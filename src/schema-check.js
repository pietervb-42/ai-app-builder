// src/schema-check.js
import fs from "fs";
import path from "path";
import { SCHEMA_CHECKERS } from "./ci-schemas.js";

function hasFlag(flags, name) {
  return Boolean(flags[name]);
}

function requireFlag(flags, name) {
  const v = flags[name];
  if (!v || v === true) throw new Error(`Missing required flag: --${name}`);
  return v;
}

function isTrueish(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "on";
}

function readStdinUtf8() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function writeJsonLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function safeString(x) {
  if (x == null) return "";
  return String(x);
}

function normalizeIssues(issues) {
  const arr = Array.isArray(issues) ? issues : [];
  const cleaned = [];

  for (const it of arr) {
    // Keep deterministic shape even if callers pass weird objects.
    const p = safeString(it?.path);
    const m = safeString(it?.message);
    cleaned.push({ path: p, message: m });
  }

  // Deterministic ordering for CI snapshots:
  // sort by path, then message.
  cleaned.sort((a, b) => {
    const ap = a.path;
    const bp = b.path;
    if (ap < bp) return -1;
    if (ap > bp) return 1;
    const am = a.message;
    const bm = b.message;
    if (am < bm) return -1;
    if (am > bm) return 1;
    return 0;
  });

  return cleaned;
}

function emitAndExit({ jsonMode, quiet, payload, exitCode }) {
  // Per your global rule:
  // --json => stdout is ONE machine JSON object only; stderr is human logs only.
  // This command produces no human logs; errors are encoded in JSON output when json/quiet is set.
  if (jsonMode || quiet) {
    writeJsonLine(payload);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  }
  process.exit(exitCode);
}

export async function schemaCheck({ flags }) {
  const jsonMode = hasFlag(flags, "json");
  const quiet = hasFlag(flags, "quiet");

  const cmdName = String(requireFlag(flags, "cmd"));
  const checker = SCHEMA_CHECKERS[cmdName];

  if (!checker) {
    const known = Object.keys(SCHEMA_CHECKERS).sort();
    const payload = {
      ok: false,
      cmd: cmdName,
      error: {
        code: "ERR_SCHEMA_INPUT",
        message: `Unknown schema cmd: ${cmdName}. Known: ${known.join(", ")}`,
      },
      issues: [],
    };

    emitAndExit({ jsonMode, quiet, payload, exitCode: 2 });
  }

  const useStdin = isTrueish(flags.stdin);
  const filePath = flags.file ? String(flags.file) : "";

  if (!useStdin && !filePath) {
    const payload = {
      ok: false,
      cmd: cmdName,
      error: {
        code: "ERR_SCHEMA_INPUT",
        message: "Provide either --file <path> or --stdin true",
      },
      issues: [],
    };

    emitAndExit({ jsonMode, quiet, payload, exitCode: 2 });
  }

  let raw = "";
  try {
    if (useStdin) {
      raw = await readStdinUtf8();
    } else {
      const abs = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
      raw = fs.readFileSync(abs, "utf8");
    }
  } catch (e) {
    const payload = {
      ok: false,
      cmd: cmdName,
      error: {
        code: "ERR_SCHEMA_INPUT",
        message: `Failed to read input: ${String(e?.message || e)}`,
      },
      issues: [],
    };

    emitAndExit({ jsonMode, quiet, payload, exitCode: 2 });
  }

  let parsed;
  try {
    // Trim whitespace; if empty, JSON.parse will throw (correct).
    parsed = JSON.parse(String(raw ?? "").trim());
  } catch (e) {
    const payload = {
      ok: false,
      cmd: cmdName,
      error: {
        code: "ERR_SCHEMA_PARSE",
        message: `Input was not valid JSON: ${String(e?.message || e)}`,
      },
      issues: [],
    };

    emitAndExit({ jsonMode, quiet, payload, exitCode: 2 });
  }

  const res = checker(parsed);
  const issues = normalizeIssues(res?.issues);

  const payload = {
    ok: Boolean(res?.ok),
    cmd: cmdName,
    error: res?.ok
      ? null
      : {
          code: "ERR_SCHEMA_FAIL",
          message: "Schema mismatch",
        },
    issues,
  };

  emitAndExit({ jsonMode, quiet, payload, exitCode: payload.ok ? 0 : 1 });
}
