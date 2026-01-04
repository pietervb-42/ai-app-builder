// src/ci-schemas.js
/**
 * Minimal, deterministic "schema" checks.
 * We avoid external deps to keep CI stable + reproducible.
 *
 * Each checker returns: { ok: boolean, issues: Array<{ path: string, message: string }> }
 */

function issue(path, message) {
  return { path, message };
}

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function isString(x) {
  return typeof x === "string";
}

function isBoolean(x) {
  return typeof x === "boolean";
}

function isNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function isArray(x) {
  return Array.isArray(x);
}

function isNull(x) {
  return x === null;
}

function isStringOrNull(x) {
  return isString(x) || isNull(x);
}

function requireField(obj, key, predicate, path, issues, typeLabel) {
  if (!isObject(obj)) {
    issues.push(issue(path, `Expected object`));
    return;
  }
  if (!(key in obj)) {
    issues.push(issue(`${path}.${key}`, `Missing required field`));
    return;
  }
  const v = obj[key];
  if (!predicate(v)) {
    issues.push(
      issue(
        `${path}.${key}`,
        `Invalid type/value. Expected ${typeLabel}, got ${Array.isArray(v) ? "array" : typeof v}`
      )
    );
  }
}

function optionalField(obj, key, predicate, path, issues, typeLabel) {
  if (!isObject(obj)) return;
  if (!(key in obj)) return;
  const v = obj[key];
  if (!predicate(v)) {
    issues.push(
      issue(
        `${path}.${key}`,
        `Invalid type/value. Expected ${typeLabel}, got ${Array.isArray(v) ? "array" : typeof v}`
      )
    );
  }
}

/**
 * requireEitherField:
 * Accept value at obj[keyA] OR at obj[keyB] (nested on obj[nestedKey][keyB] pattern is handled by callers).
 *
 * We keep this simple and explicit for determinism.
 */
function requireEitherStringField({
  obj,
  primaryKey,
  secondaryObj,
  secondaryKey,
  basePath,
  issues,
  label,
}) {
  if (!isObject(obj)) {
    issues.push(issue(basePath, `Expected object`));
    return;
  }

  const hasPrimary = primaryKey in obj && isString(obj[primaryKey]);
  const hasSecondary =
    isObject(secondaryObj) && secondaryKey in secondaryObj && isString(secondaryObj[secondaryKey]);

  if (hasPrimary || hasSecondary) return;

  // Determine most helpful “missing” path.
  const p1 = `${basePath}.${primaryKey}`;
  const p2 = secondaryObj ? `${basePath}.validation.${secondaryKey}` : `${basePath}.${secondaryKey}`;
  issues.push(issue(p1, `Missing required field (expected ${label} at ${primaryKey} or validation.${secondaryKey})`));
  // Also add a second issue so the user sees both possibilities clearly.
  issues.push(issue(p2, `Missing required field (expected ${label} at ${primaryKey} or validation.${secondaryKey})`));
}

export function checkValidate(json) {
  const issues = [];
  const p = "$";

  if (!isObject(json)) {
    return { ok: false, issues: [issue(p, "Expected object")] };
  }

  requireField(json, "ok", isBoolean, p, issues, "boolean");
  requireField(json, "template", isString, p, issues, "string");
  requireField(json, "profile", isString, p, issues, "string");
  requireField(json, "installMode", isString, p, issues, "string");
  requireField(json, "didInstall", isBoolean, p, issues, "boolean");

  // manifestIntegrity: object with ok boolean
  requireField(json, "manifestIntegrity", isObject, p, issues, "object");
  if (isObject(json.manifestIntegrity)) {
    requireField(json.manifestIntegrity, "ok", isBoolean, `${p}.manifestIntegrity`, issues, "boolean");
  }

  // validation: object with ok boolean + failureClass (string|null)
  requireField(json, "validation", isObject, p, issues, "object");
  if (isObject(json.validation)) {
    requireField(json.validation, "ok", isBoolean, `${p}.validation`, issues, "boolean");

    // failureClass can be null when ok=true
    requireField(
      json.validation,
      "failureClass",
      isStringOrNull,
      `${p}.validation`,
      issues,
      "string|null"
    );

    optionalField(json.validation, "checks", isArray, `${p}.validation`, issues, "array");
  }

  // appPath exists either top-level OR under validation.appPath
  requireEitherStringField({
    obj: json,
    primaryKey: "appPath",
    secondaryObj: isObject(json.validation) ? json.validation : null,
    secondaryKey: "appPath",
    basePath: p,
    issues,
    label: "string",
  });

  return { ok: issues.length === 0, issues };
}

