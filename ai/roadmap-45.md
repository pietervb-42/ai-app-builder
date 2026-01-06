# AI App Builder — 45 Step Roadmap (Source of Truth)

## Status

- Total steps: 45
- Completed: 40
- Remaining: 5
- Current focus: Step 41

## Steps

- [x] Step 1 — Repo + Node project created
- [x] Step 2 — OpenAI SDK wired
- [x] Step 3 — File-based memory created (/ai)
- [x] Step 4 — CLI entrypoint established (index.js)
- [x] Step 5 — Template system exists (/templates) and enforced
- [x] Step 6 — Safe deterministic writes (no overwrite unless allowed)
- [x] Step 7 — WRITE MODE outputs JSON-only (CI-safe)
- [x] Step 8 — Build pipeline works end-to-end
- [x] Step 9 — Validation command exists (validate)
- [x] Step 10 — validate:all exists
- [x] Step 11 — Manifest integrity introduced (baseline fileMap)
- [x] Step 12 — Phase A complete (Steps 1–12)

- [x] Step 13 — Structured PLAN MODE
- [x] Step 14 — PLAN → GENERATE handshake helpers
- [x] Step 15 — build command (generate + validate)
- [x] Step 16 — --dry-run support
- [x] Step 17 — deterministic absolute out path metadata
- [x] Step 18 — Manifest Integrity Lock helpers
- [x] Step 19 — Manifest refresh support
- [x] Step 20 — Snapshot BEFORE modifications (regen safety)
- [x] Step 21 — Drift + regen workflow in place
- [x] Step 22 — Contract-run tooling introduced
- [x] Step 23 — Deterministic contract normalization helpers
- [x] Step 24 — Contract fixtures created
- [x] Step 25 — CI report wiring (report:ci)
- [x] Step 26 — CI check command (ci:check)
- [x] Step 27 — Windows hardening improvements
- [x] Step 28 — Timeout floors / stability improvements
- [x] Step 29 — install-mode support (always|never|if-missing) across validate + validate:all
- [x] Step 30 — JSON purity rules (stdout JSON only, logs to stderr)
- [x] Step 31 — validate:all rules / outputs hardened
- [x] Step 32 — schema:check deterministic validators + exit codes
- [x] Step 33 — CI Contract Lock (Golden Snapshots)
- [x] Step 34 — Roadmap source-of-truth + auto-update progress file

- [x] Step 35 — Roadmap step-definition lock (no TBD at focus) + status normalization
- [x] Step 36 — Roadmap: define Steps 36–45 (lock remaining milestones)
- [x] Step 37 — Roadmap freeze rule: no (TBD) at/above focus
- [x] Step 38 — Release-ready CLI UX: help, examples, error codes catalog
- [x] Step 39 — Template hardening: template contract + deterministic inventory
- [x] Step 40 — Builder doctor command: environment + dependency diagnostics
- [ ] Step 41 — App generation safety v2: stricter overwrite policy + guardrails
- [ ] Step 42 — Golden sample apps: curated fixtures under outputs/
- [ ] Step 43 — Documentation pack: README, workflows, CI usage
- [ ] Step 44 — npm packaging: publishable CLI (bin), versioning discipline
- [ ] Step 45 — v1.0 cut: final CI gate + roadmap completion lock
