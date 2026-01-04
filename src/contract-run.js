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
  ];

  for (const item of runList) {
    const node = process.execPath;
    const entry = path.resolve(process.cwd(), "index.js");
    const args = [entry, item.cmd, ...item.args()];

    const res = await new Promise((resolve) => {
      const child = spawn(node, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.on("close", (code) => {
        let jsonOut = null;
        try {
          jsonOut = JSON.parse(stdout.trim());
        } catch {}
        resolve({ code, json: jsonOut });
      });
    });

    const schema = res.json
      ? SCHEMA_CHECKERS[item.cmd]?.(res.json) ?? { ok: false, issues: [] }
      : { ok: false, issues: ["no-json"] };

    if (!schema.ok) schemaFailCount++;
    if (res.code !== 0 && item.hardGate) cmdFailCount++;

    let contract = null;
    if (doContracts && res.json) {
      if (contractsMode === "update") {
        contract = writeSnapshotFile(
          snapshotPathFor({ contractsDir, cmd: item.cmd }),
          normalizeForContract(item.cmd, res.json)
        );
      } else {
        const snap = readSnapshotFile(
          snapshotPathFor({ contractsDir, cmd: item.cmd })
        );
        const cmp = compareNormalized(
          snap.value,
          normalizeForContract(item.cmd, res.json)
        );
        if (!cmp.ok) contractFailCount++;
      }
    }

    results.push({
      cmd: item.cmd,
      exitCode: res.code,
      schema,
      contract,
    });
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
