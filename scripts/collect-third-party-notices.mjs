import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noticesPath = path.join(root, "THIRD-PARTY-NOTICES.txt");

function readText(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function installedPackage(name) {
  const manifest = JSON.parse(readText(path.join("node_modules", name, "package.json")));
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    homepage: manifest.homepage || "",
  };
}

function utf16BeNeedle(ascii) {
  const needle = Buffer.alloc(ascii.length * 2);
  for (let i = 0; i < ascii.length; i++) {
    needle[i * 2] = 0;
    needle[i * 2 + 1] = ascii.charCodeAt(i);
  }
  return needle;
}

function readUtf16BeAscii(data, start, end) {
  let text = "";
  for (let offset = start; offset + 1 < end; offset += 2) {
    if (data[offset] !== 0) break;
    const code = data[offset + 1];
    if (code === 0) break;
    text += code === 10 ? "\n" : code >= 32 && code <= 126 ? String.fromCharCode(code) : "";
    if (code < 32 && code !== 10) break;
  }
  return text;
}

function fontMetadata() {
  const dir = path.join(root, "node_modules", "katex", "dist", "fonts");
  const marker = utf16BeNeedle("Reserved Font Name ");
  const copyright = utf16BeNeedle("Copyright (c) 2009-2010, Design Science");
  const names = new Set();
  const notices = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ttf")) continue;
    const data = readFileSync(path.join(dir, file));
    let index = 0;
    while ((index = data.indexOf(marker, index)) !== -1) {
      const name = readUtf16BeAscii(data, index + marker.length, index + marker.length + 80).split(".")[0];
      if (name) names.add(name);
      index += marker.length;
    }
    const copyrightAt = data.indexOf(copyright);
    if (copyrightAt >= 0) {
      const notice = readUtf16BeAscii(data, copyrightAt, copyrightAt + 800);
      const end = notice.indexOf("http://scripts.sil.org/OFL");
      if (end >= 0) notices.add(notice.slice(0, end + "http://scripts.sil.org/OFL".length));
    }
  }
  if (names.size === 0 || notices.size === 0) {
    throw new Error("Installed KaTeX fonts are missing reserved names or the SIL license notice");
  }
  return { names: [...names].sort(), notices: [...notices].sort() };
}

function sqliteUpstreamNotes() {
  const readme = readText(path.join("node_modules", "node-sqlite3-wasm", "README.md"));
  const basedOn = readme.match(/_node-sqlite3-wasm_ is currently based on SQLite \d+\.\d+\.\d+\./)?.[0];
  const licenseHeading = readme.indexOf("\n## License\n");
  if (!basedOn || licenseHeading < 0) {
    throw new Error("node-sqlite3-wasm README is missing the expected SQLite version or license section");
  }
  return {
    basedOn,
    licenseSection: readme.slice(licenseHeading).trim() + "\n",
  };
}

function block(label, text) {
  const body = text.replace(/\s+$/, "") + "\n";
  return `----- BEGIN ${label} -----\n${body}----- END ${label} -----\n`;
}

export function thirdPartyNoticeFragments() {
  const packages = {
    dompurify: installedPackage("dompurify"),
    highlight: installedPackage("highlight.js"),
    marked: installedPackage("marked"),
    katex: installedPackage("katex"),
    sqlite: installedPackage("node-sqlite3-wasm"),
  };
  const fonts = fontMetadata();
  const sqlite = sqliteUpstreamNotes();
  const fragments = [
    readText("node_modules/dompurify/LICENSE"),
    readText("node_modules/dompurify/LICENSE-MPL"),
    readText("node_modules/highlight.js/LICENSE"),
    readText("node_modules/marked/LICENSE.md"),
    readText("node_modules/katex/LICENSE"),
    readText("node_modules/node-sqlite3-wasm/LICENSE"),
    readText("scripts/third-party/OFL-1.1.txt"),
    readText("scripts/third-party/sqlite-public-domain.txt"),
    sqlite.licenseSection,
    sqlite.basedOn,
    "MPL-2.0 OR Apache-2.0",
    "This project does not elect either DOMPurify license.",
    "The installed package does not include a separate sql.js license file.",
  ];
  for (const item of Object.values(packages)) fragments.push(`${item.name} ${item.version}`);
  for (const name of fonts.names) fragments.push(`Reserved Font Name ${name}.`);
  for (const notice of fonts.notices) fragments.push(notice);
  return { packages, fonts, sqlite, fragments };
}

