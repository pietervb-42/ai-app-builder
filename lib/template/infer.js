import fs from "fs/promises";
import path from "path";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statDir(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function readTextIfExists(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(p) {
  const txt = await readTextIfExists(p);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function getDeps(pkg) {
  const deps =
    pkg?.dependencies && typeof pkg.dependencies === "object"
      ? pkg.dependencies
      : {};
  const dev =
    pkg?.devDependencies && typeof pkg.devDependencies === "object"
      ? pkg.devDependencies
      : {};
  return { ...deps, ...dev };
}

function hasAnyKey(obj, keys) {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) return true;
  }
  return false;
}

function textIncludesAny(haystack, needles) {
  if (!haystack) return false;
  const s = haystack.toLowerCase();
  return needles.some((n) => s.includes(String(n).toLowerCase()));
}

/**
 * Deterministic template inference when builder.manifest.json is missing
 * OR when manifest.template is missing/unknown.
 *
 * Only uses stable file existence checks + static text checks.
 * Returns "unknown" if not confident.
 */
export async function inferTemplate(appAbs) {
  const abs = path.resolve(appAbs);

  const pkgPath = path.join(abs, "package.json");
  const indexPath = path.join(abs, "index.js");
  const srcIndexPath = path.join(abs, "src", "index.js");

  const hasPkg = await exists(pkgPath);
  const hasIndex = (await exists(indexPath)) || (await exists(srcIndexPath));

  if (!hasPkg && !hasIndex) return "unknown";

  const pkg = hasPkg ? await readJsonIfExists(pkgPath) : null;
  const deps = pkg ? getDeps(pkg) : {};

  const hasExpress = hasAnyKey(deps, ["express"]);
  const hasSqliteDep = hasAnyKey(deps, ["sqlite3", "better-sqlite3"]);
  const hasStartScript = typeof pkg?.scripts?.start === "string";

  const indexTxt =
    (await readTextIfExists(indexPath)) ??
    (await readTextIfExists(srcIndexPath)) ??
    "";

  const hasHealthRoute = textIncludesAny(indexTxt, ["/health"]);
  const hasUsersRoute = textIncludesAny(indexTxt, ["/api/v1/users", "api/v1/users"]);
  const hasPingRoute = textIncludesAny(indexTxt, ["/api/v1/ping", "api/v1/ping"]);
  const mentionsSqlite = textIncludesAny(indexTxt, [
    "sqlite",
    "better-sqlite3",
    "sqlite3",
    ".db",
  ]);

  // Extra deterministic filesystem signal: presence of a db/ folder
  const hasDbDir = await statDir(path.join(abs, "db"));

  /**
   * Template: node-express-api-sqlite
   *
   * Confidence rules (deterministic, incremental):
   * - express present
   * - and looks like our API template by either:
   *   - sqlite dependency OR code mentions sqlite/db OR db/ folder exists
   * - start script usually exists for generated apps (but don’t require it)
   */
  if (hasExpress) {
    const looksLikeSqliteApi =
      hasSqliteDep || mentionsSqlite || hasDbDir || (hasHealthRoute && (hasPingRoute || hasUsersRoute));

    if (looksLikeSqliteApi) {
      return "node-express-api-sqlite";
    }

    // Future templates can be added here with similarly strict checks.
    // Notice: if we cannot be confident, we return unknown.
    if (hasStartScript && hasHealthRoute) {
      // Express app, but no sqlite/db signal -> unknown (keep strict)
      return "unknown";
    }
  }

  return "unknown";
}
