// src/regen.js
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import process from "process";
import { validateAppCore } from "./validate.js";
import {
  MANIFEST_NAME,
  SNAP_DIR_NAME,
  DEFAULT_EXCLUDED_DIRS,
  shouldSkipDir,
  shouldSkipFile,
} from "./ignore.js";

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

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fileSha256(p) {
  const buf = await fs.readFile(p);
  return sha256(buf);
}

function writeJsonLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function eprintLine(s) {
  process.stderr.write(String(s) + "\n");
}

function logHuman(json, quiet, msg) {
  // Step 30: If json=true, human logs MUST go to stderr.
  // If quiet=true, suppress human logs entirely.
  if (quiet) return;
  if (json) eprintLine(msg);
  else process.stdout.write(String(msg) + "\n");
}

// ------------------------------
// Snapshot + Rollback
// ------------------------------
const SNAP_KEEP_LAST_N = 3;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function timestampFolderLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

async function rmForce(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDirFiltered(srcDir, dstDir, excludeDirNamesSet) {
  await ensureDir(dstDir);
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const e of entries) {
    if (e.isDirectory() && excludeDirNamesSet.has(e.name)) continue;
    if (e.isFile() && shouldSkipFile(e.name)) continue;

    const srcAbs = path.join(srcDir, e.name);
    const dstAbs = path.join(dstDir, e.name);

    if (e.isDirectory()) {
      await copyDirFiltered(srcAbs, dstAbs, excludeDirNamesSet);
      continue;
    }

    if (e.isFile()) {
      await ensureDir(path.dirname(dstAbs));
      await fs.copyFile(srcAbs, dstAbs);
      continue;
    }
  }
}

async function snapshotCreate(appRootAbs) {
  const snapRoot = path.join(appRootAbs, SNAP_DIR_NAME);
  await ensureDir(snapRoot);

  const stamp = timestampFolderLocal();
  const snapDir = path.join(snapRoot, stamp);

  await copyDirFiltered(appRootAbs, snapDir, DEFAULT_EXCLUDED_DIRS);

  return { snapDir, stamp };
}

async function snapshotRestore(appRootAbs, snapDirAbs) {
  const entries = await fs.readdir(appRootAbs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const e of entries) {
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue;
      const abs = path.join(appRootAbs, e.name);
      await rmForce(abs);
      continue;
    }

    if (e.isFile()) {
      if (shouldSkipFile(e.name)) continue;
      const abs = path.join(appRootAbs, e.name);
      await rmForce(abs);
      continue;
    }
  }

  await copyDirFiltered(snapDirAbs, appRootAbs, DEFAULT_EXCLUDED_DIRS);
}

async function snapshotPrune(appRootAbs, keepN = SNAP_KEEP_LAST_N) {
  const snapRoot = path.join(appRootAbs, SNAP_DIR_NAME);
  if (!(await pathExists(snapRoot))) return;

  const entries = await fs.readdir(snapRoot, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  dirs.sort((a, b) => b.localeCompare(a)); // newest first
  const toDelete = dirs.slice(keepN);

  for (const name of toDelete) {
    const abs = path.join(snapRoot, name);
    await rmForce(abs);
  }
}

// ------------------------------
// Existing drift/baseline logic
// ------------------------------

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
        if (shouldSkipFile(e.name)) continue;
        out.push(abs);
      }
    }
  }

  await walk(rootDir);
  return out;
}

async function computeFileMap(appPath) {
  const files = await listFilesRecursive(appPath);
  const map = {};
  for (const abs of files) {
    const rel = norm(path.relative(appPath, abs));
    map[rel] = await fileSha256(abs);
  }
  return map;
}

async function computeFingerprint(appPath) {
  const fileMap = await computeFileMap(appPath);
  const keys = Object.keys(fileMap).sort();
  const joined = keys.map((k) => `${k}=${fileMap[k]}`).join("\n");
  return sha256(Buffer.from(joined, "utf8"));
}

async function readManifest(appPath) {
  const manifestPath = path.join(appPath, MANIFEST_NAME);
  if (!(await pathExists(manifestPath))) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const manifest = await readJson(manifestPath);
  return { manifestPath, manifest };
}

