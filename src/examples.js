// src/examples.js

function isTrueish(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "on";
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Deterministic example catalog.
 * - No timestamps
 * - No machine-specific absolute paths
 * - Safe copy/paste commands only
 */
function getExamplesCatalog() {
  const examples = [
    {
      id: "plan-json",
      title: "Create a deterministic plan (JSON)",
      cmd: `node index.js plan --prompt "create an express api with sqlite users table" --json`,
      notes: ["Plan output is deterministic (no timestamps/randomness)."],
    },
    {
      id: "build-json",
      title: "Build an app into outputs/ (JSON)",
      cmd: `node index.js build --prompt "create an express api with sqlite users table" --out .\\outputs\\my_app --json`,
      notes: [
        "Use --install-mode if you want to force install behavior.",
        "Use --write-policy to control overwrite behavior.",
      ],
    },
    {
      id: "validate-app-json",
      title: "Validate a single app (JSON)",
      cmd: `node index.js validate --app .\\outputs\\my_app --json`,
      notes: ["Use --no-install to skip installs during validation."],
    },
    {
      id: "validate-all-json",
      title: "Validate all apps in outputs/ (JSON)",
      cmd: `node index.js validate:all --root .\\outputs --json`,
      notes: ["Use --include and --max to limit the set."],
    },
    {
      id: "roadmap-verify-json",
      title: "Verify roadmap status lines match checkboxes (JSON)",
      cmd: `node index.js roadmap:verify --json`,
      notes: ["Strict verify fails CI if roadmap metadata is inconsistent."],
    },
    {
      id: "errors-list-json",
      title: "List stable error/exit code catalog (JSON)",
      cmd: `node index.js errors:list --json`,
      notes: ["Use this to keep docs and CI error policy aligned."],
    },
    {
      id: "ci-check-json",
      title: "Run CI gate (roadmap + schema + contracts) (JSON)",
      cmd: `node index.js ci:check --ci --root .\\outputs --json`,
      notes: ["--ci implies --json --quiet and keeps output CI-friendly."],
    },
  ];

  const notes = [
    "All examples are deterministic strings and safe for CI copy/paste.",
    "Windows paths use .\\outputs\\... on purpose (this repo is Windows-first).",
    "In --json mode, stdout is exactly ONE JSON object per command.",
  ];

  return { examples, notes };
}

/**
 * Command: examples:list
 * Flags:
 *  --json          Output one JSON object (recommended)
 *  --help          Human help text (or JSON help if --json)
 */
export async function examplesListCommand({ flags }) {
  const json = hasOwn(flags, "json") ? Boolean(flags.json) : false;
  const wantsHelp = hasOwn(flags, "help") || hasOwn(flags, "h");

  const catalog = getExamplesCatalog();

  if (wantsHelp) {
    const helpText = [
      "Usage:",
      "  node index.js examples:list [--json]",
      "",
      "Description:",
      "  Prints a deterministic, copy/paste example command catalog.",
      "",
      "Flags:",
      "  --json    Emit ONE JSON object to stdout",
      "  --help    Show this help",
      "",
    ].join("\n");

    if (json) {
      writeJson({ ok: true, cmd: "examples:list", help: true, usage: helpText, ...catalog });
    } else {
      process.stdout.write(helpText);
    }
    return 0;
  }

  if (json) {
    writeJson({ ok: true, cmd: "examples:list", ...catalog });
    return 0;
  }

  // Human output (still deterministic)
  process.stdout.write("Examples (copy/paste):\n\n");
  for (const e of catalog.examples) {
    process.stdout.write(`- ${e.title}\n  ${e.cmd}\n`);
    if (Array.isArray(e.notes) && e.notes.length) {
      for (const n of e.notes) process.stdout.write(`  # ${n}\n`);
    }
    process.stdout.write("\n");
  }

  process.stdout.write("Notes:\n");
  for (const n of catalog.notes) process.stdout.write(`- ${n}\n`);
  process.stdout.write("\n");

  return 0;
}
