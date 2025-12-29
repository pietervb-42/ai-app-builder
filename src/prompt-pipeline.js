// src/prompt-pipeline.js
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();

async function readIfExists(relPath) {
  const full = path.join(ROOT, relPath);
  try {
    return await fs.readFile(full, "utf8");
  } catch {
    return "";
  }
}

async function listTemplateFolders() {
  const templatesDir = path.join(ROOT, "templates");
  try {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readTemplatesJsonIds() {
  const p = path.join(ROOT, "templates", "templates.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const data = JSON.parse(raw);
    const ids = Array.isArray(data?.templates) ? data.templates.map((t) => t.id).filter(Boolean) : [];
    return ids.sort();
  } catch {
    return [];
  }
}

export async function buildSystemContext() {
  const systemPrompt = await readIfExists("ai/system-prompt.md");
  const rules = await readIfExists("ai/rules.md");
  const projectMemory = await readIfExists("ai/project-memory.md");
  const decisions = await readIfExists("ai/decisions.md");
  const patterns = await readIfExists("ai/reusable-patterns.md");

  const templateFolders = await listTemplateFolders();
  const templateIds = await readTemplatesJsonIds();

  if (!systemPrompt.trim()) throw new Error("Missing ai/system-prompt.md (required).");
  if (!rules.trim()) throw new Error("Missing ai/rules.md (required).");

  const parts = [
    "=== SYSTEM PROMPT ===\n" + systemPrompt.trim(),
    "\n=== RULES (HARD CONSTRAINTS) ===\n" + rules.trim(),
    "\n=== REPO TEMPLATE SNAPSHOT (AUTHORITATIVE) ===\n" +
      `Template folders in /templates:\n- ${templateFolders.join("\n- ") || "(none found)"}` +
      `\n\nTemplate IDs in templates/templates.json:\n- ${templateIds.join("\n- ") || "(none found)"}`,
  ];

  if (projectMemory.trim()) parts.push("\n=== PROJECT MEMORY ===\n" + projectMemory.trim());
  if (decisions.trim()) parts.push("\n=== DECISIONS LOG ===\n" + decisions.trim());
  if (patterns.trim()) parts.push("\n=== REUSABLE PATTERNS ===\n" + patterns.trim());

  return parts.join("\n");
}

export async function buildMessagesForPlan({ prompt }) {
  const systemContext = await buildSystemContext();

  return [
    { role: "system", content: systemContext },
    {
      role: "system",
      content:
        "PLAN MODE: Use the REPO TEMPLATE SNAPSHOT above. Pick exactly one template. Output steps only. Do NOT output code. Do NOT ask the user to list templates.",
    },
    { role: "user", content: prompt },
  ];
}

export async function buildMessagesForWrite({ prompt, plan }) {
  const systemContext = await buildSystemContext();

  return [
    { role: "system", content: systemContext },
    {
      role: "system",
      content:
        "WRITE MODE: Use the chosen template from the approved plan. Output JSON ONLY in the required write-spec format. No markdown. No commentary.",
    },
    {
      role: "user",
      content:
        `USER REQUEST:\n${prompt}\n\n` +
        `APPROVED PLAN:\n${plan}\n\n` +
        `Return the write-spec JSON that creates/modifies files as required.`,
    },
  ];
}
