# AI App Builder

Documentation lives in `docs/README.md`.

## Quick start

List templates:
- `node index.js templates:list`

Validate the committed golden apps:
- `node index.js validate:all --root .\outputs\golden --install-mode if-missing --json`

Run CI checks locally (contracts + schemas + roadmap):
- `node index.js ci:check --ci --root .\outputs --contracts-dir .\ci\contracts --json`
