# Validation (Local + CI)

Validation proves:
- generated apps boot
- health checks succeed
- endpoints behave as expected
- JSON output stays machine-parseable

## JSON purity rule (critical)

When you pass `--json`:
- stdout must contain ONLY the final JSON object
- logs must go to stderr
- child process stdout must not pollute stdout

If stdout contains mixed logs + JSON, that’s a bug.

## install-mode (always | never | if-missing)

Validation may need dependencies installed per app (node_modules).

- `--install-mode always`
  - Always install before validating.
  - Slowest, safest.

- `--install-mode never`
  - Never install.
  - Fast, fails if node_modules missing.

- `--install-mode if-missing`
  - Install only if node_modules missing.
  - Best for CI and repeated local runs.

Why CI often uses `if-missing`:
- faster
- avoids reinstall churn
- still safe when node_modules is missing

## Typical commands

Validate golden apps (CI-like):
- `node index.js validate:all --root .\outputs\golden --install-mode if-missing --json`

Validate golden apps (fresh install):
- `node index.js validate:all --root .\outputs\golden --install-mode always --json`

Run full CI checks locally:
- `node index.js ci:check --ci --root .\outputs --contracts-dir .\ci\contracts --json`
