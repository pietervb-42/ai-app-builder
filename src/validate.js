// src/validate.js
import fs from "fs/promises";
import path from "path";
import net from "net";
import http from "http";
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

function oneLine(s) {
  const t = String(s ?? "").replace(/\r?\n/g, " ").trim();
  return t;
}

function shortMessage(s, max = 200) {
  const t = oneLine(s);
  return t.length > max ? t.slice(0, max) : t;
}

function normalizeError(e, fallbackCode, fallbackMessage) {
  const code =
    (e && typeof e === "object" && typeof e.code === "string" && e.code) ||
    fallbackCode;

  const msgRaw =
    (e && typeof e === "object" && (e.message || e.stack)) ||
    e ||
    fallbackMessage ||
    "Unknown error";

  return {
    code,
    message: shortMessage(msgRaw, 220),
  };
}

function pickErrorCode(err) {
  if (!err) return null;
  if (typeof err === "object") {
    if (typeof err.code === "string" && err.code) return err.code;
    const c = err.cause;
    if (c && typeof c === "object" && typeof c.code === "string" && c.code) {
      return c.code;
    }
  }
  return null;
}

function mapHealthErrorCode(err, { timeoutFallback = "ERR_HEALTH_TIMEOUT" } = {}) {
  const code = pickErrorCode(err);

  // Most common Node/undici/network codes
  if (code === "ECONNREFUSED") return "ERR_HEALTH_CONNREFUSED";
  if (code === "EHOSTUNREACH") return "ERR_HEALTH_HOSTUNREACH";
  if (code === "ENETUNREACH") return "ERR_HEALTH_NETUNREACH";
  if (code === "ENOTFOUND") return "ERR_HEALTH_DNS";
  if (code === "EAI_AGAIN") return "ERR_HEALTH_DNS";
  if (code === "ETIMEDOUT") return "ERR_HEALTH_TIMEOUT";

  // undici / fetch specific (kept for compatibility if other code paths throw these)
  if (code === "UND_ERR_CONNECT_TIMEOUT") return "ERR_HEALTH_TIMEOUT";
  if (code === "UND_ERR_HEADERS_TIMEOUT") return "ERR_HEALTH_TIMEOUT";
  if (code === "UND_ERR_BODY_TIMEOUT") return "ERR_HEALTH_TIMEOUT";
  if (code === "UND_ERR_SOCKET") return "ERR_HEALTH_SOCKET";
  if (code === "UND_ERR_CONNECT") return "ERR_HEALTH_CONNECT";

  // TLS-ish
  if (code === "CERT_HAS_EXPIRED") return "ERR_HEALTH_TLS";
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return "ERR_HEALTH_TLS";
  if (code === "SELF_SIGNED_CERT_IN_CHAIN") return "ERR_HEALTH_TLS";

  return timeoutFallback;
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

async function taskkillTree(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return;
  if (process.platform !== "win32") return;

  await new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
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

  const killSoft = () => {
    try {
      child.kill();
    } catch {}
  };

  const killHard = async () => {
    try {
      // Windows: kill the whole process tree to avoid orphaned node servers.
      if (process.platform === "win32" && child.pid) {
        await taskkillTree(child.pid);
        return;
      }
    } catch {}

    try {
      // Non-Windows: best-effort hard kill.
      child.kill("SIGKILL");
    } catch {}
  };

  return {
    child,
    wait: () =>
      new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      }),
    kill: killSoft,
    killHard,
    isRunning: () => child.exitCode === null && !child.killed,
    capture: () => ({ stdout, stderr }),
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

/**
 * Deterministic health probe using Node http.request (NOT fetch).
 * This avoids undici/AbortController behavior where local connect failures can look like timeouts on Windows.
 */
async function fetchHealthOnce(url, { timeoutMs = 900 } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      const err = new Error("Invalid URL");
      err.code = "ERR_HEALTH_BAD_URL";
      err.cause = e;
      resolve({ ok: false, error: err });
      return;
    }

    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { Accept: "application/json" },
        timeout: Math.max(1, Number(timeoutMs) || 900),
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");

        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? null;

          if (!status || status < 200 || status > 299) {
            const e = new Error(`HTTP ${status ?? "null"}`);
            e.code = status ? `ERR_HEALTH_HTTP_${status}` : "ERR_HEALTH_HTTP_NULL";
            resolve({ ok: false, error: e });
            return;
          }

          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            json = null; // best-effort; gate doesn't require strict JSON
          }

          resolve({ ok: true, json });
        });
      }
    );

    req.on("timeout", () => {
      const e = new Error("Health request timed out.");
      e.code = "ETIMEDOUT";
      try {
        req.destroy(e);
      } catch {}
    });

    req.on("error", (e) => {
      // Preserve native error codes like ECONNREFUSED
      resolve({ ok: false, error: e });
    });

    req.end();
  });
}

