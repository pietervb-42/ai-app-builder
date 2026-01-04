// lib/validate/util/install.js
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

/**
 * Decide whether npm install should run
 */
export function shouldInstall({ appPath, installMode }) {
  if (installMode === "never") return false;
  if (installMode === "always") return true;

  // if-missing (default)
  const nm = path.join(appPath, "node_modules");
  return !fs.existsSync(nm);
}

function quoteCmdArgForCmdExe(s) {
  // For cmd.exe /c "<command string>", we need robust quoting for paths with spaces.
  // We keep this very small + deterministic: wrap in double-quotes and escape internal quotes.
  const str = String(s);
  return `"${str.replace(/"/g, '\\"')}"`;
}

/**
 * Run npm install in a Windows-safe + deterministic way
 *
 * Goals:
 * - Eliminate DEP0190 warnings (avoid shell:true patterns)
 * - Remove PATH reliance on Windows
 * - Keep behavior/semantics identical (still "npm install" in appPath)
 * - Deterministic stdout/stderr capture and error surface
 */
export function runInstall({ appPath }) {
  const isWindows = process.platform === "win32";
  const started = Date.now();

  let cmd = "npm";
  let args = ["install"];

  if (isWindows) {
    // Avoid PATH dependence and Windows npm.cmd spawning issues by invoking npm's JS CLI via Node directly.
    // Typical Node for Windows layout:
    //   <prefix>\node.exe
    //   <prefix>\node_modules\npm\bin\npm-cli.js
    //   <prefix>\npm.cmd (shim)
    const nodeExe = process.execPath;
    const nodeDir = path.dirname(nodeExe);

    const npmCli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    const npmCmd = path.join(nodeDir, "npm.cmd");

    if (fs.existsSync(npmCli)) {
      cmd = nodeExe;
      args = [npmCli, "install"];
    } else if (fs.existsSync(npmCmd)) {
      // Fallback: run the local shim explicitly via cmd.exe without relying on PATH.
      // Note: we still keep shell:false (we are spawning cmd.exe directly).
      cmd = "cmd.exe";
      const commandString = `${quoteCmdArgForCmdExe(npmCmd)} install`;
      args = ["/d", "/s", "/c", commandString];
    } else {
      // Last resort fallback: preserve prior semantics (may rely on PATH if npm isn't in the Node dir).
      cmd = "cmd.exe";
      args = ["/d", "/s", "/c", "npm install"];
    }
  }

  const result = spawnSync(cmd, args, {
    cwd: appPath,
    stdio: "pipe",
    encoding: "utf8",
    shell: false, // IMPORTANT: never true (avoids DEP0190 patterns)
  });

  if (result.error) {
    const err = new Error(`npm install failed: ${result.error.message}`);
    err.cause = result.error;
    throw err;
  }

  if (result.status !== 0) {
    const err = new Error("npm install failed");
    err.exitCode = result.status;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }

  return {
    id: "install",
    required: true,
    ok: true,
    class: null,
    details: {
      reason: "installed",
      cwd: appPath,
      cmd,
      args,
      exitCode: result.status,
      ms: Date.now() - started,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    },
  };
}
