import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { writeThirdPartyNotices } from "./scripts/collect-third-party-notices.mjs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

function copySqliteWasm() {
  const srcDir = path.join("node_modules", "node-sqlite3-wasm", "dist");
  for (const name of ["node-sqlite3-wasm.js", "node-sqlite3-wasm.wasm"]) {
    fs.copyFileSync(path.join(srcDir, name), path.join("dist", name));
  }
}

// VS Code's Chromium only needs WOFF2. Keep formula assets local and omit legacy fonts.
function copyFormulaAssets() {
  const source = path.join("node_modules", "katex", "dist");
  const target = path.join("dist", "math");
  fs.mkdirSync(path.join(target, "fonts"), { recursive: true });
  const css = fs.readFileSync(path.join(source, "katex.min.css"), "utf8")
    .replace(/,url\([^)]*\.(?:woff|ttf)\) format\("[^" ]*"\)/g, "");
  fs.writeFileSync(path.join(target, "katex.min.css"), css);
  for (const font of fs.readdirSync(path.join(source, "fonts"))) {
    if (font.endsWith(".woff2")) fs.copyFileSync(path.join(source, "fonts", font), path.join(target, "fonts", font));
  }
  fs.copyFileSync(path.join("node_modules", "katex", "LICENSE"), path.join(target, "LICENSE"));
}

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "node-sqlite3-wasm", "node:sqlite"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ext = await esbuild.context(extensionOptions);
    const web = await esbuild.context(webviewOptions);
    fs.mkdirSync("dist", { recursive: true });
    copySqliteWasm();
    copyFormulaAssets();
    writeThirdPartyNotices();
    await Promise.all([ext.watch(), web.watch()]);
    console.log("[esbuild] watching for changes...");
  } else {
    fs.mkdirSync("dist", { recursive: true });
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(webviewOptions),
    ]);
    copySqliteWasm();
    copyFormulaAssets();
    writeThirdPartyNotices();
    console.log("[esbuild] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
