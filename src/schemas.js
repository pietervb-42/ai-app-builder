// src/schemas.js
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

function isNullOrString(x) {
  return x === null || isString(x);
}

function isNullOrNumber(x) {
  return x === null || isNumber(x);
}

function push(issues, msg) {
  issues.push(String(msg));
}

function checkRequiredKey(obj, key, issues, path) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    push(issues, `missing key: ${path}${key}`);
    return false;
  }
  return true;
}

function checkType(predicate, value, issues, path, expected) {
  if (!predicate(value)) {
    push(issues, `expected ${expected} at: ${path}`);
    return false;
  }
  return true;
}

function checkValidateShape(v) {
  const issues = [];

  if (!isObject(v)) {
    return { ok: false, issues: ["expected object at: $"] };
  }

  // root keys
  if (checkRequiredKey(v, "ok", issues, "$.")) {
    checkType(isBoolean, v.ok, issues, "$.ok", "boolean");
  }

  if (checkRequiredKey(v, "template", issues, "$.")) {
    checkType(isString, v.template, issues, "$.template", "string");
  }

  if (checkRequiredKey(v, "profile", issues, "$.")) {
    checkType(isString, v.profile, issues, "$.profile", "string");
  }

  if (checkRequiredKey(v, "installMode", issues, "$.")) {
    checkType(isString, v.installMode, issues, "$.installMode", "string");
  }

  if (checkRequiredKey(v, "didInstall", issues, "$.")) {
    checkType(isBoolean, v.didInstall, issues, "$.didInstall", "boolean");
  }

  // manifestIntegrity
  if (checkRequiredKey(v, "manifestIntegrity", issues, "$.")) {
    const mi = v.manifestIntegrity;
    if (!isObject(mi)) {
      push(issues, "expected object at: $.manifestIntegrity");
    } else {
      if (checkRequiredKey(mi, "ok", issues, "$.manifestIntegrity.")) {
        checkType(isBoolean, mi.ok, issues, "$.manifestIntegrity.ok", "boolean");
      }
      if (checkRequiredKey(mi, "manifestPath", issues, "$.manifestIntegrity.")) {
        checkType(
          isString,
          mi.manifestPath,
          issues,
          "$.manifestIntegrity.manifestPath",
          "string"
        );
      }
      if (checkRequiredKey(mi, "expectedFingerprint", issues, "$.manifestIntegrity.")) {
        checkType(
          isNullOrString,
          mi.expectedFingerprint,
          issues,
          "$.manifestIntegrity.expectedFingerprint",
          "string|null"
        );
      }
      if (checkRequiredKey(mi, "currentFingerprint", issues, "$.manifestIntegrity.")) {
        checkType(
          isNullOrString,
          mi.currentFingerprint,
          issues,
          "$.manifestIntegrity.currentFingerprint",
          "string|null"
        );
      }

      // When ok === true, validate commonly-present "matches"
      if (mi.ok === true && Object.prototype.hasOwnProperty.call(mi, "matches")) {
        checkType(isBoolean, mi.matches, issues, "$.manifestIntegrity.matches", "boolean");
      }
    }
  }

  // validation object (minimum contract)
  let validationObj = null;
  if (checkRequiredKey(v, "validation", issues, "$.")) {
    const val = v.validation;
    validationObj = val;

    if (!isObject(val)) {
      push(issues, "expected object at: $.validation");
    } else {
      if (checkRequiredKey(val, "ok", issues, "$.validation.")) {
        checkType(isBoolean, val.ok, issues, "$.validation.ok", "boolean");
      }
      if (checkRequiredKey(val, "checks", issues, "$.validation.")) {
        if (!Array.isArray(val.checks)) {
          push(issues, "expected array at: $.validation.checks");
        }
      }
      if (checkRequiredKey(val, "failureClass", issues, "$.validation.")) {
        // failureClass is null when validation passes
        checkType(
          isNullOrString,
          val.failureClass,
          issues,
          "$.validation.failureClass",
          "string|null"
        );
      }
      if (checkRequiredKey(val, "startedAt", issues, "$.validation.")) {
        checkType(isString, val.startedAt, issues, "$.validation.startedAt", "string");
      }
      if (checkRequiredKey(val, "finishedAt", issues, "$.validation.")) {
        checkType(isString, val.finishedAt, issues, "$.validation.finishedAt", "string");
      }

      // validate commonly-present appPath INSIDE validation
      if (Object.prototype.hasOwnProperty.call(val, "appPath")) {
        checkType(isString, val.appPath, issues, "$.validation.appPath", "string");
      }
    }
  }

  // appPath contract:
  // Accept either $.appPath OR $.validation.appPath
  if (Object.prototype.hasOwnProperty.call(v, "appPath")) {
    checkType(isString, v.appPath, issues, "$.appPath", "string");
  } else {
    const nested = validationObj && isObject(validationObj) ? validationObj.appPath : undefined;
    if (typeof nested !== "string" || !nested) {
      push(issues, "missing key: $.appPath (or $.validation.appPath)");
    }
  }

  return { ok: issues.length === 0, issues };
}

