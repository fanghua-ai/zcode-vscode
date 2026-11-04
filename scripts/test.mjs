import { build } from "esbuild";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const output = await mkdtemp(path.join(tmpdir(), "zcode-tests-"));
try {
  // Tests must supply their own desktop fixtures, never the developer's login,
  // default models or task databases. Keep the parent's environment unchanged.
  const home = path.join(output, "home");
  await mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  delete env.ZCODE_CREDENTIAL_SECRET;
  const requested = new Set(process.argv.slice(2));
  const entries = (await readdir("src")).filter((name) => name.endsWith(".test.ts") &&
    (!requested.size || requested.has(name)));
  if (requested.size && entries.length !== requested.size) throw new Error("Unknown test file selection");
  await build({
    entryPoints: entries.map((name) => path.join("src", name)),
    outdir: output,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [{
      name: "isolated-test-runtime",
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({ path: path.resolve("src/testSupport/vscode.ts") }));
        builder.onResolve({ filter: /^\.\/log$/ }, () => ({ path: "log", namespace: "test" }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: "export const logInfo=()=>{}, logWarn=()=>{}, logError=()=>{}, logDebug=()=>{}, getLog=()=>({show(){}}), disposeLog=()=>{};",
        }));
      },
    }],
  });
  const result = spawnSync(process.execPath, ["--test", ...entries.map((name) =>
    path.join(output, name.replace(/\.ts$/, ".cjs")))], { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`Test process exited from signal ${result.signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
