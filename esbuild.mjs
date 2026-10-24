import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { writeThirdPartyNotices } from "./scripts/collect-third-party-notices.mjs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Ship KaTeX layout CSS only. WOFF2 faces download into global storage on request.
function copyFormulaAssets() {
  const source = path.join("node_modules", "katex", "dist");
  const target = path.join("dist", "math");
  fs.rmSync(path.join(target, "fonts"), { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const css = fs.readFileSync(path.join(source, "katex.min.css"), "utf8")
    .replace(/@font-face\{[^}]*\}/g, "");
  if (css.includes("url(")) throw new Error("Formula CSS still references a font file");
  fs.writeFileSync(path.join(target, "katex.min.css"), css);
  fs.copyFileSync(path.join("node_modules", "katex", "LICENSE"), path.join(target, "LICENSE"));
}

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "node:sqlite"],
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
    copyFormulaAssets();
    writeThirdPartyNotices();
    console.log("[esbuild] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
