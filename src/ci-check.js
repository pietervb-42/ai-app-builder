// src/ci-check.js
import path from "path";
import { spawn } from "child_process";
import { createOutput } from "./output.js";

function hasFlag(flags, name) {
  return Boolean(flags[name]);
}

function requireFlag(flags, name) {
  const v = flags[name];
  if (!v || v === true) throw new Error(`Missing required flag: --${name}`);
  return v;
}

function safeNumber(n, fallback) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CI_CHECK_HELP_TEXT = [
  "Usage:",
  "  node index.js ci:check --root <dir> [options]",
  "",
  "Required:",
  "  --root <dir>                 Root directory containing generated outputs",
  "",
  "Options:",
  "  --json                        Emit ONE JSON object to stdout",
  "  --quiet                       Reduce human logs (implied by --json)",
  "  --progress                    Print progress logs to stderr",
  "",
  "  --contracts-dir <dir>         Contract snapshots directory (default: ci/contracts)",
  "  --refresh-manifests <mode>    Pass-through to contract:run (default: never)",
  "",
  "  --no-install                  Pass-through to underlying commands",
  "  --install-mode <mode>         Pass-through to underlying commands",
  "  --profile <name>              Pass-through filter",
  "  --include <pattern>           Pass-through filter",
  "  --max <n>                     Pass-through limit",
  "  --heal-manifest               Pass-through (report:ci + contract:run)",
  "",
  "  --settle-ms <n>               Delay between schema targets (default: 200)",
  "  --timeout-ms <n>              Timeout per sub-command (default: 120000)",
  "",
  "Help:",
  "  --help, -h                    Show this help and exit 0",
  "",
].join("\n");

// strict json runner: expects a single JSON object on stdout
async function runCliJson({ cmd, args, timeoutMs = 120000 }) {
  const node = process.execPath;
  const entry = path.resolve(process.cwd(), "index.js");
  const fullArgs = [entry, cmd, ...args];

  return new Promise((resolve) => {
    const child = spawn(node, fullArgs, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch (_) {}
          }, timeoutMs)
        : null;

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);

      const exitCode = typeof code === "number" ? code : 1;
      const outTrim = stdout.trim();
      const errTrim = stderr.trim() || "";

      if (timedOut) {
        resolve({
          ok: false,
          exitCode: exitCode || 2,
          json: null,
          error: {
            code: "ERR_RUN_TIMEOUT",
            message: `CLI timed out after ${timeoutMs}ms (${cmd})`,
            cmd,
            stderr: errTrim || null,
          },
        });
        return;
      }

      if (!outTrim) {
        resolve({
          ok: false,
          exitCode,
          json: null,
          error: {
            code: "ERR_RUN_NO_STDOUT",
            message: `CLI produced no stdout (${cmd})`,
            cmd,
            stderr: errTrim || null,
          },
        });
        return;
      }

      try {
        const parsed = JSON.parse(outTrim);
        resolve({
          ok: exitCode === 0,
          exitCode,
          json: parsed,
          error:
            exitCode === 0
              ? null
              : {
                  code: "ERR_RUN_NONZERO",
                  message: `Non-zero exit (${exitCode})`,
                  cmd,
                  stderr: errTrim || null,
                },
        });
      } catch (e) {
        resolve({
          ok: false,
          exitCode,
          json: null,
          error: {
            code: "ERR_RUN_BAD_JSON",
            message: `CLI stdout was not valid JSON (${cmd})`,
            cmd,
            parseError: String(e?.message || e),
            stdout: outTrim.slice(0, 2000),
            stderr: errTrim || null,
          },
        });
      }
    });
  });
}

