// src/manifest.js
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import process from "process";
import {
  MANIFEST_NAME,
  DEFAULT_EXCLUDED_DIRS,
  shouldSkipDir,
  shouldSkipFile,
} from "./ignore.js";

/**
 * Manifest schema version (internal metadata only).
 * Safe to bump; consumers should not depend on this.
 */
const MANIFEST_SCHEMA_VERSION = 2;

/**
 * Extra exclusions that should NEVER affect the integrity fingerprint.
 * Reason: these are often rewritten by installers/tools without changing app logic.
 *
 * NOTE: We exclude these at the manifest layer so you are protected even if ignore.js changes.
 */
const EXTRA_EXCLUDED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".npmrc", // can be environment-specific
  "npm-debug.log",
  "yarn-error.log",
  ".ds_store",
  "thumbs.db",
]);

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

async function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fileSha256(p) {
  const buf = await fs.readFile(p);
  return sha256(buf);
}

/**
 * listFilesRecursive(rootDir)
 * Deterministic traversal:
 * - sorts entries by name
 * - excludes DEFAULT_EXCLUDED_DIRS via shouldSkipDir
 * - excludes MANIFEST_NAME via shouldSkipFile
 * - excludes EXTRA_EXCLUDED_FILES (lockfiles/tool noise)
 */
async function listFilesRecursive(rootDir) {
  const out = [];

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
        // Ignore rules from ignore.js
        if (shouldSkipFile(e.name)) continue;

        // Extra safety exclusions (installer/tool rewritten files)
        if (EXTRA_EXCLUDED_FILES.has(e.name.toLowerCase())) continue;

        out.push(abs);
      }
    }
  }

  await walk(rootDir);
  return out;
}

async function computeFileMap(appPathAbs) {
  const files = await listFilesRecursive(appPathAbs);
  const map = {};
  for (const abs of files) {
    const rel = norm(path.relative(appPathAbs, abs));
    map[rel] = await fileSha256(abs);
  }
  return map;
}

function computeFingerprintFromFileMap(fileMap) {
  const keys = Object.keys(fileMap).sort();
  const joined = keys.map((k) => `${k}=${fileMap[k]}`).join("\n");
  return sha256(Buffer.from(joined, "utf8"));
}

/**
 * ✅ Exported for other modules (generate/drift/etc.)
 * Deterministic fingerprint for an app directory using shared ignore rules.
 */
export async function computeAppFingerprint(appPath) {
  const appPathAbs = path.resolve(appPath);
  if (!(await pathExists(appPathAbs))) {
    throw new Error(`App path not found: ${appPathAbs}`);
  }
  const fileMap = await computeFileMap(appPathAbs);
  return computeFingerprintFromFileMap(fileMap);
}

/**
 * ✅ Exported (optional utility) for callers that want fileMap too.
 */
export async function computeAppFileMap(appPath) {
  const appPathAbs = path.resolve(appPath);
  if (!(await pathExists(appPathAbs))) {
    throw new Error(`App path not found: ${appPathAbs}`);
  }
  return computeFileMap(appPathAbs);
}

function isSubpath(child, parent) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function deriveTemplateName(templateDirAbs) {
  const repoRoot = process.cwd();
  const templatesRoot = path.resolve(repoRoot, "templates");
  const resolved = path.resolve(templateDirAbs);

  // If it’s inside /templates, use the folder name as template.
  if (resolved === templatesRoot) return path.basename(resolved);
  if (isSubpath(resolved, templatesRoot)) {
    return path.basename(resolved);
  }

  // Otherwise, return null (still allowed; templateDir is the source of truth)
  return null;
}

function logStderr(line) {
  process.stderr.write(String(line) + "\n");
}

function printHeader({ manifestPath, appPathAbs }) {
  logStderr("");
  logStderr(`[manifest] ${manifestPath}`);
  logStderr(`[app] ${appPathAbs}`);
  logStderr("");
}

/**
 * Step 18: Manifest Integrity Lock helpers
 */
function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function safeString(x) {
  return typeof x === "string" ? x : String(x ?? "");
}

/**
 * Read and parse builder.manifest.json
 * Returns:
 *  { ok:true, manifest, manifestPath }
 *  { ok:false, error:{code,message}, manifestPath }
 */
