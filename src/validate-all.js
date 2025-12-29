// src/validate-all.js
import fs from "fs/promises";
import path from "path";
import { validateAppCore } from "./validate.js";
import { createOutput } from "./output.js";

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
  entries.sort((a, b) => a.name.localeCompare(b.name));

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

function normalizeInstallMode({ installMode, noInstall }) {
  // legacy wins
  if (noInstall) return "never";

  const envMode = process.env.INSTALL_MODE;
  if (envMode === "always" || envMode === "never" || envMode === "if-missing") {
    return envMode;
  }

  if (!installMode) return "always";

  const v = String(installMode).toLowerCase().trim();
  if (v === "always" || v === "never" || v === "if-missing") return v;

  return "always";
}

export async function validateAll({
  rootPath,
  json = false,
  quiet = false,
  noInstall = false, // legacy
  installMode, // NEW
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
    const needle = String(include).toLowerCase();
    appPaths = appPaths.filter((p) => p.toLowerCase().includes(needle));
  }

  if (Number.isFinite(max) && max > 0) {
    appPaths = appPaths.slice(0, max);
  }

  const startedAt = toIso();
  const results = [];
  let maxExitCode = 0;

  // Step 30/31 rules:
  // - json => stdout single JSON object only
  // - logs/progress => stderr only
  const effectiveQuiet = Boolean(quiet) || Boolean(json);
  const effectiveInstallMode = normalizeInstallMode({ installMode, noInstall });

  const out = createOutput({ json: Boolean(json), quiet: effectiveQuiet });

  for (let i = 0; i < appPaths.length; i++) {
    const appPath = appPaths[i];

    if (progress) {
      // Always stderr; respect quiet, but allow progress when requested.
      if (effectiveQuiet) {
        out.log(`[validate:all] ${i + 1}/${appPaths.length} ${appPath}`);
      } else {
        out.log(`[validate:all] ${i + 1}/${appPaths.length} ${appPath}`);
      }
    }

    try {
      const { result, exitCode } = await validateAppCore({
        appPath,
        quiet: effectiveQuiet,
        json: Boolean(json),
        noInstall,
        installMode: effectiveInstallMode,
        profile,
      });

      results.push(result);
      if (exitCode > maxExitCode) maxExitCode = exitCode;
    } catch (e) {
      const crash = {
        ok: false,
        appPath,
        template: "unknown",
        profile: profile || "unknown",
        installMode: effectiveInstallMode,
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
    installMode: effectiveInstallMode,
    results,
  };

  if (outPath) {
    await writeJsonFile(outPath, summary);
    if (!json && !quiet) {
      out.log(`[out] ${path.resolve(outPath)}`);
    }
  }

  if (json) {
    out.emitJson(summary);
  } else if (!quiet) {
    process.stdout.write("\nVALIDATE:ALL RESULT:\n");
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }

  process.exit(maxExitCode);
}
