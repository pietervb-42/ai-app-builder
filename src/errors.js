// src/errors.js

/**
 * Error categories we care about right now (keep it simple + deterministic).
 */
export const ErrorCategory = Object.freeze({
  INSTALL_FAILED: "INSTALL_FAILED",
  START_FAILED: "START_FAILED",
  HEALTH_TIMEOUT: "HEALTH_TIMEOUT",
  HEALTH_BAD_STATUS: "HEALTH_BAD_STATUS",
  MISSING_PACKAGE_JSON: "MISSING_PACKAGE_JSON",
  UNKNOWN: "UNKNOWN",
});

/**
 * Classify errors coming from validateApp.
 * Input: { phase, error, logs }
 */
export function classifyValidateError({ phase, error, logs }) {
  const msg = String(error?.message || error || "");
  const l = String(logs || "");

  if (msg.includes("No package.json found")) {
    return { category: ErrorCategory.MISSING_PACKAGE_JSON, reason: msg };
  }

  if (phase === "install") {
    return { category: ErrorCategory.INSTALL_FAILED, reason: msg };
  }

  // start/boot-related
  if (phase === "start") {
    return { category: ErrorCategory.START_FAILED, reason: msg };
  }

  if (phase === "health") {
    if (msg.includes("timed out")) {
      return { category: ErrorCategory.HEALTH_TIMEOUT, reason: msg };
    }
    if (msg.includes("bad status")) {
      return { category: ErrorCategory.HEALTH_BAD_STATUS, reason: msg };
    }
  }

  // Heuristic: if logs show common port-in-use
  if (/EADDRINUSE/i.test(msg) || /EADDRINUSE/i.test(l)) {
    return {
      category: ErrorCategory.START_FAILED,
      reason: "Port already in use (EADDRINUSE).",
    };
  }

  return { category: ErrorCategory.UNKNOWN, reason: msg || "Unknown error" };
}

/**
 * Given a category, return safe auto-fix actions.
 * These are intentionally conservative.
 */
export function getAutoFixPlan(category) {
  switch (category) {
    case ErrorCategory.INSTALL_FAILED:
      return [
        { action: "DELETE_NODE_MODULES", safe: true },
        { action: "DELETE_PACKAGE_LOCK", safe: true },
        { action: "NPM_INSTALL", safe: true },
      ];

    case ErrorCategory.START_FAILED:
      return [
        // For now, safest fix is: retry with a different random port (done by validate loop)
        { action: "RETRY_WITH_NEW_PORT", safe: true },
      ];

    case ErrorCategory.HEALTH_TIMEOUT:
      return [
        // Sometimes server boots slow; give it more time (small bump)
        { action: "INCREASE_BOOT_TIMEOUT", safe: true, byMs: 10000 },
        { action: "RETRY_START", safe: true },
      ];

    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/* Step 38: Release-ready CLI UX — errors:list catalog (deterministic) */
/* ------------------------------------------------------------------ */

function hasFlag(flags, name) {
  return Boolean(flags && flags[name]);
}

function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function formatTextCatalog(catalog) {
  const lines = [];
  lines.push("AI App Builder — Error / Exit Codes Catalog");
  lines.push("");

  lines.push("Exit Codes (common):");
  for (const e of catalog.exitCodesCommon) lines.push(`  ${e.code}: ${e.meaning}`);
  lines.push("");

  lines.push("Command Exit Codes (explicit in current implementation):");
  for (const c of catalog.commandExitCodes) {
    lines.push(`- ${c.cmd}`);
    for (const r of c.rules) lines.push(`    ${r.code}: ${r.meaning}`);
  }
  lines.push("");

  lines.push("Validate Error Categories:");
  for (const e of catalog.validateErrorCategories) {
    lines.push(`  ${e.key}: ${e.meaning}`);
  }
  lines.push("");

  lines.push("Notes:");
  for (const n of catalog.notes) lines.push(`  - ${n}`);

  return lines.join("\n") + "\n";
}

function buildCatalog() {
  // IMPORTANT: deterministic ordering. No timestamps. No environment-based values.
  const validateErrorCategories = [
    { key: ErrorCategory.MISSING_PACKAGE_JSON, meaning: "No package.json present in app" },
    { key: ErrorCategory.INSTALL_FAILED, meaning: "Dependency install phase failed" },
    { key: ErrorCategory.START_FAILED, meaning: "App start/boot phase failed (includes EADDRINUSE heuristic)" },
    { key: ErrorCategory.HEALTH_TIMEOUT, meaning: "Health check timed out" },
    { key: ErrorCategory.HEALTH_BAD_STATUS, meaning: "Health endpoint returned non-OK status" },
    { key: ErrorCategory.UNKNOWN, meaning: "Unclassified/unknown failure" },
  ];

  return {
    ok: true,
    cmd: "errors:list",
    scope: "catalog",
    exitCodesCommon: [
      { code: 0, meaning: "Success" },
      { code: 1, meaning: "Gate failed / verification failed / dry-run changes required" },
      { code: 2, meaning: "Input error or runner/runtime error" },
      { code: 3, meaning: "Not found (used by roadmap when file missing)" },
    ],
    commandExitCodes: [
      {
        cmd: "roadmap:verify",
        rules: [
          { code: 0, meaning: "Verify passed" },
          { code: 1, meaning: "Verify failed (strict mode issues)" },
          { code: 3, meaning: "Roadmap file not found" },
        ],
      },
      {
        cmd: "roadmap:auto",
        rules: [
          { code: 0, meaning: "No changes needed OR apply=true succeeded" },
          { code: 1, meaning: "Dry-run detected changes needed (apply=false, changed=true)" },
          { code: 3, meaning: "Roadmap file not found" },
        ],
      },
      {
        cmd: "roadmap:update",
        rules: [
          { code: 0, meaning: "Step updated successfully" },
          { code: 2, meaning: "Bad input / step not found" },
          { code: 3, meaning: "Roadmap file not found" },
        ],
      },
      {
        cmd: "ci:check",
        rules: [
          { code: 0, meaning: "All gates passed (roadmap + schema + contracts)" },
          { code: 1, meaning: "Gate failed" },
          { code: 2, meaning: "Runner/input failure inside ci:check" },
        ],
      },
    ],
    validateErrorCategories,
    notes: [
      "This command is deterministic and safe for CI (one JSON object to stdout with --json).",
      "validate error categories are used by classifyValidateError() to group failures into stable buckets.",
      "Other commands may define additional exit codes; add them here as they become stable policy.",
    ],
  };
}

/**
 * CLI handler for: node index.js errors:list [--json]
 * - --json: emits ONE JSON object to stdout, exit 0
 * - no --json: prints a human-readable catalog, exit 0
 */
export async function errorsListCommand({ flags }) {
  const json = hasFlag(flags, "json") || hasFlag(flags, "ci");
  const catalog = buildCatalog();

  if (json) {
    writeJson(catalog);
    return 0;
  }

  process.stdout.write(formatTextCatalog(catalog));
  return 0;
}
