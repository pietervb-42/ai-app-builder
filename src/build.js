// src/build.js
import fs from "fs";
import path from "path";
import os from "os";

import { createPlan } from "./plan.js";
import { resolveFromPlanObject } from "./plan-handoff.js";
import { generateApp } from "./generate.js";
import { validateAppRun } from "./validate.js";

/**
 * build
 *
 * node index.js build --prompt "<text>" [--out <path>] [--template <name>]
 *                     [--install-mode <always|never|if-missing>] [--dry-run]
 *                     [--write-policy <refuse|merge-safe|overwrite>] [--yes]
 *                     [--overwrite]  (legacy alias for overwrite mode)
 *                     [--json] [--quiet]
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

function isTrueish(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "on";
}

function normalizeWritePolicy(x) {
  const v = safeString(x).trim().toLowerCase();
  if (!v) return "__unset__";
  if (v === "refuse" || v === "merge-safe" || v === "overwrite") return v;
  return "__invalid__";
}

function fail(stage, code, message, extra = {}) {
  return {
    ok: false,
    stage: safeString(stage),
    error: {
      code: safeString(code),
      message: safeString(message),
      ...extra,
    },
    validation: null,
  };
}

function resolveUniqueOutPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  let i = 2;
  while (true) {
    const candidate = `${basePath}_${i}`;
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}

function toAbsOutPath(outPath) {
  return path.resolve(process.cwd(), safeString(outPath));
}

function listDirEntriesSafe(dirAbs) {
  try {
    if (!fs.existsSync(dirAbs)) return { ok: true, entries: [] };
    const st = fs.statSync(dirAbs);
    if (!st.isDirectory())
      return { ok: false, entries: [], error: "not_a_directory" };
    const entries = fs.readdirSync(dirAbs);
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, entries: [], error: String(e?.message ?? e) };
  }
}

function isRootPath(p) {
  const abs = path.resolve(p);
  const root = path.parse(abs).root;
  return abs === root;
}

function samePath(a, b) {
  const aa = path.resolve(a);
  const bb = path.resolve(b);
  if (process.platform === "win32") return aa.toLowerCase() === bb.toLowerCase();
  return aa === bb;
}

function hasDotGit(dirAbs) {
  try {
    const gitAbs = path.join(dirAbs, ".git");
    return fs.existsSync(gitAbs);
  } catch {
    return false;
  }
}

function computeWillInstallAssumingFresh({ installMode }) {
  if (installMode === "always") return true;
  if (installMode === "never") return false;
  return true;
}

function checkProtectedOutPath(outAbs) {
  const repoRootAbs = path.resolve(process.cwd());
  const homeAbs = path.resolve(os.homedir());

  if (samePath(outAbs, repoRootAbs)) {
    return {
      ok: false,
      code: "ERR_OUT_PROTECTED_PATH",
      message: "Refusing to write into the repo root as an output directory.",
      details: { path: outAbs, reason: "repo_root", repoRootAbs },
    };
  }

  if (isRootPath(outAbs)) {
    return {
      ok: false,
      code: "ERR_OUT_PROTECTED_PATH",
      message: "Refusing to use a filesystem root as an output directory.",
      details: { path: outAbs, reason: "filesystem_root" },
    };
  }

  if (samePath(outAbs, homeAbs)) {
    return {
      ok: false,
      code: "ERR_OUT_PROTECTED_PATH",
      message: "Refusing to use the user home folder as an output directory.",
      details: { path: outAbs, reason: "home_root", homeAbs },
    };
  }

  if (fs.existsSync(outAbs) && hasDotGit(outAbs)) {
    return {
      ok: false,
      code: "ERR_OUT_PROTECTED_PATH",
      message: "Refusing to write into a folder containing .git.",
      details: { path: outAbs, reason: "contains_dot_git" },
    };
  }

  return { ok: true };
}

function checkOutNotEmpty(outAbs) {
  if (!fs.existsSync(outAbs)) {
    return { ok: true, exists: false, empty: true, entries: [] };
  }

  const st = fs.statSync(outAbs);
  if (!st.isDirectory()) {
    return {
      ok: false,
      code: "ERR_OUT_NOT_DIRECTORY",
      message: "Output path exists but is not a directory.",
      details: { path: outAbs },
    };
  }

  const ls = listDirEntriesSafe(outAbs);
  if (!ls.ok) {
    return {
      ok: false,
      code: "ERR_OUT_READ_FAILED",
      message: "Could not read output directory to determine safety.",
      details: { path: outAbs, reason: ls.error },
    };
  }

  const entries = ls.entries || [];
  const empty = entries.length === 0;

  if (!empty) {
    return {
      ok: false,
      code: "ERR_OUT_NOT_EMPTY",
      message: "Refusing to use non-empty output directory.",
      details: { path: outAbs, blockingEntries: entries.slice().sort() },
    };
  }

  return { ok: true, exists: true, empty: true, entries };
}

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
  const dryRun = !!flags["dry-run"] || !!flags.dryRun;

  const installMode = normalizeInstallMode(flags["install-mode"] ?? flags.installMode);

  const writePolicyRaw = flags["write-policy"] ?? flags.writePolicy;
  const writePolicyNorm = normalizeWritePolicy(writePolicyRaw);

  const legacyOverwrite = !!flags.overwrite;
  const yes = isTrueish(flags.yes);

  if (!prompt) {
    process.stdout.write(JSON.stringify(fail("input", "ERR_MISSING_PROMPT", "Missing --prompt value.")) + "\n");
    return 1;
  }

  if (installMode === "__invalid__") {
    process.stdout.write(
      JSON.stringify(
        fail("input", "ERR_BAD_INSTALL_MODE", "Invalid --install-mode. Use always|never|if-missing.", {
          provided: safeString(flags["install-mode"] ?? flags.installMode),
        })
      ) + "\n"
    );
    return 1;
  }

  if (writePolicyNorm === "__invalid__") {
    process.stdout.write(
      JSON.stringify(
        fail("input", "ERR_BAD_WRITE_POLICY", "Invalid --write-policy. Use refuse|merge-safe|overwrite.", {
          provided: safeString(writePolicyRaw),
        })
      ) + "\n"
    );
    return 1;
  }

  const effectiveWritePolicy = legacyOverwrite
    ? "overwrite"
    : writePolicyNorm !== "__unset__"
      ? writePolicyNorm
      : "merge-safe";

  if (effectiveWritePolicy === "overwrite" && !yes) {
    process.stdout.write(
      JSON.stringify(
        fail(
          "input",
          "ERR_CONFIRM_REQUIRED",
          "Refusing overwrite mode without explicit confirmation. Re-run with --yes.",
          { details: { writePolicy: effectiveWritePolicy, requiredFlag: "--yes" } }
        )
      ) + "\n"
    );
    return 1;
  }

  const plan = createPlan(prompt);
  if (!plan?.ok) {
    process.stdout.write(JSON.stringify(fail("plan", "ERR_PLAN_FAILED", "PLAN did not return ok:true.", { plan })) + "\n");
    return 1;
  }

  const resolved = resolveFromPlanObject(plan, { out, templateOverride });
  if (!resolved?.ok) {
    process.stdout.write(
      JSON.stringify(
        fail(
          "handoff",
          resolved?.error?.code || "ERR_HANDOFF_FAILED",
          resolved?.error?.message || "PLAN → GENERATE handshake failed.",
          { details: resolved?.error }
        )
      ) + "\n"
    );
    return 1;
  }

  const template = resolved.template;
  const baseOutPath = resolved.outPath;

  const shouldSuffix = effectiveWritePolicy === "merge-safe" && !legacyOverwrite;
  const outPath = shouldSuffix ? resolveUniqueOutPath(baseOutPath) : baseOutPath;
  const overwrite = effectiveWritePolicy === "overwrite";

  const outPathAbs = toAbsOutPath(outPath);
  const willCreate = !fs.existsSync(outPathAbs);

  const protectedCheck = checkProtectedOutPath(outPathAbs);
  if (!protectedCheck.ok) {
    process.stdout.write(
      JSON.stringify(
        fail("output", protectedCheck.code, protectedCheck.message, {
          details: protectedCheck.details,
          template,
          outPath,
          outPathAbs,
          overwrite,
          writePolicy: effectiveWritePolicy,
        })
      ) + "\n"
    );
    return 1;
  }

  // IMPORTANT: refuse + overwrite require an EMPTY existing directory.
  // merge-safe avoids collisions by suffixing output path; it may write into a new dir.
  const mustBeEmptyIfExists = effectiveWritePolicy === "refuse" || effectiveWritePolicy === "overwrite";
  if (mustBeEmptyIfExists) {
    const emptyCheck = checkOutNotEmpty(outPathAbs);
    if (!emptyCheck.ok) {
      process.stdout.write(
        JSON.stringify(
          fail("output", emptyCheck.code, emptyCheck.message, {
            details: emptyCheck.details,
            template,
            outPath,
            outPathAbs,
            overwrite,
            writePolicy: effectiveWritePolicy,
          })
        ) + "\n"
      );
      return 1;
    }
  }

  if (dryRun) {
    const payload = {
      ok: true,
      stage: "dry-run",
      dryRun: true,
      plan,
      template,
      outPath,
      outPathAbs,
      willCreate,
      installMode,
      willInstallAssumingFresh: computeWillInstallAssumingFresh({ installMode }),
      overwrite,
      writePolicy: effectiveWritePolicy,
      notes: [
        "Dry-run only: no files were written.",
        "No generate/manifest/validate executed.",
        effectiveWritePolicy === "refuse"
          ? "write-policy=refuse: outPath is not suffixed; non-empty outputs are refused."
          : effectiveWritePolicy === "overwrite"
            ? "write-policy=overwrite: outPath is not suffixed; requires --yes; non-empty outputs are refused (no deletion)."
            : "write-policy=merge-safe: outPath may be deterministically suffixed to avoid overwrites.",
      ],
      validation: null,
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }

  let validationResult = null;
  let valExit = 1;

  try {
    await withMutedOutput(json === true, async () => {
      const generatedAbs = await generateApp({ template, outPath, overwrite });

      const { result, exitCode } = await validateAppRun({
        appPath: generatedAbs,
        installMode,
        quiet: true,
      });

      validationResult = result;
      valExit = exitCode;
    });
  } catch (e) {
    const errCode = safeString(e?.code || "ERR_BUILD_FAILED");
    const errDetails = e?.details && typeof e.details === "object" ? e.details : undefined;

    process.stdout.write(
      JSON.stringify({
        ok: false,
        stage: "generate",
        plan,
        template,
        outPath,
        outPathAbs,
        overwrite,
        writePolicy: effectiveWritePolicy,
        error: {
          code: errCode,
          message: String(e?.message ?? e),
          ...(errDetails ? { details: errDetails } : {}),
        },
        validation: validationResult,
      }) + "\n"
    );
    return 1;
  }

  const final = {
    ok: valExit === 0,
    stage: "validate",
    plan,
    template,
    outPath,
    outPathAbs,
    overwrite,
    writePolicy: effectiveWritePolicy,
    validation: validationResult,
  };

  process.stdout.write(JSON.stringify(final) + "\n");

  if (!json && !quiet) {
    process.stderr.write(final.ok ? `[build] OK -> ${outPath}\n` : `[build] FAIL -> ${outPath}\n`);
  }

  return final.ok ? 0 : 1;
}
