import * as fs from "fs";
import * as path from "path";
import { realpathAllowMissing, resolveFileTarget } from "./workspaceFiles";

export type PreviewFile = { path: string; name: string; kind: string; extension: string };

const previewExtensions: Record<string, string> = {
  md: "markdown", html: "html", htm: "html", docx: "document", xlsx: "spreadsheet",
  pptx: "presentation", pdf: "pdf", mp4: "video", mov: "video", webm: "video",
  m4v: "video", mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio",
  opus: "audio", flac: "audio", weba: "audio",
};

/**
 * Resolve model-provided paths only inside the active workspace, after symlinks. The boundary rules are the
 * shared ones in workspaceFiles.ts (plain paths only, UNC and link-to-share checks on Windows); unlike the
 * open-file commands there is no "open anyway" prompt, so anything outside the workspace is simply null.
 */
export function existingWorkspaceFile(
  root: string,
  filePath: string,
  platform: NodeJS.Platform = process.platform
): { absolute: string; relative: string } | null {
  if (!root) return null;
  const target = resolveFileTarget([root], filePath, platform);
  if (!target?.insideWorkspace) return null;
  try {
    const relative = path.relative(realpathAllowMissing(root), target.absolute);
    if (!relative || !fs.statSync(target.absolute).isFile()) return null;
    return { absolute: target.absolute, relative };
  } catch { return null; }
}

export function previewFileKind(filePath: string): { kind: string; extension: string } | null {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const kind = previewExtensions[extension];
  return kind ? { kind, extension: extension.toUpperCase() } : null;
}

/** Desktop's card rule: source-like Markdown/HTML must be active changes in this turn. */
export function previewFilesForReply(
  root: string,
  candidates: readonly string[],
  changedPaths: readonly string[],
  fileChangesState?: string,
): PreviewFile[] {
  const changed = new Set(changedPaths.map(file => existingWorkspaceFile(root, file)?.absolute).filter(Boolean));
  const seen = new Set<string>();
  const cards: PreviewFile[] = [];
  for (const candidate of candidates.slice(0, 15).reverse()) {
    const kind = previewFileKind(candidate);
    if (!kind) continue;
    const resolved = existingWorkspaceFile(root, candidate);
    if (!resolved || seen.has(resolved.absolute)) continue;
    if ((kind.kind === "markdown" || kind.kind === "html") &&
        (fileChangesState === "reverted" || !changed.has(resolved.absolute))) continue;
    seen.add(resolved.absolute);
    cards.push({ path: resolved.relative, name: path.basename(resolved.absolute), ...kind });
    if (cards.length === 10) break;
  }
  return cards;
}
