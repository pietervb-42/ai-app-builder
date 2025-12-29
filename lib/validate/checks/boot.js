// lib/validate/checks/boot.js
import { ValidationClass } from "../classes.js";
import { httpRequestJson } from "../util/http.js";
import { sleep } from "../util/time.js";

export async function checkBoot(ctx, cfg) {
  const started = Date.now();
  const bootTimeoutMs = cfg?.bootTimeoutMs ?? 12000;

  const baseUrl = ctx.baseUrl;
  if (!baseUrl) {
    return {
      id: "boot",
      required: true,
      ok: false,
      class: ValidationClass.BOOT_FAIL,
      details: { reason: "baseUrl_missing" },
    };
  }

  const probeUrl = new URL("/health", baseUrl).toString();
  let lastErr = null;

  while (Date.now() - started < bootTimeoutMs) {
    const res = await httpRequestJson({
      url: probeUrl,
      method: "GET",
      timeoutMs: 1200,
    });

    // If we got ANY HTTP response back, the server is reachable.
    // (Health correctness is checked in the next step.)
    if (res.ok && res.statusCode) {
      return {
        id: "boot",
        required: true,
        ok: true,
        class: null,
        details: { baseUrl, probeUrl, ms: Date.now() - started },
      };
    }

    lastErr = res.error ?? `status=${res.statusCode ?? "null"}`;
    await sleep(200);
  }

  return {
    id: "boot",
    required: true,
    ok: false,
    class: ValidationClass.BOOT_FAIL,
    details: { baseUrl, probeUrl, timeoutMs: bootTimeoutMs, lastErr },
  };
}
