import test from "node:test";
import assert from "node:assert/strict";
import { cacheDraftPreview, forgetDraftPreview, draftPreviewData } from "./draftImagePreview";
import { IMAGE_MAX_COUNT, type DraftImage } from "./attachmentTypes";

const image = (id: string): DraftImage => ({id,sessionId:"test",status:"ready",ref:"test-ref",fileName:"test.png",mime:"image/png",bytes:10,thumbnail:"THUMBNAIL"});
test("draft preview uses transient original data without adding it to serialized image metadata", () => {
  const draft = image("original"); cacheDraftPreview(draft.id,"ORIGINAL");
  assert.equal(draftPreviewData(draft),"ORIGINAL");
  assert.ok(!JSON.stringify(draft).includes("ORIGINAL"));
  forgetDraftPreview(draft.id); assert.equal(draftPreviewData(draft),"THUMBNAIL");
});
test("draft preview evicts old originals at its image limit and retains thumbnail fallback", () => {
  for(let index=0;index<=IMAGE_MAX_COUNT;index++)cacheDraftPreview(`bounded-${index}`,`ORIGINAL-${index}`);
  assert.equal(draftPreviewData(image("bounded-0")),"THUMBNAIL");
  assert.equal(draftPreviewData(image(`bounded-${IMAGE_MAX_COUNT}`)),`ORIGINAL-${IMAGE_MAX_COUNT}`);
  for(let index=0;index<=IMAGE_MAX_COUNT;index++)forgetDraftPreview(`bounded-${index}`);
});
