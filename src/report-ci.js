// src/report-ci.js
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createOutput } from "./output.js";

/**
 * report:ci
 * - Scan a root folder for generated apps (dirs containing builder.manifest.json)
 * - Optionally filter by --include substring and --max
 * - Run `validate` for each app in a clean JSON-only way
 * - Print progress lines to stderr (so stdout can remain JSON clean)
 * - Write full report JSON to --out if provided
 *
 * IMPORTANT POLICY (Recommended):
 * - Manifest integrity failures are WARN (do not fail CI by default)
 * - Runtime failures (install/health/contract/etc) are FAIL (do fail CI)
 *
 * NOTE: We intentionally shell out to `node index.js validate ... --json` so we
 * don't depend on internal validate() return-shapes. This keeps report:ci stable.
 *
 * NEW:
 * - --heal-manifest
 *   If enabled, and validation fails ONLY due to manifest integrity mismatch,
 *   then report:ci will:
 *     1) run manifest refresh (apply) for that app
 *     2) re-run validate ONCE
 *     3) if it passes after healing: mark result as WARN (truthful heal)
 *   No healing is attempted for other failure types.
 */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonFile(filePath, obj) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function safeNumber(n, fallback) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function discoverApps(rootPath) {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(rootPath, e.name))
    .filter(isDir);

  // Only treat directories with a builder.manifest.json as "apps"
  const apps = dirs.filter((d) => exists(path.join(d, "builder.manifest.json")));

  // Deterministic order
  apps.sort((a, b) => a.localeCompare(b));
  return apps;
}

/**
 * Extract the LAST JSON object/array from a text blob that may contain
 * prefix lines (e.g. "[manifest] ...") before the JSON.
 *
 * Deterministic:
 * - We scan from the end for candidate '{' or '[' and try parse.
 * - First successful parse from the end wins.
 */
function extractLastJsonValue(text) {
  const s = String(text ?? "");
  if (!s.trim()) return { ok: false, value: null, error: "empty" };

  // Scan from end for '{' or '['
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch !== "{" && ch !== "[") continue;

    const candidate = s.slice(i).trim();
    if (!candidate) continue;

    try {
      const v = JSON.parse(candidate);
      return { ok: true, value: v, startIndex: i };
    } catch {
      // keep scanning
    }
  }

  return { ok: false, value: null, error: "no-json-found" };
}

/**
 * Run `node index.js <cmd> ...` and parse stdout JSON.
 * - strictJson=true: stdout must be JSON only (after trim), else error
 * - strictJson=false: stdout may include prefix lines; we parse the last JSON value
 */
function runCliJson({ cmd, args, cwdLabel, strictJson }) {
  return new Promise((resolve) => {
    const node = process.execPath;
    const entry = path.resolve(process.cwd(), "index.js");
    const fullArgs = [entry, cmd, ...args];

    const child = spawn(node, fullArgs, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : 1;
      const outTrim = stdout.trim();
      const errTrim = stderr.trim() || "";

      if (!outTrim) {
        resolve({
          ok: false,
          exitCode,
          json: null,
          error: {
            code: "ERR_CLI_NO_STDOUT",
            message: `CLI produced no stdout (${cmd})`,
            cmd,
            cwd: cwdLabel || null,
            stderr: errTrim || null,
          },
          raw: { stdout: "", stderr: errTrim },
        });
        return;
      }

      if (strictJson) {
        try {
          const parsed = JSON.parse(outTrim);
          resolve({
            ok: exitCode === 0,
            exitCode,
            json: parsed,
            error: null,
            raw: { stdout: outTrim, stderr: errTrim },
          });
        } catch (e) {
          resolve({
            ok: false,
            exitCode,
            json: null,
            error: {
              code: "ERR_CLI_BAD_JSON",
              message: `CLI stdout was not valid JSON (${cmd})`,
              cmd,
              cwd: cwdLabel || null,
              parseError: String(e?.message || e),
              stdout: outTrim.slice(0, 5000),
              stderr: errTrim || null,
            },
            raw: { stdout: outTrim.slice(0, 5000), stderr: errTrim },
          });
        }
        return;
      }

      // Non-strict: parse last JSON value from stdout
      const extracted = extractLastJsonValue(stdout);
      if (!extracted.ok) {
        resolve({
          ok: false,
          exitCode,
          json: null,
          error: {
            code: "ERR_CLI_BAD_JSON",
            message: `CLI stdout did not contain parsable JSON (${cmd})`,
            cmd,
            cwd: cwdLabel || null,
            parseError: extracted.error || "unknown",
            stdout: outTrim.slice(0, 5000),
            stderr: errTrim || null,
          },
          raw: { stdout: outTrim.slice(0, 5000), stderr: errTrim },
        });
        return;
      }

      resolve({
        ok: exitCode === 0,
        exitCode,
        json: extracted.value,
        error: null,
        raw: { stdout: outTrim.slice(0, 5000), stderr: errTrim },
      });
    });
  });
}

