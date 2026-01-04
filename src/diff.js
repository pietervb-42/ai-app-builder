// src/diff.js
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { MANIFEST_NAME, shouldSkipDir, shouldSkipFile } from "./ignore.js";

function norm(p) {
  return p.replace(/\\/g, "/");
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fileSha256(p) {
  const buf = await fs.readFile(p);
  return sha256(buf);
}

/**
 * Extra exclusions that should NEVER affect drift fingerprint.
 * Must match manifest layer behavior so drift and integrity agree.
 */
const DEFAULT_EXTRA_EXCLUDED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".npmrc",
  "npm-debug.log",
  "yarn-error.log",
  ".ds_store",
  "thumbs.db",
]);

function toLowerSet(arr) {
  const s = new Set();
  for (const v of arr || []) {
    const t = String(v ?? "").trim();
    if (!t) continue;
    s.add(t.toLowerCase());
  }
  return s;
}

function mergeSets(a, b) {
  const out = new Set(a);
  for (const v of b) out.add(v);
  return out;
}

async function listFilesRecursive(rootDir, { excludedFiles } = {}) {
  const out = [];
  const excluded = excludedFiles instanceof Set ? excludedFiles : new Set();

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const e of entries) {
      const abs = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (shouldSkipDir(e.name)) continue;
        await walk(abs);
        continue;
      }

      if (e.isFile()) {
        // ignore.js rules (includes MANIFEST_NAME)
        if (shouldSkipFile(e.name)) continue;

        // manifest-aligned extra exclusions (lockfiles/tool noise, etc.)
        const lower = String(e.name).toLowerCase();
        if (excluded.has(lower)) continue;

        out.push(abs);
      }
    }
  }

  await walk(rootDir);
  return out;
}

async function computeFileMap(appPathAbs, { excludedFiles } = {}) {
  const files = await listFilesRecursive(appPathAbs, { excludedFiles });
  const map = {};
  for (const abs of files) {
    const rel = norm(path.relative(appPathAbs, abs));
    map[rel] = await fileSha256(abs);
  }
  return map;
}

async function computeFingerprintFromFileMap(fileMap) {
  const keys = Object.keys(fileMap).sort();
  const joined = keys.map((k) => `${k}=${fileMap[k]}`).join("\n");
  return sha256(Buffer.from(joined, "utf8"));
}

function writeJsonLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function eprintLine(s) {
  process.stderr.write(String(s) + "\n");
}

/**
 * readTextFileSafe(absPath, opts)
 * - text only (basic binary detection)
 * - size-capped
 */
export async function readTextFileSafe(absPath, opts = {}) {
  const maxBytes = Number(opts.maxBytes ?? 200_000); // 200KB
  const buf = await fs.readFile(absPath);

  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 0) return { ok: false, reason: "binary" };
    const isTabLfCr = c === 9 || c === 10 || c === 13;
    const isPrintable = c >= 32 && c <= 126;
    if (!isTabLfCr && !isPrintable) nonPrintable++;
  }
  if (nonPrintable > 200) return { ok: false, reason: "binary" };

  const sliced = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const text = sliced.toString("utf8");
  return {
    ok: true,
    text,
    truncated: buf.length > maxBytes,
    bytes: buf.length,
  };
}

export function resolveTemplateFilePath(templateDir, relPath) {
  const abs = path.resolve(templateDir, relPath);
  return abs;
}

