import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { allowedDesktopPlugins, suppressedDesktopPluginIds } from "./desktopPluginChoices";

test("plugin choices suppress Sites and both computer-use ids independently", () => {
  assert.deepEqual(allowedDesktopPlugins(["pdf", "unknown", "pdf"]), ["pdf"]);
  const disabled = suppressedDesktopPluginIds(["pdf", "computer-use"]);
  assert.ok(disabled.includes("zcode-site@zcode-plugins-official"));
  assert.ok(disabled.includes("documents@zcode-plugins-official"));
  assert.ok(!disabled.includes("pdf@zcode-plugins-official"));
  assert.ok(!disabled.includes("computer-use@zcode-plugins-official"));
  assert.ok(!disabled.includes("zcode-cua@zcode-plugins-official"));
});

test("preload keeps other Node flags and permits only selected plugins", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-selective-"));
  try {
    const preload = path.join(root, "preload.cjs");
    const built = spawnSync(process.execPath, ["-e", `require('esbuild').buildSync({entryPoints:['src/desktopPluginOverlayPreload.ts'],outfile:process.argv[1],bundle:true,platform:'node',format:'cjs',logLevel:'silent'})`, preload], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const result = spawnSync(process.execPath, ["--trace-warnings", "--require", preload, "-e", `
      const fs=require('fs'),path=require('path');
      const config=path.join(${JSON.stringify(root)},'zcode.json');
      fs.writeFileSync(config,JSON.stringify({plugins:{enabledPlugins:{'pdf@zcode-plugins-official':true,'documents@zcode-plugins-official':true}}}));
      console.log(JSON.stringify({args:process.execArgv,view:JSON.parse(fs.readFileSync(config,'utf8')),disk:JSON.parse(require('child_process').execFileSync(process.execPath,['-p','require("fs").readFileSync(process.argv[1],"utf8")',config],{encoding:'utf8'}))}));
    `], { encoding: "utf8", env: { ...process.env, ZCODE_VSCODE_DESKTOP_PLUGIN_OVERLAY: "1", ZCODE_VSCODE_ALLOWED_PLUGINS: '["pdf"]' } });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.ok(data.args.includes("--trace-warnings"));
    assert.ok(!data.args.includes(preload));
    assert.equal(data.view.plugins.enabledPlugins["pdf@zcode-plugins-official"], true);
    assert.equal(data.view.plugins.enabledPlugins["documents@zcode-plugins-official"], false);
    // Overlay writes never publish their disables into shared config.
    assert.equal(data.disk.plugins.enabledPlugins["documents@zcode-plugins-official"], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
