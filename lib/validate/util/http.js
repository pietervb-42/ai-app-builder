// lib/validate/util/http.js
import http from "http";

export function httpRequestJson({ url, method = "GET", timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const req = http.request(
      url,
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

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });

    req.on("error", (err) => {
      resolve({
        ok: false,
        error: String(err?.message ?? err),
        statusCode: null,
        bodyText: null,
        json: null,
        jsonError: null,
      });
    });

    req.end();
  });
}
