# Trust Surface (What This Repo Guarantees)

This document defines what you can rely on.

## 1) Determinism boundaries

### Plan outputs
Plan-mode outputs must be deterministic:
- no timestamps
- no randomness
- stable ordering
- stable step IDs

Same input => same plan JSON.

### Validation outputs
Validation measures real execution and is allowed to be runtime-dependent:
- ports
- timing
- process scheduling

But the JSON structure must remain stable and parseable.

## 2) Manifest integrity lock

Each generated app includes a manifest (`builder.manifest.json`).

The integrity lock exists to prevent:
- silent drift
- partial updates
- accidental edits to generated outputs without updating the manifest rules

If integrity fails, validation should fail.

## 3) Contract snapshots (drift detection)

Contracts store expected results of running commands against fixtures/golden apps.
CI compares current results to snapshots to answer:

“Did output change?”

If yes:
- either a bug was introduced
- or the change was intentional and contracts must be updated

## 4) JSON purity (machine readability)

When `--json` is provided:
- stdout must contain only the final JSON document
- logs must go to stderr
- child process stdout must not pollute stdout

CI depends on this.

## 5) Windows process cleanup

Validation/fixtures must not leave orphan node servers.
Process-tree cleanup is part of stability and repeatability on Windows.