export function unifiedDiff(oldText, newText, opts = {}) {
  const context = Number(opts.context ?? 3);
  const maxLines = Number(opts.maxLines ?? 400);

  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);

  const hunks = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }

    const startI = i;
    const startJ = j;

    const window = 50;
    let syncI = -1;
    let syncJ = -1;

    outer: for (let di = 0; di <= window && startI + di < a.length; di++) {
      for (let dj = 0; dj <= window && startJ + dj < b.length; dj++) {
        if (a[startI + di] === b[startJ + dj]) {
          syncI = startI + di;
          syncJ = startJ + dj;
          break outer;
        }
      }
    }

    const endI = syncI === -1 ? a.length : syncI;
    const endJ = syncJ === -1 ? b.length : syncJ;

    const preAStart = Math.max(0, startI - context);
    const preBStart = Math.max(0, startJ - context);

    const preA = a.slice(preAStart, startI);

    const del = a.slice(startI, endI);
    const add = b.slice(startJ, endJ);

    const postAEnd = Math.min(a.length, endI + context);
    const postBEnd = Math.min(b.length, endJ + context);

    const postA = a.slice(endI, postAEnd);
    const postB = b.slice(endJ, postBEnd);

    const hunkLines = [];
    hunkLines.push(
      `@@ -${preAStart + 1},${endI - preAStart} +${preBStart + 1},${endJ - preBStart} @@`
    );

    for (const line of preA) hunkLines.push(` ${line}`);
    for (const line of del) hunkLines.push(`-${line}`);
    for (const line of add) hunkLines.push(`+${line}`);
    for (let k = 0; k < Math.min(postA.length, postB.length); k++) {
      hunkLines.push(` ${postA[k]}`);
    }

    hunks.push(hunkLines);

    i = endI;
    j = endJ;
  }

  const flat = hunks.flat();
  if (flat.length > maxLines) {
    return (
      flat.slice(0, maxLines).join("\n") +
      `\n... (diff truncated at ${maxLines} lines)`
    );
  }
  return flat.join("\n");
}

/**
 * driftReport({ appPath, diff, json, quiet })
 *
 * Step 30 (JSON purity):
 * - If json=true:
 *    - stdout = one JSON object
 *    - stderr = optional logs only
 *    - NO human output
 *
 * NOTE: exit codes are preserved for index.js behavior:
 * - json errors => process.exit(1)
 * - json success => process.exit(0)
 */
