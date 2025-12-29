// lib/validate/run.js
import { nowIso } from "./util/time.js";
import { ValidationClass } from "./classes.js";
import { getProfile } from "./profiles.js";

import { checkBoot } from "./checks/boot.js";
import { checkHealth } from "./checks/health.js";
import { checkEndpoints } from "./checks/endpoints.js";
import { checkSchemaSqlite } from "./checks/schema-sqlite.js";

// Map check IDs to functions
const CHECKS = Object.freeze({
  boot: checkBoot,
  health: checkHealth,
  endpoints: checkEndpoints,
  schema: checkSchemaSqlite,
});

export async function runValidationContract({ template, appPath, baseUrl }) {
  const startedAt = nowIso();
  const t0 = Date.now();

  const profile = getProfile(template);
  const checksOut = [];

  // Run checks in order defined by profile
  for (const item of profile.checks) {
    const id = item.id;
    const required = !!item.required;
    const fn = CHECKS[id];

    // If profile references an unknown check ID
    if (!fn) {
      const res = {
        id,
        required,
        ok: !required,
        class: required ? ValidationClass.UNKNOWN_FAIL : null,
        details: { reason: "unknown_check_id" },
      };
      checksOut.push(res);

      // Deterministic stop rule: first required failure stops further checks
      if (required) break;
      continue;
    }

    const ctx = { template, appPath, baseUrl, required };
    const res = await fn(ctx, item.config);

    // Force required flag (so checks can’t change it)
    res.required = required;

    checksOut.push(res);

    // Deterministic stop rule: stop on first REQUIRED failure
    if (required && !res.ok) break;
  }

  // failureClass = first failed REQUIRED check
  const firstFailed = checksOut.find((c) => c.required && !c.ok);
  const failureClass = firstFailed ? firstFailed.class : null;

  return {
    ok: !firstFailed,
    template,
    appPath,
    baseUrl,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - t0,
    checks: checksOut,
    failureClass,
  };
}
