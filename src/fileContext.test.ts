import assert from "node:assert/strict";
import test from "node:test";
import { prepareFileContext } from "./fileContext";
import { buildPrompt } from "./promptContext";
const doc={uri:{fsPath:"/project/a.ts"},isDirty:true,languageId:"typescript",getText:()=>"latest unsaved content"};
test("file mentions use the latest unsaved buffer while explicit selections remain captured",()=>{
 const file={path:"/project/a.ts",relPath:"a.ts",snapshot:"old content"};
 const selection={...file,selectionStart:1,selectionEnd:1,selectedText:"captured selection",snapshot:undefined};
 const chips=prepareFileContext([file,selection],"/project",[doc]);
 assert.equal(chips[0].snapshot,"latest unsaved content");assert.equal(file.snapshot,"old content");
 assert.equal(chips[1].selectedText,"captured selection");assert.equal(chips[1].snapshot,undefined);
 assert.ok(buildPrompt("q",chips).includes("latest unsaved content"));
});
test("saved files discard stale snapshots and other workspace roots resolve from the actual session root",()=>{
 const chips=prepareFileContext([{path:"/project/a.ts",relPath:"workspace/a.ts",snapshot:"stale"},{path:"/other/b.ts",relPath:"other-root/b.ts"}],"/project",[{...doc,isDirty:false}]);
 assert.equal(chips[0].snapshot,undefined);assert.equal(chips[0].relPath,"a.ts");assert.equal(chips[1].relPath,"../other/b.ts");
});
test("oversized unsaved files reject sending rather than silently using old disk content",()=>{
 assert.throws(()=>prepareFileContext([{path:doc.uri.fsPath,relPath:"a.ts"}],"/project",[{...doc,getText:()=>"a".repeat(1024*1024+1)}]));
});
