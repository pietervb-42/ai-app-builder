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
  // invalid value -> ignore (validator will default deterministically)
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

function printUsage() {
  console.log(
    `
ai-app-builder CLI

Commands:
  templates:list

  generate --template <name> --out <path>
  generate --from-plan <plan.json> [--out <path>] [--template <name>]

  plan --prompt "<text>" [--out <file>] [--json] [--quiet]

  build --prompt "<text>" [--out <path>] [--template <name>] [--install-mode <always|never|if-missing>] [--json] [--quiet]

  validate --app <path> [--quiet] [--json] [--no-install] [--install-mode <always|never|if-missing>] [--out <file>] [--profile <name>]
  validate:all --root <path> [--quiet] [--json] [--no-install] [--install-mode <always|never|if-missing>] [--out <file>] [--profile <name>] [--progress] [--max <n>] [--include <text>]

  manifest:refresh --app <path> [--apply] [--templateDir <path>]
  manifest:init --app <path> --yes --templateDir <path> [--template <name>]
  drift:report --app <path> [--diff]
  regen:preview --app <path>
  regen:apply --app <path> --yes [--overwriteModified]

Flags:
  --from-plan <file>  Generate using a plan JSON artifact (Step 14 handshake)
  --template <name>   Template name (explicit override)
  --out <path>        Output folder path (if omitted with --from-plan, defaults deterministically)

  --prompt <text>   Required for plan/build. Goal/requirements statement.
  --quiet          Suppress npm install/start output (CI friendly)
  --json           Print ONLY the final JSON result (one line)
  --no-install     Skip npm install (CI already installed deps)
  --install-mode   Install behavior: always|never|if-missing
  --out <file>     Write JSON result to a file (CI artifact)
  --profile <n>    Override validation profile selection
  --progress       Print progress lines to stderr (keeps JSON clean)
  --max <n>         Limit number of apps validated (debug)
  --include <text>  Only validate app paths containing this substring
`.trim()
  );
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv);

  try {
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
      printUsage();
      process.exit(0);
    }

    if (cmd === "templates:list") {
      const mod = await import("./src/templates.js");
      const fn = pickExport(
        mod,
        ["templatesList", "listTemplates"],
        "./src/templates.js"
      );
      await fn();
      return;
    }

    if (cmd === "generate") {
      const fromPlan = flags["from-plan"] ? String(flags["from-plan"]) : "";

      // Step 14 path: generate from plan artifact
      if (fromPlan) {
        const planMod = await import("./src/plan-handoff.js");
        const loadFn = pickExport(planMod, ["loadPlanFromFile"], "./src/plan-handoff.js");
        const selectFn = pickExport(planMod, ["selectTemplateFromPlan"], "./src/plan-handoff.js");
        const defaultOutFn = pickExport(planMod, ["defaultOutPathFromPlan"], "./src/plan-handoff.js");

        const { plan } = loadFn(fromPlan);

        // Template selection
        const explicitTemplate = flags.template ? String(flags.template) : "";
        let template = explicitTemplate;

        let notes = [];
        if (!template) {
          const selected = selectFn(plan);
          template = selected.template;
          notes = Array.isArray(selected.notes) ? selected.notes : [];
        }

        // Out path selection
        const out = flags.out ? String(flags.out) : "";
        const outPath = out ? out : defaultOutFn(plan);

        // Call existing generate implementation (unchanged)
        const mod = await import("./src/generate.js");
        const fn = pickExport(mod, ["generateApp", "generate"], "./src/generate.js");
        await fn({ template, outPath });

        // Optional deterministic note output (stderr) so it never pollutes JSON outputs elsewhere
        if (notes.length) {
          for (const n of notes) process.stderr.write(`[plan->generate] ${n}\n`);
        }

        return;
      }

      // Legacy path: explicit template + out required
      const template = requireFlag(flags, "template");
      const out = requireFlag(flags, "out");

      const mod = await import("./src/generate.js");
      const fn = pickExport(mod, ["generateApp", "generate"], "./src/generate.js");
      await fn({ template, outPath: out });
      return;
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
        for (const s of plan.steps) {
          process.stdout.write(`- ${s.id}: ${s.title}\n`);
        }
        process.stdout.write("\nTip: use --json for CI-stable output.\n");
      }

      return;
    }

    // Step 15: build (single pipeline)
    if (cmd === "build") {
      const mod = await import("./src/build.js");
      const fn = pickExport(mod, ["buildCommand"], "./src/build.js");
      const code = await fn({ flags });
      process.exit(code);
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

      await fn({
        appPath: app,
        json,
        quiet,
        noInstall,
        installMode,
        outPath: out,
        profile,
      });
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

      await fn({
        rootPath: root,
        json,
        quiet,
        noInstall,
        installMode,
        outPath: out,
        profile,
        progress,
        max,
        include,
      });
      return;
    }

    if (cmd === "manifest:refresh") {
      const app = requireFlag(flags, "app");
      const apply = hasFlag(flags, "apply");
      const templateDir = flags.templateDir;

      const mod = await import("./src/manifest.js");
      const fn = pickExport(mod, ["manifestRefresh"], "./src/manifest.js");
      await fn({ appPath: app, apply, templateDir });
      return;
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

      const mod = await import("./src/diff.js");
      const fn = pickExport(mod, ["driftReport", "reportDrift"], "./src/diff.js");
      await fn({ appPath: app, diff });
      return;
    }

    if (cmd === "regen:preview") {
      const app = requireFlag(flags, "app");

      const mod = await import("./src/regen.js");
      const fn = pickExport(mod, ["regenPreview"], "./src/regen.js");
      await fn({ appPath: app });
      return;
    }

    if (cmd === "regen:apply") {
      const app = requireFlag(flags, "app");
      const yes = hasFlag(flags, "yes");
      const overwriteModified = hasFlag(flags, "overwriteModified");

      const mod = await import("./src/regen.js");
      const fn = pickExport(mod, ["regenApply"], "./src/regen.js");
      await fn({ appPath: app, yes, overwriteModified });
      return;
    }

    throw new Error(`Unknown command: ${cmd}`);
  } catch (err) {
    console.error(`[error] ${err?.message || String(err)}`);
    process.exit(1);
  }
}

main();
