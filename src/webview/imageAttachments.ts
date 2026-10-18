import { t } from "../i18n";
import type { DraftImage, ImageAttachment } from "../attachmentTypes";
import { draftPreviewData, imageThumbnailData, cacheImageThumbnail } from "../draftImagePreview";

export function showDraftPreview(image: DraftImage): boolean {
  const data = draftPreviewData(image);
  if (!data) return false;
  showImagePreview(data);
  return true;
}

export interface ImageTarget { rowId: number; entityId: string }
export const CLOSE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const IMAGE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><path d="m3 11 3-3 2 2 2-3 3 4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

function thumbnailElement(button: HTMLElement, data: string): void {
  let img=button.querySelector("img");
  if (!img) { img=document.createElement("img"); img.alt=""; button.querySelector("svg")?.remove(); button.prepend(img); }
  img.src=data;
}
const thumbnailJobs: Array<()=>Promise<void>>=[];
let thumbnailActive=0;
function pumpThumbnails(): void {
  while (thumbnailActive<2 && thumbnailJobs.length) {
    const job=thumbnailJobs.shift()!; thumbnailActive++;
    void job().finally(()=>{thumbnailActive--;pumpThumbnails();});
  }
}
const visibleThumbnails=new WeakMap<Element,()=>void>();
const thumbnailObserver=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting || !entry.target.isConnected){thumbnailObserver.unobserve(entry.target);if(entry.target.isConnected)visibleThumbnails.get(entry.target)?.();visibleThumbnails.delete(entry.target);}
});

export function clearMessageThumbnailLoads(): void { thumbnailObserver.disconnect(); thumbnailJobs.length=0; }

export function renderMessageImages(
  el: HTMLElement,
  images: ImageAttachment[],
  onPreview: (image: ImageAttachment, index: number) => void,
  loadThumbnail: (image: ImageAttachment, index: number) => Promise<string | undefined>,
): void {
  const old=el.querySelector(".user-images");
  old?.querySelectorAll("button").forEach(button=>thumbnailObserver.unobserve(button));
  old?.remove();
  if (!images.length) return;
  const group = document.createElement("div");
  group.className = "user-images";
  images.forEach((image, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-chip";
    button.innerHTML = IMAGE;
    const label = document.createElement("span");
    label.textContent = image.fileName;
    label.className = "image-name";
    button.append(label);
    const thumbnail=imageThumbnailData(image);
    if(thumbnail)thumbnailElement(button,thumbnail);
    else {
      visibleThumbnails.set(button,()=>{thumbnailJobs.push(async()=>{
        if(!button.isConnected)return;
        try { const data=await loadThumbnail(image,index); if(data){cacheImageThumbnail(image,data);if(button.isConnected)thumbnailElement(button,data);} } catch { /* Keep the accessible placeholder and preview action. */ }
      });pumpThumbnails();});thumbnailObserver.observe(button);
    }
    button.title = `${t("查看图片")} · ${image.fileName}`;
    button.setAttribute("aria-label",button.title);
    button.addEventListener("click", () => onPreview(image, index));
    group.append(button);
  });
  el.prepend(group);
}

export function renderDraftImages(
  row: HTMLElement,
  images: DraftImage[],
  onRemove: (id: string) => void,
  onPreview: (image: DraftImage) => void,
): void {
  row.replaceChildren();
  for (const image of images) {
    const chip = document.createElement("div");
    chip.className = "image-chip";
    chip.dataset.status = image.status;
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "image-preview-btn";
    preview.disabled = image.status !== "ready" || !image.ref;
    preview.addEventListener("click", () => onPreview(image));
    if (image.thumbnail) {
      const img = document.createElement("img");
      img.src = image.thumbnail;
      img.alt = "";
      preview.append(img);
    } else preview.innerHTML = IMAGE;
    const label = document.createElement("span");
    label.textContent = image.status === "ready" ? image.fileName
      : image.status === "uploading" ? t("添加图片中…") : t("图片添加失败，请重新添加。");
    chip.title = image.status === "ready" ? image.fileName : `${label.textContent} · ${image.fileName}`;
    label.className = "image-name";
    preview.append(label);
    preview.title = preview.disabled ? chip.title : `${t("查看图片")} · ${image.fileName}`;
    preview.setAttribute("aria-label", preview.title);
    chip.append(preview);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.innerHTML = CLOSE;
    remove.setAttribute("aria-label", `${t("移除图片")} · ${image.fileName}`);
    remove.onclick = () => onRemove(image.id);
    chip.append(remove);
    row.append(chip);
  }
}

