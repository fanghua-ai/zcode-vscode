import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/pack-math-fonts.mjs <zip>");
  process.exit(1);
}
const directory = mkdtempSync(path.join(tmpdir(), "zcode-math-pack-"));
try {
  const outfile = path.join(directory, "pack.cjs");
  await build({
    entryPoints: ["src/mathFonts.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { buildMathFontPack, sha256Hex } = createRequire(import.meta.url)(outfile);
  const zip = buildMathFontPack();
  writeFileSync(target, zip);
  console.log(`${sha256Hex(zip)}  ${target}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
