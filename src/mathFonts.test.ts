import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import {
  MATH_FONT_FACES, MATH_FONTS_SHA256, MATH_FONTS_URL, buildMathFontPack, fetchMathFontPack,
  formulaFontMode, installMathFontPack, mathFontDataHref, mathFontFaceCss, mathFontPackReady, mathFontSourceUrl,
  readZip, sha256Hex, storeZip,
} from "./mathFonts";

test("the pinned formula font pack matches the installed KaTeX files", () => {
  const zip = buildMathFontPack();
  assert.equal(sha256Hex(zip), MATH_FONTS_SHA256);
  assert.equal(MATH_FONTS_URL, "https://github.com/fanghua-ai/zcode-vscode/releases/download/math-fonts-0.19.0/katex-0.19.0-woff2.zip");
  const names = readZip(zip).map(entry => entry.name).sort();
  assert.deepEqual(names, ["LICENSE", "OFL.txt", ...MATH_FONT_FACES.map(face => `fonts/${face.file}`)].sort());
});

test("inlined formula fonts stay inside the webview style rules", () => {
  const css = mathFontFaceCss(file => mathFontDataHref(readFileSync(path.join("node_modules/katex/dist/fonts", file))));
  assert.equal((css.match(/@font-face\{/g) || []).length, MATH_FONT_FACES.length);
  assert.match(css, /src:url\("data:font\/woff2;base64,/);
  assert.doesNotMatch(css, /[<>]|@import|expression\s*\(/i);
});

test("formula font mode only accepts the three settings", () => {
  assert.equal(formulaFontMode("on"), "on");
  assert.equal(formulaFontMode("off"), "off");
  assert.equal(formulaFontMode("auto"), "auto");
  assert.equal(formulaFontMode("yes"), "auto");
  assert.equal(mathFontSourceUrl({}), MATH_FONTS_URL);
  assert.equal(mathFontSourceUrl({ ZCODE_MATH_FONTS_URL: " http://127.0.0.1:9/fonts.zip " }), "http://127.0.0.1:9/fonts.zip");
});

test("installing the formula font pack checks the hash, paths and required files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-math-fonts-"));
  try {
    const destination = path.join(root, "0.19.0");
    const zip = buildMathFontPack();
    await installMathFontPack(zip, destination, MATH_FONTS_SHA256);
    assert.equal(mathFontPackReady(destination, MATH_FONTS_SHA256), true);
    assert.equal(await readFile(path.join(destination, "LICENSE"), "utf8"), await readFile("node_modules/katex/LICENSE", "utf8"));
    assert.equal(await readFile(path.join(destination, "OFL.txt"), "utf8"), await readFile("scripts/third-party/OFL-1.1.txt", "utf8"));
    const css = mathFontFaceCss(file => `vscode-webview://fonts/${file}`);
    assert.match(css, /font-family:"KaTeX_Main"/);
    assert.match(css, /url\("vscode-webview:\/\/fonts\/KaTeX_Size4-Regular\.woff2"\)/);
    assert.doesNotMatch(css, /@import|<|expression\s*\(/i);
    assert.throws(() => mathFontFaceCss(() => 'bad")'));

    const changed = Uint8Array.from(zip);
    changed[30] ^= 0xff;
    await assert.rejects(() => installMathFontPack(changed, path.join(root, "tampered"), MATH_FONTS_SHA256), /hash mismatch/);
    assert.equal(existsSync(path.join(root, "tampered")), false);

    const truncated = zip.subarray(0, 80);
    await assert.rejects(() => installMathFontPack(truncated, path.join(root, "truncated"), sha256Hex(truncated)), /truncated|unexpected size|invalid/);
    const escaped = storeZip([{ name: "../escaped.woff2", data: Buffer.from("nope") }]);
    await assert.rejects(() => installMathFontPack(escaped, path.join(root, "escaped"), sha256Hex(escaped)), /unsafe|unexpected|incomplete/);
    assert.equal(existsSync(path.join(root, "escaped.woff2")), false);
    const partial = storeZip([{ name: "fonts/KaTeX_Main-Regular.woff2", data: Buffer.from("not-a-font") }]);
    await assert.rejects(() => installMathFontPack(partial, path.join(root, "partial"), sha256Hex(partial)), /incomplete/);
    assert.equal(existsSync(path.join(root, "partial")), false);
    assert.equal(mathFontPackReady(destination, "0".repeat(64)), false);
    const font = path.join(destination, "fonts", "KaTeX_Main-Regular.woff2");
    const original = await readFile(font);
    await writeFile(font, Buffer.from("not-a-font"));
    assert.equal(mathFontPackReady(destination, MATH_FONTS_SHA256), false);
    await installMathFontPack(zip, destination, MATH_FONTS_SHA256);
    assert.equal(mathFontPackReady(destination, MATH_FONTS_SHA256), true);
    assert.equal(Buffer.compare(await readFile(font), original), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent formula font installs do not remove each other's directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-math-fonts-race-"));
  try {
    const destination = path.join(root, "0.19.0");
    const zip = buildMathFontPack();
    const sharedStaging = `${destination}.staging`;
    const sharedBackup = `${destination}.backup`;
    await mkdir(sharedStaging, { recursive: true });
    await mkdir(sharedBackup, { recursive: true });
    await writeFile(path.join(sharedStaging, "keep"), "staging");
    await writeFile(path.join(sharedBackup, "keep"), "backup");
    const installTogether = async () => {
      let waiting = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const beforeCommit = async () => {
        waiting += 1;
        if (waiting === 2) release();
        await gate;
      };
      await Promise.all([
        installMathFontPack(zip, destination, MATH_FONTS_SHA256, { beforeCommit }),
        installMathFontPack(zip, destination, MATH_FONTS_SHA256, { beforeCommit }),
      ]);
    };
    for (let round = 0; round < 20; round++) {
      await installTogether();
      assert.equal(mathFontPackReady(destination, MATH_FONTS_SHA256), true);
      const font = path.join(destination, "fonts", "KaTeX_Main-Regular.woff2");
      await writeFile(font, Buffer.from("not-a-font"));
      assert.equal(mathFontPackReady(destination, MATH_FONTS_SHA256), false);
      await installTogether();
      assert.equal(mathFontPackReady(destination, MATH_FONTS_SHA256), true);
    }
    const font = path.join(destination, "fonts", "KaTeX_Main-Regular.woff2");
    await writeFile(font, Buffer.from("not-a-font"));
    const first = installMathFontPack(zip, destination, MATH_FONTS_SHA256);
    await installMathFontPack(zip, destination, MATH_FONTS_SHA256, { beforeCommit: () => first });
    assert.equal(mathFontPackReady(destination, MATH_FONTS_SHA256), true);
    assert.equal(await readFile(path.join(sharedStaging, "keep"), "utf8"), "staging");
    assert.equal(await readFile(path.join(sharedBackup, "keep"), "utf8"), "backup");
    const leftovers = (await readdir(root)).filter(name => name.includes(".staging.") || name.includes(".backup."));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formula font downloads reject the wrong protocol, status and size", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/fonts.zip") {
      const body = Buffer.from("pack");
      response.writeHead(200, { "content-type": "application/zip", "content-length": String(body.length) });
      response.end(body);
      return;
    }
    if (request.url === "/missing") {
      response.writeHead(404);
      response.end("missing");
      return;
    }
    response.writeHead(200, { "content-length": "2000000" });
    response.end("small");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(Buffer.from(await fetchMathFontPack(`${base}/fonts.zip`)), Buffer.from("pack"));
    await assert.rejects(() => fetchMathFontPack(`${base}/missing`), /failed \(404\)/);
    await assert.rejects(() => fetchMathFontPack(`${base}/huge`), /too large/);
    await assert.rejects(() => fetchMathFontPack("file:///tmp/fonts.zip"), /http or https/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


function deflateZip(name: string, data: Buffer, declaredSize = data.length): Buffer {
  const compressed = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const checksum = crc32(data) >>> 0;
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

test("deflated formula font entries cannot expand past their declared size", () => {
  const payload = Buffer.alloc(1000, 7);
  assert.equal(readZip(deflateZip("fonts/face.woff2", payload))[0].data.equals(payload), true);
  assert.throws(() => readZip(deflateZip("fonts/face.woff2", payload, 10)), /invalid/);
});
