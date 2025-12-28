// src/build.js
import fs from "fs";
import path from "path";

import { createPlan } from "./plan.js";
import { resolveFromPlanObject } from "./plan-handoff.js";
import { generateApp } from "./generate.js";
import { validateAppRun } from "./validate.js";

/**
 * Step 15: build
 * node index.js build --prompt "<text>" [--out <path>] [--template <name>]
 *                     [--install-mode <always|never|if-missing>] [--json] [--quiet]
 *
 * Guarantees:
 * - Single JSON output in --json mode
 * - No overwrite of existing folders
 * - Deterministic suffixing if output exists
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
 * Mute ALL output during pipeline when --json is enabled.
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

export async function buildCommand({ flags }) {
  const prompt = safeString(flags.prompt).trim();
  const out = flags.out;
  const templateOverride = flags.template;
  const json = !!flags.json;
  const quiet = !!flags.quiet;

  const installMode = normalizeInstallMode(flags["install-mode"] ?? flags.installMode);

  if (!prompt) {
    const result = fail("input", "ERR_MISSING_PROMPT", "Missing --prompt value.");
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  if (installMode === "__invalid__") {
    const result = fail(
      "input",
      "ERR_BAD_INSTALL_MODE",
      "Invalid --install-mode. Use always|never|if-missing."
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  // 1) PLAN
  const plan = createPlan(prompt);
  if (!plan?.ok) {
    const result = fail("plan", "ERR_PLAN_FAILED", "PLAN did not return ok:true.", { plan });
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  // 2) Resolve template + base outPath
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
  const finalOutPath = resolveUniqueOutPath(baseOutPath);

  let validationResult = null;
  let valExit = 1;

  const pipeline = async () => {
    const generatedAbs = await generateApp({
      template,
      outPath: finalOutPath,
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
    await withMutedOutput(json === true, pipeline);
  } catch (e) {
    const result = {
      ok: false,
      stage: "generate",
      plan,
      template,
      outPath: finalOutPath,
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
    outPath: finalOutPath,
    validation: validationResult,
  };

  process.stdout.write(JSON.stringify(final) + "\n");
  return final.ok ? 0 : 1;
}
