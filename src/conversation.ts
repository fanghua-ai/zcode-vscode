import { readImageAttachments, type ImageAttachment } from "./attachmentTypes";
/** Slim conversation rows and git hunks from the desktop v4 protocol. */

export interface RowTarget {
  rowId: number;
  entityId: string;
}

export interface FileChangeSummary {
  files: number;
  additions: number;
  deletions: number;
  state?: "active" | "reverted";
}

export interface ConvRow {
  attachments?: ImageAttachment[];
  rowId: number;
  kind: string;
  createdAt?: number;
  assistantResponseId?: string;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  activeMs?: number;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  inputText?: string;
  input?: unknown;
  output?: { text?: string };
  turnId?: string;
  entityId?: string;
  text?: string;
  origin?: string;
  source?: string;
  synthetic?: boolean;
  visibility?: string;
  transcriptVisibility?: string;
  uiVisibility?: string;
  sourceCommandId?: string;
  state?: string;
  actions?: {
    canEdit?: true;
    canRewindFiles?: true;
    editDisposition?: string;
  };
  fileChanges?: FileChangeSummary;
  /** Desktop goal checks, compaction, and model switches arrive as timeline rows. */
  marker?: {
    type?: string;
    iteration?: number;
    outcome?: string;
    detail?: string;
    origin?: string;
    status?: string;
    /** v4 modelChange stores model ids. The first turn often has no previous model. */
    fromProvider?: string;
    fromModel?: string;
    toProvider?: string;
    toModel?: string;
  };
}