export async function driftReport({
  appPath,
  diff = false,
  json = false,
  quiet = false,
}) {
  const appPathAbs = path.resolve(appPath);
  const manifestPath = path.join(appPathAbs, MANIFEST_NAME);

  if (!(await pathExists(manifestPath))) {
    const errObj = {
      ok: false,
      stage: "input",
      error: {
        code: "ERR_NO_MANIFEST",
        message: `builder.manifest.json not found at: ${manifestPath}`,
      },
    };

    if (json) {
      writeJsonLine(errObj);
      process.exit(1);
    }
    throw new Error(errObj.error.message);
  }

  const manifest = await readJson(manifestPath);

  // Build excludedFiles set aligned to manifest behavior.
  // Prefer manifest.ignoreRules.excludedFiles (if present), but always include defaults.
  const manifestExcluded =
    manifest && manifest.ignoreRules && Array.isArray(manifest.ignoreRules.excludedFiles)
      ? manifest.ignoreRules.excludedFiles
      : [];
  const excludedFiles = mergeSets(
    DEFAULT_EXTRA_EXCLUDED_FILES,
    toLowerSet(manifestExcluded)
  );

  const baseline = manifest.fileMap || null;
  if (!baseline) {
    const errObj = {
      ok: false,
      stage: "manifest",
      error: {
        code: "ERR_MANIFEST_NO_FILEMAP",
        message: "Manifest missing fileMap baseline. Cannot compute drift.",
      },
    };

    if (json) {
      writeJsonLine(errObj);
      process.exit(1);
    }
    throw new Error(errObj.error.message);
  }

  const current = await computeFileMap(appPathAbs, { excludedFiles });

  const added = [];
  const removed = [];
  const modified = [];

  const baseKeys = new Set(Object.keys(baseline));
  const curKeys = new Set(Object.keys(current));

  for (const k of curKeys) if (!baseKeys.has(k)) added.push(k);
  for (const k of baseKeys) if (!curKeys.has(k)) removed.push(k);
  for (const k of baseKeys) {
    if (curKeys.has(k) && baseline[k] !== current[k]) modified.push(k);
  }

  added.sort();
  removed.sort();
  modified.sort();

  const currentFingerprint = await computeFingerprintFromFileMap(current);
  const baselineFingerprint = manifest.fingerprint || null;

  let diffs = [];
  if (diff && modified.length) {
    const maxFiles = 5;
    const filesToDiff = modified.slice(0, maxFiles);

    for (const rel of filesToDiff) {
      const abs = path.join(appPathAbs, rel);
      const templateDir = manifest.templateDir;

      const entry = {
        relPath: rel,
        ok: false,
        reason: null,
        unified: null,
        truncated: false,
      };

      if (!templateDir) {
        entry.reason = "no_templateDir_in_manifest";
        diffs.push(entry);
        continue;
      }

      const templateAbs = path.resolve(templateDir, rel);
      if (!(await pathExists(templateAbs)) || !(await pathExists(abs))) {
        entry.reason = "missing_in_app_or_template";
        diffs.push(entry);
        continue;
      }

      const cur = await readTextFileSafe(abs, { maxBytes: 200_000 });
      const tpl = await readTextFileSafe(templateAbs, { maxBytes: 200_000 });

      if (!cur.ok || !tpl.ok) {
        entry.reason = "binary_or_unreadable_text";
        diffs.push(entry);
        continue;
      }

      const d = unifiedDiff(tpl.text, cur.text, { context: 3, maxLines: 300 });
      entry.ok = true;
      entry.unified = d;
      entry.truncated = Boolean(cur.truncated || tpl.truncated);
      diffs.push(entry);
    }
  }

  const summary = {
    ok: true,
    appPath: appPathAbs,
    manifestPath,
    template: manifest.template || "(unknown)",
    templateDir: manifest.templateDir || "(unknown)",
    added,
    removed,
    modified,
    baselineFingerprint: baselineFingerprint || "(none)",
    currentFingerprint,
    fingerprintMatches: baselineFingerprint
      ? baselineFingerprint === currentFingerprint
      : false,
    diffRequested: Boolean(diff),
    diffsCapped: Boolean(diff && modified.length > 5),
    diffs,
  };

  if (json) {
    writeJsonLine(summary);
    process.exit(0);
  }

  if (quiet) return;

  // Human output (stdout) in non-json mode (existing behavior preserved)
  process.stdout.write("\n");
  process.stdout.write(`[manifest] ${manifestPath}\n`);
  process.stdout.write(`[app] ${appPathAbs}\n`);
  process.stdout.write(`[template] ${manifest.template || "(unknown)"}\n`);
  process.stdout.write(`[templateDir] ${manifest.templateDir || "(unknown)"}\n`);
  process.stdout.write("\n");

  process.stdout.write("[drift:report] Summary\n");
  process.stdout.write(
    JSON.stringify(
      {
        added: added.length,
        removed: removed.length,
        modified: modified.length,
        baselineFingerprint: baselineFingerprint || "(none)",
        currentFingerprint,
        fingerprintMatches: baselineFingerprint
          ? baselineFingerprint === currentFingerprint
          : false,
      },
      null,
      2
    ) + "\n"
  );

  if (added.length) {
    process.stdout.write("\n");
    process.stdout.write(`[added files] (${added.length})\n`);
    for (const f of added) process.stdout.write(`+ ${f}\n`);
  }

  if (removed.length) {
    process.stdout.write("\n");
    process.stdout.write(`[removed files] (${removed.length})\n`);
    for (const f of removed) process.stdout.write(`- ${f}\n`);
  }

  if (modified.length) {
    process.stdout.write("\n");
    process.stdout.write(`[modified files] (${modified.length})\n`);
    for (const f of modified) process.stdout.write(`~ ${f}\n`);
  }

  if (!diff) return;

  if (!modified.length) {
    process.stdout.write("\n");
    process.stdout.write("[drift:report] --diff requested but no modified files found.\n");
    return;
  }

  process.stdout.write("\n");
  process.stdout.write(
    `[drift:report] Unified diffs (text-only, capped). Showing ${Math.min(
      5,
      modified.length
    )}/${modified.length}\n`
  );

  for (const d of diffs) {
    process.stdout.write("\n");
    process.stdout.write(`--- ${d.relPath} ---\n`);
    if (!d.ok) {
      process.stdout.write(`(diff skipped: ${d.reason})\n`);
      continue;
    }
    process.stdout.write(String(d.unified) + "\n");
    if (d.truncated) process.stdout.write("(note: one or both files were truncated for safety)\n");
  }

  if (modified.length > 5) {
    process.stdout.write("\n");
    process.stdout.write("(diff output capped: 5 files max)\n");
  }
}
