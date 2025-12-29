// src/validate.js
import fs from "fs/promises";
import path from "path";
import net from "net";
import { spawn } from "child_process";

import { runValidationContract } from "../lib/validate/run.js";
import {
  exitCodeForFailureClass,
  ValidationClass,
} from "../lib/validate/classes.js";
import { inferTemplate } from "../lib/template/infer.js";
import { verifyManifestIntegrity } from "./manifest.js";
import { createOutput } from "./output.js";

const MANIFEST_NAME = "builder.manifest.json";

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  // NOTE: Validation is runtime-dependent (port, timing). This is acceptable for validate outputs.
  // Plan outputs must be deterministic; validate outputs reflect real execution.
  return new Date().toISOString();
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * spawnLogged routing rules (CI-safe):
 * - If opts.json === true:
 *    - NEVER write child stdout to process.stdout (stdout must be JSON only in --json mode)
 *    - Forward child stdout to process.stderr (human logs)
 * - If opts.quiet === true:
 *    - Do not forward streams at all (still captured)
 */
function spawnLogged(cmd, args, opts = {}) {
  const { quiet = false, json = false, ...rest } = opts;

  const child = spawn(cmd, args, {
    ...rest,
    shell: false,
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (d) => {
    const s = d.toString();
    stdout += s;
    if (quiet) return;

    // In --json mode, stdout is reserved for the single machine JSON object.
    if (json) process.stderr.write(s);
    else process.stdout.write(s);
  });

  child.stderr?.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    if (quiet) return;

    process.stderr.write(s);
  });

  return {
    child,
    wait: () =>
      new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      }),
    kill: () => {
      try {
        child.kill();
      } catch {}
    },
    killHard: () => {
      try {
        // Windows: Node maps this to TerminateProcess
        child.kill("SIGKILL");
      } catch {}
    },
    isRunning: () => child.exitCode === null && !child.killed,
  };
}

function runNpm(args, { cwd, env, quiet = false, json = false }) {
  if (process.platform === "win32") {
    return spawnLogged("cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
      cwd,
      env,
      quiet,
      json,
    });
  }
  return spawnLogged("npm", args, { cwd, env, quiet, json });
}

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  let lastErr = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        return { ok: true, json };
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }

  return { ok: false, error: lastErr || new Error("health timeout") };
}

function makeValidationFailure({
  template,
  appPath,
  failureClass,
  checkId,
  details,
}) {
  return {
    ok: false,
    template,
    appPath,
    baseUrl: null,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: 0,
    checks: [
      {
        id: checkId,
        required: true,
        ok: false,
        class: failureClass,
        details: details ?? {},
      },
    ],
    failureClass,
  };
}

async function writeJsonFile(outPath, data) {
  const abs = path.resolve(outPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(data, null, 2), "utf8");
  return abs;
}

async function stopServer(server) {
  if (!server) return;

  // try graceful
  server.kill();
  await sleep(600);

  // hard stop if still running
  if (server.isRunning && server.isRunning()) {
    server.killHard?.();
    await sleep(300);
  }
}

function normalizeInstallMode({ installMode, noInstall }) {
  // Backwards compatibility: legacy flag wins
  if (noInstall) return "never";

  // environment variable override (kept)
  const envMode = process.env.INSTALL_MODE;
  if (envMode === "always" || envMode === "never" || envMode === "if-missing") {
    return envMode;
  }

  // If not provided, default to always (existing behavior)
  if (!installMode) return "always";

  const v = String(installMode).toLowerCase().trim();
  if (v === "always" || v === "never" || v === "if-missing") return v;

  // deterministic fallback (don’t throw, don’t guess)
  return "always";
}

