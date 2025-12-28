#!/usr/bin/env node
import process from "process";

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

function printUsage() {
  console.log(
    `
ai-app-builder CLI

Commands:
  templates:list
  generate --template <name> --out <path>

  validate --app <path> [--quiet] [--json] [--no-install] [--install-mode <always|never|if-missing>] [--out <file>] [--profile <name>]
  validate:all --root <path> [--quiet] [--json] [--no-install] [--install-mode <always|never|if-missing>] [--out <file>] [--profile <name>] [--progress] [--max <n>] [--include <text>]

  manifest:refresh --app <path> [--apply] [--templateDir <path>]
  manifest:init --app <path> --yes --templateDir <path> [--template <name>]
  drift:report --app <path> [--diff]
  regen:preview --app <path>
  regen:apply --app <path> --yes [--overwriteModified]

Flags:
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
      const template = requireFlag(flags, "template");
      const out = requireFlag(flags, "out");

      const mod = await import("./src/generate.js");
      const fn = pickExport(mod, ["generateApp", "generate"], "./src/generate.js");
      await fn({ template, outPath: out });
      return;
    }

    if (cmd === "validate") {
      const app = requireFlag(flags, "app");
      const json = hasFlag(flags, "json");
      const quiet = hasFlag(flags, "quiet");
      const noInstall = hasFlag(flags, "no-install");
      const out = flags.out;
      const profile = flags.profile;

      // ✅ NEW: install-mode comes from parsed flags (no "args" needed)
      const installMode = normalizeInstallMode(flags["install-mode"]);

      const mod = await import("./src/validate.js");
      const fn = pickExport(mod, ["validateApp", "validate"], "./src/validate.js");

      await fn({
        appPath: app,
        json,
        quiet,
        noInstall,
        installMode, // ✅ pass through
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

      // ✅ NEW: install-mode comes from parsed flags
      const installMode = normalizeInstallMode(flags["install-mode"]);

      const mod = await import("./src/validate-all.js");
      const fn = pickExport(mod, ["validateAll"], "./src/validate-all.js");

      await fn({
        rootPath: root,
        json,
        quiet,
        noInstall,
        installMode, // ✅ pass through
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
      const template = flags.template; // optional

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
