// src/plan-handoff.js
import fs from "fs";
import path from "path";

/**
 * Step 14: PLAN -> GENERATE handshake helpers
 * - load plan JSON from disk
 * - validate minimal schema deterministically
 * - select template deterministically from plan.decisions
 * - compute deterministic default out path if not provided
 *
 * Step 15: build pipeline support
 * - resolveFromPlanObject(plan, { out, templateOverride })
 */

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function safeString(x) {
  return typeof x === "string" ? x : String(x ?? "");
}

function slugify(s) {
  const raw = safeString(s).trim().toLowerCase();

  // Keep letters/numbers, convert other runs to single underscore.
  const slug = raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

  return slug || "app";
}

function validatePlanShape(plan) {
  if (!isObject(plan)) return { ok: false, error: "plan must be an object" };
  if (plan.ok !== true) return { ok: false, error: "plan.ok must be true" };
  if (typeof plan.goal !== "string") return { ok: false, error: "plan.goal must be a string" };
  if (!Array.isArray(plan.decisions)) return { ok: false, error: "plan.decisions must be an array" };
  return { ok: true };
}

function getDecisionValue(plan, key) {
  const arr = Array.isArray(plan?.decisions) ? plan.decisions : [];
  const hit = arr.find((d) => d && d.key === key);
  return hit ? String(hit.value ?? "") : "";
}

/**
 * Step 14: load plan from file path (sync, deterministic)
 */
export function loadPlanFromFile(planPath) {
  const abs = path.isAbsolute(planPath) ? planPath : path.resolve(process.cwd(), planPath);
  const raw = readUtf8(abs);
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in plan file: ${abs}`);
  }

  const v = validatePlanShape(plan);
  if (!v.ok) throw new Error(`Invalid plan schema: ${v.error}`);

  return { abs, plan };
}

/**
 * Step 14: select template based on plan decisions.
 * Locked to existing templates only.
 * Unknown combinations hard-fail unless --template is explicitly provided by caller.
 *
 * Returns: { template, notes[] }
 */
export function selectTemplateFromPlan(plan) {
  const v = validatePlanShape(plan);
  if (!v.ok) throw new Error(`Invalid plan schema: ${v.error}`);

  const backend = getDecisionValue(plan, "backend");
  const frontend = getDecisionValue(plan, "frontend");
  const database = getDecisionValue(plan, "database");

  const notes = [];

  // Supported mapping (current repo):
  // - node-express-api-sqlite only
  const canUseExpressSqlite =
    backend === "express" &&
    database === "sqlite" &&
    (frontend === "none" || frontend === "");

  if (canUseExpressSqlite) {
    notes.push("Selected template node-express-api-sqlite from plan decisions.");
    return { template: "node-express-api-sqlite", notes };
  }

  // Hard fail for unknown combo (Step 14 behavior)
  throw new Error(
    "Could not resolve a supported template from plan decisions. Provide --template explicitly."
  );
}

/**
 * Step 14: deterministic default out path derived from plan.goal
 * (relative path, resolved by generate.js rules)
 */
export function defaultOutPathFromPlan(plan) {
  const v = validatePlanShape(plan);
  if (!v.ok) throw new Error(`Invalid plan schema: ${v.error}`);

  const base = slugify(plan.goal);
  return path.join("outputs", base);
}

/**
 * Step 15: Resolve template + outPath from an in-memory plan object.
 * This is used by the `build` command pipeline.
 *
 * Returns:
 *  { ok:true, template, outPath }
 * or
 *  { ok:false, error:{ code, message, details? } }
 */
export function resolveFromPlanObject(plan, { out, templateOverride } = {}) {
  const v = validatePlanShape(plan);
  if (!v.ok) {
    return {
      ok: false,
      error: { code: "ERR_BAD_PLAN", message: `Invalid plan schema: ${v.error}` },
    };
  }

  // Template:
  // - if override provided, accept it (caller takes responsibility)
  // - else enforce locked mapping identical to selectTemplateFromPlan
  let template = safeString(templateOverride).trim();

  if (!template) {
    try {
      const selected = selectTemplateFromPlan(plan);
      template = selected.template;
    } catch (e) {
      const backend = getDecisionValue(plan, "backend");
      const frontend = getDecisionValue(plan, "frontend");
      const database = getDecisionValue(plan, "database");

      return {
        ok: false,
        error: {
          code: "ERR_TEMPLATE_UNRESOLVED",
          message:
            "Could not resolve a supported template from plan decisions. Provide --template explicitly.",
          details: {
            backend,
            frontend,
            database,
            supportedTemplates: ["node-express-api-sqlite"],
          },
        },
      };
    }
  }

  // Out path:
  // - if out provided, use it
  // - else deterministic default from goal
  let outPath = safeString(out).trim();
  if (!outPath) outPath = defaultOutPathFromPlan(plan);

  return { ok: true, template, outPath };
}
