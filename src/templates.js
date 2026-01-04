// src/templates.js
import fs from "fs";
import path from "path";
import crypto from "crypto";

function hasFlag(flags, name) {
  return Boolean(flags && Object.prototype.hasOwnProperty.call(flags, name) && flags[name]);
}

function isTrueish(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "on";
}

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listDirs(absDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function normalizeTemplateId(item) {
  // The core fix: never stringify objects to "[object Object]"
  if (typeof item === "string") return item;

  if (item && typeof item === "object") {
    // Common key guesses (stable + safe)
    const candidates = [
      item.id,
      item.name,
      item.slug,
      item.template,
      item.key,
      item.value,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  }

  return null;
}

function loadTemplateIds({ templatesDir = "templates" } = {}) {
  const absTemplatesDir = path.isAbsolute(templatesDir)
    ? templatesDir
    : path.resolve(process.cwd(), templatesDir);

  // Preferred: templates/templates.json (if you want to curate ordering later)
  const configPath = path.join(absTemplatesDir, "templates.json");
  const cfg = readJsonIfExists(configPath);

  // If templates.json exists, it can be:
  // - ["node-hello", ...]
  // - { templates: [...] }
  // - [{ id: "node-hello" }, ...]
  let rawList = null;

  if (Array.isArray(cfg)) rawList = cfg;
  else if (cfg && Array.isArray(cfg.templates)) rawList = cfg.templates;

  if (Array.isArray(rawList)) {
    const ids = [];
    for (const item of rawList) {
      const id = normalizeTemplateId(item);
      if (id) ids.push(id);
    }
    // Deterministic
    ids.sort((a, b) => a.localeCompare(b));
    return { absTemplatesDir, ids };
  }

  // Fallback: just list directories in templates/
  if (!fs.existsSync(absTemplatesDir) || !fs.statSync(absTemplatesDir).isDirectory()) {
    return { absTemplatesDir, ids: [] };
  }

  const ids = listDirs(absTemplatesDir).filter((d) => d !== ".git");
  ids.sort((a, b) => a.localeCompare(b));
  return { absTemplatesDir, ids };
}

function shouldIgnore(relPosix) {
  const p = relPosix.toLowerCase();

  // Ignore junk / heavy folders (deterministic inventory; avoid noise)
  const ignoreDirs = [
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    ".next/",
    ".cache/",
    "coverage/",
    ".builder_snapshots/",
  ];

  for (const d of ignoreDirs) {
    if (p.startsWith(d) || p.includes(`/${d}`)) return true;
  }

  // Ignore common noise files
  const ignoreFiles = [
    ".ds_store",
    "thumbs.db",
  ];
  for (const f of ignoreFiles) {
    if (p.endsWith("/" + f) || p === f) return true;
  }

  return false;
}

function walkFiles(absRoot) {
  const files = [];

  function walk(currentAbs, relBase) {
    const entries = fs.readdirSync(currentAbs, { withFileTypes: true });
    // Deterministic: sort names
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const e of entries) {
      const abs = path.join(currentAbs, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      const relPosix = toPosix(rel);

      if (shouldIgnore(relPosix)) continue;

      if (e.isDirectory()) {
        walk(abs, rel);
      } else if (e.isFile()) {
        files.push({ absPath: abs, relPath: relPosix });
      }
    }
  }

  walk(absRoot, "");
  // Already deterministic by sorted traversal, but keep it explicit:
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function computeTemplateInventory(absTemplateDir) {
  const files = walkFiles(absTemplateDir);

  let totalBytes = 0;
  const fileEntries = [];

  for (const f of files) {
    const buf = fs.readFileSync(f.absPath);
    totalBytes += buf.length;
    fileEntries.push({
      path: f.relPath, // already posix
      bytes: buf.length,
      sha256: sha256(buf),
    });
  }

  // Stable hash for the whole template (based on stable file list string)
  const stableListString = fileEntries
    .map((x) => `${x.path}\n${x.bytes}\n${x.sha256}`)
    .join("\n");
  const templateHash = sha256(Buffer.from(stableListString, "utf8"));

  return {
    ok: true,
    fileCount: fileEntries.length,
    totalBytes,
    templateHash,
    files: fileEntries,
  };
}

/**
 * templates:list
 * - Matches current behavior: in --json mode prints an array of template IDs (not wrapped object)
 */
export async function templatesList({ json } = {}) {
  const { ids } = loadTemplateIds({ templatesDir: "templates" });

  if (json) {
    process.stdout.write(JSON.stringify(ids) + "\n");
    return;
  }

  process.stdout.write("Templates:\n");
  for (const id of ids) process.stdout.write(`- ${id}\n`);
}

/**
 * templates:inventory
 * - Deterministic JSON payload: one object to stdout in --json mode
 * - Exit code: 0 if all templates ok, else 1
 */
export async function templatesInventoryCommand({ flags } = {}) {
  const json =
    hasFlag(flags, "json") ||
    isTrueish(flags?.json);

  const templatesDir = flags?.["templates-dir"]
    ? String(flags["templates-dir"])
    : "templates";

  const { absTemplatesDir, ids } = loadTemplateIds({ templatesDir });

  const results = [];
  let okAll = true;

  for (const id of ids) {
    const abs = path.join(absTemplatesDir, id);

    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      okAll = false;
      results.push({
        id,
        ok: false,
        error: `Template directory missing: ${toPosix(path.join(templatesDir, id))}`,
        fileCount: 0,
        totalBytes: 0,
        templateHash: null,
        files: [],
      });
      continue;
    }

    try {
      const inv = computeTemplateInventory(abs);
      results.push({
        id,
        ok: true,
        error: null,
        fileCount: inv.fileCount,
        totalBytes: inv.totalBytes,
        templateHash: inv.templateHash,
        files: inv.files,
      });
    } catch (e) {
      okAll = false;
      results.push({
        id,
        ok: false,
        error: String(e?.message || e),
        fileCount: 0,
        totalBytes: 0,
        templateHash: null,
        files: [],
      });
    }
  }

  const payload = {
    ok: okAll,
    cmd: "templates:inventory",
    templatesDir: toPosix(templatesDir),
    templatesCount: ids.length,
    templates: results,
    notes: [
      "Deterministic output: files are sorted lexicographically; paths use forward slashes.",
      "Hashes are sha256 over file contents; templateHash is sha256 over the stable file list string.",
      "Common junk folders are ignored (node_modules, .git, dist, build, etc.).",
    ],
  };

  if (json) {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    process.stdout.write(`templates:inventory (${payload.templatesCount} templates)\n`);
    for (const t of payload.templates) {
      process.stdout.write(`- ${t.id}: ${t.ok ? "OK" : "FAIL"} (${t.fileCount} files)\n`);
    }
  }

  return okAll ? 0 : 1;
}