export async function ciCheck({ flags }) {
  const json = hasFlag(flags, "json");
  const quiet = hasFlag(flags, "quiet") || Boolean(json);
  const progress = hasFlag(flags, "progress");

  const out = createOutput({ json: Boolean(json), quiet: Boolean(quiet) });

  const startedAt = new Date().toISOString();

  // ---- Help must short-circuit BEFORE required flag validation ----
  const wantsHelp = hasFlag(flags, "help") || hasFlag(flags, "h");
  if (wantsHelp) {
    const finishedAt = new Date().toISOString();
    if (json) {
      out.emitJson({
        ok: true,
        startedAt,
        finishedAt,
        help: true,
        usage: CI_CHECK_HELP_TEXT,
      });
    } else {
      // Help is human output; keep it on stderr via out.log()
      out.log(CI_CHECK_HELP_TEXT);
    }
    return 0;
  }

  let root;
  try {
    root = String(requireFlag(flags, "root"));
  } catch (e) {
    const payload = {
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: { code: "ERR_CI_INPUT", message: String(e?.message || e) },
    };
    if (json) out.emitJson(payload);
    else out.log(`[ci:check] ERROR: ${payload.error.message}`);
    return 2;
  }

  // pass-through knobs (keep aligned with contract:run)
  const noInstall = hasFlag(flags, "no-install");
  const installMode = flags["install-mode"] ? String(flags["install-mode"]) : null;
  const profile = flags.profile ? String(flags.profile) : null;
  const include = flags.include ? String(flags.include) : null;
  const max = flags.max != null ? safeNumber(flags.max, null) : null;
  const healManifest = hasFlag(flags, "heal-manifest");

  const refreshManifests = flags["refresh-manifests"]
    ? String(flags["refresh-manifests"]).toLowerCase().trim()
    : "never";

  // ✅ default to CI snapshot dir
  const contractsDir = flags["contracts-dir"] ? String(flags["contracts-dir"]) : "ci/contracts";

  const settleMs = safeNumber(flags["settle-ms"], 200);

  // Base timeout for sub-commands (schema producers etc.)
  const baseTimeoutMs = safeNumber(flags["timeout-ms"], 120000);

  // contract:run can be slower (fixture boot/install checks). Give it a higher default in CI.
  // Still overridable by user via --timeout-ms (we treat that as base), but we ensure a sane floor.
  const contractTimeoutFloorMs = 600000; // 10 minutes
  const contractTimeoutMs =
    typeof baseTimeoutMs === "number" && Number.isFinite(baseTimeoutMs)
      ? Math.max(baseTimeoutMs, contractTimeoutFloorMs)
      : contractTimeoutFloorMs;

  // ---- Phase 1: schema:check for validate:all + report:ci + manifest:refresh:all ----
  const schemaResults = [];
  let schemaFailCount = 0;
  let schemaRunnerError = null;

  const schemaTargets = ["validate:all", "report:ci", "manifest:refresh:all"];

  for (let i = 0; i < schemaTargets.length; i++) {
    const target = schemaTargets[i];

    if (progress) out.log(`[ci:check] schema ${i + 1}/${schemaTargets.length} ${target}`);

    // run the actual command to produce JSON, pipe it into schema:check via stdin
    const producerArgs = ["--root", root, "--json", "--quiet"];
    if (noInstall) producerArgs.push("--no-install");
    else if (installMode && installMode !== "true") producerArgs.push("--install-mode", installMode);
    if (profile) producerArgs.push("--profile", profile);
    if (include) producerArgs.push("--include", include);
    if (typeof max === "number" && Number.isFinite(max)) producerArgs.push("--max", String(max));
    if (progress) producerArgs.push("--progress");
    if (target === "report:ci" && healManifest) producerArgs.push("--heal-manifest");

    // CI safety: never allow schema-producer manifest refresh to apply changes.
    if (target === "manifest:refresh:all") producerArgs.push("--apply", "false");

    const produced = await runCliJson({ cmd: target, args: producerArgs, timeoutMs: baseTimeoutMs });

    // IMPORTANT:
    // Phase 1 is a SHAPE gate, not a SUCCESS gate.
    // If the producer exits non-zero but still emits valid JSON, we still schema-check it.
    if (!produced.json) {
      schemaRunnerError =
        produced.error || {
          code: "ERR_SCHEMA_RUNNER",
          message: `Failed to run ${target}`,
        };

      schemaResults.push({
        cmd: target,
        ok: false,
        exitCode: produced.exitCode,
        producerOk: Boolean(produced.ok),
        producerExitCode: typeof produced.exitCode === "number" ? produced.exitCode : null,
        runError: schemaRunnerError,
        schema: null,
      });
      break;
    }

    // Now run schema:check reading that JSON via stdin
    const schemaCheckArgs = ["--cmd", target, "--stdin", "true", "--json", "--quiet"];
    const schemaCheckRes = await new Promise((resolve) => {
      const node = process.execPath;
      const entry = path.resolve(process.cwd(), "index.js");
      const fullArgs = [entry, "schema:check", ...schemaCheckArgs];

      const child = spawn(node, fullArgs, {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

      child.stdin.write(JSON.stringify(produced.json));
      child.stdin.end();

      child.on("close", (code) => {
        const exitCode = typeof code === "number" ? code : 2;
        const outTrim = stdout.trim();
        const errTrim = stderr.trim() || "";

        if (!outTrim) {
          resolve({
            ok: false,
            exitCode,
            json: null,
            error: {
              code: "ERR_SCHEMA_NO_STDOUT",
              message: "schema:check produced no stdout",
              stderr: errTrim || null,
            },
          });
          return;
        }

        try {
          const parsed = JSON.parse(outTrim);
          resolve({
            ok: exitCode === 0 && parsed && parsed.ok === true,
            exitCode,
            json: parsed,
            error:
              exitCode === 0
                ? null
                : { code: "ERR_SCHEMA_FAIL", message: "Schema mismatch", stderr: errTrim || null },
          });
        } catch (e) {
          resolve({
            ok: false,
            exitCode,
            json: null,
            error: {
              code: "ERR_SCHEMA_BAD_JSON",
              message: "schema:check stdout was not valid JSON",
              parseError: String(e?.message || e),
              stdout: outTrim.slice(0, 2000),
              stderr: errTrim || null,
            },
          });
        }
      });
    });

    if (!schemaCheckRes.ok) schemaFailCount++;

    schemaResults.push({
      cmd: target,
      ok: schemaCheckRes.ok,
      exitCode: schemaCheckRes.exitCode,
      producerOk: Boolean(produced.ok),
      producerExitCode: typeof produced.exitCode === "number" ? produced.exitCode : null,
      runError: produced.error,
      schema: schemaCheckRes.json,
    });

    if (!schemaCheckRes.ok) {
      break;
    }

    if (settleMs > 0) await sleep(settleMs);
  }

  if (schemaRunnerError) {
    const finishedAt = new Date().toISOString();
    const payload = {
      ok: false,
      rootPath: path.resolve(root),
      startedAt,
      finishedAt,
      error: schemaRunnerError,
      schema: {
        ok: false,
        failCount: schemaFailCount,
        results: schemaResults,
      },
      contracts: null,
    };
    if (json) out.emitJson(payload);
    else out.log(`[ci:check] ERROR: ${schemaRunnerError.message || "schema runner error"}`);
    return 2;
  }

  if (schemaFailCount > 0) {
    const finishedAt = new Date().toISOString();
    const payload = {
      ok: false,
      rootPath: path.resolve(root),
      startedAt,
      finishedAt,
      error: { code: "ERR_SCHEMA_FAIL", message: "Schema mismatch" },
      schema: {
        ok: false,
        failCount: schemaFailCount,
        results: schemaResults,
      },
      contracts: null,
    };
    if (json) out.emitJson(payload);
    else out.log(`[ci:check] schema FAIL`);
    return 1;
  }

  // ---- Phase 2: contract:run (mode check) ----
  if (progress) out.log(`[ci:check] contracts contract:run (check)`);

  const contractArgs = [
    "--root",
    root,
    "--json",
    "--quiet",
    "--contracts",
    "true",
    "--contracts-mode",
    "check",
    "--contracts-dir",
    contractsDir,
    "--refresh-manifests",
    refreshManifests,

    // CI safety + snapshot stability for manifest:refresh:all
    "--apply",
    "false",
  ];

  if (noInstall) contractArgs.push("--no-install");
  else if (installMode && installMode !== "true") contractArgs.push("--install-mode", installMode);

  if (profile) contractArgs.push("--profile", profile);
  if (include) contractArgs.push("--include", include);
  if (typeof max === "number" && Number.isFinite(max)) contractArgs.push("--max", String(max));
  if (progress) contractArgs.push("--progress");
  if (healManifest) contractArgs.push("--heal-manifest");

  const contractRes = await runCliJson({
    cmd: "contract:run",
    args: contractArgs,
    timeoutMs: contractTimeoutMs,
  });

  if (!contractRes.json) {
    const finishedAt = new Date().toISOString();
    const payload = {
      ok: false,
      rootPath: path.resolve(root),
      startedAt,
      finishedAt,
      error:
        contractRes.error || { code: "ERR_CONTRACT_RUNNER", message: "contract:run runner error" },
      schema: {
        ok: true,
        failCount: 0,
        results: schemaResults,
      },
      contracts: null,
    };
    if (json) out.emitJson(payload);
    else out.log(`[ci:check] ERROR: ${payload.error.message}`);
    return 2;
  }

  const finishedAt = new Date().toISOString();

  // contract:run exit code meanings: 0 ok, 1 fail, 2 runner error
  const exitCode = typeof contractRes.exitCode === "number" ? contractRes.exitCode : 2;
  const ok = exitCode === 0;

  const payload = {
    ok,
    rootPath: path.resolve(root),
    startedAt,
    finishedAt,
    schema: {
      ok: true,
      failCount: 0,
      results: schemaResults,
    },
    contracts: contractRes.json,
  };

  if (json) out.emitJson(payload);
  else out.log(`[ci:check] ${ok ? "OK" : "FAIL"}`);

  if (exitCode === 2) return 2;
  return ok ? 0 : 1;
}
