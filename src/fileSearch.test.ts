import test from "node:test";
import assert from "node:assert/strict";
import { rankWorkspaceFiles, workspaceSearchPatterns } from "./fileSearch";
test("workspace mentions rank exact names before prefixes and support paths, Unicode and hidden files", () => {
 const files = ["src/main.test.ts","src/main.ts",".vscode/settings.json","文档/说明.md","lib/domain.ts","src/main.tsx"];
 assert.equal(rankWorkspaceFiles(files,"main.ts")[0],"src/main.ts");
 assert.deepEqual(rankWorkspaceFiles(files,".vscode/"),[".vscode/settings.json"]);
 assert.deepEqual(rankWorkspaceFiles(files,"说明"),["文档/说明.md"]);
 assert.deepEqual(rankWorkspaceFiles(files,"SRC\\MAIN.TS",1),["src/main.ts"]);
 assert.deepEqual(rankWorkspaceFiles(files,"no such file"),[]);
 assert.equal(rankWorkspaceFiles(files,"",2).length,2);
});

test("fuzzy filenames and recent navigation preserve exact-match priority", () => {
 const files=["src/zcodeClient.ts","src/zcodeClient.test.ts","lib/zoo.ts","main.ts"];
 assert.equal(rankWorkspaceFiles(files,"zcl")[0],"src/zcodeClient.ts");
 assert.equal(rankWorkspaceFiles(files,"",40,["src/zcodeClient.ts"])[0],"src/zcodeClient.ts");
 assert.equal(rankWorkspaceFiles(files,"main.ts",40,["src/zcodeClient.ts"])[0],"main.ts");
 const patterns=workspaceSearchPatterns("src/m[1].ts");assert.equal(patterns.length,3);assert.ok(patterns[0].includes('[[]1[]]'));assert.ok(patterns[1].includes('/**/'));
 assert.deepEqual(workspaceSearchPatterns(""),["**/*"]);
 assert.ok(workspaceSearchPatterns(".vscode/").every(pattern=>pattern.endsWith("/**/*")));
});
