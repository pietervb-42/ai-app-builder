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

export function checkValidate(json) {
  const issues = [];
  const p = "$";

  if (!isObject(json)) {
    return { ok: false, issues: [issue(p, "Expected object")] };
  }

  requireField(json, "ok", isBoolean, p, issues, "boolean");
  requireField(json, "appPath", isString, p, issues, "string");
  requireField(json, "template", isString, p, issues, "string");
  requireField(json, "profile", isString, p, issues, "string");
  requireField(json, "installMode", isString, p, issues, "string");
  requireField(json, "didInstall", isBoolean, p, issues, "boolean");

  // manifestIntegrity: object with ok boolean
  requireField(json, "manifestIntegrity", isObject, p, issues, "object");
  if (isObject(json.manifestIntegrity)) {
    requireField(json.manifestIntegrity, "ok", isBoolean, `${p}.manifestIntegrity`, issues, "boolean");
  }

  // validation: object with ok boolean + failureClass string
  requireField(json, "validation", isObject, p, issues, "object");
  if (isObject(json.validation)) {
    requireField(json.validation, "ok", isBoolean, `${p}.validation`, issues, "boolean");
    requireField(json.validation, "failureClass", isString, `${p}.validation`, issues, "string");
    optionalField(json.validation, "checks", isArray, `${p}.validation`, issues, "array");
  }

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
      if (!isObject(item)) {
        issues.push(issue(`${p}.results[${i}]`, "Expected object"));
        continue;
      }
      requireField(item, "ok", isBoolean, `${p}.results[${i}]`, issues, "boolean");
      requireField(item, "appPath", isString, `${p}.results[${i}]`, issues, "string");
      requireField(item, "template", isString, `${p}.results[${i}]`, issues, "string");
      requireField(item, "profile", isString, `${p}.results[${i}]`, issues, "string");
      requireField(item, "installMode", isString, `${p}.results[${i}]`, issues, "string");
      requireField(item, "validation", isObject, `${p}.results[${i}]`, issues, "object");
      if (isObject(item.validation)) {
        requireField(item.validation, "ok", isBoolean, `${p}.results[${i}].validation`, issues, "boolean");
        requireField(item.validation, "failureClass", isString, `${p}.results[${i}].validation`, issues, "string");
      }
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
