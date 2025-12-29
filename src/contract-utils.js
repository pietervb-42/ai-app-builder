// src/contract-utils.js
import fs from "fs";
import path from "path";

/**
 * Step 33: CI Contract Lock (Golden Snapshots)
 *
 * Key Windows note:
 * - PowerShell `1>` redirection writes UTF-16LE with BOM for native programs.
 *   So JSON files captured via `... --json 1> file.json` are often UTF-16LE.
 * - We must decode JSON deterministically from either UTF-8 or UTF-16LE/BE.
 */

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function looksLikeIsoDateString(s) {
  if (typeof s !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(s.trim());
}

function looksLikePathString(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!t) return false;

  if (/^[a-zA-Z]:\\/.test(t)) return true; // Windows absolute
  if (t.startsWith("/")) return true; // POSIX absolute
  if (t.startsWith("\\\\")) return true; // UNC
  return false;
}

function shouldNormalizeKeyAsPath(key) {
  const k = String(key || "");
  if (!k) return false;
  if (k === "appPath") return true;
  if (k === "rootPath") return true;
  if (k === "manifestPath") return true;
  if (k === "templateDir") return true;
  if (k.endsWith("Path")) return true;
  return false;
}

function shouldNormalizeKeyAsTimestamp(key) {
  const k = String(key || "");
  if (!k) return false;
  if (k === "startedAt") return true;
  if (k === "finishedAt") return true;
  if (k === "timestamp") return true;
  if (k === "lastManifestRefreshUtc") return true;
  if (k === "lastManifestInitUtc") return true;
  if (k.endsWith("At")) return true;
  return false;
}

function shouldNormalizeKeyAsPortOrDuration(key) {
  const k = String(key || "");
  if (!k) return false;
  if (k === "port") return true;
  if (k === "durationMs") return true;
  if (k === "uptimeSeconds") return true;
  return false;
}

function shouldNormalizeKeyAsUrl(key) {
  const k = String(key || "");
  if (!k) return false;
  if (k === "url") return true;
  if (k === "baseUrl") return true;
  return false;
}

function deepCloneJson(x) {
  return JSON.parse(JSON.stringify(x));
}

function normalizeInPlace(node) {
  if (Array.isArray(node)) {
    for (const v of node) normalizeInPlace(v);
    return;
  }
  if (!isObject(node)) return;

  for (const key of Object.keys(node)) {
    const val = node[key];

    if (Array.isArray(val) || isObject(val)) {
      normalizeInPlace(val);
      continue;
    }

    if (shouldNormalizeKeyAsPath(key) && typeof val === "string") {
      node[key] = "<PATH>";
      continue;
    }

    if (shouldNormalizeKeyAsUrl(key) && typeof val === "string") {
      node[key] = "";
      continue;
    }

    if (shouldNormalizeKeyAsPortOrDuration(key) && typeof val === "number") {
      node[key] = 0;
      continue;
    }
    if (shouldNormalizeKeyAsPortOrDuration(key) && typeof val === "string") {
      node[key] = "0";
      continue;
    }

    if (shouldNormalizeKeyAsTimestamp(key) && typeof val === "string") {
      node[key] = looksLikeIsoDateString(val) ? null : null;
      continue;
    }

    if (typeof val === "string" && looksLikeIsoDateString(val)) {
      node[key] = null;
      continue;
    }

    if (typeof val === "string" && looksLikePathString(val)) {
      node[key] = "<PATH>";
      continue;
    }
  }
}

export function normalizeForContract(cmd, obj) {
  const payload = deepCloneJson(obj);
  normalizeInPlace(payload);
  return { __contractCmd: String(cmd || ""), payload };
}

function stableSortKeys(x) {
  if (Array.isArray(x)) return x.map(stableSortKeys);
  if (!isObject(x)) return x;

  const out = {};
  const keys = Object.keys(x).sort((a, b) => a.localeCompare(b));
  for (const k of keys) out[k] = stableSortKeys(x[k]);
  return out;
}

export function stableStringify(obj) {
  const sorted = stableSortKeys(obj);
  return JSON.stringify(sorted, null, 2) + "\n";
}

/**
 * Decode text from a buffer deterministically.
 * Supports:
 * - UTF-8 (default)
 * - UTF-16LE with BOM (FF FE)
 * - UTF-16BE with BOM (FE FF)
 */
function decodeText(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf ?? "");

  if (buf.length >= 2) {
    const b0 = buf[0];
    const b1 = buf[1];

    // UTF-16LE BOM
    if (b0 === 0xff && b1 === 0xfe) {
      return buf.slice(2).toString("utf16le");
    }

    // UTF-16BE BOM
    if (b0 === 0xfe && b1 === 0xff) {
      // Node doesn't support utf16be directly; swap bytes then decode as utf16le
      const swapped = Buffer.alloc(buf.length - 2);
      const src = buf.slice(2);
      for (let i = 0; i + 1 < src.length; i += 2) {
        swapped[i] = src[i + 1];
        swapped[i + 1] = src[i];
      }
      return swapped.toString("utf16le");
    }
  }

  // Heuristic fallback: PowerShell sometimes produces UTF-16LE without BOM.
  // If the buffer has lots of NUL bytes, treat as utf16le.
  let nulCount = 0;
  const sampleLen = Math.min(buf.length, 200);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0x00) nulCount++;
  }
  if (sampleLen > 0 && nulCount / sampleLen > 0.2) {
    return buf.toString("utf16le");
  }

  return buf.toString("utf8");
}

export function loadJsonFromFile(filePath) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  const buf = fs.readFileSync(abs);
  const raw = decodeText(buf);
  return { abs, value: JSON.parse(raw) };
}

export function readStdinUtf8() {
  const buf = fs.readFileSync(0);
  return decodeText(buf);
}

export function loadJsonFromStdin() {
  const raw = readStdinUtf8();
  if (!raw.trim()) throw new Error("stdin is empty");
  return { raw, value: JSON.parse(raw) };
}

export function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function writeSnapshotFile(filePath, normalizedObj) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, stableStringify(normalizedObj), "utf8");
}

export function readSnapshotFile(filePath) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  const raw = fs.readFileSync(abs, "utf8");
  return { abs, value: JSON.parse(raw) };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!deepEqual(a[ak[i]], b[bk[i]])) return false;
    }
    return true;
  }

  return false;
}

function diffSummary(a, b) {
  return {
    sameType: typeof a === typeof b,
    aIsArray: Array.isArray(a),
    bIsArray: Array.isArray(b),
    aKeys: isObject(a) ? Object.keys(a).length : null,
    bKeys: isObject(b) ? Object.keys(b).length : null,
    aLen: Array.isArray(a) ? a.length : null,
    bLen: Array.isArray(b) ? b.length : null,
  };
}

export function compareNormalized(expected, actual) {
  const ok = deepEqual(expected, actual);
  return { ok, summary: ok ? null : diffSummary(expected, actual) };
}
