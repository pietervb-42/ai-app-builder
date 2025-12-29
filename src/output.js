// src/output.js
import process from "process";
import fs from "fs";
import path from "path";

/**
 * CI Output Guard
 *
 * Rules:
 * - When json=true: stdout must be ONE JSON value per invocation (call emitJson once).
 * - Human logs must go to stderr (via log()).
 * - quiet=true suppresses stderr logs (but never suppresses JSON output).
 *
 * This file is intentionally tiny and deterministic.
 */

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function ensureTrailingNewline(s) {
  const str = String(s ?? "");
  return str.endsWith("\n") ? str : str + "\n";
}

export function createOutput({ json = false, quiet = false } = {}) {
  const jsonMode = Boolean(json);
  const quietMode = Boolean(quiet);

  function log(msg) {
    if (quietMode) return;
    process.stderr.write(ensureTrailingNewline(msg));
  }

  function emitJson(value) {
    // Always write exactly one JSON line.
    process.stdout.write(JSON.stringify(value) + "\n");
  }

  function emitHuman(msg) {
    process.stdout.write(ensureTrailingNewline(msg));
  }

  function makeErrorPayload({ code, message, details } = {}) {
    const payload = {
      ok: false,
      error: {
        code: String(code || "ERR_CLI"),
        message: String(message || "Unknown error"),
      },
    };

    if (details !== undefined) {
      payload.error.details = details;
    }
    return payload;
  }

  function emitErrorJson({ code, message, details } = {}) {
    emitJson(makeErrorPayload({ code, message, details }));
  }

  return {
    json: jsonMode,
    quiet: quietMode,
    log,
    emitJson,
    emitHuman,
    emitErrorJson,
    makeErrorPayload,
  };
}

export function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJsonFileSync(filePath, obj) {
  ensureDirForFile(filePath);
  const json = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(filePath, json, "utf8");
}

/**
 * Utility: detect piped stdout deterministically.
 * - In CI, stdout is commonly non-TTY.
 */
export function isStdoutPiped() {
  return process.stdout && process.stdout.isTTY === false;
}

/**
 * Utility: normalize a boolean-ish flag value deterministically.
 * Supports: true/false, "true"/"false", "1"/"0", "yes"/"no"
 */
export function normalizeBoolFlag(v, defaultValue = false) {
  if (v === undefined) return defaultValue;
  if (v === true) return true;
  if (v === false) return false;

  const s = String(v).toLowerCase().trim();
  if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "0" || s === "no" || s === "n") return false;

  // Deterministic fallback
  return defaultValue;
}