function isSubpath(child, parent) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function getTemplateDirFromManifest(manifest) {
  if (manifest.templateDir) return manifest.templateDir;

  if (!manifest.template) {
    throw new Error(
      `Manifest missing template and templateDir. Cannot regenerate.`
    );
  }

  const repoRoot = process.cwd();
  const templatesRoot = path.resolve(repoRoot, "templates");
  const derived = path.resolve(templatesRoot, manifest.template);

  if (!isSubpath(derived, templatesRoot) && derived !== templatesRoot) {
    throw new Error(
      `Derived templateDir outside templates root. Refusing. Derived=${derived}`
    );
  }

  return derived;
}

async function listTemplateFiles(templateDir) {
  const out = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const e of entries) {
      const abs = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        await walk(abs);
        continue;
      }

      if (e.isFile()) {
        if (e.name === MANIFEST_NAME) continue;
        const rel = norm(path.relative(templateDir, abs));
        out.push(rel);
      }
    }
  }

  await walk(templateDir);
  return out.sort();
}

async function copyFileEnsuringDir(srcAbs, dstAbs) {
  await ensureDir(path.dirname(dstAbs));
  await fs.copyFile(srcAbs, dstAbs);
}

function headerLines({ manifestPath, appPath, manifest, templateDir }) {
  return [
    "",
    `[manifest] ${manifestPath}`,
    `[app] ${appPath}`,
    `[template] ${manifest.template || "(unknown)"}`,
    `[templateDir] ${templateDir}`,
    "",
  ];
}

async function regenPlan({ appPathAbs }) {
  const { manifestPath, manifest } = await readManifest(appPathAbs);
  const templateDir = getTemplateDirFromManifest(manifest);

  if (!(await pathExists(templateDir))) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }

  const baselineMap = manifest.fileMap || null;
  if (!baselineMap) {
    throw new Error(
      `Manifest missing fileMap baseline. This app must have been generated with Step 15+ (fileMap stored at generate-time).`
    );
  }

  const currentMap = await computeFileMap(appPathAbs);

  const templateFiles = await listTemplateFiles(templateDir);
  const templateMap = {};
  for (const rel of templateFiles) {
    const abs = path.join(templateDir, rel);
    templateMap[rel] = await fileSha256(abs);
  }

  const missingTemplateFiles = [];
  const extraFilesAdded = [];
  const modifiedFiles = [];
  const unmodifiedFiles = [];

  for (const rel of Object.keys(templateMap)) {
    if (!currentMap[rel]) missingTemplateFiles.push(rel);
  }

  for (const rel of Object.keys(currentMap)) {
    if (!templateMap[rel]) extraFilesAdded.push(rel);
  }

  for (const rel of Object.keys(templateMap)) {
    const base = baselineMap[rel];
    const cur = currentMap[rel];
    if (!base || !cur) continue;
    if (base !== cur) modifiedFiles.push(rel);
    else unmodifiedFiles.push(rel);
  }

  return {
    manifestPath,
    appPathAbs,
    manifest,
    templateDir,
    templateFilesCount: templateFiles.length,
    appFilesCount: Object.keys(currentMap).length,
    missingTemplateFiles: missingTemplateFiles.sort(),
    extraFilesAdded: extraFilesAdded.sort(),
    modifiedFiles: modifiedFiles.sort(),
    unmodifiedFiles: unmodifiedFiles.sort(),
    wouldOverwriteModified: modifiedFiles.sort(),
  };
}

