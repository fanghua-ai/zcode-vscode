import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const vsceDir = dirname(require.resolve("@vscode/vsce/package.json"));
const result = spawnSync(process.execPath, [resolve(vsceDir, "vsce"), "package",
  "--no-dependencies", "--no-rewrite-relative-links", "--allow-missing-repository",
  ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ZCODE_RELEASE_CHECK: "1" } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
