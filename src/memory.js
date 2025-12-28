// src/memory.js
import fs from "fs/promises";
import path from "path";

const AI_DIR = path.resolve(process.cwd(), "ai");

const FILES = [
  "system-prompt.md",
  "project-memory.md",
  "decisions.md",
  "reusable-patterns.md",
];

export async function loadMemoryBundle() {
  const parts = [];

  for (const file of FILES) {
    const filePath = path.join(AI_DIR, file);
    try {
      const content = await fs.readFile(filePath, "utf8");
      parts.push(`\n\n## ${file}\n${content}`);
    } catch (err) {
      parts.push(`\n\n## ${file}\n[Missing file: ${file}]`);
    }
  }

  return parts.join("\n");
}
