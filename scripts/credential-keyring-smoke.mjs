import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const bindingPackage = process.argv[2];
if (!bindingPackage) throw new Error("Pass the installed ZCode-compatible native keyring package directory");
const root = await mkdtemp(path.join(tmpdir(), "zcode-keyring-smoke-"));
try {
  const home = path.join(root, "home");
  const resources = path.join(root, "resources");
  const modules = path.join(resources, "app.asar.unpacked", "node_modules", "@napi-rs");
  const bindingDirectory = path.join(modules, path.basename(bindingPackage));
  await mkdir(modules, { recursive: true });
  await cp(bindingPackage, bindingDirectory, { recursive: true });
  await mkdir(path.join(home, ".zcode", "v2"), { recursive: true });
  const harness = path.join(root, "smoke.cjs");
  await build({
    entryPoints: ["src/testSupport/credentialKeyringSmoke.ts"],
    outfile: harness,
    bundle: true,
    platform: "node",
    alias: { vscode: "./src/testSupport/vscode.ts" },
  });
  const child = spawnSync(process.execPath, [
    harness, path.join(resources, "glm", "zcode.cjs"), bindingDirectory, home,
  ], { stdio: "inherit", timeout: 60_000 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error("Native keyring smoke test failed");
} finally {
  await rm(root, { recursive: true, force: true });
}