export async function readManifest({ appPath }) {
  const appPathAbs = path.resolve(appPath);
  const manifestPath = path.join(appPathAbs, MANIFEST_NAME);

  if (!(await pathExists(manifestPath))) {
    return {
      ok: false,
      manifestPath,
      error: {
        code: "ERR_MANIFEST_MISSING",
        message: `${MANIFEST_NAME} not found at: ${manifestPath}`,
      },
    };
  }

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);

    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        manifestPath,
        error: {
          code: "ERR_MANIFEST_INVALID",
          message: `${MANIFEST_NAME} must be a JSON object.`,
        },
      };
    }

    return { ok: true, manifestPath, manifest: parsed };
  } catch (e) {
    return {
      ok: false,
      manifestPath,
      error: {
        code: "ERR_MANIFEST_PARSE",
        message: `Failed to parse ${MANIFEST_NAME}.`,
        details: { error: safeString(e?.message ?? e) },
      },
    };
  }
}

/**
 * Verify manifest integrity by recomputing current fingerprint and comparing.
 *
 * Returns:
 *  { ok:true, manifestPath, expectedFingerprint, currentFingerprint, matches:true, template, templateDir }
 *  { ok:false, manifestPath, error:{code,message,details}, expectedFingerprint, currentFingerprint, matches:false }
 */
export async function verifyManifestIntegrity({ appPath, requireManifest = true }) {
  const appPathAbs = path.resolve(appPath);
  const manifestPath = path.join(appPathAbs, MANIFEST_NAME);

  if (!(await pathExists(appPathAbs))) {
    return {
      ok: false,
      manifestPath,
      matches: false,
      error: {
        code: "ERR_APP_NOT_FOUND",
        message: `App path not found: ${appPathAbs}`,
      },
      expectedFingerprint: null,
      currentFingerprint: null,
    };
  }

  const mf = await readManifest({ appPath: appPathAbs });

  if (!mf.ok) {
    if (!requireManifest && mf.error?.code === "ERR_MANIFEST_MISSING") {
      return {
        ok: true,
        manifestPath,
        matches: true,
        expectedFingerprint: null,
        currentFingerprint: null,
        template: null,
        templateDir: null,
        notes: ["Manifest not required; skipping integrity lock."],
      };
    }

    return {
      ok: false,
      manifestPath,
      matches: false,
      error: mf.error,
      expectedFingerprint: null,
      currentFingerprint: null,
    };
  }

  const manifest = mf.manifest;

  const expectedFingerprint =
    typeof manifest.fingerprint === "string" && manifest.fingerprint.trim()
      ? manifest.fingerprint.trim()
      : null;

  if (!expectedFingerprint) {
    return {
      ok: false,
      manifestPath,
      matches: false,
      error: {
        code: "ERR_MANIFEST_NO_FINGERPRINT",
        message: `${MANIFEST_NAME} is missing required key: fingerprint`,
      },
      expectedFingerprint: null,
      currentFingerprint: null,
    };
  }

  let currentFingerprint = null;
  try {
    const fileMap = await computeFileMap(appPathAbs);
    currentFingerprint = computeFingerprintFromFileMap(fileMap);
  } catch (e) {
    return {
      ok: false,
      manifestPath,
      matches: false,
      error: {
        code: "ERR_FINGERPRINT_COMPUTE",
        message: "Failed to compute current fingerprint.",
        details: { error: safeString(e?.message ?? e) },
      },
      expectedFingerprint,
      currentFingerprint: null,
    };
  }

  const matches = currentFingerprint === expectedFingerprint;

  if (!matches) {
    return {
      ok: false,
      manifestPath,
      matches: false,
      error: {
        code: "ERR_MANIFEST_DRIFT",
        message:
          "Manifest fingerprint does not match current app fingerprint (drift detected).",
        details: {
          expectedFingerprint,
          currentFingerprint,
        },
      },
      expectedFingerprint,
      currentFingerprint,
    };
  }

  return {
    ok: true,
    manifestPath,
    matches: true,
    expectedFingerprint,
    currentFingerprint,
    template: typeof manifest.template === "string" ? manifest.template : null,
    templateDir: typeof manifest.templateDir === "string" ? manifest.templateDir : null,
  };
}

/**
 * manifestInit({ appPath, yes, templateDir })
 * Recreates or overwrites builder.manifest.json with:
 * - template + templateDir
 * - fingerprint + fileMap (computed using shared ignore rules + EXTRA_EXCLUDED_FILES)
 */
