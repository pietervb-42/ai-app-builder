import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export function shouldInstall({ appPath, installMode }) {
  if (installMode === "never") return false;
  if (installMode === "always") return true;

  // if-missing
  const nm = path.join(appPath, "node_modules");
  return !fs.existsSync(nm);
}

export function runInstall({ appPath }) {
  const result = spawnSync("npm", ["install"], {
    cwd: appPath,
    stdio: "inherit",
    shell: true
  });

  if (result.status !== 0) {
    throw new Error("npm install failed");
  }
}