/** Only a small raster thumbnail enters persisted drafts; full bytes are transient. */
export async function imageThumbnail(dataUrl: string): Promise<string | undefined> {
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    // Three to four device pixels per displayed pixel, with the existing draft
    // size limit. Dense images fall back gradually instead of failing uploads.
    for (const [edge, quality] of [[320, 0.85], [240, 0.8], [160, 0.75], [120, 0.7]]) {
      const scale = Math.min(1, edge / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      const thumbnail = canvas.toDataURL("image/webp", quality);
      if (thumbnail.length <= 65536) return thumbnail;
    }
    return undefined;
  } catch { return undefined; }
}

export function showImagePreview(dataUrl: string): void {
  document.getElementById("image-preview")?.remove();
  const previous = document.activeElement as HTMLElement | null;
  const overlay = document.createElement("div");
  overlay.id = "image-preview";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", t("查看图片"));
  // Inline the layout-critical styles: some webview CSS parsers have dropped
  // rules from the bundled stylesheet, which collapsed this overlay.
  overlay.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:0;z-index:200;background:var(--vscode-editor-background);display:flex;align-items:center;justify-content:center;padding:32px;";
  const image = document.createElement("img");
  image.src = dataUrl;
  image.alt = t("查看图片");
  image.draggable = false;
  image.style.transformOrigin = "center center";

  // Zoom and pan: wheel zooms towards the pointer, dragging pans, and the
  // controls offer discrete steps. Scale 1 is the fit-to-window size, including
  // images smaller than the preview.
  let scale = 1, tx = 0, ty = 0;
  let fit = true;
  let baseW = 0, baseH = 0;
  const MIN = 0.1, MAX = 8;
  const controls = document.createElement("div");
  controls.className = "image-zoom";
  const zoomOut = document.createElement("button");
  zoomOut.type = "button"; zoomOut.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  zoomOut.setAttribute("aria-label", t("缩小"));
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "image-zoom-label"; zoomLabel.textContent = "100%";
  const zoomIn = document.createElement("button");
  zoomIn.type = "button"; zoomIn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  zoomIn.setAttribute("aria-label", t("放大"));
  const zoomFit = document.createElement("button");
  zoomFit.type = "button"; zoomFit.className = "image-zoom-fit"; zoomFit.textContent = t("适应窗口");
  zoomFit.setAttribute("aria-label", t("适应窗口"));
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1" stroke="currentColor" stroke-width="1.4"/></svg>';
  copyBtn.setAttribute("aria-label", t("复制图片"));
  zoomOut.style.cssText = "position:static;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--vscode-foreground);cursor:pointer;";
  zoomIn.style.cssText = zoomOut.style.cssText;
  zoomFit.style.cssText = "position:static;width:auto;min-width:0;flex:0 0 auto;display:inline-flex;align-items:center;padding:0 10px;height:26px;border:0;border-radius:999px;background:transparent;color:var(--vscode-foreground);cursor:pointer;font-size:11px;white-space:nowrap;";
  zoomLabel.style.cssText = "min-width:52px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums;color:var(--z-muted, var(--vscode-foreground));user-select:none;";
  controls.style.cssText = "position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:4px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.25);";
  copyBtn.style.cssText = zoomOut.style.cssText;
  copyBtn.onclick = async () => {
    // Copy the original bytes, not the zoomed canvas: the clip stays exact.
    // VS Code's clipboard API is text-only, so this webview path is the only
    // image route; a failure surfaces as a toast instead of silence.
    let ok = false;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        // fetch() on data: URLs is blocked in webviews; decode via atob instead.
        const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
        if (match) {
          const bytes = Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0));
          const blob = new Blob([bytes], { type: match[1] });
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          ok = true;
        }
      }
    } catch { ok = false; }
    window.dispatchEvent(new MessageEvent("message", { data: { type: "toast", text: t(ok ? "图片已复制" : "复制图片失败") } }));
  };
  controls.append(zoomOut, zoomLabel, zoomIn, zoomFit, copyBtn);

  const fitToWindow = () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const rect = overlay.getBoundingClientRect();
    const availW = Math.max(1, rect.width - 64);
    const availH = Math.max(1, rect.height - 120);
    const nw = image.naturalWidth || availW;
    const nh = image.naturalHeight || availH;
    const ratio = Math.min(availW / nw, availH / nh);
    baseW = Math.max(1, nw * ratio);
    baseH = Math.max(1, nh * ratio);
    image.style.width = `${baseW}px`;
    image.style.height = `${baseH}px`;
    image.style.maxWidth = "none";
    image.style.maxHeight = "none";
  };
  const paint = () => {
    if (fit) fitToWindow();
    image.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    image.classList.toggle("pannable", scale !== 1 || tx !== 0 || ty !== 0);
  };
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const next = Math.min(MAX, Math.max(MIN, scale * factor));
    if (next === scale) return;
    const rect = overlay.getBoundingClientRect();
    const mx = cx - rect.left - rect.width / 2;
    const my = cy - rect.top - rect.height / 2;
    const ratio = next / scale;
    tx = mx - (mx - tx) * ratio;
    ty = my - (my - ty) * ratio;
    scale = next;
    fit = false;
    paint();
  };
  const reset = () => { scale = 1; tx = 0; ty = 0; fit = true; paint(); };
  const naturalSize = () => {
    if (!baseW) fitToWindow();
    const next = image.naturalWidth && baseW ? image.naturalWidth / baseW : 1;
    scale = Math.min(MAX, Math.max(MIN, next));
    tx = 0; ty = 0; fit = false;
    paint();
  };
  const zoomFromCenter = (factor: number) => {
    const rect = overlay.getBoundingClientRect();
    zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };
  zoomOut.onclick = () => zoomFromCenter(1 / 1.25);
  zoomIn.onclick = () => zoomFromCenter(1.25);
  zoomFit.onclick = reset;
  overlay.addEventListener("wheel", event => {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
  }, { passive: false });
  image.addEventListener("dblclick", () => { if (fit) naturalSize(); else reset(); });
  let drag: { x: number; y: number } | null = null;
  image.addEventListener("pointerdown", event => {
    drag = { x: event.clientX - tx, y: event.clientY - ty };
    image.setPointerCapture(event.pointerId);
  });
  image.addEventListener("pointermove", event => {
    if (!drag) return;
    tx = event.clientX - drag.x;
    ty = event.clientY - drag.y;
    fit = false;
    paint();
  });
  image.addEventListener("pointerup", () => { drag = null; });
  image.addEventListener("pointercancel", () => { drag = null; });

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toolbar-btn";
  close.innerHTML = CLOSE;
  close.setAttribute("aria-label", t("关闭图片预览"));
  const onResize = () => { if (overlay.isConnected && fit) paint(); };
  window.addEventListener("resize", onResize);
  const dismiss = () => {
    window.removeEventListener("resize", onResize);
    overlay.remove();
    (previous?.isConnected ? previous : document.getElementById("input"))?.focus();
  };
  close.onclick = dismiss;
  overlay.onclick = event => { if (event.target === overlay) dismiss(); };
  overlay.onkeydown = event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
    else if (event.key === "Tab") { event.preventDefault(); close.focus(); }
  };
  image.addEventListener("load", paint);
  overlay.append(image, close, controls);
  document.body.append(overlay);
  paint();
  close.focus();
}

/** Update extension-owned labels without touching attachment names or chat text. */
export function refreshImageLabels(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".user-images button")) {
    button.title = `${t("查看图片")} · ${button.querySelector("span")?.textContent || ""}`;
  }
  const preview = document.getElementById("image-preview");
  preview?.setAttribute("aria-label", t("查看图片"));
  preview?.querySelector("button")?.setAttribute("aria-label", t("关闭图片预览"));
  const image = preview?.querySelector("img");
  if (image) image.alt = t("查看图片");
}
