// src/contract-run.js
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import { createOutput } from "./output.js";
import { SCHEMA_CHECKERS } from "./schemas.js";

import {
  normalizeForContract,
  readSnapshotFile,
  writeSnapshotFile,
  compareNormalized,
} from "./contract-utils.js";

function hasFlag(flags, name) {
  return Boolean(flags[name]);
}

function isTrueish(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "on";
}

function requireFlag(flags, name) {
  const v = flags[name];
  if (!v || v === true) throw new Error(`Missing required flag: --${name}`);
  return v;
}

function safeNumber(n, fallback) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonFile(filePath, obj) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function snapshotPathFor({ contractsDir, cmd }) {
  const dirAbs = path.isAbsolute(contractsDir)
    ? contractsDir
    : path.resolve(process.cwd(), contractsDir);

  const file = String(cmd).replace(/[:/\\]/g, "-") + ".json";
  return path.join(dirAbs, file);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeInstallModeFlag(v) {
  if (!v || v === true) return undefined;
  const s = String(v).toLowerCase().trim();
  if (s === "always" || s === "never" || s === "if-missing") return s;
  return undefined;
}

async function runCmdJson({ cmd, args }) {
  const node = process.execPath;
  const entry = path.resolve(process.cwd(), "index.js");
  const fullArgs = [entry, cmd, ...args];

  return new Promise((resolve) => {
    const child = spawn(node, fullArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : 2;
      const outTrim = stdout.trim();
      const errTrim = stderr.trim() || "";

      if (!outTrim) {
        resolve({
          ok: false,
          exitCode,
          json: null,
          error: {
            code: "ERR_CMD_NO_STDOUT",
            message: `${cmd} produced no stdout JSON`,
            cmd,
            stderr: errTrim || null,
          },
        });
        return;
      }

      try {
        const parsed = JSON.parse(outTrim);
        resolve({
          ok: exitCode === 0,
          exitCode,
          json: parsed,
          error:
            exitCode === 0
              ? null
              : {
                  code: "ERR_CMD_NONZERO",
                  message: `${cmd} exited non-zero (${exitCode})`,
                  cmd,
                  stderr: errTrim || null,
                },
        });
      } catch (e) {
        resolve({
          ok: false,
          exitCode,
          json: null,
          error: {
            code: "ERR_CMD_BAD_JSON",
            message: `${cmd} stdout was not valid JSON`,
            cmd,
            parseError: String(e?.message || e),
            stdout: outTrim.slice(0, 2000),
            stderr: errTrim || null,
          },
        });
      }
    });
  });
}

