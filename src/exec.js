// src/exec.js
import { spawn } from "child_process";

function spawnCmd(command, args, { cwd, env }) {
  const isWin = process.platform === "win32";

  const finalCmd = isWin ? "cmd.exe" : command;
  const finalArgs = isWin ? ["/d", "/s", "/c", command, ...args] : args;

  return spawn(finalCmd, finalArgs, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Run a command and capture stdout/stderr.
 * Windows-safe (cmd.exe wrapper), optional timeout.
 */
export function execCommand(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 0,
    onStdout,
    onStderr,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawnCmd(command, args, { cwd, env });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killedByTimeout = true;
            try {
              child.kill("SIGTERM");
            } catch {}
          }, timeoutMs)
        : null;

    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdout) onStdout(s);
    });

    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      const err = new Error(`Spawn error: ${e?.message || e}`);
      err.cause = e;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);

      if (killedByTimeout) {
        const err = new Error(
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`
        );
        err.code = "ETIMEDOUT";
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }

      if (code === 0) return resolve({ code, stdout, stderr });

      const err = new Error(
        `Command failed (exit ${code}): ${command} ${args.join(" ")}`
      );
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

/**
 * Start a long-running process and keep the handle.
 * Returns:
 *  - child: the spawned process
 *  - getLogs(): combined stdout+stderr so far
 *  - stop(): attempts a clean stop; escalates if needed
 */
export function spawnProcess(command, args = [], options = {}) {
  const { cwd = process.cwd(), env = process.env } = options;

  const child = spawnCmd(command, args, { cwd, env });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  async function stop({ graceMs = 1500 } = {}) {
    if (!child || child.killed) return;

    // Try graceful
    try {
      child.kill("SIGTERM");
    } catch {}

    // Wait grace period
    await new Promise((r) => setTimeout(r, graceMs));

    // If still running, force kill
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }

  return {
    child,
    getLogs: () => logs,
    stop,
  };
}