function runValidateViaCli({ appPath, installMode, profile, noInstall, quiet }) {
  return new Promise((resolve) => {
    const node = process.execPath;
    const entry = path.resolve(process.cwd(), "index.js");

    const args = [entry, "validate", "--app", appPath, "--json"];

    if (quiet) args.push("--quiet");

    if (noInstall) {
      args.push("--no-install");
    } else if (installMode) {
      args.push("--install-mode", String(installMode));
    }

    if (profile) {
      args.push("--profile", String(profile));
    }

    const child = spawn(node, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : 1;

      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          exitCode,
          validate: {
            ok: false,
            appPath,
            error: {
              code: "ERR_VALIDATE_NO_STDOUT",
              message: "validate produced no stdout JSON",
              stderr: stderr.trim() || null,
            },
          },
          raw: { stdout: "", stderr: stderr.trim() || "" },
        });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        resolve({
          exitCode,
          validate: parsed,
          raw: { stdout: trimmed, stderr: stderr.trim() || "" },
        });
      } catch (e) {
        resolve({
          exitCode,
          validate: {
            ok: false,
            appPath,
            error: {
              code: "ERR_VALIDATE_BAD_JSON",
              message: "validate stdout was not valid JSON",
              parseError: String(e?.message || e),
              stdout: trimmed.slice(0, 5000),
              stderr: stderr.trim() || null,
            },
          },
          raw: { stdout: trimmed.slice(0, 5000), stderr: stderr.trim() || "" },
        });
      }
    });
  });
}

/**
 * Classify validate output into:
 * - pass: validate ok
 * - warn: manifest integrity failure ONLY (non-fatal for CI gate)
 * - fail: anything else failing
 */
function classifyValidateForCi(v) {
  if (!v || typeof v !== "object") {
    return {
      severity: "fail",
      hardFail: true,
      warn: false,
      reason: "no-validate-object",
    };
  }

  if (v.ok === true) {
    return { severity: "pass", hardFail: false, warn: false, reason: null };
  }

  const manifestOk = v?.manifestIntegrity?.ok;
  const checks = Array.isArray(v?.validation?.checks) ? v.validation.checks : [];
  const firstCheckId = checks[0]?.id;

  const isManifestOnlyFailure =
    manifestOk === false && checks.length === 1 && firstCheckId === "manifest_integrity";

  if (isManifestOnlyFailure) {
    return { severity: "warn", hardFail: false, warn: true, reason: "manifest_integrity" };
  }

  const failureClass = v?.validation?.failureClass || v?.failureClass || "unknown";
  const checkId = firstCheckId || v?.validation?.checks?.[0]?.id || "unknown";
  return {
    severity: "fail",
    hardFail: true,
    warn: false,
    reason: `failure:${failureClass}:${checkId}`,
  };
}

/**
 * Heal manifest for a single app by running:
 *   node index.js manifest:refresh --app <appPath> --apply --json
 *
 * NOTE:
 * Your manifest:refresh currently prints prefix lines to stdout before JSON
 * (e.g. "[manifest] ..."), so we MUST parse the last JSON value from stdout.
 *
 * Deterministic:
 * - Single fixed invocation.
 * - We treat success as: exitCode===0 AND we successfully parsed JSON.
 */
async function healManifestForApp({ appPath }) {
  const attemptArgs = ["--app", appPath, "--apply", "--json"];

  const r = await runCliJson({
    cmd: "manifest:refresh",
    args: attemptArgs,
    cwdLabel: "repo",
    strictJson: false, // allow prefix lines, parse last JSON
  });

  return {
    attempted: true,
    ok: Boolean(r.ok && r.json),
    commandTried: [
      {
        cmd: "manifest:refresh",
        args: attemptArgs,
        ok: Boolean(r.ok && r.json),
        exitCode: r.exitCode,
        json: r.json,
        error: r.error,
      },
    ],
  };
}