export interface StructuredPatch {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface GitFileChange {
  path: string;
  additions: number;
  deletions: number;
  patches: StructuredPatch[];
}

export interface ConversationTurn {
  userTarget?: RowTarget;
  userAttachments?: ImageAttachment[];
  turnId: string;
  userText: string;
  fileChanges?: {
    target: RowTarget;
    summary: FileChangeSummary;
    canRewind: boolean;
  };
}

export interface EditableQuery {
  attachments?: ImageAttachment[];
  target: RowTarget;
  text: string;
}

export interface ConversationView {
  editable: EditableQuery | null;
  turns: ConversationTurn[];
}

export function slimRow(raw: unknown): ConvRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.rowId !== "number" || typeof row.kind !== "string") return null;
  const actions =
    row.actions && typeof row.actions === "object"
      ? (row.actions as Record<string, unknown>)
      : null;
  const fileChanges =
    row.fileChanges && typeof row.fileChanges === "object"
      ? (row.fileChanges as Record<string, unknown>)
      : null;
  const state = fileChanges?.state;
  const marker = row.marker && typeof row.marker === "object" ? row.marker as Record<string, unknown> : null;
  const anchor = row.anchor && typeof row.anchor === "object" ? row.anchor as Record<string, unknown> : null;
  const semantics = row.semantics && typeof row.semantics === "object" ? row.semantics as Record<string, unknown> : null;
  const source = typeof row.source === "string" ? row.source : undefined;
  const rawOrigin = typeof row.origin === "string" ? row.origin
    : typeof anchor?.origin === "string" ? anchor.origin
    : typeof semantics?.origin === "string" ? semantics.origin
    : row.synthetic === true ? source : undefined;
  const origin = rawOrigin === "real_user" ? "realUser" : rawOrigin;
  return {
    rowId: row.rowId,
    ...(readImageAttachments(row.attachments).length ? { attachments: readImageAttachments(row.attachments) } : {}),
    sourceCommandId: typeof row.sourceCommandId === "string" ? row.sourceCommandId : undefined,
    kind: row.kind,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : undefined,
    assistantResponseId: typeof row.assistantResponseId === "string" ? row.assistantResponseId : undefined,
    durationMs: typeof row.durationMs === "number" ? row.durationMs : undefined,
    startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
    endedAt: typeof row.endedAt === "number" ? row.endedAt : undefined,
    activeMs: typeof row.activeMs === "number" ? row.activeMs : undefined,
    toolCallId: typeof row.toolCallId === "string" ? row.toolCallId : undefined,
    toolName: typeof row.toolName === "string" ? row.toolName : undefined,
    status: typeof row.status === "string" ? row.status : undefined,
    inputText: typeof row.inputText === "string" ? row.inputText : undefined,
    input: row.input,
    output: row.output && typeof row.output === "object" ? row.output as { text?: string } : undefined,
    turnId: typeof row.turnId === "string" ? row.turnId : undefined,
    entityId: typeof row.entityId === "string" ? row.entityId : undefined,
    text:
      typeof row.text === "string" ? row.text : undefined,
    origin,
    source,
    synthetic: row.synthetic === true,
    visibility: typeof row.visibility === "string" ? row.visibility : undefined,
    transcriptVisibility: typeof row.transcriptVisibility === "string" ? row.transcriptVisibility
      : typeof semantics?.transcriptVisibility === "string" ? semantics.transcriptVisibility : undefined,
    uiVisibility: typeof semantics?.uiVisibility === "string" ? semantics.uiVisibility : undefined,
    state: typeof row.state === "string" ? row.state : undefined,
    actions: actions
      ? {
          canEdit: actions.canEdit === true ? true : undefined,
          canRewindFiles: actions.canRewindFiles === true ? true : undefined,
          editDisposition:
            typeof actions.editDisposition === "string"
              ? actions.editDisposition
              : undefined,
        }
      : undefined,
    fileChanges:
      fileChanges && typeof fileChanges.files === "number"
        ? {
            files: fileChanges.files,
            additions: numberOrZero(fileChanges.additions),
            deletions: numberOrZero(fileChanges.deletions),
            state: state === "active" || state === "reverted" ? state : undefined,
          }
        : undefined,
    marker:
      marker?.type === "goalVerify"
        ? {
            type: "goalVerify",
            iteration: typeof marker.iteration === "number" ? marker.iteration : undefined,
            outcome: typeof marker.outcome === "string" ? marker.outcome : undefined,
            detail: typeof marker.detail === "string" ? marker.detail : undefined,
          }
        : marker?.type === "compact"
          ? {
              type: "compact",
              origin: marker.origin === "auto" || marker.origin === "manual" ? marker.origin : undefined,
              status:
                typeof marker.status === "string" &&
                ["running", "success", "failed", "noop", "cancelled"].includes(marker.status)
                  ? marker.status
                  : undefined,
            }
          : marker?.type === "modelChange"
            ? {
                type: "modelChange",
                ...(typeof marker.fromProvider === "string" && marker.fromProvider ? { fromProvider: marker.fromProvider } : {}),
                ...(typeof marker.fromModel === "string" && marker.fromModel ? { fromModel: marker.fromModel } : {}),
                ...(typeof marker.toProvider === "string" && marker.toProvider ? { toProvider: marker.toProvider } : {}),
                ...(typeof marker.toModel === "string" && marker.toModel ? { toModel: marker.toModel } : {}),
              }
            : undefined,
  };
}

const WIRE_FRAGMENT_CAP = 1024;
const WIRE_BYTE_CAP = 16 * 1024 * 1024;

interface WireSlot {
  expected: number;
  chunks: Uint8Array[];
  got: number;
  bytes: number;
}

/**
 * v4/conversation/frame params are a wire envelope.
 * `complete` carries the logical frame; large snapshots arrive as base64 fragments.
 */
export function createWireDecoder(): {
  push(params: unknown): unknown | null;
  reset(): void;
} {
  const pending = new Map<string, WireSlot>();
  return {
    reset() {
      pending.clear();
    },
    push(params: unknown): unknown | null {
      if (!params || typeof params !== "object") return null;
      const wire = params as Record<string, unknown>;
      if (wire.kind === "complete" && wire.frame && typeof wire.frame === "object") {
        return wire.frame;
      }
      if (wire.kind === "fragment") {
        return takeFragment(pending, wire);
      }
      if (wire.payload && typeof wire.payload === "object") return params;
      return null;
    },
  };
}

