# AI App Builder — Documentation

This folder explains how to use and trust this repo.

## Start here

- **Trust surface (what we guarantee):** `TRUST_SURFACE.md`
- **Golden apps (what they are and why they exist):** `GOLDEN_APPS.md`
- **Validation (local + CI):** `VALIDATION.md`
- **CI usage (standard commands):** `CI.md`
- **Contracts & fixtures (how to add new ones safely):** `CONTRACTS_AND_FIXTURES.md`

## Quick mental model (like you’re 10)

- The builder can generate apps.
- We keep a small set of “perfect example apps” called **golden apps**.
- We validate those golden apps to prove the builder works.
- We keep **contracts/snapshots** so CI can detect drift.
- When `--json` is on, stdout must be clean JSON so machines can read it.
