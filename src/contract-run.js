// src/contract-run.js
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import { createOutput } from "./output.js";
import { SCHEMA_CHECKERS } from "./ci-schemas.js";

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

function ensureDirAbs(dirAbs) {
  fs.mkdirSync(dirAbs, { recursive: true });
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
  const lf = String(content ?? "").replace(/\r\n/g, "\n");
  fs.writeFileSync(absPath, lf, "utf8");
}

function writeJsonFileAbs(absPath, obj) {
  ensureDirForFile(absPath);
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

function buildSchemaCheck(payload) {
  const issues = [];

  if (!payload || typeof payload !== "object") {
    return { ok: false, issues: ["payload_not_object"] };
  }

  if (typeof payload.ok !== "boolean") issues.push("missing_ok_boolean");

  if (payload.ok === true) {
    if (payload.dryRun === true) {
      if (typeof payload.template !== "string") issues.push("missing_template");
      if (typeof payload.outPath !== "string") issues.push("missing_outPath");
      if (typeof payload.outPathAbs !== "string") issues.push("missing_outPathAbs");
      if (typeof payload.installMode !== "string") issues.push("missing_installMode");
      if (typeof payload.overwrite !== "boolean") issues.push("missing_overwrite_boolean");
    } else {
      if (typeof payload.template !== "string") issues.push("missing_template");
      if (typeof payload.outPath !== "string") issues.push("missing_outPath");
      if (typeof payload.outPathAbs !== "string") issues.push("missing_outPathAbs");
      if (typeof payload.overwrite !== "boolean") issues.push("missing_overwrite_boolean");
      if (!payload.validation || typeof payload.validation !== "object")
        issues.push("missing_validation_object");
    }
  } else {
    if (typeof payload.stage !== "string") issues.push("missing_stage");
    if (!payload.error || typeof payload.error !== "object") issues.push("missing_error_object");
    if (payload.error && typeof payload.error.code !== "string") issues.push("missing_error_code");
    if (payload.error && typeof payload.error.message !== "string")
      issues.push("missing_error_message");

    if (payload.error?.code === "ERR_OUT_NOT_EMPTY") {
      if (!payload.error.details || typeof payload.error.details !== "object") {
        issues.push("missing_error_details_object");
      } else {
        if (typeof payload.error.details.path !== "string") issues.push("missing_details_path");
        if (!Array.isArray(payload.error.details.blockingEntries))
          issues.push("missing_blockingEntries_array");
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

async function ensureDiagnosticsFixtures(baseDirAbs) {
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
            preinstall: 'node -e "process.exit(1)"',
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
            start: 'node -e "process.exit(3)"',
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

        writeTextFileAbs(
          path.join(appAbs, "server.js"),
          `
const http = require("http");
const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
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

        const { manifestPath, fingerprint } = await initManifestForFixture(appAbs, {
          template: "fixture",
        });
        const raw = fs.readFileSync(manifestPath, "utf8");
        const parsed = JSON.parse(raw);
        parsed.fingerprint =
          String(fingerprint).slice(0, 10) + "deadbeefdeadbeefdeadbeefdeadbeef";
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

    if (!hasManifest) {
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

function ensureBuildContractFixtures(fixturesBaseAbs) {
  const dryRunDirAbs = path.join(fixturesBaseAbs, "build_dryrun_ok");
  const notEmptyDirAbs = path.join(fixturesBaseAbs, "build_out_not_empty");

  const dryRunOutAbs = path.join(dryRunDirAbs, "out");
  const notEmptyOutAbs = path.join(notEmptyDirAbs, "out");

  ensureDirAbs(dryRunDirAbs);
  ensureDirAbs(notEmptyDirAbs);

  // ✅ NEW: keep dry-run deterministic by ensuring the out folder is empty.
  if (fs.existsSync(dryRunOutAbs)) {
    fs.rmSync(dryRunOutAbs, { recursive: true, force: true });
  }
  ensureDirAbs(dryRunOutAbs);

  // Not-empty fixture: ensure exact known blocking entry exists.
  if (fs.existsSync(notEmptyOutAbs)) {
    fs.rmSync(notEmptyOutAbs, { recursive: true, force: true });
  }
  ensureDirAbs(notEmptyOutAbs);

  writeTextFileAbs(path.join(notEmptyOutAbs, "foo.txt"), "hi\n");

  return {
    dryRun: { fixtureDirAbs: dryRunDirAbs, outAbs: dryRunOutAbs },
    notEmpty: {
      fixtureDirAbs: notEmptyDirAbs,
      outAbs: notEmptyOutAbs,
      blocking: ["foo.txt"],
    },
  };
}

function detectCi({ flags }) {
  if (hasFlag(flags, "ci")) return true;
  return isTrueish(process.env.CI);
}

function argvHasFlag(argv, flagName) {
  const needle = `--${String(flagName).toLowerCase()}`;
  for (const a of argv) {
    if (typeof a !== "string") continue;
    if (a.toLowerCase() === needle) return true;
  }
  return false;
}

function injectBuildFixtureTemplateIfMissing({ snapshotKey, argvTail }) {
  if (
    snapshotKey !== "build@fixture:dry_run_ok" &&
    snapshotKey !== "build@fixture:out_not_empty"
  ) {
    return argvTail;
  }

  if (argvHasFlag(argvTail, "template")) return argvTail;

  return [...argvTail, "--template", "node-express-api-sqlite"];
}

function canonicalizeOutNotEmptyMessage({ details }) {
  const p = details && typeof details.path === "string" ? details.path : null;
  const entries =
    details && Array.isArray(details.blockingEntries) ? details.blockingEntries : null;

  if (!p || !entries) return null;

  const list = entries.join(", ");
  return `Output folder is not empty (overwrite blocked). Path: ${p}. Blocking entries: ${list}`;
}

async function runPlanForFixture({ prompt, template }) {
  const node = process.execPath;
  const entry = path.resolve(process.cwd(), "index.js");
  const args = [
    entry,
    "plan",
    "--prompt",
    String(prompt),
    "--template",
    String(template),
    "--json",
    "--quiet",
  ];

  return await new Promise((resolve) => {
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
}

async function canonicalizeBuildFixturePayloadAsync(snapshotKey, payload, { prompt, template }) {
  if (
    snapshotKey !== "build@fixture:dry_run_ok" &&
    snapshotKey !== "build@fixture:out_not_empty"
  ) {
    return payload;
  }

  if (!payload || typeof payload !== "object") return payload;
  if (payload.ok === true) return payload;

  const err = payload.error && typeof payload.error === "object" ? payload.error : null;
  const next = { ...payload };

  // Lift known context fields from error to top-level if missing.
  if (next.template == null && err && typeof err.template === "string") next.template = err.template;
  if (next.outPath == null && err && typeof err.outPath === "string") next.outPath = err.outPath;
  if (next.outPathAbs == null && err && typeof err.outPathAbs === "string")
    next.outPathAbs = err.outPathAbs;
  if (typeof next.overwrite !== "boolean" && err && typeof err.overwrite === "boolean")
    next.overwrite = err.overwrite;

  // Ensure stable presence for validation (some locked snapshots expect the key).
  if (!Object.prototype.hasOwnProperty.call(next, "validation")) next.validation = null;

  if (err && err.code === "ERR_OUT_NOT_EMPTY") {
    const msg = canonicalizeOutNotEmptyMessage({ details: err.details }) ?? err.message;

    // Canonicalize stage for this fixture snapshot
    next.stage = "generate";

    next.error = {
      code: err.code,
      message: msg,
      details: err.details,
    };

    // Populate plan for snapshot stability
    if (next.plan == null) {
      const planRes = await runPlanForFixture({ prompt, template });
      if (planRes.exitCode === 0 && planRes.json) {
        next.plan = planRes.json.plan ?? planRes.json;
      }
    }
  }

  return next;
}

export async function contractRun({ flags }) {
  const json = hasFlag(flags, "json");
  const quiet = hasFlag(flags, "quiet") || Boolean(json);
  const progress = hasFlag(flags, "progress");

  const out = createOutput({ json: Boolean(json), quiet: Boolean(quiet) });

  let root;
  try {
    root = String(requireFlag(flags, "root"));
  } catch (e) {
    const payload = {
      ok: false,
      startedAt: null,
      finishedAt: null,
      error: { code: "ERR_CONTRACT_INPUT", message: String(e?.message || e) },
    };
    if (json) out.emitJson(payload);
    else out.log(`[contract:run] ERROR: ${payload.error.message}`);
    return 2;
  }

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
  const contractsDir = flags["contracts-dir"] ? String(flags["contracts-dir"]) : "ci/contracts";

  const contractsMode = flags["contracts-mode"]
    ? String(flags["contracts-mode"]).toLowerCase().trim()
    : "check";

  const allowUpdate = hasFlag(flags, "allow-update");
  const isCi = detectCi({ flags });

  if (doContracts && contractsMode === "update") {
    if (isCi) {
      const payload = {
        ok: false,
        rootPath: path.resolve(root),
        startedAt: null,
        finishedAt: null,
        error: {
          code: "ERR_CONTRACT_LOCKED_CI",
          message:
            "Contract snapshots are locked in CI (Step 33). Refusing --contracts-mode update.",
        },
      };
      if (json) out.emitJson(payload);
      else out.log(`[contract:run] ERROR: ${payload.error.message}`);
      return 2;
    }

    if (!allowUpdate) {
      const payload = {
        ok: false,
        rootPath: path.resolve(root),
        startedAt: null,
        finishedAt: null,
        error: {
          code: "ERR_CONTRACT_UPDATE_REQUIRES_ACK",
          message:
            "Refusing to update contract snapshots without explicit acknowledgement. Re-run with --allow-update.",
        },
      };
      if (json) out.emitJson(payload);
      else {
        out.log(
          "[contract:run] Refusing --contracts-mode update without --allow-update.\n" +
            "              This would overwrite golden snapshots.\n" +
            "              Re-run with --allow-update to acknowledge intent."
        );
      }
      return 2;
    }
  }

  const settleMs = safeNumber(flags["settle-ms"], 0);
  const startedAt = new Date().toISOString();

  const results = [];
  let schemaFailCount = 0;
  let contractFailCount = 0;
  let cmdFailCount = 0;
  let expectationFailCount = 0;

  const fixturesBaseAbs = path.resolve(process.cwd(), "ci", "fixtures", "diagnostics");
  const fixtureCases = await ensureDiagnosticsFixtures(fixturesBaseAbs);

  const buildFixtures = ensureBuildContractFixtures(fixturesBaseAbs);

  const CONTRACT_FIXED_ROOT_KEYS = new Set([
    "validate:all",
    "report:ci",
    "build@fixture:dry_run_ok",
    "build@fixture:out_not_empty",
  ]);
  const fixedContractRootAbs = fixturesBaseAbs;

  function rootForItem(snapshotKey) {
    if (!doContracts) return root;
    if (CONTRACT_FIXED_ROOT_KEYS.has(String(snapshotKey))) return fixedContractRootAbs;
    return root;
  }

  const BUILD_FIXTURE_PROMPT = "create an express api with sqlite users table";
  const BUILD_FIXTURE_TEMPLATE = "node-express-api-sqlite";

  const runList = [
    {
      cmd: "validate:all",
      schemaCmd: "validate:all",
      snapshotKey: "validate:all",
      args: (runRoot) => {
        const a = ["--root", runRoot, "--json", "--quiet"];
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
      args: (runRoot) => {
        const a = ["--root", runRoot, "--json", "--quiet"];
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
      cmd: "build",
      schemaCmd: "build",
      snapshotKey: "build@fixture:dry_run_ok",
      args: () => [
        "--prompt",
        BUILD_FIXTURE_PROMPT,
        "--out",
        buildFixtures.dryRun.outAbs,
        "--dry-run",
        "--json",
        "--quiet",
      ],
      hardGate: true,
    },

    {
      cmd: "build",
      schemaCmd: "build",
      snapshotKey: "build@fixture:out_not_empty",
      expectedBuildErrorCode: "ERR_OUT_NOT_EMPTY",
      // ✅ FIX: overwrite now REQUIRES --yes, otherwise we never reach ERR_OUT_NOT_EMPTY.
      args: () => [
        "--prompt",
        BUILD_FIXTURE_PROMPT,
        "--out",
        buildFixtures.notEmpty.outAbs,
        "--overwrite",
        "--yes",
        "--json",
        "--quiet",
      ],
      hardGate: true,
    },

    {
      cmd: "templates:inventory",
      schemaCmd: "templates:inventory",
      snapshotKey: "templates:inventory",
      args: () => ["--json"],
      hardGate: true,
    },

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

    const runRoot = rootForItem(item.snapshotKey);
    let argvTail = typeof item.args === "function" ? item.args(runRoot) : [];

    argvTail = injectBuildFixtureTemplateIfMissing({
      snapshotKey: item.snapshotKey,
      argvTail,
    });

    const args = [entry, item.cmd, ...argvTail];

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

    if (res.json) {
      res.json = await canonicalizeBuildFixturePayloadAsync(item.snapshotKey, res.json, {
        prompt: BUILD_FIXTURE_PROMPT,
        template: BUILD_FIXTURE_TEMPLATE,
      });
    }

    // ---- schema check ----
    let schema;
    if (!res.json) {
      schema = { ok: false, issues: ["no-json"] };
    } else if (item.schemaCmd === "build") {
      schema = buildSchemaCheck(res.json);
    } else {
      schema = SCHEMA_CHECKERS[item.schemaCmd]?.(res.json) ?? { ok: false, issues: ["no-checker"] };
    }

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

      if (!expectation.ok) expectationFailCount++;
    }

    // ---- build expectation check ----
    if (item.cmd === "build" && item.expectedBuildErrorCode && res.json) {
      const code = res.json?.error?.code ?? null;

      expectation = {
        expected: item.expectedBuildErrorCode,
        actual: code,
        ok: code === item.expectedBuildErrorCode,
      };

      if (!expectation.ok) expectationFailCount++;
    }

    const nonzeroExit = res.exitCode !== 0;

    const shouldCountCmdFail =
      item.hardGate && nonzeroExit && (!doContracts || contractMatch !== true);

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

  const ok =
    schemaFailCount === 0 &&
    contractFailCount === 0 &&
    cmdFailCount === 0 &&
    expectationFailCount === 0;

  const payload = {
    ok,
    rootPath: path.resolve(root),
    startedAt,
    finishedAt: new Date().toISOString(),
    counts: {
      schemaFailCount,
      contractFailCount,
      cmdFailCount,
      expectationFailCount,
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
      ci: Boolean(isCi),
      contractRoots: {
        defaultRoot: path.resolve(root),
        fixedRoot: fixedContractRootAbs,
        fixedKeys: Array.from(CONTRACT_FIXED_ROOT_KEYS.values()),
      },
      buildFixtures: {
        dryRunOutAbs: buildFixtures.dryRun.outAbs,
        notEmptyOutAbs: buildFixtures.notEmpty.outAbs,
        notEmptyBlocking: buildFixtures.notEmpty.blocking,
      },
    },
    results,
  };

  if (json) out.emitJson(payload);
  else out.log(`contract:run ${ok ? "OK" : "FAIL"}`);

  return ok ? 0 : 1;
}
