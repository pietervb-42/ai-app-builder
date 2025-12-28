// src/generate.js
import fs from "fs/promises";
import path from "path";
import process from "process";
import { templateExists } from "./templates.js";
import { manifestInit } from "./manifest.js";

const ROOT = process.cwd();
const DEFAULT_OUTPUT_DIR = path.resolve(ROOT, "output");
const TEMPLATES_DIR = path.resolve(ROOT, "templates");

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// Decide where to generate the app
function resolveOutPath(outDirName) {
  if (!outDirName) throw new Error("outDirName is required");

  // Absolute path? Respect it as-is.
  if (path.isAbsolute(outDirName)) return outDirName;

  // Relative path like ./outputs/app or outputs/app? Resolve from repo root.
  const looksLikePath =
    outDirName.startsWith(".") ||
    outDirName.includes("/") ||
    outDirName.includes("\\");

  if (looksLikePath) return path.resolve(ROOT, outDirName);

  // Just a folder name? Keep legacy behavior: ./output/<name>
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

    // Never copy node_modules or sqlite DB files
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
 * Legacy-compatible export name used by index.js:
 * - index.js calls generateApp/generate (pickExport)
 * We expose generateApp that accepts { template, outPath }
 */
export async function generateApp({ template, outPath }) {
  if (!template) throw new Error("template is required");
  if (!outPath) throw new Error("outPath is required");

  const ok = await templateExists(template);
  if (!ok) throw new Error(`Template not found: ${template}`);

  const src = path.join(TEMPLATES_DIR, template);
  const dest = resolveOutPath(outPath);

  if (await pathExists(dest)) {
    throw new Error(`Output folder already exists: ${dest}`);
  }

  // Create the parent folder (works for all path types)
  await fs.mkdir(path.dirname(dest), { recursive: true });

  // Copy template to destination
  await copyDir(src, dest);

  // Write builder.manifest.json into the generated app folder (deterministic baseline)
  // Equivalent to running:
  // node index.js manifest:init --app <dest> --yes --templateDir <src>
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