export function renderThirdPartyNotices() {
  const { packages, fonts, sqlite } = thirdPartyNoticeFragments();
  const fontCopyright = fonts.notices.join("\n\n");
  const sections = [
    ["node_modules/dompurify/LICENSE", readText("node_modules/dompurify/LICENSE")],
    ["node_modules/dompurify/LICENSE-MPL", readText("node_modules/dompurify/LICENSE-MPL")],
    ["node_modules/highlight.js/LICENSE", readText("node_modules/highlight.js/LICENSE")],
    ["node_modules/marked/LICENSE.md", readText("node_modules/marked/LICENSE.md")],
    ["node_modules/katex/LICENSE", readText("node_modules/katex/LICENSE")],
    ["node_modules/node-sqlite3-wasm/LICENSE", readText("node_modules/node-sqlite3-wasm/LICENSE")],
    ["scripts/third-party/OFL-1.1.txt", readText("scripts/third-party/OFL-1.1.txt")],
    ["scripts/third-party/sqlite-public-domain.txt", readText("scripts/third-party/sqlite-public-domain.txt")],
    ["node_modules/node-sqlite3-wasm/README.md license section", sqlite.licenseSection],
  ];

  return `第三方声明 / Third-party notices
=====================================

本文件由 scripts/collect-third-party-notices.mjs 根据当前安装的依赖许可原文生成。请勿手工修改；依赖升级后重新构建即可刷新。
This file is generated by scripts/collect-third-party-notices.mjs from the license texts of the currently installed dependencies. Do not edit it by hand; rebuild after a dependency upgrade.

根目录 LICENSE 只覆盖本项目和其中已写明的 Lucide 图标。它不能代替下面这些作品的许可。
The LICENSE file covers this project and the Lucide icon attribution written there. It does not replace the notices below.

已安装版本 / Installed versions
-------------------------------

${Object.values(packages).map(item => `- ${item.name} ${item.version}`).join("\n")}

包含方式 / How each work is included
------------------------------------

- DOMPurify ${packages.dompurify.version} (${packages.dompurify.homepage})
  打包进 dist/webview.js，用于 HTML 净化。许可是 MPL-2.0 OR Apache-2.0。本项目不选择其中之一；两份全文都附在下面，接收方可以任选。
  Bundled into dist/webview.js for HTML sanitization. License: MPL-2.0 OR Apache-2.0. This project does not elect either DOMPurify license. Both full texts are included below, and a recipient may choose either.

- highlight.js ${packages.highlight.version} (${packages.highlight.homepage})
  打包进 dist/webview.js，用于语法高亮。许可是 BSD-3-Clause。全文来自该依赖自带的 LICENSE。
  Bundled into dist/webview.js for syntax highlighting. License: BSD-3-Clause. The full text is the LICENSE shipped with that dependency.

- marked ${packages.marked.version} (${packages.marked.homepage})
  打包进 dist/webview.js，用于 Markdown。下面附上完整 LICENSE.md，包括 Markdown 相关说明，不只摘主许可名称。
  Bundled into dist/webview.js for Markdown. The complete LICENSE.md is included below, including its Markdown notice, not only the main license name.

- KaTeX ${packages.katex.version} (${packages.katex.homepage})
  渲染器打包进 dist/webview.js。样式和 WOFF2 字体复制到 dist/math/。软件许可是 MIT，同一文本也保留为 dist/math/LICENSE。字体是 SIL Open Font License 1.1；发布包只带 WOFF2，许可仍适用于这些字体。Reserved Font Name 来自当前安装字体的元数据，不是另行推断。
  The renderer is bundled into dist/webview.js. The stylesheet and WOFF2 fonts are copied to dist/math/. The software license is MIT, and the same text is also kept as dist/math/LICENSE. The fonts are under the SIL Open Font License 1.1; the package ships WOFF2 only, and that license still applies to those fonts. Reserved Font Names come from the installed font metadata, not from a separate guess.

- node-sqlite3-wasm ${packages.sqlite.version} (${packages.sqlite.homepage})
  dist/node-sqlite3-wasm.js 和 dist/node-sqlite3-wasm.wasm 是复制而非打包。包装层许可是 MIT，版权人为 Tobias Enderle。${sqlite.basedOn} 上游 README 写明部分代码来自 sql.js（同样是 MIT），SQLite 处于公有领域。当前安装的包没有单独附带 sql.js 许可文件，因此这里只保留上游说明，不另补一份无法对应版本的 sql.js 许可文本。
  dist/node-sqlite3-wasm.js and dist/node-sqlite3-wasm.wasm are copied rather than bundled. The wrapper license is MIT, copyright Tobias Enderle. ${sqlite.basedOn} The upstream README says parts of the code come from sql.js, also under the MIT license, and that SQLite is in the public domain. The installed package does not include a separate sql.js license file. This notice keeps the upstream statement and does not add a sql.js license text whose version cannot be identified.

字体元数据原文 / Font metadata
------------------------------

${fontCopyright}

Reserved Font Names:
${fonts.names.map(name => `- ${name}`).join("\n")}

许可原文 / License texts
------------------------

${sections.map(([label, text]) => block(label, text)).join("\n")}
`;
}

export function writeThirdPartyNotices() {
  const next = renderThirdPartyNotices();
  writeFileSync(noticesPath, next);
  return noticesPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeThirdPartyNotices();
  console.log(`Wrote ${path.relative(root, noticesPath)}`);
}