export async function regenPreview({ appPath, json = false, quiet = false }) {
  const appPathAbs = path.resolve(appPath);
  const plan = await regenPlan({ appPathAbs });

  const summary = {
    ok: true,
    appPath: plan.appPathAbs,
    manifestPath: plan.manifestPath,
    template: plan.manifest.template || "(unknown)",
    templateDir: plan.templateDir,
    templateFiles: plan.templateFilesCount,
    appFiles: plan.appFilesCount,
    wouldOverwrite_modified: plan.wouldOverwriteModified,
    extraFiles_added: plan.extraFilesAdded,
    missingFiles_removed: plan.missingTemplateFiles,
  };

  if (json) {
    // Step 30: stdout must be exactly one JSON object
    writeJsonLine(summary);
    process.exit(0);
  }

  if (quiet) return;

  for (const line of headerLines({
    manifestPath: plan.manifestPath,
    appPath: plan.appPathAbs,
    manifest: plan.manifest,
    templateDir: plan.templateDir,
  })) {
    process.stdout.write(line + "\n");
  }

  process.stdout.write("[regen:preview] Summary\n");
  process.stdout.write(
    JSON.stringify(
      {
        templateFiles: plan.templateFilesCount,
        appFiles: plan.appFilesCount,
        wouldOverwrite_modified: plan.wouldOverwriteModified.length,
        extraFiles_added: plan.extraFilesAdded.length,
        missingFiles_removed: plan.missingTemplateFiles.length,
      },
      null,
      2
    ) + "\n"
  );

  process.stdout.write("\n");
  process.stdout.write(
    `[would overwrite: modified files] (${plan.wouldOverwriteModified.length})\n`
  );
  for (const f of plan.wouldOverwriteModified) process.stdout.write(`- ${f}\n`);

  process.stdout.write("\n");
  process.stdout.write(
    `[extra files added by user] (${plan.extraFilesAdded.length})\n`
  );
  for (const f of plan.extraFilesAdded) process.stdout.write(`- ${f}\n`);

  process.stdout.write("\n");
  process.stdout.write(
    `[missing template files to restore] (${plan.missingTemplateFiles.length})\n`
  );
  for (const f of plan.missingTemplateFiles) process.stdout.write(`- ${f}\n`);

  process.stdout.write("\n");
  process.stdout.write(
    "[regen:preview] This is READ-ONLY. regen:apply requires explicit confirmations.\n"
  );
}