async function nodeModulesExists(appAbs) {
  const nm = path.join(appAbs, "node_modules");
  try {
    const st = await fs.stat(nm);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Core validator: NO process.exit here.
 * Returns: { result, exitCode }
 */
export async function validateAppCore({
  appPath,
  quiet = false,
  json = false,
  noInstall = false, // legacy
  installMode, // always|never|if-missing
  profile = undefined,
}) {
  const appAbs = path.resolve(appPath);
  const manifestPath = path.join(appAbs, MANIFEST_NAME);

  // Step 18: Manifest Integrity Lock (required)
  const integrity = await verifyManifestIntegrity({
    appPath: appAbs,
    requireManifest: true,
  });

  if (!integrity.ok) {
    // Still try to detect template name for reporting, but never bypass the lock.
    let templateName = "unknown";
    if (await pathExists(manifestPath)) {
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const m = JSON.parse(raw);
        const t =
          (typeof m?.template === "string" && m.template) ||
          (typeof m?.templateName === "string" && m.templateName) ||
          "unknown";
        templateName = t;
      } catch {
        templateName = "unknown";
      }

      if (templateName === "unknown") {
        templateName = await inferTemplate(appAbs);
      }
    } else {
      templateName = await inferTemplate(appAbs);
    }

    const validation = makeValidationFailure({
      template: templateName,
      appPath: appAbs,
      failureClass: ValidationClass.UNKNOWN_FAIL,
      checkId: "manifest_integrity",
      details: {
        code: integrity?.error?.code || "ERR_MANIFEST_INTEGRITY",
        message:
          integrity?.error?.message || "Manifest integrity check failed.",
        manifestPath: integrity.manifestPath,
        expectedFingerprint: integrity.expectedFingerprint ?? null,
        currentFingerprint: integrity.currentFingerprint ?? null,
        details: integrity?.error?.details ?? undefined,
      },
    });

    const result = {
      ok: false,
      appPath: appAbs,
      template: templateName,
      profile: profile || templateName,
      installMode: normalizeInstallMode({ installMode, noInstall }),
      didInstall: false,
      manifestIntegrity: {
        ok: false,
        manifestPath: integrity.manifestPath,
        error: integrity.error,
        expectedFingerprint: integrity.expectedFingerprint ?? null,
        currentFingerprint: integrity.currentFingerprint ?? null,
      },
      validation,
    };

    return {
      result,
      exitCode: exitCodeForFailureClass(validation.failureClass),
    };
  }

  // template detection (support both manifest keys)
  let templateName = "unknown";

  if (await pathExists(manifestPath)) {
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const m = JSON.parse(raw);

      const t =
        (typeof m?.template === "string" && m.template) ||
        (typeof m?.templateName === "string" && m.templateName) ||
        "unknown";

      templateName = t;
    } catch {
      templateName = "unknown";
    }

    // If manifest didn't provide a usable template, infer deterministically
    if (templateName === "unknown") {
      templateName = await inferTemplate(appAbs);
    }
  } else {
    templateName = await inferTemplate(appAbs);
  }

  const profileUsed = profile || templateName;

  // install-mode
  const effectiveInstallMode = normalizeInstallMode({ installMode, noInstall });

  const attempts = 2;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let didInstall = false;

    // install decision
    const shouldInstall =
      effectiveInstallMode === "always"
        ? true
        : effectiveInstallMode === "never"
        ? false
        : !(await nodeModulesExists(appAbs)); // if-missing

    // install (optional)
    if (shouldInstall) {
      try {
        const installRes = await runNpm(["install"], {
          cwd: appAbs,
          env: process.env,
          quiet,
          json,
        }).wait();

        if (installRes.code !== 0) {
          if (attempt === attempts) {
            const validation = makeValidationFailure({
              template: templateName,
              appPath: appAbs,
              failureClass: ValidationClass.UNKNOWN_FAIL,
              checkId: "install",
              details: { code: installRes.code, installMode: effectiveInstallMode },
            });

            const result = {
              ok: false,
              appPath: appAbs,
              template: templateName,
              profile: profileUsed,
              installMode: effectiveInstallMode,
              didInstall: false,
              manifestIntegrity: {
                ok: true,
                manifestPath: integrity.manifestPath,
                expectedFingerprint: integrity.expectedFingerprint,
                currentFingerprint: integrity.currentFingerprint,
                matches: true,
              },
              validation,
            };

            return {
              result,
              exitCode: exitCodeForFailureClass(validation.failureClass),
            };
          }
          continue;
        }

        didInstall = true;
      } catch (e) {
        if (attempt === attempts) {
          const validation = makeValidationFailure({
            template: templateName,
            appPath: appAbs,
            failureClass: ValidationClass.UNKNOWN_FAIL,
            checkId: "install",
            details: {
              error: String(e?.message ?? e),
              installMode: effectiveInstallMode,
            },
          });

          const result = {
            ok: false,
            appPath: appAbs,
            template: templateName,
            profile: profileUsed,
            installMode: effectiveInstallMode,
            didInstall: false,
            manifestIntegrity: {
              ok: true,
              manifestPath: integrity.manifestPath,
              expectedFingerprint: integrity.expectedFingerprint,
              currentFingerprint: integrity.currentFingerprint,
              matches: true,
            },
            validation,
          };

          return {
            result,
            exitCode: exitCodeForFailureClass(validation.failureClass),
          };
        }
        continue;
      }
    }

    // boot
    const port = await getFreePort();
    const baseUrl = `http://localhost:${port}`;
    const healthUrl = `${baseUrl}/health`;

    const env = { ...process.env, PORT: String(port) };
    const server = runNpm(["start"], { cwd: appAbs, env, quiet, json });

    // health gate
    const health = await waitForHealth(healthUrl, 15000);
    if (!health.ok) {
      await stopServer(server);

      if (attempt === attempts) {
        const validation = makeValidationFailure({
          template: templateName,
          appPath: appAbs,
          failureClass: ValidationClass.HEALTH_FAIL,
          checkId: "health",
          details: { error: String(health.error || "unknown") },
        });

        const result = {
          ok: false,
          appPath: appAbs,
          template: templateName,
          profile: profileUsed,
          installMode: effectiveInstallMode,
          didInstall,
          manifestIntegrity: {
            ok: true,
            manifestPath: integrity.manifestPath,
            expectedFingerprint: integrity.expectedFingerprint,
            currentFingerprint: integrity.currentFingerprint,
            matches: true,
          },
          validation,
        };

        return {
          result,
          exitCode: exitCodeForFailureClass(validation.failureClass),
        };
      }
      continue;
    }

    // contract checks
    let validation;
    try {
      validation = await runValidationContract({
        template: profileUsed,
        appPath: appAbs,
        baseUrl,
      });

      validation.templateOriginal = templateName;
      validation.profileUsed = profileUsed;
    } catch (e) {
      validation = makeValidationFailure({
        template: templateName,
        appPath: appAbs,
        failureClass: ValidationClass.UNKNOWN_FAIL,
        checkId: "contract",
        details: { error: String(e?.message ?? e) },
      });

      validation.templateOriginal = templateName;
      validation.profileUsed = profileUsed;
    }

    await stopServer(server);

    const result = {
      ok: validation.ok,
      port,
      url: healthUrl,
      baseUrl,
      response: health.json ?? { status: "ok" },
      template: templateName,
      profile: profileUsed,
      installMode: effectiveInstallMode,
      didInstall,
      manifestIntegrity: {
        ok: true,
        manifestPath: integrity.manifestPath,
        expectedFingerprint: integrity.expectedFingerprint,
        currentFingerprint: integrity.currentFingerprint,
        matches: true,
      },
      validation,
    };

    return { result, exitCode: exitCodeForFailureClass(validation.failureClass) };
  }

  const validation = makeValidationFailure({
    template: "unknown",
    appPath: path.resolve(appPath),
    failureClass: ValidationClass.UNKNOWN_FAIL,
    checkId: "unknown",
    details: {},
  });

  const result = {
    ok: false,
    appPath: path.resolve(appPath),
    template: "unknown",
    profile: profile || "unknown",
    installMode: normalizeInstallMode({ installMode, noInstall }),
    didInstall: false,
    manifestIntegrity: {
      ok: true,
      manifestPath: integrity.manifestPath,
      expectedFingerprint: integrity.expectedFingerprint,
      currentFingerprint: integrity.currentFingerprint,
      matches: true,
    },
    validation,
  };

  return { result, exitCode: exitCodeForFailureClass(validation.failureClass) };
}

