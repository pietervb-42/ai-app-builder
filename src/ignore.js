// src/ignore.js
// Centralized ignore rules for drift, snapshot, and regen operations.

export const MANIFEST_NAME = "builder.manifest.json";
export const SNAP_DIR_NAME = ".builder_snapshots";

// Directory names to exclude everywhere we do recursive scanning/copying.
// NOTE: these are NAME-based excludes (not paths).
export const DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  SNAP_DIR_NAME,
]);

// File names to exclude everywhere we do recursive scanning/copying.
// NOTE: these are NAME-based excludes (not paths).
export const DEFAULT_EXCLUDED_FILES = new Set([
  MANIFEST_NAME,
]);

export function shouldSkipDir(dirName) {
  return DEFAULT_EXCLUDED_DIRS.has(dirName);
}

export function shouldSkipFile(fileName) {
  return DEFAULT_EXCLUDED_FILES.has(fileName);
}