function takeFragment(
  pending: Map<string, WireSlot>,
  wire: Record<string, unknown>
): unknown | null {
  const id = typeof wire.logicalFrameId === "string" ? wire.logicalFrameId : "";
  const index = wire.fragmentIndex;
  const count = wire.fragmentCount;
  const b64 = wire.dataBase64;
  if (
    !id ||
    typeof index !== "number" ||
    typeof count !== "number" ||
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > WIRE_FRAGMENT_CAP ||
    index < 0 ||
    index >= count ||
    typeof b64 !== "string"
  ) {
    return null;
  }
  const bytes = decodeBase64(b64);
  if (!bytes) return null;
  let slot = pending.get(id);
  if (!slot || slot.expected !== count) {
    if (pending.size >= 32) return null;
    slot = { expected: count, chunks: new Array(count), got: 0, bytes: 0 };
    pending.set(id, slot);
  }
  if (slot.chunks[index]) return null;
  if (slot.bytes + bytes.byteLength > WIRE_BYTE_CAP) {
    pending.delete(id);
    return null;
  }
  slot.chunks[index] = bytes;
  slot.got += 1;
  slot.bytes += bytes.byteLength;
  if (slot.got < count) return null;
  pending.delete(id);
  const joined = new Uint8Array(slot.bytes);
  let offset = 0;
  for (const chunk of slot.chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    return null;
  }
}

function decodeBase64(input: string): Uint8Array | null {
  if (input.length < 4 || input.length % 4 !== 0) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const pad = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((input.length / 4) * 3 - pad);
  let n = 0;
  for (let i = 0; i < input.length; i += 4) {
    const a = alphabet.indexOf(input[i]);
    const b = alphabet.indexOf(input[i + 1]);
    const c = pad === 2 && i + 2 >= input.length - 2 ? 0 : alphabet.indexOf(input[i + 2]);
    const d = pad > 0 && i + 3 >= input.length - 1 ? 0 : alphabet.indexOf(input[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    out[n++] = (a << 2) | (b >> 4);
    if (n < out.length) out[n++] = ((b & 15) << 4) | (c >> 2);
    if (n < out.length) out[n++] = ((c & 3) << 6) | d;
  }
  return out;
}

/** Appends can arrive out of rowId order when concurrent server-side writes
 * race; the transcript order is the rowId order, so insert by identity. */
function insertRowSorted(rows: ConvRow[], row: ConvRow): ConvRow[] {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].rowId < row.rowId) low = mid + 1;
    else high = mid;
  }
  const next = rows.slice();
  next.splice(low, 0, row);
  return next;
}

export function applyConversationFrame(
  rows: ConvRow[],
  params: unknown
): { rows: ConvRow[]; logEpoch?: string; revision?: number } {
  const frame = params as {
    payload?: {
      kind?: string;
      snapshot?: {
        logEpoch?: string;
        revision?: number;
        rows?: { window?: unknown[] };
      };
      deltas?: unknown[];
    };
  };
  const payload = frame?.payload;
  if (!payload) return { rows };
  if (payload.kind === "snapshot" && payload.snapshot) {
    const window = payload.snapshot.rows?.window ?? [];
    return {
      rows: window.map(slimRow).filter((row): row is ConvRow => row !== null)
        .sort((a, b) => a.rowId - b.rowId),
      logEpoch:
        typeof payload.snapshot.logEpoch === "string"
          ? payload.snapshot.logEpoch
          : undefined,
      revision:
        typeof payload.snapshot.revision === "number"
          ? payload.snapshot.revision
          : undefined,
    };
  }
  if (payload.kind !== "deltas" || !Array.isArray(payload.deltas)) return { rows };
  let next = rows;
  let revision: number | undefined;
  for (const raw of payload.deltas) {
    if (!raw || typeof raw !== "object") continue;
    const op = raw as {
      op?: string;
      row?: unknown;
      rowId?: number;
      path?: string;
      append?: string;
      fromRowId?: number;
      patch?: { revision?: number };
    };
    if (op.op === "row.appended" || op.op === "row.upserted") {
      const row = slimRow(op.row);
      if (!row) continue;
      const index = next.findIndex((item) => item.rowId === row.rowId);
      next = next.slice();
      if (index >= 0) next[index] = row;
      else next = insertRowSorted(next, row);
    } else if (op.op === "row.delta" && typeof op.append === "string") {
      const index = next.findIndex(item => item.rowId === op.rowId);
      if (index < 0) continue;
      const row = { ...next[index] };
      if (op.path === "text") row.text = (row.text ?? "") + op.append;
      else if (op.path === "inputText") row.inputText = (row.inputText ?? "") + op.append;
      else if (op.path === "output.text") row.output = { ...row.output, text: (row.output?.text ?? "") + op.append };
      next = next.slice();
      next[index] = row;
    } else if (op.op === "row.removed" && typeof op.fromRowId === "number") {
      const from = op.fromRowId;
      next = next.filter((row) => row.rowId < from);
    } else if (op.op === "state.updated" && typeof op.patch?.revision === "number") {
      revision = op.patch.revision;
    }
  }
  return { rows: next, revision };
}

