// lib/validate/checks/health.js
import { ValidationClass } from "../classes.js";
import { httpRequestJson } from "../util/http.js";

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export async function checkHealth(ctx, cfg) {
  const baseUrl = ctx.baseUrl;
  const path = cfg?.path ?? "/health";
  const timeoutMs = cfg?.timeoutMs ?? 4000;
  const expectStatus = cfg?.expectStatus ?? 200;

  const url = new URL(path, baseUrl).toString();
  const res = await httpRequestJson({ url, method: "GET", timeoutMs });

  // Could not connect / request failed
  if (!res.ok) {
    return {
      id: "health",
      required: true,
      ok: false,
      class: ValidationClass.HEALTH_FAIL,
      details: { url, error: res.error },
    };
  }

  // Wrong HTTP status code
  if (res.statusCode !== expectStatus) {
    return {
      id: "health",
      required: true,
      ok: false,
      class: ValidationClass.HEALTH_FAIL,
      details: {
        url,
        statusCode: res.statusCode,
        expectStatus,
        bodySnippet: (res.bodyText ?? "").slice(0, 200),
      },
    };
  }

  // If profile wants strict JSON validation, enforce it
  const expectJson = cfg?.expectJson;
  if (expectJson) {
    if (!res.json) {
      return {
        id: "health",
        required: true,
        ok: false,
        class: ValidationClass.HEALTH_FAIL,
        details: {
          url,
          reason: "invalid_json",
          jsonError: res.jsonError,
          bodySnippet: (res.bodyText ?? "").slice(0, 200),
        },
      };
    }

    // Validate json.status == "ok"
    if (expectJson.status && res.json.status !== expectJson.status) {
      return {
        id: "health",
        required: true,
        ok: false,
        class: ValidationClass.HEALTH_FAIL,
        details: {
          url,
          reason: "status_field_mismatch",
          got: res.json.status,
          expect: expectJson.status,
        },
      };
    }

    // Validate required keys exist
    for (const key of expectJson.requiredKeys ?? []) {
      if (!(key in res.json)) {
        return {
          id: "health",
          required: true,
          ok: false,
          class: ValidationClass.HEALTH_FAIL,
          details: { url, reason: "missing_key", key },
        };
      }
    }

    // Validate types of keys
    const types = expectJson.types ?? {};
    for (const [key, t] of Object.entries(types)) {
      if (key in res.json && typeOf(res.json[key]) !== t) {
        return {
          id: "health",
          required: true,
          ok: false,
          class: ValidationClass.HEALTH_FAIL,
          details: {
            url,
            reason: "type_mismatch",
            key,
            expect: t,
            got: typeOf(res.json[key]),
          },
        };
      }
    }
  }

  // All good
  return {
    id: "health",
    required: true,
    ok: true,
    class: null,
    details: { url, statusCode: res.statusCode },
  };
}
