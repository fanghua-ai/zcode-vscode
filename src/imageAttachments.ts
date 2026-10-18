import * as crypto from "crypto";
import { LocalizedError } from "./i18n";
import { IMAGE_MAX_BYTES, type ImageAttachment } from "./attachmentTypes";

export function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return "image/jpeg";
  const head = Buffer.from(bytes.subarray(0,12)).toString("ascii");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8,12)==="WEBP") return "image/webp";
  return null;
}

export function decodeImage(dataUrl: string): Buffer {
  if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 128) throw new LocalizedError("每张图片不能超过 20 MB。");
  const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[1].length % 4 !== 0) throw new LocalizedError("请选择 PNG、JPEG、WebP 或 GIF 图片。");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.toString("base64") !== match[1] || !imageMime(bytes)) throw new LocalizedError("请选择 PNG、JPEG、WebP 或 GIF 图片。");
  if (bytes.length > IMAGE_MAX_BYTES) throw new LocalizedError("每张图片不能超过 20 MB。");
  return bytes;
}

type Rpc = (method: string, params: Record<string, unknown>, timeout?: number) => Promise<unknown>;
const CHUNK = 512 * 1024;
/** Desktop protocol upload; sequential bounded chunks, checksum and abort on failure. */
export async function uploadImage(rpc: Rpc, sessionId: string, fileName: string, bytes: Buffer): Promise<ImageAttachment> {
  const mime = imageMime(bytes);
  if (!mime) throw new LocalizedError("请选择 PNG、JPEG、WebP 或 GIF 图片。");
  if (bytes.length > IMAGE_MAX_BYTES) throw new LocalizedError("每张图片不能超过 20 MB。");
  const name = fileName.replace(/[\\/\0\r\n]/g,"_").slice(0,255) || "image.png";
  const base = {connectionId:"zcode-vscode", uploadId:crypto.randomUUID(), sessionId};
  try {
    await rpc("v4/attachment/begin", {...base,fileName:name,mime,totalBytes:bytes.length,totalChunks:Math.ceil(bytes.length/CHUNK),checksum:"sha256:"+crypto.createHash("sha256").update(bytes).digest("hex")}, 20000);
    for (let offset=0,index=0;offset<bytes.length;offset+=CHUNK,index++) {
      await rpc("v4/attachment/chunk", {...base,chunkIndex:index,dataBase64:bytes.subarray(offset,offset+CHUNK).toString("base64")},20000);
    }
    const result = await rpc("v4/attachment/commit",base,20000) as {ref?:string};
    if (!result || typeof result.ref !== "string" || !result.ref) throw new LocalizedError("图片添加失败，请重新添加。");
    return {ref:result.ref,fileName:name,mime,bytes:bytes.length};
  } catch(error) {
    try {await rpc("v4/attachment/abort",base,5000);} catch { /* Preserve upload failure. */ }
    throw error;
  }
}

export async function readUploadedImage(
  rpc: Rpc, attachment: ImageAttachment, sessionId: string,
  selection?: {target: {rowId:number;entityId:string}; attachmentIndex:number},
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let offset = 0;
    let total: number | undefined;
    for (;;) {
      const result = await rpc("v4/attachment/read", {
        sessionId, ref: attachment.ref, offset, limit: 512 * 1024,
        ...(selection ? selection : {}),
      },20000) as {dataBase64:string;mediaType:string;totalBytes:number;nextOffset:number|null};
      if (!result || !Number.isSafeInteger(result.totalBytes) || result.totalBytes <= 0 || result.totalBytes > IMAGE_MAX_BYTES || result.mediaType !== attachment.mime || (total !== undefined && total !== result.totalBytes) || typeof result.dataBase64 !== "string") throw new LocalizedError("图片预览失败，请重试。");
      total = result.totalBytes;
      const chunk = Buffer.from(result.dataBase64,"base64");
      if (chunk.toString("base64") !== result.dataBase64 || chunk.length > 512 * 1024 || offset + chunk.length > result.totalBytes || (result.nextOffset !== null && result.nextOffset !== offset + chunk.length)) throw new LocalizedError("图片预览失败，请重试。");
      chunks.push(chunk); offset += chunk.length;
      if (result.nextOffset === null) {
        if (offset !== result.totalBytes) throw new LocalizedError("图片预览失败，请重试。");
        const bytes = Buffer.concat(chunks, offset);
        if (imageMime(bytes) !== attachment.mime) throw new LocalizedError("图片预览失败，请重试。");
        return bytes;
      }
      if (!chunk.length || chunks.length > 40) throw new LocalizedError("图片预览失败，请重试。");
    }
}
