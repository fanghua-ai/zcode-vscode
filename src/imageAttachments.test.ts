import assert from "node:assert/strict";
import test from "node:test";
import { decodeImage, uploadImage } from "./imageAttachments";
import { draftImages, readImageAttachments, IMAGE_MAX_BYTES } from "./attachmentTypes";
import { ComposerDrafts } from "./composerDrafts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGMM6LnDgA0wYRUdtBIAWtsByEY277MAAAAASUVORK5CYII=", "base64");
const attachment = { ref: "local-image-ref", fileName: "test.png", mime: "image/png", bytes: png.length };
test("image upload uses bounded chunks, checksum and the originating session", async () => {
  const bytes = Buffer.concat([png, Buffer.alloc(600000)]);
  const calls: {method:string; params:Record<string, unknown>}[] = [];
  const result = await uploadImage(async (method, params) => { calls.push({method,params}); return method.endsWith("commit") ? {ref: "committed-ref"} : {}; }, "A", "a/b.png", bytes);
  assert.equal(result.ref, "committed-ref"); assert.equal(result.fileName,"a_b.png");
  assert.deepEqual(calls.map(call => call.method), ["v4/attachment/begin","v4/attachment/chunk","v4/attachment/chunk","v4/attachment/commit"]);
  assert.ok(calls.every(call => call.params.sessionId === "A"));
  assert.match(String(calls[0].params.checksum), /^sha256:[0-9a-f]{64}$/);
  assert.equal(calls[0].params.totalChunks,2);
  assert.deepEqual(Buffer.concat(calls.filter(call => call.method.endsWith("chunk")).map(call => Buffer.from(String(call.params.dataBase64),"base64"))), bytes);
});
test("failed upload aborts without masking the original failure", async () => {
  const calls:string[]=[]; const failure=new Error("chunk failed");
  await assert.rejects(uploadImage(async method => {calls.push(method); if(method.endsWith("chunk") || method.endsWith("abort")) throw failure; return {};}, "A", "test.png", png), error => error === failure);
  assert.deepEqual(calls, ["v4/attachment/begin","v4/attachment/chunk","v4/attachment/abort"]);
});
test("image input rejects non-images, malformed base64 and oversized bytes", async () => {
  assert.deepEqual(decodeImage("data:image/png;base64,"+png.toString("base64")),png);
  for(const url of ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,YWJj", "data:image/png;base64,AAAA=", "https://example.org/a.png"]) assert.throws(() => decodeImage(url));
  await assert.rejects(uploadImage(async () => {throw new Error("must not call RPC");},"A","big.png",Buffer.concat([png,Buffer.alloc(IMAGE_MAX_BYTES)])), /20 MB/);
  assert.deepEqual(readImageAttachments([{...attachment,bytes:IMAGE_MAX_BYTES+1}]),[]);
});
test("image drafts survive reload, recover only to owner, and interrupted uploads become removable errors", () => {
  const drafts=new ComposerDrafts(undefined);
  const image={...attachment,id:"i1",sessionId:"A",status:"ready" as const};
  drafts.set("A","",[],[image]); drafts.set("B","B draft",[]);
  const restored=new ComposerDrafts(drafts.serialize());
  assert.deepEqual(restored.get("A").images,[image]);
  restored.set("A","new text",[]); restored.recover("A",{text:"",chips:[],images:[image]});
  assert.equal(restored.get("A").text,"new text"); assert.equal(restored.get("B").text,"B draft");
  assert.equal(draftImages([{...image,status:"uploading",ref:undefined}])[0].status,"error");
});
