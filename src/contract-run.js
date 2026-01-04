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

import { computeAppFingerprint, computeAppFileMap } from "./manifest.js";

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

function snapshotPathFor({ contractsDir, key }) {
  const dirAbs = path.isAbsolute(contractsDir)
    ? contractsDir
    : path.resolve(process.cwd(), contractsDir);

  const file = String(key).replace(/[:/\\]/g, "-") + ".json";
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

function writeTextFileAbs(absPath, content) {
  ensureDirForFile(absPath);
  // Force LF for deterministic hashing across platforms.
  const lf = String(content ?? "").replace(/\r\n/g, "\n");
  fs.writeFileSync(absPath, lf, "utf8");
}

function writeJsonFileAbs(absPath, obj) {
  ensureDirForFile(absPath);
  // Stable JSON; newline to match repo conventions.
  const s = JSON.stringify(obj, null, 2).replace(/\r\n/g, "\n") + "\n";
  fs.writeFileSync(absPath, s, "utf8");
}

async function initManifestForFixture(appAbs, { template = "fixture" } = {}) {
  const fileMap = await computeAppFileMap(appAbs);
  const fingerprint = await computeAppFingerprint(appAbs);

  const manifestPath = path.join(appAbs, "builder.manifest.json");
  const manifest = {
    manifestSchemaVersion: 2,
    template,
    templateDir: null,
    fingerprint,
    fileMap,
    lastManifestInitUtc: new Date().toISOString(),
  };

  writeJsonFileAbs(manifestPath, manifest);

  return { manifestPath, fingerprint };
}

async function ensureDiagnosticsFixtures(baseDirAbs) {
  // Deterministic fixture locations.
  const fixtures = [
    {
      key: "fixture:err_npm_install_exit",
      dir: "err_npm_install_exit",
      prepare: async (appAbs) => {
        writeJsonFileAbs(path.join(appAbs, "package.json"), {
          name: "fixture-err-npm-install-exit",
          version: "1.0.0",
          private: true,
          scripts: {
            preinstall: "node -e \"process.exit(1)\"",
            start: "node server.js",
          },
        });

        writeTextFileAbs(
          path.join(appAbs, "server.js"),
          `
const http = require("http");
const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({ ok:true }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});
server.listen(port, "127.0.0.1", () => {});
`.trimStart()
        );

        await initManifestForFixture(appAbs, { template: "fixture" });
      },
      validateFlags: { installMode: "always" },
      expectCode: "ERR_NPM_INSTALL_EXIT",
    },
    {
      key: "fixture:err_npm_start_exit",
      dir: "err_npm_start_exit",
      prepare: async (appAbs) => {
        writeJsonFileAbs(path.join(appAbs, "package.json"), {
          name: "fixture-err-npm-start-exit",
          version: "1.0.0",
          private: true,
          scripts: {
            start: "node -e \"process.exit(3)\"",
          },
        });

        await initManifestForFixture(appAbs, { template: "fixture" });
      },
      validateFlags: { installMode: "never" },
      expectCode: "ERR_NPM_START_EXIT",
    },
    {
      key: "fixture:err_health_connrefused",
      dir: "err_health_connrefused",
      prepare: async (appAbs) => {
        writeJsonFileAbs(path.join(appAbs, "package.json"), {
          name: "fixture-err-health-connrefused",
          version: "1.0.0",
          private: true,
          scripts: {
            // Process stays alive but never binds to PORT => health fetch sees ECONNREFUSED.
            start: "node server.js",
          },
        });

        writeTextFileAbs(
          path.join(appAbs, "server.js"),
          `
setInterval(() => {}, 1000);
`.trimStart()
        );

        await initManifestForFixture(appAbs, { template: "fixture" });
      },
      validateFlags: { installMode: "never" },
      expectCode: "ERR_HEALTH_CONNREFUSED",
    },
    {
      key: "fixture:err_health_timeout",
      dir: "err_health_timeout",
      prepare: async (appAbs) => {
        writeJsonFileAbs(path.join(appAbs, "package.json"), {
          name: "fixture-err-health-timeout",
          version: "1.0.0",
          private: true,
          scripts: {
            start: "node server.js",
          },
        });

        // Server listens, but /health never responds (hang) => fetch abort timeout => ERR_HEALTH_TIMEOUT.
        writeTextFileAbs(
          path.join(appAbs, "server.js"),
          `
const http = require("http");
const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    // Intentionally never end response.
    res.setHeader("content-type","application/json");
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {});
`.trimStart()
        );

        await initManifestForFixture(appAbs, { template: "fixture" });
      },
      validateFlags: { installMode: "never" },
      expectCode: "ERR_HEALTH_TIMEOUT",
    },
    {
      key: "fixture:err_manifest_integrity",
      dir: "err_manifest_integrity",
      prepare: async (appAbs) => {
        writeJsonFileAbs(path.join(appAbs, "package.json"), {
          name: "fixture-err-manifest-integrity",
          version: "1.0.0",
          private: true,
          scripts: {
            start: "node server.js",
          },
        });

        writeTextFileAbs(
          path.join(appAbs, "server.js"),
          `
const http = require("http");
const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({ ok:true }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});
server.listen(port, "127.0.0.1", () => {});
`.trimStart()
        );

        // Write a valid manifest first, then deliberately corrupt fingerprint to force drift deterministically.
        const { manifestPath, fingerprint } = await initManifestForFixture(appAbs, { template: "fixture" });
        const raw = fs.readFileSync(manifestPath, "utf8");
        const parsed = JSON.parse(raw);
        parsed.fingerprint = String(fingerprint).slice(0, 10) + "deadbeefdeadbeefdeadbeefdeadbeef";
        writeJsonFileAbs(manifestPath, parsed);
      },
      validateFlags: { installMode: "never" },
      expectCode: "ERR_MANIFEST_INTEGRITY",
    },
  ];

  for (const f of fixtures) {
    const appAbs = path.join(baseDirAbs, f.dir);
    const manifestPath = path.join(appAbs, "builder.manifest.json");

    const exists = fs.existsSync(appAbs) && fs.statSync(appAbs).isDirectory();
    const hasManifest = exists && fs.existsSync(manifestPath);

    if (!exists) fs.mkdirSync(appAbs, { recursive: true });

    // Deterministic rebuild if missing manifest (or missing folder).
    if (!hasManifest) {
      // Clear directory to avoid partial state.
      if (fs.existsSync(appAbs)) {
        const entries = fs.readdirSync(appAbs);
        for (const name of entries) {
          const abs = path.join(appAbs, name);
          fs.rmSync(abs, { recursive: true, force: true });
        }
      }
      await f.prepare(appAbs);
    }
  }

  return fixtures.map((f) => ({
    key: f.key,
    appAbs: path.join(baseDirAbs, f.dir),
    validateFlags: f.validateFlags,
    expectCode: f.expectCode,
  }));
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

  // --- Diagnostics fixtures (deterministic local apps) ---
  // Lives outside outputs root; does not affect validate:all enumeration.
  const fixturesBaseAbs = path.resolve(process.cwd(), "ci", "fixtures", "diagnostics");
  const fixtureCases = await ensureDiagnosticsFixtures(fixturesBaseAbs);

  // Commands:
  // - Keep existing gates first
  // - Then add validate fixture cases, each with its own snapshot key
  const runList = [
    {
      cmd: "validate:all",
      schemaCmd: "validate:all",
      snapshotKey: "validate:all",
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
      schemaCmd: "report:ci",
      snapshotKey: "report:ci",
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
    // Fixture validate cases (contract-locked diagnostics)
    ...fixtureCases.map((fx) => ({
      cmd: "validate",
      schemaCmd: "validate",
      snapshotKey: `validate@${fx.key}`,
      expectedDiagnosticCode: fx.expectCode,
      args: () => {
        const a = ["--app", fx.appAbs, "--json", "--quiet"];
        if (fx.validateFlags?.installMode) {
          a.push("--install-mode", String(fx.validateFlags.installMode));
        }
        // No profile override for fixtures (they are not template-driven).
        return a;
      },
      hardGate: true,
    })),
  ];

  for (let idx = 0; idx < runList.length; idx++) {
    const item = runList[idx];

    if (progress) out.log(`[contract:run] ${idx + 1}/${runList.length} ${item.snapshotKey}`);

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
      ? SCHEMA_CHECKERS[item.schemaCmd]?.(res.json) ?? { ok: false, issues: ["no-checker"] }
      : { ok: false, issues: ["no-json"] };

    if (!schema.ok) schemaFailCount++;

    // ---- contract check/update ----
    let contract = null;
    let contractMatch = null;

    if (doContracts && res.json) {
      const snapPath = snapshotPathFor({ contractsDir, key: item.snapshotKey });

      if (contractsMode === "update") {
        ensureDirForFile(snapPath);
        const normalized = normalizeForContract(item.snapshotKey, res.json);
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
          const normalized = normalizeForContract(item.snapshotKey, res.json);
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

    // ---- fixture expectation check (diagnostics) ----
    // This does NOT affect schema; it’s a contract-level expectation only.
    // We only hard-gate when contracts are enabled and snapshot does NOT match.
    let expectation = null;
    if (item.cmd === "validate" && item.expectedDiagnosticCode && res.json) {
      const code =
        res.json?.validation?.checks?.[0]?.details?.code ??
        res.json?.validation?.checks?.[0]?.details?.error?.code ??
        null;

      expectation = {
        expected: item.expectedDiagnosticCode,
        actual: code,
        ok: code === item.expectedDiagnosticCode,
      };
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
      snapshotKey: item.snapshotKey,
      exitCode: res.exitCode,
      runError,
      schema,
      contract,
      expectation,
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
      fixturesDir: fixturesBaseAbs,
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