/**
 * Step 15 helper: NON-PRINTING, NON-EXITING runner.
 * Used by build pipeline to avoid double JSON output and avoid process.exit().
 */
export async function validateAppRun({
  appPath,
  quiet = true,
  json = false,
  noInstall = false,
  installMode,
  profile,
}) {
  return validateAppCore({
    appPath,
    quiet,
    json,
    noInstall,
    installMode,
    profile,
  });
}

/**
 * CLI wrapper: prints + writes outPath + exits deterministically.
 *
 * Step 30 (JSON purity):
 * - If --json is present:
 *    - stdout = ONE JSON object line only
 *    - stderr = logs / progress only
 *    - no banners, no mixed output
 */
export async function validateApp({
  appPath,
  json = false,
  quiet = false,
  noInstall = false, // legacy
  installMode, // NEW
  outPath,
  profile,
}) {
  const out = createOutput({ json: Boolean(json), quiet: Boolean(quiet) || Boolean(json) });

  try {
    const { result, exitCode } = await validateAppCore({
      appPath,
      quiet: Boolean(quiet) || Boolean(json),
      json: Boolean(json),
      noInstall,
      installMode,
      profile,
    });

    if (outPath) {
      await writeJsonFile(outPath, result);
      if (!json && !quiet) {
        process.stderr.write(`[out] ${path.resolve(outPath)}\n`);
      }
    }

    if (json) {
      out.emitJson(result);
    } else {
      process.stdout.write("\nVALIDATION RESULT:\n");
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }

    process.exit(exitCode);
  } catch (e) {
    const appAbs = path.resolve(appPath);
    const errMsg = String(e?.stack || e?.message || e);

    const validation = makeValidationFailure({
      template: "unknown",
      appPath: appAbs,
      failureClass: ValidationClass.UNKNOWN_FAIL,
      checkId: "exception",
      details: { error: errMsg },
    });

    const result = {
      ok: false,
      appPath: appAbs,
      template: "unknown",
      profile: profile || "unknown",
      installMode: normalizeInstallMode({ installMode, noInstall }),
      didInstall: false,
      manifestIntegrity: {
        ok: false,
        manifestPath: path.join(appAbs, MANIFEST_NAME),
        error: { code: "ERR_VALIDATE_EXCEPTION", message: errMsg },
        expectedFingerprint: null,
        currentFingerprint: null,
      },
      validation,
    };

    if (outPath) {
      try {
        await writeJsonFile(outPath, result);
        if (!json && !quiet) {
          process.stderr.write(`[out] ${path.resolve(outPath)}\n`);
        }
      } catch (writeErr) {
        process.stderr.write(
          `[validate] failed to write outPath: ${String(
            writeErr?.message ?? writeErr
          )}\n`
        );
      }
    }

    if (json) {
      out.emitJson(result);
    } else {
      process.stderr.write(`[validate] exception: ${errMsg}\n`);
      process.stdout.write("\nVALIDATION RESULT:\n");
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }

    process.exit(exitCodeForFailureClass(ValidationClass.UNKNOWN_FAIL));
  }
}

export async function validate({
  appPath,
  json = false,
  quiet = false,
  noInstall = false, // legacy
  installMode, // NEW
  outPath,
  profile,
}) {
  return validateApp({
    appPath,
    json,
    quiet,
    noInstall,
    installMode,
    outPath,
    profile,
  });
}
