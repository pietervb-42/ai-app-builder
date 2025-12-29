// src/memory.js
import fs from "fs/promises";
import path from "path";

const AI_DIR = path.resolve(process.cwd(), "ai");
const TEMPLATES_DIR = path.resolve(process.cwd(), "templates");

const FILES = [
  "system-prompt.md",
  "project-memory.md",
  "decisions.md",
  "reusable-patterns.md",
];

async function loadAIMemory() {
  const parts = [];

  for (const file of FILES) {
    const filePath = path.join(AI_DIR, file);
    try {
      const content = await fs.readFile(filePath, "utf8");
      parts.push(`\n\n## ${file}\n${content}`);
    } catch {
      parts.push(`\n\n## ${file}\n[Missing file]`);
    }
  }

  return parts.join("\n");
}

async function loadTemplatesIndex() {
  try {
    const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
    const templates = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const templatePath = path.join(
        TEMPLATES_DIR,
        entry.name,
        "TEMPLATE.md"
      );

      try {
        const summary = await fs.readFile(templatePath, "utf8");
        templates.push(`- ${entry.name}: ${summary.split("\n")[0]}`);
      } catch {
        // Ignore folders without TEMPLATE.md
      }
    }

    if (templates.length === 0) {
      return "\n\n## Available Templates\n[No templates found]";
    }

    return `\n\n## Available Templates\n${templates.join("\n")}`;
  } catch {
    return "\n\n## Available Templates\n[Templates directory missing]";
  }
}

export async function loadMemoryBundle() {
  const aiMemory = await loadAIMemory();
  const templatesIndex = await loadTemplatesIndex();

  return aiMemory + templatesIndex;
}
