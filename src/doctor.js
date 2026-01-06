// src/doctor.js
import fs from "fs";
import path from "path";
import process from "process";
import { spawnSync } from "child_process";

function hasFlag(flags, name) {
  return Boolean(flags && Object.prototype.hasOwnProperty.call(flags, name) && flags[name]);
}

function isTrueish(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "on";
}

function safeTrim(s) {
  return String(s ?? "").replace(/\r?\n/g, "\n").trim();
}

function isCmdShim(exe) {
  const s = String(exe || "").toLowerCase();
  return s.endsWith(".cmd") || s.endsWith(".bat");
}

function quoteCmdArg(a) {
  const s = String(a ?? "");
  // Simple quoting for our usage (doctor runs simple args like --version).
  // If it contains spaces or quotes, wrap in quotes and escape internal quotes.
  if (!/[ \t"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function runCmd(exe, args, { cwd } = {}) {
  const isWin = process.platform === "win32";
  const useCmdWrapper = isWin && isCmdShim(exe);

  let r;

  if (useCmdWrapper) {
    const comspec = process.env.ComSpec || "cmd.exe";
    const cmdLine = [quoteCmdArg(exe), ...(args || []).map(quoteCmdArg)].join(" ");
    r = spawnSync(comspec, ["/d", "/s", "/c", cmdLine], {
      cwd,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
  } else {
    r = spawnSync(exe, args, {
      cwd,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
  }

  const stdout = safeTrim(r.stdout);
  const stderr = safeTrim(r.stderr);

  return {
    ok: r.status === 0,
    status: typeof r.status === "number" ? r.status : null,
    signal: r.signal ? String(r.signal) : null,
    error: r.error ? (r.error.message || String(r.error)) : null,
    stdout,
    stderr,
  };
}

function parseSemverLoose(s) {
  const m = String(s || "").trim().match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Try hard to locate npm on Windows:
 * 1) npm
 * 2) npm.cmd (common on Windows)
 * 3) bundled npm-cli.js under the node install dir
 */
function runNpmVersion({ cwd }) {
  // 1) plain "npm"
  let r = runCmd("npm", ["--version"], { cwd });
  if (r.ok || r.error !== "spawnSync npm ENOENT") {
    return { ...r, method: "npm", npmCliPath: null };
  }

  // 2) Windows: try npm.cmd (run via cmd wrapper inside runCmd)
  if (process.platform === "win32") {
    const r2 = runCmd("npm.cmd", ["--version"], { cwd });
    if (r2.ok || r2.error !== "spawnSync npm.cmd ENOENT") {
      return { ...r2, method: "npm.cmd", npmCliPath: null };
    }
  }

  // 3) Bundled npm-cli.js (works if npm is installed alongside node)
  // Typical: <nodeDir>/node_modules/npm/bin/npm-cli.js
  const nodeDir = path.dirname(process.execPath);
  const npmCli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (existsFile(npmCli)) {
    const r3 = runCmd(process.execPath, [npmCli, "--version"], { cwd });
    return { ...r3, method: "bundled:npm-cli.js", npmCliPath: npmCli };
  }

  // Not found anywhere
  return {
    ok: false,
    status: null,
    signal: null,
    error: r.error || "npm not found",
    stdout: "",
    stderr: "",
    method: "not-found",
    npmCliPath: null,
  };
}

export async function doctorCommand({ flags }) {
  const jsonMode = hasFlag(flags, "json") || isTrueish(flags?.["json"]);
  const quiet = hasFlag(flags, "quiet") || isTrueish(flags?.quiet);

  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");
  const nodeModulesPath = path.join(cwd, "node_modules");

  const checks = [];

  // Check: node version
  {
    const raw = process.version;
    const parsed = parseSemverLoose(raw);
    const ok = Boolean(parsed && Number.isFinite(parsed.major));
    checks.push({
      id: "node.version",
      required: true,
      ok,
      details: {
        raw: raw ? String(raw) : "",
        major: parsed ? parsed.major : null,
        minor: parsed ? parsed.minor : null,
        patch: parsed ? parsed.patch : null,
      },
    });
  }

  // Check: npm version (robust)
  {
    const r = runNpmVersion({ cwd });
    const parsed = parseSemverLoose(r.stdout);
    const ok = Boolean(r.ok && parsed && Number.isFinite(parsed.major));

    const guidance =
      ok
        ? null
        : process.platform === "win32"
          ? "npm was not found or could not be executed. Fix by installing Node LTS with npm included, or ensure npm.cmd is on PATH."
          : "npm was not found. Fix by installing npm or ensuring it is on PATH.";

    checks.push({
      id: "npm.version",
      required: true,
      ok,
      details: {
        method: r.method,
        npmCliPath: r.npmCliPath ?? null,
        ok: r.ok,
        status: r.status,
        stdout: r.stdout,
        stderr: quiet ? "" : r.stderr,
        major: parsed ? parsed.major : null,
        minor: parsed ? parsed.minor : null,
        patch: parsed ? parsed.patch : null,
        error: r.error,
        guidance,
      },
    });
  }

  // Check: repo has package.json
  {
    const ok = existsFile(pkgPath);
    checks.push({
      id: "repo.packageJson",
      required: true,
      ok,
      details: {
        path: "package.json",
        exists: ok,
      },
    });
  }

  // Check: node_modules (optional)
  {
    const ok = existsDir(nodeModulesPath);
    checks.push({
      id: "repo.nodeModules",
      required: false,
      ok,
      details: {
        path: "node_modules",
        exists: ok,
      },
    });
  }

  // Check: git presence (optional)
  {
    const r = runCmd("git", ["--version"], { cwd });
    checks.push({
      id: "git.present",
      required: false,
      ok: r.ok,
      details: {
        ok: r.ok,
        status: r.status,
        stdout: r.stdout,
        stderr: quiet ? "" : r.stderr,
        error: r.error,
      },
    });
  }

  // Check: templates inventory runnable (required)
  {
    const nodeExe = process.execPath;
    const r = runCmd(nodeExe, ["index.js", "templates:inventory", "--json"], { cwd });
    let parsed = null;
    try {
      parsed = r.stdout ? JSON.parse(r.stdout) : null;
    } catch {
      parsed = null;
    }
    const ok = Boolean(r.ok && parsed && parsed.ok === true && parsed.cmd === "templates:inventory");

    checks.push({
      id: "builder.templatesInventory",
      required: true,
      ok,
      details: {
        ok: r.ok,
        status: r.status,
        stdoutIsJson: parsed !== null,
        inventoryOk: parsed ? Boolean(parsed.ok) : false,
        error: r.error,
        stderr: quiet ? "" : r.stderr,
      },
    });
  }

  const requiredFails = checks.filter((c) => c.required && !c.ok).length;
  const optionalFails = checks.filter((c) => !c.required && !c.ok).length;

  const payload = {
    ok: requiredFails === 0,
    cmd: "doctor",
    requiredFailCount: requiredFails,
    optionalFailCount: optionalFails,
    checks,
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    const lines = [];
    lines.push("ai-app-builder doctor");
    lines.push("");
    for (const c of checks) {
      const mark = c.ok ? "OK " : "FAIL";
      const req = c.required ? "required" : "optional";
      lines.push(`${mark}  [${req}] ${c.id}`);
    }
    lines.push("");
    lines.push(`Required failures: ${requiredFails}`);
    lines.push(`Optional failures: ${optionalFails}`);
    process.stdout.write(lines.join("\n") + "\n");
  }

  return payload.ok ? 0 : 1;
}
