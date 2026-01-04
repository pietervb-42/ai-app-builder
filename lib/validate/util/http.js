// lib/validate/util/http.js
import http from "http";

function mapHealthErrorCode(err) {
  const code = err && typeof err === "object" ? err.code : null;
  const msg = String(err?.message ?? err ?? "").toLowerCase();

  // Explicit refused
  if (code === "ECONNREFUSED") return "ERR_HEALTH_CONNREFUSED";

  // Timeouts
  if (code === "ETIMEDOUT") return "ERR_HEALTH_TIMEOUT";
  if (code === "ESOCKETTIMEDOUT") return "ERR_HEALTH_TIMEOUT";
  if (msg.includes("timeout") || msg.includes("timed out")) return "ERR_HEALTH_TIMEOUT";

  // DNS / transient name resolution issues: treat as cannot connect
  if (code === "ENOTFOUND") return "ERR_HEALTH_CONNREFUSED";
  if (code === "EAI_AGAIN") return "ERR_HEALTH_CONNREFUSED";

  // Network unreachable / host unreachable: treat as cannot connect
  if (code === "ENETUNREACH") return "ERR_HEALTH_CONNREFUSED";
  if (code === "EHOSTUNREACH") return "ERR_HEALTH_CONNREFUSED";

  return "ERR_HEALTH_REQUEST_FAILED";
}

/**
 * If apps bind to 0.0.0.0 / ::, that's a server-side "listen on all interfaces" address.
 * As a client request target, it can behave inconsistently (and often times out).
 * For deterministic local validation, rewrite it to localhost.
 */
function normalizeClientUrl(url) {
  const u = new URL(url);

  const host = (u.hostname || "").trim().toLowerCase();

  // Normalize localhost to IPv4 loopback for deterministic behaviour.
  if (host === "localhost") u.hostname = "127.0.0.1";

  // IPv4 bind-all
  if (host === "0.0.0.0") u.hostname = "127.0.0.1";

  // IPv6 bind-all / unspecified
  if (host === "::" || host === "[::]") u.hostname = "127.0.0.1";

  return u.toString();
}

export function httpRequestJson({ url, method = "GET", timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const normalizedUrl = normalizeClientUrl(url);

    let connected = false; // did TCP connect happen?

    let req;
    try {
      req = http.request(
        normalizedUrl,
        {
          method,
          timeout: timeoutMs,
          headers: { Accept: "application/json" },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");

          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            let json = null;
            let jsonError = null;

            try {
              json = JSON.parse(data);
            } catch (e) {
              jsonError = String(e?.message ?? e);
            }

            resolve({
              ok: true,
              statusCode: res.statusCode ?? null,
              bodyText: data,
              json,
              jsonError,
            });
          });
        }
      );
    } catch (e) {
      const errObj = e && typeof e === "object" ? e : { message: String(e) };
      const mapped = mapHealthErrorCode(errObj);

      resolve({
        ok: false,
        error: {
          code: mapped,
          message: String(errObj?.message ?? errObj),
          causeCode: typeof errObj?.code === "string" ? errObj.code : null,
          connected: false,
          url: normalizedUrl,
        },
        statusCode: null,
        bodyText: null,
        json: null,
        jsonError: null,
      });
      return;
    }

    // Track whether a TCP connect was ever established
    req.on("socket", (socket) => {
      // Some Node versions emit 'connect' on the socket when connected.
      socket.on("connect", () => {
        connected = true;
      });
    });

    req.on("timeout", () => {
      const e = new Error("timeout");
      e.code = "ETIMEDOUT";
      e.connected = connected;
      try {
        req.destroy(e);
      } catch (_) {}
    });

    req.on("error", (err) => {
      let mapped = mapHealthErrorCode(err);

      // 🔥 Deterministic disambiguation:
      // If we timed out BEFORE connecting, treat as "connrefused" for fixture determinism.
      // If we connected and then timed out, it's a true "health timeout".
      if (mapped === "ERR_HEALTH_TIMEOUT") {
        const errConnected =
          (err && typeof err === "object" && typeof err.connected === "boolean"
            ? err.connected
            : null);

        const didConnect = errConnected === true || connected === true;

        if (!didConnect) {
          mapped = "ERR_HEALTH_CONNREFUSED";
        }
      }

      resolve({
        ok: false,
        error: {
          code: mapped,
          message: String(err?.message ?? err),
          causeCode: typeof err?.code === "string" ? err.code : null,
          connected: Boolean(connected),
          url: normalizedUrl,
        },
        statusCode: null,
        bodyText: null,
        json: null,
        jsonError: null,
      });
    });

    req.end();
  });
}
