import express from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const app = express();
const PORT = 3333;

const ROOT = process.cwd();
const OUTPUTS_DIR = path.join(ROOT, "outputs");

app.use(express.json());
app.use(express.static(path.join(ROOT, "ui/public")));

function safeJsonParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), raw: s };
  }
}

app.post("/api/build", (req, res) => {
  const { prompt, template } = req.body || {};

  if (!prompt || !template) {
    return res.status(400).json({
      ok: false,
      error: "Missing prompt or template",
    });
  }

  // Important: avoid Date.now() only if you want deterministic naming.
  // For UI builds, unique out dirs are good.
  const outDir = path.join(OUTPUTS_DIR, `ui-build-${Date.now()}`);

  // Run the CLI by calling node + index.js directly (NO shell)
  // This avoids Windows shell arg mangling (especially with multi-line prompts).
  const nodeExe = process.execPath; // the node that is running this server
  const entry = path.join(ROOT, "index.js");

  const args = [
    entry,
    "build",
    "--prompt",
    String(prompt),
    "--template",
    String(template),
    "--out",
    outDir,

    // UI-safe defaults:
    "--write-policy",
    "merge-safe",
    "--yes",

    "--json",
  ];

  const child = spawn(nodeExe, args, {
    cwd: ROOT,
    shell: false,
    windowsHide: true,
    env: { ...process.env },
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  child.on("close", (code) => {
    // Always return both stdout + stderr for debugging
    if (code !== 0) {
      return res.json({
        ok: false,
        exitCode: code,
        outDir,
        stderr: stderr || "",
        stdout: stdout || "",
      });
    }

    const parsed = safeJsonParse(stdout);

    if (!parsed.ok) {
      return res.json({
        ok: false,
        outDir,
        error: "Failed to parse CLI JSON",
        parseError: parsed.error,
        stderr: stderr || "",
        stdout: stdout || "",
      });
    }

    return res.json({
      ok: true,
      outDir,
      result: parsed.value,
      stderr: stderr || "",
    });
  });
});

app.listen(PORT, () => {
  console.log(`UI running at http://localhost:${PORT}`);
});
