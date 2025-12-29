// src/templates.js
import fs from "fs/promises";
import path from "path";

const TEMPLATES_DIR = path.resolve(process.cwd(), "templates");

async function listTemplatesCore() {
  try {
    const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function writeJsonLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export async function listTemplates({ json = false, quiet = false } = {}) {
  const names = await listTemplatesCore();

  if (json) {
    // One-line JSON array (CI friendly)
    writeJsonLine(names);
    return;
  }

  if (quiet) return;

  // Human output
  for (const n of names) {
    process.stdout.write(n + "\n");
  }
}

// Backwards-compatible helpers (if other modules import them)
export async function readTemplateManifest(templateName) {
  const manifestPath = path.join(TEMPLATES_DIR, templateName, "TEMPLATE.md");
  try {
    return await fs.readFile(manifestPath, "utf8");
  } catch {
    return "";
  }
}

export async function templateExists(templateName) {
  const p = path.join(TEMPLATES_DIR, templateName);
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}
