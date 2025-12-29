// lib/validate/run.js
import { nowIso } from "./util/time.js";
import { ValidationClass } from "./classes.js";
import { getProfile } from "./profiles.js";

import { checkBoot } from "./checks/boot.js";
import { checkHealth } from "./checks/health.js";
import { checkEndpoints } from "./checks/endpoints.js";
import { checkSchemaSqlite } from "./checks/schema-sqlite.js";

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

  for (const item of profile.checks) {
    const id = item.id;
    const required = !!item.required;
    const fn = CHECKS[id];

    if (!fn) {
      const res = {
        id,
        required,
        ok: !required,
        class: required ? ValidationClass.UNKNOWN_FAIL : null,
        details: { reason: "unknown_check_id" },
      };
      checksOut.push(res);
      if (required) break;
      continue;
    }

    const ctx = { template, appPath, baseUrl, required };
    const res = await fn(ctx, item.config);
    res.required = required;

    checksOut.push(res);
    if (required && !res.ok) break;
  }

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