export async function reportCi(options = {}) {
  const rootPath = options.rootPath || options.root || "";
  if (!rootPath) throw new Error("Missing required option: rootPath/root");

  const jsonOnly = Boolean(options.json);
  const quiet = Boolean(options.quiet) || Boolean(options.json);
  const out = createOutput({ json: jsonOnly, quiet });

  const noInstall = Boolean(options.noInstall);
  const installMode = options.installMode || undefined;
  const profile = options.profile || undefined;

  const progress = Boolean(options.progress);
  const include = options.include ? String(options.include) : undefined;
  const max = options.max != null ? safeNumber(options.max, undefined) : undefined;

  const outPath = options.outPath ? String(options.outPath) : undefined;

  const healManifest = Boolean(options.healManifest);

  const startedAt = new Date().toISOString();

  // 1) Discover
  const discoveredApps = discoverApps(rootPath);

  // 2) Filter BEFORE progress loop
  let apps = discoveredApps;
  if (include) {
    apps = apps.filter((p) => p.toLowerCase().includes(include.toLowerCase()));
  }
  if (typeof max === "number" && Number.isFinite(max) && max > 0) {
    apps = apps.slice(0, max);
  }

  // 3) Validate each app
  const results = [];
  for (let i = 0; i < apps.length; i++) {
    const appPath = apps[i];

    if (progress) {
      out.log(`[report:ci] ${i + 1}/${apps.length} ${appPath}`);
    }

    const initial = await runValidateViaCli({
      appPath,
      installMode,
      profile,
      noInstall,
      quiet: true,
    });

    const initialCi = classifyValidateForCi(initial.validate);

    const result = {
      appPath,
      validate: initial.validate,
      exitCode: initial.exitCode,
      ci: initialCi,
      healedManifest: null,
      validateAfterHeal: null,
      ciAfterHeal: null,
    };

    // Heal ONLY if enabled and failure is manifest_integrity ONLY
    if (healManifest && initialCi?.reason === "manifest_integrity" && initialCi?.severity === "warn") {
      if (progress) {
        out.log(`[report:ci] heal-manifest: refreshing manifest (apply) for ${appPath}`);
      }

      const heal = await healManifestForApp({ appPath });
      result.healedManifest = heal;

      // Re-run validate ONCE only if refresh succeeded
      if (heal.ok === true) {
        if (progress) {
          out.log(`[report:ci] heal-manifest: re-validating ${appPath}`);
        }

        const after = await runValidateViaCli({
          appPath,
          installMode,
          profile,
          noInstall,
          quiet: true,
        });

        const afterCi = classifyValidateForCi(after.validate);

        result.validateAfterHeal = after.validate;
        result.ciAfterHeal = afterCi;

        // Truthful CI rules:
        // - If passes after heal => WARN with reason healed_manifest (not pass)
        // - Else reflect afterCi severity (could become fail)
        if (after.validate && after.validate.ok === true) {
          result.ci = {
            severity: "warn",
            hardFail: false,
            warn: true,
            reason: "healed_manifest",
          };
          result.exitCode = 0;
          result.validate = after.validate;
        } else {
          result.ci = afterCi;
          result.exitCode = after.exitCode;
          result.validate = after.validate;
        }
      } else {
        // refresh failed: remain at initial warn
        result.ci = initialCi;
        result.exitCode = initial.exitCode;
        result.validate = initial.validate;
      }
    }

    results.push(result);
  }

  // CI gate: hard fails only
  const hardFailCount = results.filter((r) => r.ci?.hardFail === true).length;
  const warnCount = results.filter((r) => r.ci?.warn === true).length;
  const passCount = results.filter((r) => r.ci?.severity === "pass").length;

  const ok = hardFailCount === 0;

  const report = {
    ok,
    rootPath: path.resolve(rootPath),
    startedAt,
    finishedAt: new Date().toISOString(),

    appsDiscovered: discoveredApps.length,
    appsFound: apps.length,

    passCount,
    warnCount,
    hardFailCount,

    installMode: noInstall ? "no-install" : installMode || null,
    include: include || null,
    max: typeof max === "number" && Number.isFinite(max) ? max : null,
    profile: profile || null,
    healManifest: healManifest,

    results,
  };

  if (outPath) writeJsonFile(outPath, report);

  if (jsonOnly) {
    out.emitJson(report);
  } else {
    process.stdout.write(
      `report:ci ${ok ? "OK" : "FAIL"} | pass ${passCount} | warn ${warnCount} | fail ${hardFailCount} | processed ${apps.length} (discovered ${discoveredApps.length})\n`
    );
  }

  if (!ok) process.exitCode = 1;

  return report;
}
