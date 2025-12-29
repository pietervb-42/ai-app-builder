// src/contract-check.js
import path from "path";
import {
  normalizeForContract,
  loadJsonFromFile,
  loadJsonFromStdin,
  readSnapshotFile,
  writeSnapshotFile,
  compareNormalized,
} from "./contract-utils.js";

/**
 * Commands:
 * - contract:check  => compare provided JSON vs snapshot
 * - contract:update => write snapshot from provided JSON
 *
 * Flags (shared):
 *   --cmd <validate|validate:all|report:ci|manifest:refresh:all>
 *   --file <path> OR --stdin true
 *   --contracts-dir <path> (default: ci/contracts)
 *   --json
 *   --quiet
 *
 * Exit codes:
 *   0 ok
 *   1 mismatch (check only)
 *   2 input/parse/snapshot error
 */

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

function emit({ json, quiet }, obj, humanLine) {
  if (json) {
    process.stdout.write(JSON.stringify(obj) + "\n");
    return;
  }
  if (!quiet && humanLine) process.stdout.write(String(humanLine) + "\n");
}

function log({ quiet }, line) {
  if (quiet) return;
  process.stderr.write(String(line) + "\n");
}

function snapshotPathFor({ contractsDir, cmd }) {
  const dirAbs = path.isAbsolute(contractsDir)
    ? contractsDir
    : path.resolve(process.cwd(), contractsDir);

  // Map command name to stable filename
  const file = String(cmd).replace(/[:/\\]/g, "-") + ".json";
  return path.join(dirAbs, file);
}

function loadInputJson({ flags }) {
  const file = flags.file ? String(flags.file) : "";
  const stdin = isTrueish(flags.stdin);

  if (!file && !stdin) {
    throw new Error("Provide input via --file <path> OR --stdin true");
  }
  if (file && stdin) {
    throw new Error("Provide only one input source: --file OR --stdin");
  }

  if (file) {
    const { abs, value } = loadJsonFromFile(file);
    return { source: { kind: "file", path: abs }, value };
  }

  const { value } = loadJsonFromStdin();
  return { source: { kind: "stdin" }, value };
}

export async function contractCheck({ flags }) {
  const cmd = requireFlag(flags, "cmd");
  const json = hasFlag(flags, "json");
  const quiet = hasFlag(flags, "quiet") || Boolean(json);

  const contractsDir = flags["contracts-dir"]
    ? String(flags["contracts-dir"])
    : "ci/contracts";

  try {
    const { source, value: inputJson } = loadInputJson({ flags });

    const expectedPath = snapshotPathFor({ contractsDir, cmd });
    const expected = readSnapshotFile(expectedPath);

    const normalizedActual = normalizeForContract(cmd, inputJson);
    const normalizedExpected = expected.value;

    const cmp = compareNormalized(normalizedExpected, normalizedActual);

    if (cmp.ok) {
      emit(
        { json, quiet },
        {
          ok: true,
          cmd,
          contractsDir: path.resolve(contractsDir),
          snapshot: expected.abs,
          input: source,
          match: true,
        },
        `contract:check OK (${cmd})`
      );
      process.exit(0);
    }

    // mismatch
    log({ quiet }, `[contract:check] MISMATCH for ${cmd}`);
    log({ quiet }, `[contract:check] snapshot: ${expected.abs}`);
    if (source.kind === "file") log({ quiet }, `[contract:check] input: ${source.path}`);
    log({ quiet }, `[contract:check] summary: ${JSON.stringify(cmp.summary)}`);

    emit(
      { json, quiet },
      {
        ok: false,
        cmd,
        contractsDir: path.resolve(contractsDir),
        snapshot: expected.abs,
        input: source,
        match: false,
        diffSummary: cmp.summary,
      },
      `contract:check FAIL (${cmd})`
    );
    process.exit(1);
  } catch (e) {
    const msg = String(e?.message ?? e);
    log({ quiet }, `[contract:check] ERROR: ${msg}`);

    emit(
      { json, quiet },
      {
        ok: false,
        cmd: flags.cmd || null,
        error: { code: "ERR_CONTRACT_CHECK", message: msg },
      },
      `contract:check ERROR`
    );
    process.exit(2);
  }
}

export async function contractUpdate({ flags }) {
  const cmd = requireFlag(flags, "cmd");
  const json = hasFlag(flags, "json");
  const quiet = hasFlag(flags, "quiet") || Boolean(json);

  const contractsDir = flags["contracts-dir"]
    ? String(flags["contracts-dir"])
    : "ci/contracts";

  try {
    const { source, value: inputJson } = loadInputJson({ flags });

    const outPath = snapshotPathFor({ contractsDir, cmd });
    const normalized = normalizeForContract(cmd, inputJson);

    writeSnapshotFile(outPath, normalized);

    log({ quiet }, `[contract:update] WROTE ${outPath}`);

    emit(
      { json, quiet },
      {
        ok: true,
        cmd,
        contractsDir: path.resolve(contractsDir),
        snapshot: path.resolve(outPath),
        input: source,
        updated: true,
      },
      `contract:update OK (${cmd})`
    );
    process.exit(0);
  } catch (e) {
    const msg = String(e?.message ?? e);
    log({ quiet }, `[contract:update] ERROR: ${msg}`);

    emit(
      { json, quiet },
      {
        ok: false,
        cmd: flags.cmd || null,
        error: { code: "ERR_CONTRACT_UPDATE", message: msg },
      },
      `contract:update ERROR`
    );
    process.exit(2);
  }
}
