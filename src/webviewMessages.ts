import { IMAGE_MAX_BYTES } from "./attachmentTypes";
import type { WebviewIn } from "./extension";

/**
 * Runtime gate for messages posted by the webview. The `WebviewIn` type is a
 * compile-time promise only, so every message is checked here before any
 * handler reads it: the message must be a plain object with a known `type`,
 * every known field must have the declared runtime kind and a bounded size,
 * and unknown fields are dropped. Arrays and records with a known shape
 * (attachments, patches, chips, ...) are checked element by element. The
 * free-form `chrome`, `defaults` and `content` payloads are only checked for
 * plain JSON values and total size/depth here; their keys are interpreted by
 * normalizeComposerChrome, normalizeNewSessionDefaults and the elicitation
 * answer path. Business rules (session ownership, path boundaries, image
 * decoding) stay with the individual handlers.
 */

type Kind = "string" | "longString" | "path" | "dataUrl" | "number" | "boolean" | "nullableString"
  | "settingsObject" | "formAnswer"
  | "fileUris" | "attachments" | "patches" | "fileChange" | "chips" | "chip" | "sessionRefs" | "stringList";

export const KNOWN_WEBVIEW_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "archiveSession", "attachFileUris", "copy", "copyDiagnostics", "deleteSession", "editLast",
  "fileReferenceDetails", "historyRenderTiming", "insert", "installMathFonts", "listSessions", "loadFileChanges",
  "loadOlder", "loadPreviewFiles", "loadThrough", "newSession", "openCommunity", "openDiff",
  "openFile", "openGitDiff", "openMarkdownFile", "openRecoverySettings", "permissionAnswer",
  "pickAttachments", "previewImage", "queueDelete", "queueEdit", "queueReorder", "queueSendNow",
  "ready", "renameSession", "responsePainted", "retry", "retryLast", "rewindFiles",
  "searchWorkspaceFiles", "selectModel", "send", "setChrome", "setLanguage", "setMode",
  "setNewSessionDefaults", "setThoughtLevel", "showLog", "stop", "switchSession",
  "thumbnailImage", "unarchiveSession", "uploadImage", "userInputAnswer",
]);

const FIELD_KINDS = {
  type: "string",
  timingId: "string", frameWaitMs: "number", historySyncMs: "number", historyFrameMs: "number",
  historyItemCount: "number", historyPreviousDomRows: "number", historyCurrentDomRows: "number",
  historyTruncated: "boolean", historyVisible: "boolean", historyRenderSource: "string",
  historyRenderMode: "string", renderSource: "string", sentAt: "number", setting: "string",
  attachments: "attachments", imageId: "string", maxImages: "number", attachmentIndex: "number",
  dataUrl: "dataUrl", uris: "fileUris", fileName: "string", language: "string", chrome: "settingsObject",
  defaults: "settingsObject", chromeKey: "string", enabled: "boolean", text: "longString",
  sessionId: "string", providerId: "string", modelId: "string", restart: "boolean",
  includeArchived: "boolean", listVisible: "boolean", requestId: "string", actionRequestId: "string", optionId: "string",
  mode: "string", planMode: "boolean", recoveryText: "longString", thoughtLevel: "string",
  viewGen: "number", title: "string", commit: "boolean", action: "string", content: "formAnswer",
  reason: "longString", path: "path", fileChange: "fileChange", previewCandidates: "stringList",
  signature: "string", fileChangesState: "string", chips: "chips", sessionRefs: "sessionRefs",
  chip: "chip", edit: "boolean", editRequestId: "string", line: "number", endLine: "number",
  immediate: "boolean", keepDraft: "boolean", queueItemId: "string",
  beforeQueueItemId: "nullableString", commandId: "string", oldestId: "string",
  messageId: "string", rowId: "number", entityId: "string", workspaceMode: "string",
  turnId: "string", patches: "patches", reverted: "boolean",
} as const satisfies { [K in keyof WebviewIn]-?: Kind };

const MAX_STRING = 64 * 1024;
const MAX_LONG_STRING = 16 * 1024 * 1024;
const MAX_PATH = 4096;
const MAX_DATA_URL = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 128;

const MAX_LIST = 100;
const MAX_DROPPED_URIS = 1000;
const MAX_ATTACHMENTS = 32;
const MAX_PATCHES = 10_000;
const MAX_PATCH_LINES = 200_000;

type JsonBudget = { maxDepth: number; maxNodes: number; maxChars: number };
const SETTINGS_BUDGET: JsonBudget = { maxDepth: 8, maxNodes: 1_000, maxChars: 64 * 1024 };
const FORM_ANSWER_BUDGET: JsonBudget = { maxDepth: 16, maxNodes: 10_000, maxChars: 1024 * 1024 };

/**
 * Plain JSON data only (no class instances or non-finite numbers), within the depth, node and character budget.
 * Every node is counted when it is queued, not when it is visited, so an oversized array is refused from its
 * length alone and an object stops at the first property past the budget; nothing larger than the budget is ever
 * queued or copied.
 */
