import fs from "fs/promises";
import path from "path";

/* ------------------------- helpers ------------------------- */

function safeInt(v) {
  if (v == null) return null;
  const m = String(v).match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function isTrueish(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).toLowerCase().trim();
  return ["true", "1", "yes", "y", "on"].includes(s);
}

function normalizeFileFlag(flags) {
  const v = flags.file;
  if (!v || v === true) return "ai/roadmap-45.md";
  return String(v);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/* ------------------ encoding + normalization ------------------ */

function stripUtf8Bom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

async function readTextFileSmart(filePath) {
  const buf = await fs.readFile(filePath);

  // Keep simple + deterministic:
  // your roadmap is being read as UTF-8 already (confirmed)
  let text = buf.toString("utf8");

  text = stripUtf8Bom(text);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  return { text, encoding: "utf8" };
}

/**
 * Normalize escaped markdown:
 * \-  -> -
 * \#  -> #
 * \[  -> [
 * \]  -> ]
 */
function unescapeMarkdown(md) {
  return md
    .replace(/\\#/g, "#")
    .replace(/\\-/g, "-")
    .replace(/\\\[/g, "[")
    .replace(/\\\]/g, "]");
}

/* ---------------------- parsing logic ---------------------- */

// Accept normal hyphen/asterisk/bullet plus common unicode dash/minus characters
const BULLET = String.raw`[-*•\u2010-\u2015\u2212]`;

function extractStatusField(md, label) {
  // matches:
  // - Total steps: 45
  // • Completed: 33
  // – Current focus: Step 34
  const re = new RegExp(
    String.raw`^\s*(?:${BULLET}\s+)?${label}\s*:\s*(.+?)\s*$`,
    "im"
  );
  const m = md.match(re);
  return m ? String(m[1]).trim() : null;
}

function parseSteps(md) {
  // matches:
  // - [x] Step 33 — Title
  // - [ ] Step 34 - Title
  const re = new RegExp(
    String.raw`^\s*(?:${BULLET}\s+)\[(x| )\]\s*Step\s+(\d+)\s*(?:—|-)?\s*(.*)\s*$`,
    "gim"
  );

  const steps = [];
  let m;
  while ((m = re.exec(md))) {
    const done = String(m[1] || "").toLowerCase() === "x";
    const n = Number(m[2]);
    const title = String(m[3] ?? "").trim();
    if (Number.isFinite(n)) steps.push({ n, done, title });
  }

  steps.sort((a, b) => a.n - b.n);
  return steps;
}

function computeStatus(mdRaw) {
  const md = unescapeMarkdown(mdRaw);

  const steps = parseSteps(md);

  const total =
    safeInt(extractStatusField(md, "Total steps")) ??
    (steps.length ? steps[steps.length - 1].n : 0);

  const completed = steps.filter((s) => s.done).length;
  const remaining = Math.max(0, total - completed);

  const focus =
    safeInt(extractStatusField(md, "Current focus")) ??
    Math.min(total || 0, completed + 1);

  return { total, completed, remaining, focus, steps };
}

function replaceStatusLine(md, label, value) {
  const re = new RegExp(
    String.raw`(^\s*(?:${BULLET}\s+)?${label}\s*:\s*)(.+?)(\s*$)`,
    "im"
  );
  if (re.test(md)) return md.replace(re, `$1${value}$3`);
  return md;
}

function setStepCheckboxLine(md, stepN, done) {
  const re = new RegExp(
    String.raw`(^\s*(?:${BULLET}\s+))\[(x| )\](\s*Step\s+${stepN}\b)`,
    "im"
  );

  if (!re.test(md)) {
    const err = new Error(`Step not found in roadmap file: Step ${stepN}`);
    err.code = "ERR_STEP_NOT_FOUND";
    throw err;
  }

  const mark = done ? "x" : " ";
  return md.replace(re, `$1[${mark}]$3`);
}

function titleIsTbd(title) {
  // IMPORTANT:
  // We only treat titles as TBD when they are literal placeholders:
  //   "(TBD)" or "TBD" (with optional whitespace/case)
  // Not when the title *mentions* "(TBD)" as part of a real sentence.
  const t = String(title ?? "").trim();
  if (!t) return true;
  if (/^tbd$/i.test(t)) return true;
  if (/^\(\s*tbd\s*\)$/i.test(t)) return true;
  return false;
}

function buildVerifyIssues(mdRaw, statusComputed) {
  const md = unescapeMarkdown(mdRaw);

  const issues = [];

  const totalRaw = extractStatusField(md, "Total steps");
  const completedRaw = extractStatusField(md, "Completed");
  const remainingRaw = extractStatusField(md, "Remaining");
  const focusRaw = extractStatusField(md, "Current focus");

  const totalDeclared = safeInt(totalRaw);
  const completedDeclared = safeInt(completedRaw);
  const remainingDeclared = safeInt(remainingRaw);
  const focusDeclared = safeInt(focusRaw);

  if (totalDeclared == null) {
    issues.push({
      code: "ERR_STATUS_TOTAL_MISSING",
      message: "Status line missing or invalid: Total steps",
      expected: statusComputed.total,
      actual: totalRaw,
    });
  } else if (totalDeclared !== statusComputed.total) {
    issues.push({
      code: "ERR_STATUS_TOTAL_MISMATCH",
      message: "Status total does not match parsed steps",
      expected: statusComputed.total,
      actual: totalDeclared,
    });
  }

  if (completedDeclared == null) {
    issues.push({
      code: "ERR_STATUS_COMPLETED_MISSING",
      message: "Status line missing or invalid: Completed",
      expected: statusComputed.completed,
      actual: completedRaw,
    });
  } else if (completedDeclared !== statusComputed.completed) {
    issues.push({
      code: "ERR_STATUS_COMPLETED_MISMATCH",
      message: "Status completed does not match checkbox count",
      expected: statusComputed.completed,
      actual: completedDeclared,
    });
  }

  if (remainingDeclared == null) {
    issues.push({
      code: "ERR_STATUS_REMAINING_MISSING",
      message: "Status line missing or invalid: Remaining",
      expected: statusComputed.remaining,
      actual: remainingRaw,
    });
  } else if (remainingDeclared !== statusComputed.remaining) {
    issues.push({
      code: "ERR_STATUS_REMAINING_MISMATCH",
      message: "Status remaining does not match computed remaining",
      expected: statusComputed.remaining,
      actual: remainingDeclared,
    });
  }

  if (focusDeclared == null) {
    issues.push({
      code: "ERR_STATUS_FOCUS_MISSING",
      message: "Status line missing or invalid: Current focus",
      expected: statusComputed.focus,
      actual: focusRaw,
    });
  } else if (focusDeclared < 1 || focusDeclared > statusComputed.total) {
    issues.push({
      code: "ERR_STATUS_FOCUS_OUT_OF_RANGE",
      message: "Current focus step is out of range",
      expected: `1..${statusComputed.total}`,
      actual: focusDeclared,
    });
  }

  // Basic sanity: we should have steps
  if (!statusComputed.steps || statusComputed.steps.length === 0) {
    issues.push({
      code: "ERR_PARSE_NO_STEPS",
      message: "No steps were parsed from roadmap list",
    });
  }

  // Step 37 freeze rule:
  // No "(TBD)" titles at or above the CURRENT FOCUS step.
  // Use declared focus if present, otherwise computed.
  const focusGate =
    typeof focusDeclared === "number" && Number.isFinite(focusDeclared)
      ? focusDeclared
      : statusComputed.focus;

  if (Array.isArray(statusComputed.steps) && statusComputed.steps.length > 0) {
    const offenders = statusComputed.steps
      .filter((s) => s && typeof s.n === "number" && s.n >= focusGate)
      .filter((s) => titleIsTbd(s.title))
      .map((s) => ({ step: s.n, title: s.title }));

    if (offenders.length > 0) {
      issues.push({
        code: "ERR_TBD_AT_OR_ABOVE_FOCUS",
        message: "Roadmap contains (TBD) titles at or above current focus step",
        focus: focusGate,
        offenders,
      });
    }
  }

  return {
    issues,
    declared: {
      total: totalDeclared,
      completed: completedDeclared,
      remaining: remainingDeclared,
      focus: focusDeclared,
    },
  };
}

/* ------------------ Step 37: auto-sync logic ------------------ */

function findNextIncompleteFocus(steps, total) {
  if (!Array.isArray(steps) || steps.length === 0) return total || 1;
  for (const s of steps) {
    if (s && typeof s.n === "number" && s.n >= 1 && s.done === false) return s.n;
  }
  return total || steps[steps.length - 1].n || 1;
}

function replaceStatusValueRaw(mdRaw, label, valueStr) {
  // Supports escaped bullets like "\-" and plain "-".
  // Captures the prefix (bullet + spaces + label + colon) and only replaces the value part.
  const escOpt = String.raw`\\?`;
  const re = new RegExp(
    String.raw`(^\s*(?:${escOpt}(?:${BULLET})\s+)?${label}\s*:\s*)(.+?)(\s*$)`,
    "im"
  );
  if (!re.test(mdRaw)) return { text: mdRaw, changed: false, found: false };
  const next = mdRaw.replace(re, `$1${valueStr}$3`);
  return { text: next, changed: next !== mdRaw, found: true };
}

/* ------------------------ commands ------------------------ */

export async function roadmapStatusCommand({ flags }) {
  const fileRel = normalizeFileFlag(flags);
  const filePath = path.resolve(process.cwd(), fileRel);

  if (!(await pathExists(filePath))) {
    writeJson({
      ok: false,
      error: { code: "ERR_NOT_FOUND", message: `Roadmap file not found: ${filePath}` },
      filePath,
    });
    return 3;
  }

  const { text, encoding } = await readTextFileSmart(filePath);
  const status = computeStatus(text);

  writeJson({
    ok: true,
    filePath,
    encoding,
    status: {
      total: status.total,
      completed: status.completed,
      remaining: status.remaining,
      focus: status.focus,
    },
    steps: status.steps,
  });
  return 0;
}

export async function roadmapUpdateCommand({ flags }) {
  const fileRel = normalizeFileFlag(flags);
  const filePath = path.resolve(process.cwd(), fileRel);

  const stepN = safeInt(flags.step);
  if (!stepN) {
    writeJson({
      ok: false,
      error: { code: "ERR_INPUT", message: "Missing or invalid --step <n>" },
      cmd: "roadmap:update",
    });
    return 2;
  }

  const hasDone = Object.prototype.hasOwnProperty.call(flags, "done");
  const hasUndone = Object.prototype.hasOwnProperty.call(flags, "undone");
  if (hasDone === hasUndone) {
    writeJson({
      ok: false,
      error: { code: "ERR_INPUT", message: "Provide exactly one of --done or --undone" },
      cmd: "roadmap:update",
    });
    return 2;
  }

  const done = hasDone;
  const focusN = flags.focus != null && flags.focus !== true ? safeInt(flags.focus) : null;

  if (!(await pathExists(filePath))) {
    writeJson({
      ok: false,
      error: { code: "ERR_NOT_FOUND", message: `Roadmap file not found: ${filePath}` },
      filePath,
    });
    return 3;
  }

  const { text: md0, encoding } = await readTextFileSmart(filePath);

  const escapeOptional = String.raw`\\?`; // matches optional "\"

  // Update checkbox line in raw text (supports "\- \[x]" etc.)
  const stepRe = new RegExp(
    String.raw`(^\s*${escapeOptional}(?:${BULLET})\s+${escapeOptional}\[(x| )\]\s*Step\s+${stepN}\b)`,
    "im"
  );

  if (!stepRe.test(md0)) {
    writeJson({
      ok: false,
      error: { code: "ERR_STEP_NOT_FOUND", message: `Step not found in roadmap file: Step ${stepN}` },
      filePath,
    });
    return 2;
  }

  const mark = done ? "x" : " ";
  const md1 = md0.replace(stepRe, (full) =>
    full.replace(new RegExp(String.raw`${escapeOptional}\[(x| )\]`, "i"), (m) =>
      m.replace(/[x ]/i, mark)
    )
  );

  const status1 = computeStatus(md1);

  let md2 = md1;
  md2 = replaceStatusLine(md2, "Total steps", status1.total);
  md2 = replaceStatusLine(md2, "Completed", status1.completed);
  md2 = replaceStatusLine(md2, "Remaining", status1.remaining);

  const newFocus = focusN ?? status1.focus;
  md2 = replaceStatusLine(md2, "Current focus", `Step ${newFocus}`);

  if (encoding === "utf16le") {
    await fs.writeFile(filePath, md2, "utf16le");
  } else {
    await fs.writeFile(filePath, md2, "utf8");
  }

  writeJson({
    ok: true,
    filePath,
    encoding,
    updated: { step: stepN, done, focus: newFocus },
    status: {
      total: status1.total,
      completed: status1.completed,
      remaining: status1.remaining,
      focus: newFocus,
    },
  });
  return 0;
}

export async function roadmapVerifyCommand({ flags }) {
  const fileRel = normalizeFileFlag(flags);
  const filePath = path.resolve(process.cwd(), fileRel);

  const strict =
    Object.prototype.hasOwnProperty.call(flags, "strict") ? isTrueish(flags.strict) : true;

  if (!(await pathExists(filePath))) {
    writeJson({
      ok: false,
      error: { code: "ERR_NOT_FOUND", message: `Roadmap file not found: ${filePath}` },
      filePath,
    });
    return 3;
  }

  const { text: md0, encoding } = await readTextFileSmart(filePath);
  const statusComputed = computeStatus(md0);

  const { issues, declared } = buildVerifyIssues(md0, statusComputed);
  const ok = issues.length === 0;

  writeJson({
    ok: strict ? ok : true,
    filePath,
    encoding,
    strict,
    status: {
      computed: {
        total: statusComputed.total,
        completed: statusComputed.completed,
        remaining: statusComputed.remaining,
        focus: statusComputed.focus,
      },
      declared,
    },
    issues,
  });

  if (ok) return 0;
  return strict ? 1 : 0;
}

/**
 * Step 37 command:
 * - default: dry-run (no writes). exits 1 if changes are needed.
 * - --apply true: write changes. exits 0 on success.
 *
 * Flags:
 *   --file <path>            (default ai/roadmap-45.md)
 *   --apply true|false       (default false)
 *   --advance-focus true|false (default true)
 *   --focus <n>              (override focus to Step n)
 */
export async function roadmapAutoCommand({ flags }) {
  const fileRel = normalizeFileFlag(flags);
  const filePath = path.resolve(process.cwd(), fileRel);

  const apply = Object.prototype.hasOwnProperty.call(flags, "apply") ? isTrueish(flags.apply) : false;
  const advanceFocus =
    Object.prototype.hasOwnProperty.call(flags, "advance-focus") ? isTrueish(flags["advance-focus"]) : true;

  const focusOverride =
    flags.focus != null && flags.focus !== true ? safeInt(flags.focus) : null;

  if (!(await pathExists(filePath))) {
    writeJson({
      ok: false,
      error: { code: "ERR_NOT_FOUND", message: `Roadmap file not found: ${filePath}` },
      filePath,
    });
    return 3;
  }

  const { text: md0, encoding } = await readTextFileSmart(filePath);

  const statusComputed0 = computeStatus(md0);
  const verify0 = buildVerifyIssues(md0, statusComputed0);

  const computedFocus = advanceFocus
    ? findNextIncompleteFocus(statusComputed0.steps, statusComputed0.total)
    : statusComputed0.focus;

  const nextFocus = focusOverride != null ? focusOverride : computedFocus;

  let md1 = md0;
  let changed = false;
  const changes = {
    total: false,
    completed: false,
    remaining: false,
    focus: false,
  };

  const rTotal = replaceStatusValueRaw(md1, "Total steps", String(statusComputed0.total));
  md1 = rTotal.text;
  if (rTotal.changed) {
    changed = true;
    changes.total = true;
  }

  const rCompleted = replaceStatusValueRaw(md1, "Completed", String(statusComputed0.completed));
  md1 = rCompleted.text;
  if (rCompleted.changed) {
    changed = true;
    changes.completed = true;
  }

  const rRemaining = replaceStatusValueRaw(md1, "Remaining", String(statusComputed0.remaining));
  md1 = rRemaining.text;
  if (rRemaining.changed) {
    changed = true;
    changes.remaining = true;
  }

  const rFocus = replaceStatusValueRaw(md1, "Current focus", `Step ${nextFocus}`);
  md1 = rFocus.text;
  if (rFocus.changed) {
    changed = true;
    changes.focus = true;
  }

  // After proposed updates, recompute + verify again (for deterministic reporting)
  const statusComputed1 = computeStatus(md1);
  const verify1 = buildVerifyIssues(md1, statusComputed1);

  if (apply && changed) {
    if (encoding === "utf16le") {
      await fs.writeFile(filePath, md1, "utf16le");
    } else {
      await fs.writeFile(filePath, md1, "utf8");
    }
  }

  writeJson({
    ok: true,
    filePath,
    encoding,
    apply,
    changed,
    changes,
    advanceFocus,
    focusOverride: focusOverride ?? null,
    status: {
      before: {
        computed: {
          total: statusComputed0.total,
          completed: statusComputed0.completed,
          remaining: statusComputed0.remaining,
          focus: statusComputed0.focus,
        },
        declared: verify0.declared,
        issues: verify0.issues,
      },
      after: {
        computed: {
          total: statusComputed1.total,
          completed: statusComputed1.completed,
          remaining: statusComputed1.remaining,
          focus: statusComputed1.focus,
        },
        declared: verify1.declared,
        issues: verify1.issues,
      },
    },
  });

  // Exit codes:
  // - dry-run + changes needed => 1 (signals “apply needed”)
  // - apply or no changes => 0
  return !apply && changed ? 1 : 0;
}