export function buildConversationView(rows: ConvRow[]): ConversationView {
  const slots = new Map<string, { order: number; userText: string; attachments?: ImageAttachment[]; target?: RowTarget; header?: ConvRow }>();
  let order = 0;
  let editable: EditableQuery | null = null;
  for (const row of rows) {
    if (
      row.kind === "userInput" &&
      row.origin === "realUser" &&
      row.actions?.canEdit &&
      row.entityId
    ) {
      editable = {
        target: { rowId: row.rowId, entityId: row.entityId },
        text: row.text ?? "",
        ...(row.attachments?.length ? {attachments:row.attachments} : {}),
      };
    }
    if (!row.turnId) continue;
    let slot = slots.get(row.turnId);
    if (!slot) {
      slot = { order: order++, userText: "" };
      slots.set(row.turnId, slot);
    }
    if (row.kind === "userInput" && row.origin === "realUser") {
      slot.userText = row.text ?? "";
      slot.attachments = row.attachments;
      if (row.entityId) slot.target = {rowId:row.rowId,entityId:row.entityId};
    }
    if (row.kind === "turnHeader") slot.header = row;
  }
  const turns: ConversationTurn[] = [...slots.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .filter(([, slot]) => slot.userText || slot.attachments?.length || slot.header?.attachments?.length)
    .map(([turnId, slot]) => {
      const header = slot.header;
      const summary = header?.fileChanges;
      const attachments = slot.attachments?.length ? slot.attachments : header?.attachments;
      const turn: ConversationTurn = { turnId, userText: slot.userText, ...(slot.target ? {userTarget:slot.target} : {}), ...(attachments?.length ? {userAttachments:attachments} : {}) };
      if (header?.entityId && summary && summary.files > 0) {
        turn.fileChanges = {
          target: { rowId: header.rowId, entityId: header.entityId },
          summary,
          canRewind: header.actions?.canRewindFiles === true && summary.state !== "reverted",
        };
      }
      return turn;
    });
  return { editable, turns };
}

export function readGitFiles(result: unknown): GitFileChange[] {
  const items = (result as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  const files: GitFileChange[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.path !== "string" || !item.path) continue;
    const patches = Array.isArray(item.patches)
      ? item.patches.map(readPatch).filter((patch): patch is StructuredPatch => patch !== null)
      : [];
    files.push({
      path: item.path,
      additions: numberOrZero(item.additions),
      deletions: numberOrZero(item.deletions),
      patches,
    });
  }
  return files;
}

/** Rebuild the pre-change text from unified hunks. `afterText` is the file as applied. */
export function materializeGitDiff(
  afterText: string | null,
  patches: StructuredPatch[]
): { before: string; after: string } {
  if (afterText !== null) {
    try {
      return { before: reverseApply(afterText, patches), after: afterText };
    } catch {
      /* The file on disk no longer matches the hunk; show the hunk itself. */
    }
  }
  return hunkDocuments(patches);
}

function reverseApply(afterText: string, patches: StructuredPatch[]): string {
  const after = afterText.split("\n");
  const before: string[] = [];
  let cursor = 0;
  const hunks = [...patches].sort(
    (a, b) => a.newStart - b.newStart || a.oldStart - b.oldStart
  );
  for (const hunk of hunks) {
    const start = hunk.newStart <= 0 ? cursor : hunk.newStart - 1;
    if (start < cursor) throw new Error("overlap");
    before.push(...after.slice(cursor, start));
    let index = start;
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      const prefix = line[0];
      const body = line.slice(1);
      if (prefix === "+") {
        if (after[index] !== body) throw new Error("mismatch");
        index += 1;
      } else if (prefix === "-") {
        before.push(body);
      } else if (prefix === " ") {
        if (after[index] !== body) throw new Error("mismatch");
        before.push(body);
        index += 1;
      } else {
        throw new Error("prefix");
      }
    }
    cursor = index;
  }
  before.push(...after.slice(cursor));
  return before.join("\n");
}