export function checkValidateAll(json) {
  const issues = [];
  const p = "$";

  if (!isObject(json)) {
    return { ok: false, issues: [issue(p, "Expected object")] };
  }

  requireField(json, "ok", isBoolean, p, issues, "boolean");
  requireField(json, "rootPath", isString, p, issues, "string");
  requireField(json, "startedAt", isString, p, issues, "string");
  requireField(json, "finishedAt", isString, p, issues, "string");
  requireField(json, "appsFound", isNumber, p, issues, "number");
  requireField(json, "installMode", isString, p, issues, "string");
  requireField(json, "results", isArray, p, issues, "array");

  // results items: validate-shaped objects (loose)
  if (isArray(json.results)) {
    for (let i = 0; i < json.results.length; i++) {
      const item = json.results[i];
      const ip = `${p}.results[${i}]`;

      if (!isObject(item)) {
        issues.push(issue(ip, "Expected object"));
        continue;
      }

      requireField(item, "ok", isBoolean, ip, issues, "boolean");
      requireField(item, "template", isString, ip, issues, "string");
      requireField(item, "profile", isString, ip, issues, "string");
      requireField(item, "installMode", isString, ip, issues, "string");

      requireField(item, "validation", isObject, ip, issues, "object");
      if (isObject(item.validation)) {
        requireField(item.validation, "ok", isBoolean, `${ip}.validation`, issues, "boolean");

        // failureClass can be null when ok=true
        requireField(
          item.validation,
          "failureClass",
          isStringOrNull,
          `${ip}.validation`,
          issues,
          "string|null"
        );
      }

      // appPath exists either top-level OR under item.validation.appPath
      requireEitherStringField({
        obj: item,
        primaryKey: "appPath",
        secondaryObj: isObject(item.validation) ? item.validation : null,
        secondaryKey: "appPath",
        basePath: ip,
        issues,
        label: "string",
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function checkReportCi(json) {
  const issues = [];
  const p = "$";

  if (!isObject(json)) {
    return { ok: false, issues: [issue(p, "Expected object")] };
  }

  requireField(json, "ok", isBoolean, p, issues, "boolean");
  requireField(json, "rootPath", isString, p, issues, "string");
  requireField(json, "startedAt", isString, p, issues, "string");
  requireField(json, "finishedAt", isString, p, issues, "string");

  requireField(json, "passCount", isNumber, p, issues, "number");
  requireField(json, "warnCount", isNumber, p, issues, "number");
  requireField(json, "hardFailCount", isNumber, p, issues, "number");

  requireField(json, "results", isArray, p, issues, "array");

  if (isArray(json.results)) {
    for (let i = 0; i < json.results.length; i++) {
      const r = json.results[i];
      const rp = `${p}.results[${i}]`;
      if (!isObject(r)) {
        issues.push(issue(rp, "Expected object"));
        continue;
      }
      requireField(r, "appPath", isString, rp, issues, "string");
      requireField(r, "ci", isObject, rp, issues, "object");
      if (isObject(r.ci)) {
        requireField(r.ci, "severity", isString, `${rp}.ci`, issues, "string");
        requireField(r.ci, "hardFail", isBoolean, `${rp}.ci`, issues, "boolean");
        requireField(r.ci, "warn", isBoolean, `${rp}.ci`, issues, "boolean");
      }
      requireField(r, "validate", isObject, rp, issues, "object");
    }
  }

  return { ok: issues.length === 0, issues };
}

export function checkManifestRefreshAll(json) {
  const issues = [];
  const p = "$";

  if (!isObject(json)) {
    return { ok: false, issues: [issue(p, "Expected object")] };
  }

  requireField(json, "ok", isBoolean, p, issues, "boolean");
  requireField(json, "rootPath", isString, p, issues, "string");
  requireField(json, "startedAt", isString, p, issues, "string");
  requireField(json, "finishedAt", isString, p, issues, "string");

  requireField(json, "appsFound", isNumber, p, issues, "number");
  requireField(json, "okCount", isNumber, p, issues, "number");
  requireField(json, "failCount", isNumber, p, issues, "number");

  requireField(json, "apply", isBoolean, p, issues, "boolean");
  requireField(json, "results", isArray, p, issues, "array");

  return { ok: issues.length === 0, issues };
}

/**
 * Registry: map "cmd name" => checker
 * We keep names aligned to CLI commands.
 */
export const SCHEMA_CHECKERS = Object.freeze({
  validate: checkValidate,
  "validate:all": checkValidateAll,
  "report:ci": checkReportCi,
  "manifest:refresh:all": checkManifestRefreshAll,
});