export async function manifestInit({ appPath, yes, templateDir }) {
  const appPathAbs = path.resolve(appPath);
  const manifestPath = path.join(appPathAbs, MANIFEST_NAME);

  if (!templateDir) {
    throw new Error("Missing required flag: --templateDir");
  }

  if (!yes) {
    logStderr("[manifest:init] Refusing to run because --yes was not provided.");
    logStderr("Example:");
    logStderr(
      `  node index.js manifest:init --app ${appPath} --yes --templateDir ${templateDir}`
    );
    return;
  }

  if (!(await pathExists(appPathAbs))) {
    throw new Error(`App path not found: ${appPathAbs}`);
  }

  const templateDirAbs = path.resolve(templateDir);
  if (!(await pathExists(templateDirAbs))) {
    throw new Error(`Template directory not found: ${templateDirAbs}`);
  }

  const willCreate = !(await pathExists(manifestPath));
  const willOverwrite = !willCreate;

  // IMPORTANT: compute baseline using shared ignore rules + EXTRA exclusions
  const fileMap = await computeFileMap(appPathAbs);
  const fingerprint = computeFingerprintFromFileMap(fileMap);

  const templateName = deriveTemplateName(templateDirAbs);

  printHeader({ manifestPath, appPathAbs });

  logStderr("[manifest:init] Proposed manifest");
  logStderr(
    JSON.stringify(
      {
        willCreate,
        willOverwrite,
        template: templateName || "(unknown)",
        templateDir: templateDirAbs,
        fingerprint,
        fileMapEntries: Object.keys(fileMap).length,
        excludedDirs: Array.from(DEFAULT_EXCLUDED_DIRS || []),
        excludedFiles: Array.from(EXTRA_EXCLUDED_FILES || []),
        manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
      },
      null,
      2
    )
  );
  logStderr("");

  const now = new Date().toISOString();

  const existing = willOverwrite ? await readJson(manifestPath) : {};
  const updated = {
    ...existing,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    ignoreRules: {
      excludedDirs: Array.from(DEFAULT_EXCLUDED_DIRS || []),
      excludedFiles: Array.from(EXTRA_EXCLUDED_FILES || []),
    },
    template: templateName || existing.template || "(unknown)",
    templateDir: templateDirAbs,
    fingerprint,
    fileMap,
    lastManifestInitUtc: now,
  };

  await writeJsonAtomic(manifestPath, updated);

  logStderr("[manifest:init] APPLIED");
}

/**
 * ✅ NEW (Step 33 support): manifestRefreshCore({ appPath, apply })
 * Non-printing, non-exiting, deterministic.
 * Returns: summary object.
 */
export async function manifestRefreshCore({ appPath, apply = true }) {
  const appPathAbs = path.resolve(appPath);
  const manifestPath = path.join(appPathAbs, MANIFEST_NAME);

  if (!(await pathExists(manifestPath))) {
    throw new Error(`${MANIFEST_NAME} not found at: ${manifestPath}`);
  }

  const existing = await readJson(manifestPath);

  const fileMap = await computeFileMap(appPathAbs);
  const fingerprint = computeFingerprintFromFileMap(fileMap);

  const updated = {
    ...existing,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    ignoreRules: {
      excludedDirs: Array.from(DEFAULT_EXCLUDED_DIRS || []),
      excludedFiles: Array.from(EXTRA_EXCLUDED_FILES || []),
    },
    fingerprint,
    fileMap,
    lastManifestRefreshUtc: new Date().toISOString(),
  };

  if (apply) {
    await writeJsonAtomic(manifestPath, updated);
  }

  return {
    applied: Boolean(apply),
    fingerprint,
    fileMapEntries: Object.keys(fileMap).length,
    excludedDirs: Array.from(DEFAULT_EXCLUDED_DIRS || []),
    excludedFiles: Array.from(EXTRA_EXCLUDED_FILES || []),
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestPath,
    appPath: appPathAbs,
  };
}

/**
 * manifestRefresh({ appPath, apply, templateDir })
 * CLI wrapper that prints:
 * - human header/progress to stderr only
 * - machine JSON to stdout only
 *
 * Returns summary.
 */
export async function manifestRefresh({ appPath, apply = true }) {
  const summary = await manifestRefreshCore({ appPath, apply });

  // Human-friendly header/progress to stderr only
  printHeader({ manifestPath: summary.manifestPath, appPathAbs: summary.appPath });
  logStderr(`[manifest:refresh] ${apply ? "APPLIED" : "DRY_RUN"}`);

  // Machine output MUST be stdout JSON only.
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  return summary;
}
