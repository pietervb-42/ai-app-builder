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

function readSnapshotSafe(snapshotPath) {
  try {
    const snap = readSnapshotFile(snapshotPath);
    return { ok: true, snap };
  } catch (e) {
    return {
      ok: false,
      snap: null,
      error: {
        code: "ERR_CONTRACT_SNAPSHOT_MISSING",
        message: String(e?.message ?? e),
      },
    };
  }
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

  const doContracts = isTrueish(flags.contracts);
  const contractsDir = flags["contracts-dir"]
    ? String(flags["contracts-dir"])
    : "ci/contracts";

  const contractsMode = flags["contracts-mode"]
    ? String(flags["contracts-mode"]).toLowerCase().trim()
    : "check";

  const allowUpdate = hasFlag(flags, "allow-update");

  // 🔒 WARNING-ONLY GUARD (explicit intent)
  if (contractsMode === "update" && !allowUpdate && !quiet) {
    process.stderr.write(
      "[contract:run] WARNING: --contracts-mode update will overwrite contract snapshots.\n" +
        "               This is an intentional mutation of CI truth.\n" +
        "               Re-run with --allow-update to acknowledge intent.\n"
    );
  }

  const settleMs = safeNumber(flags["settle-ms"], 0);

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
    // Keep this available for future expansion
    // { cmd: "manifest:refresh:all", ... }
  ];

  for (let idx = 0; idx < runList.length; idx++) {
    const item = runList[idx];

    if (progress) out.log(`[contract:run] ${idx + 1}/${runList.length} ${item.cmd}`);

    const node = process.execPath;
    const entry = path.resolve(process.cwd(), "index.js");
    const args = [entry, item.cmd, ...item.args()];

    const res = await new Promise((resolve) => {
      const child = spawn(node, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

      child.on("close", (code) => {
        const exitCode = typeof code === "number" ? code : 1;

        let jsonOut = null;
        try {
          const t = stdout.trim();
          if (t) jsonOut = JSON.parse(t);
        } catch (_) {}

        resolve({
          exitCode,
          json: jsonOut,
          stderr: (stderr || "").trim() || null,
        });
      });
    });

    // ---- schema check ----
    const schema = res.json
      ? SCHEMA_CHECKERS[item.cmd]?.(res.json) ?? { ok: false, issues: ["no-checker"] }
      : { ok: false, issues: ["no-json"] };

    if (!schema.ok) schemaFailCount++;

    // ---- contract check/update ----
    let contract = null;
    let contractMatch = null;

    if (doContracts && res.json) {
      const snapPath = snapshotPathFor({ contractsDir, cmd: item.cmd });

      if (contractsMode === "update") {
        ensureDirForFile(snapPath);
        const normalized = normalizeForContract(item.cmd, res.json);
        writeSnapshotFile(snapPath, normalized);
        contract = {
          mode: "update",
          snapshot: path.resolve(snapPath),
          updated: true,
        };
        contractMatch = true;
      } else {
        const snapLoad = readSnapshotSafe(snapPath);

        if (!snapLoad.ok) {
          contractFailCount++;
          contract = {
            mode: "check",
            snapshot: path.resolve(snapPath),
            match: false,
            diffSummary: { kind: "missing_snapshot", message: snapLoad.error.message },
            error: snapLoad.error,
          };
          contractMatch = false;
        } else {
          const normalized = normalizeForContract(item.cmd, res.json);
          const cmp = compareNormalized(snapLoad.snap.value, normalized);

          if (!cmp.ok) contractFailCount++;

          contract = {
            mode: "check",
            snapshot: snapLoad.snap.abs,
            match: Boolean(cmp.ok),
            diffSummary: cmp.ok ? null : cmp.summary,
          };
          contractMatch = Boolean(cmp.ok);
        }
      }
    }

    /**
     * IMPORTANT:
     * In contract mode, a non-zero exit is NOT a CI failure if:
     * - schema is ok, AND
     * - contract snapshot matches (golden output agreed)
     *
     * This allows deterministic failures to be “locked” and verified.
     */
    const nonzeroExit = res.exitCode !== 0;

    const shouldCountCmdFail =
      item.hardGate &&
      nonzeroExit &&
      // If we are NOT doing contracts, exit code must gate.
      (!doContracts ||
        // If we ARE doing contracts, only gate when contracts don't match (or no contract info).
        contractMatch !== true);

    if (shouldCountCmdFail) cmdFailCount++;

    const runError =
      nonzeroExit && shouldCountCmdFail
        ? {
            code: "ERR_CMD_NONZERO",
            message: `${item.cmd} exited non-zero (${res.exitCode})`,
            cmd: item.cmd,
            stderr: res.stderr,
          }
        : null;

    results.push({
      cmd: item.cmd,
      exitCode: res.exitCode,
      runError,
      schema,
      contract,
    });

    if (settleMs > 0) await sleep(settleMs);
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
    knobs: {
      refreshManifests,
      installMode: installMode ?? null,
      noInstall: Boolean(noInstall),
      include: include ?? null,
      max: typeof max === "number" ? max : null,
      profile: profile ?? null,
      healManifest: Boolean(healManifest),
      contracts: Boolean(doContracts),
      contractsMode,
      contractsDir: path.resolve(contractsDir),
    },
    results,
  };

  if (json) out.emitJson(payload);
  else out.log(`contract:run ${ok ? "OK" : "FAIL"}`);

  // Exit codes:
  // 0: ok
  // 1: contract/schema/command gating failed
  return ok ? 0 : 1;
}
