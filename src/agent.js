// src/agent.js
import OpenAI from "openai";
import { loadMemoryBundle } from "./memory.js";

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export async function runPlanAgent({ prompt }) {
  const client = getClient();
  const memory = await loadMemoryBundle();

  const messages = [
    {
      role: "system",
      content:
        "You are an AI App Builder agent. Output ONLY a step-by-step PLAN. Do NOT write code. Do NOT output file contents.",
    },
    { role: "system", content: `PROJECT MEMORY (authoritative):\n${memory}` },
    {
      role: "user",
      content: `User request:\n${prompt}\n\nReturn a step-by-step PLAN ONLY. Include: files to create/modify and the exact sequence of actions.`,
    },
  ];

  const resp = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages,
    temperature: 0.2,
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

/**
 * This produces file contents ONLY AFTER approval.
 * Output MUST be JSON with schema:
 * { "files": [ { "path": "relative/path", "content": "..." } ] }
 */
export async function runWriteAgent({ prompt, plan }) {
  const client = getClient();
  const memory = await loadMemoryBundle();

  const messages = [
    {
      role: "system",
      content:
        "You are an AI App Builder agent. You must output ONLY valid JSON. No markdown. No commentary. No extra keys.",
    },
    { role: "system", content: `PROJECT MEMORY (authoritative):\n${memory}` },
    {
      role: "user",
      content:
        `User request:\n${prompt}\n\n` +
        `Approved plan:\n${plan}\n\n` +
        `Now generate the exact files to write as JSON ONLY with this schema:\n` +
        `{ "files": [ { "path": "relative/path/from/project-root", "content": "file contents" } ] }\n\n` +
        `Rules:\n` +
        `- Only include files mentioned by the plan\n` +
        `- Use LF newlines\n` +
        `- Do not include binary files\n` +
        `- Do not write outside project root\n`,
    },
  ];

  const resp = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages,
    temperature: 0.2,
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}