function checkValidateAllShape(v) {
  const issues = [];

  if (!isObject(v)) return { ok: false, issues: ["expected object at: $"] };

  if (checkRequiredKey(v, "ok", issues, "$.")) checkType(isBoolean, v.ok, issues, "$.ok", "boolean");
  if (checkRequiredKey(v, "rootPath", issues, "$.")) checkType(isString, v.rootPath, issues, "$.rootPath", "string");
  if (checkRequiredKey(v, "startedAt", issues, "$.")) checkType(isString, v.startedAt, issues, "$.startedAt", "string");
  if (checkRequiredKey(v, "finishedAt", issues, "$.")) checkType(isString, v.finishedAt, issues, "$.finishedAt", "string");
  if (checkRequiredKey(v, "appsFound", issues, "$.")) checkType(isNumber, v.appsFound, issues, "$.appsFound", "number");
  if (checkRequiredKey(v, "installMode", issues, "$.")) checkType(isString, v.installMode, issues, "$.installMode", "string");

  if (checkRequiredKey(v, "results", issues, "$.")) {
    if (!Array.isArray(v.results)) {
      push(issues, "expected array at: $.results");
    } else {
      // Validate each result minimally as validate-shape
      for (let i = 0; i < v.results.length; i++) {
        const r = v.results[i];
        const sub = checkValidateShape(r);
        if (!sub.ok) {
          for (const msg of sub.issues) push(issues, `results[${i}]: ${msg}`);
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

function checkManifestRefreshAllShape(v) {
  const issues = [];
  if (!isObject(v)) return { ok: false, issues: ["expected object at: $"] };

  if (checkRequiredKey(v, "ok", issues, "$.")) checkType(isBoolean, v.ok, issues, "$.ok", "boolean");
  if (checkRequiredKey(v, "rootPath", issues, "$.")) checkType(isString, v.rootPath, issues, "$.rootPath", "string");
  if (checkRequiredKey(v, "startedAt", issues, "$.")) checkType(isString, v.startedAt, issues, "$.startedAt", "string");
  if (checkRequiredKey(v, "finishedAt", issues, "$.")) checkType(isString, v.finishedAt, issues, "$.finishedAt", "string");
  if (checkRequiredKey(v, "appsFound", issues, "$.")) checkType(isNumber, v.appsFound, issues, "$.appsFound", "number");
  if (checkRequiredKey(v, "okCount", issues, "$.")) checkType(isNumber, v.okCount, issues, "$.okCount", "number");
  if (checkRequiredKey(v, "failCount", issues, "$.")) checkType(isNumber, v.failCount, issues, "$.failCount", "number");
  if (checkRequiredKey(v, "apply", issues, "$.")) checkType(isBoolean, v.apply, issues, "$.apply", "boolean");

  if (checkRequiredKey(v, "include", issues, "$.")) {
    checkType(isNullOrString, v.include, issues, "$.include", "string|null");
  }
  if (checkRequiredKey(v, "max", issues, "$.")) {
    checkType(isNullOrNumber, v.max, issues, "$.max", "number|null");
  }

  if (checkRequiredKey(v, "results", issues, "$.")) {
    if (!Array.isArray(v.results)) {
      push(issues, "expected array at: $.results");
    } else {
      for (let i = 0; i < v.results.length; i++) {
        const r = v.results[i];
        const p = `$.results[${i}]`;
        if (!isObject(r)) {
          push(issues, `expected object at: ${p}`);
          continue;
        }
        if (checkRequiredKey(r, "appPath", issues, `${p}.`)) {
          checkType(isString, r.appPath, issues, `${p}.appPath`, "string");
        }
        if (checkRequiredKey(r, "ok", issues, `${p}.`)) {
          checkType(isBoolean, r.ok, issues, `${p}.ok`, "boolean");
        }
        if (!Object.prototype.hasOwnProperty.call(r, "result")) {
          push(issues, `missing key: ${p}.result`);
        }
        if (r.ok === false && !Object.prototype.hasOwnProperty.call(r, "error")) {
          push(issues, `missing key: ${p}.error`);
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

function checkReportCiShape(v) {
  const issues = [];
  if (!isObject(v)) return { ok: false, issues: ["expected object at: $"] };

  if (checkRequiredKey(v, "ok", issues, "$.")) checkType(isBoolean, v.ok, issues, "$.ok", "boolean");
  if (checkRequiredKey(v, "rootPath", issues, "$.")) checkType(isString, v.rootPath, issues, "$.rootPath", "string");
  if (checkRequiredKey(v, "startedAt", issues, "$.")) checkType(isString, v.startedAt, issues, "$.startedAt", "string");
  if (checkRequiredKey(v, "finishedAt", issues, "$.")) checkType(isString, v.finishedAt, issues, "$.finishedAt", "string");

  if (checkRequiredKey(v, "appsDiscovered", issues, "$.")) checkType(isNumber, v.appsDiscovered, issues, "$.appsDiscovered", "number");
  if (checkRequiredKey(v, "appsFound", issues, "$.")) checkType(isNumber, v.appsFound, issues, "$.appsFound", "number");

  if (checkRequiredKey(v, "passCount", issues, "$.")) checkType(isNumber, v.passCount, issues, "$.passCount", "number");
  if (checkRequiredKey(v, "warnCount", issues, "$.")) checkType(isNumber, v.warnCount, issues, "$.warnCount", "number");
  if (checkRequiredKey(v, "hardFailCount", issues, "$.")) checkType(isNumber, v.hardFailCount, issues, "$.hardFailCount", "number");

  if (checkRequiredKey(v, "installMode", issues, "$.")) {
    if (!(isString(v.installMode) || v.installMode === null)) {
      push(issues, "expected string|null at: $.installMode");
    }
  }

  if (checkRequiredKey(v, "include", issues, "$.")) checkType(isNullOrString, v.include, issues, "$.include", "string|null");
  if (checkRequiredKey(v, "max", issues, "$.")) checkType(isNullOrNumber, v.max, issues, "$.max", "number|null");
  if (checkRequiredKey(v, "profile", issues, "$.")) checkType(isNullOrString, v.profile, issues, "$.profile", "string|null");
  if (checkRequiredKey(v, "healManifest", issues, "$.")) checkType(isBoolean, v.healManifest, issues, "$.healManifest", "boolean");

  if (checkRequiredKey(v, "results", issues, "$.")) {
    if (!Array.isArray(v.results)) {
      push(issues, "expected array at: $.results");
    } else {
      for (let i = 0; i < v.results.length; i++) {
        const r = v.results[i];
        const p = `$.results[${i}]`;
        if (!isObject(r)) {
          push(issues, `expected object at: ${p}`);
          continue;
        }

        if (checkRequiredKey(r, "appPath", issues, `${p}.`)) {
          checkType(isString, r.appPath, issues, `${p}.appPath`, "string");
        }
        if (checkRequiredKey(r, "exitCode", issues, `${p}.`)) {
          checkType(isNumber, r.exitCode, issues, `${p}.exitCode`, "number");
        }

        if (checkRequiredKey(r, "validate", issues, `${p}.`)) {
          const vv = r.validate;
          if (!isObject(vv)) {
            push(issues, `expected object at: ${p}.validate`);
          } else {
            if (checkRequiredKey(vv, "ok", issues, `${p}.validate.`)) {
              checkType(isBoolean, vv.ok, issues, `${p}.validate.ok`, "boolean");
            }
            // validate.appPath can be either top-level or nested; we only require one via validate schema
          }
        }

        if (checkRequiredKey(r, "ci", issues, `${p}.`)) {
          const ci = r.ci;
          if (!isObject(ci)) {
            push(issues, `expected object at: ${p}.ci`);
          } else {
            if (checkRequiredKey(ci, "severity", issues, `${p}.ci.`)) {
              checkType(isString, ci.severity, issues, `${p}.ci.severity`, "string");
            }
            if (checkRequiredKey(ci, "hardFail", issues, `${p}.ci.`)) {
              checkType(isBoolean, ci.hardFail, issues, `${p}.ci.hardFail`, "boolean");
            }
            if (checkRequiredKey(ci, "warn", issues, `${p}.ci.`)) {
              checkType(isBoolean, ci.warn, issues, `${p}.ci.warn`, "boolean");
            }
            if (Object.prototype.hasOwnProperty.call(ci, "reason")) {
              if (!(ci.reason === null || isString(ci.reason))) {
                push(issues, `expected string|null at: ${p}.ci.reason`);
              }
            } else {
              push(issues, `missing key: ${p}.ci.reason`);
            }
          }
        }

        for (const k of ["healedManifest", "validateAfterHeal", "ciAfterHeal"]) {
          if (!Object.prototype.hasOwnProperty.call(r, k)) {
            push(issues, `missing key: ${p}.${k}`);
          } else {
            const val = r[k];
            if (!(val === null || isObject(val))) {
              push(issues, `expected object|null at: ${p}.${k}`);
            }
          }
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export const SCHEMA_CHECKERS = {
  validate: checkValidateShape,
  "validate:all": checkValidateAllShape,
  "report:ci": checkReportCiShape,
  "manifest:refresh:all": checkManifestRefreshAllShape,
};
