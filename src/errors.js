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
