import { IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, type DraftImage, type ImageAttachment } from "./attachmentTypes";

// Full image data is transient and bounded; persisted drafts keep thumbnails only.
const draftPreviews = new Map<string, string>();
const PREVIEW_BUDGET = Math.ceil(IMAGE_MAX_BYTES * 4 / 3) * 2 + 256;
let previewBytes = 0;
export function forgetDraftPreview(id: string): void {
  const data = draftPreviews.get(id);
  if (data) previewBytes -= data.length;
  draftPreviews.delete(id);
}
export function cacheDraftPreview(id: string, dataUrl: string): void {
  forgetDraftPreview(id);
  if (dataUrl.length > PREVIEW_BUDGET) return;
  while (draftPreviews.size && (draftPreviews.size >= IMAGE_MAX_COUNT || previewBytes + dataUrl.length > PREVIEW_BUDGET)) {
    forgetDraftPreview(draftPreviews.keys().next().value!);
  }
  draftPreviews.set(id, dataUrl); previewBytes += dataUrl.length;
}
export function draftPreviewData(image: DraftImage): string | undefined {
  return draftPreviews.get(image.id) ?? image.thumbnail;
}

const thumbnails = new Map<string, string>();
const thumbnailKey = (image: ImageAttachment) => JSON.stringify([image.ref,image.mime,image.bytes]);
export function imageThumbnailData(image: ImageAttachment): string | undefined { return thumbnails.get(thumbnailKey(image)); }
export function cacheImageThumbnail(image: ImageAttachment, data: string): void {
  if (data.length > 65536 || !/^data:image\/(?:png|jpeg|webp);base64,/.test(data)) return;
  const key = thumbnailKey(image); thumbnails.delete(key);
  while (thumbnails.size >= 64) thumbnails.delete(thumbnails.keys().next().value!);
  thumbnails.set(key,data);
}
