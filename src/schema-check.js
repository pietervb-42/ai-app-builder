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

export async function schemaCheck({ flags }) {
  const json = hasFlag(flags, "json");
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

    if (json || quiet) writeJsonLine(payload);
    else process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(2);
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

    if (json || quiet) writeJsonLine(payload);
    else process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(2);
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

    if (json || quiet) writeJsonLine(payload);
    else process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw || "").trim());
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

    if (json || quiet) writeJsonLine(payload);
    else process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(2);
  }

  const res = checker(parsed);
  const payload = {
    ok: Boolean(res.ok),
    cmd: cmdName,
    error: res.ok
      ? null
      : {
          code: "ERR_SCHEMA_FAIL",
          message: "Schema mismatch",
        },
    issues: Array.isArray(res.issues) ? res.issues : [],
  };

  if (json || quiet) {
    writeJsonLine(payload);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  }

  process.exit(payload.ok ? 0 : 1);
}
