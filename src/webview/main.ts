import { cacheDraftPreview, forgetDraftPreview, cacheImageThumbnail } from "../draftImagePreview";
import { errorGuidance } from "../errorGuidance";
import { lucideIcon } from "../lucideIcons";
import { fileMentions, type MentionChoice } from "./fileMentions";
import { renderMessageImages, clearMessageThumbnailLoads, renderDraftImages, imageThumbnail, showImagePreview, showDraftPreview, refreshImageLabels, CLOSE, type ImageTarget } from "./imageAttachments";
import { readImageAttachments, IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, IMAGE_MIMES, type DraftImage, type ImageAttachment } from "../attachmentTypes";
import { greetingKey, nextGreetingDelay } from "../greeting";
import { EMPTY_LOGO } from "./emptyLogo";
import { t, setUiLanguage, getUiLanguage, resolveUiLanguage, relocalizeUiText, type LanguageSetting } from "../i18n";
import { ComposerDrafts, type ComposerDraft } from "../composerDrafts";
import { renderMarkdown } from "./markdown";
import { localMarkdownFileLink } from "../markdownFileLink";
import { QuestionAnswers } from "../userInput";
import type { FileChange } from "../toolFiles";
import { sameSessionModel, type NewSessionDefaults, type SessionModelChoice } from "../newSessionDefaults";
import { prettifyToolIo, splitZaiBuiltin, formatImageAnalysisOutput } from "../zaiBuiltin";
import {
  ContextChip,
  chipLabel,
  chipTitle,
  parsePromptDisplay,
  buildPrompt,
  stripSessionReferences,
  type SessionReference,
} from "../promptContext";
import type { ConversationTurn, ConversationView, GitFileChange, ConversationQueueItem } from "../conversation";
import {
  SESSION_MODES,
  localizeThoughtLevels,
  modeOption,
  permissionOptionKind,
  permissionOptionLabel,
  thoughtLabel,
  thoughtMark,
  modeIcon,
  type ThoughtOption,
} from "../sessionUi";

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  getState: () => Record<string, unknown> | undefined;
  setState: (state: Record<string, unknown>) => void;
};

type Session = {
  sessionId: string;
  title: string;
  status?: string;
  updatedAt?: number;
  archivedAt?: number;
  model?: { providerId: string; modelId: string };
};

type PickerModel = {
  providerId: string;
  modelId: string;
  label: string;
  providerName?: string;
  providerLabel?: string;
  hasKey?: boolean;
  disabledReason?: string;
};

function providerGroup(m: PickerModel): string {
  return m.providerName || m.providerLabel || m.providerId;
}

setUiLanguage(resolveUiLanguage(document.documentElement.dataset.uiLanguage, document.documentElement.lang));

const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById("messages")!;
const messagesScrollEl = document.getElementById("messages-scrollbar")!;
const messagesThumbEl = document.getElementById("messages-thumb")!;
const composerEl = document.getElementById("composer")!;
const queueZoneEl = document.getElementById("queue-zone")!;
const topbarEl = document.getElementById("topbar")!;
const questionRail = document.getElementById("question-rail")!;
const questionTrack = document.getElementById("question-rail-track")!;
const questionPreview = document.getElementById("question-preview")!;
const railToggle = document.getElementById("rail-toggle") as HTMLButtonElement;
const collapseAllTurnsButton = document.getElementById("collapse-all-turns") as HTMLButtonElement;
const usagePanel = document.getElementById("usage-panel")!;
let usagePanelOpen = vscode.getState()?.usagePanelOpen === true;
let messagesScrollbarRaf = 0;
let messagesThumbDrag: { pointerId: number; offsetY: number } | null = null;

/** Keep transcript padding synced so floating chrome can occlude scrolling text. */
function syncMessagesChrome(): void {
  const msg = messagesEl.getBoundingClientRect();
  const top = topbarEl.getBoundingClientRect();
  // Align the soft rail to the title-card bottom and the topmost input-card edge
  // (question rail when open, otherwise the composer card) — not the +10 content inset.
  const inputChrome = (!questionRail.hidden ? questionRail : composerEl.querySelector(".composer-card")) as HTMLElement | null;
  const inputTop = (inputChrome ?? composerEl).getBoundingClientRect().top;
  const scrollTop = Math.max(0, Math.ceil(top.bottom - msg.top));
  const scrollBottom = Math.max(0, Math.ceil(msg.bottom - inputTop));
  const padTop = Math.max(48, scrollTop + 10);
  const padBottom = Math.max(96, scrollBottom + 10);
  document.body.style.setProperty("--z-messages-pad-top", `${padTop}px`);
  document.body.style.setProperty("--z-messages-pad-bottom", `${padBottom}px`);
  document.body.style.setProperty("--z-messages-scroll-top", `${scrollTop}px`);
  document.body.style.setProperty("--z-messages-scroll-bottom", `${scrollBottom}px`);
  scheduleMessagesScrollbar();
}
function messagesChromeTop(): number {
  return Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--z-messages-pad-top")) || 56;
}

/** Soft custom rail lives only between chrome cards (native bar is full-height). */
function syncMessagesScrollbar(): void {
  const view = messagesEl.clientHeight;
  const scroll = messagesEl.scrollHeight;
  const max = scroll - view;
  if (max <= 1 || view <= 0) {
    messagesScrollEl.hidden = true;
    return;
  }
  messagesScrollEl.hidden = false;
  const track = messagesScrollEl.clientHeight;
  if (track <= 0) return;
  const thumbH = Math.max(20, Math.round((view / scroll) * track));
  const maxTop = Math.max(0, track - thumbH);
  const top = maxTop === 0 ? 0 : Math.round((messagesEl.scrollTop / max) * maxTop);
  messagesThumbEl.style.height = `${thumbH}px`;
  messagesThumbEl.style.transform = `translateY(${top}px)`;
}
function scheduleMessagesScrollbar(): void {
  if (messagesScrollbarRaf) return;
  messagesScrollbarRaf = requestAnimationFrame(() => {
    messagesScrollbarRaf = 0;
    syncMessagesScrollbar();
  });
}
function messagesScrollbarScrollTo(clientY: number, thumbOffsetY: number): void {
  const track = messagesScrollEl.getBoundingClientRect();
  const thumbH = messagesThumbEl.offsetHeight;
  const maxTop = Math.max(0, track.height - thumbH);
  const top = Math.min(maxTop, Math.max(0, clientY - track.top - thumbOffsetY));
  const max = messagesEl.scrollHeight - messagesEl.clientHeight;
  messagesEl.scrollTop = maxTop === 0 ? 0 : (top / maxTop) * max;
}

/** Same 2px rail as the transcript. Native scrollbars cannot go this thin. */
function bindSoftScrollbar(scroller: HTMLElement, axis: "x" | "y"): () => void {
  const host = scroller.parentElement;
  if (!host) return () => {};
  const rail = document.createElement("div");
  rail.className = `soft-scroll ${axis}`;
  rail.hidden = true;
  rail.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("div");
  thumb.className = "soft-thumb";
  rail.appendChild(thumb);
  host.appendChild(rail);
  let raf = 0;
  let drag: { pointerId: number; offset: number } | null = null;
  const sync = () => {
    const view = axis === "y" ? scroller.clientHeight : scroller.clientWidth;
    const size = axis === "y" ? scroller.scrollHeight : scroller.scrollWidth;
    const max = size - view;
    if (max <= 1 || view <= 0) {
      rail.hidden = true;
      return;
    }
    rail.hidden = false;
    const track = axis === "y" ? rail.clientHeight : rail.clientWidth;
    if (track <= 0) return;
    const thumbSize = Math.max(axis === "y" ? 16 : 12, Math.round((view / size) * track));
    const maxPos = Math.max(0, track - thumbSize);
    const pos = axis === "y" ? scroller.scrollTop : scroller.scrollLeft;
    const offset = maxPos === 0 ? 0 : Math.round((pos / max) * maxPos);
    if (axis === "y") {
      thumb.style.height = `${thumbSize}px`;
      thumb.style.transform = `translateY(${offset}px)`;
    } else {
      thumb.style.width = `${thumbSize}px`;
      thumb.style.transform = `translateX(${offset}px)`;
    }
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sync();
    });
  };
  const scrollToPointer = (client: number, thumbOffset: number) => {
    const box = rail.getBoundingClientRect();
    const thumbSize = axis === "y" ? thumb.offsetHeight : thumb.offsetWidth;
    const track = axis === "y" ? box.height : box.width;
    const origin = axis === "y" ? box.top : box.left;
    const maxPos = Math.max(0, track - thumbSize);
    const pos = Math.min(maxPos, Math.max(0, client - origin - thumbOffset));
    const max = axis === "y"
      ? scroller.scrollHeight - scroller.clientHeight
      : scroller.scrollWidth - scroller.clientWidth;
    const value = maxPos === 0 ? 0 : (pos / maxPos) * max;
    if (axis === "y") scroller.scrollTop = value;
    else scroller.scrollLeft = value;
  };
  scroller.addEventListener("scroll", schedule, { passive: true });
  scroller.addEventListener("input", schedule);
  new ResizeObserver(schedule).observe(scroller);
  // Expanding an existing card changes scrollHeight without resizing the
  // capped scroller or inserting text nodes. Watch visibility/layout changes too.
  new MutationObserver(records => {
    if (records.some(record => record.type === "attributes")) sync();
    else schedule();
  }).observe(scroller, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["class", "hidden", "style", "open"],
  });
  rail.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const box = thumb.getBoundingClientRect();
    const client = axis === "y" ? event.clientY : event.clientX;
    const start = axis === "y" ? box.top : box.left;
    const extent = axis === "y" ? box.height : box.width;
    const onThumb = client >= start && client <= start + extent;
    const offset = onThumb ? client - start : extent / 2;
    drag = { pointerId: event.pointerId, offset };
    rail.classList.add("is-dragging");
    rail.setPointerCapture(event.pointerId);
    scrollToPointer(client, offset);
    event.preventDefault();
    event.stopPropagation();
  });
  rail.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    scrollToPointer(axis === "y" ? event.clientY : event.clientX, drag.offset);
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    rail.classList.remove("is-dragging");
  };
  rail.addEventListener("pointerup", endDrag);
  rail.addEventListener("pointercancel", endDrag);
  schedule();
  return sync;
}
const input = document.getElementById("input") as HTMLTextAreaElement;
let syncComposerScrollbar: (() => void) | undefined;

function resizeComposerInput(): void {
  // Native scrollbars must not change the available wrapping width while the
  // textarea is measured at its natural height and then capped.
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  syncComposerScrollbar?.();
}
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const insertNowBtn = document.getElementById("insert-now-btn") as HTMLButtonElement;
const ICON_SEND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>`;
const ICON_EDIT_ATTACH = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_EDIT_CANCEL = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6.5 6.5 11 11m0-11-11 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_EDIT_REWIND = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h4.1M13 3.5v5h5M13 3.5l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17" cy="17" r="4.2" stroke="currentColor" stroke-width="1.6"/><path d="M17 14.8v2.4l1.5.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_STOP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>`;
const ICON_QUEUE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 15 7-7 7 7"/></svg>`;
const ICON_INSERT_NOW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 11 7-7 7 7"/><path d="m5 20 7-7 7 7"/></svg>`;
const statusDot = document.getElementById("status-dot")!;
const connStatus = document.getElementById("conn-status")!;
const connLabel = document.getElementById("conn-label")!;
const titleEl = document.getElementById("session-title") as HTMLInputElement;
const modelChip = document.getElementById("model-chip")!;
const modeChip = document.getElementById("mode-chip")!;
const thoughtChip = document.getElementById("thought-chip")!;
const contextMeter = document.getElementById("context-meter")!;
const contextRingTip = document.getElementById("context-ring-tip")!;
const contextRing = contextMeter.querySelector(".context-ring") as SVGSVGElement;
const contextValue = contextMeter.querySelector(".context-value") as SVGCircleElement;
const fiveHourRingTip = document.getElementById("five-hour-ring-tip")!;
const fiveHourRing = contextMeter.querySelector(".five-hour-ring") as SVGSVGElement;
const fiveHourValue = contextMeter.querySelector(".five-hour-value") as SVGCircleElement;
const overlay = document.getElementById("overlay")!;
const overlayTitle = document.getElementById("overlay-title")!;
const overlaySearch = document.getElementById("overlay-search") as HTMLInputElement;
const overlayList = document.getElementById("overlay-list")!;
const popover = document.getElementById("popover")!;
const popoverList = document.getElementById("popover-list")!;
const setupEl = document.getElementById("setup")!;
const setupTitle = document.getElementById("setup-title")!;
const setupHint = document.getElementById("setup-hint")!;
const setupList = document.getElementById("setup-list")!;
const toastEl = document.getElementById("toast")!;

let isGenerating = false;
let revealAfterCompletionArmed = false;
let completionRevealPending = false;
let completionRevealJump = "";
let completionRevealRaf = 0;
let holdStreams = false;
let sessionConnected = false;
let viewGen = 0;
let runningSessions = new Set<string>();
let turnWorkStarted = 0;
let workTicker = 0;
let currentAssistantEl: HTMLElement | null = null;
let overlayMode: "sessions" | "models" | "mode" | "thought" | null = null;
let showArchived = false;
let sessions: Session[] = [];
type SessionAction = "rename" | "archive" | "unarchive" | "delete";
const pendingSessionActions = new Map<string, { action: SessionAction; requestId: string }>();
let sessionActionRequestSequence = 0;
let currentSessionId = "";
let models: PickerModel[] = [];
let currentModelLabel = "";
let currentSessionModel: SessionModelChoice | undefined;
let sessionThoughtOptions: ThoughtOption[] = [];
let newSessionDefaults: NewSessionDefaults = {};
let defaultModelChoices: PickerModel[] = [];
let currentMode = "build";
let baseMode = "build";
let planEnabled = false;
let thoughtEnabled = false;
let currentThought = "";
let thoughtLevels: ThoughtOption[] = [];
let overlayItems: Array<{
  id: string;
  title: string;
  sub?: string;
  disabled?: boolean;
  running?: boolean;
  payload: unknown;
}> = [];
let stickToBottom = true;
let ignoreScroll = false;
/** Set when a prompt appears while output was being followed; cleared if the user scrolls away. */
let resumeOuterFollow = false;
let resumeWorkFollow = false;
let jumpSeq = 0;
let questionDrag: { x: number; left: number; moved: boolean } | null = null;
let previewAnchor: HTMLButtonElement | null = null;
let previewWatch = 0;
const savedRailOpen = vscode.getState()?.questionRailOpen;
let questionRailOpen = savedRailOpen === true;
let activeQuestionId = "";
let pinActiveQuestionUntil = 0;
type IndexedQuestion = { id: string; text: string; at?: number };
let questionIndex: IndexedQuestion[] = [];
let oldestLoadedId = "";
let loadedHistory: HistoryViewItem[] = [];
let historyTruncated = false;
let historyActiveSince = 0;
let suspendScroll = false;
let pendingJump = "";
let conversationSessionId = "";
let currentQueue: ConversationQueueItem[] | undefined;
let latestConversation: ConversationView | null = null;
const gitFileLists = new Map<string, GitFileChange[]>();
type ReplyPreviewFile = { path: string; name: string; kind: string; extension: string };
const previewRequests = new Map<string, string>();
const previewResults = new Map<string, { signature: string; cards: ReplyPreviewFile[] }>();
const localTurnFiles = new Map<string, LocalFile[]>();

interface LocalFile {
  path: string;
  added: number;
  removed: number;
  change: FileChange;
}
const composerDrafts = new ComposerDrafts(vscode.getState()?.composerDrafts);
let draftSessionId = typeof vscode.getState()?.draftSessionId === "string" ? String(vscode.getState()!.draftSessionId) : "";
let explicitChips: ContextChip[] = [];
let explicitSessionRefs: SessionReference[] = [];
let imageDrafts: DraftImage[] = [];
const pendingInputs = new Map<string, { sessionId: string; draft: ComposerDraft }>();

function persistComposerDraft(): void {
  const text = activeCommand ? `/${activeCommand} ${input.value}` : input.value;
  composerDrafts.set(draftSessionId, text, explicitChips, imageDrafts, explicitSessionRefs);
  vscode.setState({ ...(vscode.getState() ?? {}), composerDrafts: composerDrafts.serialize(), draftSessionId });
}

function restoreComposerDraft(draft: ComposerDraft): void {
  const persisted = /^\/([a-zA-Z][a-zA-Z0-9_-]*) ([\s\S]*)$/.exec(draft.text);
  const known = !!persisted && slashCommands.some(item => item.name === persisted[1]);
  activeCommand = persisted && (known || !slashCommands.length) ? persisted[1] : undefined;
  input.value = activeCommand ? persisted![2] : draft.text;
  if (activeCommand) {
    const entry = slashCommands.find(item => item.name === activeCommand);
    input.placeholder = entry ? commandDescription(entry) : composerPlaceholder();
  } else input.placeholder = composerPlaceholder();
  updateActiveCommandChip();
  explicitChips = draft.chips;
  explicitSessionRefs = draft.sessionRefs ?? [];
  imageDrafts = draft.images ?? [];
  renderImageDrafts();
  resizeComposerInput();
  renderComposerChips();
  updateComposerActions();
}

function attachComposerDraft(sessionId: string): void {
  if (sessionId === draftSessionId) return;
  persistComposerDraft();
  draftSessionId = sessionId;
  restoreComposerDraft(composerDrafts.takePending(sessionId));
  persistComposerDraft();
}

function prepareComposerSwitch(): void {
  clearMessageThumbnailLoads();
  mentions.close();
  previewRequest = "";
  for(const request of thumbnailRequests.values())request.resolve(undefined);
  thumbnailRequests.clear();
  document.getElementById("image-preview")?.remove();
  // Repeated reset notifications must not erase typing during the handoff.
  if (holdStreams && draftSessionId === "") return;
  persistComposerDraft();
  draftSessionId = "";
  restoreComposerDraft(composerDrafts.get(""));
  persistComposerDraft();
}

function recoverInput(msg: { commandId?: string; sessionId?: string; text?: string; chips?: ContextChip[]; sessionRefs?: SessionReference[]; attachments?: ImageAttachment[] }): void {
  const pending = msg.commandId ? pendingInputs.get(msg.commandId) : undefined;
  const owner = pending ? (pending.sessionId || msg.sessionId || "") : msg.sessionId;
  const failed = pending?.draft ?? (typeof msg.text === "string" ? { text: msg.text, chips: msg.chips ?? [], sessionRefs: msg.sessionRefs ?? [], images: readImageAttachments(msg.attachments).map(image => ({...image,id:crypto.randomUUID(),sessionId:owner || "",status:"ready" as const})) } : undefined);
  if (msg.commandId) pendingInputs.delete(msg.commandId);
  if (owner === undefined || !failed) return;
  persistComposerDraft();
  const recovered = composerDrafts.recover(owner, failed);
  if (owner === draftSessionId) restoreComposerDraft(recovered);
  vscode.setState({ ...(vscode.getState() ?? {}), composerDrafts: composerDrafts.serialize(), draftSessionId });
}
const attachmentsEl = document.getElementById("attachments")!;
const editorChipRow = document.getElementById("editor-chip-row")!;

const thumbnailRequests=new Map<string,{owner:string;gen:number;resolve:(value:string|undefined)=>void}>();
async function loadMessageThumbnail(image: ImageAttachment, target: ImageTarget | undefined, index:number): Promise<string|undefined> {
  const owner=currentSessionId, gen=viewGen;
  if(!owner || holdStreams)return;
  const data=await new Promise<string|undefined>(resolve=>{
    const requestId=crypto.randomUUID();
    const timer=setTimeout(()=>{thumbnailRequests.delete(requestId);resolve(undefined);},20000);
    thumbnailRequests.set(requestId,{owner,gen,resolve:value=>{clearTimeout(timer);resolve(value);}});
    post({type:"thumbnailImage",requestId,sessionId:owner,attachments:[image],...(target?{...target,attachmentIndex:index}:{})});
  });
  if(!data || owner!==currentSessionId || gen!==viewGen)return;
  return imageThumbnail(data);
}
let previewRequest = "";
function previewImage(image: ImageAttachment, target?: {rowId:number;entityId:string}, attachmentIndex?: number): void {
  previewRequest = crypto.randomUUID();
  post({ type: "previewImage", requestId: previewRequest, sessionId: draftSessionId, attachments: [image], ...(target ? {...target,attachmentIndex} : {}) });
}
function renderUserImages(el: HTMLElement, images: ImageAttachment[], target?: ImageTarget): void {
  const signature = JSON.stringify([images, target]);
  if (el.dataset.imageSignature === signature) return;
  el.dataset.imageSignature = signature;
  renderMessageImages(el, images, (image, index) => previewImage(image, target, index), (image,index)=>loadMessageThumbnail(image,target,index));
}
function renderImageDrafts(): void {
  for(const image of imageDrafts){const attachment=readImageAttachments([image])[0];if(attachment&&image.thumbnail)cacheImageThumbnail(attachment,image.thumbnail);}
  renderDraftImages(document.getElementById("image-drafts")!, imageDrafts, id => {
    previewRequest = "";
    forgetDraftPreview(id);
    imageDrafts = imageDrafts.filter(image => image.id !== id);
    renderImageDrafts(); persistComposerDraft(); updateComposerActions();
  }, image => {
    const attachment = readImageAttachments([image])[0];
    if (attachment && image.status === "ready") {
      previewRequest = "";
      if (!showDraftPreview(image)) previewImage(attachment);
    }
  });
}
function imageResult(msg: any): void {
  persistComposerDraft();
  const owner = msg.sessionId;
  if (typeof owner !== "string") return;
  const draft = composerDrafts.get(owner); const images = draft.images ?? [];
  const index = images.findIndex(image => image.id === msg.imageId);
  if (msg.type === "image_ready" && typeof msg.dataUrl === "string") {
    if (index < 0) return;
    void cacheThumbnail(msg.dataUrl, owner, msg.imageId).then(valid => {
      if (valid === undefined) return;
      imageResult(valid ? {...msg, dataUrl:undefined} : {type:"image_failed", sessionId:owner, imageId:msg.imageId, message:t("图片无法解码，请选择有效的图片。")});
    });
    return;
  }
  if (msg.type === "image_pending") {
    if (images.length >= IMAGE_MAX_COUNT) { showToast(t("最多添加 8 张图片。")); return; }
    images.push({ id: msg.imageId, sessionId: owner, fileName: msg.fileName, mime: msg.mime, bytes: msg.bytes, status: "uploading" });
  } else if (index >= 0) {
    const attachment = readImageAttachments([msg.attachment])[0];
    images[index] = attachment ? { ...images[index], ...attachment, status: "ready" } : { ...images[index], status: "error" };
  }
  composerDrafts.set(owner, draft.text, draft.chips, images, draft.sessionRefs);
  if (owner === draftSessionId) {
    imageDrafts = composerDrafts.get(owner).images ?? [];
    renderImageDrafts(); updateComposerActions();
  }
  vscode.setState({ ...(vscode.getState() ?? {}), composerDrafts: composerDrafts.serialize() });
  if (msg.type === "image_failed") showToast(msg.message || t("图片添加失败，请重新添加。"));
}
async function cacheThumbnail(dataUrl: string, owner: string, id: string): Promise<boolean | undefined> {
  try {
    const thumbnail = await imageThumbnail(dataUrl);
    if (!thumbnail) return false;
    persistComposerDraft(); const draft = composerDrafts.get(owner); const item = draft.images?.find(image => image.id === id);
    if (!item) return;
    cacheDraftPreview(id, dataUrl);
    item.thumbnail = thumbnail; composerDrafts.set(owner, draft.text, draft.chips, draft.images, draft.sessionRefs);
    if (owner === draftSessionId) { imageDrafts = draft.images ?? []; renderImageDrafts(); }
    vscode.setState({ ...(vscode.getState() ?? {}), composerDrafts: composerDrafts.serialize() });
    return true;
  } catch { return false; }
}
async function addImageFile(file: File): Promise<void> {
  if (holdStreams || !draftSessionId) return;
  if (imageDrafts.length >= IMAGE_MAX_COUNT) { showToast(t("最多添加 8 张图片。")); return; }
  if (file.size > IMAGE_MAX_BYTES) { showToast(t("每张图片不能超过 20 MB。")); return; }
  if (!IMAGE_MIMES.includes(file.type as any)) { showToast(t("请选择 PNG、JPEG、WebP 或 GIF 图片。")); return; }
  const owner = draftSessionId; const id = crypto.randomUUID();
  imageDrafts.push({ id, sessionId: owner, fileName: file.name || "image.png", mime: file.type, bytes: file.size, status: "uploading" }); renderImageDrafts(); persistComposerDraft(); updateComposerActions();
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
    const valid = await cacheThumbnail(dataUrl, owner, id);
    if (valid === undefined) return;
    if (!valid) { imageResult({type:"image_failed", sessionId:owner, imageId:id, message:t("图片无法解码，请选择有效的图片。")}); return; }
    post({ type: "uploadImage", imageId: id, sessionId: owner, fileName: file.name, dataUrl });
  } catch { imageResult({ type: "image_failed", imageId: id, sessionId: owner }); }
}
document.getElementById("attach-files")!.addEventListener("click", () => { if (!holdStreams) post({ type: "pickAttachments", sessionId: draftSessionId, maxImages: Math.max(0, IMAGE_MAX_COUNT - imageDrafts.length) }); });
input.addEventListener("paste", event => {
  const images = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith("image/"));
  if (images.length) {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (text && !/^(?:file:\/\/|data:image\/)/i.test(text)) {
      input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input"));
    }
    for (const image of images) void addImageFile(image);
  }
});
input.addEventListener("dragover", event => { if (event.dataTransfer?.types.some(type => type === "Files" || type === "text/uri-list")) event.preventDefault(); });
input.addEventListener("drop", event => {
  const images = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith("image/"));
  if (images.length) { event.preventDefault(); for (const image of images) void addImageFile(image); return; }
  const uris = (event.dataTransfer?.getData("text/uri-list") || "").split(/\r?\n/).filter(uri => /^file:/i.test(uri));
  if (uris.length && !holdStreams) { event.preventDefault(); post({ type: "attachFileUris", sessionId: draftSessionId, uris, maxImages: Math.max(0, IMAGE_MAX_COUNT - imageDrafts.length) }); }
});

function post(msg: unknown): void {
  vscode.postMessage(msg);
}

function isNearBottom(px = 72): boolean {
  return (
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= px
  );
}

function updateJumpLatest(): void {
  const btn = document.getElementById("jump-latest");
  if (!btn) return;
  btn.classList.toggle("show", !stickToBottom);
}

function scrollToBottom(force = false): void {
  if (!force && !stickToBottom) return;
  ignoreScroll = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  stickToBottom = true;
  updateJumpLatest();
  requestAnimationFrame(() => {
    ignoreScroll = false;
    updateQuestionRailActive();
  });
}

function questionReadingEdge(): number {
  return messagesEl.getBoundingClientRect().top + messagesChromeTop();
}

function followTranscriptGrowth(): void {
  if (completionRevealPending) {
    reconcileCompletedReveal();
    return;
  }
  if (!suspendScroll) scrollToBottom();
}

function releaseCompletedReveal(): void {
  completionRevealPending = false;
  completionRevealJump = "";
}

function alignQuestionToTop(question: HTMLElement): void {
  // Match the question rail's jump target exactly.
  const edge = questionReadingEdge();
  const delta = question.getBoundingClientRect().top - edge;
  stickToBottom = false;
  resumeOuterFollow = false;
  resumeWorkFollow = false;
  if (Math.abs(delta) < 1) return;
  ignoreScroll = true;
  messagesEl.scrollTop += delta;
  updateJumpLatest();
  const epoch = messageEpoch;
  requestAnimationFrame(() => {
    if (epoch !== messageEpoch) return;
    ignoreScroll = false;
    updateQuestionRailActive();
  });
}

function reconcileCompletedReveal(): void {
  if (!completionRevealPending) return;
  const turn = groupTurns().at(-1);
  if (!turn?.length) return;
  let questionIndex = -1;
  for (let index = turn.length - 1; index >= 0; index--) {
    const node = turn[index];
    if (node.matches(".message.user:not(.queued)") && node.getClientRects().length > 0) {
      questionIndex = index;
      break;
    }
  }
  const question = questionIndex >= 0 ? turn[questionIndex] : undefined;
  if (!question) return;
  const questionRect = question.getBoundingClientRect();
  const lastBottom = turn.slice(questionIndex + 1).reduce((bottom, node) => {
    if (!node.getClientRects().length) return bottom;
    return Math.max(bottom, node.getBoundingClientRect().bottom);
  }, questionRect.bottom);
  const messagesRect = messagesEl.getBoundingClientRect();
  const bottomInset = Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--z-messages-scroll-bottom")) || 120;
  const visibleHeight = messagesRect.bottom - bottomInset - 8 - (messagesRect.top + messagesChromeTop() + 8);
  // A completed turn that fits after its work fold closes already sits at the
  // bottom. Keep following in that case so the jump-to-bottom control stays off.
  if (lastBottom - questionRect.top <= visibleHeight) {
    completionRevealJump = "";
    if (!stickToBottom || !isNearBottom(2)) scrollToBottom(true);
    else updateJumpLatest();
    return;
  }
  // A full history redraw can replace an optimistic qN ID with the canonical
  // message ID. The latest visible question still belongs to this completion
  // intent until the user scrolls, switches sessions, or starts another turn.
  completionRevealJump = question.dataset.jump || "";
  alignQuestionToTop(question);
}

function scheduleCompletedReveal(): void {
  if (!completionRevealPending || completionRevealRaf) return;
  const epoch = messageEpoch;
  completionRevealRaf = requestAnimationFrame(() => {
    completionRevealRaf = 0;
    if (epoch === messageEpoch) reconcileCompletedReveal();
  });
}

type ActivityPhase = "waiting" | "reasoning" | "answer" | "tool" | "sync" | "stopping";
let activityPhase: ActivityPhase = "waiting";
let activitySince = Date.now();
const activityLabels: Record<ActivityPhase, string> = {
  waiting: "等待模型响应", reasoning: "正在思考", answer: "正在回复",
  tool: "正在执行工具", sync: "正在恢复同步", stopping: "正在停止",
};

function pendingPrompt(): HTMLElement | null {
  return messagesEl.querySelector<HTMLElement>(".perm-card:not(.resolved), .ask-card:not(.resolved)");
}

function paintActivity(): void {
  if (!isGenerating) return;
  const prompt = pendingPrompt();
  const key = activityPhase === "stopping" ? activityLabels.stopping
    : prompt ? (prompt.classList.contains("perm-card") ? "等待确认" : "等待你的选择")
    : activityLabels[activityPhase];
  if (connLabel.dataset.i18nKey !== key || connLabel.textContent !== t(key) || !statusDot.classList.contains("busy")) {
    setConnStatus("busy", t(key));
    connLabel.dataset.i18nKey = key;
  }
  if (!prompt && activityPhase === "waiting" && Date.now() - activitySince >= 30_000) {
    connStatus.title = t("等待模型响应较久，可打开日志查看连接状态。");
  }
}

function noteActivity(phase: ActivityPhase): void {
  if (activityPhase === "stopping" && phase !== "stopping" && isGenerating) return;
  if (phase === activityPhase) return;
  activitySince = Date.now();
  activityPhase = phase;
  paintActivity();
}

function refreshPendingAction(): void {
  const button = document.getElementById("pending-action") as HTMLButtonElement;
  const prompt = pendingPrompt();
  button.hidden = !prompt;
  const key = prompt?.classList.contains("perm-card") ? "需要批准 · 查看" : "需要选择 · 查看";
  button.textContent = t(key);
  button.dataset.i18nKey = key;
  paintActivity();
}

function revealPrompt(el: HTMLElement, focus = false): void {
  if (!el.isConnected || el.classList.contains("resolved") || !messagesEl.contains(el)) return;
  const fold = el.closest<HTMLElement>(".work-fold");
  if (fold) {
    fold.classList.add("open");
    workBody(fold).scrollTop = workBody(fold).scrollHeight;
  }
  // The action row can be below a very long command. Reveal controls, not just
  // the card's top, through both the work viewport and outer chat viewport.
  const actions = el.querySelector<HTMLElement>(".perm-actions, .ask-actions:last-child") || el;
  actions.scrollIntoView({block: "nearest", inline: "nearest"});
  if (focus) { el.tabIndex = -1; el.focus({preventScroll: true}); }
}

let messageEpoch = 0;

function announcePrompt(el: HTMLElement, follow: boolean): void {
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", t(el.classList.contains("perm-card") ? "等待确认" : "等待你的选择"));
  refreshPendingAction();
  const viewport = el.closest<HTMLElement>(".work-fold") ? workBody(el.closest<HTMLElement>(".work-fold")!) : null;
  const workNear = !!viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24;
  if (follow) resumeOuterFollow = true;
  if (follow || workNear) resumeWorkFollow = true;
  if (!follow) return;
  const epoch = messageEpoch;
  ignoreScroll = true;
  revealPrompt(el);
  // Confirm placement after layout without relying on a frame being delivered
  // immediately (e.g. an inactive or throttled webview).
  requestAnimationFrame(() => {
    if (epoch !== messageEpoch) return;
    revealPrompt(el);
    ignoreScroll = false;
  });
}

function restorePromptFollow(): void {
  const outer = resumeOuterFollow;
  const work = resumeWorkFollow;
  if (!outer && !work) return;
  resumeOuterFollow = false;
  resumeWorkFollow = false;
  const epoch = messageEpoch;
  const apply = () => {
    if (epoch !== messageEpoch) return;
    ignoreScroll = true;
    if (work) {
      for (const fold of document.querySelectorAll<HTMLElement>('.work-fold.open[data-state="running"]')) {
        const body = workBody(fold);
        body.scrollTop = body.scrollHeight;
      }
    }
    if (outer) {
      stickToBottom = true;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      updateJumpLatest();
    }
    requestAnimationFrame(() => { if (epoch === messageEpoch) ignoreScroll = false; });
  };
  apply();
  requestAnimationFrame(apply);
}

function resolveOpenPrompts(): void {
  document
    .querySelectorAll(".perm-card:not(.resolved), .ask-card:not(.resolved)")
    .forEach((el) => {
      if (el.classList.contains("ask-card")) collapseQuestion(el as HTMLElement,"已取消");
      else el.classList.add("resolved");
    });
  refreshPendingAction();
}

const DEFAULT_SESSION_TITLES = new Set(["", "ZCode", "New session", "Untitled session", "新会话", "新會話"]);

function displayTitle(title?: string): string {
  const next = (title || "").trim();
  if (DEFAULT_SESSION_TITLES.has(next)) return t("新会话");
  return next;
}

let editingTitle = false;
let titleBeforeEdit = "";

function setSessionTitle(title?: string): void {
  if (editingTitle) return;
  const next = displayTitle(title);
  titleEl.value = next;
  titleEl.title = t("点击重命名");
}

function beginTitleEdit(): void {
  if (editingTitle) return;
  editingTitle = true;
  titleBeforeEdit = titleEl.value;
  titleEl.select();
}

function finishTitleEdit(save: boolean): void {
  if (!editingTitle) return;
  editingTitle = false;
  const next = titleEl.value.trim();
  if (save && next && next !== titleBeforeEdit && currentSessionId) {
    titleEl.value = next;
    post({
      type: "renameSession",
      sessionId: currentSessionId,
      title: next,
      commit: true,
    });
  } else {
    titleEl.value = titleBeforeEdit;
  }
  titleEl.blur();
}

function setConnStatus(kind: "idle" | "busy" | "error" | "warn", text?: string): void {
  let label =
    text?.trim() ||
    (kind === "busy" ? t("生成中") : kind === "error" ? t("出错") : kind === "warn" ? t("需要设置") : t("已连接"));
  statusDot.className = `status-dot ${kind}`;
  label = relocalizeUiText(label);
  delete connLabel.dataset.i18nKey;
  connLabel.textContent = label;
  connStatus.title = label;
}

function setGenerating(generating: boolean, preserveCompletionReveal = false): void {
  const wasGenerating = isGenerating;
  isGenerating = generating;
  if (generating) {
    releaseCompletedReveal();
    revealAfterCompletionArmed = true;
    if (!wasGenerating) {
      for (const el of groupTurns().at(-1) ?? []) {
        if (el.classList.contains("reply-meta")) el.remove();
        else el.querySelectorAll(".reply-meta").forEach(meta => meta.remove());
      }
    }
    if (!turnWorkStarted) turnWorkStarted = Date.now();
    startWorkTicker();
    if (!wasGenerating) { activityPhase = "waiting"; activitySince = Date.now(); }
    paintActivity();
    ensureWorkingIndicator();
  } else {
    if (!preserveCompletionReveal) revealAfterCompletionArmed = false;
    stopWorkTicker();
    resolveOpenPrompts();
    setConnStatus("idle", t("已连接"));
    workingIndicator()?.remove();
  }
  updateComposerActions();
}

/** The tail spinner mirrors the desktop: a small loader at the transcript's
 * bottom-left while the turn is working, without any text. */
function workingIndicator(): HTMLElement | null {
  return document.getElementById("working-indicator");
}

function ensureWorkingIndicator(): void {
  let el = workingIndicator();
  if (!el) {
    el = document.createElement("div");
    el.id = "working-indicator";
    el.innerHTML = WORKING_SPINNER;
  }
  if (el.parentElement !== messagesEl) attachMessage(el);
  // Other live transcript rows can be inserted after the spinner. Keep it at
  // the true tail so it remains below the work fold and the latest answer.
  if (el !== messagesEl.lastElementChild) messagesEl.appendChild(el);
}

function composerHasText(): boolean {
  return input.value.trim().length > 0 || imageDrafts.length > 0;
}

function updateComposerActions(): void {
  const inserting = isGenerating && composerHasText();
  const stopping = isGenerating && !inserting;
  sendBtn.classList.toggle("stop", stopping);
  sendBtn.hidden = stopping;
  sendBtn.innerHTML = inserting ? ICON_QUEUE : ICON_SEND;
  const sendTitle = !sessionConnected ? t("连接中") : inserting ? t("排队发送") : t("发送");
  sendBtn.title = sendTitle;
  sendBtn.setAttribute("aria-label", sendTitle);
  sendBtn.disabled = holdStreams || !sessionConnected;
  stopBtn.hidden = !isGenerating;
  stopBtn.disabled = holdStreams || connLabel.textContent === t("正在停止");
  stopBtn.innerHTML = ICON_STOP;
  stopBtn.title = t("停止");
  stopBtn.setAttribute("aria-label", stopBtn.title);
  insertNowBtn.disabled = holdStreams || !sessionConnected;
  insertNowBtn.innerHTML = ICON_INSERT_NOW;
  insertNowBtn.classList.toggle("show", inserting);
}

function setStatus(kind: "idle" | "busy" | "error" | "warn", text: string): void {
  setConnStatus(
    kind,
    kind === "error" ? t("出错") : kind === "warn" ? t("需要设置") : text
  );
}

function formatTokens(n: number): string {
  if (getUiLanguage() === "en" && n >= 1000) {
    const scale = n >= 1_000_000 ? 1_000_000 : 1000;
    return `${Number((n / scale).toFixed(1))}${scale === 1000 ? "K" : "M"}`;
  }
  if (n >= 10000) {
    const wan = n / 10000;
    const digits = wan >= 100 || Math.abs(wan - Math.round(wan)) < 0.05 ? 0 : 1;
    return `${wan.toFixed(digits).replace(/\.0$/, "")}万`;
  }
  return String(Math.round(n));
}

type UsageQuotaLine = {
  label: string;
  remainingPercent?: number;
  usedPercent?: number;
  nextResetTime?: number;
  remainingCount?: number;
  remainingAmount?: number;
  currency?: string;
  grantedAmount?: number;
  toppedUpAmount?: number;
  metrics?: UsageQuotaMetric[];
};

type UsageQuotaMetric = {
  label: string;
  value: number;
  format: "number" | "currency";
  currency?: string;
  unit?: string;
  period?: string;
};

function formatPercent(n: number): string {
  const digits = n >= 10 ? 0 : 1;
  return n.toFixed(digits).replace(/\.0$/, "");
}

function formatMoney(amount: number, currency: string): string {
  const value = amount.toLocaleString(getUiLanguage(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === "CNY") return `¥${value}`;
  if (currency === "USD") return `$${value}`;
  try {
    return new Intl.NumberFormat(getUiLanguage(), {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${value} ${currency}`;
  }
}

function isUsageQuotaMetric(value: unknown): value is UsageQuotaMetric {
  if (!value || typeof value !== "object") return false;
  const metric = value as Partial<UsageQuotaMetric>;
  if (typeof metric.label !== "string" || !metric.label.trim() || typeof metric.value !== "number" || !Number.isFinite(metric.value) || metric.value < 0) return false;
  if (metric.period !== undefined && typeof metric.period !== "string") return false;
  if (metric.unit !== undefined && typeof metric.unit !== "string") return false;
  if (metric.format === "currency") return typeof metric.currency === "string" && /^[A-Z]{3}$/.test(metric.currency) && metric.unit === undefined;
  return metric.format === "number" && metric.currency === undefined;
}

function formatUsageMetricValue(metric: UsageQuotaMetric): string {
  if (metric.format === "currency" && metric.currency) return formatMoney(metric.value, metric.currency);
  const value = metric.value.toLocaleString(getUiLanguage(), { maximumFractionDigits: 4 });
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function formatUsageMetricLine(metric: UsageQuotaMetric): string {
  const label = metric.period ? `${metric.period} · ${metric.label}` : metric.label;
  return t("{0}：{1}", { 0: label, 1: formatUsageMetricValue(metric) });
}

function formatReset(ms: number): string {
  const t = ms < 1e12 ? ms * 1000 : ms;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(getUiLanguage(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  return d.toLocaleDateString(getUiLanguage(), { month: "numeric", day: "numeric" });
}

let currentUsage: Parameters<typeof setUsageMeter>[0] | undefined;

function setUsageMeter(msg: {
  used?: number;
  max?: number;
  quota?: UsageQuotaLine[];
}): void {
  currentUsage = msg;
  renderUsagePanel();
}

function usagePanelEnabled(): boolean {
  return document.documentElement.dataset.showUsageChevron !== "false";
}

function applyUsageVisibility(): void {
  const enabled = usagePanelEnabled();
  usagePanel.hidden = !enabled || !usagePanelOpen;
  const label = usagePanelOpen ? t("收起额度与上下文") : t("展开额度与上下文");
  contextMeter.title = enabled ? label : "";
  contextMeter.setAttribute("aria-label", label);
  contextMeter.setAttribute("aria-expanded", String(enabled && usagePanelOpen));
}

function tipLines(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => !!line && line.trim().length > 0).join("\n");
}
function setTip(el: HTMLElement, text: string): void {
  if (text) el.title = text;
  else el.removeAttribute("title");
}

function ensureQuotaCell(index: number): HTMLElement {
  if (index === 0) return document.getElementById("usage-five-hour")!;
  if (index === 1) return document.getElementById("usage-weekly")!;
  const id = `usage-extra-${index - 2}`;
  let cell = document.getElementById(id) as HTMLElement | null;
  if (!cell) {
    cell = document.createElement("div");
    cell.id = id;
    cell.className = "usage-cell usage-extra";
    cell.tabIndex = 0;
    cell.setAttribute("role", "progressbar");
    cell.setAttribute("aria-valuemin", "0");
    cell.setAttribute("aria-valuemax", "100");
    const head = document.createElement("div");
    head.className = "usage-cell-head";
    const label = document.createElement("span");
    label.className = "usage-cell-label";
    const value = document.createElement("span");
    value.className = "usage-cell-value";
    const detail = document.createElement("span");
    detail.className = "usage-cell-detail";
    const detailText = document.createElement("span");
    detailText.className = "usage-cell-detail-text";
    detail.append(detailText);
    head.append(label, value, detail);
    const track = document.createElement("div");
    track.className = "usage-track";
    const fill = document.createElement("div");
    fill.className = "usage-fill";
    track.append(fill);
    cell.append(head, track);
    usagePanel.append(cell);
  }
  return cell;
}

function paintUsageCell(
  cell: HTMLElement,
  label: string,
  used: number | undefined,
  detail: string,
  brief = "",
  displayMode: "money" | "metric" | "count" | null = null,
  mainValue = brief,
  showBrief = displayMode !== "money",
): void {
  const known = typeof used === "number" && Number.isFinite(used);
  const percent = known ? Math.max(0, Math.min(100, used)) : 0;
  const briefEl = cell.querySelector(".usage-cell-detail")!;
  briefEl.replaceChildren();
  if (brief && showBrief) {
    if (cell.id === "usage-context") briefEl.innerHTML = '<svg class="usage-context-symbol" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" aria-hidden="true"><rect x="1.5" y="2" width="9" height="8" rx="1.5"/><path d="M4 4.5h4M4 7.5h2.5"/></svg>';
    const text = document.createElement("span");
    text.className = "usage-cell-detail-text";
    text.textContent = brief;
    briefEl.append(text);
  }
  cell.querySelector(".usage-cell-label")!.textContent = label;
  const value = cell.querySelector(".usage-cell-value")!;
  const isMoney = !known && displayMode === "money";
  const isMetric = !known && displayMode === "metric";
  const isCount = !known && displayMode === "count";
  value.textContent = known ? `${formatPercent(percent)}%` : displayMode ? mainValue : "—";
  (cell.querySelector(".usage-fill") as HTMLElement).style.width = `${percent}%`;
  cell.hidden = false;
  cell.classList.toggle("money", isMoney);
  cell.classList.toggle("metric-only", isMetric);
  cell.classList.toggle("count-only", isCount);
  cell.classList.toggle("warm", known && percent >= 75 && percent < 90);
  cell.classList.toggle("hot", known && percent >= 90);
  cell.title = detail || t("等待额度和上下文信息…");
  if (known) {
    cell.setAttribute("role", "progressbar");
    cell.setAttribute("aria-valuemin", "0");
    cell.setAttribute("aria-valuemax", "100");
    cell.setAttribute("aria-label", label);
    cell.setAttribute("aria-valuetext", cell.title);
    cell.setAttribute("aria-valuenow", String(Math.round(percent)));
  } else {
    cell.setAttribute("role", "group");
    cell.removeAttribute("aria-valuemin");
    cell.removeAttribute("aria-valuemax");
    cell.removeAttribute("aria-valuenow");
    cell.removeAttribute("aria-valuetext");
    cell.setAttribute("aria-label", detail ? `${label}. ${detail}` : `${label} ${value.textContent}`);
  }
}

function compactContext(used:number, max:number): string {
  const language = getUiLanguage();
  const divisor = language === "en" ? 1000 : 10000;
  const unit = language === "en" ? "k" : language === "zh-TW" ? "萬" : "万";
  const count = (value:number) => String(Number((value / divisor).toFixed(value < divisor / 100 ? 4 : value < divisor ? 2 : 1)));
  // Both numbers share the trailing unit, keeping the ratio directly comparable.
  return `${count(used)}/${count(max)}${unit}`;
}
function compactReset(value?:number, dateOnly=false): string {
  if (!value || !Number.isFinite(value)) return "";
  const date=new Date(value<1e12 ? value*1000 : value);if(Number.isNaN(date.getTime()))return "";
  if (dateOnly) return `↻ ${date.getMonth()+1}/${date.getDate()}`;
  const now=new Date(),same=date.toDateString()===now.toDateString();
  const clock=`${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
  return `↻ ${same ? "" : `${date.getMonth()+1}/${date.getDate()} `}${clock}`;
}

function renderUsagePanel(): void {
  const msg = currentUsage ?? {};
  const quota = (msg.quota ?? []).filter(row =>
    Number.isFinite(row.remainingPercent) ||
    (Number.isFinite(row.remainingCount) && row.remainingCount! >= 0) ||
    (Number.isFinite(row.nextResetTime) && row.nextResetTime! > 0) ||
    (typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) && Number.isFinite(row.remainingAmount) && row.remainingAmount! >= 0) ||
    (Array.isArray(row.metrics) && row.metrics.some(isUsageQuotaMetric))
  );
  const hasContext = typeof msg.max === "number" && Number.isFinite(msg.max) && msg.max > 0 &&
    typeof msg.used === "number" && Number.isFinite(msg.used) && msg.used >= 0;
  const ratio = hasContext ? Math.max(0, Math.min(1, msg.used! / msg.max!)) : 0;
  const percent = ratio * 100;
  usagePanel.setAttribute("aria-label", t("额度与上下文"));
  contextRing.classList.toggle("hot", ratio >= .9);
  contextRing.classList.toggle("warn", ratio >= .75 && ratio < .9);
  const circumference = 2 * Math.PI * 7;
  contextValue.style.strokeDasharray = String(circumference);
  contextValue.style.strokeDashoffset = String(circumference * (1 - ratio));
  const contextDetail = hasContext ? t("{0} / {1} tokens · 剩余 {2}", {
    0: msg.used!.toLocaleString(getUiLanguage()), 1: msg.max!.toLocaleString(getUiLanguage()),
    2: Math.max(0, msg.max! - msg.used!).toLocaleString(getUiLanguage())
  }) : "";
  const contextHover = hasContext ? tipLines([
    `${t("上下文")}  ${t("已用 {0}%", { 0: formatPercent(percent) })}`,
    contextDetail,
  ]) : "";
  const quotaDetails = new Map<UsageQuotaLine, string>();
  for (const row of quota) {
    const hasPercent = typeof row.remainingPercent === "number" && Number.isFinite(row.remainingPercent);
    const remaining = hasPercent ? Math.max(0, Math.min(100, row.remainingPercent!)) : 0;
    const used = 100 - remaining;
    const hasMoney = typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) && Number.isFinite(row.remainingAmount);
    const detailLines = hasPercent
      ? [
        `${t(row.label)}  ${t("已用 {0}%", { 0: formatPercent(used) })}`,
        t("剩余 {0}%", { 0: formatPercent(remaining) }),
        Number.isFinite(row.remainingCount) ? t("剩余数量：{0}", { 0: Math.max(0, row.remainingCount!).toLocaleString(getUiLanguage()) }) : "",
        hasMoney ? t("剩余金额：{0}", { 0: formatMoney(row.remainingAmount!, row.currency!) }) : "",
        Number.isFinite(row.grantedAmount) && row.currency ? t("赠金余额：{0}", { 0: formatMoney(row.grantedAmount!, row.currency) }) : "",
        Number.isFinite(row.toppedUpAmount) && row.currency ? t("充值余额：{0}", { 0: formatMoney(row.toppedUpAmount!, row.currency) }) : "",
        row.nextResetTime ? t("重置时间：{0}", { 0: formatReset(row.nextResetTime) }) : "",
      ]
      : [
        hasMoney || Number.isFinite(row.grantedAmount) || Number.isFinite(row.toppedUpAmount)
          ? t("账户余额（{0}）", { 0: row.currency ?? "" }) : "",
        Number.isFinite(row.remainingCount) && row.remainingCount! >= 0
          ? t("剩余数量：{0}", { 0: row.remainingCount!.toLocaleString(getUiLanguage()) }) : "",
        hasMoney ? t("剩余金额：{0}", { 0: formatMoney(row.remainingAmount!, row.currency!) }) : "",
        Number.isFinite(row.grantedAmount) && row.currency ? t("赠金余额：{0}", { 0: formatMoney(row.grantedAmount!, row.currency) }) : "",
        Number.isFinite(row.toppedUpAmount) && row.currency ? t("充值余额：{0}", { 0: formatMoney(row.toppedUpAmount!, row.currency) }) : "",
        row.nextResetTime ? t("重置时间：{0}", { 0: formatReset(row.nextResetTime) }) : "",
      ];
    const detail = tipLines([
      ...detailLines,
      ...(Array.isArray(row.metrics) ? row.metrics.filter(isUsageQuotaMetric).map(formatUsageMetricLine) : []),
    ]);
    quotaDetails.set(row, detail);
  }
  const fiveHour = quota.find(row => row.label === "5 小时");
  const weekly = quota.find(row => row.label === "每周");
  const usesCanonicalSlots = !!fiveHour || !!weekly;
  const displayQuota: Array<UsageQuotaLine | undefined> = usesCanonicalSlots
    ? [fiveHour, weekly, ...quota.filter(row => row !== fiveHour && row !== weekly)]
    : quota;
  const visibleQuota = displayQuota.filter((row): row is UsageQuotaLine => !!row);
  const quotaUsed = (row?: UsageQuotaLine) => row && Number.isFinite(row.remainingPercent)
    ? 100 - Math.max(0, Math.min(100, row.remainingPercent!))
    : undefined;
  const quotaBrief = (row?: UsageQuotaLine) => row && typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) && Number.isFinite(row.remainingAmount)
    ? formatMoney(row.remainingAmount!, row.currency)
    : compactReset(row?.nextResetTime);
  const fiveHourUsed = quotaUsed(fiveHour);
  const fiveHourRatio = typeof fiveHourUsed === "number" ? fiveHourUsed / 100 : 0;
  fiveHourValue.style.strokeDasharray = String(circumference);
  fiveHourValue.style.strokeDashoffset = String(circumference * (1 - fiveHourRatio));
  fiveHourRing.classList.toggle("hot", fiveHourRatio >= .9);
  fiveHourRing.classList.toggle("warn", fiveHourRatio >= .75 && fiveHourRatio < .9);
  const fiveHourQuotaTip = fiveHour ? quotaDetails.get(fiveHour)! : "";
  fiveHourRingTip.toggleAttribute("hidden", fiveHourUsed === undefined);
  paintUsageCell(document.getElementById("usage-context")!, t("上下文"), hasContext ? percent : undefined, contextHover, hasContext ? compactContext(msg.used!, msg.max!) : "");
  for (let index = 0; index < displayQuota.length; index++) {
    const row = displayQuota[index];
    const cell = ensureQuotaCell(index);
    if (!row) {
      cell.hidden = true;
      continue;
    }
    const fallback = index === 0 ? t("5时") : index === 1 ? t("一周") : t("Start Plan");
    const label = row === fiveHour ? t("5时") : row === weekly ? t("一周") : t(row.label || fallback);
    const metrics = Array.isArray(row.metrics) ? row.metrics.filter(isUsageQuotaMetric) : [];
    const firstMetric = metrics[0];
    const amountOnly = quotaUsed(row) === undefined && typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) && Number.isFinite(row.remainingAmount);
    const metricOnly = quotaUsed(row) === undefined && !amountOnly && !!firstMetric;
    const countOnly = quotaUsed(row) === undefined && !amountOnly && !metricOnly && Number.isFinite(row.remainingCount) && row.remainingCount! >= 0;
    const metricBrief = firstMetric ? formatUsageMetricLine(firstMetric) : "";
    const brief = amountOnly ? metricBrief : metricOnly ? "" : quotaBrief(row) || metricBrief;
    const displayMode = amountOnly ? "money" : metricOnly ? "metric" : countOnly ? "count" : null;
    const mainValue = amountOnly && row.currency
      ? formatMoney(row.remainingAmount!, row.currency)
      : metricOnly && firstMetric ? formatUsageMetricValue(firstMetric) : brief;
    const countValue = countOnly ? row.remainingCount!.toLocaleString(getUiLanguage()) : mainValue;
    paintUsageCell(cell, label, quotaUsed(row), quotaDetails.get(row) ?? "", brief, displayMode, countValue, !amountOnly || !!metricBrief);
  }
  for (const id of ["usage-five-hour", "usage-weekly"]) {
    const cell = document.getElementById(id)!;
    const index = id === "usage-five-hour" ? 0 : 1;
    if (!displayQuota[index]) {
      paintUsageCell(cell, index === 0 ? t("5时") : t("一周"), undefined, "");
      cell.hidden = true;
    }
  }
  for (const cell of usagePanel.querySelectorAll<HTMLElement>(".usage-extra")) {
    if (Number(cell.id.slice("usage-extra-".length)) >= displayQuota.length - 2) {
      paintUsageCell(cell, "", undefined, "");
      cell.hidden = true;
    }
  }
  usagePanel.style.gridTemplateColumns = `repeat(${Math.min(3, Math.max(1, 1 + visibleQuota.length))}, minmax(0, 1fr))`;
  setTip(contextRingTip, contextHover);
  setTip(fiveHourRingTip, fiveHourQuotaTip);
  applyUsageVisibility();
}

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1400);
}

let greetingTimer = 0;

function clearGreetingTimer(): void {
  window.clearTimeout(greetingTimer);
  greetingTimer = 0;
}

function refreshEmptyGreeting(): void {
  clearGreetingTimer();
  const title = messagesEl.querySelector<HTMLElement>(".empty-title");
  if (!title) return;
  const now = new Date();
  setUiLabel(title, greetingKey(now));
  // One timeout at the next time-period boundary; no periodic polling.
  greetingTimer = window.setTimeout(refreshEmptyGreeting, nextGreetingDelay(now));
}

function emptyState(): void {
  questionIndex = [];
  oldestLoadedId = "";
  pendingJump = "";
  stopWorkTicker();
  turnWorkStarted = 0;
  messagesEl.innerHTML = `<div class="empty">
    <div class="empty-mark" aria-hidden="true">${EMPTY_LOGO}</div>
    <div class="empty-title"></div>
  </div>`;
  refreshEmptyGreeting();
  syncQuestionRail();
}

function attachMessage(el: HTMLElement): void {
  if (!el.dataset.sessionId) el.dataset.sessionId = currentSessionId;
  const spinner = workingIndicator();
  if (spinner && spinner !== el && spinner.parentElement === messagesEl) {
    messagesEl.insertBefore(el, spinner);
  } else {
    messagesEl.appendChild(el);
  }
  if (!suspendScroll) pinGitCards();
}

function questionTimeMs(raw: unknown): number | undefined {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

function indexedQuestions(value: unknown): IndexedQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: IndexedQuestion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; text?: unknown; at?: unknown };
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    const text = typeof row.text === "string" ? row.text : "";
    const at = questionTimeMs(row.at);
    questions.push(at ? { id, text, at } : { id, text });
  }
  return questions;
}

function bubbleSentAt(el: HTMLElement | null | undefined): number | undefined {
  return questionTimeMs(el?.dataset.sentAt);
}

function railQuestions(): IndexedQuestion[] {
  const bubbles = new Map(
    sentQuestions()
      .filter((el) => el.dataset.jump)
      .map((el) => [el.dataset.jump || "", el] as const)
  );
  const seen = new Set(questionIndex.map((item) => item.id));
  const indexed = questionIndex.map((item) => {
    const at = item.at ?? bubbleSentAt(bubbles.get(item.id));
    return at ? { id: item.id, text: item.text, at } : { id: item.id, text: item.text };
  });
  const extra = sentQuestions()
    .filter((el) => el.dataset.jump && !seen.has(el.dataset.jump))
    .map((el) => {
      const at = bubbleSentAt(el);
      const item: IndexedQuestion = { id: el.dataset.jump || "", text: questionLabel(el) };
      if (at) item.at = at;
      return item;
    });
  return [...indexed, ...extra];
}

function clearMessages(): void {
  messageEpoch++;
  ignoreScroll = false;
  clearGreetingTimer();
  activityPhase = "waiting";
  activitySince = Date.now();
  messagesEl.innerHTML = "";
  refreshPendingAction();
  localTurnFiles.clear();
  currentAssistantEl = null;
  stopWorkTicker();
  turnWorkStarted = 0;
  jumpSeq = 0;
  activeQuestionId = "";
  syncQuestionRail();
}

function questionLabel(el: HTMLElement): string {
  const body = el.querySelector(".user-body");
  const text = (body?.textContent || el.dataset.rawText || "").replace(/\s+/g, " ").trim();
  return text || t("（无文字）");
}

/** Rail hover always shows month, day, and time, including today and earlier years. */
function questionDateTime(at: number | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const hm = date.toLocaleTimeString(getUiLanguage(), { hour: "2-digit", minute: "2-digit", hour12: false });
  return t("{0}月{1}日 {2}", { 0: date.getMonth() + 1, 1: date.getDate(), 2: hm });
}

function questionHoverLabel(text: string, at?: number): string {
  const when = questionDateTime(at);
  return when ? `${when}\n${text}` : text;
}

function sentQuestions(): HTMLElement[] {
  return [...messagesEl.querySelectorAll<HTMLElement>(".message.user:not(.queued)")];
}

function stopPreviewWatch(): void {
  if (!previewWatch) return;
  window.clearInterval(previewWatch);
  previewWatch = 0;
}

function hideQuestionPreview(): void {
  previewAnchor = null;
  questionPreview.hidden = true;
  stopPreviewWatch();
}

function armPreviewWatch(): void {
  if (previewWatch) return;
  previewWatch = window.setInterval(() => {
    if (!questionTrack.querySelector(".q-dot:hover")) hideQuestionPreview();
  }, 120);
}

function rememberRailOpen(open: boolean): void {
  questionRailOpen = open;
  const prev = vscode.getState() ?? {};
  vscode.setState({ ...prev, questionRailOpen: open });
}

function applyQuestionRailVisibility(): void {
  const has = questionTrack.querySelector(".q-dot") !== null;
  const jumpEnabled = document.documentElement.dataset.showQuestionJump !== "false";
  composerEl.classList.toggle("rail-available", has && jumpEnabled);
  railToggle.hidden = !has || !jumpEnabled;
  const open = has && questionRailOpen && jumpEnabled;
  questionRail.hidden = !open;
  railToggle.classList.toggle("expand", questionRailOpen);
  const label = questionRailOpen ? t("收起问题跳转") : t("展开问题跳转");
  railToggle.title = label;
  railToggle.setAttribute("aria-label", label);
  railToggle.setAttribute("aria-expanded", questionRailOpen ? "true" : "false");
  if (!open) hideQuestionPreview();
}

function syncQuestionRail(): void {
  const questions = railQuestions();
  hideQuestionPreview();
  questionTrack.innerHTML = "";
  questions.forEach((item, index) => {
    const label = item.text;
    const dot = document.createElement("button");
    dot.type = "button";
    const marked = (index + 1) % 10 === 0;
    dot.className = "q-dot" + (marked ? " mark" : "");
    dot.textContent = String(index + 1);
    dot.dataset.jump = item.id;
    dot.dataset.preview = label;
    if (item.at) dot.dataset.at = String(item.at);
    dot.title = "";
    dot.setAttribute("aria-label", questionHoverLabel(label, item.at));
    questionTrack.appendChild(dot);
  });
  applyQuestionRailVisibility();
  updateQuestionRailOverflow();
  updateQuestionRailActive();
  syncCollapseAllButton();
}

function updateQuestionRailOverflow(): void {
  const overflow = questionTrack.scrollWidth - questionTrack.clientWidth > 2;
  questionRail.classList.toggle("can-scroll", overflow);
}

function showQuestionPreview(dot: HTMLButtonElement): void {
  if (questionDrag?.moved || questionRail.hidden) {
    hideQuestionPreview();
    return;
  }
  armPreviewWatch();
  if (previewAnchor === dot && !questionPreview.hidden) return;
  previewAnchor = dot;
  questionPreview.hidden = false;
  const text = dot.dataset.preview || "";
  const when = questionDateTime(questionTimeMs(dot.dataset.at));
  const time = questionPreview.querySelector<HTMLElement>(".question-preview-time");
  const previewBody = questionPreview.querySelector<HTMLElement>(".question-preview-body");
  if (time && previewBody) {
    time.hidden = !when;
    time.textContent = when;
    previewBody.textContent = text;
  } else {
    questionPreview.textContent = when ? `${when}\n${text}` : text;
  }
  const railBox = questionRail.getBoundingClientRect();
  const dotBox = dot.getBoundingClientRect();
  const width = questionPreview.offsetWidth;
  let left = dotBox.left - railBox.left + dotBox.width / 2 - width / 2;
  left = Math.max(0, Math.min(left, railBox.width - width));
  questionPreview.style.left = `${left}px`;
}

function syncQuestionPreview(target: EventTarget | null): void {
  if (questionDrag?.moved) return;
  const dot = target instanceof Element ? target.closest<HTMLButtonElement>(".q-dot") : null;
  if (dot && questionTrack.contains(dot)) showQuestionPreview(dot);
  else hideQuestionPreview();
}

function markActiveQuestion(id: string, reveal: boolean): void {
  activeQuestionId = id;
  for (const dot of questionTrack.querySelectorAll<HTMLButtonElement>(".q-dot")) {
    dot.classList.toggle("current", dot.dataset.jump === id);
  }
  if (!reveal) return;
  const current = questionTrack.querySelector<HTMLButtonElement>(".q-dot.current");
  if (!current) return;
  const left = current.offsetLeft;
  const right = left + current.offsetWidth;
  if (left < questionTrack.scrollLeft) questionTrack.scrollLeft = Math.max(0, left - 8);
  else if (right > questionTrack.scrollLeft + questionTrack.clientWidth) {
    questionTrack.scrollLeft = right - questionTrack.clientWidth + 8;
  }
}

function updateQuestionRailActive(): void {
  if (Date.now() < pinActiveQuestionUntil) return;
  // A folded turn hides its user bubble, so let the visible fold bar stand in
  // for that question when choosing the marker at the reading line.
  const anchors = [...messagesEl.querySelectorAll<HTMLElement>(
    ':scope > .message.user:not(.queued)[data-jump], :scope > .turn-fold-bar[data-jump]'
  )].filter((el) => el.getClientRects().length > 0);
  if (!anchors.length) return;
  // Active marker follows the line just below the floating topbar card.
  const edge = questionReadingEdge();
  let active = anchors[0];
  for (const el of anchors) {
    if (el.getBoundingClientRect().top <= edge) active = el;
  }
  markActiveQuestion(active.dataset.jump || "", !questionDrag && !questionRail.matches(":hover"));
}

function jumpToQuestion(id: string): void {
  releaseCompletedReveal();
  const el = messagesEl.querySelector<HTMLElement>(`.message.user[data-jump="${CSS.escape(id)}"]`);
  if (!el) {
    if (!oldestLoadedId || pendingJump === id) return;
    pendingJump = id;
    post({ type: "loadThrough", messageId: id, oldestId: oldestLoadedId, sessionId: currentSessionId, viewGen, requestId: crypto.randomUUID() });
    return;
  }
  pendingJump = "";
  expandTurn(el);
  pinActiveQuestionUntil = Date.now() + 900;
  markActiveQuestion(id, true);
  const inset = messagesChromeTop();
  const top =
    el.getBoundingClientRect().top -
    messagesEl.getBoundingClientRect().top +
    messagesEl.scrollTop -
    inset;
  stickToBottom = false;
  resumeOuterFollow = false;
  resumeWorkFollow = false;
  ignoreScroll = true;
  messagesEl.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  updateJumpLatest();
  messagesEl.querySelectorAll(".jump-flash").forEach((node) => node.classList.remove("jump-flash"));
  el.classList.add("jump-flash");
  window.setTimeout(() => el.classList.remove("jump-flash"), 1400);
  window.setTimeout(() => {
    ignoreScroll = false;
    updateQuestionRailActive();
  }, 400);
}

const RECENT_TURNS = 10;
let allTurnsCollapsed = false;
let preCollapseTurnStates: Map<string, boolean> | null = null;
let preCollapseViewport: { turnKey: string; element: HTMLElement; pieceIndex: number; top: number } | null = null;

const COLLAPSE_ALL_ICON = '<svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true"><path d="M1 1.5h10M1 5h10M1 8.5h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const RESTORE_RECENT_ICON = '<svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true"><path d="M1 1.5h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M1 5h10M1 8.5h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="2 1.7"/></svg>';

function syncCollapseAllButton(): void {
  const label = t(allTurnsCollapsed ? "恢复" : "折叠所有对话");
  collapseAllTurnsButton.title = label;
  collapseAllTurnsButton.setAttribute("aria-label", label);
  collapseAllTurnsButton.dataset.state = allTurnsCollapsed ? "restore-recent" : "collapse-all";
  collapseAllTurnsButton.innerHTML = allTurnsCollapsed ? RESTORE_RECENT_ICON : COLLAPSE_ALL_ICON;
}

function resetAllTurnCollapse(): void {
  allTurnsCollapsed = false;
  preCollapseTurnStates = null;
  preCollapseViewport = null;
  syncCollapseAllButton();
}

function isTurnPiece(el: HTMLElement): boolean {
  return (
    el.classList.contains("message") ||
    el.classList.contains("tool-call") ||
    el.classList.contains("perm-card") ||
    el.classList.contains("ask-card") ||
    el.classList.contains("git-changes") ||
    el.classList.contains("msg-meta") ||
    el.classList.contains("work-fold")
  );
}

function groupTurns(): HTMLElement[][] {
  const turns: HTMLElement[][] = [];
  let turn: HTMLElement[] | null = null;
  const leading: HTMLElement[] = [];
  for (const node of messagesEl.children) {
    if (!(node instanceof HTMLElement) || !isTurnPiece(node)) continue;
    const isUser =
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued");
    if (isUser) {
      const firstUser = turn?.find(item => item.classList.contains("user"));
      if (node.dataset.taskId && firstUser?.dataset.taskId === node.dataset.taskId) {
        turn!.push(node);
        continue;
      }
      turn = [node];
      turns.push(turn);
      continue;
    }
    if (turn) turn.push(node);
    else leading.push(node);
  }
  if (leading.length) turns.unshift(leading);
  return turns;
}

function unfoldElements(items: HTMLElement[]): void {
  const first = items[0];
  const prev = first?.previousElementSibling;
  if (prev instanceof HTMLElement && prev.classList.contains("turn-fold-bar")) prev.remove();
  for (const el of items) {
    el.classList.remove("turn-collapsed", "turn-folded", "turn-hidden");
    el.querySelector(":scope > .fold-preview")?.remove();
    messageAction(el, ".turn-collapse-btn")?.remove();
    const questionFold = messageAction(el, ".question-fold-btn");
    if (questionFold) questionFold.hidden = false;
  }
}
const TURN_CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Footer actions share a 12px drawing grid and a 1.1px rendered stroke.
// Keep Copy slightly inset to balance the denser overlapping rectangles.
const TURN_COLLAPSE =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2h8M3 7l3-3 3 3M6 4v6"/></svg>';
const TURN_PEN =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.1 9.9 2.7 7.4 8 2.1a1.15 1.15 0 0 1 1.6 1.6L4.3 9 2.1 9.9Z"/><path d="M6.8 3.3 8.7 5.2"/></svg>';

function makeChevron(expanded: boolean): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = expanded ? "turn-chevron turn-collapse-btn" : "turn-chevron expand";
  btn.title = expanded ? t("折叠这一轮") : t("展开这一轮");
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = expanded ? TURN_COLLAPSE : TURN_CHEVRON;
  return btn;
}

function ensureCollapseButton(turn: HTMLElement[]): void {
  const host =
    turn.find((el) => el.classList.contains("user") && !el.classList.contains("queued"));
  // A page starting inside a task has no question footer to host an action.
  if (!host) return;
  if (messageAction(host, ".turn-collapse-btn")) return;
  const btn = makeChevron(true);
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    pinActiveQuestionUntil = 0;
    turn[0].dataset.turnOpen = "0";
    foldOldTurns();
  });
  ensureMessageMeta(host, { copy: !isCompactCommand(host.dataset.rawText || "") });
  const meta = messageMeta(host);
  const edit = meta?.querySelector<HTMLButtonElement>(":scope > .turn-edit-btn");
  if (meta && edit) meta.insertBefore(btn, edit.nextSibling);
  else meta?.prepend(btn);
}

function foldSource(el: HTMLElement): string {
  if (el.classList.contains("tool-call")) return "";
  const nodes = el.classList.contains("user")
    ? [...el.querySelectorAll(".user-body")]
    : [...el.querySelectorAll(":scope > .md")];
  return nodes
    .map((node) => node.textContent || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandTurn(el: HTMLElement): void {
  const turn = groupTurns().find((items) => items.includes(el));
  if (!turn) return;
  pinActiveQuestionUntil = 0;
  if (allTurnsCollapsed) resetAllTurnCollapse();
  turn[0].dataset.turnOpen = "1";
  unfoldElements(turn);
  ensureCollapseButton(turn);
  requestAnimationFrame(updateQuestionRailActive);
}

function foldLabel(turn: HTMLElement[]): string {
  const question = turn.find(
    (el) => el.classList.contains("user") && !el.classList.contains("queued")
  );
  return (question ? foldSource(question) : foldSource(turn[0])).replace(/\s+/g, " ").trim();
}

function foldOldTurns(): void {
  // Pagination can insert content between an old bar and its first element.
  // Rebuild all bars so no detached/stale turn remains clickable.
  messagesEl.querySelectorAll(":scope > .turn-fold-bar").forEach(bar => bar.remove());
  const turns = groupTurns();
  const userTurns = turns.filter((turn) =>
    turn.some((el) => el.classList.contains("user") && !el.classList.contains("queued"))
  );
  const recent = new Set(userTurns.slice(-RECENT_TURNS));
  for (const turn of turns) {
    unfoldElements(turn);
    if (allTurnsCollapsed) turn[0].dataset.turnOpen = "0";
    const opened = turn[0].dataset.turnOpen === "1";
    const closed = turn[0].dataset.turnOpen === "0";
    const partial = !turn.some(el => el.classList.contains("user") && !el.classList.contains("queued"));
    if ((partial && !closed) || (recent.has(turn) && !closed) || opened) {
      ensureCollapseButton(turn);
      continue;
    }
    const bar = document.createElement("div");
    bar.className = "turn-fold-bar";
    const question = turn.find(el => el.classList.contains("user") && !el.classList.contains("queued"));
    if (question?.dataset.jump) bar.dataset.jump = question.dataset.jump;
    const label = document.createElement("span");
    label.className = "turn-fold-text";
    label.textContent = foldLabel(turn) || t("更早的一轮");
    bar.append(label, makeChevron(false));
    bar.addEventListener("click", () => expandTurn(turn[0]));
    turn[0].before(bar);
    for (const el of turn) {
      el.classList.add("turn-hidden");
      const questionFold = messageAction(el, ".question-fold-btn");
      if (questionFold) questionFold.hidden = true;
    }
  }
  // Folding changes the vertical position of every later question without
  // necessarily producing a scroll event. Re-evaluate after layout settles.
  requestAnimationFrame(updateQuestionRailActive);
}

function turnStateKey(turn: HTMLElement[], index: number): string {
  const question = turn.find((el) => el.classList.contains("user") && !el.classList.contains("queued"));
  if (question?.dataset.jump) return `question:${question.dataset.jump}`;
  const partId = turn.find((el) => el.dataset.partId)?.dataset.partId;
  if (partId) return `partial:${partId}`;
  return `partial:${index}`;
}

function captureTurnViewport(): { turnKey: string; element: HTMLElement; pieceIndex: number; top: number } | null {
  const edge = questionReadingEdge();
  const viewport = messagesEl.getBoundingClientRect();
  const candidates = [...messagesEl.children].filter((node): node is HTMLElement =>
    node instanceof HTMLElement && node.matches(
      ".turn-fold-bar, .message, .tool-call, .perm-card, .ask-card, .git-changes, .work-fold"
    )
  );
  const element = candidates.find(node => {
    const rect = node.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > edge && rect.top < viewport.bottom;
  });
  if (!element) return null;

  const turns = groupTurns();
  const turn = element.classList.contains("turn-fold-bar")
    ? turns.find(items => items[0] === element.nextElementSibling)
    : turns.find(items => items.includes(element));
  const turnFirst = turn?.[0];
  if (!turn || !turnFirst) return null;
  return {
    turnKey: turnStateKey(turn, turns.indexOf(turn)),
    element,
    pieceIndex: turn.indexOf(element),
    top: element.getBoundingClientRect().top - edge,
  };
}

function restoreTurnViewport(anchor: typeof preCollapseViewport): void {
  ignoreScroll = true;
  requestAnimationFrame(() => {
    if (anchor) {
      const turns = groupTurns();
      const turnIndex = turns.findIndex((turn, index) => turnStateKey(turn, index) === anchor.turnKey);
      const turn = turnIndex >= 0 ? turns[turnIndex] : undefined;
      if (turn?.length) {
        const first = turn[0];
        const indexedElement = anchor.pieceIndex >= 0 ? turn[anchor.pieceIndex] : undefined;
        const savedElement = anchor.element.isConnected && messagesEl.contains(anchor.element)
          ? anchor.element
          : indexedElement;
        const anchorVisible = savedElement?.getClientRects().length;
        const foldBar = first.previousElementSibling instanceof HTMLElement
          && first.previousElementSibling.classList.contains("turn-fold-bar")
          ? first.previousElementSibling
          : null;
        const target = anchorVisible ? savedElement! : foldBar ?? first;
        const delta = target.getBoundingClientRect().top - questionReadingEdge() - anchor.top;
        if (Math.abs(delta) >= 1) messagesEl.scrollTop += delta;
      }
    }
    requestAnimationFrame(() => {
      ignoreScroll = false;
      updateQuestionRailActive();
    });
  });
}

function toggleAllTurns(): void {
  pinActiveQuestionUntil = 0;
  const turns = groupTurns();
  if (allTurnsCollapsed) {
    const previous = preCollapseTurnStates;
    const viewport = preCollapseViewport;
    allTurnsCollapsed = false;
    preCollapseTurnStates = null;
    preCollapseViewport = null;
    turns.forEach((turn, index) => {
      const wasOpen = previous?.get(turnStateKey(turn, index));
      if (wasOpen === undefined) delete turn[0].dataset.turnOpen;
      else turn[0].dataset.turnOpen = wasOpen ? "1" : "0";
    });
    foldOldTurns();
    syncCollapseAllButton();
    restoreTurnViewport(viewport);
    return;
  }

  preCollapseViewport = captureTurnViewport();
  preCollapseTurnStates = new Map(turns.map((turn, index) => [
    turnStateKey(turn, index),
    !turn.some((el) => el.classList.contains("turn-hidden")),
  ]));
  allTurnsCollapsed = true;
  for (const turn of turns) turn[0].dataset.turnOpen = "0";
  foldOldTurns();
  syncCollapseAllButton();
  ignoreScroll = true;
  requestAnimationFrame(() => {
    ignoreScroll = false;
    updateQuestionRailActive();
  });
}

function errorActions(text: string): Array<{ act: string; label: string }> {
  const guidance = errorGuidance(text);
  const actions: Array<{ act:string; label:string }> = [{ act: guidance.action, label: guidance.label }];
  if (sentQuestions().at(-1)) actions.push({ act: "retryLast", label: "重试" });
  if (guidance.action !== "retry") actions.push({ act: "retry", label: guidance.category === "model" || guidance.category === "general" ? "重新读取登录" : "重新连接" });
  actions.push({ act: "showLog", label: "打开日志" }, { act: "copyDiagnostics", label: "复制诊断信息" }, { act: "community", label: "社区提问" });
  return actions;
}

function addErrorMessage(text: string): void {
  const question = sentQuestions().at(-1);
  const ownerSessionId = currentSessionId;
  const ownerViewGen = viewGen;
  const failedPrompt = question?.dataset.retryText ?? question?.dataset.rawText;
  finalizeAssistantMessage();
  const empty = messagesEl.querySelector(".empty");
  empty?.remove();
  clearGreetingTimer();
  const el = document.createElement("div");
  el.className = "message error";
  el.dataset.sessionId = ownerSessionId;
  const guidance = errorGuidance(text);
  const actions = errorActions(text)
    .map(
      (a) =>
        `<button type="button" data-act="${escapeText(a.act)}" ${uiLabelAttributes(a.label)}>${escapeText(t(a.label))}</button>`
    )
    .join("");
  el.innerHTML = `<div class="err-title" ${uiLabelAttributes(guidance.title)}>${escapeText(t(guidance.title))}</div>
    <div class="err-guidance" ${uiLabelAttributes(guidance.hint)}>${escapeText(t(guidance.hint))}</div>
    <details class="error-details"><summary ${uiLabelAttributes("错误详情")}>${t("错误详情")}</summary><pre>${escapeText(text)}</pre></details>
    <div class="err-actions">${actions}</div>`;
  el.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (currentSessionId !== ownerSessionId || viewGen !== ownerViewGen) return;
      const act = btn.dataset.act;
      if (act === "retryLast" && question && (failedPrompt || readImageAttachments(JSON.parse(question.dataset.images || "[]")).length)) {
        const images = readImageAttachments(JSON.parse(question?.dataset.images || "[]"));
        addUserMessage(failedPrompt || "", [], false, undefined, undefined, undefined, undefined, images);
        setGenerating(true);
        post({ type: "retryLast", sessionId: ownerSessionId, text: failedPrompt || "", chips: [], attachments: images });
      } else if (act === "showLog") post({ type: "showLog" });
      else if (act === "retry") post({ type: "retry" });
      else if (act === "pickModel") openOverlay("models");
      else if (act === "binaryPath" || act === "nodePath") post({type:"openRecoverySettings", setting:act});
      else if (act === "community") post({type:"openCommunity"});
      else if (act === "copyDiagnostics") post({type:"copyDiagnostics"});
    });
  });
  attachMessage(el);
  scrollToBottom();
}

function addUserMessage(
  text: string,
  chips: ContextChip[] = [],
  queued = false,
  queueItemId?: string,
  messageId?: string,
  createdAt?: number,
  sourceCommandId?: string,
  images: ImageAttachment[] = [],
  attachmentTarget?: {rowId:number;entityId:string},
  editPending = false,
  sessionRefs: SessionReference[] = []
): HTMLElement {
  if (!queued && isGenerating && !suspendScroll) {
    // An immediate insertion begins a new visible segment, not a new copy of
    // the task-wide clock. A queued draft does not end the current segment.
    finalizeAssistantMessage();
    settleWorkFolds("completed", true);
    turnWorkStarted = createdAt && createdAt > 0 ? createdAt : Date.now();
  }
  const empty = messagesEl.querySelector(".empty");
  empty?.remove();
  clearGreetingTimer();
  const parsed = parsePromptDisplay(text);
  const el = document.createElement("div");
  el.className = queued ? "message user queued" : "message user";
  el.dataset.sessionId = currentSessionId;
  if (queueItemId) el.dataset.queueId = queueItemId;
  if (sourceCommandId) el.dataset.sourceCommandId = sourceCommandId;
  el.dataset.rawText = text;
  el.dataset.images = JSON.stringify(images);
  const shownSessionRefs = sessionRefs.length ? sessionRefs : parsed.sessionRefs;
  el.dataset.sessionRefs = JSON.stringify(shownSessionRefs);
  el.dataset.retryText = parsed.sessionRefs.length ? text : chips.length || sessionRefs.length ? buildPrompt(text, chips, sessionRefs) : text;
  const shown = chips.length
    ? chips
        .filter((c) => !c.hidden)
        .map((c) => ({ label: chipLabel(c), title: chipTitle(c) }))
    : parsed.chips;
  const body = chips.length ? text : parsed.body;
  const sessionRefHtml = shownSessionRefs.map(reference =>
    `<span class="ctx-chip session-ref-chip" title="${escapeText(reference.title)}">${SESSION_REF_ICON}<span>${escapeText(reference.title)}</span></span>`
  ).join("");
  const chipHtml = shown.length || sessionRefHtml
    ? `<div class="user-chips">${shown
        .map(
          (c) =>
            `<span class="ctx-chip" title="${escapeText(c.title)}"><span>${escapeText(
              c.label
            )}</span></span>`
        )
        .join("")}${sessionRefHtml}</div>`
    : "";
  const queuedUi = queued
    ? `<div class="queued-tag">${t("排队中，当前回复结束后发送")}</div>`
    : "";
  const commandParts = queued ? undefined : splitCommandBody(body);
  const bodyHtml = commandParts
    ? `${commandParts.badge}${escapeText(commandParts.rest)}`
    : escapeText(body);
  const actions = queued
    ? `<div class="queued-actions">
        <button type="button" data-qact="now" title="${t("立即发送")}" aria-label="${t("立即发送")}">${lucideIcon("chevronsUp")}</button>
        <button type="button" data-qact="edit" title="${t("修改")}" aria-label="${t("修改")}">${lucideIcon("pencil")}</button>
        <button type="button" data-qact="delete" title="${t("删除")}" aria-label="${t("删除")}">${lucideIcon("trash2")}</button>
      </div>`
    : "";
  el.innerHTML = `${queuedUi}${chipHtml}<div class="user-body">${bodyHtml}</div>${actions}`;
  renderUserImages(el, images, attachmentTarget);
  if (!queued) {
    if (createdAt && createdAt > 0) el.dataset.sentAt = String(createdAt);
    else if (!messageId) el.dataset.sentAt = String(Date.now());
  }
  if (queued) bindQueuedActions(el);
  else if (messageId) el.dataset.jump = messageId;
  else {
    if (!el.dataset.jump) el.dataset.jump = `q${++jumpSeq}`;
    el.dataset.live = "1";
  }
  attachMessage(el);
  if (queued) placeQueuedCard(el);
  if (!queued) {
    // /compact is a timeline operation, not a normal question — keep time/collapse,
    // but omit the copy control that would otherwise treat it like chat prose.
    ensureMessageMeta(el, { copy: !isCompactCommand(text) });
    syncQuestionFoldControl(el, false);
    if (editPending && !isCompactCommand(text)) ensurePendingEditPen(el);
    // Backend turn IDs can change at an inserted prompt, so the preceding
    // work segment must be collapsed from transcript order, not turn metadata.
    collapseSupersededWorkFolds();
  }
  if (!suspendScroll) {
    syncQuestionRail();
    foldOldTurns();
    scrollToBottom(true);
  }
  return el;
}

function sameQuery(el: HTMLElement, serverText: string, images: ImageAttachment[] = []): boolean {
  if (JSON.stringify(readImageAttachments(JSON.parse(el.dataset.images || "[]" )).map(i => i.ref)) !== JSON.stringify(images.map(i => i.ref))) return false;
  if (!serverText.trim() && images.length) return true;
  const server = serverText.trim();
  const raw = (el.dataset.rawText || "").trim();
  if (raw && raw === server) return true;
  const shown = (el.querySelector(".user-body")?.textContent || "").trim();
  const parsed = parsePromptDisplay(server).body.trim();
  if (shown && parsed && shown === parsed) return true;
  if (raw && server.endsWith(raw)) return true;
  return false;
}

function pairTurns(
  users: HTMLElement[],
  turns: ConversationTurn[]
): Map<string, HTMLElement> {
  const paired = new Map<string, HTMLElement>();
  let cursor = users.length - 1;
  for (let index = turns.length - 1; index >= 0 && cursor >= 0; index--) {
    const turn = turns[index];
    if (turn.userTarget && users[cursor].dataset.jump === turn.userTarget.entityId || sameQuery(users[cursor], turn.userText, turn.userAttachments)) {
      paired.set(turn.turnId, users[cursor]);
      cursor -= 1;
      continue;
    }
    let found = -1;
    for (let userIndex = cursor; userIndex >= 0; userIndex--) {
      if (turn.userTarget && users[userIndex].dataset.jump === turn.userTarget.entityId || sameQuery(users[userIndex], turn.userText, turn.userAttachments)) {
        found = userIndex;
        break;
      }
    }
    if (found < 0) continue;
    paired.set(turn.turnId, users[found]);
    cursor = found - 1;
  }
  return paired;
}

function applyStoredConversation(): void {
  if (latestConversation) applyConversation(latestConversation);
}

function applyConversation(view: ConversationView): void {
  latestConversation = view;
  const users = sentQuestions();
  const turns = view.turns.filter((turn) => turn.userText || turn.userAttachments?.length);
  const paired = pairTurns(users, turns);
  const keep = new Set<string>();
  for (const turn of turns) {
    const bubble = paired.get(turn.turnId);
    if (bubble && !bubble.classList.contains("editing") && turn.userAttachments?.length) renderUserImages(bubble, turn.userAttachments, turn.userTarget);
    if (!bubble) continue;
    if (turn.fileChanges) {
      keep.add(turn.turnId);
      upsertGitCard(bubble, turn);
      const jump = bubble.dataset.jump;
      if (jump) {
        messagesEl
          .querySelector<HTMLElement>(`.git-changes[data-local-turn="${CSS.escape(jump)}"]`)
          ?.remove();
        localTurnFiles.delete(jump);
      }
    }
    updateTurnPreviews(turn, bubble);
  }
  for (const card of [...messagesEl.querySelectorAll<HTMLElement>(".git-changes")]) {
    if (card.dataset.local === "1") continue;
    if (!keep.has(card.dataset.turnId || "")) card.remove();
  }
  syncEditButton(view.editable, users);
  pinGitCards();
  if (!suspendScroll) foldOldTurns();
  followTranscriptGrowth();
}

function pinGitCards(): void {
  // Resolve ownership from the question, never from a card's current DOM
  // position. Repeated updates must not migrate older changes to a later task.
  const turns = groupTurns();
  const cards = [...messagesEl.querySelectorAll<HTMLElement>(".git-changes")];
  for (const turn of turns) {
    const questions = new Set(turn.filter(node => node.classList.contains("user") && !node.classList.contains("queued")).map(node => node.dataset.jump));
    const owned = cards.filter(card => card.dataset.ownerJump
      ? questions.has(card.dataset.ownerJump) : turn.includes(card));
    if (owned.some(card => card.dataset.local !== "1")) {
      for (const card of owned.filter(card => card.dataset.local === "1")) {
        localTurnFiles.delete(card.dataset.localTurn || "");
        card.remove();
      }
    }
    let last = turn.filter(node => !node.classList.contains("git-changes")).at(-1);
    if (last?.classList.contains("user")) last = messageMeta(last) ?? last;
    for (const card of owned.filter(card => card.isConnected)) {
      if (last) last.after(card);
      last = card;
    }
  }
  reconcileCompletedReveal();
}

function syncEditButton(
  editable: ConversationView["editable"],
  users: HTMLElement[]
): void {
  const last = users[users.length - 1];
  for (const el of users) {
    if (el.querySelector(".user-edit")) {
      if (editable && el === last) {
        el.dataset.rowId = String(editable.target.rowId);
        el.dataset.entityId = editable.target.entityId;
        el.dataset.serverText = editable.text;
      }
      continue;
    }
    const match = !!editable && el === last && sameQuery(el, editable.text, editable.attachments);
    if (!match || !editable) {
      const pending = messageAction(el, ".turn-edit-btn");
      if (pending?.dataset.editPending === "1" && el === last && !editable && isGenerating) continue;
      el.querySelector(".user-actions")?.remove();
      pending?.remove();
      delete el.dataset.rowId;
      delete el.dataset.entityId;
      continue;
    }
    el.dataset.rowId = String(editable.target.rowId);
    el.dataset.entityId = editable.target.entityId;
    el.dataset.serverText = editable.text;
    el.querySelector(".user-actions")?.remove();
    ensureEditPen(el);
  }
}

function ensureEditPen(el: HTMLElement): void {
  ensureMessageMeta(el, { copy: !isCompactCommand(el.dataset.rawText || "") });
  const existing = messageAction(el, ".turn-edit-btn");
  if (existing) {
    existing.hidden = false;
    existing.disabled = false;
    existing.classList.remove("edit-pending");
    delete existing.dataset.editPending;
    existing.title = t("编辑");
    existing.setAttribute("aria-label", t("编辑"));
    existing.removeAttribute("aria-disabled");
    bindEditPenClick(existing, el);
    bindUserEdit(el);
    return;
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "turn-chevron turn-edit-btn";
  btn.dataset.uedit = "open";
  btn.title = t("编辑");
  btn.setAttribute("aria-label", t("编辑"));
  btn.innerHTML = TURN_PEN;
  ensureMessageMeta(el, { copy: !isCompactCommand(el.dataset.rawText || "") });
  messageMeta(el)?.prepend(btn);
  bindEditPenClick(btn, el);
  bindUserEdit(el);
}

function ensurePendingEditPen(el: HTMLElement): void {
  ensureMessageMeta(el, { copy: !isCompactCommand(el.dataset.rawText || "") });
  if (messageAction(el, ".turn-edit-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "turn-chevron turn-edit-btn edit-pending";
  btn.dataset.editPending = "1";
  btn.disabled = true;
  btn.title = t("还没有同步到桌面会话，暂时不能编辑");
  btn.setAttribute("aria-label", t("还没有同步到桌面会话，暂时不能编辑"));
  btn.setAttribute("aria-disabled", "true");
  btn.innerHTML = TURN_PEN;
  messageMeta(el)?.prepend(btn);
}

function bindEditPenClick(btn: HTMLButtonElement, el: HTMLElement): void {
  if (btn.dataset.editClickBound === "1") return;
  btn.dataset.editClickBound = "1";
  btn.addEventListener("click", (event) => { event.stopPropagation(); beginUserEdit(el); });
}

function removePendingEditPens(): void {
  document.querySelectorAll<HTMLButtonElement>('.turn-edit-btn[data-edit-pending="1"]').forEach(button => button.remove());
}

function bindUserEdit(el: HTMLElement): void {
  if (el.dataset.editBound) return;
  el.dataset.editBound = "1";
  el.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-uedit]");
    if (!btn || !el.contains(btn)) return;
    event.stopPropagation();
    const act = btn.dataset.uedit;
    if (act === "open") beginUserEdit(el);
    else if (act === "cancel") cancelUserEdit(el);
    else if (act === "send") submitUserEdit(el, "preserve");
    else if (act === "rewind") submitUserEdit(el, "rewind");
    else if (act === "add-image") {
      post({ type: "pickAttachments", sessionId: draftSessionId, maxImages: Math.max(0, IMAGE_MAX_COUNT - editImageSlots(el)), edit: true, editRequestId:el.dataset.editRequestId });
    }
  });
}

function editImageSlots(el: HTMLElement): number {
  return [...el.querySelectorAll<HTMLElement>(".user-images .image-chip")].filter(chip => chip.dataset.removed !== "1" && chip.dataset.status !== "error").length;
}

function ensureEditImageGroup(el: HTMLElement): HTMLElement {
  let group = el.querySelector<HTMLElement>(".user-images");
  if (!group) {
    group = document.createElement("div");
    group.className = "user-images";
    el.prepend(group);
  }
  group.dataset.editing = "1";
  return group;
}

function ensureEditAddButton(el: HTMLElement): void {
  const actions = el.querySelector<HTMLElement>(".user-actions");
  if (!actions || actions.querySelector(".edit-add-image")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "edit-add-image user-edit-action";
  button.dataset.uedit = "add-image";
  button.title = t("添加图片或文件");
  button.setAttribute("aria-label", t("添加图片或文件"));
  button.innerHTML = ICON_EDIT_ATTACH;
  actions.prepend(button);
}

function appendEditImageChip(el: HTMLElement, id: string, fileName: string): HTMLElement {
  const group = ensureEditImageGroup(el);
  const chip = document.createElement("div");
  chip.className = "image-chip";
  chip.dataset.added = "1";
  chip.dataset.imageId = id;
  chip.dataset.status = "uploading";
  chip.title = fileName;
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "image-preview-btn";
  preview.disabled = true;
  preview.innerHTML = `<span class="image-name">${t("添加图片中…")}</span>`;
  chip.append(preview);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "image-remove";
  remove.innerHTML = CLOSE;
  remove.setAttribute("aria-label", `${t("移除图片")} · ${fileName}`);
  remove.onclick = event => { event.stopPropagation(); chip.remove(); };
  chip.append(remove);
  const add = group.querySelector(".edit-add-image");
  if (add) group.insertBefore(chip, add);
  else group.append(chip);
  ensureEditAddButton(el);
  return chip;
}

function editImageChip(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.user-images .image-chip[data-image-id="${CSS.escape(id)}"]`);
}

async function addEditImageFile(el: HTMLElement, file: File): Promise<void> {
  if (holdStreams || !draftSessionId || el.dataset.editSubmissionId) return;
  if (editImageSlots(el) >= IMAGE_MAX_COUNT) { showToast(t("最多添加 8 张图片。")); return; }
  if (file.size > IMAGE_MAX_BYTES) { showToast(t("每张图片不能超过 20 MB。")); return; }
  if (!IMAGE_MIMES.includes(file.type as typeof IMAGE_MIMES[number])) { showToast(t("请选择 PNG、JPEG、WebP 或 GIF 图片。")); return; }
  const owner = draftSessionId, editRequestId = el.dataset.editRequestId;
  const id = crypto.randomUUID();
  const chip = appendEditImageChip(el, id, file.name || "image.png");
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const thumbnail = await imageThumbnail(dataUrl);
    if (!chip.isConnected || owner !== draftSessionId || editRequestId !== el.dataset.editRequestId) return;
    if (!thumbnail) {
      chip.dataset.status = "error";
      showToast(t("图片无法解码，请选择有效的图片。"));
      return;
    }
    cacheDraftPreview(id, dataUrl);
    const preview = chip.querySelector(".image-preview-btn");
    const img = document.createElement("img");
    img.src = thumbnail;
    img.alt = "";
    preview?.replaceChildren(img);
    if (preview instanceof HTMLButtonElement) {
      preview.disabled = false;
      preview.onclick = event => { event.stopPropagation(); showDraftPreview({ id, sessionId: draftSessionId, fileName: file.name || "image.png", mime: file.type, bytes: file.size, status: "uploading" }); };
    }
    post({ type: "uploadImage", imageId: id, sessionId: owner, fileName: file.name, dataUrl, edit:true, editRequestId });
  } catch {
    if (chip.isConnected) chip.dataset.status = "error";
    showToast(t("图片添加失败，请重新添加。"));
  }
}

function bindEditImageInput(el: HTMLElement, ta: HTMLTextAreaElement): void {
  const take = (files: File[], event: Event) => {
    if (ta.readOnly) { event.preventDefault(); return; }
    const images = files.filter(file => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    for (const image of images) void addEditImageFile(el, image);
  };
  ta.addEventListener("paste", event => {
    if (ta.readOnly) { event.preventDefault(); return; }
    const images = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (text && !/^(?:file:\/\/|data:image\/)/i.test(text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    for (const image of images) void addEditImageFile(el, image);
  });
  ta.addEventListener("dragover", event => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
  ta.addEventListener("drop", event => take(Array.from(event.dataTransfer?.files ?? []), event));
}

function applyEditImageMessage(msg: { type?: string; edit?: boolean; sessionId?: string; editRequestId?: string; imageId?: string; fileName?: string; attachment?: unknown; dataUrl?: string; message?: string }): boolean {
  if (msg.edit) {
    const editor = [...document.querySelectorAll<HTMLElement>(".message.user.editing")]
      .find(node => node.dataset.editRequestId === msg.editRequestId);
    // Consume obsolete edit events: never fall back to the normal composer.
    if (holdStreams || msg.sessionId !== draftSessionId || !editor || !msg.editRequestId || editor.dataset.editRequestId !== msg.editRequestId) return true;
  }
  if (msg.type === "image_pending" && msg.edit && msg.imageId) {
    const host = [...document.querySelectorAll<HTMLElement>(".message.user.editing")]
      .find(node => node.dataset.editRequestId === msg.editRequestId);
    if (!(host instanceof HTMLElement)) return false;
    if (editImageSlots(host) >= IMAGE_MAX_COUNT) { showToast(t("最多添加 8 张图片。")); return true; }
    appendEditImageChip(host, msg.imageId, msg.fileName || "image.png");
    return true;
  }
  const chip = msg.imageId ? editImageChip(msg.imageId) : null;
  if (!chip) return !!msg.edit;
  if (msg.type === "image_failed") {
    chip.dataset.status = "error";
    showToast(msg.message || t("图片添加失败，请重新添加。"));
    return true;
  }
  if (msg.type === "image_ready") {
    const attachment = readImageAttachments([msg.attachment])[0];
    if (!attachment) {
      chip.dataset.status = "error";
      showToast(t("图片添加失败，请重新添加。"));
      return true;
    }
    chip.dataset.status = "ready";
    chip.dataset.attachment = JSON.stringify(attachment);
    const preview = chip.querySelector(".image-preview-btn");
    if (preview instanceof HTMLButtonElement) {
      preview.disabled = false;
      preview.onclick = event => {
        event.stopPropagation();
        if (!showDraftPreview({ id: msg.imageId!, sessionId: draftSessionId, fileName: attachment.fileName, mime: attachment.mime, bytes: attachment.bytes, status: "ready", ref: attachment.ref })) {
          previewImage(attachment);
        }
      };
    }
    if (typeof msg.dataUrl === "string") {
      cacheDraftPreview(msg.imageId!, msg.dataUrl);
      void imageThumbnail(msg.dataUrl).then(thumbnail => {
        if (!thumbnail || !chip.isConnected) return;
        const img = document.createElement("img");
        img.src = thumbnail;
        img.alt = "";
        preview?.replaceChildren(img);
      });
    }
    return true;
  }
  return false;
}

function armEditImageRemoval(el: HTMLElement): void {
  // Match the desktop edit dialog: while editing, each sent image can be
  // dropped before resending. Tapping the badge again brings the image back.
  const group = el.querySelector<HTMLElement>(".user-images");
  if (!group || !group.querySelector(".image-chip")) return;
  group.dataset.editing = "1";
  group.querySelectorAll<HTMLElement>(".image-chip").forEach(chip => {
    if (chip.querySelector(".image-remove")) return;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.innerHTML = CLOSE;
    remove.setAttribute("aria-label", t("移除图片"));
    remove.onclick = event => {
      event.stopPropagation();
      const removed = chip.dataset.removed === "1";
      if (removed) delete chip.dataset.removed;
      else chip.dataset.removed = "1";
      remove.setAttribute("aria-label", removed ? t("移除图片") : t("恢复图片"));
    };
    chip.append(remove);
  });
}

function disarmEditImageRemoval(el: HTMLElement, restore = true): void {
  const group = el.querySelector<HTMLElement>(".user-images");
  if (!group) return;
  delete group.dataset.editing;
  group.querySelectorAll(".image-remove").forEach(button => button.remove());
  group.querySelectorAll(".image-chip[data-added], .edit-add-image").forEach(node => node.remove());
  if (!group.querySelector(".image-chip")) group.remove();
  if (restore) group.querySelectorAll<HTMLElement>(".image-chip").forEach(chip => delete chip.dataset.removed);
}

function editRemainingAttachments(el: HTMLElement): ImageAttachment[] {
  const all = readImageAttachments(JSON.parse(el.dataset.images || "[]"));
  const chips = [...(el.querySelector(".user-images")?.querySelectorAll<HTMLElement>(".image-chip") ?? [])];
  const originals = chips.filter(chip => chip.dataset.added !== "1");
  const kept = originals.length ? all.filter((_, index) => originals[index]?.dataset.removed !== "1") : all;
  const added = chips.filter(chip => chip.dataset.added === "1" && chip.dataset.status === "ready").map(chip => {
    try { return JSON.parse(chip.dataset.attachment || ""); } catch { return null; }
  });
  return readImageAttachments([...kept, ...added]);
}

function editBubbleWidth(el: HTMLElement, originalWidth: number): number {
  const available = el.parentElement?.clientWidth || originalWidth;
  const box = getComputedStyle(el);
  const chrome = [box.paddingLeft, box.paddingRight, box.borderLeftWidth, box.borderRightWidth]
    .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
  const contentWidth = (node: HTMLElement | null) => {
    if (!node) return 0;
    const saved = node.style.cssText;
    node.style.flexWrap = "nowrap";
    node.style.width = "max-content";
    const width = node.scrollWidth;
    node.style.cssText = saved;
    return width;
  };
  const buttonRow = contentWidth(el.querySelector(".user-actions")) + chrome + 2;
  const tileRow = contentWidth(el.querySelector(".user-images")) + chrome + 2;
  // Keep a long message at its own width. A short one grows just enough for
  // the compact attachment/action footer and any image thumbnails.
  return Math.min(available, Math.max(originalWidth, buttonRow, tileRow));
}

function beginUserEdit(el: HTMLElement): void {
  if (el.querySelector(".user-edit")) return;
  const body = el.querySelector(".user-body");
  if (!body) return;
  const originalWidth=el.getBoundingClientRect().width;
  el.classList.add("editing");
  el.dataset.editRequestId = crypto.randomUUID();
  el.style.width=originalWidth+"px";
  const serializedText = el.dataset.serverText || el.dataset.rawText || body.textContent || "";
  const refs = parsePromptDisplay(serializedText).sessionRefs;
  if (refs.length) el.dataset.sessionRefs = JSON.stringify(refs);
  const ta = document.createElement("textarea");
  ta.className = "user-edit";
  ta.value = stripSessionReferences(serializedText);
  body.replaceWith(ta);
  armEditImageRemoval(el);
  const pen = messageAction(el, ".turn-edit-btn");
  if (pen) pen.hidden = true;
  let actions = el.querySelector(".user-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "user-actions";
    el.appendChild(actions);
  }
  actions.innerHTML = `
      <span class="user-edit-action-group">
        <button type="button" class="user-edit-action" data-uedit="cancel" title="${escapeText(t("取消"))}" aria-label="${escapeText(t("取消"))}">${ICON_EDIT_CANCEL}</button>
        <button type="button" class="user-edit-action" data-uedit="rewind" title="${escapeText(t("对话 + 文件重置"))}" aria-label="${escapeText(t("对话 + 文件重置"))}">${ICON_EDIT_REWIND}</button>
        <button type="button" class="user-edit-action user-edit-send" data-uedit="send" title="${escapeText(t("发送"))}" aria-label="${escapeText(t("发送"))}">${ICON_SEND}</button>
      </span>`;
  ensureEditAddButton(el);
  el.style.width=editBubbleWidth(el, originalWidth)+"px";
  const resize = () => { ta.style.height="auto"; ta.style.height=Math.max(64,Math.min(ta.scrollHeight,320))+"px"; };
  resize(); ta.addEventListener("input",resize);
  bindEditImageInput(el, ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function cancelUserEdit(el: HTMLElement): void {
  el.classList.remove("editing");
  delete el.dataset.editRequestId;
  delete el.dataset.editSubmissionId;
  el.style.removeProperty("width");
  const text = el.dataset.serverText || el.dataset.rawText || "";
  const ta = el.querySelector(".user-edit");
  const parsed = parsePromptDisplay(text);
  const body = document.createElement("div");
  body.className = "user-body";
  body.textContent = parsed.body || text;
  ta?.replaceWith(body);
  disarmEditImageRemoval(el);
  el.querySelector(".user-actions")?.remove();
  const pen = messageAction(el, ".turn-edit-btn");
  if (pen) pen.hidden = false;
}

function setEditSubmitting(el: HTMLElement, pending: boolean): void {
  const ta = el.querySelector<HTMLTextAreaElement>(".user-edit");
  if (ta) ta.readOnly = pending;
  for (const button of el.querySelectorAll<HTMLButtonElement>(".user-actions button, .image-remove")) {
    if (button.dataset.uedit !== "cancel") button.disabled = pending;
  }
}

function submittedEditor(msg: { sessionId?: string; viewGen?: number; entityId?: string; editRequestId?: string; commandId?: string }): HTMLElement | undefined {
  if (holdStreams || msg.sessionId !== currentSessionId || msg.viewGen !== viewGen || !msg.editRequestId || !msg.commandId || !msg.entityId) return;
  return sentQuestions().find(node => node.dataset.entityId === msg.entityId
    && node.dataset.editRequestId === msg.editRequestId && node.dataset.editSubmissionId === msg.commandId);
}

function submitUserEdit(el: HTMLElement, workspaceMode: "preserve" | "rewind"): void {
  if (el.dataset.editSubmissionId) return;
  const ta = el.querySelector<HTMLTextAreaElement>(".user-edit");
  const text = ta?.value.trim() || "";
  const rowId = Number(el.dataset.rowId);
  const entityId = el.dataset.entityId;
  const attachments = editRemainingAttachments(el);
  if (el.querySelector('.user-images .image-chip[data-added][data-status="uploading"], .user-images .image-chip[data-added][data-status="error"]')) {
    showToast(t("请等待图片添加完成，或移除失败的图片。"));
    return;
  }
  if ((!text && !attachments.length) || !entityId || !Number.isFinite(rowId)) return;
  let sessionRefs: SessionReference[] = [];
  try {
    const saved = JSON.parse(el.dataset.sessionRefs || "[]");
    if (Array.isArray(saved)) sessionRefs = saved.filter((item): item is SessionReference => !!item && typeof item.sessionId === "string" && typeof item.title === "string");
  } catch { /* Treat malformed DOM state as no references. */ }
  const commandId = crypto.randomUUID();
  el.dataset.editSubmissionId = commandId;
  setEditSubmitting(el, true);
  post({ type: "editLast", sessionId: el.dataset.sessionId, viewGen, editRequestId: el.dataset.editRequestId, commandId,
    text, sessionRefs, rowId, entityId, workspaceMode, attachments });
}

function applyQueryRewind(el: HTMLElement, text: string, attachments: ImageAttachment[]): void {
  el.classList.remove("editing");
  delete el.dataset.editRequestId;
  delete el.dataset.editSubmissionId;
  el.style.removeProperty("width");
  el.dataset.rawText = text;
  el.dataset.serverText = text;
  const parsed = parsePromptDisplay(text);
  el.dataset.retryText = text;
  el.dataset.sessionRefs = JSON.stringify(parsed.sessionRefs);
  el.dataset.live = "1";
  const ta = el.querySelector(".user-edit");
  const body = document.createElement("div");
  body.className = "user-body";
  body.textContent = parsed.body || text;
  if (ta) ta.replaceWith(body);
  else {
    const existing = el.querySelector(".user-body");
    if (existing) existing.textContent = parsed.body || text;
  }
  disarmEditImageRemoval(el);
  el.dataset.images = JSON.stringify(attachments);
  delete el.dataset.imageSignature;
  renderUserImages(el, attachments);
  el.style.removeProperty("width");
  let node = el.nextElementSibling;
  while (node) {
    const next = node.nextElementSibling;
    if (!node.classList.contains("queued")) node.remove();
    node = next;
  }
  currentAssistantEl = null;
  ensureMessageMeta(el, { copy: !isCompactCommand(el.dataset.rawText || text) });
  el.querySelector(".user-actions")?.remove();
  const pen = messageAction(el, ".turn-edit-btn");
  if (pen) pen.hidden = false;
  else syncEditButton(latestConversation?.editable ?? null, sentQuestions());
  // The previous stop must not leave the new turn's stop control disabled.
  activityPhase = "waiting";
  activitySince = Date.now();
  setGenerating(true);
  foldOldTurns();
  scrollToBottom(true);
}

const PREVIEW_FILE_EXTENSION = /\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)$/i;

function previewTurnElements(bubble: HTMLElement): HTMLElement[] {
  return groupTurns().find(nodes => nodes.includes(bubble)) ?? [];
}

function assistantElementsInTurn(bubble: HTMLElement): HTMLElement[] {
  return previewTurnElements(bubble).flatMap(node => [
    ...(node.matches(".message.assistant") ? [node] : []),
    ...node.querySelectorAll<HTMLElement>(".message.assistant"),
  ]);
}

function previewCandidatesForTurn(bubble: HTMLElement): string[] {
  const candidates: string[] = [];
  for (const assistant of assistantElementsInTurn(bubble)) {
    for (const link of assistant.querySelectorAll<HTMLAnchorElement>(".md a[href]")) {
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("//") || /^(?![a-zA-Z]:[\\/])[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) continue;
      let filePath = href;
      try { filePath = decodeURIComponent(href); } catch { /* Literal percent sign. */ }
      if (PREVIEW_FILE_EXTENSION.test(filePath)) candidates.push(filePath);
    }
  }
  return candidates.slice(0, 15);
}

function renderTurnPreviews(bubble: HTMLElement, cards: ReplyPreviewFile[]): void {
  const assistants = assistantElementsInTurn(bubble);
  const final = assistants.filter(node => !node.closest(".work-fold") && !node.hidden).at(-1) ?? assistants.at(-1);
  for (const node of assistants) if (node !== final) node.querySelector(":scope > .file-previews")?.remove();
  if (!final || !cards.length) { final?.querySelector(":scope > .file-previews")?.remove(); return; }
  let container = final.querySelector<HTMLElement>(":scope > .file-previews");
  const signature = JSON.stringify(cards);
  if (container?.dataset.signature === signature) return;
  if (!container) {
    container = document.createElement("div");
    container.className = "file-previews";
    final.append(container);
  }
  container.dataset.signature = signature;
  container.replaceChildren();
  const owner = currentSessionId;
  for (const file of cards) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-preview-card";
    button.title = file.path;
    button.setAttribute("aria-label", `${t("打开")} ${file.name}`);
    button.innerHTML = '<span class="file-preview-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.75h8l4 4V21.25H6z"/><path d="M14 2.75v4h4M9 12h6M9 16h6"/></svg></span><span class="file-preview-copy"><span class="file-preview-name"></span><span class="file-preview-subtitle"></span></span><span class="file-preview-open"></span>';
    button.querySelector(".file-preview-name")!.textContent = file.name;
    button.querySelector(".file-preview-subtitle")!.textContent = file.kind === "markdown" ? t("文档 · MD") : t("文件 · {0}", { 0: file.extension });
    button.querySelector(".file-preview-open")!.textContent = t("打开");
    button.addEventListener("click", () => post({ type: "openMarkdownFile", path: file.path, sessionId: owner }));
    container.append(button);
  }
}

function updateTurnPreviews(turn: ConversationTurn, bubble: HTMLElement): void {
  const candidates = previewCandidatesForTurn(bubble);
  if (!candidates.length) { renderTurnPreviews(bubble, []); return; }
  const change = turn.fileChanges;
  const signature = JSON.stringify([candidates, change?.target.rowId, change?.target.entityId, change?.summary.state]);
  const cached = previewResults.get(turn.turnId);
  if (cached?.signature === signature) { renderTurnPreviews(bubble, cached.cards); return; }
  renderTurnPreviews(bubble, []);
  if (previewRequests.get(turn.turnId) === signature) return;
  previewRequests.set(turn.turnId, signature);
  post({ type: "loadPreviewFiles", sessionId: currentSessionId, turnId: turn.turnId, signature,
    previewCandidates: candidates, rowId: change?.target.rowId, entityId: change?.target.entityId,
    fileChangesState: change?.summary.state });
}

function showTurnPreviews(turnId: string, signature: string, cards: ReplyPreviewFile[]): void {
  if (previewRequests.get(turnId) !== signature) return;
  previewRequests.delete(turnId);
  previewResults.set(turnId, { signature, cards });
  const turn = latestConversation?.turns.find(item => item.turnId === turnId);
  if (!turn) return;
  const bubble = pairTurns(sentQuestions(), latestConversation!.turns).get(turnId);
  if (!bubble) return;
  updateTurnPreviews(turn, bubble);
  followTranscriptGrowth();
}

function upsertGitCard(bubble: HTMLElement, turn: ConversationTurn): void {
  const change = turn.fileChanges;
  if (!change) return;
  let card = messagesEl.querySelector<HTMLElement>(
    `.git-changes[data-turn-id="${CSS.escape(turn.turnId)}"]`
  );
  const signature = `${change.summary.files}:${change.summary.additions}:${change.summary.deletions}:${change.summary.state ?? ""}:${change.canRewind ? 1 : 0}`;
  if (!card) {
    card = document.createElement("div");
    card.className = "git-changes";
    card.dataset.turnId = turn.turnId;
    card.dataset.ownerJump = bubble.dataset.jump;
    card.addEventListener("click", onGitClick);
    bubble.after(card);
  }
  card.dataset.sessionId = bubble.dataset.sessionId;
  card.dataset.rowId = String(change.target.rowId);
  card.dataset.entityId = change.target.entityId;
  card.dataset.reverted = change.summary.state === "reverted" ? "1" : "0";
  if (!card.querySelector(".git-head")) {
    card.innerHTML = gitCardHtml(change);
    card.dataset.signature = signature;
    return;
  }
  if (card.dataset.signature === signature) return;
  card.dataset.signature = signature;
  const title = card.querySelector(".git-title");
  if (title) setUiLabel(title as HTMLElement, "{0} 个文件已更改", { 0: change.summary.files });
  const add = card.querySelector(".git-add");
  const del = card.querySelector(".git-del");
  if (add) add.textContent = `+${change.summary.additions}`;
  if (del) del.textContent = `-${change.summary.deletions}`;
  let badge = card.querySelector(".git-reverted");
  if (change.summary.state === "reverted") {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "git-reverted";
      badge.textContent = t("已撤销");
      card.querySelector(".git-head")?.appendChild(badge);
    }
  } else {
    badge?.remove();
  }
  const rewind = card.querySelector<HTMLButtonElement>(".git-rewind");
  if (rewind) rewind.hidden = !change.canRewind;
  gitFileLists.delete(turn.turnId);
  if (card.classList.contains("open")) requestGitFiles(card);
}

function gitCardHtml(change: NonNullable<ConversationTurn["fileChanges"]>): string {
  const reverted = change.summary.state === "reverted";
  return `<div class="git-bar">
      <button type="button" class="git-head" aria-expanded="false">
        <span class="git-chevron" aria-hidden="true"></span>
        <span class="git-title" ${uiLabelAttributes("{0} 个文件已更改", { 0: change.summary.files })}>${t("{0} 个文件已更改", { 0: change.summary.files })}</span>
        <span class="git-stat"><span class="git-add">+${change.summary.additions}</span> <span class="git-del">-${change.summary.deletions}</span></span>
        ${reverted ? `<span class="git-reverted">${t("已撤销")}</span>` : ""}
      </button>
      <button type="button" class="git-rewind"${change.canRewind ? "" : " hidden"}>${t("撤销")}</button>
    </div>
    <div class="git-body" hidden></div>`;
}

function onGitClick(event: Event): void {
  const card = event.currentTarget as HTMLElement;
  const target = event.target as HTMLElement;
  const local = card.dataset.local === "1";
  if (target.closest(".git-file") && !target.closest("button")) {
    const row = target.closest<HTMLElement>(".git-file");
    if (local) openLocalReview(card, row);
    else openGitReview(card, row);
    return;
  }
  const btn = target.closest("button");
  if (!btn || !card.contains(btn)) return;
  event.stopPropagation();
  if (btn.classList.contains("git-head")) {
    const open = card.classList.toggle("open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    const body = card.querySelector<HTMLElement>(".git-body");
    if (body) body.hidden = !open;
    if (open) {
      if (local) renderLocalFiles(card);
      else requestGitFiles(card);
    }
    followTranscriptGrowth();
    return;
  }
  if (btn.classList.contains("git-rewind")) {
    if (!card.querySelector(".git-confirm")) {
      const bar = document.createElement("div");
      bar.className = "git-confirm";
      bar.textContent = t("撤销这些文件改动？ ");
      const yes = document.createElement("button");
      yes.type = "button";
      yes.dataset.gitYes = "1";
      yes.textContent = t("撤销");
      const no = document.createElement("button");
      no.type = "button";
      no.dataset.gitNo = "1";
      no.textContent = t("取消");
      bar.append(yes, no);
      card.querySelector(".git-bar")?.after(bar);
    }
    return;
  }
  if (btn.dataset.gitYes) {
    post({
      type: "rewindFiles",
      sessionId: card.dataset.sessionId,
      rowId: Number(card.dataset.rowId),
      entityId: card.dataset.entityId,
    });
    card.querySelector(".git-confirm")?.remove();
    return;
  }
  if (btn.dataset.gitNo) {
    card.querySelector(".git-confirm")?.remove();
    return;
  }
  if (btn.dataset.gitReview) {
    const row = btn.closest<HTMLElement>(".git-file");
    if (local) openLocalReview(card, row);
    else openGitReview(card, row);
    return;
  }
  if (btn.dataset.gitOpen) post({ type: "openFile", path: btn.dataset.gitOpen });
}

function requestGitFiles(card: HTMLElement): void {
  const turnId = card.dataset.turnId || "";
  const body = card.querySelector<HTMLElement>(".git-body");
  if (!body) return;
  const cached = gitFileLists.get(turnId);
  if (cached) {
    renderGitFiles(body, cached);
    return;
  }
  body.innerHTML = `<div class="git-loading">${t("正在读取文件变更…")}</div>`;
  post({
    type: "loadFileChanges",
    turnId,
    rowId: Number(card.dataset.rowId),
    entityId: card.dataset.entityId,
  });
}

function renderGitFiles(body: HTMLElement, files: GitFileChange[]): void {
  if (!files.length) {
    body.innerHTML = `<div class="git-loading">${t("暂时无法预览这份 Diff。")}</div>`;
    return;
  }
  body.innerHTML = files
    .map(
      (file, index) => `<div class="git-file" data-index="${index}">
        <button type="button" class="file-path" data-git-open="${escapeText(file.path)}" title="${escapeText(file.path)}">${escapeText(file.path)}</button>
        <span class="git-stat">${
          file.additions ? `<span class="git-add">+${file.additions}</span>` : ""
        }${file.deletions ? `<span class="git-del">-${file.deletions}</span>` : ""}</span>
        <button type="button" data-git-review="1">${t("审查")}</button>
      </div>`
    )
    .join("");
}

function openGitReview(card: HTMLElement, row: HTMLElement | null): void {
  if (!row) return;
  const files = gitFileLists.get(card.dataset.turnId || "") ?? [];
  const file = files[Number(row.dataset.index)];
  if (!file) return;
  post({
    type: "openGitDiff",
    path: file.path,
    patches: file.patches,
    reverted: card.dataset.reverted === "1",
  });
}

function questionOwning(host: HTMLElement | null): HTMLElement | null {
  if (host) {
    const turn = groupTurns().find(items => items.some(item => item === host || item.contains(host)));
    const user = turn?.find(item => item.classList.contains("message") && item.classList.contains("user") && !item.classList.contains("queued"));
    if (user) return user;
  }
  return sentQuestions().at(-1) ?? null;
}

function chainFileChange(previous: FileChange, next: FileChange): FileChange {
  const before = previous.before !== undefined && (next.before === undefined || next.before === previous.after)
    ? previous.before
    : next.before ?? previous.before;
  return { ...next, before, after: next.after ?? previous.after };
}

function noteLocalFile(change: FileChange, host?: HTMLElement): void {
  if (!change.path || change.kind === "read") return;
  const bubble = questionOwning(host ?? null);
  const id = bubble?.dataset.jump || "live";
  const turns = groupTurns();
  const turn = bubble ? turns.find((items) => items[0] === bubble) : undefined;
  if (turn?.some((el) => el.classList.contains("git-changes") && el.dataset.local !== "1")) return;
  const list = localTurnFiles.get(id) ?? [];
  const next: LocalFile = {
    path: change.path,
    added: change.added ?? 0,
    removed: change.removed ?? 0,
    change,
  };
  const index = list.findIndex((file) => file.path === change.path);
  if (index >= 0) {
    next.change = chainFileChange(list[index].change, change);
    list[index] = next;
  } else list.push(next);
  localTurnFiles.set(id, list);
  upsertLocalCard(id, bubble, list);
  pinGitCards();
  followTranscriptGrowth();
}

function upsertLocalCard(id: string, bubble: HTMLElement | null, list: LocalFile[]): void {
  let card = messagesEl.querySelector<HTMLElement>(
    `.git-changes[data-local-turn="${CSS.escape(id)}"]`
  );
  const additions = list.reduce((sum, file) => sum + file.added, 0);
  const deletions = list.reduce((sum, file) => sum + file.removed, 0);
  const signature = `${list.length}:${additions}:${deletions}:${list.map((file) => file.path).join("|")}`;
  if (!card) {
    card = document.createElement("div");
    card.className = "git-changes";
    card.dataset.local = "1";
    card.dataset.localTurn = id;
    card.dataset.ownerJump = bubble?.dataset.jump;
    card.dataset.sessionId = bubble?.dataset.sessionId ?? currentSessionId;
    card.addEventListener("click", onGitClick);
    if (bubble) bubble.after(card);
    else attachMessage(card);
  }
  if (card.dataset.signature === signature && card.querySelector(".git-head")) {
    if (card.classList.contains("open")) renderLocalFiles(card);
    return;
  }
  const open = card.classList.contains("open");
  card.dataset.signature = signature;
  card.innerHTML = `<div class="git-bar">
      <button type="button" class="git-head" aria-expanded="${open ? "true" : "false"}">
        <span class="git-chevron" aria-hidden="true"></span>
        <span class="git-title" ${uiLabelAttributes("{0} 个文件已更改", { 0: list.length })}>${t("{0} 个文件已更改", { 0: list.length })}</span>
        <span class="git-stat"><span class="git-add">+${additions}</span> <span class="git-del">-${deletions}</span></span>
      </button>
    </div>
    <div class="git-body"${open ? "" : " hidden"}></div>`;
  if (open) card.classList.add("open");
  if (open) renderLocalFiles(card);
}

function renderLocalFiles(card: HTMLElement): void {
  const body = card.querySelector<HTMLElement>(".git-body");
  const list = localTurnFiles.get(card.dataset.localTurn || "") ?? [];
  if (!body) return;
  if (!list.length) {
    body.innerHTML = `<div class="git-loading">${t("暂时无法预览这份 Diff。")}</div>`;
    return;
  }
  body.innerHTML = list
    .map(
      (file, index) => `<div class="git-file" data-index="${index}">
        <button type="button" class="file-path" data-git-open="${escapeText(file.path)}" title="${escapeText(file.path)}">${escapeText(file.path)}</button>
        <span class="git-stat">${
          file.added ? `<span class="git-add">+${file.added}</span>` : ""
        }${file.removed ? `<span class="git-del">-${file.removed}</span>` : ""}</span>
        <button type="button" data-git-review="1">${t("审查")}</button>
      </div>`
    )
    .join("");
}

function openLocalReview(card: HTMLElement, row: HTMLElement | null): void {
  if (!row) return;
  const list = localTurnFiles.get(card.dataset.localTurn || "") ?? [];
  const file = list[Number(row.dataset.index)];
  if (!file) return;
  post({ type: "openDiff", fileChange: file.change });
}

function showGitFiles(turnId: string, files: GitFileChange[], error?: string): void {
  const card = messagesEl.querySelector<HTMLElement>(
    `.git-changes[data-turn-id="${CSS.escape(turnId)}"]`
  );
  const body = card?.querySelector<HTMLElement>(".git-body");
  if (!body) return;
  if (error) {
    body.innerHTML = `<div class="git-loading">${escapeText(error)}</div>`;
    followTranscriptGrowth();
    return;
  }
  gitFileLists.set(turnId, files);
  renderGitFiles(body, files);
  followTranscriptGrowth();
}

function bindQueuedActions(el: HTMLElement): void {
  el.querySelectorAll<HTMLButtonElement>("[data-qact]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = el.dataset.queueId;
      const sessionId = el.dataset.sessionId;
      if (!id || !sessionId || sessionId !== currentSessionId || el.dataset.queuePending === "1") return;
      const act = btn.dataset.qact;
      if (act === "delete" || act === "now") {
        el.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
        post({ type: act === "delete" ? "queueDelete" : "queueSendNow", sessionId, queueItemId: id });
      } else if (act === "edit") {
        beginQueuedEdit(el);
      }
    });
  });
}

function queueCards(): HTMLElement[] {
  return [...queueZoneEl.querySelectorAll<HTMLElement>(".message.queued"),
    ...messagesEl.querySelectorAll<HTMLElement>(".message.queued")];
}

function placeQueuedCard(el: HTMLElement): void {
  if (!el.querySelector(".queue-grip")) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "queue-grip";
    handle.title = t("拖动排序");
    handle.setAttribute("aria-label", t("拖动排序"));
    handle.innerHTML = lucideIcon("gripVertical");
    handle.draggable = true;
    handle.addEventListener("dragstart", event => {
      if (el.dataset.queuePending === "1" || !el.dataset.queueId) { event.preventDefault(); return; }
      draggingQueueId = el.dataset.queueId;
      event.dataTransfer?.setData("text/plain", draggingQueueId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      el.classList.add("queue-dragging");
    });
    handle.addEventListener("dragend", () => { draggingQueueId = ""; clearQueueDropMarks(); el.classList.remove("queue-dragging"); });
    handle.addEventListener("keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const cards = queueCards();
      const index = cards.indexOf(el);
      const target = cards[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (!target || el.dataset.queuePending === "1" || target.dataset.queuePending === "1") return;
      event.preventDefault();
      reorderQueueCard(el, event.key === "ArrowUp" ? target : target.nextElementSibling as HTMLElement | null);
      handle.focus();
    });
    el.prepend(handle);
    el.addEventListener("dragover", event => {
      if (!draggingQueueId || draggingQueueId === el.dataset.queueId) return;
      event.preventDefault();
      clearQueueDropMarks();
      el.classList.add(event.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2 ? "queue-drop-before" : "queue-drop-after");
    });
    el.addEventListener("drop", event => {
      event.preventDefault();
      const source = queueCards().find(card => card.dataset.queueId === draggingQueueId);
      const before = el.classList.contains("queue-drop-before") ? el : el.nextElementSibling as HTMLElement | null;
      clearQueueDropMarks();
      if (source && source !== el) reorderQueueCard(source, before);
    });
  }
  queueZoneEl.append(el);
  queueZoneEl.hidden = false;
}

let draggingQueueId = "";
function clearQueueDropMarks(): void {
  for (const card of queueCards()) card.classList.remove("queue-drop-before", "queue-drop-after");
}

function reorderQueueCard(source: HTMLElement, before: HTMLElement | null): void {
  const sessionId = source.dataset.sessionId;
  const queueItemId = source.dataset.queueId;
  if (!queueItemId || !sessionId || sessionId !== currentSessionId || source.dataset.queuePending === "1") return;
  if (before === source || before === source.nextElementSibling) return;
  const beforeQueueItemId = before?.dataset.queueId ?? null;
  if (before && (!beforeQueueItemId || before.dataset.queuePending === "1")) return;
  queueZoneEl.insertBefore(source, before);
  if (currentQueue) {
    const items = [...currentQueue];
    const from = items.findIndex(item => item.queueItemId === queueItemId);
    if (from >= 0) {
      const [moved] = items.splice(from, 1);
      const to = beforeQueueItemId ? items.findIndex(item => item.queueItemId === beforeQueueItemId) : -1;
      items.splice(to < 0 ? items.length : to, 0, moved);
      currentQueue = items;
    }
  }
  post({ type: "queueReorder", sessionId, queueItemId, beforeQueueItemId });
}

// Keep edits by queue and session until the backend acknowledges the attempt.
const queuedEditDrafts = new Map<string, { text: string; requestId?: string }>();
function queuedEditKey(sessionId: string, queueId: string): string { return `${sessionId}\0${queueId}`; }

function paintQueuedEdit(el: HTMLElement): void {
  const draft = queuedEditDrafts.get(queuedEditKey(el.dataset.sessionId || "", el.dataset.queueId || ""));
  const pending = !!draft?.requestId;
  const editor = el.querySelector<HTMLTextAreaElement>(".queued-edit");
  if (editor) editor.readOnly = pending;
  el.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = pending; });
}

function beginQueuedEdit(el: HTMLElement): void {
  if (el.querySelector(".queued-edit")) return;
  const body = el.querySelector(".user-body");
  const id = el.dataset.queueId;
  const sessionId = el.dataset.sessionId;
  if (!body || !id || !sessionId || sessionId !== currentSessionId) return;
  const ta = document.createElement("textarea");
  ta.className = "queued-edit";
  const key = queuedEditKey(sessionId, id);
  const draft = queuedEditDrafts.get(key) ?? { text: el.dataset.rawText || body.textContent || "" };
  queuedEditDrafts.set(key, draft);
  ta.value = draft.text;
  ta.addEventListener("input", () => { if (!draft.requestId) draft.text = ta.value; });
  body.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const actions = el.querySelector(".queued-actions");
  if (actions) {
    actions.innerHTML = `
      <button type="button" data-qact="save">${t("保存")}</button>
      <button type="button" data-qact="cancel">${t("取消")}</button>`;
    actions.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.qact === "save") {
          const next = ta.value.trim();
          if (!next && !readImageAttachments(JSON.parse(el.dataset.images || "[]")).length) return;
          if (draft.requestId) return;
          draft.text = ta.value;
          draft.requestId = crypto.randomUUID();
          paintQueuedEdit(el);
          post({ type: "queueEdit", sessionId, queueItemId: id, text: next, requestId: draft.requestId, viewGen });
        } else {
          if (draft.requestId) return;
          queuedEditDrafts.delete(key);
          finishQueuedEdit(el, el.dataset.rawText || "");
        }
      });
    });
  }
  paintQueuedEdit(el);
}

function finishQueuedEdit(el: HTMLElement, text: string): void {
  const ta = el.querySelector(".queued-edit");
  const body = document.createElement("div");
  body.className = "user-body";
  body.textContent = text;
  ta?.replaceWith(body);
  const actions = el.querySelector(".queued-actions");
  if (actions) {
    actions.innerHTML = `
      <button type="button" data-qact="now" title="${t("立即发送")}" aria-label="${t("立即发送")}">${lucideIcon("chevronsUp")}</button>
      <button type="button" data-qact="edit" title="${t("修改")}" aria-label="${t("修改")}">${lucideIcon("pencil")}</button>
      <button type="button" data-qact="delete" title="${t("删除")}" aria-label="${t("删除")}">${lucideIcon("trash2")}</button>`;
    bindQueuedActions(el);
  }
}

function startAssistantMessage(stamp?: { at?: number }): HTMLElement {
  const empty = messagesEl.querySelector(".empty");
  empty?.remove();
  clearGreetingTimer();
  currentAssistantEl = document.createElement("div");
  currentAssistantEl.className = "message assistant";
  const at = stamp?.at && stamp.at > 0 ? stamp.at : Date.now();
  currentAssistantEl.dataset.sentAt = String(at);
  currentAssistantEl.innerHTML = `<div class="md"></div>`;
  attachMessage(currentAssistantEl);
  return currentAssistantEl;
}

function assistantVisibleText(el: HTMLElement): string {
  const copy = el.dataset.copyText?.trim();
  if (copy) return copy;
  return el.querySelector(".md")?.textContent?.trim() || "";
}

function appendAssistantDelta(fullText: string, partId?: string, authoritative = false, streaming = true): void {
  if (partId) {
    const restored = [...messagesEl.querySelectorAll<HTMLElement>(".message.assistant")]
      .find(node => node.dataset.partId === partId);
    if (restored) {
      currentAssistantEl = restored;
    } else if (currentAssistantEl && (assistantVisibleText(currentAssistantEl) || builtinWork.has(currentAssistantEl)) &&
               currentAssistantEl.dataset.partId !== partId) {
      // A new part means the previous bubble is no longer the live answer.
      // Dropping the reference left that narration pinned below the fold.
      parkCurrentAnswer();
    }
  } else if (!currentAssistantEl) adoptTrailingAnswer(fullText);
  if (streaming && !isGenerating) setGenerating(true);
  if (!currentAssistantEl) startAssistantMessage();
  const el = currentAssistantEl!;
  const workViewport = el.closest<HTMLElement>(".work-fold-body");
  const followWork = workViewport && workViewport.scrollHeight - workViewport.scrollTop - workViewport.clientHeight <= 24;
  const previous = el.dataset.streamText ?? el.dataset.copyText ?? "";
  // History can be ahead of a replayed prefix. Never replace it with less text.
  if (!authoritative && previous.startsWith(fullText) && fullText.length < previous.length) return;
  if (partId) el.dataset.partId = partId;
  // Text that starts after every protocol tool has already settled is the
  // answer. Narration written while a tool is still running is not.
  if (!el.closest(".work-fold") && answerFollowsSettledTools()) el.dataset.afterSettled = "1";
  // A finished text part is not a finished turn: tools/reasoning may follow.
  renderAssistantBody(el, fullText, !streaming && !isGenerating, streaming);
  if (followWork) workViewport.scrollTop = workViewport.scrollHeight;
  scrollToBottom();
}

function adoptTrailingAnswer(fullText: string): void {
  const nodes = [...messagesEl.children].reverse();
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued")
    ) {
      return;
    }
    if (!node.classList.contains("message") || !node.classList.contains("assistant")) continue;
    const prev = assistantVisibleText(node);
    if (!prev) continue;
    if (fullText.startsWith(prev) || prev.startsWith(fullText)) currentAssistantEl = node;
    return;
  }
}

// Desktop-parity command glyphs, traced from the app's lucide icon set.
const GOAL_ICON = '<svg class="timeline-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13V2l8 4-8 4"/><path d="M20.561 10.222a9 9 0 1 1-12.55-5.29"/><path d="M8.002 9.997a5 5 0 1 0 8.9 2.02"/></svg>';
/** lucide loader — the 8-ray glyph the desktop spins while a turn is working. */
const WORKING_SPINNER = '<svg class="working-spinner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path opacity=".95" d="M12 2v4"/><path opacity=".83" d="m16.2 7.8 2.9-2.9"/><path opacity=".71" d="M18 12h4"/><path opacity=".59" d="m16.2 16.2 2.9 2.9"/><path opacity=".47" d="M12 18v4"/><path opacity=".35" d="m4.9 19.1 2.9-2.9"/><path opacity=".23" d="M2 12h4"/><path opacity=".15" d="m4.9 4.9 2.9 2.9"/></svg>';
const SWITCH_ICON = '<svg class="timeline-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>';
const COMPACT_ICON = '<svg class="timeline-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 20v-4"/><path d="M7 4v4"/><path d="M17 20v-4"/><path d="M17 4v4"/><path d="M3 12h18"/><path d="m7 8 5-4 5 4"/><path d="m7 16 5 4 5-4"/></svg>';
/** Default command glyph: lucide square-pen, used by custom commands. */
const COMMAND_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>';
const PLAN_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';
const COMMAND_ICONS: Record<string, string> = {
  goal: GOAL_ICON,
  plan: PLAN_ICON,
  compact: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  workflow: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>',
};

function compactStatusLabel(status: string, origin?: string): string {
  if (status === "running") return t("正在压缩上下文");
  if (status === "noop") return t("上下文已是最新，无需压缩");
  if (status === "cancelled") return t("上下文压缩已中断");
  if (status === "failed") return t("上下文压缩失败");
  if (origin === "auto") return t("上下文已自动压缩");
  return t("上下文已压缩");
}

const builtinWork = new WeakMap<HTMLElement, HTMLElement>();function renderAssistantBody(el: HTMLElement, text: string, settled: boolean, liveAnswer = false): void {
  el.dataset.streamText = text;
  const parts = splitZaiBuiltin(text);
  let work = builtinWork.get(el);
  const tools = parts.some(part => part.kind === "tool");
  const toggles = [...(work ?? el).querySelectorAll<HTMLElement>(".tool-call")].map(tool => tool.dataset.userToggle);
  if (tools && !work) {
    let fold = currentTurnFold();
    if (!fold) { fold = createWorkFold(isGenerating ? "running" : "completed"); messagesEl.insertBefore(fold, el); }
    work = document.createElement("div"); work.className = "builtin-work";
    workBody(fold).append(work); builtinWork.set(el,work);
  }
  work?.replaceChildren(); el.replaceChildren();
  let lastTool = -1; parts.forEach((part,index) => { if (part.kind === "tool") lastTool=index; });
  let toolIndex = 0;
  for (let index=0; index<parts.length; index++) {
    const part=parts[index];
    if (part.kind === "text") {
      if (!part.text.trim()) continue;
      const md=document.createElement("div"); md.className="md"; md.innerHTML=renderMarkdown(part.text);
      (index<lastTool && work ? work : el).append(md);
    } else {
      const tool=document.createElement("div"); if (toggles[toolIndex]) tool.dataset.userToggle=toggles[toolIndex]; toolIndex++;
      fillBuiltinTool(tool, part, settled ? "completed" : work?.closest<HTMLElement>(".work-fold")?.dataset.state); work!.append(tool);
    }
  }
  // Trailing prose may leave the fold only while this bubble is the live
  // answer. Reasoning or a protocol tool already in the fold means the
  // bubble was parked and has to stay between that work.
  if (liveAnswer && tools && el.childElementCount && el.closest(".work-fold")) {
    const fold=el.closest<HTMLElement>(".work-fold")!;
    const own=builtinWork.get(el);
    const surrounded=[...workBody(fold).children].some(node =>
      node !== el && node !== own &&
      (node.classList.contains("tool-call") || node.classList.contains("work-note") ||
        node.classList.contains("reasoning-head") || node.classList.contains("message") ||
        node.classList.contains("perm-card")));
    if (!surrounded) fold.after(el);
  }
  el.hidden = tools && !el.childElementCount;
  if (!el.childElementCount) el.innerHTML='<div class="md"></div>';
  el.dataset.copyText=parts.filter(part=>part.kind==="text").map(part=>part.text.trim()).filter(Boolean).join("\n\n");
  if (settled && !el.hidden) syncReplyFooter(el,true);
  wireCopyButtons(el); if (work) wireCopyButtons(work);
}

function finalizeAssistantMessage(): void {
  currentAssistantEl = null;
}

function formatPermissionInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const keys = ["command", "cmd", "path", "file_path", "filePath", "target", "url", "pattern"];
    const parts: string[] = [];
    for (const k of keys) {
      if (o[k] != null && o[k] !== "") parts.push(`${k}: ${String(o[k])}`);
    }
    if (parts.length) return parts.join("\n");
    try {
      return JSON.stringify(o, null, 2);
    } catch {
      return String(input);
    }
  }
  return String(input);
}

function addPermissionCard(data: {
  requestId: string;
  toolCallId?: string;
  toolName?: string;
  reason?: string;
  riskLevel?: string;
  input?: unknown;
  options?: Array<{
    optionId: string;
    kind?: string;
    name?: string;
    description?: string;
  }>;
}): void {
  parkCurrentAnswer();
  const fold = ensureTurnWorkFold();
  const viewport = workBody(fold);
  const follow = stickToBottom && fold.classList.contains("open") && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24;
  const id = `perm-${data.requestId}`;
  if (document.getElementById(id)) return;
  const el = document.createElement("div");
  el.className = `perm-card risk-${escapeText(data.riskLevel || "medium")}`;
  el.id = id;
  const options = data.options ?? [];
  const buttons = options
    .map((opt) => {
      const kind = permissionOptionKind(opt);
      const cls = kind === "deny" ? "deny" : "allow";
      return `<button type="button" data-opt="${escapeText(opt.optionId)}" class="${cls}" title="${escapeText(
        opt.description || ""
      )}">${escapeText(permissionOptionLabel(opt))}</button>`;
    })
    .join("");
  el.innerHTML = `<div class="perm-title" ${uiLabelAttributes("{0} 需要权限", { 0: data.toolName || "tool" })}>${escapeText(t("{0} 需要权限", { 0: data.toolName || "tool" }))}</div>
    ${data.reason ? `<div class="perm-reason">${escapeText(data.reason)}</div>` : ""}
    ${
      data.input
        ? `<div class="perm-input">${escapeText(formatPermissionInput(data.input))}</div>`
        : ""
    }
    <div class="perm-actions">${buttons}</div>`;
  el.querySelectorAll<HTMLButtonElement>("button[data-opt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (el.classList.contains("resolved")) return;
      const returnFocus = el.contains(document.activeElement);
      el.classList.add("resolved");
      const picked = options.find((opt) => opt.optionId === btn.dataset.opt);
      const denied = picked ? permissionOptionKind(picked) === "deny" : false;
      const decision = {
        toolName: data.toolName || "tool",
        status: denied ? t("已拒绝") : t("已允许"),
        inputText: data.input ? formatPermissionInput(data.input) : "",
      };
      const existing = data.toolCallId
        ? (document.getElementById(`tool-${data.toolCallId}`) as HTMLElement | null)
        : null;
      if (existing) {
        fillToolCallEl(existing, decision);
        el.remove();
      } else {
        const tool = document.createElement("div");
        tool.className = "tool-call";
        if (data.toolCallId) tool.id = `tool-${data.toolCallId}`;
        fillToolCallEl(tool, decision);
        el.replaceWith(tool);
      }
      refreshPendingAction();
      setGenerating(true);
      noteActivity("waiting");
      if (returnFocus) input.focus({preventScroll: true});
      restorePromptFollow();
      post({
        type: "permissionAnswer",
        requestId: data.requestId,
        optionId: btn.dataset.opt,
      });
    });
  });
  workBody(fold).appendChild(el);
  setStatus("busy", t("等待确认"));
  announcePrompt(el, follow);
}

/** Keep completed questions readable without retaining an active form. */
function collapseQuestion(el: HTMLElement, statusKey: string, summary = ""): void {
  if (el.querySelector(".ask-summary")) return;
  const returnFocus=el.contains(document.activeElement);
  el.classList.add("resolved");
  const details=el.querySelector<HTMLElement>(".ask-details")!;
  details.hidden=true;
  details.querySelectorAll<HTMLButtonElement>("button").forEach(button=>button.disabled=true);
  const head=document.createElement("button");head.type="button";head.className="ask-summary process-head";
  head.setAttribute("aria-expanded","false");
  head.innerHTML=`${processIcon("question")}<span ${uiLabelAttributes("询问")}>${t("询问")}</span><span class="tool-preview"></span><span class="tool-status" ${uiLabelAttributes(statusKey)}>${t(statusKey)}</span><svg class="process-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  head.querySelector(".tool-preview")!.textContent=summary;head.title=summary;
  head.addEventListener("click",()=>{details.hidden=!details.hidden;head.setAttribute("aria-expanded",String(!details.hidden));});
  el.prepend(head);
  let fold=currentTurnFold();
  if (!fold) { fold=createWorkFold(isGenerating ? "running" : statusKey==="已取消" ? "interrupted" : "completed");messagesEl.insertBefore(fold,el); }
  workBody(fold).append(el);
  if(returnFocus) input.focus({preventScroll:true});
}

function addUserInputCard(data: {
  requestId: string;
  prompt?: string;
  toolName?: string;
  questions?: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ value: string; label: string; description?: string }>;
  }>;
}): void {
  finalizeAssistantMessage();
  messagesEl.querySelector(".empty")?.remove();
  clearGreetingTimer();
  const id = `ask-${data.requestId}`;
  if (document.getElementById(id)) return;
  const el = document.createElement("div");
  el.className = "ask-card";
  el.id = id;
  const questions = data.questions ?? [];
  const answers = new QuestionAnswers(questions);
  const needsSubmit = questions.length > 1 || questions.some((question) => question.multiSelect);
  const qHtml = questions
    .map((q, qi) => {
      const opts = (q.options ?? [])
        .map(
          (opt) =>
            `<button type="button" data-q="${qi}" data-val="${escapeText(opt.value)}" title="${escapeText(
              opt.description || ""
            )}">${escapeText(opt.label || opt.value)}</button>`
        )
        .join("");
      return `<div class="ask-q">${q.header ? `<strong>${escapeText(q.header)}</strong>` : ""}<div>${escapeText(q.question)}</div><div class="ask-actions">${opts}</div></div>`;
    })
    .join("");
  el.innerHTML = `${
    data.prompt ? `<div class="ask-prompt">${escapeText(data.prompt)}</div>` : ""
  }${qHtml}<div class="ask-actions">${needsSubmit ? `<button type="button" data-act="submit" disabled>${t("提交选择")}</button>` : ""}<button type="button" class="decline" data-act="decline">${t("拒绝")}</button></div>`;

  const details=document.createElement("div");details.className="ask-details";
  while(el.firstChild) details.append(el.firstChild);el.append(details);

  const finish = (action: "accept" | "decline", content?: unknown) => {
    if (el.classList.contains("resolved")) return;
    const returnFocus = el.contains(document.activeElement);
    const summary=questions.map((question,index)=>question.options.filter(option=>answers.selected(index,option.value)).map(option=>option.label || option.value).join(" · ")).filter(Boolean).join("; ");
    collapseQuestion(el,action === "accept" ? "已回答" : "已拒绝",summary);
    refreshPendingAction();
    if (returnFocus) input.focus({preventScroll: true});
    post({
      type: "userInputAnswer",
      requestId: data.requestId,
      action,
      content,
    });
    if (action === "accept") {
      setGenerating(true);
      noteActivity("waiting");
      restorePromptFollow();
    }
  };

  const submit = el.querySelector<HTMLButtonElement>("button[data-act='submit']");
  el.querySelectorAll<HTMLButtonElement>("button[data-val]").forEach((btn) => {
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      if (el.classList.contains("resolved")) return;
      const qi = Number(btn.dataset.q || "0");
      answers.toggle(qi, btn.dataset.val || "");
      el.querySelectorAll<HTMLButtonElement>(`button[data-q="${qi}"]`).forEach((option) => {
        const selected = answers.selected(qi, option.dataset.val || "");
        option.setAttribute("aria-pressed", String(selected));
        option.style.outline = selected ? "1px solid var(--z-accent)" : "";
      });
      if (submit) submit.disabled = !answers.complete();
      if (!needsSubmit && answers.complete()) finish("accept", answers.content());
    });
  });
  submit?.addEventListener("click", () => {
    if (answers.complete()) finish("accept", answers.content());
  });
  el.querySelector<HTMLButtonElement>("button[data-act='decline']")?.addEventListener(
    "click",
    () => finish("decline")
  );
  const follow = stickToBottom;
  attachMessage(el);
  setStatus("busy", t("等待你的选择"));
  announcePrompt(el, follow);
}

function formatWorkDuration(ms: number, running = false): string {
  const total = running ? Math.max(0, Math.floor(ms / 1000)) : Math.max(1, Math.round(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(t("{0} 天", {0: days}));
  if (hours > 0) parts.push(t("{0} 时", {0: hours}));
  if (minutes > 0) parts.push(t("{0} 分", {0: minutes}));
  if (seconds > 0 || parts.length === 0) parts.push(t("{0} 秒", {0: seconds}));
  return parts.slice(0, 2).join(" ");
}

function workDurationMs(fold: HTMLElement): number {
  if (fold.dataset.state === "running") {
    const started = Number(fold.dataset.startedAt);
    return Math.max(0, Date.now() - (Number.isFinite(started) ? started : Date.now()));
  }
  const frozen = Number(fold.dataset.durationMs);
  return Number.isFinite(frozen) ? frozen : 0;
}

function paintWorkFold(fold: HTMLElement): void {
  const label = fold.querySelector(".work-fold-label");
  if (!label) return;
  const state = fold.dataset.state || "running";
  const open = fold.classList.contains("open");
  fold.querySelector(".work-fold-btn")?.setAttribute("aria-expanded", open ? "true" : "false");
  // Restored segments split by an inserted prompt carry their own bounded
  // duration. Show it when available; only fall back to the generic label for
  // older history that has no timestamps to calculate a segment duration.
  if (fold.dataset.continuation === "1" && fold.dataset.durationMs === undefined) {
    label.textContent = t("工作过程");
    return;
  }
  const elapsed = workDurationMs(fold);
  if (state !== "running" && fold.dataset.durationMs === undefined) {
    label.textContent = t("已工作");
    return;
  }
  const duration = formatWorkDuration(elapsed, state === "running");
  label.textContent = state === "running" ? t("工作中 {0}", {0: duration}) : t("已工作 {0}", {0: duration});
}

function createWorkFold(state: "running" | "completed" | "interrupted", startedAt?: number): HTMLElement {
  const fold = document.createElement("div");
  fold.className = state === "running" ? "work-fold open" : "work-fold";
  fold.dataset.state = state;
  if (startedAt && startedAt > 0) fold.dataset.startedAt = String(startedAt);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "work-fold-btn";
  btn.innerHTML =
    `<span class="work-fold-label"></span><svg class="tool-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const viewport = document.createElement("div");
  viewport.className = "work-fold-viewport";
  const body = document.createElement("div");
  body.className = "work-fold-body";
  viewport.appendChild(body);
  bindSoftScrollbar(body, "y");
  fold.append(btn, viewport);
  btn.addEventListener("click", () => {
    const open = fold.classList.toggle("open");
    fold.dataset.userToggle = open ? "open" : "closed";
    paintWorkFold(fold);
  });
  paintWorkFold(fold);
  return fold;
}

function createWorkDurationBar(durationMs: number): HTMLElement {
  const fold = document.createElement("div");
  fold.className = "work-fold work-duration-only";
  fold.dataset.state = "completed";
  fold.dataset.durationMs = String(durationMs);
  const row = document.createElement("div");
  row.className = "work-duration-row";
  const label = document.createElement("span");
  label.className = "work-fold-label";
  label.textContent = t("已工作 {0}", { 0: formatWorkDuration(durationMs) });
  row.appendChild(label);
  fold.appendChild(row);
  return fold;
}

function measuredRunningWork(): number | undefined {
  const running = runningWorkFold();
  if (running) {
    const started = Number(running.dataset.startedAt) || turnWorkStarted;
    if (!started) return undefined;
    return Math.max(0, Date.now() - started);
  }
  // Completion marks the fold finished before the transcript redraw. Keep that
  // frozen duration; recomputing from the start time would make it keep growing.
  let fold: HTMLElement | null = null;
  for (const node of messagesEl.children) {
    if (!(node instanceof HTMLElement)) continue;
    const isUser =
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued");
    if (isUser) fold = null;
    else if (node.classList.contains("work-fold") && node.dataset.continuation !== "1") fold = node;
  }
  if (!fold || fold.dataset.durationMs === undefined) return undefined;
  const frozen = Number(fold.dataset.durationMs);
  return Number.isFinite(frozen) ? Math.max(0, frozen) : undefined;
}

function runningWorkFold(): HTMLElement | null {
  let fold: HTMLElement | null = null;
  for (const node of messagesEl.children) {
    if (!(node instanceof HTMLElement)) continue;
    const isUser =
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued");
    if (isUser) fold = null;
    else if (node.classList.contains("work-fold") && node.dataset.state === "running") fold = node;
  }
  return fold;
}

function ensureTurnWorkFold(): HTMLElement {
  const existing = runningWorkFold();
  if (existing) return existing;
  const tail = currentTurnFold();
  if (tail) {
    tail.dataset.state = "running";
    if (!Number(tail.dataset.startedAt) && turnWorkStarted) {
      tail.dataset.startedAt = String(turnWorkStarted);
    }
    if (Number(tail.dataset.startedAt)) turnWorkStarted = Number(tail.dataset.startedAt);
    delete tail.dataset.durationMs;
    tail.classList.add("open");
    paintWorkFold(tail);
    startWorkTicker();
    return tail;
  }
  if (!turnWorkStarted) turnWorkStarted = Date.now();
  const fold = createWorkFold("running", turnWorkStarted);
  if (currentAssistantEl?.parentElement === messagesEl) {
    messagesEl.insertBefore(fold, currentAssistantEl);
  } else {
    attachMessage(fold);
  }
  startWorkTicker();
  return fold;
}

function ensureWaitingWorkFeedback(): void {
  if (!isGenerating || runningWorkFold()) return;
  const user = [...messagesEl.querySelectorAll<HTMLElement>(".message.user:not(.queued)")].at(-1);
  if (user && !isCompactCommand(user.dataset.rawText || "")) {
    ensureTurnWorkFold();
    scrollToBottom();
  }
}

function currentTurnFold(): HTMLElement | null {
  let fold: HTMLElement | null = null;
  for (const node of messagesEl.children) {
    if (!(node instanceof HTMLElement)) continue;
    const isUser =
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued");
    if (isUser) fold = null;
    // Fast replies can show a duration-only bar. It has no work body and must
    // never become the target for builtin tool content during history replay.
    else if (node.classList.contains("work-fold") && !node.classList.contains("work-duration-only")) fold = node;
  }
  return fold;
}

function workBody(fold: HTMLElement): HTMLElement {
  return fold.querySelector(".work-fold-body") as HTMLElement;
}

function answerFollowsSettledTools(): boolean {
  const fold = currentTurnFold();
  if (!fold) return false;
  const tools = [...workBody(fold).querySelectorAll<HTMLElement>(":scope > .tool-call")];
  return tools.length > 0 && tools.every(tool => tool.dataset.toolStatus !== "running" && tool.dataset.toolStatus !== "pending");
}

function parkCurrentAnswer(): void {
  const el = currentAssistantEl;
  if (!el) return;
  if (!assistantVisibleText(el)) {
    if (!builtinWork.has(el)) el.remove();
    currentAssistantEl = null;
    return;
  }
  // An intermediate reply already sitting inside the fold must stay between
  // the thoughts that surround it. Only a reply still below the fold moves in.
  if (el.closest(".work-fold")) {
    currentAssistantEl = null;
    return;
  }
  const fold = ensureTurnWorkFold();
  currentAssistantEl = null;
  const body = workBody(fold);
  const follow = body.scrollHeight - body.scrollTop - body.clientHeight <= 24;
  body.appendChild(el);
  if (follow && fold.classList.contains("open")) body.scrollTop = body.scrollHeight;
}

function appendWorkNote(fold: HTMLElement, text: string, live = false): HTMLElement {
  const note = document.createElement("div");
  note.className = "work-note";
  if (live) note.dataset.live = "1";
  note.dataset.segment = text;
  renderReasoningBody(note, text);
  const header = document.createElement("button");
  header.type = "button";
  header.className = "reasoning-head process-head";
  note.hidden = fold.dataset.state !== "running";
  header.setAttribute("aria-expanded", String(!note.hidden));
  header.innerHTML = `${processIcon("reasoning")}<span ${uiLabelAttributes("思考")}>${t("思考")}</span><svg class="process-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  header.addEventListener("click", () => {
    header.dataset.userToggle = "1";
    note.hidden = !note.hidden;
    header.setAttribute("aria-expanded", String(!note.hidden));
  });
  workBody(fold).append(header, note);
  return note;
}

function followingAnswer(fold: HTMLElement): boolean {
  let node = fold.nextElementSibling;
  while (node instanceof HTMLElement) {
    if (
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued")
    ) {
      return false;
    }
    if (node.classList.contains("assistant") && assistantVisibleText(node)) return true;
    node = node.nextElementSibling;
  }
  return false;
}

function followingQuestion(fold: HTMLElement): boolean {
  let node = fold.nextElementSibling;
  while (node instanceof HTMLElement) {
    if (
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued")
    ) return true;
    node = node.nextElementSibling;
  }
  return false;
}

function collapseSupersededWorkFolds(): void {
  for (const fold of messagesEl.querySelectorAll<HTMLElement>(".work-fold:not(.work-duration-only)")) {
    if (!followingQuestion(fold) || fold.dataset.userToggle === "open") continue;
    fold.classList.remove("open");
    paintWorkFold(fold);
  }
}

function fillBuiltinTool(el: HTMLElement, part: {toolName:string;status:string;inputText:string;outputText:string}, state?: string): void {
  el.dataset.builtin = "1";
  const status = part.status === "running" && state && state !== "running"
    ? state === "interrupted" ? "cancelled" : "completed" : part.status;
  fillToolCallEl(el, {...part, status});
}

function capturePostFoldAnchor(folds: HTMLElement[]): { element: HTMLElement; top: number } | undefined {
  if (!folds.length) return undefined;
  const children = [...messagesEl.children].filter((node): node is HTMLElement => node instanceof HTMLElement);
  const firstFoldIndex = Math.min(...folds.map(fold => children.indexOf(fold)).filter(index => index >= 0));
  if (!Number.isFinite(firstFoldIndex)) return undefined;
  const viewport = messagesEl.getBoundingClientRect();
  const candidates = children.slice(firstFoldIndex + 1).filter(node =>
    !folds.some(fold => fold === node || fold.contains(node)) &&
    node.matches(".message.assistant, .message.user, .git-changes, .work-fold")
  );
  const visible = candidates.filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  const element = visible.find(node => node.classList.contains("assistant") && !!node.dataset.copyText?.trim()) ?? visible[0];
  return element ? { element, top: element.getBoundingClientRect().top } : undefined;
}

function restorePostFoldAnchor(anchor: { element: HTMLElement; top: number } | undefined): void {
  if (!anchor?.element.isConnected) return;
  const delta = anchor.element.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) < 1) return;
  ignoreScroll = true;
  messagesEl.scrollTop += delta;
  requestAnimationFrame(() => {
    ignoreScroll = false;
    updateQuestionRailActive();
  });
}

function settleWorkFolds(state: "completed" | "interrupted", nextQuestion = false): void {
  // Markdown built-ins have no separate tool-completion event. Settle their
  // status with the task. Image-analysis cards also use this terminal guard.
  for (const tool of messagesEl.querySelectorAll<HTMLElement>(".tool-call[data-tool-status='running']")) {
    if (tool.dataset.builtin !== "1" && !/(?:^|[.:])analyze_image$/i.test(tool.dataset.toolName ?? "")) continue;
    fillToolCallEl(tool, {status:state === "interrupted" ? "cancelled" : "completed"});
  }
  const now = Date.now();
  const folds = [...messagesEl.querySelectorAll<HTMLElement>(".work-fold[data-state='running']")];
  const closesForQuestion = (fold: HTMLElement) => nextQuestion || followingQuestion(fold);
  const closingFolds = folds.filter(fold => workBody(fold).childElementCount
    && ((state === "completed" && followingAnswer(fold)) || closesForQuestion(fold))
    && fold.dataset.userToggle !== "open");
  const removedFolds = folds.filter(fold => !workBody(fold).childElementCount);
  const anchor = !stickToBottom ? capturePostFoldAnchor([...closingFolds, ...removedFolds]) : undefined;
  for (const fold of folds) {
    if (!workBody(fold).childElementCount) {
      fold.remove();
      continue;
    }
    const started = Number(fold.dataset.startedAt) || turnWorkStarted || now;
    fold.dataset.durationMs = String(Math.max(0, now - started));
    fold.dataset.state = state;
    for (const header of fold.querySelectorAll<HTMLElement>(".reasoning-head")) {
      const note = header.nextElementSibling as HTMLElement | null;
      if (!header.dataset.userToggle && note?.classList.contains("work-note")) {
        note.hidden = true;
        header.setAttribute("aria-expanded", "false");
      }
    }
    const answered = followingAnswer(fold);
    const superseded = closesForQuestion(fold);
    if (((state === "completed" && answered) || superseded) && fold.dataset.userToggle !== "open") {
      fold.classList.remove("open");
    } else if (!answered && !superseded && fold.dataset.userToggle !== "closed") {
      fold.classList.add("open");
    }
    paintWorkFold(fold);
  }
  restorePostFoldAnchor(anchor);
  turnWorkStarted = 0;
}

function renderReasoningBody(note: HTMLElement, text: string): void {
  const parts = splitZaiBuiltin(text);
  if (!parts.some(part => part.kind === "tool")) { note.textContent = text; return; }
  const toggles = [...note.querySelectorAll<HTMLElement>(".tool-call")].map(tool => tool.dataset.userToggle);
  note.replaceChildren();
  let index = 0;
  for (const part of parts) {
    if (part.kind === "text") { const prose = document.createElement("div"); prose.textContent = part.text; note.append(prose); }
    else { const tool = document.createElement("div"); if (toggles[index]) tool.dataset.userToggle = toggles[index]; index++;
      fillBuiltinTool(tool, part, note.closest<HTMLElement>(".work-fold")?.dataset.state); note.append(tool); }
  }
}

function appendReasoningDelta(fullText: string, partId?: string, authoritative = false, streaming = true): void {
  if (!fullText.trim() && !authoritative) return;
  if (streaming && !isGenerating) setGenerating(true);
  if (authoritative && partId) {
    const existing = [...messagesEl.querySelectorAll<HTMLElement>(".work-note")]
      .find(node => node.dataset.partId === partId);
    if (existing) {
      const body = existing.closest<HTMLElement>(".work-fold-body")!;
      const follow = body.scrollHeight - body.scrollTop - body.clientHeight <= 24;
      existing.dataset.segment = fullText;
      renderReasoningBody(existing, fullText);
      if (follow && body.closest(".work-fold")?.classList.contains("open")) body.scrollTop = body.scrollHeight;
      scrollToBottom();
      return;
    }
  }
  const fold = ensureTurnWorkFold();
  const body = workBody(fold);
  const follow = body.scrollHeight - body.scrollTop - body.clientHeight <= 24;
  let note = body.querySelector<HTMLElement>(":scope > .work-note[data-live='1']");
  if (partId) {
    if (note && note.dataset.partId !== partId) delete note.dataset.live;
    note = [...body.querySelectorAll<HTMLElement>(":scope > .work-note")]
      .find(candidate => candidate.dataset.partId === partId) ?? null;
  }
  if (!note && !partId) {
    const notes = [...body.querySelectorAll<HTMLElement>(":scope > .work-note")];
    const last = notes[notes.length - 1];
    const prev = last?.dataset.segment ?? last?.textContent ?? "";
    if (last && prev && (fullText.startsWith(prev) || prev.startsWith(fullText))) {
      last.dataset.live = "1";
      last.dataset.segment = prev;
      note = last;
    }
  }
  if (note && partId && note.dataset.segment === undefined) note.dataset.segment = note.textContent ?? "";
  const segment = note?.dataset.segment ?? "";
  // A restored snapshot can be ahead of the resumed stream. Never shorten it.
  if (!authoritative && note && segment.startsWith(fullText) && fullText.length < segment.length) return;
  const fresh =
    !note || (!authoritative && !!segment && !fullText.startsWith(segment) && !segment.startsWith(fullText));
  if (fresh && note) {
    delete note.dataset.live;
    parkCurrentAnswer();
    note = null;
  }
  if (!note) {
    if (authoritative) parkCurrentAnswer();
    note = appendWorkNote(fold, "", true);
  }
  if (partId) note.dataset.partId = partId;
  note.dataset.live = "1";
  note.dataset.segment = fullText;
  renderReasoningBody(note, fullText);
  if (follow && fold.classList.contains("open")) body.scrollTop = body.scrollHeight;
  discardEmptyAnswer();
  paintWorkFold(fold);
  scrollToBottom();
}

function discardEmptyAnswer(): void {
  const el = currentAssistantEl;
  if (!el || assistantVisibleText(el)) return;
  if (builtinWork.has(el)) { currentAssistantEl = null; return; }
  el.remove();
  currentAssistantEl = null;
}

function startWorkTicker(): void {
  if (workTicker) return;
  workTicker = window.setInterval(() => {
    paintActivity();
    for (const fold of messagesEl.querySelectorAll<HTMLElement>(".work-fold[data-state='running']")) {
      paintWorkFold(fold);
    }
  }, 1000);
}

function stopWorkTicker(): void {
  if (!workTicker) return;
  window.clearInterval(workTicker);
  workTicker = 0;
}

const planIndicator = document.getElementById("plan-indicator")!;

function applySessionControls(data: {
  mode?: string;
  baseMode?: string;
  planEnabled?: boolean;
  thoughtEnabled?: boolean;
  thoughtLevel?: string;
  thoughtLevels?: ThoughtOption[];
}): void {
  if (data.baseMode && data.baseMode !== "plan") baseMode = data.baseMode;
  if (typeof data.planEnabled === "boolean") planEnabled = data.planEnabled;
  else if (data.mode === "plan") planEnabled = true;
  else if (data.mode) {
    baseMode = data.mode;
    planEnabled = false;
  }
  currentMode = planEnabled ? "plan" : baseMode;
  const mode = modeOption(baseMode);
  updatePlanChip();
  const icons = document.documentElement.dataset.sessionControlsIcons === "true";
  modeChip.classList.toggle("icon-chip", icons);
  if (icons) modeChip.innerHTML = modeIcon(baseMode);
  else modeChip.textContent = mode.label;
  modeChip.setAttribute("aria-label", mode.label);
  setTitled(modeChip, t("权限管理 · {0}\n{1}", {0: mode.label, 1: mode.description}));

  if (Array.isArray(data.thoughtLevels)) {
    thoughtLevels = localizeThoughtLevels(data.thoughtLevels);
    sessionThoughtOptions = thoughtLevels;
    thoughtEnabled = data.thoughtEnabled !== false && thoughtLevels.length > 0;
    thoughtChip.style.display = thoughtEnabled ? "" : "none";
  }
  if (data.thoughtLevel) currentThought = data.thoughtLevel;
  if (thoughtEnabled) {
    const label = thoughtLabel(
      currentThought,
      thoughtLevels.find((l) => l.value === currentThought)?.label
    );
    const iconsOn = document.documentElement.dataset.sessionControlsIcons === "true";
    thoughtChip.classList.toggle("icon-chip", iconsOn);
    thoughtChip.textContent = iconsOn ? thoughtMark(currentThought) : (currentThought ? label : t("推理强度"));
    thoughtChip.setAttribute("aria-label", label);
    setTitled(thoughtChip, t("推理强度 · {0}", {0: label}));
  }
  if (overlayMode === "mode" || overlayMode === "thought") {
    rebuildOverlay(overlaySearch.value);
  }
  renderNewSessionSettings();
}

function addToolCall(data: {
  rowId?: string | number;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  inputText?: string;
  outputText?: string;
  fileChange?: FileChange;
}): void {
  const key = data.toolCallId || data.rowId;
  const id = key != null && String(key).length > 0 ? `tool-${key}` : "";
  let el = id ? (document.getElementById(id) as HTMLElement | null) : null;
  if (!el && data.rowId != null && data.toolCallId) {
    el = document.getElementById(`tool-${data.rowId}`) as HTMLElement | null;
  }
  // A brand-new tool always closes the bubble above it. An update does too,
  // unless that bubble started after the tool had already settled — that one
  // is the answer, and a late result must not pull it into the fold.
  if (!el || (currentAssistantEl && !currentAssistantEl.dataset.afterSettled && !currentAssistantEl.closest(".work-fold"))) {
    parkCurrentAnswer();
  }
  const empty = messagesEl.querySelector(".empty");
  empty?.remove();
  clearGreetingTimer();
  const settledFold = el?.closest<HTMLElement>(".work-fold");
  const fold = !isGenerating && settledFold && settledFold.dataset.state !== "running" ? settledFold : ensureTurnWorkFold();
  if (!el) {
    const body = workBody(fold);
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight <= 24;
    el = document.createElement("div");
    el.className = "tool-call";
    if (id) el.id = id;
    body.appendChild(el);
    if (follow && fold.classList.contains("open")) body.scrollTop = body.scrollHeight;
  } else if (id && el.id !== id) {
    el.id = id;
  }
  if (el.parentElement !== workBody(fold)) workBody(fold).appendChild(el);
  const viewport = workBody(fold);
  const follow = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24;
  fillToolCallEl(el, data);
  if (follow && fold.classList.contains("open")) viewport.scrollTop = viewport.scrollHeight;
  syncReplyFooter(fold, false);
  if (!suspendScroll) scrollToBottom();
}

/** Desktop writes the approved plan to `.zcode/plans/plan-<session>.md`. */
function planFilePath(sessionId: string): string {
  const safe = sessionId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe ? `.zcode/plans/plan-${safe}.md` : "";
}

/** ExitPlanMode renders as the desktop's plan document card: the plan in
 *  readable Markdown plus the permissions it will need, not a raw JSON dump. */
function fillPlanCardEl(
  el: HTMLElement,
  data: { status: string; inputText: string; outputText?: string }
): void {
  el.classList.add("tool-call", "plan-card");
  el.dataset.toolName = "ExitPlanMode";
  el.dataset.toolStatus = data.status;
  let plan = "";
  let prompts: string[] = [];
  try {
    const input = JSON.parse(data.inputText) as { plan?: unknown; allowedPrompts?: unknown };
    if (typeof input.plan === "string") plan = input.plan;
    if (Array.isArray(input.allowedPrompts)) {
      prompts = input.allowedPrompts
        .map(item => item && typeof item === "object" && typeof (item as { prompt?: unknown }).prompt === "string"
          ? (item as { prompt: string }).prompt : "")
        .filter(Boolean);
    }
  } catch { /* Streaming input arrives progressively; keep the raw text visible. */ }
  el.dataset.rawInput = data.inputText;
  el.dataset.rawOutput = data.outputText ?? "";
  const approved = /approved/i.test(data.outputText ?? "");
  const rejected = data.status === "error" || /rejected|declined/i.test(data.outputText ?? "");
  const statusLabel = rejected ? t("已拒绝") : approved ? t("已批准") : data.status === "running" ? t("等待批准") : t("已批准");
  el.innerHTML = `
    <div class="plan-head">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v5a1 1 0 0 0 1 1h5"/><path d="M9 13h6M9 17h6"/></svg>
      <span class="plan-title">${t("计划")}</span>
      <span class="plan-status ${rejected ? "rejected" : approved ? "approved" : "waiting"}">${statusLabel}</span>
    </div>
    <div class="plan-body"></div>`;
  const planPath = planFilePath(currentSessionId);
  if (planPath) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "plan-open";
    open.dataset.i18nKey = "打开计划";
    open.textContent = t("打开计划");
    open.title = planPath;
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      post({ type: "openFile", path: planPath });
    });
    el.querySelector(".plan-status")?.before(open);
  }
  const body = el.querySelector<HTMLElement>(".plan-body")!;
  if (plan) {
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = renderMarkdown(plan);
    body.appendChild(md);
    wireCopyButtons(body);
  } else {
    const raw = document.createElement("div");
    raw.className = "plan-raw";
    raw.textContent = data.inputText;
    body.appendChild(raw);
  }
  if (prompts.length) {
    const list = document.createElement("div");
    list.className = "plan-prompts";
    const head = document.createElement("div");
    head.textContent = t("批准后允许的操作");
    list.appendChild(head);
    for (const prompt of prompts) {
      const item = document.createElement("div");
      item.className = "plan-prompt";
      item.textContent = prompt;
      list.appendChild(item);
    }
    body.appendChild(list);
  }
}

function fillToolCallEl(
  el: HTMLElement,
  data: {
    toolName?: string;
    status?: string;
    inputText?: string;
    outputText?: string;
    fileChange?: FileChange;
  }
): void {
  el.classList.add("tool-call");
  const prevName = el.dataset.toolName ?? "";
  const prevInput = el.querySelector(".tool-io:not(.out)")?.textContent ?? "";
  const prevOutput = el.querySelector(".tool-io.out")?.textContent ?? "";
  const userToggle = el.dataset.userToggle;
  const toolName = data.toolName || prevName || "tool";
  el.dataset.toolName = toolName;
  const prevStatus = el.dataset.toolStatus ?? "";
  let status = data.status ?? "running";
  if ((prevStatus === "completed" || prevStatus === "error") && status === "running") {
    status = prevStatus;
  }
  el.dataset.toolStatus = status;
  const inputText = data.inputText || el.dataset.rawInput || prevInput;
  el.dataset.rawInput = inputText;
  if (/^ExitPlanMode$/i.test(toolName)) {
    fillPlanCardEl(el, { status, inputText, outputText: data.outputText || el.dataset.rawOutput || prevOutput });
    return;
  }
  const imageAnalysis = /(?:^|[.:])analyze_image$/i.test(toolName);
  const rawOutput = data.outputText || el.dataset.rawOutput || prevOutput;
  el.dataset.rawOutput = rawOutput;
  const outputText = /(?:^|[.:])analyze_image$/i.test(toolName) ? formatImageAnalysisOutput(rawOutput) : prettifyToolIo(rawOutput);
  const change = data.fileChange;
  const previousCategory = el.dataset.processCategory;
  const category = processCategory(toolName, inputText);
  el.dataset.processCategory = category;
  el.dataset.exploreBucket = category === "explore" ? exploreBucket(toolName, inputText) : "";
  let preview = inputText;
  try {
    const input = JSON.parse(inputText);
    preview = [input.command, input.cmd, input.path, input.file_path, input.filePath, input.pattern,
      input.query, input.searchQuery, input.search_query, input.q, input.url, input.uri,
      input.repository, input.repo, input.action, input.expression]
      .find(value => typeof value === "string" && value.trim()) ?? inputText;
  } catch { /* Partial tool input remains readable during streaming. */ }
  preview = typeof preview === "string" ? preview.replace(/\s+/g, " ").trim() : inputText;
  const shellCall = isShellTool(toolName);
  const labelKey = shellCall ? "终端" : category === "explore" ? (el.dataset.exploreBucket === "search" ? "搜索" : el.dataset.exploreBucket === "list" ? "列表" : "读取") : "工具调用";
  const expanded = userToggle === "open";
  let displayInput=inputText;
  if (imageAnalysis) {
    preview="";
    try {
      const parameters=JSON.parse(inputText);
      if (typeof parameters.imageSource === "string") {
        try { const url=new URL(parameters.imageSource); parameters.imageSource=url.origin+url.pathname; } catch { /* Local paths stay readable. */ }
      }
      displayInput=JSON.stringify(parameters,null,2);
    } catch { displayInput=t("正在接收参数…"); }
  }
  if (change && change.kind !== "read") noteLocalFile(change, el);
  const fileHtml =
    change && change.kind === "read"
      ? `<div class="file-change">
        <button type="button" class="file-path" data-path="${escapeText(change.path)}">${escapeText(
          change.path
        )}</button>
        ${
          change.kind !== "read" && (change.added != null || change.removed != null)
            ? `<div class="file-meta">+${change.added ?? 0} / -${change.removed ?? 0}</div>`
            : ""
        }
        <div class="file-actions">
          <button type="button" data-open="${escapeText(change.path)}">${t("打开")}</button>
          ${
            change.kind !== "read"
              ? `<button type="button" data-diff="1">${t("查看 diff")}</button>`
              : ""
          }
        </div>
      </div>`
      : "";
  const hideIo = !!change && change.kind !== "read";
  const bodyHtml = `${
    !hideIo && inputText ? `${imageAnalysis ? `<div class="tool-section-label" ${uiLabelAttributes("参数")}>${t("参数")}</div>` : ""}<div class="tool-io">${escapeText(displayInput)}</div>` : ""
  }${
    !hideIo && outputText ? `${imageAnalysis ? `<div class="tool-section-label" ${uiLabelAttributes("结果")}>${t("结果")}</div>` : ""}<div class="tool-io out">${escapeText(outputText)}</div>` : ""
  }${fileHtml}`;
  el.classList.toggle("collapsed", !expanded);
  el.innerHTML = `<button type="button" class="tool-head${category === "tool" && !imageAnalysis ? " raw-tool-head" : ""}" aria-expanded="${expanded ? "true" : "false"}">${processIcon(shellCall ? "terminal" : category)}<span class="tool-name" ${category === "tool" && !imageAnalysis ? "" : uiLabelAttributes(imageAnalysis ? "分析图片" : labelKey)}>${escapeText(imageAnalysis ? t("分析图片") : category === "tool" ? toolName : t(labelKey))}</span><span class="tool-preview" title="${escapeText(imageAnalysis ? "" : preview || toolName)}">${escapeText(imageAnalysis ? "" : preview || toolName)}</span><span class="tool-status ${escapeText(status)}" ${uiLabelAttributes(toolStatusKey(status))}>${escapeText(t(toolStatusKey(status)))}</span><svg class="process-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="tool-body">${bodyHtml}</div>`;
  if (!suspendScroll && (previousCategory !== category || prevStatus !== status)) refreshProcessGroups(el.parentElement);
  if (userToggle) el.dataset.userToggle = userToggle;
  el.querySelector(".tool-head")?.addEventListener("click", () => {
    const open = el.classList.contains("collapsed");
    el.classList.toggle("collapsed", !open);
    el.dataset.userToggle = open ? "open" : "closed";
    el.querySelector(".tool-head")?.setAttribute("aria-expanded", open ? "true" : "false");
  });
  el.querySelectorAll<HTMLButtonElement>("[data-open], .file-path").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const p = btn.dataset.open || btn.dataset.path || change?.path;
      if (p) post({ type: "openFile", path: p });
    });
  });
  el.querySelector<HTMLButtonElement>("[data-diff]")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (change) post({ type: "openDiff", fileChange: change });
  });
}

// Presentation grouping only: tool nodes and their IDs remain independent.
function shellCommandText(inputText: string): string {
  let command = inputText;
  try {
    const input = JSON.parse(inputText);
    command = input.command ?? input.cmd ?? input.script ?? inputText;
    if (Array.isArray(command)) command = command.join(" ");
  } catch { /* Partial input is still a terminal call. */ }
  return typeof command === "string" ? command : "";
}

function unwrapShellLauncher(command: string): string {
  const wrapped = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i.exec(command.trim());
  if (!wrapped?.[1]) return command.trim();
  let inner = wrapped[1].trim();
  if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
    inner = inner.slice(1, -1);
  }
  return inner.trim();
}

function isShellTool(name: string): boolean {
  const base = toolBaseName(name);
  return /^(?:bash|shell|terminal|execute|exec_command|run_command|execute_command|executegroup|exec|run|command)$/.test(base);
}

const EXPLORE_HINT = /\b(?:rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(?:status|log|show|diff)\b/i;
const MUTATING_SHELL = /\b(?:sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(?:add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i;
const SHELL_REDIRECT = /(^|[^\d<])>>?\s*\S|&>\s*\S/i;

function shellClauses(command: string): string[] {
  return unwrapShellLauncher(command).split(/&&|\|\||;/).map(clause => clause.trim()).filter(Boolean);
}

function isExploreShell(command: string): boolean {
  const clauses = shellClauses(command);
  if (!clauses.length || clauses.some(clause => MUTATING_SHELL.test(clause) || SHELL_REDIRECT.test(clause))) return false;
  return clauses.some(clause => EXPLORE_HINT.test(clause));
}

function exploreBucket(name: string, inputText: string): "search" | "list" | "file" {
  const base = toolBaseName(name);
  if (/grep|search|fetch|glob/.test(base)) return "search";
  if (/^(?:list|ls|dir|tree|find|get_repo_structure)(?:_|$)/.test(base)) return "list";
  if (!/^(?:bash|shell|terminal|execute|exec|run|command)/.test(base)) return "file";
  const text = shellClauses(shellCommandText(inputText)).join(" ; ");
  if (/(^|\s)(?:rg|grep|egrep|fgrep|ripgrep|git\s+grep)(\s|$)/i.test(text)) return "search";
  if (/(^|\s)(?:ls|find|tree|dir)(\s|$)/i.test(text)) return "list";
  return "file";
}

function processCategory(name: string, inputText: string): "terminal" | "explore" | "tool" {
  if (isShellTool(name)) return isExploreShell(shellCommandText(inputText)) ? "explore" : "terminal";
  const base = toolBaseName(name);
  if (/^(?:read|view|open|cat|head|tail|glob|grep|search|find|fetch|web_?search|web_?fetch|web_?reader|query|lookup|list|ls|dir|tree|explore|inspect|get_repo_structure)(?:_|$)/.test(base)) return "explore";
  return "tool";
}

function toolBaseName(name: string): string {
  return name.split(/[.:/]|__/).pop()!.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s-]+/g, "_");
}

function processIcon(kind: string): string {
  const name = kind === "reasoning" ? "brain"
    : kind === "question" ? "circleQuestionMark"
    : kind === "terminal" ? "squareTerminal"
    : kind === "explore" ? "search"
    : "codeXml";
  return lucideIcon(name, { className: "process-icon", strokeWidth: 1.5 });
}

function refreshProcessGroups(parent: HTMLElement | null): void {
  if (!parent?.classList.contains("work-fold-body")) return;
  parent.querySelectorAll(":scope > .process-group").forEach(node => node.remove());
  const nodes = [...parent.children] as HTMLElement[];
  for (const node of nodes) node.classList.remove("group-hidden", "group-detail");
  for (let i = 0; i < nodes.length;) {
    const first = nodes[i];
    const category = first.dataset.processCategory;
    if (!first.classList.contains("tool-call") || !category || category === "tool") { i++; continue; }
    const group = [first];
    while (++i < nodes.length && nodes[i].classList.contains("tool-call") && nodes[i].dataset.processCategory === category) group.push(nodes[i]);
    if (group.length < 2) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "process-group process-head";
    const chevron = `<svg class="process-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
    if (category === "terminal") {
      button.innerHTML = `${processIcon(category)}<span ${uiLabelAttributes("终端 · {0} 个命令", { 0: group.length })}>${escapeText(t("终端 · {0} 个命令", { 0: group.length }))}</span>${chevron}`;
    } else {
      button.innerHTML = `${processIcon(category)}<span class="process-group-label"></span>${chevron}`;
      const label = button.querySelector(".process-group-label") as HTMLElement;
      const title = document.createElement("span");
      setUiLabel(title, "查阅");
      label.append(title, document.createTextNode(" · "));
      const counts = { search: 0, list: 0, file: 0 };
      for (const node of group) {
        const bucket = node.dataset.exploreBucket === "search" || node.dataset.exploreBucket === "list" ? node.dataset.exploreBucket : "file";
        counts[bucket] += 1;
      }
      let wrote = false;
      const add = (key: string, count: number) => {
        if (!count) return;
        if (wrote) label.append(document.createTextNode(", "));
        wrote = true;
        const part = document.createElement("span");
        setUiLabel(part, key, { 0: count });
        label.append(part);
      };
      add("{0} 搜索", counts.search);
      add("{0} 列表", counts.list);
      add("{0} 文件", counts.file);
    }
    const groupStatus = group.find(node => ["error", "failed"].includes(node.dataset.toolStatus || ""))?.dataset.toolStatus
      ?? (group.some(node => node.dataset.toolStatus === "running") ? "running" : group.find(node => node.dataset.toolStatus === "cancelled")?.dataset.toolStatus);
    if (groupStatus) {
      const status = document.createElement("span");
      status.className = `tool-status ${groupStatus}`;
      setUiLabel(status, toolStatusKey(groupStatus));
      button.insertBefore(status, button.lastElementChild);
    }
    const paint = () => {
      const open = first.dataset.groupToggle === "open";
      button.setAttribute("aria-expanded", String(open));
      for (const node of group) { node.classList.toggle("group-hidden", !open); node.classList.add("group-detail"); }
    };
    button.addEventListener("click", () => { first.dataset.groupToggle = first.dataset.groupToggle === "open" ? "closed" : "open"; paint(); });
    first.before(button);
    paint();
  }
}

function toolStatusKey(status: string): string {
  return ({ running: "运行中", completed: "已完成", error: "出错", failed: "失败", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

function uiLabelAttributes(key: string, values: Record<string, unknown> = {}): string {
  return `data-i18n-key="${escapeText(key)}" data-i18n-values="${escapeText(JSON.stringify(values))}"`;
}

function setUiLabel(node: HTMLElement, key: string, values: Record<string, unknown> = {}): void {
  node.dataset.i18nKey = key;
  node.dataset.i18nValues = JSON.stringify(values);
  node.textContent = t(key, values);
}

function escapeText(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="4.5" width="6" height="6" rx="1"/><path d="M2.5 7.5H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h4.5a1 1 0 0 1 1 1v.5"/></svg>';
const CHECK_ICON =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3 4.5 8.5 2 6"/></svg>';

function messageProse(el: HTMLElement): string {
  if (el.classList.contains("reply-meta") || el.classList.contains("assistant")) {
    return el.dataset.copyText || "";
  }
  const editing = el.querySelector<HTMLTextAreaElement>(".user-edit");
  if (editing) return editing.value;
  return el.querySelector(".user-body")?.textContent || "";
}

function messageClock(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const hm = date.toLocaleTimeString(getUiLanguage(), { hour: "2-digit", minute: "2-digit", hour12: false });
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t("昨天 {0}", {0: hm});
  if (date.getFullYear() === now.getFullYear()) {
    return t("{0}月{1}日 {2}", {0: date.getMonth() + 1, 1: date.getDate(), 2: hm});
  }
  return t("{0}年{1}月{2}日 {3}", {0: date.getFullYear(), 1: date.getMonth() + 1, 2: date.getDate(), 3: hm});
}

function messageAction(el: HTMLElement, selector: string): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>(`:scope > ${selector}`) ?? messageMeta(el)?.querySelector<HTMLButtonElement>(selector) ?? null;
}

function messageMeta(el: HTMLElement): HTMLElement | null {
  if (el.classList.contains("user")) {
    const anchor = el.dataset.jump;
    if (!anchor) return null;
    const next = el.nextElementSibling;
    if (next instanceof HTMLElement && next.classList.contains("msg-meta") && next.dataset.anchor === anchor) return next;
    // Git cards and history reconciliation can temporarily separate siblings.
    return [...messagesEl.querySelectorAll<HTMLElement>(":scope > .msg-meta.outside")]
      .find(meta => meta.dataset.anchor === anchor) ?? null;
  }
  return el.querySelector<HTMLElement>(":scope > .msg-meta");
}

function questionFoldStateKey(question: HTMLElement, occurrences: Map<string, number>): string {
  const base = `text:${question.dataset.rawText || ""}`;
  const occurrence = occurrences.get(base) ?? 0;
  occurrences.set(base, occurrence + 1);
  return `${base}\u0000${occurrence}`;
}

function replyFooterNear(anchor: HTMLElement): HTMLElement | null {
  for (const dir of ["previousElementSibling", "nextElementSibling"] as const) {
    let node: Element | null = anchor[dir];
    while (node instanceof HTMLElement) {
      if (node.classList.contains("reply-meta")) return node;
      if (
        node.classList.contains("message") &&
        node.classList.contains("user") &&
        !node.classList.contains("queued")
      ) {
        break;
      }
      node = node[dir];
    }
  }
  return null;
}

function replyEnd(anchor: HTMLElement): HTMLElement {
  let end = anchor;
  let node = anchor.nextElementSibling;
  while (node instanceof HTMLElement) {
    if (
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued")
    ) {
      break;
    }
    // Timeline separators begin the next visual event. Keep this reply's
    // copy/time footer above them rather than letting it drift below a switch.
    if (node.classList.contains("timeline-mark")) break;
    if (!node.classList.contains("reply-meta")) end = node;
    node = node.nextElementSibling;
  }
  return end;
}

function replyProse(footer: HTMLElement): string {
  const chunks: string[] = [];
  let node = footer.previousElementSibling;
  while (node instanceof HTMLElement) {
    if (
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued")
    ) {
      break;
    }
    const prose = node.classList.contains("assistant")
      ? [node]
      : [...node.querySelectorAll<HTMLElement>(".message.assistant")];
    const text = prose.map(el => el.dataset.copyText?.trim()).filter(Boolean).join("\n\n");
    if (text) chunks.push(text);
    node = node.previousElementSibling;
  }
  return chunks.reverse().join("\n\n");
}

function turnStartedAt(anchor: HTMLElement): number | undefined {
  let node: Element | null = anchor;
  let found: number | undefined;
  while (node instanceof HTMLElement) {
    if (
      node.classList.contains("message") &&
      node.classList.contains("user") &&
      !node.classList.contains("queued")
    ) {
      break;
    }
    const sent = Number(node.dataset.sentAt);
    if (node.classList.contains("assistant") && Number.isFinite(sent) && sent > 0) found = sent;
    node = node.previousElementSibling;
  }
  return found;
}

function syncReplyFooter(anchor: HTMLElement, force: boolean): void {
  if (!force && isGenerating) {
    replyFooterNear(anchor)?.remove();
    return;
  }
  const sent = Number(anchor.dataset.sentAt);
  ensureReplyFooter(anchor, Number.isFinite(sent) && sent > 0 ? sent : undefined);
}

function settleReplyFooters(): void {
  for (const turn of groupTurns()) {
    let anchor: HTMLElement | null = null;
    for (const el of turn) {
      if (el.classList.contains("msg-meta")) continue;
      if (el.classList.contains("message") && el.classList.contains("user")) continue;
      anchor = el;
    }
    // Intermediate parts may have been moved into a work fold. Only retain
    // the single footer placed after the entire turn.
    for (const el of turn) {
      if (el.classList.contains("reply-meta")) el.remove();
      else el.querySelectorAll(".reply-meta").forEach(meta => meta.remove());
    }
    // Compact/goal/model separators are not assistant prose — no copy footer.
    const hasAssistantProse = turn.some(el =>
      (el.classList.contains("message") && el.classList.contains("assistant") && !!el.dataset.copyText?.trim()) ||
      [...el.querySelectorAll<HTMLElement>(".message.assistant")].some(node => !!node.dataset.copyText?.trim())
    );
    if (anchor && hasAssistantProse) ensureReplyFooter(anchor);
  }
  // Completion may create reply footers after the history's first folding pass.
  // Reapply turn visibility so newly added copy/time controls stay inside the
  // same folded turn instead of appearing as orphan actions below the fold bar.
  foldOldTurns();
}

function ensureReplyFooter(anchor: HTMLElement, at?: number): void {
  const stamp = turnStartedAt(anchor) ?? (at && at > 0 ? at : undefined);
  let meta = replyFooterNear(anchor);
  if (!meta) {
    meta = document.createElement("div");
    meta.className = "msg-meta reply-meta";
    meta.dataset.sentAt = String(stamp && stamp > 0 ? stamp : Date.now());
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-copy";
    btn.title = t("复制");
    btn.setAttribute("aria-label", t("复制"));
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      void copyMessage(meta!, btn);
    });
    const time = document.createElement("time");
    time.className = "msg-time";
    meta.append(btn, time);
  }
  replyEnd(anchor).after(meta);
  pinGitCards();
  const prose = replyProse(meta);
  meta.dataset.copyText = prose;
  if (!prose.trim()) {
    meta.hidden = true;
    return;
  }
  meta.hidden = false;
  paintMessageTime(meta, Number(meta.dataset.sentAt));
}

function isCompactCommand(text: string): boolean {
  return /^\/compact(?:\s|$)/i.test(text.trim());
}

function ensureMessageMeta(el: HTMLElement, options: { copy?: boolean } = {}): void {
  const allowCopy = options.copy !== false;
  const prose = messageProse(el).trim();
  const outside = el.classList.contains("user");
  if (!prose && !outside) {
    messageMeta(el)?.remove();
    return;
  }
  let meta = messageMeta(el);
  if (!meta) {
    meta = document.createElement("div");
    meta.className = outside ? "msg-meta outside" : "msg-meta";
    if (outside) meta.dataset.anchor = el.dataset.jump || "";
    const time = document.createElement("time");
    time.className = "msg-time";
    meta.append(time);
    if (outside) el.after(meta);
    else el.appendChild(meta);
  }
  let btn = meta.querySelector<HTMLButtonElement>(":scope > .msg-copy");
  if (allowCopy) {
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg-copy";
      btn.title = t("复制");
      btn.setAttribute("aria-label", t("复制"));
      btn.innerHTML = COPY_ICON;
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        void copyMessage(el, btn!);
      });
      meta.prepend(btn);
    }
  } else {
    btn?.remove();
  }
  if (outside) {
    if (el.nextElementSibling !== meta) el.after(meta);
    for (const action of el.querySelectorAll(":scope > .turn-collapse-btn, :scope > .turn-edit-btn")) meta.prepend(action);
    const edit = meta.querySelector<HTMLButtonElement>(":scope > .turn-edit-btn");
    const collapse = meta.querySelector<HTMLButtonElement>(":scope > .turn-collapse-btn");
    if (edit && collapse) meta.insertBefore(edit, collapse);
  }
  paintMessageTime(meta, Number(el.dataset.sentAt));
}

const QUESTION_FOLD_ICON =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5"/></svg>';

function syncQuestionFoldControl(question: HTMLElement, expanded = question.dataset.questionExpanded === "1"): void {
  const body = question.querySelector<HTMLElement>(":scope > .user-body");
  const meta = messageMeta(question);
  const existing = meta?.querySelector<HTMLButtonElement>(":scope > .question-fold-btn");
  if (!body || !meta || question.classList.contains("queued")) {
    existing?.remove();
    question.classList.remove("question-collapsed");
    delete question.dataset.questionExpanded;
    return;
  }

  question.classList.add("question-collapsed");
  const canCollapse = body.scrollHeight > body.clientHeight + 1;
  if (!canCollapse) {
    question.classList.remove("question-collapsed");
    delete question.dataset.questionExpanded;
    existing?.remove();
    return;
  }

  question.classList.toggle("question-collapsed", !expanded);
  question.dataset.questionExpanded = expanded ? "1" : "0";
  let button = existing;
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "question-fold-btn turn-chevron";
    button.innerHTML = QUESTION_FOLD_ICON;
    button.addEventListener("click", event => {
      event.stopPropagation();
      syncQuestionFoldControl(question, question.classList.contains("question-collapsed"));
    });
    const copy = meta.querySelector(":scope > .msg-copy");
    meta.insertBefore(button, copy ?? meta.firstChild);
  }
  const label = expanded ? t("折叠问题") : t("展开问题");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.classList.toggle("expand", !expanded);
}

function syncQuestionFoldControls(): void {
  for (const question of sentQuestions()) {
    syncQuestionFoldControl(question, question.dataset.questionExpanded === "1");
  }
}

function paintMessageTime(meta: HTMLElement, sent: number): void {
  const time = meta.querySelector("time");
  if (!time) return;
  if (!Number.isFinite(sent) || sent <= 0) {
    time.textContent = "";
    time.hidden = true;
    return;
  }
  time.hidden = false;
  time.dateTime = new Date(sent).toISOString();
  time.dataset.sentAt = String(sent);
  time.textContent = messageClock(sent);
  time.title = new Date(sent).toLocaleString(getUiLanguage(), { hour12: false });
}

async function copyMessage(el: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const text = messageProse(el);
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    post({ type: "copy", text });
  }
  btn.innerHTML = CHECK_ICON;
  showToast(t("已复制"));
  window.setTimeout(() => {
    if (btn.isConnected) btn.innerHTML = COPY_ICON;
  }, 1200);
}

function wireCopyButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>(".copy-btn").forEach((btn) => {
    btn.textContent = t("Copy");
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const block = btn.closest(".code-block");
      const code = block?.querySelector("code")?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        post({ type: "copy", text: code });
      }
      btn.textContent = t("Copied");
      showToast(t("Copied to clipboard"));
      setTimeout(() => {
        btn.textContent = t("Copy");
      }, 1200);
    });
  });
}

function relativeTime(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return t("just now");
  if (min < 60) return t("{0}分钟前", { "0": min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("{0}小时前", { "0": hr });
  const day = Math.round(hr / 24);
  return t("{0}天前", { "0": day });
}

function sessionIsRunning(session: Session): boolean {
  return (
    runningSessions.has(session.sessionId) ||
    /^(running|busy|generating)$/i.test(session.status || "")
  );
}

function markSessionRunning(sessionId: string, running: boolean): void {
  if (!sessionId) return;
  if (running) runningSessions.add(sessionId);
  else runningSessions.delete(sessionId);
  if (overlayMode === "sessions") rebuildOverlay(overlaySearch.value);
}

function sessionActionBusyLabel(action: SessionAction): string {
  switch (action) {
    case "rename": return t("正在重命名");
    case "archive": return t("正在归档");
    case "unarchive": return t("正在恢复");
    case "delete": return t("正在删除");
  }
}

function sessionActionLabel(action: SessionAction): string {
  switch (action) {
    case "rename": return "重命名";
    case "archive": return "归档";
    case "unarchive": return "恢复";
    case "delete": return "删除";
  }
}

function sessionActionButton(action: SessionAction, label: string, pending?: SessionAction): string {
  const busy = pending === action;
  const disabled = pending !== undefined;
  const aria = busy ? ` aria-label="${escapeText(sessionActionBusyLabel(action))}" aria-busy="true"` : "";
  return `<button type="button" data-act="${action}"${disabled ? " disabled" : ""}${busy ? ` data-pending="1"${aria}` : ""}><span class="session-action-label">${t(label)}</span><span class="session-action-dots" aria-hidden="true"${busy ? "" : " hidden"}><i></i><i></i><i></i></span></button>`;
}

function beginSessionAction(sessionId: string, action: SessionAction, requestId = `session-action-${++sessionActionRequestSequence}`): string {
  pendingSessionActions.set(sessionId, { action, requestId });
  if (overlayMode === "sessions") rebuildOverlay(overlaySearch.value);
  return requestId;
}

function finishSessionAction(sessionId: string, requestId: string): void {
  if (pendingSessionActions.get(sessionId)?.requestId !== requestId) return;
  pendingSessionActions.delete(sessionId);
  if (overlayMode === "sessions") rebuildOverlay(overlaySearch.value);
}

function openOverlay(mode: "sessions" | "models" | "mode" | "thought"): void {
  hideTooltip();
  if (mode === "sessions") {
    closePicker();
    overlayMode = mode;
    overlay.classList.add("open");
    overlayTitle.textContent = t("Sessions in this workspace");
    overlaySearch.value = "";
    overlaySearch.placeholder = t("Filter sessions…");
    const tabs = document.getElementById("session-tabs");
    tabs?.classList.add("show");
    showArchived = false;
    document.getElementById("tab-active")?.classList.add("active");
    document.getElementById("tab-archived")?.classList.remove("active");
    if (isGenerating && currentSessionId) runningSessions.add(currentSessionId);
    post({ type: "listSessions", includeArchived: false });
    rebuildOverlay("");
    overlaySearch.focus();
    return;
  }
  openPicker(mode);
}

function pickerAnchor(mode: "models" | "mode" | "thought"): HTMLElement {
  return mode === "models" ? modelChip : mode === "mode" ? modeChip : thoughtChip;
}

function setPickerExpanded(mode: "models" | "mode" | "thought" | null): void {
  for (const [id, chip] of [
    ["models", modelChip],
    ["mode", modeChip],
    ["thought", thoughtChip],
  ] as const) {
    chip.setAttribute("aria-expanded", String(id === mode));
  }
}

function placePicker(): void {
  if (!popover.classList.contains("open")) return;
  if (overlayMode !== "models" && overlayMode !== "mode" && overlayMode !== "thought") return;
  const host = composerEl.getBoundingClientRect();
  const chip = pickerAnchor(overlayMode).getBoundingClientRect();
  popover.style.bottom = `${Math.max(0, host.bottom - chip.top + 6)}px`;
  const width = popover.offsetWidth;
  const minLeft = 8;
  const maxLeft = Math.max(minLeft, host.width - width - 8);
  let left = chip.left - host.left;
  if (left > maxLeft) left = maxLeft;
  if (left < minLeft) left = minLeft;
  popover.style.left = `${left}px`;
}

function openPicker(mode: "models" | "mode" | "thought"): void {
  // Opening a menu from the hovered chip must dismiss its hover card, or the
  // card sits on top of the menu the user is trying to read.
  hideTooltip();
  overlay.classList.remove("open");
  if (overlayMode === mode && popover.classList.contains("open")) {
    closePicker();
    return;
  }
  overlayMode = mode;
  popover.classList.add("open");
  setPickerExpanded(mode);
  rebuildOverlay("");
  placePicker();
}

function closePicker(): void {
  popover.classList.remove("open");
  if (overlayMode === "models" || overlayMode === "mode" || overlayMode === "thought") {
    overlayMode = null;
  }
  setPickerExpanded(null);
}

function closeOverlay(): void {
  overlay.classList.remove("open");
  closePicker();
  overlayMode = null;
  input.focus();
}

function rebuildOverlay(query: string): void {
  const q = query.trim().toLowerCase();
  overlayItems = [];
  const listEl =
    overlayMode === "sessions" ? overlayList : popoverList;
  listEl.innerHTML = "";

  if (overlayMode === "sessions") {
    const ranked = [...sessions].sort((a, b) => {
      const ar = sessionIsRunning(a) ? 1 : 0;
      const br = sessionIsRunning(b) ? 1 : 0;
      return br - ar;
    });
    overlayItems = ranked
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.sessionId.toLowerCase().includes(q))
      .map((s) => ({
        id: s.sessionId,
        title: s.title || t("Untitled"),
        sub: [s.model?.modelId, relativeTime(s.updatedAt)].filter(Boolean).join(" · "),
        running: sessionIsRunning(s),
        payload: s.sessionId,
      }));
  } else if (overlayMode === "models") {
    overlayItems = models
      .filter(
        (m) =>
          !q ||
          m.label.toLowerCase().includes(q) ||
          m.modelId.toLowerCase().includes(q) ||
          providerGroup(m).toLowerCase().includes(q) ||
          m.providerId.toLowerCase().includes(q)
      )
      .map((m) => ({
        id: `${m.providerId}/${m.modelId}`,
        title: m.modelId,
        sub: providerGroup(m),
        disabled: !!m.disabledReason || m.hasKey === false,
        payload: m,
      }));
  } else if (overlayMode === "mode") {
    overlayItems = SESSION_MODES.map(mode => ({ ...mode, label: t(mode.label), description: t(mode.description) })).filter(
      (m) =>
        !q ||
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q)
    ).map((m) => ({
      id: m.id,
      title: m.label,
      sub: m.description,
      payload: m.id,
    }));
  } else if (overlayMode === "thought") {
    overlayItems = thoughtLevels
      .filter(
        (t) =>
          !q ||
          t.label.toLowerCase().includes(q) ||
          t.value.toLowerCase().includes(q) ||
          (t.description || "").toLowerCase().includes(q)
      )
      .map((t) => ({
        id: t.value,
        title: t.label,
        sub: t.description || t.value,
        payload: t.value,
      }));
  }

  if (overlayItems.length === 0) {
    listEl.innerHTML = `<div class="overlay-empty">${t("Nothing matches.")}</div>`;
    placePicker();
    return;
  }

  let lastGroup = "";
  overlayItems.forEach((item, idx) => {
    if (overlayMode === "models") {
      const group = item.sub ?? "";
      if (group && group !== lastGroup) {
        const header = document.createElement("div");
        header.className = "overlay-group";
        header.textContent = group;
        listEl.appendChild(header);
        lastGroup = group;
      }
    }
    const el = document.createElement("button");
    el.type = "button";
    el.className =
      "overlay-item" +
      (item.disabled ? " disabled" : "") +
      ((overlayMode === "sessions" && item.id === currentSessionId) ||
      (overlayMode === "models" && item.id === currentModelLabel) ||
      (overlayMode === "mode" && item.id === baseMode) ||
      (overlayMode === "thought" && item.id === currentThought)
        ? " active"
        : "");
    const body =
      overlayMode === "models"
        ? `<div class="oi-title">${escapeText(item.title)}</div>`
        : `<div class="oi-title">${escapeText(item.title)}${
            item.running ? `<span class="oi-live">${t("运行中")}</span>` : ""
          }</div><div class="oi-sub">${escapeText(item.sub ?? "")}</div>`;
    if (overlayMode === "sessions") {
      const archived = showArchived;
      const pendingAction = pendingSessionActions.get(item.id)?.action;
      el.innerHTML = `<div class="oi-row"><div class="oi-main">${body}</div><div class="oi-actions">
        ${pendingAction ? sessionActionButton(pendingAction, sessionActionLabel(pendingAction), pendingAction) : `${archived ? "" : sessionActionButton("rename", "重命名")}${sessionActionButton(archived ? "unarchive" : "archive", archived ? "恢复" : "归档")}${archived ? sessionActionButton("delete", "删除") : ""}`}
      </div></div>`;
      if (pendingAction) {
        el.setAttribute("aria-busy", "true");
        el.dataset.operationPending = "1";
      }
      el.querySelectorAll("button[data-act]").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const act = (btn as HTMLButtonElement).dataset.act;
          const id = item.id;
          if (!act || pendingSessionActions.has(id)) return;
          const requestId = `session-action-${++sessionActionRequestSequence}`;
          if (act === "rename") {
            post({ type: "renameSession", sessionId: id, title: item.title, actionRequestId: requestId });
          } else if (act === "archive" || act === "unarchive" || act === "delete") {
            beginSessionAction(id, act, requestId);
            post({
              type: act === "archive" ? "archiveSession" : act === "unarchive" ? "unarchiveSession" : "deleteSession",
              sessionId: id,
              actionRequestId: requestId,
            });
          }
        });
      });
    } else if (overlayMode === "mode") {
      el.innerHTML = `<div class="oi-mode">${modeIcon(item.id)}<div class="oi-main">${body}</div></div>`;
    } else if (overlayMode === "thought") {
      el.innerHTML = `<div class="oi-title"><span class="thought-mark">${escapeText(thoughtMark(item.id))}</span>${escapeText(item.title)}</div><div class="oi-sub">${escapeText(item.sub ?? "")}</div>`;
    } else {
      el.innerHTML = body;
    }
    el.disabled = !!item.disabled;
    el.addEventListener("click", () => selectOverlay(idx));
    listEl.appendChild(el);
  });
  placePicker();
}

function selectOverlay(idx: number): void {
  const item = overlayItems[idx];
  if (!item || item.disabled) return;
  if (overlayMode === "sessions") {
    if (pendingSessionActions.has(item.id)) return;
    if (showArchived) {
      showToast(t("请先取消归档再打开"));
      return;
    }
    const next = String(item.payload);
    // The open conversation is already on screen. Closing the list is enough.
    if (next === currentSessionId) {
      closeOverlay();
      return;
    }
    if (isGenerating && currentSessionId) {
      runningSessions.add(currentSessionId);
    }
    currentSessionId = next;
    setSessionTitle(item.title);
    post({ type: "switchSession", sessionId: item.payload });
  } else if (overlayMode === "models") {
    const m = item.payload as PickerModel;
    currentModelLabel = `${m.providerId}/${m.modelId}`;
    modelChip.textContent = m.modelId;
    modelChip.title = `${providerGroup(m)} / ${m.modelId}`;
    post({ type: "selectModel", providerId: m.providerId, modelId: m.modelId });
  } else if (overlayMode === "mode") {
    const picked = String(item.payload);
    if (picked === "plan") planEnabled = true;
    else baseMode = picked;
    applySessionControls({
      mode: picked,
      baseMode,
      planEnabled: picked === "plan" ? true : false,
      thoughtEnabled,
      thoughtLevel: currentThought,
      thoughtLevels,
    });
    post({ type: "setMode", mode: picked, sessionId: currentSessionId, viewGen });
  } else if (overlayMode === "thought") {
    currentThought = String(item.payload);
    applySessionControls({ mode: currentMode, thoughtEnabled, thoughtLevel: currentThought, thoughtLevels });
    post({ type: "setThoughtLevel", sessionId: currentSessionId, viewGen, thoughtLevel: currentThought });
  }
  closeOverlay();
}

function showSetup(reason: string, hint: string, picker: PickerModel[]): void {
  setupEl.classList.add("open");
  const guidance = errorGuidance(reason || hint);
  setUiLabel(setupTitle, guidance.title);
  setUiLabel(setupHint, guidance.hint);
  const recovery = document.getElementById("setup-recovery")!;
  recovery.innerHTML = `<details class="error-details"><summary ${uiLabelAttributes("错误详情")}>${t("错误详情")}</summary><pre>${escapeText([reason,hint].filter(Boolean).join("\n"))}</pre></details>
    <div class="err-actions">${[ ["retry","重新读取登录"], ["copyDiagnostics","复制诊断信息"], ["showLog","打开日志"], ["community","社区提问"] ].map(([act,label])=>`<button type="button" data-act="${act}" ${uiLabelAttributes(label)}>${t(label)}</button>`).join("")}</div>`;
  recovery.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.addEventListener("click",()=>{
    const act=button.dataset.act;
    if(act==="retry"){hideSetup();post({type:"retry"});}
    else if(act==="community")post({type:"openCommunity"});
    else if(act==="showLog")post({type:"showLog"});
    else if(act==="copyDiagnostics")post({type:"copyDiagnostics"});
  }));
  setupList.innerHTML = "";
  const usable = picker.filter((p) => p.hasKey !== false && !p.disabledReason);
  if (usable.length === 0) {
    setupList.innerHTML = `<div class="overlay-empty">${t("No saved API keys found. Open the ZCode desktop app and sign in, then click Retry.")}</div>`;
    return;
  }
  usable.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "overlay-item";
    btn.innerHTML = `<div class="oi-title">${escapeText(m.modelId || m.label)}</div><div class="oi-sub">${escapeText(
      providerGroup(m)
    )}</div>`;
    btn.addEventListener("click", () => {
      setupEl.classList.remove("open");
      post({
        type: "selectModel",
        providerId: m.providerId,
        modelId: m.modelId,
        restart: true,
      });
    });
    setupList.appendChild(btn);
  });
}

function hideSetup(): void {
  setupEl.classList.remove("open");
}

type HistoryViewItem = {
  turnId?: string;
  rowId?: number;
  logEpoch?: string;
  attachments?: ImageAttachment[];
  attachmentTarget?: {rowId:number;entityId:string};
  id?: string;
  sourceCommandId?: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: number;
  endedAt?: number;
  workDurationMs?: number;
  running?: boolean;
  work?: { text: string; durationMs?: number; interrupted?: boolean };
  steps?: Array<
    | { kind: "reasoning"; text: string; partId?: string }
    | { kind: "text"; text: string; partId?: string }
    | { kind: "goal"; passed: boolean; iteration?: number }
    | { kind: "model"; from?: string; to?: string; fromProvider?: string; toProvider?: string }
    | { kind: "compact"; status: "running" | "success" | "failed" | "noop" | "cancelled"; origin?: "manual" | "auto" }
    | {
        kind: "tool";
        toolCallId?: string;
        toolName: string;
        status: string;
        inputText?: string;
        outputText?: string;
        fileChange?: FileChange;
      }
  >;
  tools?: Array<{
    toolName: string;
    status: string;
    inputText?: string;
    outputText?: string;
    fileChange?: FileChange;
  }>;
};

function tailStillRunning(items: HistoryViewItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === "assistant") return !!items[i].running;
  }
  return false;
}

function sameWorkQuestion(question: HTMLElement | null | undefined, item: HistoryViewItem | undefined): boolean {
  if (!question || !item) return false;
  if (item.id && question.dataset.jump === item.id) return true;
  if (item.sourceCommandId && question.dataset.sourceCommandId === item.sourceCommandId) return true;
  return question.dataset.live === "1" && sameQuery(question, item.text, item.attachments ?? []);
}

function renderHistoryItems(items: HistoryViewItem[], activeSince = 0, carriedWorkMs?: number, liveStartAt = 0, liveQuestion?: HTMLElement | null): void {
  let group: HistoryViewItem[] = [];
  let segmentQuestion: HistoryViewItem | undefined;
  const lastAssistant = new Map<string, number>();
  items.forEach((item, index) => { if (item.role === "assistant" && item.turnId) lastAssistant.set(item.turnId, index); });
  let lastAssistantItem: HistoryViewItem | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index].role === "assistant") { lastAssistantItem = items[index]; break; }
  }
  const flush = (active: boolean, continuation = false, endBoundary = 0) => {
    if (group.length) {
      const latest = !continuation && lastAssistantItem && group.includes(lastAssistantItem);
      const reuseClock = latest && sameWorkQuestion(liveQuestion, segmentQuestion);
      renderAssistantTurn(group, active ? activeSince : 0, continuation,
        reuseClock ? carriedWorkMs : undefined, reuseClock ? liveStartAt : 0, endBoundary, restartAt);
    }
    group = [];
  };
  // The most recent insert inside this turn: earlier segments end there, and
  // segments after it restart their clock there when row times are missing.
  let restartAt = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.role === "user") {
      const turnId = group[0]?.turnId;
      const insert = !!turnId && (item.turnId === turnId || (lastAssistant.get(turnId) ?? -1) > index);
      const boundary = insert && item.createdAt && item.createdAt > 0 ? item.createdAt : 0;
      flush(false, insert, boundary);
      if (boundary) {
        restartAt = boundary;
        if (activeSince > 0) turnWorkStarted = boundary;
      } else if (!insert) {
        restartAt = 0;
      }
      segmentQuestion = item;
      if (activeSince > 0) {
        turnWorkStarted = sameWorkQuestion(liveQuestion, item) && liveStartAt > 0
          ? Math.max(liveStartAt, restartAt)
          : Math.max(activeSince, item.createdAt || 0, restartAt);
      }
      addUserMessage(item.text, [], false, undefined, item.id, item.createdAt, item.sourceCommandId, item.attachments, item.attachmentTarget);
      const bubble = sentQuestions().at(-1);
      if (bubble && item.turnId) bubble.dataset.taskId = item.turnId;
      // dataset.rowId belongs to the edit target and is cleared for every other
      // question. The transcript row has to live on its own attribute.
      if (bubble && item.rowId !== undefined) bubble.dataset.transcriptRow = String(item.rowId);
    } else {
      // Backend turn IDs can advance for hidden runtime work (for example a
      // todo reminder or background result) without a new visible user prompt.
      // Keep adjacent assistant output in one displayed work segment; visible
      // user messages above remain the boundary that starts a new segment.
      group.push(item);
    }
  }
  flush(activeSince > 0);
}

function isTimelinePiece(piece: NonNullable<HistoryViewItem["steps"]>[number]): boolean {
  return piece.kind === "compact" || piece.kind === "goal" || piece.kind === "model";
}

/** The visible answer is the last prose that no tool follows. A later thought
 * can still settle after that answer; a later tool means the prose was narration. */
function finalAnswerIndex(pieces: NonNullable<HistoryViewItem["steps"]>): number {
  let toolFollows = false;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i];
    if (!piece || isTimelinePiece(piece)) continue;
    if (piece.kind === "tool") {
      toolFollows = true;
      continue;
    }
    if (piece.kind !== "text" || !piece.text.trim()) continue;
    if (!splitZaiBuiltin(piece.text).some(part => part.kind === "text" && part.text.trim())) continue;
    return toolFollows ? -1 : i;
  }
  return -1;
}

function renderAssistantTurn(items: HistoryViewItem[], activeSince = 0, continuation = false, carriedWorkMs?: number, liveStartAt = 0, endBoundary = 0, restartAt = 0): void {
  const last = items[items.length - 1];
  let started = 0;
  let ended = 0;
  let workDurationMs: number | undefined;
  const workDurationByTurn = new Map<string, number>();
  let reasoningDurationMs = 0;
  const pieces: HistoryViewItem["steps"] = [];
  for (const item of items) {
    if (item.createdAt && item.createdAt > 0) started = started ? Math.min(started, item.createdAt) : item.createdAt;
    if (item.endedAt && item.endedAt > 0) ended = Math.max(ended, item.endedAt);
    if (typeof item.workDurationMs === "number" && item.workDurationMs >= 0) {
      workDurationMs = item.workDurationMs;
      if (item.turnId) workDurationByTurn.set(item.turnId, item.workDurationMs);
    }
    if (item.work?.durationMs && item.work.durationMs > 0) reasoningDurationMs += item.work.durationMs;
    if (item.steps?.length) {
      pieces.push(...item.steps);
      continue;
    }
    if (item.work?.text.trim()) pieces.push({ kind: "reasoning", text: item.work.text.trim() });
    if (item.text.trim()) pieces.push({ kind: "text", text: item.text });
    for (const tool of item.tools ?? []) pieces.push({ kind: "tool", ...tool });
  }
  // A single visible prompt can span multiple backend turns when runtime-only
  // inputs are hidden from the transcript. Each header's active time is copied
  // onto its rows, so sum once per distinct backend turn rather than showing
  // only the last header's duration.
  if (workDurationByTurn.size > 1) {
    workDurationMs = [...workDurationByTurn.values()].reduce((sum, duration) => sum + duration, 0);
  }
  // An inserted prompt splits the turn: the segment before the insert ends at
  // it, and every segment after it restarts there — row times can be missing,
  // so the insert boundary also floors the start.
  if (endBoundary > 0 && ended > endBoundary) ended = endBoundary;
  if (restartAt > 0 && started < restartAt) started = restartAt;
  const splitTurn = endBoundary > 0 || restartAt > 0;
  const segmentStarted = started;
  const answerAt = finalAnswerIndex(pieces);
  const before = answerAt < 0 ? pieces : pieces.slice(0, answerAt);
  const answerPiece = pieces[answerAt];
  const answer = answerPiece?.kind === "text" ? answerPiece.text : "";
  const after = answerAt < 0 ? [] : pieces.slice(answerAt + 1);
  const beforeWork = before.filter(piece => !isTimelinePiece(piece));
  const beforeMarks = before.filter(isTimelinePiece);
  const running = !continuation && (activeSince > 0 || !!last.running);
  const interrupted = !!last.work?.interrupted;
  const clock =
    splitTurn && started > 0
      ? started
      : activeSince > 0 && started > 0
        ? Math.min(started, activeSince)
        : activeSince > 0
          ? activeSince
          : started;
  if (running) {
    // Keep the visible clock's exact start across a live redraw. Server row
    // timestamps are used only when restoring a turn without a local fold.
    const runningStartedAt = liveStartAt > 0 ? Math.max(liveStartAt, restartAt) : clock;
    // The answer still being written stays below the fold, as it does during
    // live deltas. Text already followed by later reasoning belongs inside.
    const streamingAnswer = !!answer.trim() && after.length === 0;
    const runningWork = streamingAnswer ? beforeWork : pieces.filter(piece => !isTimelinePiece(piece));
    const runningMarks = streamingAnswer ? beforeMarks : pieces.filter(isTimelinePiece);
    // Compact (and other timeline separators) must not open an empty work fold.
    if (runningWork.length || (!streamingAnswer && !!answer.trim())) {
      const fold = createWorkFold("running", runningStartedAt || undefined);
      fold.dataset.startedAt = String(runningStartedAt || Date.now());
      turnWorkStarted = Number(fold.dataset.startedAt);
      attachMessage(fold);
      appendHistoryPieces(fold, streamingAnswer ? beforeWork : runningWork, true);
      fold.classList.add("open");
      // Restoring a running turn follows the newest output, as the live
      // stream does, instead of leaving the process scroller wherever it was.
      workBody(fold).scrollTop = workBody(fold).scrollHeight;
      paintWorkFold(fold);
      startWorkTicker();
    }
    if (runningMarks.length) appendHistoryPieces(null, runningMarks, false);
    if (streamingAnswer) {
      const el = startAssistantMessage({ at: last.createdAt });
      renderAssistantBody(el, answer, false);
      if (answerPiece?.kind === "text" && answerPiece.partId) el.dataset.partId = answerPiece.partId;
      currentAssistantEl = el;
    }
    return;
  }
  const span = segmentStarted && ended > segmentStarted ? ended - segmentStarted : undefined;
  const duration = splitTurn
    ? span ?? carriedWorkMs
    : workDurationMs ?? (span ?? (reasoningDurationMs > 0 ? reasoningDurationMs : carriedWorkMs));
  const visibleDuration = duration !== undefined && (splitTurn || !continuation) ? duration : undefined;
  if (beforeWork.length) {
    const fold = createWorkFold(
      interrupted ? "interrupted" : "completed",
      clock || undefined
    );
    if (continuation) fold.dataset.continuation = "1";
    if (visibleDuration !== undefined) fold.dataset.durationMs = String(visibleDuration);
    attachMessage(fold);
    appendHistoryPieces(fold, beforeWork, true);
    // A visible insert ends this segment even if it has no final answer. Keep
    // the old work folded by default so the newly inserted prompt starts clear.
    if (!continuation && (!answer.trim() || interrupted)) fold.classList.add("open");
    paintWorkFold(fold);
  } else if (answer.trim() && visibleDuration !== undefined) {
    // Fast direct answers may have no reasoning/tool parts to expand, while
    // the backend still provides a real elapsed duration for the reply.
    attachMessage(createWorkDurationBar(visibleDuration));
  }
  if (beforeMarks.length) appendHistoryPieces(null, beforeMarks, false);
  if (answer.trim()) {
    const el = startAssistantMessage({ at: last.createdAt });
    renderAssistantBody(el, answer, true);
    if (answerPiece?.kind === "text" && answerPiece.partId) el.dataset.partId = answerPiece.partId;
    currentAssistantEl = null;
  }
  // Reasoning may follow the last answer while a turn is settling. It still
  // needs a work fold; passing a null fold would silently discard it.
  let trailingFold: HTMLElement | null = null;
  for (const piece of after) {
    if (piece.kind === "reasoning") {
      if (!trailingFold) {
        trailingFold = createWorkFold(interrupted ? "interrupted" : "completed");
        trailingFold.dataset.continuation = "1";
        trailingFold.classList.add("open");
        attachMessage(trailingFold);
      }
      appendHistoryPieces(trailingFold, [piece], true);
    } else if (isTimelinePiece(piece)) {
      appendHistoryPieces(null, [piece], false);
    } else {
      appendHistoryPieces(trailingFold, [piece], !!trailingFold);
    }
  }
}

/** Goal sentences already painted from transcript rows. A goal snapshot must not add another copy at the tail. */
let historyGoalKeys = new Set<string>();

function goalMarkKey(passed: boolean, iteration: number): string {
  return `${passed ? "pass" : "fail"}:${iteration}`;
}

/** Same shape as the live banner: modelId, then (provider name) when the picker knows it. */
function modelSwitchText(model: string | undefined, providerId?: string): string | undefined {
  if (!model) return undefined;
  if (/\([^)]*\)$/.test(model)) return model;
  const entry = providerId
    ? models.find(item => item.providerId === providerId && item.modelId === model)
    : undefined;
  const source = entry?.providerName?.trim() || entry?.providerLabel?.trim();
  return source ? `${model}(${source})` : model;
}

function renderModelMarkLabel(mark: HTMLElement, from: string | undefined, to: string, fromProvider?: string, toProvider?: string): void {
  if (fromProvider) mark.dataset.fromProvider = fromProvider;
  else delete mark.dataset.fromProvider;
  if (toProvider) mark.dataset.toProvider = toProvider;
  else delete mark.dataset.toProvider;
  if (from && !/\([^)]*\)$/.test(from)) mark.dataset.fromModel = from;
  else delete mark.dataset.fromModel;
  if (!/\([^)]*\)$/.test(to)) mark.dataset.toModel = to;
  else delete mark.dataset.toModel;
  const fromText = modelSwitchText(from, fromProvider);
  const toText = modelSwitchText(to, toProvider) ?? to;
  mark.innerHTML = SWITCH_ICON;
  const label = document.createElement("span");
  label.className = "model-mark-label";
  const prefix = document.createElement("span");
  prefix.className = "model-mark-prefix";
  prefix.textContent = t(fromText ? "模型已切换" : "切换到模型");
  label.append(prefix, document.createTextNode(" "));
  if (fromText) {
    const previous = document.createElement("bdi");
    previous.className = "model-mark-name";
    previous.textContent = fromText;
    label.append(previous, document.createTextNode(" "));
    const arrow = document.createElement("span");
    arrow.className = "model-mark-arrow";
    arrow.textContent = "→";
    label.append(arrow, document.createTextNode(" "));
  }
  const next = document.createElement("bdi");
  next.className = "model-mark-name";
  next.textContent = toText;
  label.append(next);
  mark.append(label);
  mark.setAttribute("aria-label", fromText
    ? t("模型已切换 {0} → {1}", { 0: fromText, 1: toText })
    : t("切换到模型 {0}", { 0: toText }));
}

function refreshModelSwitchLabels(): void {
  document.querySelectorAll<HTMLElement>(".model-mark").forEach(mark => {
    const to = mark.dataset.toModel;
    if (!to) return;
    renderModelMarkLabel(mark, mark.dataset.fromModel, to, mark.dataset.fromProvider, mark.dataset.toProvider);
  });
}

function appendHistoryPieces(
  fold: HTMLElement | null,
  pieces: NonNullable<HistoryViewItem["steps"]>,
  inside: boolean
): void {
  const body = fold ? workBody(fold) : null;
  for (const piece of pieces) {
    if (piece.kind === "reasoning") {
      if (body) {
        const note = appendWorkNote(fold!, piece.text);
        if (piece.partId) note.dataset.partId = piece.partId;
      }
      continue;
    }
    if (piece.kind === "goal") {
      // Desktop parity: an icon, the iteration text, then a fading rule.
      const mark = document.createElement("div");
      mark.className = "timeline-mark goal-mark" + (piece.passed ? " passed" : " failed");
      mark.innerHTML = `${GOAL_ICON}<span></span>`;
      const label = mark.querySelector("span")!;
      label.textContent = piece.iteration
        ? t(piece.passed ? "第 {0} 次迭代 · 目标已完成，任务结束" : "第 {0} 次迭代 · 目标未达成", { 0: piece.iteration })
        : t(piece.passed ? "目标已完成，任务结束" : "目标未达成");
      mark.setAttribute("aria-label", label.textContent ?? "");
      mark.dataset.goalKey = goalMarkKey(piece.passed, piece.iteration ?? 0);
      historyGoalKeys.add(mark.dataset.goalKey);
      attachMessage(mark);
      continue;
    }
    if (piece.kind === "compact") {
      // Desktop /compact reminder at the end of the turn: compressing → compressed.
      const mark = document.createElement("div");
      mark.className = "timeline-mark compact-mark" + (piece.status === "running" ? " running" : piece.status === "failed" ? " failed" : "");
      mark.innerHTML = `${COMPACT_ICON}<span></span>`;
      const label = mark.querySelector("span")!;
      label.textContent = compactStatusLabel(piece.status, piece.origin);
      mark.setAttribute("aria-label", label.textContent ?? "");
      attachMessage(mark);
      continue;
    }
    if (piece.kind === "model") {
      if (!piece.to) continue;
      const mark = document.createElement("div");
      mark.className = "timeline-mark model-mark";
      renderModelMarkLabel(mark, piece.from, piece.to, piece.fromProvider, piece.toProvider);
      attachMessage(mark);
      continue;
    }
    if (piece.kind === "text") {
      const el = startAssistantMessage();
      renderAssistantBody(el, piece.text, false);
      if (piece.partId) el.dataset.partId = piece.partId;
      currentAssistantEl = null;
      if (inside && body) body.appendChild(el);
      continue;
    }
    const id = piece.toolCallId ? `tool-${piece.toolCallId}` : "";
    let el = id ? (document.getElementById(id) as HTMLElement | null) : null;
    if (!el) {
      el = document.createElement("div");
      el.className = "tool-call";
      if (id) el.id = id;
      if (inside && body) body.appendChild(el);
      else attachMessage(el);
    }
    fillToolCallEl(el, piece);
  }
  refreshProcessGroups(body);
}

function ensureHistoryMore(show: boolean): void {
  const existing = messagesEl.querySelector<HTMLButtonElement>(".history-more");
  if (!show) {
    existing?.remove();
    return;
  }
  const button = existing ?? document.createElement("button");
  button.type = "button";
  button.className = "history-more";
  button.disabled = false;
  button.textContent = t("加载更早的消息");
  if (!existing) {
    button.addEventListener("click", () => {
      if (!oldestLoadedId || button.disabled) return;
      button.disabled = true;
      button.textContent = t("正在加载更早的消息…");
      post({ type: "loadOlder", oldestId: oldestLoadedId, sessionId: currentSessionId, viewGen, requestId: crypto.randomUUID() });
    });
    messagesEl.prepend(button);
  }
}

type HistoryRenderSource = "snapshot" | "transcript-sync" | "older";

function reportHistoryRenderTiming(
  started: number,
  syncMs: number,
  source: HistoryRenderSource,
  itemCount: number,
  previousDomRows: number,
  currentDomRows: number,
  truncated: boolean,
  mode: "full" | "append" = "full"
): void {
  const visible = document.visibilityState === "visible";
  const metrics = {
    type: "historyRenderTiming",
    historySyncMs: syncMs,
    historyItemCount: itemCount,
    historyPreviousDomRows: previousDomRows,
    historyCurrentDomRows: currentDomRows,
    historyTruncated: truncated,
    historyVisible: visible,
    historyRenderSource: source,
    historyRenderMode: mode,
  };
  if (!visible) {
    post(metrics);
    return;
  }
  // Two frames measure the render-to-paint opportunity without capturing any
  // transcript content. This is not a guarantee that pixels reached the screen.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    post({ ...metrics, historyFrameMs: performance.now() - started, historyVisible: document.visibilityState === "visible" });
  }));
}

function historyItemsEqual(left: HistoryViewItem, right: HistoryViewItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconcileAppendedQuestion(
  items: HistoryViewItem[],
  truncated: boolean,
  activeSince: number,
  started: number,
  previousDomRows: number
): boolean {
  const reject = (_reason: string) => false;
  const previous = loadedHistory;
  if (items.length !== previous.length + 1) return reject(`length-${previous.length}-${items.length}`);
  const appended = items[items.length - 1];
  if (!appended || appended.role !== "user" || !appended.id) return reject("tail");
  for (let index = 0; index < previous.length; index++) {
    if (!historyItemsEqual(previous[index], items[index])) return reject(`prefix-${index}`);
  }

  // The send path already paints an optimistic question before the backend
  // echoes its canonical row. Reconcile that bubble in place; anything without
  // an exact local match falls back to the full transcript renderer.
  const matchingQuestions = sentQuestions().filter(node =>
    node.dataset.live === "1" && sameQuery(node, appended.text, appended.attachments ?? [])
  );
  // Identical prompts can be in flight together. If the echo cannot be tied to
  // exactly one optimistic bubble, keep the canonical full-render path.
  if (matchingQuestions.length !== 1) return reject("ambiguous-live-question");
  const question = matchingQuestions[0];
  if (sentQuestions().some(node => node !== question && node.dataset.jump === appended.id)) return reject("duplicate-id");

  const meta = messageMeta(question);
  if (!meta) return reject("meta");
  question.dataset.jump = appended.id;
  delete question.dataset.live;
  if (appended.turnId) question.dataset.taskId = appended.turnId;
  else delete question.dataset.taskId;
  if (appended.rowId !== undefined) question.dataset.transcriptRow = String(appended.rowId);
  if (appended.sourceCommandId) question.dataset.sourceCommandId = appended.sourceCommandId;
  if (appended.createdAt && appended.createdAt > 0) question.dataset.sentAt = String(appended.createdAt);
  meta.dataset.anchor = appended.id;
  if (appended.createdAt && appended.createdAt > 0) meta.dataset.sentAt = String(appended.createdAt);
  ensureMessageMeta(question, { copy: !isCompactCommand(appended.text) });
  syncQuestionFoldControl(question, question.dataset.questionExpanded === "1");
  if (appended.attachments?.length) renderUserImages(question, appended.attachments, appended.attachmentTarget);

  loadedHistory = items;
  historyTruncated = truncated;
  historyActiveSince = activeSince;
  oldestLoadedId = items.find(item => item.id)?.id ?? "";
  ensureHistoryMore(truncated);
  syncQuestionRail();
  foldOldTurns();
  syncQueuedMessages();
  applyStoredConversation();
  if (!(activeSince > 0) && !tailStillRunning(items)) settleReplyFooters();
  if (isGenerating) ensureWorkingIndicator();
  const currentDomRows = messagesEl.children.length;
  reportHistoryRenderTiming(started, performance.now() - started, "transcript-sync", items.length, previousDomRows, currentDomRows, truncated, "append");
  return true;
}

// Only carry explicit choices across a redraw of the current chat. Never keep
// this map across view_reset, or use a backend turn id that changes on insertion.
function workFoldKeys(): Map<string, HTMLElement> {
  const result = new Map<string, HTMLElement>();
  let question = "";
  let index = 0;
  for (const node of messagesEl.children) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.matches(".message.user:not(.queued)")) {
      question = node.dataset.jump ?? "";
      index = 0;
    } else if (node.matches(".work-fold:not(.work-duration-only)")) {
      const part = node.querySelector<HTMLElement>("[data-part-id], .tool-call[id]");
      const owner = part?.dataset.partId ? `part:${part.dataset.partId}` : part?.id ? `tool:${part.id}`
        : question ? `question:${question}:${index}` : "";
      index++;
      if (owner) result.set(owner, node);
    }
  }
  return result;
}

function toolChoiceKeys(): Map<string, HTMLElement> {
  const result = new Map<string, HTMLElement>();
  const folds = new Map([...workFoldKeys()].map(([key, node]) => [node, key]));
  const occurrences = new Map<string, number>();
  for (const tool of messagesEl.querySelectorAll<HTMLElement>(".tool-call")) {
    if (tool.id) { result.set(`id:${tool.id}`, tool); continue; }
    // Inline builtin tools have no call id, but belong to an identified part.
    const part = tool.closest<HTMLElement>("[data-part-id]");
    const fold = tool.closest<HTMLElement>(".work-fold");
    const owner = part?.dataset.partId ? `part:${part.dataset.partId}` : fold && folds.get(fold);
    if (!owner) continue;
    const index = occurrences.get(owner) ?? 0;
    occurrences.set(owner, index + 1);
    result.set(`${owner}:${index}`, tool);
  }
  return result;
}

function reasoningChoiceKeys(): Map<string, HTMLElement> {
  const result = new Map<string, HTMLElement>();
  for (const [foldKey, fold] of workFoldKeys()) {
    let index = 0;
    for (const header of fold.querySelectorAll<HTMLElement>(".reasoning-head")) {
      const note = header.nextElementSibling as HTMLElement | null;
      const key = note?.dataset.partId ? `part:${note.dataset.partId}` : `${foldKey}:reasoning:${index}`;
      index++;
      result.set(key, header);
    }
  }
  return result;
}

function captureHistoryEditors() {
  return [...messagesEl.querySelectorAll<HTMLElement>(".message.user.editing")].map(node => ({
    node, meta: messageMeta(node), jump: node.dataset.jump, entityId: node.dataset.entityId, owner: node.dataset.sessionId,
    focused: node.contains(document.activeElement),
  }));
}

function restoreHistoryEditors(editors: ReturnType<typeof captureHistoryEditors>): void {
  for (const saved of editors) {
    if (saved.owner !== currentSessionId || !saved.jump) continue;
    const fresh = sentQuestions().find(node => node.dataset.sessionId === saved.owner && (
      node.dataset.jump === saved.jump || saved.entityId && (node.dataset.jump === saved.entityId || node.dataset.entityId === saved.entityId)));
    if (!fresh) {
      // A rewrite may actually remove the target. Keep its unsubmitted input in
      // the source chat's composer rather than attaching it to another question.
      const text = saved.node.querySelector<HTMLTextAreaElement>(".user-edit")?.value ?? "";
      recoverInput({ sessionId: saved.owner, text, attachments: editRemainingAttachments(saved.node),
        sessionRefs: parsePromptDisplay(saved.node.dataset.serverText || "").sessionRefs });
      continue;
    }
    const freshMeta = messageMeta(fresh);
    const node = saved.node;
    node.dataset.jump = fresh.dataset.jump;
    if (saved.meta) saved.meta.dataset.anchor = fresh.dataset.jump ?? "";
    node.dataset.rawText = fresh.dataset.rawText ?? "";
    node.dataset.serverText = fresh.dataset.serverText ?? fresh.dataset.rawText ?? "";
    node.dataset.retryText = fresh.dataset.retryText ?? node.dataset.serverText;
    for (const key of ["rowId", "entityId"] as const) if (fresh.dataset[key]) node.dataset[key] = fresh.dataset[key];
    fresh.replaceWith(node);
    freshMeta?.remove();
    if (saved.meta) node.after(saved.meta);
    // Reusing the actual nodes also keeps image upload callbacks and removal
    // choices attached to the same edit attempt, including FileReader work.
    if (saved.focused) node.querySelector<HTMLTextAreaElement>(".user-edit")?.focus({ preventScroll: true });
  }
}

function nextWorkQuestion(fold: HTMLElement): string {
  let node = fold.nextElementSibling;
  while (node) {
    if (node.matches(".message.user:not(.queued)")) return (node as HTMLElement).dataset.jump ?? "";
    node = node.nextElementSibling;
  }
  return "";
}

function renderHistory(
  items: HistoryViewItem[],
  truncated = false,
  questions?: Array<{ id: string; text: string; at?: number }>,
  activeSince = 0,
  renderSource: HistoryRenderSource = "snapshot"
): void {
  const renderStarted = performance.now();
  const previousDomRows = messagesEl.children.length;
  historyGoalKeys = new Set();
  const first = items.find(item => item.rowId !== undefined);
  if (truncated && first?.logEpoch && first.rowId !== undefined) {
    const prefix = loadedHistory.filter(item => item.logEpoch === first.logEpoch && item.rowId !== undefined && item.rowId < first.rowId!);
    if (prefix.length) truncated = historyTruncated;
    items = [...prefix, ...items];
  }
  const itemCount = items.length;
  if (renderSource === "transcript-sync" && reconcileAppendedQuestion(items, truncated, activeSince, renderStarted, previousDomRows)) return;
  const historyEditors = captureHistoryEditors();
  const workChoices = new Map([...workFoldKeys()].map(([key, fold]) => [key, {
    toggle: fold.dataset.userToggle,
    nextQuestion: nextWorkQuestion(fold),
  }]));
  const toolChoices = new Map([...toolChoiceKeys()].map(([key, tool]) => [key, {
    toggle: tool.dataset.userToggle, groupToggle: tool.dataset.groupToggle,
  }]));
  const reasoningChoices = new Map([...reasoningChoiceKeys()].filter(([, header]) => header.dataset.userToggle)
    .map(([key, header]) => [key, (header.nextElementSibling as HTMLElement | null)?.hidden ?? true]));
  const openTurns = new Map(sentQuestions().map(node => [node.dataset.jump, node.dataset.turnOpen]));
  const expandedQuestions = new Map<string, boolean>();
  const previousQuestionOccurrences = new Map<string, number>();
  for (const question of sentQuestions()) {
    if (question.dataset.questionExpanded === "1") {
      expandedQuestions.set(questionFoldStateKey(question, previousQuestionOccurrences), true);
    } else {
      questionFoldStateKey(question, previousQuestionOccurrences);
    }
  }
  const previousTop = messagesEl.scrollTop;
  const follow = stickToBottom;
  const liveStartAt = Number(runningWorkFold()?.dataset.startedAt) || 0;
  let liveQuestion = (runningWorkFold() ?? currentTurnFold())?.previousElementSibling;
  while (liveQuestion && !liveQuestion.matches(".message.user:not(.queued)")) liveQuestion = liveQuestion.previousElementSibling;
  const carriedWorkMs = measuredRunningWork();
  loadedHistory = items;
  historyTruncated = truncated;
  historyActiveSince = activeSince;
  // The index now arrives in its own message; a redraw without it keeps the
  // current one instead of blanking the rail until the next index lands.
  if (questions) questionIndex = indexedQuestions(questions);
  oldestLoadedId = items.find((item) => item.id)?.id ?? "";
  pendingJump = "";
  suspendScroll = true;
  const queued = queueCards();
  clearMessages();
  turnWorkStarted = 0;
  if (!items.length) {
    suspendScroll = false;
    emptyState();
    if (queued.length) { messagesEl.querySelector(".empty")?.remove(); clearGreetingTimer(); }
    for (const card of queued) attachMessage(card);
    syncQueuedMessages();
    restoreHistoryEditors(historyEditors);
    reportHistoryRenderTiming(renderStarted, performance.now() - renderStarted, renderSource, itemCount, previousDomRows, messagesEl.children.length, truncated);
    return;
  }
  renderHistoryItems(items, activeSince, carriedWorkMs, liveStartAt, liveQuestion instanceof HTMLElement ? liveQuestion : null);
  for (const [key, fold] of workFoldKeys()) {
    const previous = workChoices.get(key);
    // A newly inserted question ends the old segment; keep its default collapse.
    if (!previous?.toggle || previous.nextQuestion !== nextWorkQuestion(fold)) continue;
    fold.dataset.userToggle = previous.toggle;
    fold.classList.toggle("open", previous.toggle === "open");
    paintWorkFold(fold);
  }
  for (const [key, tool] of toolChoiceKeys()) {
    const previous = toolChoices.get(key);
    if (previous?.groupToggle) tool.dataset.groupToggle = previous.groupToggle;
    const toggle = previous?.toggle;
    if (!toggle) continue;
    tool.dataset.userToggle = toggle;
    tool.classList.toggle("collapsed", toggle !== "open");
    tool.querySelector(".tool-head")?.setAttribute("aria-expanded", String(toggle === "open"));
  }
  for (const [key, header] of reasoningChoiceKeys()) {
    const hidden = reasoningChoices.get(key);
    const note = header.nextElementSibling;
    if (hidden === undefined || !(note instanceof HTMLElement)) continue;
    header.dataset.userToggle = "1";
    note.hidden = hidden;
    header.setAttribute("aria-expanded", String(!hidden));
  }
  for (const body of messagesEl.querySelectorAll<HTMLElement>(".work-fold-body")) refreshProcessGroups(body);
  restoreHistoryEditors(historyEditors);
  const nextQuestionOccurrences = new Map<string, number>();
  for (const node of sentQuestions()) {
    const opened = openTurns.get(node.dataset.jump);
    if (opened !== undefined) node.dataset.turnOpen = opened;
    syncQuestionFoldControl(node, expandedQuestions.get(questionFoldStateKey(node, nextQuestionOccurrences)) === true);
  }
  for (const card of queued) attachMessage(card);
  syncQueuedMessages();
  suspendScroll = false;
  ensureHistoryMore(truncated);
  syncQuestionRail();
  foldOldTurns();
  applyStoredConversation();
  const covered = new Set<string>();
  for (const item of items) {
    for (const step of item.steps ?? []) {
      if (step.kind === "model" && step.to) covered.add(step.to);
    }
  }
  modelMarks = modelMarks.filter(mark => !covered.has(mark.toId));
  renderModelMarks(new Set());
  restoreGoalHistoryMarks();
  if (!(activeSince > 0) && !tailStillRunning(items)) settleReplyFooters();
  // The redraw wiped the spinner; a live turn still needs it at the tail.
  if (isGenerating) ensureWorkingIndicator();
  if (!completionRevealPending) {
    if (follow) scrollToBottom(true);
    else messagesEl.scrollTop = previousTop;
  }
  reconcileCompletedReveal();
  reportHistoryRenderTiming(renderStarted, performance.now() - renderStarted, renderSource, itemCount, previousDomRows, messagesEl.children.length, truncated);
}

function syncQueuedMessages(): void {
  for (const node of queueCards()) {
    if (node.dataset.sessionId !== currentSessionId) node.remove();
  }
  const promoted = new Set(sentQuestions().map(node => node.dataset.sourceCommandId).filter(Boolean));
  const existing = queueCards();
  for (const node of existing) {
    const source = node.dataset.sourceCommandId;
    const item = currentQueue?.find(item => item.queueItemId === node.dataset.queueId || source && item.sourceCommandId === source);
    if (promoted.has(source) || currentQueue && !item && node.dataset.queuePending !== "1") node.remove();
  }
  for (const item of currentQueue ?? []) {
    let node = queueCards()
      .find(node => node.dataset.queueId === item.queueItemId || item.sourceCommandId && node.dataset.sourceCommandId === item.sourceCommandId);
    if (!node) {
      node = addUserMessage(item.text, [], true, item.queueItemId, undefined, undefined, item.sourceCommandId, item.attachments);
    }
    node.dataset.sessionId = currentSessionId;
    node.dataset.queueId = item.queueItemId;
    node.dataset.queuePending = "0";
    node.dataset.rawText = item.text;
    node.dataset.retryText = item.text;
    node.dataset.images = JSON.stringify(item.attachments ?? []);
    renderUserImages(node, item.attachments ?? []);
    if (item.sourceCommandId) node.dataset.sourceCommandId = item.sourceCommandId;
    if (!node.querySelector(".queued-edit")) node.querySelector(".user-body")!.textContent = parsePromptDisplay(item.text).body;
    if (queuedEditDrafts.has(queuedEditKey(currentSessionId, item.queueItemId))) beginQueuedEdit(node);
    node.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; });
    paintQueuedEdit(node);
  }
  for (const item of currentQueue ?? []) {
    const node = queueCards().find(card => card.dataset.queueId === item.queueItemId);
    if (node) queueZoneEl.append(node);
  }
  queueZoneEl.hidden = !queueZoneEl.querySelector(".message.queued");
  if (currentQueue) {
    const prefix = `${currentSessionId}\0`;
    for (const [key, draft] of queuedEditDrafts) {
      if (!key.startsWith(prefix) || draft.requestId || currentQueue.some(item => key === queuedEditKey(currentSessionId, item.queueItemId))) continue;
      queuedEditDrafts.delete(key);
      recoverInput({ sessionId: currentSessionId, text: draft.text });
    }
  }
  syncQuestionRail();
}

function prependHistory(items: HistoryViewItem[], more: boolean): void {
  if (!items.length) {
    historyTruncated = more;
    ensureHistoryMore(more);
    return;
  }
  const previousTop = messagesEl.scrollTop;
  const previousHeight = messagesEl.scrollHeight;
  // Render joined pages together: an assistant continuation at the old
  // page boundary must not become a second, unrelated work block.
  const known = new Set(loadedHistory.map(item => item.id).filter(Boolean));
  const earlier = items.filter(item => !item.id || !known.has(item.id));
  const joined = [...earlier, ...loadedHistory];
  loadedHistory = [];
  renderHistory(joined, more, questionIndex, historyActiveSince, "older");
  messagesEl.scrollTop = previousTop + (messagesEl.scrollHeight - previousHeight);
  syncQuestionRail();
  applyStoredConversation();
}

function chipKey(chip: ContextChip): string {
  return `${chip.path}:${chip.selectionStart ?? 0}-${chip.selectionEnd ?? 0}:${chip.implicit ? "i" : "e"}`;
}

function renderComposerChips(): void {
  attachmentsEl.innerHTML = "";
  editorChipRow.innerHTML = "";
  for (const chip of explicitChips) attachmentsEl.appendChild(makeChipEl(chip, true));
  for (const reference of explicitSessionRefs) attachmentsEl.appendChild(makeSessionReferenceEl(reference, true));
}

const SESSION_REF_ICON = '<svg class="session-ref-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 2v-2H3A1.5 1.5 0 0 1 1.5 10V5A1.5 1.5 0 0 1 3 3.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>';

function makeSessionReferenceEl(reference: SessionReference, removable: boolean): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "ctx-chip session-ref-chip";
  chip.title = reference.title;
  chip.setAttribute("aria-label", `${t("会话引用")} · ${reference.title}`);
  chip.innerHTML = `${SESSION_REF_ICON}<span>${escapeText(reference.title)}</span>`;
  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = t("移除会话引用");
    remove.setAttribute("aria-label", `${t("移除会话引用")} · ${reference.title}`);
    remove.addEventListener("click", () => {
      explicitSessionRefs = explicitSessionRefs.filter(item => item.sessionId !== reference.sessionId);
      renderComposerChips();
      persistComposerDraft();
    });
    chip.append(remove);
  }
  return chip;
}



function makeChipEl(chip: ContextChip, removable: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className =
    "ctx-chip" +
    (chip.implicit ? " implicit" : "") +
    (chip.hidden ? " hidden" : "");
  const title = (dirty:boolean) => `${chip.path}\n${chip.selectionStart && chip.selectionEnd ? `${t("选中片段")} · L${chip.selectionStart}–L${chip.selectionEnd} · ${t("添加时的快照")}` : t("整个文件")}
${dirty ? t("包含未保存修改") : chip.selectionStart ? "" : t("引用已保存内容")}`.trim();
  el.title=title(chip.sourceDirty ?? chip.snapshot !== undefined); el.setAttribute("aria-label",el.title);
  if (!chip.selectionStart) el.addEventListener("mouseenter", () => {
    const requestId=crypto.randomUUID(); el.dataset.detailRequest=requestId;
    el.dataset.referencePath=chip.path;
    post({type:"fileReferenceDetails",path:chip.path,sessionId:draftSessionId,requestId});
  });
  el.innerHTML = `<span>${escapeText(chipLabel(chip))}</span>`;
  if (removable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "×";
    btn.title = t("移除");
    btn.addEventListener("click", () => {
      explicitChips = explicitChips.filter((c) => chipKey(c) !== chipKey(chip));
      renderComposerChips();
      persistComposerDraft();
    });
    el.appendChild(btn);
  }
  return el;
}

function addExplicitChip(chip: ContextChip): void {
  const next = { ...chip, implicit: false };
  explicitChips = explicitChips.filter((c) => chipKey(c) !== chipKey(next));
  explicitChips.push(next);
  renderComposerChips();
  persistComposerDraft();
}

function addExplicitSessionReference(reference: SessionReference): void {
  if (sessions.some(session => session.sessionId === reference.sessionId && !session.archivedAt)) {
    explicitSessionRefs = explicitSessionRefs.filter(item => item.sessionId !== reference.sessionId);
    explicitSessionRefs.push({ sessionId: reference.sessionId, title: reference.title });
    renderComposerChips();
    persistComposerDraft();
  }
}

function activeChips(): ContextChip[] { return [...explicitChips]; }

function sendMessage(immediate = false): void {
  if (holdStreams || !sessionConnected) return;
  mentions.close();
  const body = input.value.trim();
  const planShortcut = activeCommand === "plan";
  if (planShortcut && (imageDrafts.length || explicitChips.length || explicitSessionRefs.length)) {
    showToast(t("Plan 命令暂不支持图片或上下文引用，请先移除后重试。"));
    return;
  }
  if (planShortcut && !body) {
    planEnabled = true;
    applySessionControls({ mode: "plan", baseMode, planEnabled: true, thoughtEnabled, thoughtLevel: currentThought, thoughtLevels });
    clearActiveCommand();
    post({ type: "setMode", mode: "plan", sessionId: draftSessionId, viewGen });
    persistComposerDraft();
    return;
  }
  // Most active commands keep their slash prefix; /plan is a composer mode
  // shortcut and sends only its task body after the host switches the session.
  const text = planShortcut ? body : activeCommand ? `/${activeCommand} ${body}`.trim() + (body ? "" : " ") : body;
  if (!text.trim() && !imageDrafts.length) return;
  if (imageDrafts.length > IMAGE_MAX_COUNT) { showToast(t("最多添加 8 张图片。")); return; }
  if (imageDrafts.some(image => image.status !== "ready")) { showToast(t("请等待图片添加完成，或移除失败的图片。")); return; }
  const images = imageDrafts.map(image => ({ ...image }));
  const attachments = readImageAttachments(images);
  const chips = activeChips();
  const refs = explicitSessionRefs.map(reference => ({ ...reference }));
  const commandId = crypto.randomUUID();
  const recoveryText = planShortcut ? `/plan ${body}` : text;
  pendingInputs.set(commandId, { sessionId: draftSessionId, draft: { text: recoveryText, chips: explicitChips.map(chip => ({ ...chip })), sessionRefs: refs, images } });
  if (planShortcut) {
    planEnabled = true;
    applySessionControls({ mode: "plan", baseMode, planEnabled: true, thoughtEnabled, thoughtLevel: currentThought, thoughtLevels });
  }
  input.value = "";
  clearActiveCommand();
  explicitChips = [];
  explicitSessionRefs = [];
  renderComposerChips();
  imageDrafts = [];
  renderImageDrafts();
  persistComposerDraft();
  resizeComposerInput();
  if (isGenerating) {
    const queueItemId = commandId;
    const node = addUserMessage(text, chips, !immediate, queueItemId, undefined, undefined, queueItemId, attachments, undefined, immediate, refs);
    if (!immediate) {
      node.dataset.queuePending = "1";
      node.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
    }
    post({ type: "insert", text, chips, sessionRefs: refs, attachments, immediate, queueItemId, sessionId: draftSessionId, ...(planShortcut ? { planMode: true, recoveryText } : {}) });
    showToast(immediate ? t("已立即发送") : t("已排队，当前回复结束后发送"));
    updateComposerActions();
    return;
  }
  addUserMessage(text, chips, false, undefined, undefined, undefined, undefined, attachments, undefined, true, refs);
  setGenerating(true);
  if (!isCompactCommand(text)) {
    ensureTurnWorkFold();
    scrollToBottom(true);
  }
  post({ type: "send", text, chips, sessionRefs: refs, attachments, commandId, sessionId: draftSessionId, sentAt: Date.now(), ...(planShortcut ? { planMode: true, recoveryText } : {}) });
}

// Two animation frames acknowledge a paint opportunity after updating the DOM,
// not the time the remote desktop actually displays the pixels.
function acknowledgeFirstOutput(msg: { timingId?: string; sessionId?: string }): void {
  if (!msg.timingId || msg.sessionId !== currentSessionId) return;
  const owner = currentSessionId;
  const generation = viewGen;
  const started = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (owner !== currentSessionId || generation !== viewGen) return;
    post({ type: "responsePainted", sessionId: owner, timingId: msg.timingId, frameWaitMs: performance.now() - started });
  }));
}

function requestStop(): void {
  if (!isGenerating || holdStreams || stopBtn.disabled) return;
  post({ type: "stop", sessionId: currentSessionId });
  noteActivity("stopping");
  updateComposerActions();
}
sendBtn.addEventListener("click", () => {
  if (isGenerating && !composerHasText()) requestStop();
  else sendMessage(false);
});
stopBtn.addEventListener("click", requestStop);
insertNowBtn.addEventListener("click", () => sendMessage(true));

messagesEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLAnchorElement>(".md a[href]");
  if (link && messagesEl.contains(link)) {
    const href = link.getAttribute("href") || "";
    // Local Markdown links need the extension host: the webview cannot navigate
    // to a workspace file, and its CSP intentionally disallows file images.
    const local = localMarkdownFileLink(href);
    if (local) {
      event.preventDefault();
      post({ type: "openMarkdownFile", ...local, sessionId: draftSessionId });
      return;
    }
  }
  if (target.closest("button, a, input, textarea")) return;
  const block = target.closest<HTMLElement>(".turn-folded, .turn-collapsed");
  if (!block || !messagesEl.contains(block)) return;
  expandTurn(block);
});
messagesEl.addEventListener("pointerdown", releaseCompletedReveal, {capture:true});
document.addEventListener("keydown", (event) => {
  if (!completionRevealPending || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
  const target = event.target;
  if (target === document.body || target === document.documentElement ||
      (target instanceof Node && messagesEl.contains(target))) releaseCompletedReveal();
}, { capture: true });
messagesEl.addEventListener("scroll", () => {
  if (completionRevealPending) {
    // Browser anchoring and delayed layout can emit another scroll after the
    // initial reveal. Keep the completed question pinned, and never let that
    // programmatic adjustment re-arm follow-to-bottom. Direct user gestures
    // clear the pin in the wheel/pointer handlers below.
    stickToBottom = !completionRevealJump;
    updateJumpLatest();
    updateQuestionRailActive();
    return;
  }
  if (ignoreScroll) return;
  stickToBottom = isNearBottom();
  updateJumpLatest();
  updateQuestionRailActive();
});
messagesEl.addEventListener(
  "wheel",
  (event) => {
    // A user's upward gesture takes precedence even if an automatic scroll's
    // frame callback has not run yet (including a completion in the same frame).
    if (event.deltaY !== 0) releaseCompletedReveal();
    if (event.deltaY < 0) {
      stickToBottom = false;
      resumeOuterFollow = false;
      updateJumpLatest();
    }
    const viewport = event.target instanceof Element ? event.target.closest<HTMLElement>(".work-fold-body") : null;
    requestAnimationFrame(() => {
      if (viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 24) resumeWorkFollow = false;
      if (ignoreScroll) return;
      stickToBottom = isNearBottom();
      if (!stickToBottom) resumeOuterFollow = false;
      updateJumpLatest();
    });
  },
  { passive: true }
);
document.getElementById("jump-latest")?.addEventListener("click", () => {
  releaseCompletedReveal();
  scrollToBottom(true);
});

questionTrack.addEventListener(
  "wheel",
  (event) => {
    if (questionTrack.scrollWidth <= questionTrack.clientWidth + 2) return;
    let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (event.deltaMode === 1) delta *= 48;
    else if (event.deltaMode === 2) delta *= questionTrack.clientWidth * 0.85;
    else if (Math.abs(delta) >= 40) delta = Math.sign(delta) * Math.max(Math.abs(delta), 108);
    questionTrack.scrollLeft += delta;
    event.preventDefault();
  },
  { passive: false }
);
questionTrack.addEventListener("scroll", () => {
  hideQuestionPreview();
});
questionTrack.addEventListener("pointerover", (event) => syncQuestionPreview(event.target));
questionRail.addEventListener("pointerleave", () => hideQuestionPreview());
document.documentElement.addEventListener("pointerleave", () => hideQuestionPreview());
window.addEventListener("blur", () => hideQuestionPreview());
window.addEventListener("pointermove", (event) => {
  if (questionPreview.hidden && !questionRail.matches(":hover")) return;
  syncQuestionPreview(event.target);
});
function toggleUsagePanel(): void {
  if (!usagePanelEnabled()) return;
  usagePanelOpen = !usagePanelOpen;
  vscode.setState({ ...(vscode.getState() ?? {}), usagePanelOpen });
  applyUsageVisibility();
}
contextMeter.addEventListener("click", toggleUsagePanel);
railToggle.addEventListener("click", () => {
  rememberRailOpen(!questionRailOpen);
  applyQuestionRailVisibility();
  if (!questionRail.hidden) {
    updateQuestionRailOverflow();
    updateQuestionRailActive();
  }
});
collapseAllTurnsButton.addEventListener("click", toggleAllTurns);
questionTrack.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  questionDrag = { x: event.clientX, left: questionTrack.scrollLeft, moved: false };
});
questionTrack.addEventListener("pointermove", (event) => {
  if (!questionDrag) return;
  const dx = event.clientX - questionDrag.x;
  if (!questionDrag.moved && Math.abs(dx) <= 4) return;
  if (!questionDrag.moved) {
    questionDrag.moved = true;
    questionTrack.setPointerCapture(event.pointerId);
    hideQuestionPreview();
  }
  questionTrack.scrollLeft = questionDrag.left - dx;
});
questionTrack.addEventListener("pointerup", (event) => {
  const drag = questionDrag;
  questionDrag = null;
  if (!drag || drag.moved) return;
  const target = event.target;
  const dot = target instanceof Element ? target.closest<HTMLButtonElement>(".q-dot") : null;
  if (!dot?.dataset.jump) return;
  hideQuestionPreview();
  jumpToQuestion(dot.dataset.jump);
});
questionTrack.addEventListener("pointercancel", () => {
  questionDrag = null;
});

function fileUri(fsPath: string): string {
  const slash = fsPath.replace(/\\/g, "/");
  const absolute = slash.startsWith("/") ? slash : `/${slash}`;
  return `file://${absolute.split("/").map(encodeURIComponent).join("/")}`;
}
const mentions = fileMentions(input, document.getElementById("composer")!, () => draftSessionId,
  (requestId,text,sessionId) => post({type:"searchWorkspaceFiles",requestId,text,sessionId}),
  () => sessions.filter(session => !session.archivedAt).map(({ sessionId, title }) => ({ sessionId, title })),
  (choice: MentionChoice,sessionId) => {
    if (sessionId !== draftSessionId || holdStreams) return;
    if (choice.kind === "session") {
      addExplicitSessionReference(choice.session);
      return;
    }
    const file = choice.file;
    if (/\.(png|jpe?g|webp|gif)$/i.test(file.path)) {
      post({ type: "attachFileUris", sessionId, uris: [fileUri(file.path)], maxImages: Math.max(0, IMAGE_MAX_COUNT - imageDrafts.length) });
      return;
    }
    addExplicitChip(file);
  });

let slashCommands: Array<{ name: string; description: string; inputHint: string }> = [];
/** Goal state from the v4 stream: drives the status strip and iteration markers. */
type WebviewGoal = { objective: string; status: string; iteration: number; timeUsedSeconds: number; activeRunStartedAtMs?: number | null; localTickFrom?: number; verifications: Array<{ anchorTurnId?: string; anchorRowId?: number; iteration: number; passed: boolean }> };
type GoalVerification = WebviewGoal["verifications"][number];
type GoalAnchor = { turnId: string; jump: string; text: string };
let goalState: WebviewGoal | null = null;
let goalVerificationsShown = 0;
let goalAnchors: Array<GoalAnchor | undefined> = [];
let goalTicker = 0;

function buildGoalMark(passed: boolean, iteration: number): HTMLElement {
  const mark = document.createElement("div");
  mark.className = "timeline-mark goal-mark" + (passed ? " passed" : " failed");
  mark.innerHTML = `${GOAL_ICON}<span></span>`;
  const label = mark.querySelector("span")!;
  label.textContent = iteration > 0
    ? t(passed ? "第 {0} 次迭代 · 目标已完成，任务结束" : "第 {0} 次迭代 · 目标未达成", { 0: iteration })
    : t(passed ? "目标已完成，任务结束" : "目标未达成");
  mark.setAttribute("aria-label", label.textContent ?? "");
  return mark;
}

const GOAL_STATUS_KEYS: Record<string, string> = {
  active: "正在追求目标",
  verifying: "正在校验目标",
  verified: "目标已达成",
  notSatisfied: "目标未达成",
  failed: "目标未达成",
  paused: "目标已暂停",
};

function goalElapsedSeconds(goal: WebviewGoal): number {
  const base = goal.timeUsedSeconds > 0 ? goal.timeUsedSeconds : 0;
  const running = goal.status === "active" || goal.status === "verifying";
  const started = running ? goal.activeRunStartedAtMs || goal.localTickFrom : 0;
  if (!started) return base;
  return base + Math.max(0, Math.floor((Date.now() - started) / 1000));
}

function formatGoalElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function renderGoalStrip(): void {
  const strip = document.getElementById("goal-strip");
  if (!strip) return;
  if (!goalState) {
    strip.hidden = true;
    strip.classList.remove("expanded");
    return;
  }
  strip.hidden = false;
  strip.querySelector(".goal-strip-icon")!.innerHTML = GOAL_ICON;
  const statusWord = strip.querySelector<HTMLElement>("#goal-status-text")!;
  statusWord.textContent = t(GOAL_STATUS_KEYS[goalState.status] ?? "正在追求目标");
  const objective = strip.querySelector<HTMLElement>("#goal-objective")!;
  objective.textContent = goalState.objective;
  objective.title = goalState.objective;
  const seconds = goalElapsedSeconds(goalState);
  strip.querySelector("#goal-timer")!.textContent = `· ${formatGoalElapsed(seconds)}`;
  const pause = strip.querySelector<HTMLButtonElement>("#goal-pause");
  if (pause) {
    const paused = goalState.status === "paused";
    pause.disabled = goalState.status !== "active" && goalState.status !== "verifying" && !paused;
    pause.setAttribute("aria-label", t(paused ? "继续目标" : "暂停目标"));
    pause.innerHTML = paused
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>';
  }
}

function ensureGoalTicker(): void {
  const running = !!goalState && (goalState.status === "active" || goalState.status === "verifying");
  if (!running || goalTicker) {
    if (!running && goalTicker) { window.clearInterval(goalTicker); goalTicker = 0; }
    return;
  }
  goalTicker = window.setInterval(() => { if (goalState) renderGoalStrip(); }, 1000);
}

function sendGoalAction(action: "clear" | "pause" | "resume"): void {
  if (holdStreams) return;
  const text = `/goal ${action}`;
  const commandId = crypto.randomUUID();
  // Strip actions are not drafts. A rejection must not paste `/goal clear` back
  // into the composer or treat the running reply as a failed send.
  if (isGenerating) {
    post({ type: "insert", text, chips: [], attachments: [], immediate: true, queueItemId: commandId, sessionId: draftSessionId, keepDraft: false });
    return;
  }
  post({ type: "send", text, chips: [], attachments: [], commandId, sessionId: draftSessionId, keepDraft: false });
}

function applyGoalState(goal: unknown): void {
  const next = goal && typeof goal === "object"
    ? { ...(goal as WebviewGoal) }
    : null;
  if (next && !Array.isArray(next.verifications)) next.verifications = [];
  const changed = JSON.stringify(next) !== JSON.stringify(goalState);
  const running = !!next && (next.status === "active" || next.status === "verifying");
  if (next && running && !next.activeRunStartedAtMs) {
    const sameRun = !!goalState && goalState.objective === next.objective && goalState.status === next.status
      && goalState.timeUsedSeconds === next.timeUsedSeconds && goalState.localTickFrom;
    next.localTickFrom = sameRun ? goalState!.localTickFrom : Date.now();
  }
  const previousObjective = goalState?.objective;
  goalState = next && next.objective ? next : null;
  if (!goalState || (previousObjective && goalState.objective !== previousObjective)) {
    document.querySelectorAll(".goal-mark[data-live-mark]").forEach(mark => mark.remove());
    goalVerificationsShown = 0;
    goalAnchors = [];
  }
  renderGoalStrip();
  ensureGoalTicker();
  if (changed && goalState) appendGoalVerificationMarks();
}

function goalUserBubbles(): HTMLElement[] {
  return [...messagesEl.querySelectorAll<HTMLElement>(".message.user:not(.queued)")];
}

/** The sentence sits after the question it closed, and before the next one. */
function insertGoalMarkAfterTurn(anchor: HTMLElement, mark: HTMLElement): void {
  let node: Element | null = anchor.nextElementSibling;
  let last: Element = anchor;
  while (node) {
    if (node instanceof HTMLElement && node.classList.contains("message") && node.classList.contains("user") && !node.classList.contains("queued")) break;
    last = node;
    node = node.nextElementSibling;
  }
  last.after(mark);
}

function goalBubbleByRow(anchorRowId: number): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestRow = -Infinity;
  for (const bubble of goalUserBubbles()) {
    const row = Number(bubble.dataset.transcriptRow);
    if (!Number.isFinite(row) || row > anchorRowId || row < bestRow) continue;
    best = bubble;
    bestRow = row;
  }
  return best;
}

function resolveGoalAnchor(entry: GoalVerification, index: number): HTMLElement | undefined {
  const bubbles = goalUserBubbles();
  if (entry.anchorTurnId) {
    const match = bubbles.find(bubble => bubble.dataset.taskId === entry.anchorTurnId);
    if (match) return match;
  }
  if (typeof entry.anchorRowId === "number") {
    const match = goalBubbleByRow(entry.anchorRowId);
    if (match) return match;
  }
  const remembered = goalAnchors[index];
  if (!remembered) return undefined;
  const match = bubbles.find(bubble => remembered.turnId && bubble.dataset.taskId === remembered.turnId)
    ?? bubbles.find(bubble => remembered.jump && bubble.dataset.jump === remembered.jump)
    ?? bubbles.find(bubble => remembered.text && bubble.dataset.rawText === remembered.text);
  if (match && !remembered.turnId && match.dataset.taskId) remembered.turnId = match.dataset.taskId;
  return match;
}

/** A check that finished above the loaded page stays at the top of this page. */
function placeGoalMarkAboveWindow(entry: GoalVerification, mark: HTMLElement): boolean {
  if (typeof entry.anchorRowId !== "number") return false;
  const rows = goalUserBubbles().map(bubble => Number(bubble.dataset.transcriptRow)).filter(row => Number.isFinite(row));
  if (!rows.length || Math.min(...rows) <= entry.anchorRowId) return false;
  const more = messagesEl.querySelector(".history-more");
  if (more) more.after(mark);
  else messagesEl.prepend(mark);
  return true;
}

function placeGoalMark(entry: GoalVerification, index: number, captureTail: boolean): void {
  if (historyGoalKeys.has(goalMarkKey(entry.passed, entry.iteration))) return;
  document.querySelector(".empty")?.remove();
  const mark = buildGoalMark(entry.passed, entry.iteration);
  mark.dataset.liveMark = "1";
  const bubbles = goalUserBubbles();
  const anchor = resolveGoalAnchor(entry, index);
  if (anchor) {
    insertGoalMarkAfterTurn(anchor, mark);
    return;
  }
  if (placeGoalMarkAboveWindow(entry, mark)) return;
  if (captureTail && bubbles.length) {
    const tail = bubbles.at(-1)!;
    goalAnchors[index] = { turnId: tail.dataset.taskId ?? "", jump: tail.dataset.jump ?? "", text: tail.dataset.rawText ?? "" };
    insertGoalMarkAfterTurn(tail, mark);
    return;
  }
  if (!bubbles.length) attachMessage(mark);
}

/** New verifications arrived live: keep the sentence on the turn that just finished. */
function appendGoalVerificationMarks(): void {
  if (!goalState) return;
  const list = goalState.verifications;
  for (let index = goalVerificationsShown; index < list.length; index++) {
    placeGoalMark(list[index], index, true);
  }
  goalVerificationsShown = list.length;
}

function restoreGoalHistoryMarks(): void {
  if (!goalState?.verifications.length) return;
  for (let index = 0; index < goalState.verifications.length; index++) {
    placeGoalMark(goalState.verifications[index], index, false);
  }
  goalVerificationsShown = goalState.verifications.length;
}
/** Active composer command (e.g. "goal"): shown as a toolbar chip, sent as a /prefix. */
let activeCommand: string | undefined;
function composerPlaceholder(): string {
  return t("向 ZCode 提问，@ 添加上下文，/ 选择能力");
}
/** Live model-switch separators kept until the transcript's own timeline part covers them. */
let modelMarks: Array<{ fromText?: string; toText: string; toId: string; anchorJump: string; anchorText: string }> = [];

function renderModelMarks(covered: Set<string>): void {
  document.querySelectorAll(".model-mark[data-live-mark]").forEach(mark => mark.remove());
  for (const mark of modelMarks) {
    if (covered.has(mark.toId)) continue;
    const el = document.createElement("div");
    el.className = "timeline-mark model-mark";
    el.dataset.liveMark = "1";
    renderModelMarkLabel(el, mark.fromText, mark.toText);
    // The banner stays with the question it was captured for. Redraws swap the
    // optimistic local id (q123) for the server id, so fall back to the
    // question text and migrate the anchor instead of trailing the newest.
    const bubbles = [...messagesEl.querySelectorAll<HTMLElement>(".message.user:not(.queued)")];
    let anchor: HTMLElement | undefined = mark.anchorJump
      ? bubbles.find(node => node.dataset.jump === mark.anchorJump)
      : undefined;
    if (!anchor && mark.anchorText) {
      anchor = bubbles.find(node => node.dataset.rawText === mark.anchorText);
      if (anchor) mark.anchorJump = anchor.dataset.jump ?? "";
    }
    anchor ??= bubbles.at(-1);
    if (anchor) anchor.before(el);
    else attachMessage(el);
  }
}
let slashIndex = 0;

/** A leading /command renders as an inline icon+name badge followed by the
 *  body on the same line; editing keeps the full "/command body" text. */
function splitCommandBody(body: string): { badge: string; rest: string } | undefined {
  const match = /^\s*\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s|\n)([\s\S]*)$/.exec(body);
  if (!match) return undefined;
  const name = match[1];
  const icon = COMMAND_ICONS[name] ?? COMMAND_ICON;
  const badge = `<span class="cmd-chip inline">${icon}<span>${escapeText(name.charAt(0).toUpperCase() + name.slice(1))}</span></span>`;
  return { badge, rest: match[2] };
}

function slashMatches(): typeof slashCommands {
  // The menu covers command-name completion only; once parameters begin the
  // input stops matching and the menu closes. A bare "/" still opens it.
  const match = /^\/([a-zA-Z][a-zA-Z0-9_-]*)?$/.exec(input.value.trim());
  if (!match) return [];
  const query = (match[1] ?? "").toLowerCase();
  return slashCommands.filter(command => command.name.toLowerCase().startsWith(query));
}

function closeSlashMenu(): void {
  slashIndex = 0;
  document.getElementById("slash-menu")?.classList.remove("open");
}

function renderSlashMenu(): void {
  const menu = document.getElementById("slash-menu");
  if (!menu) return;
  const items = slashMatches();
  if (!items.length || document.activeElement !== input) {
    closeSlashMenu();
    return;
  }
  slashIndex = Math.min(Math.max(slashIndex, 0), items.length - 1);
  menu.replaceChildren();
  items.forEach((command, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "slash-item" + (index === slashIndex ? " active" : "");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === slashIndex));
    const icon = document.createElement("span");
    icon.className = "slash-icon";
    icon.innerHTML = COMMAND_ICONS[command.name] ?? COMMAND_ICON;
    const name = document.createElement("span");
    name.className = "slash-name"; name.textContent = `/${command.name}`;
    const hint = document.createElement("span");
    hint.className = "slash-hint"; hint.textContent = command.inputHint;
    const desc = document.createElement("span");
    desc.className = "slash-desc"; desc.textContent = commandDescription(command);
    item.append(icon, name, hint, desc);
    // pointerdown keeps the composer focus so the draft state stays intact.
    item.addEventListener("pointerdown", event => { event.preventDefault(); applySlashCommand(command); });
    menu.appendChild(item);
  });
  menu.classList.add("open");
}

/** Picking a command clears the composer: the body typed next is the parameter,
 *  sent with a /name prefix. The chip lives in the toolbar, like the desktop. */
function applySlashCommand(command: { name: string }): void {
  activateCommand(command.name);
}

function activateCommand(name: string): void {
  activeCommand = name;
  input.value = "";
  closeSlashMenu();
  const entry = slashCommands.find(item => item.name === name);
  input.placeholder = entry ? commandDescription(entry) : composerPlaceholder();
  updateActiveCommandChip();
  updateComposerActions();
  input.focus();
}

/** Builtin descriptions arrive in English; localize the known ones. */
function commandDescription(entry: { name: string; description: string }): string {
  return t(entry.description);
}

function clearActiveCommand(): void {
  activeCommand = undefined;
  input.placeholder = composerPlaceholder();
  updateActiveCommandChip();
  updateComposerActions();
}

/** Title updates for elements that may be showing the custom card: route
 *  them to the card instead of the native attribute, which would pop the
 *  browser tooltip next to the card. */
function setTitled(el: HTMLElement, title: string): void {
  if (tooltipSource === el) {
    el.dataset.tipBackup = title;
    if (tooltipEl.classList.contains("show")) showTooltipFor(el);
    return;
  }
  el.title = title;
}

function updateActiveCommandChip(): void {
  const chip = document.getElementById("active-command");
  if (!chip) return;
  // /plan and the permission menu share the plan chip. A pending /plan must
  // not grow a second command chip beside it.
  if (!activeCommand || activeCommand === "plan") {
    chip.hidden = true;
    chip.replaceChildren();
    updatePlanChip();
    return;
  }
  // On hover the command glyph flips to an X so the click-to-cancel affordance
  // is discoverable, the way close buttons usually look.
  chip.innerHTML = `<span class="chip-icon">${COMMAND_ICONS[activeCommand] ?? COMMAND_ICON}</span><span class="chip-close">${CLOSE}</span><span>${escapeText(activeCommand.charAt(0).toUpperCase() + activeCommand.slice(1))}</span>`;
  chip.title = t("取消 {0}", { 0: `/${activeCommand}` });
  chip.hidden = false;
  updatePlanChip();
}

/** Permission-menu plan and /plan are one chip: lightbulb, the word plan, and the same hover X. */
function updatePlanChip(): void {
  const show = planEnabled || activeCommand === "plan";
  if (!show) {
    planIndicator.hidden = true;
    planIndicator.replaceChildren();
    return;
  }
  planIndicator.innerHTML = `<span class="chip-icon">${PLAN_ICON}</span><span class="chip-close">${CLOSE}</span><span>plan</span>`;
  planIndicator.title = t("取消 {0}", { 0: "/plan" });
  planIndicator.setAttribute("aria-label", planIndicator.title);
  planIndicator.hidden = false;
}

function dismissPlanChip(): void {
  if (activeCommand === "plan") clearActiveCommand();
  if (!planEnabled) return;
  const next = baseMode && baseMode !== "plan" ? baseMode : "build";
  applySessionControls({
    mode: next,
    baseMode: next,
    planEnabled: false,
    thoughtEnabled,
    thoughtLevel: currentThought,
    thoughtLevels,
  });
  post({ type: "setMode", mode: next, sessionId: currentSessionId, viewGen });
}

/** When the typed name is followed by a space, activate it and clear the box. */
function maybeActivateTypedCommand(): void {
  if (activeCommand) return;
  const match = /^\/([a-zA-Z][a-zA-Z0-9_-]*)\s$/.exec(input.value);
  if (!match) return;
  const name = match[1].toLowerCase();
  if (!slashCommands.some(item => item.name.toLowerCase() === name)) return;
  activateCommand(name);
}

input.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const menu = document.getElementById("slash-menu");
  const open = menu?.classList.contains("open") ?? false;
  if (open) {
    const items = slashMatches();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      slashIndex = e.key === "ArrowDown"
        ? Math.min(slashIndex + 1, items.length - 1)
        : Math.max(slashIndex - 1, 0);
      renderSlashMenu();
      return;
    }
    if ((e.key === "Tab" || e.key === "Enter") && items[slashIndex]) {
      e.preventDefault();
      applySlashCommand(items[slashIndex]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSlashMenu();
      return;
    }
  }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && isGenerating) {
    e.preventDefault();
    sendMessage(true);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(false);
  }
});

input.addEventListener("input", () => {
  resizeComposerInput();
  maybeActivateTypedCommand();
  updateComposerActions();
  persistComposerDraft();
  renderSlashMenu();
});

document.getElementById("goal-clear")?.addEventListener("click", () => sendGoalAction("clear"));
document.getElementById("goal-pause")?.addEventListener("click", () => sendGoalAction(goalState?.status === "paused" ? "resume" : "pause"));
document.getElementById("goal-expand")?.addEventListener("click", () => {
  const strip = document.getElementById("goal-strip");
  const button = document.getElementById("goal-expand");
  if (!strip || !button) return;
  const open = !strip.classList.contains("expanded");
  strip.classList.toggle("expanded", open);
  button.setAttribute("aria-expanded", String(open));
});

const activeCommandChipEl = document.getElementById("active-command");
activeCommandChipEl?.addEventListener("click", () => {
  clearActiveCommand();
  input.focus();
});
planIndicator.addEventListener("click", () => {
  dismissPlanChip();
  input.focus();
});

input.addEventListener("blur", closeSlashMenu);
input.addEventListener("focus", renderSlashMenu);

titleEl.addEventListener("focus", () => beginTitleEdit());
titleEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    finishTitleEdit(true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    finishTitleEdit(false);
  }
});
titleEl.addEventListener("blur", () => {
  if (editingTitle) finishTitleEdit(true);
});
const settingsButton = document.getElementById("btn-settings") as HTMLButtonElement;
const settingsMenu = document.getElementById("settings-menu")!;
const languageSelect = document.getElementById("ui-language") as HTMLSelectElement;
const defaultSessionModelSelect = document.getElementById("default-session-model") as HTMLSelectElement;
const defaultSessionModeSelect = document.getElementById("default-session-mode") as HTMLSelectElement;
const defaultSessionThoughtSelect = document.getElementById("default-session-thought") as HTMLSelectElement;
const newSessionThoughtHelp = document.getElementById("new-session-thought-help")!;

function sessionModelKey(model: SessionModelChoice): string {
  return `${encodeURIComponent(model.providerId)}::${encodeURIComponent(model.modelId)}`;
}

function settingsThoughtChoices(): ThoughtOption[] {
  if (newSessionDefaults.model && sameSessionModel(newSessionDefaults.model, currentSessionModel)) {
    return sessionThoughtOptions;
  }
  return ["off", "low", "medium", "high", "xhigh", "max"].map(value => ({ value, label: thoughtLabel(value) }));
}

function renderNewSessionSettings(): void {
  if (!defaultSessionModelSelect) return;
  const modelValue = newSessionDefaults.model ? sessionModelKey(newSessionDefaults.model) : "desktop";
  const modelOptions = [...defaultModelChoices];
  if (newSessionDefaults.model && !modelOptions.some(model => sessionModelKey(model) === modelValue)) {
    modelOptions.push({
      ...newSessionDefaults.model,
      label: `${newSessionDefaults.model.providerId} · ${newSessionDefaults.model.modelId}`,
      providerName: newSessionDefaults.model.providerId,
      disabledReason: t("此模型当前不可用"),
    });
  }
  defaultSessionModelSelect.replaceChildren(new Option(t("跟随 ZCode 默认"), "desktop"));
  for (const model of modelOptions) {
    const label = `${providerGroup(model)} · ${model.modelId}`;
    const option = new Option(label, sessionModelKey(model));
    option.disabled = !!model.disabledReason || model.hasKey === false;
    defaultSessionModelSelect.add(option);
  }
  defaultSessionModelSelect.value = modelValue;

  const modeValue = newSessionDefaults.mode ?? "desktop";
  defaultSessionModeSelect.value = modeValue;

  const thoughtChoices = settingsThoughtChoices();
  defaultSessionThoughtSelect.replaceChildren(new Option(t("跟随模型默认"), "desktop"));
  let hasSavedThought = false;
  for (const level of thoughtChoices) {
    const option = new Option(thoughtLabel(level.value, level.label), level.value);
    if (level.description) option.title = level.description;
    defaultSessionThoughtSelect.add(option);
    if (level.value === newSessionDefaults.thoughtLevel) hasSavedThought = true;
  }
  if (newSessionDefaults.thoughtLevel && !hasSavedThought) {
    const option = new Option(`${thoughtLabel(newSessionDefaults.thoughtLevel)} · ${t("此模型当前不可用")}`, newSessionDefaults.thoughtLevel);
    option.disabled = true;
    defaultSessionThoughtSelect.add(option);
  }
  defaultSessionThoughtSelect.value = newSessionDefaults.thoughtLevel ?? "desktop";
  if (![...defaultSessionThoughtSelect.options].some(option => option.value === defaultSessionThoughtSelect.value)) {
    defaultSessionThoughtSelect.value = "desktop";
  }
  newSessionThoughtHelp.textContent = t("思考强度取决于模型；更换默认模型后会恢复为模型默认值。");
}

function saveNewSessionDefaults(): void {
  post({ type: "setNewSessionDefaults", defaults: newSessionDefaults });
}

defaultSessionModelSelect.addEventListener("change", () => {
  const choice = defaultModelChoices.find(model => sessionModelKey(model) === defaultSessionModelSelect.value);
  newSessionDefaults = {
    ...(choice ? { model: { providerId: choice.providerId, modelId: choice.modelId } } : {}),
    ...(newSessionDefaults.mode ? { mode: newSessionDefaults.mode } : {}),
    // Thought levels belong to a model. Reset them when the model default changes.
  };
  renderNewSessionSettings();
  saveNewSessionDefaults();
});
defaultSessionModeSelect.addEventListener("change", () => {
  const mode = defaultSessionModeSelect.value;
  newSessionDefaults = {
    ...(newSessionDefaults.model ? { model: newSessionDefaults.model } : {}),
    ...(mode !== "desktop" ? { mode: mode as NewSessionDefaults["mode"] } : {}),
    ...(newSessionDefaults.thoughtLevel ? { thoughtLevel: newSessionDefaults.thoughtLevel } : {}),
  };
  saveNewSessionDefaults();
});
defaultSessionThoughtSelect.addEventListener("change", () => {
  const thoughtLevel = defaultSessionThoughtSelect.value;
  newSessionDefaults = {
    ...(newSessionDefaults.model ? { model: newSessionDefaults.model } : {}),
    ...(newSessionDefaults.mode ? { mode: newSessionDefaults.mode } : {}),
    ...(thoughtLevel !== "desktop" ? { thoughtLevel } : {}),
  };
  saveNewSessionDefaults();
});

document.getElementById("copy-diagnostics")!.addEventListener("click", () => {
  closeSettings(); settingsButton.focus(); post({type: "copyDiagnostics"});
});
document.getElementById("pending-action")!.addEventListener("click", () => {
  const prompt = pendingPrompt();
  if (prompt) revealPrompt(prompt, true);
});
languageSelect.value = document.documentElement.dataset.languageSetting || "auto";
function closeSettings(): void {
  settingsMenu.hidden = true;
  settingsButton.setAttribute("aria-expanded", "false");
}
settingsButton.addEventListener("click", () => {
  settingsMenu.hidden = !settingsMenu.hidden;
  settingsButton.setAttribute("aria-expanded", String(!settingsMenu.hidden));
  if (!settingsMenu.hidden) defaultSessionModelSelect.focus();
});
languageSelect.addEventListener("change", () => {
  post({ type: "setLanguage", language: languageSelect.value });
});
function applyComposerChrome(chrome: {
  showQuestionJump?: boolean;
  showUsageChevron?: boolean;
  showContextRing?: boolean;
  showFiveHourRing?: boolean;
  showConnectionStatus?: boolean;
}): void {
  for (const input of settingsMenu.querySelectorAll<HTMLInputElement>("input[data-chrome]")) {
    const key = input.dataset.chrome as keyof typeof chrome;
    const on = chrome[key] !== false;
    document.documentElement.dataset[key] = String(on);
    input.checked = on;
  }
  applyQuestionRailVisibility();
  applyUsageVisibility();
  applyControlFold();
}
const controlsToggle = document.getElementById("controls-toggle") as HTMLButtonElement;
let sessionControlsOpen = vscode.getState()?.sessionControlsOpen === true;
function applyControlFold(): void {
  const fold = document.documentElement.dataset.foldSessionControls === "true";
  const open = fold && sessionControlsOpen;
  document.documentElement.dataset.sessionControlsOpen = String(open);
  const label = open ? t("收起权限和推理") : t("展开权限和推理");
  controlsToggle.title = label;
  controlsToggle.setAttribute("aria-label", label);
  controlsToggle.setAttribute("aria-expanded", String(open));
  applySessionControls({ mode: currentMode, thoughtEnabled, thoughtLevel: currentThought, thoughtLevels });
}
controlsToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  sessionControlsOpen = !sessionControlsOpen;
  vscode.setState({ ...(vscode.getState() ?? {}), sessionControlsOpen });
  applyControlFold();
});
for (const input of settingsMenu.querySelectorAll<HTMLInputElement>("input[data-chrome]")) {
  input.addEventListener("change", () => {
    document.documentElement.dataset[input.dataset.chrome!] = String(input.checked);
    applyQuestionRailVisibility();
    applyUsageVisibility();
    applyControlFold();
    post({ type: "setChrome", chromeKey: input.dataset.chrome, enabled: input.checked });
  });
}
document.addEventListener("click", event => {
  if (!settingsMenu.contains(event.target as Node) && !settingsButton.contains(event.target as Node)) closeSettings();
});
settingsMenu.addEventListener("keydown", event => {
  if (event.key === "Escape") { closeSettings(); settingsButton.focus(); }
});
function applyInterfaceLanguage(language: string, setting: LanguageSetting): void {
  setUiLanguage(resolveUiLanguage(language, "en"));
  document.documentElement.lang = language;
  languageSelect.value = setting;
  renderImageDrafts(); refreshImageLabels(); renderComposerChips();
  refreshPendingAction();
  // Refresh only extension-owned controls. Chat text, question choices, tool
  // input/output, drafts and session names remain untouched.
  const labels = "button,option,#language-label,.settings-select-label,.settings-help,.settings-switch > span,.settings-section,#conn-label,#overlay-title,#setup-title,.empty-title,.overlay-empty,.queued-tag,.git-title,.git-loading,.git-reverted,.perm-title,.tool-status";
  const owned = (node: Element) => !node.classList.contains("tool-preview") && (node.classList.contains("copy-btn") || node.hasAttribute("data-open") || node.hasAttribute("data-diff") || !node.closest(".md,.work-note,.message.user:not(.queued),.tool-body,.ask-q,.perm-reason") && !node.hasAttribute("data-q"));
  for (const node of document.querySelectorAll<HTMLElement>(labels)) {
    if (!owned(node) || node.dataset.i18nKey) continue;
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent) child.textContent = relocalizeUiText(child.textContent);
    }
  }
  for (const node of document.querySelectorAll<HTMLElement>("[title],[aria-label],[placeholder]")) {
    if (!owned(node)) continue;
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const value = node.getAttribute(attr);
      if (value) node.setAttribute(attr, relocalizeUiText(value));
    }
  }
  for (const node of document.querySelectorAll<HTMLElement>(".git-title[data-i18n-key],.perm-title[data-i18n-key],.tool-status[data-i18n-key],.tool-name[data-i18n-key],.reasoning-head [data-i18n-key],.process-group [data-i18n-key],.tool-section-label[data-i18n-key],.ask-summary [data-i18n-key],.message.error [data-i18n-key],#setup-title[data-i18n-key],#setup-hint[data-i18n-key],#setup-recovery [data-i18n-key]")) {
    if (node.closest(".md,.work-note,.message.user,.tool-body,.ask-q,.perm-reason") && !node.classList.contains("tool-section-label") && node.dataset.i18nKey !== "分析图片") continue;
    node.textContent = t(node.dataset.i18nKey!, JSON.parse(node.dataset.i18nValues || "{}"));
  }
  renderUsagePanel();
  syncQuestionRail();
  syncQuestionFoldControls();
  for (const time of document.querySelectorAll<HTMLElement>(".msg-time[data-sent-at]")) {
    time.textContent = messageClock(Number(time.dataset.sentAt));
    time.title = new Date(Number(time.dataset.sentAt)).toLocaleString(getUiLanguage(), { hour12: false });
  }
  applySessionControls({ mode: currentMode });
  renderNewSessionSettings();
  updateComposerActions();
  setSessionTitle(titleEl.value);
  const command = activeCommand ? slashCommands.find(item => item.name === activeCommand) : undefined;
  input.placeholder = command ? commandDescription(command) : composerPlaceholder();
  for (const fold of messagesEl.querySelectorAll<HTMLElement>(".work-fold")) paintWorkFold(fold);
  refreshEmptyGreeting();
  if (overlayMode) rebuildOverlay(overlaySearch.value);
  placePicker();
}

document.getElementById("btn-sessions")!.addEventListener("click", () => {
  openOverlay("sessions");
});
document.getElementById("tab-active")?.addEventListener("click", () => {
  showArchived = false;
  document.getElementById("tab-active")?.classList.add("active");
  document.getElementById("tab-archived")?.classList.remove("active");
  post({ type: "listSessions", includeArchived: false });
});
document.getElementById("tab-archived")?.addEventListener("click", () => {
  showArchived = true;
  document.getElementById("tab-archived")?.classList.add("active");
  document.getElementById("tab-active")?.classList.remove("active");
  post({ type: "listSessions", includeArchived: true });
});
document.getElementById("btn-new")!.addEventListener("click", () => {
  post({ type: "newSession" });
});
document.getElementById("btn-retry")!.addEventListener("click", () => {
  hideSetup();
  post({ type: "retry" });
});
modelChip.addEventListener("click", () => openOverlay("models"));
modeChip.addEventListener("click", () => openOverlay("mode"));
thoughtChip.addEventListener("click", () => openOverlay("thought"));
new ResizeObserver(() => placePicker()).observe(composerEl);
document.addEventListener("mousedown", (e) => {
  if (!popover.classList.contains("open")) return;
  const t = e.target as Node;
  if (
    popover.contains(t) ||
    modelChip.contains(t) ||
    modeChip.contains(t) ||
    thoughtChip.contains(t)
  ) {
    return;
  }
  closePicker();
});
document.getElementById("overlay-close")!.addEventListener("click", closeOverlay);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeOverlay();
});
overlaySearch.addEventListener("input", () => rebuildOverlay(overlaySearch.value));
overlaySearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && overlayItems[0]) {
    e.preventDefault();
    selectOverlay(0);
  }
});

document.getElementById("setup-close")!.addEventListener("click", hideSetup);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeOverlay();
    hideSetup();
  }
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "session_ready":
      hideSetup();
      if (
        msg.sessionId &&
        conversationSessionId &&
        msg.sessionId !== conversationSessionId
      ) {
        latestConversation = null;
        gitFileLists.clear();
        previewRequests.clear();
        previewResults.clear();
        localTurnFiles.clear();
      }
      if (msg.sessionId) conversationSessionId = msg.sessionId;
      if (msg.kind === "created" || msg.sessionId !== currentSessionId) { modelMarks = []; clearActiveCommand(); applyGoalState(null); }
      if (Array.isArray(msg.slashCommands)) {
        slashCommands = msg.slashCommands.filter((command: { name?: string }) => typeof command?.name === "string" && command.name);
      }
      attachComposerDraft(msg.sessionId ?? "");
      currentSessionId = msg.sessionId ?? "";
      if (msg.title) setSessionTitle(msg.title);
      if (msg.kind === "created") holdStreams = false;
      if (typeof msg.viewGen === "number") viewGen = msg.viewGen;
      sessionConnected = true;
      updateComposerActions();
      setStatus("idle", "");
      break;
    case "goal_state": {
      if (holdStreams) break;
      if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
      applyGoalState((msg as { goal?: unknown }).goal);
      scrollToBottom();
      break;
    }
    case "model_switched": {
      if (holdStreams) break;
      if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
      const to = msg.to as { modelId?: string; source?: string } | undefined;
      const from = msg.from as { modelId?: string; source?: string } | undefined;
      const modelText = (model: { modelId?: string; source?: string } | undefined) =>
        model?.modelId ? `${model.modelId}${model.source ? `(${model.source})` : ""}` : undefined;
      const fromText = modelText(from);
      const toText = modelText(to);
      const toId = to?.modelId ?? "";
      if (!toText || !toId) break;
      const anchorBubble = [...messagesEl.querySelectorAll<HTMLElement>(".message.user:not(.queued)")].at(-1);
      const anchorJump = anchorBubble?.dataset.jump ?? "";
      const anchorText = anchorBubble?.dataset.rawText ?? "";
      modelMarks = modelMarks.filter(mark => mark.toId !== toId);
      modelMarks.push({ fromText, toText, toId, anchorJump, anchorText });
      renderModelMarks(new Set());
      scrollToBottom();
      break;
    }
    case "session_title":
      sessions = sessions.map((s) =>
        s.sessionId === (msg.sessionId || currentSessionId)
          ? { ...s, title: msg.title }
          : s
      );
      if (
        msg.title &&
        (!msg.sessionId || msg.sessionId === currentSessionId)
      ) {
        setSessionTitle(msg.title);
      }
      if (overlayMode === "sessions") rebuildOverlay(overlaySearch.value);
      break;
    case "session_activity":
      markSessionRunning(String(msg.sessionId || ""), !!msg.running);
      break;
    case "session_action_started":
      if (msg.sessionId && msg.actionRequestId &&
          ["rename", "archive", "unarchive", "delete"].includes(msg.action)) {
        beginSessionAction(msg.sessionId, msg.action as SessionAction, msg.actionRequestId);
      }
      break;
    case "session_action_complete":
      if (msg.sessionId && msg.actionRequestId) finishSessionAction(msg.sessionId, msg.actionRequestId);
      break;
    case "sessions":
      sessions = msg.sessions ?? [];
      mentions.refresh();
      currentSessionId = msg.currentId || currentSessionId;
      {
        const current = sessions.find((s) => s.sessionId === currentSessionId);
        if (current?.title) setSessionTitle(current.title);
      }
      if (typeof msg.includeArchived === "boolean") showArchived = msg.includeArchived;
      document.getElementById("tab-active")?.classList.toggle("active", !showArchived);
      document.getElementById("tab-archived")?.classList.toggle("active", showArchived);
      if (overlayMode === "sessions") rebuildOverlay(overlaySearch.value);
      break;
    case "history":
      if (msg.sessionId && msg.sessionId !== currentSessionId) break;
      if (typeof msg.viewGen === "number" && msg.viewGen !== viewGen) break;
      holdStreams = false;
      if (Array.isArray(msg.queue)) currentQueue = msg.queue;
      {
        const wasEmpty =
          !!messagesEl.querySelector(".empty") || messagesEl.children.length === 0;
        const hasHistory = (msg.items?.length ?? 0) > 0;
        const activeSince = Number(msg.activeSince) || 0;
        renderHistory(msg.items ?? [], !!msg.truncated, msg.questions, activeSince,
          msg.renderSource === "transcript-sync" ? "transcript-sync" : "snapshot");
        if (activeSince > 0 || tailStillRunning(msg.items ?? [])) {
          if (currentSessionId) runningSessions.add(currentSessionId);
          isGenerating = true;
          if (!completionRevealPending) completionRevealJump = "";
          revealAfterCompletionArmed = true;
          if (!turnWorkStarted) turnWorkStarted = activeSince || Date.now();
          // A running user-only snapshot is still waiting for its first output.
          // Timeline-only operations (for example /compact) have their own UI.
          ensureWaitingWorkFeedback();
          // Session switches can render a running history before a status event.
          // Restore the tail spinner from history and scroll after its layout.
          ensureWorkingIndicator();
          if (stickToBottom) {
            scrollToBottom(true);
            const owner = currentSessionId, generation = viewGen;
            requestAnimationFrame(() => {
              if (owner === currentSessionId && generation === viewGen && isGenerating && stickToBottom) {
                scrollToBottom(true);
              }
            });
          }
          startWorkTicker();
          setConnStatus("busy", t("生成中"));
          updateComposerActions();
        } else {
          if (currentSessionId) runningSessions.delete(currentSessionId);
          // A transcript sync can momentarily omit the running marker while
          // the terminal status is still in flight. Retire the spinner, but
          // keep the natural-completion reveal intent until that status lands.
          setGenerating(false, true);
        }
        if (wasEmpty && hasHistory) {
          showToast(t("会话已恢复"));
        }
      }
      break;
    case "history_load_failed":
      if (msg.sessionId !== currentSessionId || msg.viewGen !== viewGen) break;
      if (msg.jumpId && pendingJump === msg.jumpId) pendingJump = "";
      ensureHistoryMore(historyTruncated);
      showToast(msg.message || t("加载更早的消息"));
      break;
    case "historyOlder":
      if (msg.sessionId !== currentSessionId || msg.viewGen !== viewGen) break;
      prependHistory(msg.items ?? [], !!msg.more);
      if (msg.jumpId) {
        pendingJump = "";
        const target = messagesEl.querySelector(
          `.message.user[data-jump="${CSS.escape(String(msg.jumpId))}"]`
        );
        if (target) jumpToQuestion(String(msg.jumpId));
      }
      break;
    case "cleared":
      loadedHistory = [];
      currentQueue = undefined;
      queueZoneEl.replaceChildren();
      queueZoneEl.hidden = true;
      holdStreams = false;
      latestConversation = null;
      gitFileLists.clear();
      previewRequests.clear();
      previewResults.clear();
      localTurnFiles.clear();
      emptyState();
      currentAssistantEl = null;
      setSessionTitle(t("新会话"));
      break;
    case "conversation_sync":
      if (
        msg.sessionId &&
        conversationSessionId &&
        msg.sessionId !== conversationSessionId
      ) {
        break;
      }
      latestConversation = {
        editable: msg.editable ?? null,
        turns: msg.turns ?? [],
      };
      if (!holdStreams) applyStoredConversation();
      break;
    case "query_rewound": {
      const editor = submittedEditor(msg);
      if (editor && editor === sentQuestions().at(-1)) applyQueryRewind(editor, msg.text || "", readImageAttachments(msg.attachments));
      break;
    }
    case "query_edit_rejected": {
      const editor = submittedEditor(msg);
      if (editor) {
        delete editor.dataset.editSubmissionId;
        setEditSubmitting(editor, false);
        showToast(msg.message || t("发送失败，内容已保留到草稿。"));
      }
      break;
    }
    case "file_changes":
      if (holdStreams) break;
      showGitFiles(String(msg.turnId || ""), msg.files ?? [], msg.error);
      break;
    case "preview_files":
      if (holdStreams || msg.sessionId !== currentSessionId) break;
      showTurnPreviews(String(msg.turnId || ""), String(msg.signature || ""), msg.cards ?? []);
      break;
    case "user_input_echo":
      break;
    case "view_reset":
      messageEpoch++;
      resetAllTurnCollapse();
      pinActiveQuestionUntil = 0;
      releaseCompletedReveal();
      ignoreScroll = false;
      resumeOuterFollow = false;
      resumeWorkFollow = false;
      applyGoalState(null);
      loadedHistory = [];
      historyTruncated = false;
      historyActiveSince = 0;
      prepareComposerSwitch();
      currentQueue = undefined;
      queueZoneEl.replaceChildren();
      queueZoneEl.hidden = true;
      setUsageMeter({});
      holdStreams = true;
      if (typeof msg.viewGen === "number") viewGen = msg.viewGen;
      setGenerating(false);
      latestConversation = null;
      gitFileLists.clear();
      previewRequests.clear();
      previewResults.clear();
      localTurnFiles.clear();
      currentAssistantEl = null;
      turnWorkStarted = 0;
      stopWorkTicker();
      if (msg.clear) {
        emptyState();
        setSessionTitle(t("新会话"));
      } else {
        messagesEl.innerHTML = "";
        setStatus("busy", t("切换会话"));
      }
      questionIndex = [];
      syncQuestionRail();
      break;
    case "question_index":
      if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
      if (typeof msg.viewGen === "number" && msg.viewGen !== viewGen) break;
      questionIndex = indexedQuestions(msg.questions);
      syncQuestionRail();
      break;
    case "stream_release":
      if (!draftSessionId && currentSessionId) attachComposerDraft(currentSessionId);
      holdStreams = false;
      updateComposerActions();
      break;
    case "assistant_text":
      if (holdStreams) break;
      startAssistantMessage();
      appendAssistantDelta(msg.text ?? "");
      noteActivity("answer");
      break;
    case "assistant_text_delta":
      if (holdStreams) break;
      appendAssistantDelta(msg.fullText ?? msg.delta ?? "", msg.partId, msg.authoritative, msg.streaming ?? true);
      acknowledgeFirstOutput(msg);
      if (msg.streaming !== false) noteActivity("answer");
      break;
    case "assistant_reasoning_delta":
      if (holdStreams) break;
      appendReasoningDelta(msg.fullText ?? msg.delta ?? "", msg.partId, msg.authoritative, msg.streaming ?? true);
      acknowledgeFirstOutput(msg);
      if (msg.streaming !== false) noteActivity("reasoning");
      break;
    case "tool_call":
      if (holdStreams) break;
      addToolCall(msg);
      if (isGenerating) noteActivity(messagesEl.querySelector(".work-fold[data-state='running'] .tool-call[data-tool-status='running']") ? "tool" : "waiting");
      break;
    case "models":
      models = msg.available ?? [];
      defaultModelChoices = models;
      const nextCurrentModel = msg.current?.providerId && msg.current?.modelId
        ? { providerId: msg.current.providerId, modelId: msg.current.modelId }
        : undefined;
      if (!sameSessionModel(currentSessionModel, nextCurrentModel)) sessionThoughtOptions = [];
      currentSessionModel = nextCurrentModel;
      currentModelLabel = msg.current
        ? `${msg.current.providerId}/${msg.current.modelId}`
        : "";
      modelChip.textContent = msg.current
        ? msg.current.modelId
        : t("Select model");
      modelChip.title = msg.current
        ? `${msg.current.providerId} / ${msg.current.modelId}`
        : t("Select model");
      refreshModelSwitchLabels();
      if (msg.needsSelection) {
        openOverlay("models");
      }
      if (overlayMode === "models") rebuildOverlay(overlaySearch.value);
      renderNewSessionSettings();
      break;
    case "new_session_defaults":
      newSessionDefaults = msg.defaults && typeof msg.defaults === "object" ? msg.defaults : {};
      defaultModelChoices = Array.isArray(msg.models) ? msg.models : models;
      if (msg.currentModel?.providerId && msg.currentModel?.modelId) {
        currentSessionModel = { providerId: msg.currentModel.providerId, modelId: msg.currentModel.modelId };
      }
      renderNewSessionSettings();
      break;
    case "setup":
      sessionConnected = false;
      setStatus("warn", msg.reason || t("Setup needed"));
      updateComposerActions();
      showSetup(msg.reason || t("Setup needed"), msg.hint || "", msg.picker || []);
      break;
    case "ui_language":
      applyInterfaceLanguage(msg.language, msg.setting);
      break;
    case "composer_chrome":
      if (msg.chrome) applyComposerChrome(msg.chrome);
      break;
    case "openSettings":
      settingsMenu.hidden = false;
      settingsButton.setAttribute("aria-expanded", "true");
      break;
    case "status":
      if (msg.sessionId && msg.sessionId !== currentSessionId) break;
      if (holdStreams) break;
      if (msg.status === "stopping") {
        setGenerating(true);
        noteActivity("stopping");
        updateComposerActions();
      } else if (msg.status === "running") {
        if (activityPhase === "stopping") { activityPhase = "waiting"; activitySince = Date.now(); }
        if (currentSessionId) runningSessions.add(currentSessionId);
        setGenerating(true);
        if (msg.message === "等待模型响应…") { ensureWaitingWorkFeedback(); noteActivity("waiting"); }
        else paintActivity();
        updateComposerActions();
      }
      else if (msg.status === "connecting" || msg.status === "resolving_credentials") {
        sessionConnected = false;
        setStatus("busy", msg.status === "resolving_credentials" ? t("读取登录") : t("连接中"));
        updateComposerActions();
      } else if (msg.status === "completedSuccess" || msg.status === "completedInterrupted") {
        const revealStart = msg.status === "completedSuccess" && revealAfterCompletionArmed && stickToBottom;
        if (currentSessionId) runningSessions.delete(currentSessionId);
        if (overlayMode === "sessions") rebuildOverlay(overlaySearch.value);
        setGenerating(false);
        removePendingEditPens();
        if (msg.status === "completedInterrupted") setConnStatus("idle", t("已停止"));
        settleWorkFolds(msg.status === "completedInterrupted" ? "interrupted" : "completed");
        settleReplyFooters();
        finalizeAssistantMessage();
        if (revealStart) {
          completionRevealPending = true;
          reconcileCompletedReveal();
          scheduleCompletedReveal();
        }
      } else if (msg.status === "exited") {
        sessionConnected = false;
        setGenerating(false);
        removePendingEditPens();
        settleWorkFolds("interrupted");
        settleReplyFooters();
        setStatus("error", t("ZCode process exited"));
        if (!messagesEl.lastElementChild?.classList.contains("error")) addErrorMessage(msg.message || "ZCode process exited");
      } else if (msg.status === "error") {
        setGenerating(false);
        removePendingEditPens();
        settleWorkFolds("interrupted");
        settleReplyFooters();
        const text = msg.message || t("The model failed to complete this turn");
        setStatus("error", t(errorGuidance(text).title));
        addErrorMessage(text);
      }
      break;
    case "sync_status":
      if (holdStreams || msg.sessionId && msg.sessionId !== currentSessionId) break;
      if (msg.active) noteActivity("sync");
      else if (activityPhase === "sync") noteActivity("waiting");
      break;
    case "session_error":
      if (holdStreams) break;
      setGenerating(false);
      removePendingEditPens();
      settleWorkFolds("interrupted");
      settleReplyFooters();
      {
        const text = msg.message || t("Session error");
        setStatus("error", t(errorGuidance(text).title));
        addErrorMessage(text);
      }
      break;
    case "copied":
      showToast(t("Copied"));
      break;
    case "image_pending": case "image_ready": case "image_failed":
      if (!applyEditImageMessage(msg)) imageResult(msg);
      break;
    case "attachment_picker_closed":
      if (document.querySelector(".message.user .user-edit")) document.querySelector<HTMLTextAreaElement>(".message.user .user-edit")?.focus();
      else if (msg.sessionId === draftSessionId) input.focus();
      break;
    case "workspace_files": mentions.receive(msg.requestId,msg.sessionId ?? "",msg.files ?? [],msg.error); break;
    case "file_reference_details": {
      if (msg.sessionId !== draftSessionId || typeof msg.dirty !== "boolean") break;
      for (const element of attachmentsEl.querySelectorAll<HTMLElement>(".ctx-chip")) {
        if (element.dataset.detailRequest !== msg.requestId || element.dataset.referencePath !== msg.path) continue;
        element.title=`${msg.path}\n${t("整个文件")}\n${msg.dirty ? t("包含未保存修改") : t("引用已保存内容")}`;
        element.setAttribute("aria-label",element.title);
      }
      break;
    }
    case "file_added": {
      persistComposerDraft(); const draft = composerDrafts.get(msg.sessionId);
      if (!draft.chips.some(chip => chip.path === msg.chip.path)) draft.chips.push(msg.chip);
      composerDrafts.set(msg.sessionId, draft.text, draft.chips, draft.images, draft.sessionRefs);
      if (msg.sessionId === draftSessionId) { explicitChips = draft.chips; renderComposerChips(); }
      vscode.setState({ ...(vscode.getState() ?? {}), composerDrafts: composerDrafts.serialize() }); break;
    }
    case "image_thumbnail": {
      const request=thumbnailRequests.get(msg.requestId);if(!request)break;
      thumbnailRequests.delete(msg.requestId);
      request.resolve(request.owner===currentSessionId&&request.gen===viewGen&&/^data:image\/(png|jpeg|webp|gif);base64,/.test(msg.dataUrl??"")?msg.dataUrl:undefined);
      break;
    }
    case "image_preview": {
      if (msg.requestId !== previewRequest || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(msg.dataUrl)) break;
      showImagePreview(msg.dataUrl); break;
    }
    case "toast":
      if (msg.text || msg.message) showToast(msg.text || msg.message);
      break;
    case "session_controls":
      applySessionControls(msg);
      break;
    case "queue_edit_result": {
      const key = queuedEditKey(msg.sessionId, msg.queueItemId);
      const draft = queuedEditDrafts.get(key);
      if (!draft?.requestId || draft.requestId !== msg.requestId) break;
      if (msg.ok) queuedEditDrafts.delete(key);
      else draft.requestId = undefined;
      if (msg.sessionId !== currentSessionId || holdStreams) break;
      if (msg.ok && currentQueue) currentQueue = currentQueue.map(item => item.queueItemId === msg.queueItemId
        ? { ...item, text: draft.text.trim() } : item);
      const card = queueCards().find(node => node.dataset.queueId === msg.queueItemId);
      if (card) {
        if (msg.ok) {
          card.dataset.rawText = draft.text.trim();
          finishQueuedEdit(card, draft.text.trim());
        } else {
          beginQueuedEdit(card);
        }
        paintQueuedEdit(card);
      }
      if (!card && !msg.ok) {
        queuedEditDrafts.delete(key);
        recoverInput({ sessionId: msg.sessionId, text: draft.text });
      }
      if (!msg.ok && msg.message) showToast(msg.message);
      break;
    }
    case "queue_sync":
      if (holdStreams || msg.sessionId && msg.sessionId !== currentSessionId) break;
      currentQueue = msg.items ?? [];
      syncQueuedMessages();
      break;
    case "send_admitted":
      if (msg.commandId) pendingInputs.delete(msg.commandId);
      break;
    case "send_rejected":
      if (msg.keepDraft === false) {
        if (!msg.sessionId || msg.sessionId === currentSessionId) showToast(msg.message || "");
        break;
      }
      recoverInput(msg);
      if (!msg.sessionId || msg.sessionId === currentSessionId) {
        setGenerating(false);
        removePendingEditPens();
        settleWorkFolds("interrupted");
        settleReplyFooters();
        setStatus("error", msg.message || "");
        addErrorMessage(msg.message || t("发送失败，内容已保留到草稿。"));
        showToast(t("发送失败，内容已保留到草稿。"));
      }
      break;
    case "queue_admitted":
      if (msg.commandId) pendingInputs.delete(msg.commandId);
      if (msg.sessionId && msg.sessionId !== currentSessionId) break;
      for (const node of queueCards()) {
        if (node.dataset.sourceCommandId === msg.commandId) node.dataset.queuePending = "0";
      }
      break;
    case "queue_rejected": {
      const node = [...queueCards(), ...messagesEl.querySelectorAll<HTMLElement>(".message.user")].find(node => node.dataset.sourceCommandId === msg.commandId);
      if (msg.keepDraft !== false) recoverInput(msg);
      if (node) node.remove();
      if (node && isGenerating && (!msg.sessionId || msg.sessionId === currentSessionId)) ensureWaitingWorkFeedback();
      updateComposerActions();
      if (!msg.sessionId || msg.sessionId === currentSessionId) showToast(msg.message || "");
      break;
    }
    case "context_usage":
      setUsageMeter(msg);
      break;
    case "permission_request":
      if (holdStreams) break;
      if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
      addPermissionCard(msg);
      break;
    case "user_input_request":
      if (holdStreams) break;
      if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
      addUserInputCard(msg);
      break;
    case "editorContext": break; // Context is now always explicitly selected.
    case "addChip":
      if (msg.chip) {
        addExplicitChip(msg.chip);
        input.focus();
        showToast(t("已附加到对话"));
      }
      break;
  }
});

window.addEventListener("pagehide", () => { persistComposerDraft(); clearGreetingTimer(); });

// Styled hover cards replace the browser's plain title tooltips everywhere.
// The native title is hidden only while the card is visible and restored on
// leave, so dynamically updated titles keep working.
const tooltipEl = document.getElementById("tooltip")!;
let tooltipTimer = 0;
let tooltipSource: HTMLElement | null = null;

function showTooltipFor(el: HTMLElement): void {
  const text = (el.dataset.tipBackup ?? "").trim();
  if (!text) return;
  tooltipEl.replaceChildren(
    ...text.split("\n").map((line, index) => {
      const row = document.createElement("div");
      if (index === 0 && text.includes("\n")) row.className = "tip-label";
      row.textContent = line;
      return row;
    })
  );
  tooltipEl.classList.add("show");
  const rect = el.getBoundingClientRect();
  const box = tooltipEl.getBoundingClientRect();
  let left = Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8));
  let top = rect.top - box.height - 6;
  if (top < 8) top = Math.min(rect.bottom + 6, window.innerHeight - box.height - 8);
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTooltip(): void {
  window.clearTimeout(tooltipTimer);
  tooltipTimer = 0;
  tooltipEl.classList.remove("show");
  const source = tooltipSource;
  tooltipSource = null;
  if (source?.dataset.tipBackup !== undefined) {
    source.title = source.dataset.tipBackup;
    delete source.dataset.tipBackup;
  }
}

function armTooltip(el: HTMLElement, delay: number): void {
  // Already showing for this element: keep it (child-to-child hover would
  // otherwise restart the timer and make the card blink).
  if (tooltipSource === el) {
    window.clearTimeout(tooltipTimer);
    return;
  }
  hideTooltip();
  tooltipTimer = window.setTimeout(() => {
    if (!el.isConnected || !el.title) return;
    el.dataset.tipBackup = el.title;
    el.title = "";
    tooltipSource = el;
    showTooltipFor(el);
  }, delay);
}

// While the card is visible, JS title updates (mode/reasoning labels and the
// like) must go to the backup — a non-empty title would let the native
// tooltip pop up next to the custom card.
const tooltipTitleSync = new MutationObserver(mutations => {
  const debug = (window as unknown as { tipObs?: string[] }).tipObs ?? [];
  debug.push(mutations.map(m => (m.target as HTMLElement).id + "=" + (m.target as HTMLElement).title.length).join(","));
  (window as unknown as { tipObs?: string[] }).tipObs = debug;
  for (const mutation of mutations) {
    const el = mutation.target as HTMLElement;
    if (el !== tooltipSource) continue;
    const next = el.getAttribute("title") ?? "";
    if (!next) continue;
    el.dataset.tipBackup = next;
    el.title = "";
    if (tooltipEl.classList.contains("show")) showTooltipFor(el);
  }
});
tooltipTitleSync.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["title"] });

document.addEventListener("mouseover", event => {
  const target = event.target as Element | null;
  const el = target instanceof Element ? target.closest<HTMLElement>("[title]") : null;
  if (el?.title) armTooltip(el, el.closest("#usage-panel, #context-meter") ? 40 : 260);
});
document.addEventListener("mouseout", event => {
  const related = event.relatedTarget as Node | null;
  if (related && tooltipSource?.contains(related)) return;
  hideTooltip();
});
document.addEventListener("focusin", event => {
  const target = event.target as Element | null;
  const el = target instanceof Element ? target.closest<HTMLElement>("[title]") : null;
  if (el?.title) armTooltip(el, 0);
});
document.addEventListener("focusout", hideTooltip);
// Scrolling moves the anchor, so a visible card must hide — but only when
// the scroll could actually move that anchor: unrelated inner scrollers
// (work folds, overlay lists) fire bubbled scroll events too.
window.addEventListener("scroll", event => {
  if (!tooltipSource) return;
  const target = event.target;
  if (target instanceof Node &&
      (target === tooltipSource || target.contains(tooltipSource) || tooltipSource.contains(target))) {
    hideTooltip();
  }
}, true);
window.addEventListener("focus", refreshEmptyGreeting);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshEmptyGreeting();
  else clearGreetingTimer();
});
window.addEventListener("blur", persistComposerDraft);
restoreComposerDraft(composerDrafts.get(draftSessionId));
updateComposerActions();
emptyState();
applySessionControls({ mode: currentMode });
renderUsagePanel();
const chromeObserver = new ResizeObserver(() => {
  const stick = stickToBottom;
  syncMessagesChrome();
  if (stick) scrollToBottom(true);
  scheduleCompletedReveal();
});
chromeObserver.observe(topbarEl);
chromeObserver.observe(composerEl);
// Watch the border box only: the callback writes #messages padding, and the
// content-box would then resize under us, re-firing this observer in a loop.
chromeObserver.observe(messagesEl, { box: "border-box" });
window.addEventListener("resize", () => {
  const stick = stickToBottom;
  syncMessagesChrome();
  syncQuestionFoldControls();
  updateQuestionRailOverflow();
  if (stick) scrollToBottom(true);
  scheduleCompletedReveal();
});
messagesEl.addEventListener("scroll", scheduleMessagesScrollbar, { passive: true });
new MutationObserver(() => {
  scheduleMessagesScrollbar();
  scheduleCompletedReveal();
}).observe(messagesEl, {
  childList: true,
  subtree: true,
  characterData: true,
});
messagesScrollEl.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  releaseCompletedReveal();
  const thumbRect = messagesThumbEl.getBoundingClientRect();
  const onThumb = event.clientY >= thumbRect.top && event.clientY <= thumbRect.bottom;
  const offsetY = onThumb ? event.clientY - thumbRect.top : messagesThumbEl.offsetHeight / 2;
  messagesThumbDrag = { pointerId: event.pointerId, offsetY };
  messagesScrollEl.classList.add("is-dragging");
  messagesScrollEl.setPointerCapture(event.pointerId);
  messagesScrollbarScrollTo(event.clientY, offsetY);
  event.preventDefault();
});
messagesScrollEl.addEventListener("pointermove", (event) => {
  if (!messagesThumbDrag || event.pointerId !== messagesThumbDrag.pointerId) return;
  messagesScrollbarScrollTo(event.clientY, messagesThumbDrag.offsetY);
});
const endMessagesThumbDrag = (event: PointerEvent) => {
  if (!messagesThumbDrag || event.pointerId !== messagesThumbDrag.pointerId) return;
  messagesThumbDrag = null;
  messagesScrollEl.classList.remove("is-dragging");
};
messagesScrollEl.addEventListener("pointerup", endMessagesThumbDrag);
messagesScrollEl.addEventListener("pointercancel", endMessagesThumbDrag);
bindSoftScrollbar(questionTrack, "x");
syncComposerScrollbar = bindSoftScrollbar(input, "y");
syncMessagesChrome();
post({ type: "ready" });
input.focus();
