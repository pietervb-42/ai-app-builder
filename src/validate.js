import fs from "fs/promises";
import path from "path";
import net from "net";
import { spawn } from "child_process";

import { runValidationContract } from "../lib/validate/run.js";
import { exitCodeForFailureClass, ValidationClass } from "../lib/validate/classes.js";
import { inferTemplate } from "../lib/template/infer.js";

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
  return new Date().toISOString();
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function spawnLogged(cmd, args, opts = {}) {
  const { quiet = false, ...rest } = opts;

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
    if (!quiet) process.stdout.write(s);
  });

  child.stderr?.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    if (!quiet) process.stderr.write(s);
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

function runNpm(args, { cwd, env, quiet = false }) {
  if (process.platform === "win32") {
    return spawnLogged("cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
      cwd,
      env,
      quiet,
    });
  }
  return spawnLogged("npm", args, { cwd, env, quiet });
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

function makeValidationFailure({ template, appPath, failureClass, checkId, details }) {
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

  // EASY WORKAROUND: environment variable override (no index.js changes)
  // PowerShell:
  //   $env:INSTALL_MODE="if-missing"
  const envMode = process.env.INSTALL_MODE;
  if (envMode === "always" || envMode === "never" || envMode === "if-missing") {
    return envMode;
  }

  // Optional: future CLI support if index.js passes installMode
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
  noInstall = false, // legacy
  installMode, // NEW: always|never|if-missing
  profile = undefined,
}) {
  const appAbs = path.resolve(appPath);
  const manifestPath = path.join(appAbs, MANIFEST_NAME);

  // 29.2 template detection (support both manifest keys)
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

  // 29.1 install-mode
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
              validation,
            };

            return {
              result,
              exitCode: exitCodeForFailureClass(validation.failureClass),
            };
          }
          continue;
        }

        // install succeeded
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
    const server = runNpm(["start"], { cwd: appAbs, env, quiet });

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
          validation,
        };

        return {
          result,
          exitCode: exitCodeForFailureClass(validation.failureClass),
        };
      }
      continue;
    }

    // contract checks (profile override supported)
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
    validation,
  };

  return { result, exitCode: exitCodeForFailureClass(validation.failureClass) };
}

/**
 * CLI wrapper: prints + writes outPath + exits deterministically.
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
  const { result, exitCode } = await validateAppCore({
    appPath,
    quiet,
    noInstall,
    installMode,
    profile,
  });

  if (outPath) {
    await writeJsonFile(outPath, result);
  }

  if (json) {
    console.log(JSON.stringify(result));
  } else {
    console.log("");
    console.log("VALIDATION RESULT:");
    console.log(JSON.stringify(result, null, 2));
    if (outPath) console.log(`[out] ${path.resolve(outPath)}`);
  }

  process.exit(exitCode);
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