function isBoundedJson(value: unknown, budget: JsonBudget): boolean {
  let reserved = 1;
  let chars = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item === "string") { chars += item.length; if (chars > budget.maxChars) return false; continue; }
    if (typeof item !== "object") return false;
    if (Array.isArray(item)) {
      if (!item.length) continue;
      if (depth + 1 > budget.maxDepth || reserved + item.length > budget.maxNodes) return false;
      reserved += item.length;
      for (let i = 0; i < item.length; i++) stack.push([item[i], depth + 1]);
      continue;
    }
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      chars += key.length;
      if (depth + 1 > budget.maxDepth || ++reserved > budget.maxNodes || chars > budget.maxChars) return false;
      stack.push([(item as Record<string, unknown>)[key], depth + 1]);
    }
  }
  return true;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isBoundedString = (value: unknown, max = MAX_STRING): value is string => typeof value === "string" && value.length <= max;
const isPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_PATH && !value.includes("\0");
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);

function isChip(value: unknown): boolean {
  return isRecord(value) && isPath(value.path) && isBoundedString(value.relPath, MAX_PATH) &&
    optional(value.selectedText, v => isBoundedString(v, MAX_LONG_STRING)) &&
    optional(value.snapshot, v => isBoundedString(v, MAX_LONG_STRING)) &&
    optional(value.selectionStart, isFiniteNumber) && optional(value.selectionEnd, isFiniteNumber);
}

function patchesOk(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_PATCHES) return false;
  let lines = 0;
  for (const patch of value) {
    if (!isRecord(patch) || !isFiniteNumber(patch.oldStart) || !isFiniteNumber(patch.oldLines) ||
        !isFiniteNumber(patch.newStart) || !isFiniteNumber(patch.newLines) || !Array.isArray(patch.lines)) return false;
    lines += patch.lines.length;
    if (lines > MAX_PATCH_LINES || !patch.lines.every(line => isBoundedString(line, MAX_LONG_STRING))) return false;
  }
  return true;
}

function fieldOk(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case "fileUris":
      // Drops may list many files; the handler attaches at most 20 of them.
      return Array.isArray(value) && value.length <= MAX_DROPPED_URIS &&
        value.every(uri => isBoundedString(uri, MAX_PATH) && /^file:/i.test(uri));
    case "attachments":
      // Refs are desktop attachment-store keys; malformed metadata is still filtered by readImageAttachments.
      return Array.isArray(value) && value.length <= MAX_ATTACHMENTS && value.every(item => isRecord(item) &&
        optional(item.ref, v => isBoundedString(v, MAX_PATH) && !v.includes("\0")) && optional(item.fileName, v => isBoundedString(v, 255)));
    case "patches": return patchesOk(value);
    case "fileChange":
      return isRecord(value) && isPath(value.path) && ["edit", "write", "read"].includes(value.kind as string) &&
        optional(value.before, v => isBoundedString(v, MAX_LONG_STRING)) && optional(value.after, v => isBoundedString(v, MAX_LONG_STRING)) &&
        optional(value.added, isFiniteNumber) && optional(value.removed, isFiniteNumber);
    case "chips": return Array.isArray(value) && value.length <= MAX_LIST && value.every(isChip);
    case "chip": return isChip(value);
    case "sessionRefs":
      return Array.isArray(value) && value.length <= MAX_LIST &&
        value.every(ref => isRecord(ref) && isBoundedString(ref.sessionId, 256) && isBoundedString(ref.title));
    case "stringList": return Array.isArray(value) && value.length <= MAX_LIST && value.every(item => isBoundedString(item));
    case "string": return typeof value === "string" && value.length <= MAX_STRING;
    case "longString": return typeof value === "string" && value.length <= MAX_LONG_STRING;
    case "path": return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH && !value.includes("\0");
    case "dataUrl": return typeof value === "string" && value.length <= MAX_DATA_URL;
    case "nullableString": return value === null || (typeof value === "string" && value.length <= MAX_STRING);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "settingsObject": return isRecord(value) && isBoundedJson(value, SETTINGS_BUDGET);
    case "formAnswer": return isBoundedJson(value, FORM_ANSWER_BUDGET);
  }
}

/** Fields a message type cannot do anything useful without; checked before dispatch. */
const REQUIRED_FIELDS: Readonly<Record<string, readonly (keyof WebviewIn)[]>> = {
  openFile: ["path"],
  openMarkdownFile: ["path", "sessionId"],
  openGitDiff: ["path", "patches"],
  openDiff: ["fileChange"],
  attachFileUris: ["uris", "sessionId"],
  uploadImage: ["dataUrl", "sessionId", "imageId"],
};

export type WebviewMessageRejection = { reason: "not-object" | "unknown-type" | "bad-field" | "missing-field"; field?: string };

/** Returns a sanitized copy of the message, or a rejection describing why it was dropped. */
export function parseWebviewMessage(raw: unknown): { ok: true; message: WebviewIn } | { ok: false; rejection: WebviewMessageRejection } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, rejection: { reason: "not-object" } };
  const source = raw as Record<string, unknown>;
  if (typeof source.type !== "string" || !KNOWN_WEBVIEW_MESSAGE_TYPES.has(source.type)) {
    return { ok: false, rejection: { reason: "unknown-type" } };
  }
  const message: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(FIELD_KINDS) as Array<[string, Kind]>) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    if (value === undefined) continue;
    if (value === null && kind !== "nullableString" && kind !== "formAnswer") continue;
    if (!fieldOk(kind, value)) return { ok: false, rejection: { reason: "bad-field", field } };
    message[field] = value;
  }
  for (const field of REQUIRED_FIELDS[source.type] ?? []) {
    if (message[field] === undefined) return { ok: false, rejection: { reason: "missing-field", field } };
  }
  return { ok: true, message: message as WebviewIn };
}
