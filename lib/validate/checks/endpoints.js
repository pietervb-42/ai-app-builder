// lib/validate/checks/endpoints.js
import { ValidationClass } from "../classes.js";
import { httpRequestJson } from "../util/http.js";

export async function checkEndpoints(ctx, cfg) {
  const baseUrl = ctx.baseUrl;
  const timeoutMs = cfg?.timeoutMs ?? 4000;
  const endpoints = cfg?.endpoints ?? [];

  const failures = [];

  for (const ep of endpoints) {
    const method = ep.method ?? "GET";
    const url = new URL(ep.path, baseUrl).toString();

    const res = await httpRequestJson({ url, method, timeoutMs });

    if (!res.ok) {
      failures.push({
        method,
        path: ep.path,
        url,
        error: res.error,
      });
      continue;
    }

    const expectStatus = ep.expectStatus ?? 200;
    if (res.statusCode !== expectStatus) {
      failures.push({
        method,
        path: ep.path,
        url,
        statusCode: res.statusCode,
        expectStatus,
        bodySnippet: (res.bodyText ?? "").slice(0, 200),
      });
    }
  }

  if (failures.length > 0) {
    return {
      id: "endpoints",
      required: !!ctx.required,
      ok: false,
      class: ValidationClass.ENDPOINT_FAIL,
      details: { failures },
    };
  }

  return {
    id: "endpoints",
    required: !!ctx.required,
    ok: true,
    class: null,
    details: {
      checked: endpoints.map((e) => ({
        method: e.method ?? "GET",
        path: e.path,
      })),
    },
  };
}
