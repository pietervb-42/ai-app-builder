// src/writer.js
import fs from "fs/promises";
import path from "path";

const OUTPUT_DIR = path.resolve(process.cwd(), "output");

export async function savePlan(planText) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, "plan.md");
  await fs.writeFile(filePath, planText, "utf8");
  return filePath;
}

function ensureSafeRelativePath(relPath) {
  if (!relPath || typeof relPath !== "string") {
    throw new Error("Invalid file path in model output.");
  }

  // Normalize Windows backslashes to forward slashes for consistency
  const cleaned = relPath.replace(/\\/g, "/");

  // Disallow absolute paths and traversal
  if (cleaned.startsWith("/") || cleaned.match(/^[A-Za-z]:\//)) {
    throw new Error(`Unsafe path (absolute): ${relPath}`);
  }
  if (cleaned.includes("..")) {
    throw new Error(`Unsafe path (traversal): ${relPath}`);
  }

  return cleaned;
}

async function writeFileAtomic(absPath, content) {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = absPath + ".tmp";
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, absPath);
}

export async function applyWriteSpec(writeSpecJson, { overwrite = false } = {}) {
  let spec;
  try {
    spec = JSON.parse(writeSpecJson);
  } catch {
    throw new Error("Model output was not valid JSON.");
  }

  if (!spec || !Array.isArray(spec.files)) {
    throw new Error('JSON must have {"files":[...]}');
  }

  const written = [];

  for (const f of spec.files) {
    const safeRel = ensureSafeRelativePath(f.path);
    const absPath = path.resolve(process.cwd(), safeRel);

    // extra safety: ensure still under project root
    const root = path.resolve(process.cwd());
    if (!absPath.startsWith(root)) {
      throw new Error(`Unsafe resolved path: ${f.path}`);
    }

    const content = typeof f.content === "string" ? f.content.replace(/\r\n/g, "\n") : "";
    if (content === "" && typeof f.content !== "string") {
      throw new Error(`Missing content for file: ${f.path}`);
    }

    // prevent accidental overwrite unless explicitly allowed
    if (!overwrite) {
      try {
        await fs.access(absPath);
        throw new Error(`Refusing to overwrite existing file: ${safeRel} (use --force)`);
      } catch (err) {
        // ok if it doesn't exist
        if (err && err.code !== "ENOENT") throw err;
      }
    }

    await writeFileAtomic(absPath, content);
    written.push(safeRel);
  }

  return written;
}