export async function contractRun({ flags }) {
  const root = String(requireFlag(flags, "root"));

  const json = hasFlag(flags, "json");
  const quiet = hasFlag(flags, "quiet") || Boolean(json);
  const progress = hasFlag(flags, "progress");

  const out = createOutput({ json: Boolean(json), quiet: Boolean(quiet) });

  const noInstall = hasFlag(flags, "no-install");
  const installMode = normalizeInstallModeFlag(flags["install-mode"]);
  const profile = flags.profile ? String(flags.profile) : undefined;

  const include = flags.include ? String(flags.include) : undefined;
  const max = flags.max != null ? safeNumber(flags.max, undefined) : undefined;

  const healManifest = hasFlag(flags, "heal-manifest");

  const refreshManifests = flags["refresh-manifests"]
    ? String(flags["refresh-manifests"]).toLowerCase().trim()
    : "never";

  const apply =
    flags.apply != null && flags.apply !== true
      ? String(flags.apply).toLowerCase().trim() === "true"
      : false;

  const doContracts = isTrueish(flags.contracts);

  const contractsDir = flags["contracts-dir"]
    ? String(flags["contracts-dir"])
    : "ci/contracts";

  const contractsMode = flags["contracts-mode"]
    ? String(flags["contracts-mode"]).toLowerCase().trim()
    : "check";

  const allowUpdate = hasFlag(flags, "allow-update");

  // Hard guard: prevent accidental update
  const effectiveMode =
    contractsMode === "update" && allowUpdate ? "update" : "check";

  if (contractsMode === "update" && effectiveMode !== "update" && !quiet) {
    process.stderr.write(
      "[contract:run] Refusing --contracts-mode update without --allow-update.\n"
    );
  }

  const startedAt = new Date().toISOString();

  const results = [];
  let schemaFailCount = 0;
  let contractFailCount = 0;
  let cmdFailCount = 0;

  const runList = [
    {
      cmd: "validate:all",
      args: () => {
        const a = ["--root", root, "--json", "--quiet"];
        if (noInstall) a.push("--no-install");
        else if (installMode) a.push("--install-mode", String(installMode));
        if (profile) a.push("--profile", String(profile));
        if (include) a.push("--include", include);
        if (typeof max === "number") a.push("--max", String(max));
        if (progress) a.push("--progress");
        return a;
      },
      hardGate: true,
    },
    {
      cmd: "report:ci",
      args: () => {
        const a = ["--root", root, "--json", "--quiet"];
        if (noInstall) a.push("--no-install");
        else if (installMode) a.push("--install-mode", String(installMode));
        if (profile) a.push("--profile", String(profile));
        if (include) a.push("--include", include);
        if (typeof max === "number") a.push("--max", String(max));
        if (progress) a.push("--progress");
        if (healManifest) a.push("--heal-manifest");
        return a;
      },
      hardGate: true,
    },
    {
      cmd: "manifest:refresh:all",
      args: () => {
        const a = ["--root", root];
        if (apply) a.push("--apply");
        if (profile) a.push("--templateDir", String(profile));
        if (include) a.push("--include", include);
        if (typeof max === "number") a.push("--max", String(max));
        if (progress) a.push("--progress");
        // This command should be schema-checked too (it can drift)
        a.push("--json", "--quiet");
        return a;
      },
      hardGate: false,
      enabled: refreshManifests === "after",
    },
  ];

  for (const item of runList) {
    if (item.enabled === false) continue;

    if (progress) out.log(`[contract:run] run ${item.cmd}`);

    const cmdRes = await runCmdJson({ cmd: item.cmd, args: item.args() });

    const schema = cmdRes.json
      ? SCHEMA_CHECKERS[item.cmd]?.(cmdRes.json) ?? { ok: false, issues: ["no-checker"] }
      : { ok: false, issues: ["no-json"] };

    if (!schema.ok) schemaFailCount++;
    if (cmdRes.exitCode !== 0 && item.hardGate) cmdFailCount++;

    let contract = null;

    if (doContracts && cmdRes.json) {
      const snapPath = snapshotPathFor({ contractsDir, cmd: item.cmd });

      if (effectiveMode === "update") {
        const normalized = normalizeForContract(item.cmd, cmdRes.json);
        writeSnapshotFile(snapPath, normalized);
        contract = {
          mode: "update",
          snapshot: path.resolve(snapPath),
          updated: true,
          match: true,
          diffSummary: null,
        };
      } else {
        try {
          const snap = readSnapshotFile(snapPath);
          const normalized = normalizeForContract(item.cmd, cmdRes.json);
          const cmp = compareNormalized(snap.value, normalized);
          if (!cmp.ok) contractFailCount++;
          contract = {
            mode: "check",
            snapshot: snap.abs,
            match: Boolean(cmp.ok),
            diffSummary: cmp.ok ? null : cmp.summary,
          };
        } catch (e) {
          contractFailCount++;
          contract = {
            mode: "check",
            snapshot: path.resolve(snapPath),
            match: false,
            diffSummary: {
              kind: "missing_snapshot",
              message: String(e?.message || e),
            },
          };
        }
      }
    }

    results.push({
      cmd: item.cmd,
      exitCode: cmdRes.exitCode,
      runError: cmdRes.error,
      schema,
      contract,
    });

    if (item.hardGate && (cmdRes.exitCode !== 0 || !schema.ok)) {
      break;
    }

    // small settle to reduce port races
    await sleep(50);
  }

  const ok = schemaFailCount === 0 && contractFailCount === 0 && cmdFailCount === 0;

  const payload = {
    ok,
    rootPath: path.resolve(root),
    startedAt,
    finishedAt: new Date().toISOString(),
    counts: {
      schemaFailCount,
      contractFailCount,
      cmdFailCount,
    },
    results,
  };

  if (json) out.emitJson(payload);
  else out.log(`contract:run ${ok ? "OK" : "FAIL"}`);

  return ok ? 0 : 1;
}
