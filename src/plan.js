// src/plan.js
/**
 * Deterministic Structured Plan Builder
 * - No randomness
 * - No timestamps
 * - No external calls
 * - Same prompt -> same JSON
 */

function cleanText(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function detectStack(prompt) {
  const p = String(prompt || "").toLowerCase();

  const wantsReact =
    /\breact\b/.test(p) ||
    /\bnext\.?js\b/.test(p) ||
    /\bfrontend\b/.test(p) ||
    /\bui\b/.test(p);

  const wantsExpress =
    /\bexpress\b/.test(p) ||
    /\bapi\b/.test(p) ||
    /\bbackend\b/.test(p) ||
    /\brest\b/.test(p);

  const wantsSqlite =
    /\bsqlite\b/.test(p) ||
    /\bsql\b/.test(p) ||
    /\bdatabase\b/.test(p) ||
    /\bdb\b/.test(p);

  const wantsPostgres = /\bpostgres\b/.test(p) || /\bpostgresql\b/.test(p);

  return {
    frontend: wantsReact ? "react" : "none",
    backend: wantsExpress ? "express" : "node",
    database: wantsPostgres ? "postgres" : wantsSqlite ? "sqlite" : "none",
  };
}

function defaultAssumptions(stack) {
  const base = [
    "You want a production-ready result with deterministic file writes and repeatable builds.",
    "You want a CLI-driven workflow suitable for CI (JSON output, stable structure).",
    "You want safe outputs: no destructive overwrites unless explicitly commanded elsewhere.",
  ];

  if (stack.backend === "express") base.push("Backend will be an Express HTTP API with a /health endpoint.");
  if (stack.frontend === "react") base.push("Frontend will be a React SPA consuming the API via HTTP.");
  if (stack.database === "sqlite") base.push("Database will be SQLite for local-first deterministic storage.");
  if (stack.database === "postgres") base.push("Database will be PostgreSQL; local dev uses env vars and migrations.");

  return base;
}

function defaultDecisions(stack) {
  return [
    { key: "determinism", value: "No timestamps/randomness in plans; stable step IDs and ordering." },
    { key: "writes", value: "Plan command writes only the plan output file (optional). No app generation." },
    { key: "cli", value: "All options provided via parseArgs() flags; no raw argv scanning in handlers." },
    { key: "output", value: "JSON structure is stable for CI consumption." },
    { key: "backend", value: stack.backend },
    { key: "frontend", value: stack.frontend },
    { key: "database", value: stack.database },
  ];
}

function buildSteps(stack) {
  // Stable IDs: append-only (avoid reordering to keep CI stable)
  const steps = [];

  steps.push({
    id: "S1",
    title: "Confirm goal and constraints",
    files: ["README.md (update if needed)"],
    commands: [],
    acceptance: [
      "Goal is restated clearly in one sentence.",
      "Constraints include deterministic writes, CI-safe output, and no raw argv re-parsing.",
    ],
  });

  steps.push({
    id: "S2",
    title: "Select template and architecture",
    files: ["templates/* (reference)", "src/* (builder CLI)"],
    commands: ["node index.js templates:list --json"],
    acceptance: [
      "A single template is chosen (or a new template is specified).",
      "Architecture includes backend/frontend/db responsibilities.",
    ],
  });

  steps.push({
    id: "S3",
    title: "Define folder structure and contracts",
    files: [
      "outputs/<app>/ (generated app root)",
      "outputs/<app>/package.json",
      "outputs/<app>/src/*",
    ],
    commands: [],
    acceptance: [
      "Folder structure is listed (backend routes, db layer, optional frontend).",
      "API contract includes /health and core endpoints.",
    ],
  });

  if (stack.backend === "express") {
    steps.push({
      id: "S4",
      title: "Implement backend API skeleton (Express)",
      files: [
        "outputs/<app>/index.js or src/server.js",
        "outputs/<app>/src/routes/*",
        "outputs/<app>/src/middleware/*",
      ],
      commands: ["npm start"],
      acceptance: [
        "GET /health returns { status: 'ok' }.",
        "Core routes return expected HTTP codes and JSON responses.",
      ],
    });
  } else {
    steps.push({
      id: "S4",
      title: "Implement backend API skeleton (Node HTTP)",
      files: ["outputs/<app>/index.js"],
      commands: ["npm start"],
      acceptance: [
        "Server boots reliably on provided PORT.",
        "GET /health returns { status: 'ok' }.",
      ],
    });
  }

  if (stack.database === "sqlite") {
    steps.push({
      id: "S5",
      title: "Add SQLite data layer",
      files: [
        "outputs/<app>/src/db/*",
        "outputs/<app>/src/models/*",
        "outputs/<app>/data/app.sqlite (runtime-created)",
      ],
      commands: [],
      acceptance: [
        "DB connection is created once and reused.",
        "Schema exists (migrations or init script).",
        "CRUD operations are covered by tests or validation checks.",
      ],
    });
  } else if (stack.database === "postgres") {
    steps.push({
      id: "S5",
      title: "Add PostgreSQL data layer",
      files: [
        "outputs/<app>/src/db/*",
        "outputs/<app>/.env.example",
        "outputs/<app>/src/migrations/*",
      ],
      commands: ["npm run migrate", "npm start"],
      acceptance: [
        "DB config is fully env-driven.",
        "Migrations run cleanly from empty database.",
      ],
    });
  } else {
    steps.push({
      id: "S5",
      title: "Define data storage strategy",
      files: ["outputs/<app>/src/storage/* (if needed)"],
      commands: [],
      acceptance: ["Storage decision is documented (in-memory, file-based, sqlite, postgres)."],
    });
  }

  if (stack.frontend === "react") {
    steps.push({
      id: "S6",
      title: "Implement React frontend (minimal but complete)",
      files: [
        "outputs/<app>/web/package.json",
        "outputs/<app>/web/src/*",
        "outputs/<app>/web/vite.config.* (or equivalent)",
      ],
      commands: ["npm run dev", "npm run build"],
      acceptance: [
        "Frontend can load and display API status from /health.",
        "Build completes without warnings-as-errors.",
      ],
    });
  } else {
    steps.push({
      id: "S6",
      title: "Skip frontend (API-only)",
      files: [],
      commands: [],
      acceptance: ["API-only scope confirmed."],
    });
  }

  steps.push({
    id: "S7",
    title: "Add validation hooks and CI-friendly output",
    files: ["src/validate.js", "src/validate-all.js", "index.js"],
    commands: [
      "node index.js validate --app outputs/<app> --install-mode if-missing --json",
      "node index.js validate:all --root outputs --install-mode if-missing --json",
    ],
    acceptance: [
      "validate returns ok=true and stable JSON shape.",
      "install-mode behavior is correct (always|never|if-missing).",
    ],
  });

  steps.push({
    id: "S8",
    title: "Document usage and next automation steps",
    files: ["README.md"],
    commands: [],
    acceptance: [
      "README contains: generate → validate → drift/regen workflow.",
      "PLAN MODE documented with example output and flags.",
    ],
  });

  return steps;
}

function defaultRisks(stack) {
  const risks = [
    {
      id: "R1",
      risk: "Plan output becomes non-deterministic (timestamps, random IDs).",
      mitigation: "Never add timestamps/randomness; keep stable ordering and step IDs.",
    },
    {
      id: "R2",
      risk: "CLI handler re-parses argv directly and drifts from parseArgs().",
      mitigation: "Use parseArgs() flags only; never use args.indexOf/argv scanning in handlers.",
    },
    {
      id: "R3",
      risk: "Plan implies file writes beyond --out.",
      mitigation: "PLAN command must only compute and optionally write the plan JSON file.",
    },
  ];

  if (stack.database === "postgres") {
    risks.push({
      id: "R4",
      risk: "Postgres local dev setup adds env/migration complexity.",
      mitigation: "Provide .env.example and a single migrate command; validate connectivity early.",
    });
  }

  return risks;
}

export function createPlan(prompt) {
  const goal = cleanText(prompt);
  const stack = detectStack(goal);

  return {
    ok: Boolean(goal),
    goal: goal || "No prompt provided.",
    assumptions: defaultAssumptions(stack),
    decisions: defaultDecisions(stack),
    steps: buildSteps(stack),
    risks: defaultRisks(stack),
    next: [
      "If this plan looks right, run: node index.js templates:list",
      "Then generate an app in outputs/ and validate it with validate / validate:all",
      "Use drift:report and regen:* commands to keep outputs aligned with templates safely",
    ],
  };
}
