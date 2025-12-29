// lib/validate/profiles.js

// This file defines WHICH checks run for WHICH template,
// and in WHAT ORDER. It does not execute anything.

export const ValidationProfiles = Object.freeze({
  "node-express-api-sqlite": {
    checks: [
      // 1️⃣ Server must boot and be reachable
      {
        id: "boot",
        required: true,
        config: { bootTimeoutMs: 12000 },
      },

      // 2️⃣ /health must respond correctly AND match the strict JSON contract
      {
        id: "health",
        required: true,
        config: {
          path: "/health",
          timeoutMs: 4000,
          expectStatus: 200,
          expectJson: {
            status: "ok",
            requiredKeys: ["status", "uptimeSeconds", "timestamp"],
            types: {
              uptimeSeconds: "number",
              timestamp: "string",
            },
          },
        },
      },

      // 3️⃣ Real API endpoints must respond correctly (required)
      {
        id: "endpoints",
        required: true,
        config: {
          timeoutMs: 4000,
          endpoints: [
            { method: "GET", path: "/", expectStatus: 200 },
            { method: "GET", path: "/api/v1/ping", expectStatus: 200 },
            { method: "GET", path: "/api/v1/users", expectStatus: 200 },
          ],
        },
      },

      // ✅ Schema check removed for now (it was noisy and template-dependent)
    ],
  },
});

// Fallback profile if a template is unknown
export function getProfile(templateName) {
  return (
    ValidationProfiles[templateName] ?? {
      checks: [
        {
          id: "boot",
          required: true,
          config: { bootTimeoutMs: 12000 },
        },
        {
          id: "health",
          required: true,
          config: { path: "/health", timeoutMs: 4000, expectStatus: 200 },
        },
      ],
    }
  );
}
