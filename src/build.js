// src/build.js
import fs from "fs";
import path from "path";

import { createPlan } from "./plan.js";
import { resolveFromPlanObject } from "./plan-handoff.js";
import { generateApp } from "./generate.js";
import { validateAppRun } from "./validate.js";

/**
 * Step 15/16: build
 *
 * node index.js build --prompt "<text>" [--out <path>] [--template <name>]
 *                     [--install-mode <always|never|if-missing>] [--dry-run]
 *                     [--json] [--quiet]
 *
 * Guarantees:
 * - build --json prints ONLY one JSON object line
 * - No overwrite of existing folders
 * - Deterministic suffixing if output exists
 *
 * Step 16: --dry-run
 * - PLAN + resolve template/outPath (+ suffix) only
 * - NO filesystem writes
 * - NO generate / manifest / validate
 *
 * Step 17: Absolute Path Normalisation (metadata only)
 * - Add outPathAbs alongside outPath in build + dry-run output
 * - No behavior changes
 */

function safeString(x) {
  return typeof x === "string" ? x : String(x ?? "");
}

function normalizeInstallMode(x) {
  const v = safeString(x).trim().toLowerCase();
  if (!v) return "if-missing";
  if (v === "always" || v === "never" || v === "if-missing") return v;
  return "__invalid__";
}

function fail(stage, code, message, extra = {}) {
  return {
    ok: false,
    stage,
    error: {
      code: safeString(code),
      message: safeString(message),
      ...extra,
    },
  };
}

/**
 * Deterministically find the first available folder:
 *   path
 *   path_2
 *   path_3
 *   ...
 *
 * Note: uses fs.existsSync only; no writes.
 */
function resolveUniqueOutPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;

  let i = 2;
  while (true) {
    const candidate = `${basePath}_${i}`;
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}

/**
 * Step 17 helper: deterministic absolute path for an outPath.
 * - Works for relative and absolute inputs
 * - Uses process.cwd() as the anchor (stable within a run)
 * - No filesystem access
 */
function toAbsOutPath(outPath) {
  return path.resolve(process.cwd(), safeString(outPath));
}

/**
 * Mute ALL output during pipeline when --json is enabled.
 * This guarantees build --json emits only the final JSON line.
 */
async function withMutedOutput(enabled, fn) {
  if (!enabled) return await fn();

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  const origConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const noop = () => {};
  const noopWrite = () => true;

  try {
    process.stdout.write = noopWrite;
    process.stderr.write = noopWrite;

    console.log = noop;
    console.info = noop;
    console.warn = noop;
    console.error = noop;

    return await fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;

    console.log = origConsole.log;
    console.info = origConsole.info;
    console.warn = origConsole.warn;
    console.error = origConsole.error;
  }
}

function computeWillInstallAssumingFresh({ installMode }) {
  // In a dry-run (no app generated yet), we cannot inspect node_modules.
  // Deterministic assumption: fresh output -> node_modules missing.
  if (installMode === "always") return true;
  if (installMode === "never") return false;
  // if-missing + fresh output => install would happen
  return true;
}

export async function buildCommand({ flags }) {
  const prompt = safeString(flags.prompt).trim();
  const out = flags.out;
  const templateOverride = flags.template;

  const json = !!flags.json;
  const quiet = !!flags.quiet;
  const dryRun = !!flags["dry-run"] || !!flags.dryRun;

  const installMode = normalizeInstallMode(
    flags["install-mode"] ?? flags.installMode
  );

  if (!prompt) {
    const result = fail("input", "ERR_MISSING_PROMPT", "Missing --prompt value.");
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  if (installMode === "__invalid__") {
    const result = fail(
      "input",
      "ERR_BAD_INSTALL_MODE",
      "Invalid --install-mode. Use always|never|if-missing.",
      { provided: safeString(flags["install-mode"] ?? flags.installMode) }
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  // 1) PLAN (no I/O)
  const plan = createPlan(prompt);
  if (!plan?.ok) {
    const result = fail("plan", "ERR_PLAN_FAILED", "PLAN did not return ok:true.", {
      plan,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  // 2) Resolve template + base outPath (Step 14 rules)
  const resolved = resolveFromPlanObject(plan, {
    out,
    templateOverride,
  });

  if (!resolved?.ok) {
    const result = fail(
      "handoff",
      resolved?.error?.code || "ERR_HANDOFF_FAILED",
      resolved?.error?.message || "PLAN → GENERATE handshake failed.",
      { details: resolved?.error }
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  const template = resolved.template;
  const baseOutPath = resolved.outPath;

  // Deterministic safe output selection (no overwrite)
  const outPath = resolveUniqueOutPath(baseOutPath);
  const outPathAbs = toAbsOutPath(outPath);
  const willCreate = !fs.existsSync(outPath);

  // Step 16: DRY RUN (no writes, no validate)
  if (dryRun) {
    const result = {
      ok: true,
      dryRun: true,
      plan,
      template,
      outPath,
      outPathAbs, // Step 17 metadata
      willCreate,
      installMode,
      willInstallAssumingFresh: computeWillInstallAssumingFresh({ installMode }),
      notes: [
        "Dry-run only: no files were written.",
        "No generate/manifest/validate executed.",
        "outPath includes deterministic suffixing to avoid overwrites.",
      ],
    };

    // Always write single JSON line for CI stability
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  }

  // Step 15 pipeline: generate + validate
  let validationResult = null;
  let valExit = 1;
  let generatedAbs = null;

  const pipeline = async () => {
    generatedAbs = await generateApp({
      template,
      outPath,
    });

    const { result, exitCode } = await validateAppRun({
      appPath: generatedAbs,
      installMode,
      quiet: true,
    });

    validationResult = result;
    valExit = exitCode;
  };

  try {
    // mute internal logs in --json mode so we output only final JSON
    await withMutedOutput(json === true, pipeline);
  } catch (e) {
    const result = {
      ok: false,
      stage: "generate",
      plan,
      template,
      outPath,
      outPathAbs, // Step 17 metadata (still useful on failure)
      error: {
        code: "ERR_BUILD_FAILED",
        message: String(e?.message ?? e),
      },
      validation: validationResult,
    };

    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  const final = {
    ok: valExit === 0,
    plan,
    template,
    outPath,
    outPathAbs, // Step 17 metadata
    validation: validationResult,
  };

  process.stdout.write(JSON.stringify(final) + "\n");

  if (!json && !quiet) {
    // Optional human hint to stderr (doesn't break JSON redirection)
    process.stderr.write(
      final.ok ? `[build] OK -> ${outPath}\n` : `[build] FAIL -> ${outPath}\n`
    );
  }

  return final.ok ? 0 : 1;
}