export async function regenApply({
  appPath,
  yes,
  overwriteModified,
  json = false,
  quiet = false,
}) {
  const appPathAbs = path.resolve(appPath);

  if (!yes) {
    const msg = "Refusing to run because --yes was not provided.";
    if (json) {
      writeJsonLine({
        ok: false,
        stage: "input",
        error: { code: "ERR_MISSING_YES", message: msg },
      });
      process.exit(1);
    }
    if (!quiet) {
      // human output must not pollute json mode; here json=false
      process.stdout.write("[regen:apply] " + msg + "\n");
      process.stdout.write("Example:\n");
      process.stdout.write(`  node index.js regen:apply --app ${appPath} --yes\n`);
    }
    return;
  }

  const plan = await regenPlan({ appPathAbs });

  if (plan.wouldOverwriteModified.length && !overwriteModified) {
    const msg = `Modified files detected (${plan.wouldOverwriteModified.length}). Refusing to overwrite without --overwriteModified.`;
    if (json) {
      writeJsonLine({
        ok: false,
        stage: "safety",
        error: {
          code: "ERR_MODIFIED_FILES",
          message: msg,
          modifiedCount: plan.wouldOverwriteModified.length,
        },
        modified: plan.wouldOverwriteModified,
      });
      process.exit(1);
    }

    if (!quiet) {
      for (const line of headerLines({
        manifestPath: plan.manifestPath,
        appPath: plan.appPathAbs,
        manifest: plan.manifest,
        templateDir: plan.templateDir,
      })) {
        process.stdout.write(line + "\n");
      }

      process.stdout.write("[regen:apply] REFUSED\n");
      process.stdout.write(msg + "\n");
      process.stdout.write("\n");
      process.stdout.write("Run preview to review impact:\n");
      process.stdout.write(`  node index.js regen:preview --app ${appPath}\n`);
      process.stdout.write("\n");
      process.stdout.write("If you accept overwriting modified files, rerun with:\n");
      process.stdout.write(
        `  node index.js regen:apply --app ${appPath} --yes --overwriteModified\n`
      );
    }
    return;
  }

  const toRestore = plan.missingTemplateFiles;
  const toOverwrite = [
    ...plan.unmodifiedFiles,
    ...(overwriteModified ? plan.modifiedFiles : []),
  ]
    .filter((rel) => rel !== MANIFEST_NAME)
    .sort();

  // Step 20: Snapshot BEFORE any file modifications
  const { snapDir, stamp } = await snapshotCreate(plan.appPathAbs);

  try {
    // Logging (stderr in json mode)
    logHuman(
      json,
      quiet,
      `[regen:apply] snapshot created: ${norm(
        path.relative(plan.appPathAbs, snapDir)
      )}`
    );

    for (const rel of toRestore) {
      if (rel === MANIFEST_NAME) continue;
      const srcAbs = path.join(plan.templateDir, rel);
      const dstAbs = path.join(plan.appPathAbs, rel);
      await copyFileEnsuringDir(srcAbs, dstAbs);
    }

    for (const rel of toOverwrite) {
      if (rel === MANIFEST_NAME) continue;
      const srcAbs = path.join(plan.templateDir, rel);
      const dstAbs = path.join(plan.appPathAbs, rel);
      await copyFileEnsuringDir(srcAbs, dstAbs);
    }

    // Validation gate (SAFE: uses validateAppCore, not validateApp)
    const { result: validationResult, exitCode } = await validateAppCore({
      appPath: plan.appPathAbs,
      quiet: true, // never print during apply
      json: true, // force validateAppCore child output away from stdout if any
      noInstall: false,
      installMode: "if-missing",
      profile: undefined,
    });

    if (exitCode !== 0 || validationResult?.ok !== true) {
      await snapshotRestore(plan.appPathAbs, snapDir);

      const outObj = {
        ok: false,
        stage: "validate",
        appPath: plan.appPathAbs,
        snapshot: { stamp, snapDir: norm(path.relative(plan.appPathAbs, snapDir)) },
        message: "regen:apply failed validation; rolled back to snapshot",
        validation: validationResult || null,
      };

      if (json) {
        writeJsonLine(outObj);
        process.exit(1);
      }

      if (!quiet) {
        process.stdout.write("\n[regen:apply] VALIDATION FAILED — rollback completed.\n");
        process.stdout.write(JSON.stringify(outObj, null, 2) + "\n");
      }
      return;
    }

    // Only after validation succeeds, refresh baseline in manifest
    const newFileMap = await computeFileMap(plan.appPathAbs);
    const newFingerprint = await computeFingerprint(plan.appPathAbs);

    const existingManifest = await readJson(plan.manifestPath);
    const updated = {
      ...existingManifest,
      templateDir: plan.templateDir,
      fingerprint: newFingerprint,
      fileMap: newFileMap,
      lastRegenApplyUtc: new Date().toISOString(),
      lastRegenValidatedUtc: new Date().toISOString(),
    };

    await writeJsonAtomic(plan.manifestPath, updated);

    await snapshotPrune(plan.appPathAbs, SNAP_KEEP_LAST_N);

    const doneObj = {
      ok: true,
      appPath: plan.appPathAbs,
      manifestPath: plan.manifestPath,
      snapshot: { stamp, snapDir: norm(path.relative(plan.appPathAbs, snapDir)) },
      restoredMissing: toRestore.length,
      overwroteFiles: toOverwrite.length,
      preservedExtra: plan.extraFilesAdded.length,
      overwriteModified: Boolean(overwriteModified),
      manifestUpdated: true,
      newFingerprint,
      snapshotsKept: SNAP_KEEP_LAST_N,
      validation: validationResult,
    };

    if (json) {
      writeJsonLine(doneObj);
      process.exit(0);
    }

    if (!quiet) {
      for (const line of headerLines({
        manifestPath: plan.manifestPath,
        appPath: plan.appPathAbs,
        manifest: plan.manifest,
        templateDir: plan.templateDir,
      })) {
        process.stdout.write(line + "\n");
      }

      process.stdout.write("\n[regen:apply] DONE (validated + baseline updated)\n");
      process.stdout.write(JSON.stringify(doneObj, null, 2) + "\n");
    }
  } catch (err) {
    // Safety rollback
    try {
      await snapshotRestore(plan.appPathAbs, snapDir);
    } catch {
      // keep going; we still report below
    }

    const outObj = {
      ok: false,
      stage: "error",
      appPath: plan.appPathAbs,
      snapshot: { stamp, snapDir: norm(path.relative(plan.appPathAbs, snapDir)) },
      error: String(err?.message ?? err),
      message: "regen:apply encountered an error; rollback attempted",
    };

    if (json) {
      writeJsonLine(outObj);
      process.exit(1);
    }

    if (!quiet) {
      process.stdout.write("\n[regen:apply] ERROR\n");
      process.stdout.write(JSON.stringify(outObj, null, 2) + "\n");
    }

    throw err;
  }
}
