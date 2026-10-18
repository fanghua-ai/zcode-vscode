/** Matches the desktop v4 attachment metadata; bytes stay in the desktop store. */
export interface ImageAttachment {
  ref: string;
  fileName: string;
  mime: string;
  bytes: number;
}
export interface DraftImage {
  id: string;
  sessionId: string;
  fileName: string;
  mime: string;
  bytes: number;
  status: "uploading" | "ready" | "error";
  ref?: string;
  thumbnail?: string;
}
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 8;
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export function readImageAttachments(raw: unknown): ImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, IMAGE_MAX_COUNT).filter((item): item is ImageAttachment =>
    !!item && typeof item === "object" && typeof item.ref === "string" && !!item.ref &&
    typeof item.fileName === "string" && item.fileName.length <= 255 &&
    IMAGE_MIMES.includes(item.mime) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= IMAGE_MAX_BYTES
  ).map(({ref, fileName, mime, bytes}) => ({ref, fileName, mime, bytes}));
}

export function draftImages(raw: unknown): DraftImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, IMAGE_MAX_COUNT * 2).filter(item => !!item && typeof item === "object" &&
    typeof item.id === "string" && typeof item.sessionId === "string" && typeof item.fileName === "string" &&
    IMAGE_MIMES.includes(item.mime) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= IMAGE_MAX_BYTES
  ).map(item => ({
    id: item.id, sessionId: item.sessionId, fileName: item.fileName.slice(0,255), mime: item.mime, bytes: item.bytes,
    status: item.status === "ready" && typeof item.ref === "string" && item.ref ? "ready" : "error",
    ...(item.status === "ready" && typeof item.ref === "string" ? {ref:item.ref} : {}),
    ...(typeof item.thumbnail === "string" && item.thumbnail.length <= 65536 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(item.thumbnail) ? {thumbnail:item.thumbnail} : {}),
  }));
}