function hunkDocuments(patches: StructuredPatch[]): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const hunk of patches) {
    for (const line of hunk.lines) {
      if (!line || line.startsWith("\\")) continue;
      const prefix = line[0];
      const body = line.slice(1);
      if (prefix === "+") after.push(body);
      else if (prefix === "-") before.push(body);
      else if (prefix === " ") {
        before.push(body);
        after.push(body);
      }
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

function readPatch(raw: unknown): StructuredPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const patch = raw as Record<string, unknown>;
  if (!Array.isArray(patch.lines) || !patch.lines.every((line) => typeof line === "string")) {
    return null;
  }
  return {
    oldStart: numberOrZero(patch.oldStart),
    oldLines: numberOrZero(patch.oldLines),
    newStart: numberOrZero(patch.newStart),
    newLines: numberOrZero(patch.newLines),
    lines: patch.lines as string[],
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface ConversationQueueItem {
  attachments?: ImageAttachment[];
  queueItemId: string;
  sourceCommandId?: string;
  kind?: string;
  text: string;
}

function readQueue(raw: unknown): ConversationQueueItem[] | undefined {
  const items = (raw as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  return items.flatMap(raw => {
    const item = raw as Partial<ConversationQueueItem> | null;
    return item && typeof item.queueItemId === "string" && typeof item.text === "string"
      ? [{ queueItemId: item.queueItemId, sourceCommandId: item.sourceCommandId, kind: item.kind, text: item.text, ...(readImageAttachments(item.attachments).length ? { attachments: readImageAttachments(item.attachments) } : {}) }] : [];
  });
}

/** Wire goal state from the conversation snapshot; the desktop renders its
 *  status card and iteration markers from the same data. */
export interface GoalState {
  objective: string;
  status: "active" | "paused" | "verifying" | "verified" | "notSatisfied" | "failed" | string;
  iteration: number;
  timeUsedSeconds: number;
  /** Server clock for the run in progress. The strip adds elapsed time locally. */
  activeRunStartedAtMs: number | null;
  verifications: Array<{ anchorTurnId?: string; anchorRowId?: number; iteration: number; passed: boolean }>;
}

/** The target store says "complete"; the conversation projection says "verified". */
function canonicalGoalStatus(status: string | undefined): string {
  if (status === "complete" || status === "completed") return "verified";
  return status || "active";
}

function normalizeGoal(raw: unknown, previous: GoalState | null = null): GoalState | null {
  if (raw == null) return null;
  if (typeof raw !== "object") return previous;
  const goal = raw as Record<string, unknown>;
  const stated = typeof goal.objective === "string" ? goal.objective : "";
  const objective = stated || previous?.objective || "";
  if (!objective) return null;
  const verifications: GoalState["verifications"] = [];
  if (Array.isArray(goal.verifications)) {
    for (const entry of goal.verifications) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const nested = item.verification && typeof item.verification === "object"
        ? item.verification as Record<string, unknown> : null;
      const outcome = typeof item.outcome === "string" ? item.outcome : "";
      verifications.push({
        ...(typeof item.anchorTurnId === "string" ? { anchorTurnId: item.anchorTurnId } : {}),
        ...(typeof item.anchorRowId === "number" ? { anchorRowId: item.anchorRowId } : {}),
        iteration: typeof item.iteration === "number" ? item.iteration
          : typeof item.goalIteration === "number" ? item.goalIteration : 0,
        passed: outcome === "pass" || (outcome !== "notSatisfied" && outcome !== "failed" && (nested ? nested.passed : item.passed) === true),
      });
    }
  }
  const iteration = typeof goal.iteration === "number" ? goal.iteration : verifications.length || previous?.iteration || 0;
  const activeRunStartedAtMs = goal.activeRunStartedAtMs === null ? null
    : typeof goal.activeRunStartedAtMs === "number" ? goal.activeRunStartedAtMs
    : previous?.activeRunStartedAtMs ?? null;
  return {
    objective,
    status: canonicalGoalStatus(typeof goal.status === "string" ? goal.status : previous?.status),
    iteration,
    timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : previous?.timeUsedSeconds ?? 0,
    activeRunStartedAtMs,
    verifications: Array.isArray(goal.verifications) ? verifications : previous?.verifications ?? [],
  };
}

export interface ConversationControl {
  phase?: "draft" | "prewarming" | "running" | "completedSuccess" | "completedInterrupted" | "error";
  canStop?: boolean;
  sessionEnded?: boolean;
  activeWorks?: Array<{ kind?: string; foregroundExecutionId?: string }>;
  lastError?: { message?: string } | null;
}

/** Apply a logical frame exactly once. Sequence bounds describe an atomic batch,
 * not individual strings; an overlapping batch cannot be safely sliced. */
export class ConversationReplica {
  rows: ConvRow[] = [];
  seq: number | null = null;
  logEpoch = "";
  revision?: number;
  needsSnapshot = false;
  control: ConversationControl | undefined;
  queue: ConversationQueueItem[] | undefined;
  goal: GoalState | null = null;

  constructor(readonly topic: string, readonly subscriptionId: string) {}

  receive(raw: unknown): "applied" | "ignored" | "resync" {
    const frame = raw as { topic?: string; subscriptionId?: string; fromSeq?: number; toSeq?: number;
      payload?: { kind?: string; snapshot?: { logEpoch?: string; seq?: number; control?: ConversationControl; queue?: unknown; goal?: unknown; rows?: { window?: unknown[] } }; deltas?: Array<{ op?: string; rowId?: number; patch?: { control?: ConversationControl; queue?: unknown; goal?: unknown } }> } };
    if (frame?.topic !== this.topic || frame.subscriptionId !== this.subscriptionId) return "ignored";
    const { fromSeq, toSeq, payload } = frame;
    if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq! < 0 || toSeq! < fromSeq!) return this.gap();
    if (payload?.kind === "snapshot") {
      const snapshot = payload.snapshot;
      if (!snapshot?.logEpoch || snapshot.seq !== toSeq || !Array.isArray(snapshot.rows?.window)) return this.gap();
      if (snapshot.logEpoch === this.logEpoch && this.seq !== null && toSeq! < this.seq) return "ignored";
      const applied = applyConversationFrame([], frame);
      this.rows = applied.rows;
      this.seq = toSeq!;
      this.logEpoch = snapshot.logEpoch;
      this.revision = applied.revision;
      this.needsSnapshot = false;
      this.control = snapshot.control;
      this.queue = readQueue(snapshot.queue);
      this.goal = normalizeGoal(snapshot.goal);
      return "applied";
    }
    if (payload?.kind !== "deltas" || !Array.isArray(payload.deltas)) return this.gap();
    if (this.needsSnapshot || this.seq === null) return this.gap();
    if (toSeq! <= this.seq) return "ignored";
    if (fromSeq !== this.seq) return this.gap();
    // A delta for a row missing from our window signals an incomplete snapshot.
    // Validate the whole batch before committing any of its operations.
    let rows = this.rows;
    for (const op of payload.deltas) {
      if (op.op === "row.delta" && !rows.some(row => row.rowId === op.rowId)) return this.gap();
      rows = applyConversationFrame(rows, { payload: { kind: "deltas", deltas: [op] } }).rows;
    }
    const applied = applyConversationFrame(this.rows, frame);
    this.rows = applied.rows;
    this.seq = toSeq!;
    this.revision = applied.revision ?? this.revision;
    for (const op of payload.deltas) {
      if (op.op === "state.updated" && op.patch?.control) this.control = op.patch.control;
      if (op.op === "state.updated" && op.patch?.queue !== undefined) this.queue = readQueue(op.patch.queue);
      if (op.op === "state.updated" && op.patch?.goal !== undefined) this.goal = normalizeGoal(op.patch.goal, this.goal);
    }
    return "applied";
  }

  private gap(): "resync" {
    this.needsSnapshot = true;
    return "resync";
  }
}
