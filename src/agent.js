// src/agent.js
import OpenAI from "openai";
import { buildMessagesForPlan, buildMessagesForWrite } from "./prompt-pipeline.js";

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in environment.");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getModel() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

async function chat({ messages }) {
  const client = getClient();
  const model = getModel();

  const res = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.2,
  });

  const text = res?.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("Model returned empty response.");
  return text;
}

export async function runPlanAgent({ prompt }) {
  if (!prompt || typeof prompt !== "string") {
    throw new Error("runPlanAgent requires prompt (string).");
  }
  const messages = await buildMessagesForPlan({ prompt });
  return await chat({ messages });
}

export async function runWriteAgent({ prompt, plan }) {
  if (!prompt || typeof prompt !== "string") {
    throw new Error("runWriteAgent requires prompt (string).");
  }
  if (!plan || typeof plan !== "string") {
    throw new Error("runWriteAgent requires plan (string).");
  }
  const messages = await buildMessagesForWrite({ prompt, plan });
  return await chat({ messages });
}