async function waitForServerReady({ server, healthUrl, timeoutMs }) {
  const start = Date.now();
  let lastErr = null;

  while (Date.now() - start < timeoutMs) {
    // If the server process exited, that's a BOOT failure (not a health failure).
    if (server?.child && server.child.exitCode !== null) {
      const cap = server.capture ? server.capture() : { stdout: "", stderr: "" };
      const stderrSnippet = shortMessage(cap.stderr ?? "", 200);
      const stdoutSnippet = shortMessage(cap.stdout ?? "", 200);

      return {
        ok: false,
        error: {
          code: "ERR_NPM_START_EXIT",
          message: `npm start exited early (exit ${server.child.exitCode}).`,
          exitCode: server.child.exitCode,
          stderrSnippet: stderrSnippet || undefined,
          stdoutSnippet: stdoutSnippet || undefined,
        },
      };
    }

    const once = await fetchHealthOnce(healthUrl, { timeoutMs: 900 });
    if (once.ok) return once;

    lastErr = once.error;
    await sleep(250);
  }

  // Timeout: still classify as HEALTH_FAIL, but with a deterministic code.
  const code = mapHealthErrorCode(lastErr, { timeoutFallback: "ERR_HEALTH_TIMEOUT" });
  const msg = lastErr?.message ? oneLine(lastErr.message) : "health timeout";

  return {
    ok: false,
    error: {
      code,
      message: shortMessage(msg, 220),
    },
  };
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
  try {
    server.kill?.();
  } catch {}
  await sleep(600);

  // hard stop if still running
  if (server.isRunning && server.isRunning()) {
    try {
      await server.killHard?.();
    } catch {}
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
 * If node_modules exists, it can still be BROKEN (partial install, deleted module, etc.).
 * `npm ls` returns non-zero when dependencies are missing/invalid.
 * We treat non-zero as "deps not healthy" => we should install when in if-missing mode.
 */
async function npmDepsHealthy(appAbs, { json = false } = {}) {
  try {
    const res = await runNpm(["ls", "--depth=0", "--json"], {
      cwd: appAbs,
      env: process.env,
      quiet: true, // never spam output during health check
      json: Boolean(json), // keep routing rules consistent even though quiet suppresses writes
    }).wait();

    return {
      ok: res.code === 0,
      exitCode: typeof res.code === "number" ? res.code : null,
      stdoutSnippet: shortMessage(res.stdout ?? "", 200) || null,
      stderrSnippet: shortMessage(res.stderr ?? "", 200) || null,
    };
  } catch (e) {
    const err = normalizeError(e, "ERR_NPM_LS_EXCEPTION", "npm ls threw an exception.");
    return {
      ok: false,
      exitCode: null,
      stdoutSnippet: null,
      stderrSnippet: err.message || null,
    };
  }
}

function classForBootstrapFailure(checkId) {
  // Deterministic mapping to existing classes (no UNKNOWN_FAIL).
  // These failures happen before contract checks, but must still be classified.
  switch (checkId) {
    case "manifest_integrity":
      return ValidationClass.SCHEMA_FAIL;
    case "install":
      return ValidationClass.BOOT_FAIL;
    case "start":
      return ValidationClass.BOOT_FAIL;
    case "contract":
      return ValidationClass.ENDPOINT_FAIL;
    case "exception":
    default:
      return ValidationClass.BOOT_FAIL;
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

    // Force a stable top-level diagnostic code for integrity lock failures.
    // Preserve the underlying integrity reason separately for debugging.
    const integrityErrorCode =
      integrity?.error &&
      typeof integrity.error === "object" &&
      typeof integrity.error.code === "string"
        ? integrity.error.code
        : null;

    const err = {
      code: "ERR_MANIFEST_INTEGRITY",
      message: shortMessage(
        integrity?.error?.message ?? "Manifest integrity check failed.",
        220
      ),
    };

    const validation = makeValidationFailure({
      template: templateName,
      appPath: appAbs,
      failureClass: classForBootstrapFailure("manifest_integrity"),
      checkId: "manifest_integrity",
      details: {
        code: err.code,
        message: err.message,
        integrityErrorCode: integrityErrorCode ?? null,
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
    let shouldInstall = false;

    if (effectiveInstallMode === "always") {
      shouldInstall = true;
    } else if (effectiveInstallMode === "never") {
      shouldInstall = false;
    } else {
      // if-missing: install when node_modules missing OR deps are broken
      const nmExists = await nodeModulesExists(appAbs);
      if (!nmExists) {
        shouldInstall = true;
      } else {
        const deps = await npmDepsHealthy(appAbs, { json });
        shouldInstall = !deps.ok;
      }
    }

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
              failureClass: classForBootstrapFailure("install"),
              checkId: "install",
              details: {
                code: "ERR_NPM_INSTALL_EXIT",
                message: `npm install failed (exit ${installRes.code}).`,
                exitCode: installRes.code,
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

        didInstall = true;
      } catch (e) {
        if (attempt === attempts) {
          const err = normalizeError(
            e,
            "ERR_NPM_INSTALL_EXCEPTION",
            "npm install threw an exception."
          );

          const validation = makeValidationFailure({
            template: templateName,
            appPath: appAbs,
            failureClass: classForBootstrapFailure("install"),
            checkId: "install",
            details: {
              code: err.code,
              message: err.message,
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

    // Use IPv4 explicitly (also avoids localhost IPv6 quirks)
    const baseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${baseUrl}/health`;

    const env = { ...process.env, PORT: String(port) };
    const server = runNpm(["start"], { cwd: appAbs, env, quiet, json });

    // Always cleanup server (Windows needs tree kill to prevent orphans).
    try {
      // health gate + early-exit detection
      const health = await waitForServerReady({
        server,
        healthUrl,
        timeoutMs: 15000,
      });

      if (!health.ok) {
        // If npm start exited, classify as BOOT_FAIL, not HEALTH_FAIL.
        if (health?.error?.code === "ERR_NPM_START_EXIT") {
          if (attempt === attempts) {
            const validation = makeValidationFailure({
              template: templateName,
              appPath: appAbs,
              failureClass: classForBootstrapFailure("start"),
              checkId: "start",
              details: {
                code: health.error.code,
                message: health.error.message,
                exitCode: health.error.exitCode ?? null,
                stderrSnippet: health.error.stderrSnippet,
                stdoutSnippet: health.error.stdoutSnippet,
              },
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

        // Otherwise it's a HEALTH gate failure.
        if (attempt === attempts) {
          const err = normalizeError(
            health.error,
            health?.error?.code || "ERR_HEALTH_GATE",
            "Health gate failed."
          );

          const validation = makeValidationFailure({
            template: templateName,
            appPath: appAbs,
            failureClass: ValidationClass.HEALTH_FAIL,
            checkId: "health",
            details: { code: err.code, message: err.message, url: healthUrl },
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
        const err = normalizeError(
          e,
          "ERR_CONTRACT_EXCEPTION",
          "Validation contract runner threw an exception."
        );

        validation = makeValidationFailure({
          template: templateName,
          appPath: appAbs,
          failureClass: classForBootstrapFailure("contract"),
          checkId: "contract",
          details: { code: err.code, message: err.message },
        });

        validation.templateOriginal = templateName;
        validation.profileUsed = profileUsed;
      }

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
    } finally {
      await stopServer(server);
    }
  }

  const validation = makeValidationFailure({
    template: "unknown",
    appPath: path.resolve(appPath),
    failureClass: classForBootstrapFailure("exception"),
    checkId: "fallthrough",
    details: {
      code: "ERR_VALIDATE_FALLTHROUGH",
      message: "Validator exhausted attempts without producing a final result.",
    },
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
  const out = createOutput({
    json: Boolean(json),
    quiet: Boolean(quiet) || Boolean(json),
  });

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
    const err = normalizeError(
      e,
      "ERR_VALIDATE_EXCEPTION",
      "Validator threw an exception."
    );

    const validation = makeValidationFailure({
      template: "unknown",
      appPath: appAbs,
      failureClass: classForBootstrapFailure("exception"),
      checkId: "exception",
      details: { code: err.code, message: err.message },
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
        error: { code: err.code, message: err.message },
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
          `[validate] failed to write outPath: ${shortMessage(
            writeErr?.message ?? writeErr
          )}\n`
        );
      }
    }

    if (json) {
      out.emitJson(result);
    } else {
      process.stderr.write(`[validate] exception: ${err.message}\n`);
      process.stdout.write("\nVALIDATION RESULT:\n");
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }

    process.exit(exitCodeForFailureClass(validation.failureClass));
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
