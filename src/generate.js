// src/generate.js
import fs from "fs/promises";
import path from "path";
import process from "process";
import { manifestInit } from "./manifest.js";

const ROOT = process.cwd();
const DEFAULT_OUTPUT_DIR = path.resolve(ROOT, "output");
const TEMPLATES_DIR = path.resolve(ROOT, "templates");

// Only these entries are allowed to exist in an "empty enough" output folder
// when overwrite is explicitly enabled.
// Keep this list conservative and stable.
const SAFE_EMPTY_ALLOWLIST = new Set([
  ".git",
  ".gitignore",
  ".gitattributes",
  ".DS_Store",
  "Thumbs.db",
  ".idea",
  ".vscode",
]);

function makeErr(code, message, details = null) {
  const e = new Error(String(message ?? ""));
  e.code = String(code ?? "ERR_RUNTIME");
  if (details && typeof details === "object") {
    // Keep details deterministic; callers should sort arrays before passing.
    e.details = details;
  }
  return e;
}

async function statSafe(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function templateDirExists(templateName) {
  const name = String(templateName ?? "").trim();
  if (!name) return false;
  const p = path.join(TEMPLATES_DIR, name);
  const st = await statSafe(p);
  return !!st && st.isDirectory();
}

function normalizeAbs(p) {
  return path.resolve(ROOT, String(p ?? ""));
}

function isSamePath(a, b) {
  const na = normalizeAbs(a);
  const nb = normalizeAbs(b);
  if (process.platform === "win32") return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

function isPathUnder(child, parent) {
  const c = normalizeAbs(child);
  const p = normalizeAbs(parent);

  const cp = process.platform === "win32" ? c.toLowerCase() : c;
  const pp = process.platform === "win32" ? p.toLowerCase() : p;

  if (cp === pp) return false;
  return cp.startsWith(pp + path.sep);
}

function assertSafeOutPath(destAbs) {
  const dest = normalizeAbs(destAbs);
  const rootOfDest = path.parse(dest).root;

  if (isSamePath(dest, rootOfDest)) {
    throw makeErr("ERR_OUT_UNSAFE", `Unsafe outPath: cannot generate into filesystem root: ${dest}`, {
      path: dest,
      reason: "FS_ROOT",
    });
  }

  if (isSamePath(dest, ROOT)) {
    throw makeErr("ERR_OUT_UNSAFE", `Unsafe outPath: cannot generate into repo root: ${dest}`, {
      path: dest,
      reason: "REPO_ROOT",
    });
  }

  if (isSamePath(dest, TEMPLATES_DIR) || isPathUnder(dest, TEMPLATES_DIR)) {
    throw makeErr(
      "ERR_OUT_UNSAFE",
      `Unsafe outPath: cannot generate into templates directory: ${dest}`,
      { path: dest, reason: "TEMPLATES_DIR" }
    );
  }

  if (isSamePath(dest, DEFAULT_OUTPUT_DIR)) {
    throw makeErr(
      "ERR_OUT_UNSAFE",
      `Unsafe outPath: cannot generate into output root folder directly: ${dest}`,
      { path: dest, reason: "OUTPUT_ROOT" }
    );
  }

  return dest;
}

async function listBlockingEntriesForSafeEmpty(dirAbs) {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  const names = entries.map((e) => e.name);

  // Deterministic
  names.sort((a, b) => a.localeCompare(b));

  const blocking = [];
  for (const name of names) {
    if (!SAFE_EMPTY_ALLOWLIST.has(name)) blocking.push(name);
  }

  // Deterministic
  blocking.sort((a, b) => a.localeCompare(b));
  return blocking;
}

// Decide where to generate the app
function resolveOutPath(outDirName) {
  if (!outDirName) throw new Error("outDirName is required");

  if (path.isAbsolute(outDirName)) return outDirName;

  const looksLikePath =
    outDirName.startsWith(".") ||
    outDirName.includes("/") ||
    outDirName.includes("\\");

  if (looksLikePath) return path.resolve(ROOT, outDirName);

  return path.join(DEFAULT_OUTPUT_DIR, outDirName);
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  // Deterministic order
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.name === "node_modules") continue;
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".sqlite")) continue;

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Step 41+42:
 * - overwrite must be explicitly enabled to reuse an existing folder
 * - even then, folder must be "safe empty" (allowlist-only)
 * - unsafe outPath guardrails (root/repo/templates/output-root)
 * - structured deterministic error codes + details
 */
export async function generateApp({ template, outPath, overwrite = false }) {
  if (!template) throw new Error("template is required");
  if (!outPath) throw new Error("outPath is required");

  const ok = await templateDirExists(template);
  if (!ok) {
    throw makeErr("ERR_TEMPLATE_NOT_FOUND", `Template not found: ${template}`, {
      template: String(template),
      templatesDir: TEMPLATES_DIR,
    });
  }

  const src = path.join(TEMPLATES_DIR, template);

  // Resolve + guardrails (Step 41)
  const destRaw = resolveOutPath(outPath);
  const dest = assertSafeOutPath(destRaw);

  const st = await statSafe(dest);
  const exists = !!st;

  if (exists) {
    if (!st.isDirectory()) {
      throw makeErr("ERR_OUT_NOT_DIR", `Output path exists and is not a directory: ${dest}`, {
        path: dest,
      });
    }

    if (!overwrite) {
      throw makeErr("ERR_OUT_EXISTS", `Output folder already exists: ${dest}`, {
        path: dest,
      });
    }

    const blocking = await listBlockingEntriesForSafeEmpty(dest);
    if (blocking.length > 0) {
      throw makeErr(
        "ERR_OUT_NOT_EMPTY",
        `Output folder is not empty (overwrite blocked). Path: ${dest}. Blocking entries: ${blocking.join(
          ", "
        )}`,
        {
          path: dest,
          blockingEntries: blocking, // deterministic sorted array
        }
      );
    }
  } else {
    await fs.mkdir(path.dirname(dest), { recursive: true });
  }

  await copyDir(src, dest);

  await manifestInit({ appPath: dest, yes: true, templateDir: src });

  return dest;
}

// Backwards-compatible alias
export async function generate({ template, outPath }) {
  return generateApp({ template, outPath });
}

/**
 * Kept for compatibility with any older callers.
 * generateFromTemplate expects { templateName, outDirName }.
 */
export async function generateFromTemplate({ templateName, outDirName }) {
  return generateApp({ template: templateName, outPath: outDirName });
}
