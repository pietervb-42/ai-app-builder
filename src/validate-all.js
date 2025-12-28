import fs from "fs/promises";
import path from "path";
import { validateAppCore } from "./validate.js";

const MANIFEST_NAME = "builder.manifest.json";

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, found) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const e of entries) {
    if (!e.isDirectory()) continue;

    // skip big/noisy dirs
    if (e.name === "node_modules") continue;
    if (e.name === ".builder_snapshots") continue;

    const full = path.join(dir, e.name);

    // if directory contains manifest, treat it as an app root
    const manifestPath = path.join(full, MANIFEST_NAME);
    if (await pathExists(manifestPath)) {
      found.add(full);
      continue; // do not recurse into app folders
    }

    await walk(full, found);
  }
}

async function writeJsonFile(outPath, data) {
  const abs = path.resolve(outPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(data, null, 2), "utf8");
  return abs;
}

function toIso() {
  return new Date().toISOString();
}

export async function validateAll({
  rootPath,
  json = false,
  quiet = false,
  noInstall = false,     // legacy
  installMode,           // NEW
  outPath,
  profile,
  progress = false,
  max,
  include,
}) {
  const rootAbs = path.resolve(rootPath);

  const found = new Set();
  await walk(rootAbs, found);

  let appPaths = Array.from(found).sort((a, b) => a.localeCompare(b));

  if (include) {
    const needle = include.toLowerCase();
    appPaths = appPaths.filter((p) => p.toLowerCase().includes(needle));
  }

  if (Number.isFinite(max) && max > 0) {
    appPaths = appPaths.slice(0, max);
  }

  const startedAt = toIso();

  const results = [];
  let maxExitCode = 0;

  for (let i = 0; i < appPaths.length; i++) {
    const appPath = appPaths[i];

    if (progress) {
      // stderr so JSON stdout remains clean in --json mode
      console.error(`[validate:all] ${i + 1}/${appPaths.length} ${appPath}`);
    }

    try {
      const { result, exitCode } = await validateAppCore({
        appPath,
        quiet,
        noInstall,
        installMode,
        profile,
      });

      results.push(result);
      if (exitCode > maxExitCode) maxExitCode = exitCode;
    } catch (e) {
      // If ANY unexpected crash occurs, record it deterministically and continue
      const crash = {
        ok: false,
        appPath,
        template: "unknown",
        profile: profile || "unknown",
        installMode: installMode || (noInstall ? "never" : "always"),
        validation: {
          ok: false,
          template: "unknown",
          appPath,
          baseUrl: null,
          startedAt: toIso(),
          finishedAt: toIso(),
          durationMs: 0,
          checks: [
            {
              id: "validate_all_crash",
              required: true,
              ok: false,
              class: "UNKNOWN_FAIL",
              details: { error: String(e?.message ?? e) },
            },
          ],
          failureClass: "UNKNOWN_FAIL",
        },
      };

      results.push(crash);
      if (maxExitCode < 1) maxExitCode = 1;
    }
  }

  const finishedAt = toIso();

  const summary = {
    ok: maxExitCode === 0,
    rootPath: rootAbs,
    startedAt,
    finishedAt,
    appsFound: appPaths.length,
    installMode: installMode || (noInstall ? "never" : "always"),
    results,
  };

  if (outPath) {
    await writeJsonFile(outPath, summary);
  }

  if (json) {
    console.log(JSON.stringify(summary));
  } else {
    console.log("");
    console.log("VALIDATE:ALL RESULT:");
    console.log(JSON.stringify(summary, null, 2));
    if (outPath) console.log(`[out] ${path.resolve(outPath)}`);
  }

  process.exit(maxExitCode);
}
