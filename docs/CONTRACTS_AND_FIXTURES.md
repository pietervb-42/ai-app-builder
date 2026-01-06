# Contracts & Fixtures

Fixtures + contracts make behavior testable and safe.

## Definitions

### Fixture
A **fixture** is a controlled folder used for repeatable tests under:
- `ci/fixtures/`

Fixtures should contain only stable inputs.
Fixtures should NOT contain runtime outputs (out dirs, node_modules, logs).

### Contract
A **contract** is a snapshot of expected command output stored under:
- `ci/contracts/`

CI compares current outputs vs contract snapshots to detect drift.

## Adding a new fixture (safe workflow)

1) Create a new folder under `ci/fixtures/...`
2) Put only stable input files inside it
3) Ensure runtime outputs go to an ignored directory (recommended: `out/`)
4) Run the command locally and verify behavior
5) Update contracts only when intended
6) Commit fixture inputs + contract snapshot changes

## Never commit runtime outputs

Do not commit:
- `ci/fixtures/**/out/`
- logs produced by test runs
- node_modules
- package-lock.json created by runtime installs inside fixtures

If runtime output appears, delete it and make sure it’s ignored.
