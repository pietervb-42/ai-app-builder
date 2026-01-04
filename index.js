#!/usr/bin/env node
import process from "process";
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || "";
  const flags = {};
  const rest = args.slice(1);

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;

    const key = token.slice(2);
    const next = rest[i + 1];

    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }

  return { cmd, flags };
}

function requireFlag(flags, name) {
  const v = flags[name];
  if (!v || v === true) throw new Error(`Missing required flag: --${name}`);
  return v;
}

function hasFlag(flags, name) {
  return Boolean(flags[name]);
}

function isTrueish(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "on";
}

function pickExport(mod, candidates, modulePathForError) {
  for (const name of candidates) {
    if (typeof mod[name] === "function") return mod[name];
  }
  const available = Object.keys(mod).sort();
  throw new Error(
    `Module ${modulePathForError} does not export any of: ${candidates.join(
      ", "
    )}\nAvailable exports: ${available.join(", ")}`
  );
}

function normalizeInstallMode(v) {
  if (!v || v === true) return undefined;
  const s = String(v).toLowerCase().trim();
  if (s === "always" || s === "never" || s === "if-missing") return s;
  return undefined;
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonFile(filePath, obj) {
  ensureDirForFile(filePath);
  const json = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(filePath, json, "utf8");
}

function getUsageText() {
  return `
ai-app-builder CLI

Commands:
  templates:list [--json]

  plan --prompt "<text>" [--out <file>] [--json] [--quiet]

  generate --template <name> --out <path>
  generate --from-plan <plan.json> [--out <path>] [--template <name>]

  build --prompt "<text>" [--out <path>] [--template <name>]
        [--install-mode <always|never|if-missing>] [--dry-run]
        [--write-policy <refuse|merge-safe|overwrite>] [--yes]
        [--json] [--quiet]

  validate --app <path> [--quiet] [--json] [--no-install]
           [--install-mode <always|never|if-missing>] [--out <file>] [--profile <name>]

  validate:all --root <path> [--quiet] [--json] [--no-install]
               [--install-mode <always|never|if-missing>] [--out <file>] [--profile <name>]
               [--progress] [--max <n>] [--include <text>]

  report:ci --root <path> [--quiet] [--json] [--no-install]
            [--install-mode <always|never|if-missing>] [--out <file>] [--profile <name>]
            [--progress] [--max <n>] [--include <text>] [--heal-manifest]

  manifest:refresh --app <path> [--apply] [--templateDir <path>]
  manifest:refresh:all --root <path> [--apply] [--templateDir <path>]
                       [--progress] [--max <n>] [--include <text>]

  manifest:init --app <path> --yes --templateDir <path> [--template <name>]

  drift:report --app <path> [--diff] [--json] [--quiet]
  regen:preview --app <path> [--json] [--quiet]
  regen:apply --app <path> --yes [--overwriteModified]
             [--write-policy <merge-safe|overwrite>] [--json] [--quiet]

  schema:check --cmd <validate|validate:all|report:ci|manifest:refresh:all> (--file <path> | --stdin true)
               [--json] [--quiet]

  contract:check --cmd <validate|validate:all|report:ci|manifest:refresh:all> (--file <path> | --stdin true)
                 [--contracts-dir <path>] [--json] [--quiet]

  contract:update --cmd <validate|validate:all|report:ci|manifest:refresh:all> (--file <path> | --stdin true)
                  [--contracts-dir <path>] [--json] [--quiet]

  contract:run --root <path> [--json] [--quiet] [--out <file>]
               [--no-install] [--install-mode <always|never|if-missing>] [--profile <name>]
               [--progress] [--max <n>] [--include <text>] [--heal-manifest]
               [--refresh-manifests <never|after>] [--apply]
               [--contracts true] [--contracts-dir <path>]
               [--contracts-mode <check|update>]

  ci:check --root <path> [--json] [--quiet]
           [--no-install] [--install-mode <always|never|if-missing>] [--profile <name>]
           [--progress] [--max <n>] [--include <text>] [--heal-manifest]
           [--refresh-manifests <never|after>] [--apply]
           [--contracts-dir <path>]

CI convenience:
  --ci                 Alias for --json --quiet
  --json-on-pipe true  If stdout is piped (not TTY), force --json
`.trim();
}

function printUsage() {
  console.log(getUsageText());
}

function classifyCliError(err, cmd) {
  const message = err?.message || String(err || "");
  const msg = String(message);

  const usageSignals = [
    "Missing required flag:",
    "Unknown command:",
    "does not exist or is not a directory:",
    "does not exist",
    "is not a directory",
  ];

  const isUsage =
    usageSignals.some((s) => msg.includes(s)) ||
    (cmd === "schema:check" && msg.includes("--cmd")) ||
    (cmd === "contract:check" && msg.includes("--cmd")) ||
    (cmd === "contract:update" && msg.includes("--cmd")) ||
    (cmd === "contract:run" && msg.includes("--root")) ||
    (cmd === "ci:check" && msg.includes("--root"));

  return {
    exitCode: 2,
    errorCode: isUsage ? "ERR_INPUT" : "ERR_RUNTIME",
    message: msg,
  };
}

function discoverApps(rootPath, { include, max } = {}) {
  const absRoot = path.isAbsolute(rootPath)
    ? rootPath
    : path.resolve(process.cwd(), rootPath);

  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    throw new Error(`Root path does not exist or is not a directory: ${absRoot}`);
  }

  const entries = fs.readdirSync(absRoot, { withFileTypes: true });
  let dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  dirs.sort((a, b) => a.localeCompare(b));

  const apps = [];
  for (const d of dirs) {
    const rel = path.join(rootPath, d);
    const abs = path.join(absRoot, d);

    if (include && !String(rel).includes(include)) continue;

    const manifestPath = path.join(abs, "builder.manifest.json");
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      apps.push({ relPath: rel, absPath: abs });
      if (typeof max === "number" && Number.isFinite(max) && apps.length >= max) break;
    }
  }

  return { absRoot, apps };
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv);

  const ciMode = hasFlag(flags, "ci");
  const jsonOnPipe = isTrueish(flags["json-on-pipe"]);
  const stdoutNotTty = Boolean(process.stdout && process.stdout.isTTY !== true);

  if (ciMode) {
    flags.json = true;
    flags.quiet = true;
  }

  if (jsonOnPipe && stdoutNotTty) {
    flags.json = true;
  }

  const jsonMode = hasFlag(flags, "json") || ciMode || (jsonOnPipe && stdoutNotTty);

  try {
    const isHelp = !cmd || cmd === "help" || cmd === "--help" || cmd === "-h";

    if (isHelp) {
      const usage = getUsageText();

      if (jsonMode) {
        process.stderr.write(usage + "\n");
        process.stdout.write(
          JSON.stringify({ ok: true, cmd: "help", usageOnStderr: true }) + "\n"
        );
        process.exit(0);
      }

      printUsage();
      process.exit(0);
    }

    if (cmd === "templates:list") {
      const json = hasFlag(flags, "json");
      const mod = await import("./src/templates.js");
      const fn = pickExport(mod, ["templatesList", "listTemplates"], "./src/templates.js");
      await fn({ json });
      return;
    }

    if (cmd === "schema:check") {
      const mod = await import("./src/schema-check.js");
      const fn = pickExport(mod, ["schemaCheck"], "./src/schema-check.js");
      await fn({ flags });
      return;
    }

    if (cmd === "contract:check") {
      const mod = await import("./src/contract-check.js");
      const fn = pickExport(mod, ["contractCheck"], "./src/contract-check.js");
      await fn({ flags });
      return;
    }

    if (cmd === "contract:update") {
      const mod = await import("./src/contract-check.js");
      const fn = pickExport(mod, ["contractUpdate"], "./src/contract-check.js");
      await fn({ flags });
      return;
    }

    if (cmd === "contract:run") {
      const mod = await import("./src/contract-run.js");
      const fn = pickExport(mod, ["contractRun"], "./src/contract-run.js");
      const exitCode = await fn({ flags });
      process.exit(typeof exitCode === "number" ? exitCode : 2);
    }

    if (cmd === "ci:check") {
      const mod = await import("./src/ci-check.js");
      const fn = pickExport(mod, ["ciCheck"], "./src/ci-check.js");
      const exitCode = await fn({ flags });
      process.exit(typeof exitCode === "number" ? exitCode : 2);
    }

    if (cmd === "plan") {
      const prompt = requireFlag(flags, "prompt");
      const json = hasFlag(flags, "json");
      const quiet = hasFlag(flags, "quiet");
      const out = flags.out;

      const mod = await import("./src/plan.js");
      const fn = pickExport(mod, ["createPlan"], "./src/plan.js");

      const plan = fn(prompt);

      if (out) {
        const resolved = path.isAbsolute(out) ? out : path.resolve(process.cwd(), String(out));
        writeJsonFile(resolved, plan);
      }

      if (json || quiet) {
        process.stdout.write(JSON.stringify(plan) + "\n");
      } else {
        process.stdout.write("=== PLAN MODE ===\n");
        process.stdout.write(`Goal: ${plan.goal}\n\n`);
        process.stdout.write("Steps:\n");
        for (const s of plan.steps) process.stdout.write(`- ${s.id}: ${s.title}\n`);
        process.stdout.write("\nTip: use --json for CI-stable output.\n");
      }

      return;
    }

    if (cmd === "generate") {
      const fromPlan = flags["from-plan"] ? String(flags["from-plan"]) : "";

      if (fromPlan) {
        const planMod = await import("./src/plan-handoff.js");
        const loadFn = pickExport(planMod, ["loadPlanFromFile"], "./src/plan-handoff.js");
        const selectFn = pickExport(planMod, ["selectTemplateFromPlan"], "./src/plan-handoff.js");
        const defaultOutFn = pickExport(planMod, ["defaultOutPathFromPlan"], "./src/plan-handoff.js");

        const { plan } = loadFn(fromPlan);

        const explicitTemplate = flags.template ? String(flags.template) : "";
        let template = explicitTemplate;
        let notes = [];
        if (!template) {
          const selected = selectFn(plan);
          template = selected.template;
          notes = Array.isArray(selected.notes) ? selected.notes : [];
        }

        const out = flags.out ? String(flags.out) : "";
        const outPath = out ? out : defaultOutFn(plan);

        const mod = await import("./src/generate.js");
        const fn = pickExport(mod, ["generateApp", "generate"], "./src/generate.js");
        await fn({ template, outPath });

        if (notes.length) for (const n of notes) process.stderr.write(`[plan->generate] ${n}\n`);
        return;
      }

      const template = requireFlag(flags, "template");
      const out = requireFlag(flags, "out");

      const mod = await import("./src/generate.js");
      const fn = pickExport(mod, ["generateApp", "generate"], "./src/generate.js");
      await fn({ template, outPath: out });
      return;
    }

    if (cmd === "build") {
      const mod = await import("./src/build.js");
      const fn = pickExport(mod, ["buildCommand"], "./src/build.js");
      const exitCode = await fn({ flags });
      process.exit(typeof exitCode === "number" ? exitCode : 2);
    }

    if (cmd === "validate") {
      const app = requireFlag(flags, "app");
      const json = hasFlag(flags, "json");
      const quiet = hasFlag(flags, "quiet");
      const noInstall = hasFlag(flags, "no-install");
      const out = flags.out;
      const profile = flags.profile;

      const installMode = normalizeInstallMode(flags["install-mode"]);

      const mod = await import("./src/validate.js");
      const fn = pickExport(mod, ["validateApp", "validate"], "./src/validate.js");

      await fn({ appPath: app, json, quiet, noInstall, installMode, outPath: out, profile });
      return;
    }

    if (cmd === "validate:all") {
      const root = requireFlag(flags, "root");
      const json = hasFlag(flags, "json");
      const quiet = hasFlag(flags, "quiet");
      const noInstall = hasFlag(flags, "no-install");
      const out = flags.out;
      const profile = flags.profile;

      const progress = hasFlag(flags, "progress");
      const max = flags.max ? Number(flags.max) : undefined;
      const include = flags.include ? String(flags.include) : undefined;

      const installMode = normalizeInstallMode(flags["install-mode"]);

      const mod = await import("./src/validate-all.js");
      const fn = pickExport(mod, ["validateAll"], "./src/validate-all.js");

      await fn({ rootPath: root, json, quiet, noInstall, installMode, outPath: out, profile, progress, max, include });
      return;
    }

    if (cmd === "report:ci") {
      const root = requireFlag(flags, "root");
      const json = hasFlag(flags, "json");
      const quiet = hasFlag(flags, "quiet");
      const noInstall = hasFlag(flags, "no-install");
      const out = flags.out;
      const profile = flags.profile;

      const progress = hasFlag(flags, "progress");
      const max = flags.max ? Number(flags.max) : undefined;
      const include = flags.include ? String(flags.include) : undefined;

      const installMode = normalizeInstallMode(flags["install-mode"]);
      const healManifest = hasFlag(flags, "heal-manifest");

      const mod = await import("./src/report-ci.js");
      const fn = pickExport(mod, ["reportCi"], "./src/report-ci.js");

      await fn({ root, rootPath: root, json, quiet, noInstall, installMode, outPath: out, profile, progress, max, include, healManifest });
      return;
    }

    if (cmd === "manifest:refresh") {
      const app = requireFlag(flags, "app");

      let apply = true;
      if (Object.prototype.hasOwnProperty.call(flags, "apply")) {
        const v = flags.apply;
        if (v === true) apply = true;
        else {
          const s = String(v).toLowerCase().trim();
          apply = !(s === "false" || s === "0" || s === "no");
        }
      }

      const templateDir = flags.templateDir;

      const mod = await import("./src/manifest.js");
      const fn = pickExport(mod, ["manifestRefresh"], "./src/manifest.js");

      await fn({ appPath: app, apply, templateDir });
      return;
    }

    if (cmd === "manifest:refresh:all") {
      const root = requireFlag(flags, "root");

      let apply = true;
      if (Object.prototype.hasOwnProperty.call(flags, "apply")) {
        const v = flags.apply;
        if (v === true) apply = true;
        else {
          const s = String(v).toLowerCase().trim();
          apply = !(s === "false" || s === "0" || s === "no");
        }
      }

      const templateDir = flags.templateDir;

      const progress = hasFlag(flags, "progress");
      const max = flags.max ? Number(flags.max) : undefined;
      const include = flags.include ? String(flags.include) : undefined;

      const { apps } = discoverApps(root, { include, max });

      const mod = await import("./src/manifest.js");
      const fn = pickExport(mod, ["manifestRefreshCore"], "./src/manifest.js");

      const startedAt = new Date().toISOString();
      let okCount = 0;
      let failCount = 0;
      const results = [];

      for (let i = 0; i < apps.length; i++) {
        const a = apps[i];
        if (progress) process.stderr.write(`[manifest:refresh:all] ${i + 1}/${apps.length} ${a.relPath}\n`);
        try {
          const r = await fn({ appPath: a.relPath, apply, templateDir });
          okCount++;
          results.push({ appPath: a.relPath, ok: true, result: r ?? null });
        } catch (e) {
          failCount++;
          results.push({ appPath: a.relPath, ok: false, error: e?.message || String(e) });
        }
      }

      const finishedAt = new Date().toISOString();
      const payload = {
        ok: failCount === 0,
        rootPath: path.isAbsolute(root) ? root : path.resolve(process.cwd(), root),
        startedAt,
        finishedAt,
        appsFound: apps.length,
        okCount,
        failCount,
        apply,
        include: include ?? null,
        max: typeof max === "number" && Number.isFinite(max) ? max : null,
        results,
      };

      process.stdout.write(JSON.stringify(payload) + "\n");
      process.exit(payload.ok ? 0 : 1);
    }

    if (cmd === "manifest:init") {
      const app = requireFlag(flags, "app");
      const yes = hasFlag(flags, "yes");
      const templateDir = requireFlag(flags, "templateDir");
      const template = flags.template;

      const mod = await import("./src/manifest.js");
      const fn = pickExport(mod, ["manifestInit"], "./src/manifest.js");
      await fn({ appPath: app, yes, templateDir, template });
      return;
    }

    if (cmd === "drift:report") {
      const app = requireFlag(flags, "app");
      const diff = hasFlag(flags, "diff");
      const json = hasFlag(flags, "json");
      const quiet = hasFlag(flags, "quiet");

      const mod = await import("./src/diff.js");
      const fn = pickExport(mod, ["driftReport", "reportDrift"], "./src/diff.js");
      await fn({ appPath: app, diff, json, quiet });
      return;
    }

    if (cmd === "regen:preview") {
      const app = requireFlag(flags, "app");
      const json = hasFlag(flags, "json");
      const quiet = hasFlag(flags, "quiet");

      const mod = await import("./src/regen.js");
      const fn = pickExport(mod, ["regenPreview"], "./src/regen.js");
      await fn({ appPath: app, json, quiet });
      return;
    }

    if (cmd === "regen:apply") {
      const app = requireFlag(flags, "app");
      const yes = hasFlag(flags, "yes");
      const overwriteModified = hasFlag(flags, "overwriteModified");
      const json = hasFlag(flags, "json");
      const quiet = hasFlag(flags, "quiet");

      const writePolicy = flags["write-policy"] ?? flags.writePolicy;

      const mod = await import("./src/regen.js");
      const fn = pickExport(mod, ["regenApply"], "./src/regen.js");

      await fn({ appPath: app, yes, overwriteModified, writePolicy, json, quiet });
      return;
    }

    throw new Error(`Unknown command: ${cmd}`);
  } catch (err) {
    const classified = classifyCliError(err, cmd);
    const message = classified.message;

    if (jsonMode) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: { code: classified.errorCode, message, cmd: cmd || null },
        }) + "\n"
      );
      process.exit(classified.exitCode);
    }

    console.error(`[error] ${message}`);
    process.exit(classified.exitCode);
  }
}

main();
