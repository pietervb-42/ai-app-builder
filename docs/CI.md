# CI Usage

CI should prove:
1) golden apps validate
2) trust surface guarantees hold (JSON purity, contracts, manifest integrity)
3) fixture hygiene stays clean (no runtime outputs committed)

## Recommended CI-style commands

Validate golden apps:
- `node index.js validate:all --root .\outputs\golden --install-mode if-missing --json`

Run the repo CI wrapper:
- `node index.js ci:check --ci --root .\outputs --contracts-dir .\ci\contracts --json`

## Why `--install-mode if-missing` is ideal in CI

- If CI starts from clean workspace: behaves like always.
- If CI caches deps: avoids reinstalling every run.
- Keeps CI fast while staying reliable.
