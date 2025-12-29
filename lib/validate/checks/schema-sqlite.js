// lib/validate/checks/schema-sqlite.js
import fs from "fs";
import path from "path";
import { ValidationClass } from "../classes.js";

export async function checkSchemaSqlite(ctx, cfg) {
  const appPath = ctx.appPath;
  const candidates = cfg?.dbPathCandidates ?? [];

  // Look for the first candidate DB file that exists
  const found = candidates
    .map((rel) => ({ rel, abs: path.join(appPath, rel) }))
    .find((c) => fs.existsSync(c.abs) && fs.statSync(c.abs).isFile());

  if (!found) {
    return {
      id: "schema",
      required: !!ctx.required,
      ok: false,
      class: ValidationClass.SCHEMA_FAIL,
      details: {
        reason: "db_file_not_found",
        candidates,
      },
    };
  }

  return {
    id: "schema",
    required: !!ctx.required,
    ok: true,
    class: null,
    details: {
      dbFile: found.rel,
    },
  };
}
