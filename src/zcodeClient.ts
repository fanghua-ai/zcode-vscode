import { createHash } from "crypto";
import { uploadImage, readUploadedImage } from "./imageAttachments";
import { withRuntimeCompileCache } from "./runtimeCache";
import { readImageAttachments, type ImageAttachment } from "./attachmentTypes";
import { hostT as t, userFacingError } from "./hostI18n";
import { LocalizedError } from "./i18n";
import { ChildProcess, spawn } from "child_process";
import * as readline from "readline";
import { sameWorkspacePath } from "./workspacePath";
import { listWorkspacePathVariants, sessionsFinishedSince } from "./taskIndex";
import { logDebug, logError, logInfo, logWarn } from "./log";
import {
  ResolvedRuntime,
  ResolveResult,
  appServerEnv,
  buildAccountProviderSync,
  isDesktopOauthProvider,
  modelContextWindow,
  readPlanSelection,
  readConfiguredDefaultModel,
  resolveProviderRequestAuth,
  runtimeFromStoredProvider,
  sameDesktopLogin,
  listStoredProviderModels,
  workspaceObject,
} from "./desktop";
import { fetchPlanQuota, type PlanQuotaLimit, type QuotaLine, type PlanAuth } from "./credentials";
import { desktopVersion } from "./diagnostics";
import { appServerLaunch, startupExitMessage } from "./serverPath";
import { StartupTiming } from "./startupTiming";
import { FileChange, parseFileChange } from "./toolFiles";
import {
  ConvRow,
  RowTarget,
  ConversationReplica,
  slimRow,
  buildConversationView,
  createWireDecoder,
  readGitFiles,
  type GitFileChange,
  type ConversationQueueItem,
  type GoalState,
} from "./conversation";
import { parseGoalCommand, type GoalCommand } from "./goalCommand";
import { sameSessionModel, type NewSessionDefaults } from "./newSessionDefaults";

export interface ZCodeRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface ZCodeNotification {
  method: string;
  params?: unknown;
}

export interface ZCodeSuccessResponse {
  id: string | number;
  result: unknown;
}

export interface ZCodeErrorResponse {
  id: string | number;
  error: { code: number; message: string; data?: unknown };
}

export type ZCodeMessage =
  | ZCodeRequest
  | ZCodeNotification
  | ZCodeSuccessResponse
  | ZCodeErrorResponse;

export interface ZCodeRow {
  rowId: number;
  kind: string;
  [key: string]: unknown;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  status?: string;
  mode?: string;
  model?: { providerId: string; modelId: string; variant?: string };
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  workspacePath?: string;
}

export interface HistoryWork {
  text: string;
  durationMs?: number;
  interrupted?: boolean;
}

export type HistoryStep =
  | { kind: "reasoning"; text: string; partId?: string }
  | { kind: "text"; text: string; partId?: string }
  | { kind: "goal"; passed: boolean; iteration?: number }
  | { kind: "model"; from?: string; to?: string; fromProvider?: string; toProvider?: string }
  | {
      kind: "compact";
      status: "running" | "success" | "failed" | "noop" | "cancelled";
      origin?: "manual" | "auto";
    }
  | {
      kind: "tool";
      toolCallId?: string;
      toolName: string;
      status: string;
      inputText?: string;
      outputText?: string;
      fileChange?: FileChange;
    };

export interface HistoryItem {
  turnId?: string;
  rowId?: number;
  logEpoch?: string;
  attachments?: ImageAttachment[];
  attachmentTarget?: RowTarget;
  sourceCommandId?: string;
  id?: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: number;
  endedAt?: number;
  workDurationMs?: number;
  running?: boolean;
  work?: HistoryWork;
  steps?: HistoryStep[];
  tools: Array<{
    toolCallId?: string;
    toolName: string;
    status: string;
    inputText?: string;
    outputText?: string;
    fileChange?: FileChange;
  }>;
}

export interface AvailableModel {
  providerId: string;
  modelId: string;
  label: string;
  providerLabel?: string;
  disabledReason?: string;
}

interface SessionSnapshot {
  runtime?: { stateRevision?: number; eventSeq?: number };
  slashCommands?: Array<{ name?: string; description?: string; inputHint?: string; source?: string }>;
  projection?: {
    contextUsed?: number | null;
    contextWindow?: number | null;
  };
  usage?: {
    contextWindow?: {
      usedTokens?: number;
      maxTokens?: number;
    } | null;
  };
  session?: { sessionId?: string; title?: unknown; model?: unknown; mode?: string; planEnabled?: boolean };
  planEnabled?: boolean;
  settings?: {
    mode?: { current?: string };
    permission?: { mode?: string };
    planEnabled?: boolean;
    model?: {
      current?: unknown;
      lastUsed?: unknown;
      available?: Array<{
        ref?: { providerId?: string; modelId?: string };
        label?: string;
        providerLabel?: string;
        disabledReason?: string;
      }>;
    };
    thoughtLevel?: {
      enabled?: boolean;
      current?: string;
      defaultLevel?: string;
      available?: Array<{ value?: string; label?: string; description?: string }>;
    };
  };
}

export interface PermissionDecision {
  decision: "allow" | "deny" | "escalate" | "modify";
  reason?: string;
  modifiedInput?: unknown;
  permissionUpdates?: unknown[];
}

export interface PermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response?: PermissionDecision;
}

export interface PermissionRequest {
  rpcIds: Array<string | number>;
  requestId: string;
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
  reason?: string;
  riskLevel?: string;
  input?: unknown;
  options: PermissionOption[];
}

export interface UserInputQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{
    value: string;
    label: string;
    description?: string;
    preview?: string;
  }>;
}

export interface UserInputRequest {
  rpcIds: Array<string | number>;
  requestId: string;
  sessionId?: string;
  toolName?: string;
  prompt?: string;
  questions: UserInputQuestion[];
  schema?: unknown;
}

export interface SessionControls {
  mode: string;
  baseMode?: string;
  planEnabled?: boolean;
  thoughtEnabled: boolean;
  thoughtLevel?: string;
  thoughtLevels: Array<{ value: string; label: string; description?: string }>;
}

export interface ZCodeEvent {
  type:
    | "session_ready"
    | "session_error"
    | "sync_status"
    | "assistant_text"
    | "assistant_text_delta"
    | "assistant_reasoning_delta"
    | "tool_call"
    | "tool_result"
    | "status"
    | "user_input_echo"
    | "session_title"
    | "model_info"
    | "permission_request"
    | "user_input_request"
    | "session_controls"
    | "context_usage"
    | "transcript_sync"
    | "conversation_sync"
    | "queue_sync"
    | "goal_state"
    | "session_activity"
    | "session_defaults_warning"
    | "raw";
  data: unknown;
}

export interface ZCodeClientOptions {
  binaryPath: string;
  nodePath?: string;
  workspacePath: string;
  env?: Record<string, string>;
  compileCachePath?: string;
  runtime?: ResolvedRuntime;
  /** In-flight desktop login. Session attach waits for it, then reuses the key. */
  pendingLogin?: Promise<ResolveResult>;
  readDefaultModel?: () => { providerId: string; modelId: string } | undefined;
  resolveSessionRuntime?: (
    model: { providerId: string; modelId: string }
  ) => Promise<ResolvedRuntime | null | false>;
  isSessionModelAvailable?: (model: { providerId: string; modelId: string }) => Promise<boolean>;
  resolveProviderAuth?: typeof resolveProviderRequestAuth;
  readQuotaPlan?: typeof readPlanSelection;
  fetchPlanQuota?: typeof fetchPlanQuota;
  fetchProviderQuota?: (providerId: string) => Promise<QuotaLine[] | null>;
  rememberedModel?: (sessionId: string) =>
    | { providerId: string; modelId: string }
    | undefined;
  onEvent: (event: ZCodeEvent) => void;
}

interface HistoryDelivery {
  sessionId: string;
  generation: number;
  epoch: string;
  seq: number | null;
  rows: readonly ConvRow[];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  method?: string;
  timing?: StartupTiming;
}

const BASE_SESSION_MODES = new Set(["build", "edit", "yolo", "auto"]);

function readPlanFlag(source: unknown): boolean | undefined {
  if (!source || typeof source !== "object") return undefined;
  const row = source as { planEnabled?: unknown; mode?: unknown };
  if (typeof row.planEnabled === "boolean") return row.planEnabled;
  if (row.mode === "plan") return true;
  if (row.mode && typeof row.mode === "object" && (row.mode as { current?: unknown }).current === "plan") return true;
  return undefined;
}

function readBaseSessionMode(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const row = source as { mode?: unknown; permission?: { mode?: unknown } };
  const current = typeof row.mode === "string"
    ? row.mode
    : (row.mode as { current?: unknown } | undefined)?.current;
  if (typeof current === "string" && BASE_SESSION_MODES.has(current)) return current;
  if (typeof row.permission?.mode === "string" && BASE_SESSION_MODES.has(row.permission.mode)) return row.permission.mode;
  return undefined;
}

export class ZCodeClient {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private errRl: readline.Interface | null = null;
  private msgId = 1;
  private pending = new Map<string | number, Pending>();
  private sessionId: string | null = null;
  private historyCache: { sessionId: string; items: HistoryItem[] } | null = null;
  private static readonly historyPage = 200;
  private readonly opts: ZCodeClientOptions;
  private seenRowIds = new Set<number>();
  private seenToolCallIds = new Set<string>();
  private killTimer: NodeJS.Timeout | null = null;
  private lastTitle = "";
  /** Builtin /goal-style commands advertised by the session snapshot. */
  private slashCommands: Array<{ name: string; description: string; inputHint: string }> = [];
  private defaultRuntime: ResolvedRuntime | null;
  private sessionRuntime: ResolvedRuntime | null;
  private runtimeNeedsRevalidation = false;
  private pendingPermissions = new Map<string, PermissionRequest>();
  private pendingUserInputs = new Map<string, UserInputRequest>();
  private lastControls: SessionControls = {
    mode: "build",
    thoughtEnabled: false,
    thoughtLevels: [],
  };
  /** Permission mode under plan. Desktop keeps this separate from planEnabled. */
  private baseMode = "build";
  private planEnabled = false;
  private readonly sessionControlStates = new Map<string, {baseMode:string; planEnabled:boolean}>();
  private sessionModel: { providerId: string; modelId: string } | null = null;
  private stopping = false;
  private stopEpoch = 0;
  private stopInFlight = false;
  private stopWatch: NodeJS.Timeout | null = null;
  private acceptLive = true;
  private sessionChanges: Promise<unknown> = Promise.resolve();
  private sessionGeneration = 0;
  private disposed = false;

  /** A returned response belongs to this attachment, including A → B → A switches. */
  private sessionScope(): () => boolean {
    const sessionId = this.sessionId;
    const generation = this.sessionGeneration;
    return () => !this.disposed && this.sessionId === sessionId && this.sessionGeneration === generation;
  }

  private serializeSessionChange<T>(change: () => Promise<T>): Promise<T> {
    const result = this.sessionChanges.then(() => {
      if (this.disposed) throw new LocalizedError("ZCode 客户端已关闭");
      return change();
    });
    this.sessionChanges = result.catch(() => undefined);
    return result;
  }
  /** Events held while switching, replayed after the history is rendered. */
  private heldSessionEvents: unknown[] = [];
  private startupError: Error | null = null;
  private serverReady = false;
  private spawnedAt = 0;
  private activeTiming: StartupTiming | undefined;
  /** Same provider already has a key. A 401 makes the next align exchange a fresh one. */
  private loginStale = false;
  /** session/subscribe just applied settings, so the follow-up reads can reuse them. */
  private snapshotSettingsFresh = false;
  private snapshotModelFresh = false;
  private historyDelivery: HistoryDelivery | null = null;
  private readonly historyVersions = new WeakMap<readonly unknown[], HistoryDelivery>();
  private startupLoginConsumed = false;
  private startupSessions: SessionSummary[] | undefined;
  private sessionListSupportsArchived = true;
  private stderrLines: string[] = [];
  private liveModelReady = false;
  private lastRevision = 0;
  private conversationRevision: number | null = null;
  private lastLogEpoch = "";
  private conversationRows: ConvRow[] = [];
  private wireDecoder = createWireDecoder();
  private conversationViewKey = "";
  private queueViewKey = "";
  private goalViewKey = "";
  private projectionStatusKey = "";
  private conversationTopic = "";
  private conversationSubId = "";
  private conversationGen = 0;
  private replica: ConversationReplica | null = null;
  private pendingConversationFrames: unknown[] | null = null;
  private resyncGeneration: number | null = null;
  private resyncFailures = 0;
  private resyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private projectionTruncated = false;
  private historyRowIds = new Map<string, number>();
  private snapshotWait: (() => void) | null = null;
  private lastContext: { used: number; max: number } | null = null;
  private modelWindow: number | null = null;
  private lastQuota: QuotaLine[] = [];
  private lastQuotaProviderId: string | undefined;
  private lastPlanQuota: PlanQuotaLimit[] = [];
  private quotaTimer: NodeJS.Timeout | null = null;
  private quotaRequest = 0;
  private quotaStarted = false;
  private viewVisible = true;
  private readonly desktopAppVersion: string | null;

  constructor(opts: ZCodeClientOptions) {
    this.opts = opts;
    this.desktopAppVersion = desktopVersion(opts.binaryPath);
    this.defaultRuntime = opts.runtime ?? null;
    this.sessionRuntime = opts.runtime ?? null;
  }

  async uploadImage(bytes: Buffer, fileName: string, sessionId = this.sessionId): Promise<ImageAttachment> {
    if (!sessionId) throw new LocalizedError("没有活动会话，请先启动 ZCode。");
    return uploadImage((method,params,timeout) => this.sendRequest(method,params,timeout), sessionId,fileName,bytes);
  }

  async readImage(attachment: ImageAttachment, sessionId: string, selection?: {target: RowTarget; attachmentIndex: number}): Promise<Buffer> {
    return readUploadedImage((method, params, timeout) => this.sendRequest(method, params, timeout), attachment, sessionId, selection);
  }

  diagnosticSummary() {
    return {
      binaryPath: this.opts.binaryPath,
      nodePath: this.opts.nodePath || process.execPath,
      serverReady: this.serverReady,
      sessionAttached: !!this.sessionId,
      synchronizationFailures: this.resyncFailures,
      pendingPermissions: this.pendingPermissions.size,
      pendingQuestions: this.pendingUserInputs.size,
    };
  }

  setSessionRuntime(runtime: ResolvedRuntime): void {
    // Stage credentials for the switch; the model remains the last confirmed
    // selection until the backend accepts it or a snapshot reconciles it.
    this.sessionRuntime = runtime;
    this.liveModelReady = false;
  }

  private setSessionModel(model: { providerId: string; modelId: string } | null, publish = true): void {
    const previousProviderId = this.sessionModel?.providerId;
    this.sessionModel = model;
    if (previousProviderId !== model?.providerId) {
      // Ignore pending responses for the old provider and display the ZCode
      // plan quota until the newly selected provider returns its own balance.
      this.quotaRequest++;
      if (publish) this.publishUsage();
    }
  }

  setDefaultRuntime(runtime: ResolvedRuntime): void {
    this.defaultRuntime = runtime;
  }

  setTiming(timing: StartupTiming | undefined): void {
    this.activeTiming = timing;
  }

  clearTiming(timing: StartupTiming): void {
    if (this.activeTiming === timing) this.activeTiming = undefined;
  }

  hasFreshSessionSettings(): boolean {
    return this.snapshotSettingsFresh;
  }

  hasFreshSessionModel(): boolean {
    return this.snapshotModelFresh;
  }

  noteHistoryDelivered(items?: readonly unknown[]): void {
    if (!this.sessionId) return;
    this.historyDelivery = items ? this.historyVersions.get(items) ?? null : this.historyVersion();
    this.activeTiming?.mark("historyPostedMs");
  }

  private historyVersion(): HistoryDelivery {
    return { sessionId: this.sessionId!, generation: this.sessionGeneration,
      epoch: this.replica?.logEpoch ?? "", seq: this.replica?.seq ?? null, rows: this.conversationRows };
  }

  takeStartupSessions(): SessionSummary[] | undefined {
    const listed = this.startupSessions;
    this.startupSessions = undefined;
    return listed?.some(session => session.sessionId === this.sessionId) ? listed : undefined;
  }

  historyDelivered(sessionId?: string | null): boolean {
    return !!sessionId
      && this.historyDelivery?.sessionId === sessionId
      && this.historyDelivery.generation === this.sessionGeneration
      && this.historyDelivery.epoch === (this.replica?.logEpoch ?? "")
      && this.historyDelivery.seq === (this.replica?.seq ?? null)
      && this.historyDelivery.rows === this.conversationRows;
  }

  private reusableRuntime(model: { providerId: string }): ResolvedRuntime | null {
    if (this.loginStale) return null;
    for (const runtime of [this.sessionRuntime, this.defaultRuntime]) {
      if (runtime && sameDesktopLogin(runtime, model.providerId)) return runtime;
    }
    return null;
  }

  private async awaitStartupLogin(): Promise<void> {
    const pending = this.opts.pendingLogin;
    if (!pending || this.startupLoginConsumed) return;
    try {
      const resolved = await pending;
      if (this.startupLoginConsumed || this.disposed) return;
      this.startupLoginConsumed = true;
      if (this.loginStale || !resolved.ok || !resolved.runtime?.apiKey) return;
      this.defaultRuntime = this.defaultRuntime ?? resolved.runtime;
      if (!this.sessionRuntime?.apiKey) this.sessionRuntime = resolved.runtime;
    } catch (e) {
      this.startupLoginConsumed = true;
      logWarn("startup login failed", e);
    }
  }

  private async alignSessionRuntime(model: {
    providerId: string;
    modelId: string;
  }): Promise<void> {
    const isCurrent = this.sessionScope();
    const previousProviderId = this.sessionModel?.providerId;
    this.setSessionModel(model, false);
    await this.awaitStartupLogin();
    if (!isCurrent()) return;
    if (previousProviderId !== model.providerId) this.publishUsage();
    const reusable = this.reusableRuntime(model);
    const revalidateCachedRuntime = this.runtimeNeedsRevalidation;
    this.runtimeNeedsRevalidation = false;
    if (this.opts.resolveSessionRuntime && (revalidateCachedRuntime || !reusable)) {
      const alignStarted = Date.now();
      try {
        const resolved = await this.opts.resolveSessionRuntime(model);
        this.activeTiming?.add("alignLogin", Date.now() - alignStarted);
        if (!isCurrent()) return;
        if (resolved === false) {
          this.sessionRuntime = null;
          logWarn("Desktop disabled or removed this session model", model);
          return;
        }
        if (resolved) {
          this.loginStale = false;
          this.sessionRuntime = { ...resolved, modelId: model.modelId };
          logInfo("Reusing desktop login for session model", {
            providerId: model.providerId,
            modelId: model.modelId,
            source: resolved.source,
          });
          return;
        }
      } catch (e) {
        this.activeTiming?.add("alignLogin", Date.now() - alignStarted);
        logWarn("Could not resolve desktop login for session model", e);
      }
    }
    if (!isCurrent()) return;
    // Desktop inventory is authoritative when a different session attaches;
    // this cached key has now been checked against that inventory.
    if (reusable) {
      this.sessionRuntime = { ...reusable, modelId: model.modelId };
      this.activeTiming?.addCount("loginReuse");
      return;
    }
    if (this.loginStale) {
      // Resolving failed: never restore the cached key that caused the 401.
      this.sessionRuntime = null;
      logWarn("No refreshed desktop login for session model", model);
      return;
    }
    if (this.sessionRuntime?.providerId === model.providerId) {
      this.sessionRuntime = { ...this.sessionRuntime, modelId: model.modelId };
      return;
    }
    if (this.defaultRuntime?.providerId === model.providerId) {
      this.sessionRuntime = { ...this.defaultRuntime, modelId: model.modelId };
      return;
    }
    if (isDesktopOauthProvider(model.providerId)) {
      this.sessionRuntime = null;
      logWarn("No current desktop login for this session's coding-plan model", model);
      return;
    }
    this.sessionRuntime = runtimeFromStoredProvider(
      model.providerId,
      model.modelId
    );
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get currentTitle(): string {
    return this.lastTitle;
  }

  async start(opts?: {
    resumeSessionId?: string;
    createNew?: boolean;
    applyModel?: boolean;
    newSessionDefaults?: NewSessionDefaults;
    chooseResume?: (
      listed: SessionSummary[],
      rejected: ReadonlySet<string>
    ) => string | undefined;
  }): Promise<void> {
    const { binaryPath, nodePath, workspacePath } = this.opts;

    const launch = appServerLaunch({
      binaryPath,
      nodePath,
      execPath: process.execPath,
    });
    const cmd = launch.command;
    const args = launch.args;

    const env = withRuntimeCompileCache({
      ...process.env,
      ...appServerEnv(binaryPath),
      ...(this.opts.env ?? {}),
    }, this.opts.compileCachePath);
    this.activeTiming?.note("runtimeCompileCacheRequested", !!env.NODE_COMPILE_CACHE && env.NODE_DISABLE_COMPILE_CACHE !== "1");
    if (launch.electronAsNode) env.ELECTRON_RUN_AS_NODE = "1";

    logInfo("Starting app-server", { cmd, args, cwd: workspacePath });

    this.startupError = null;
    this.serverReady = false;
    this.stderrLines = [];
    this.spawnedAt = Date.now();
    this.proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: workspacePath,
    });
    const proc = this.proc;

    proc.on("error", (err: NodeJS.ErrnoException) => {
      this.failStartup(
        new Error(
          startupExitMessage({
            spawnCode: err.code,
            command: cmd,
            binaryPath,
            stderr: err.message,
          })
        )
      );
    });
    proc.on("exit", (code, signal) => {
      logWarn("app-server exited", { code, signal });
      this.opts.onEvent({
        type: "status",
        data: { status: "exited", code, signal },
      });
      if (!this.serverReady) {
        this.failStartup(
          new Error(
            startupExitMessage({
              stderr: this.stderrLines.join("\n"),
              code,
              signal,
              binaryPath,
            })
          )
        );
        return;
      }
      this.failPending(new Error("ZCode process exited"));
    });

    if (!proc.stdout || !proc.stdin || !proc.stderr) {
      throw new LocalizedError("无法打开 ZCode 标准输入输出管道");
    }

    this.errRl = readline.createInterface({
      input: proc.stderr,
      crlfDelay: Infinity,
    });
    this.errRl.on("line", (line) => {
      this.stderrLines.push(line);
      if (this.stderrLines.length > 40) this.stderrLines.shift();
      if (/error|fail|unauthorized|denied|cannot find module/i.test(line)) {
        logWarn("[stderr] " + line);
      } else {
        logDebug("[stderr] " + line);
      }
    });

    this.rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });
    this.rl.on("line", (line) => this.handleLine(line));
    const accountSync = this.syncAccountProviders();
    if (opts?.createNew) {
      await accountSync;
      await this.createSession(true, opts.newSessionDefaults);
      return;
    }
    try {
      await this.openStartupSession(opts);
    } finally {
      await accountSync;
    }
  }

  private async openStartupSession(opts?: {
    resumeSessionId?: string;
    newSessionDefaults?: NewSessionDefaults;
    chooseResume?: (
      listed: SessionSummary[],
      rejected: ReadonlySet<string>
    ) => string | undefined;
  }): Promise<void> {
    let listed: SessionSummary[] | undefined;
    try {
      listed = await this.listSessions(true);
      this.startupSessions = listed;
    } catch (e) {
      if (this.startupError) throw this.startupError;
      logWarn("session/list failed during startup", e);
    }
    if (!listed) {
      if (opts?.resumeSessionId) {
        try {
          logInfo("Resuming remembered session", opts.resumeSessionId);
          await this.resumeSession(opts.resumeSessionId);
          return;
        } catch (e) {
          if (this.startupError) throw this.startupError;
          logWarn("Remembered session could not be resumed", e);
        }
      }
      await this.createSession(true, opts?.newSessionDefaults);
      return;
    }

    const rejected = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = opts?.chooseResume
        ? opts.chooseResume(listed, rejected)
        : attempt === 0
          ? opts?.resumeSessionId ?? listed.find((s) => !rejected.has(s.sessionId))?.sessionId
          : listed.find((s) => !rejected.has(s.sessionId))?.sessionId;
      if (!sessionId || rejected.has(sessionId)) break;
      try {
        logInfo("Resuming session", sessionId);
        const known = listed.find((session) => session.sessionId === sessionId);
        await this.resumeSession(sessionId, known);
        return;
      } catch (e) {
        if (this.startupError) throw this.startupError;
        logWarn("Session could not be resumed", e);
        rejected.add(sessionId);
      }
    }
    await this.createSession(true, opts?.newSessionDefaults);
  }

  private async syncAccountProviders(): Promise<void> {
    const payload = buildAccountProviderSync(this.opts.binaryPath);
    if (!payload) return;
    const started = Date.now();
    try {
      await this.sendRequest("provider/updateAccountConfig", payload);
      this.activeTiming?.add("provider/updateAccountConfig", Date.now() - started);
    } catch (e) {
      this.activeTiming?.add("provider/updateAccountConfig", Date.now() - started);
      if (this.startupError) throw this.startupError;
      logWarn("Could not sync ZCode account providers", e);
    }
  }

  private failStartup(error: Error): void {
    if (!this.startupError) this.startupError = error;
    this.failPending(this.startupError);
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private ws() {
    return workspaceObject(this.opts.workspacePath);
  }

  async listSessions(includeArchived = false): Promise<SessionSummary[]> {
    const started = Date.now();
    try {
      const paths = listWorkspacePathVariants(this.opts.workspacePath);
      const results = await Promise.all(paths.map(async workspacePath => {
        const params = { workspace: workspaceObject(workspacePath), limit: 80 };
        try {
          return await this.sendRequest("session/list", {
            ...params, ...(this.sessionListSupportsArchived ? { includeArchived } : {}),
          }, 20000) as { sessions?: unknown[] };
        } catch (error) {
          // Desktop 3.16.2 removed this optional field from its strict schema.
          const message = error instanceof Error ? error.message : "";
          if (!/ZCode error -32602:/.test(message) ||
              !/Unrecognized key[^\n]*["']includeArchived["']/i.test(message)) throw error;
          this.sessionListSupportsArchived = false;
          return await this.sendRequest("session/list", params, 20000) as { sessions?: unknown[] };
        }
      }));
      const byId = new Map<string, SessionSummary>();
      for (const result of results) {
        for (const raw of result?.sessions ?? []) {
          const session = this.normalizeSession(raw);
          if (!session?.sessionId || (session.workspacePath && !sameWorkspacePath(session.workspacePath, this.opts.workspacePath))) continue;
          if (!includeArchived && session.archivedAt) continue;
          const previous = byId.get(session.sessionId);
          if (!previous || (session.updatedAt ?? 0) > (previous.updatedAt ?? 0)) byId.set(session.sessionId, session);
        }
      }
      const sessions = [...byId.values()];
      sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return sessions;
    } finally {
      this.activeTiming?.add("session/list", Date.now() - started);
      this.activeTiming?.addCount("sessionListCount");
    }
  }

  private normalizeSession(raw: unknown): SessionSummary | null {
    const s = raw as {
      sessionId?: string;
      id?: string;
      title?: string;
      status?: string;
      mode?: string;
      createdAt?: number;
      updatedAt?: number;
      archivedAt?: number;
      model?: { providerId?: string; modelId?: string; variant?: string };
      workspace?: { workspacePath?: string; workspaceKey?: string };
    };
    const sessionId = s?.sessionId ?? s?.id;
    if (!sessionId) return null;
    return {
      sessionId: String(sessionId),
      title: extractTitle(s) || "新会话",
      status: s.status,
      mode: s.mode,
      model:
        s.model?.providerId && s.model?.modelId
          ? {
              providerId: s.model.providerId,
              modelId: s.model.modelId,
              variant: s.model.variant,
            }
          : undefined,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      archivedAt: s.archivedAt,
      workspacePath: s.workspace?.workspacePath ?? s.workspace?.workspaceKey,
    };
  }

  private async createSession(applyModel: boolean, newSessionDefaults?: NewSessionDefaults): Promise<void> {
    // The desktop login may still be exchanging while the process starts. A new
    // session must be configured from that login, not from a missing default.
    await this.awaitStartupLogin();
    if (this.disposed) return;
    this.releaseStopWait();
    this.runtimeNeedsRevalidation = true;
    this.sessionGeneration++;
    this.snapshotSettingsFresh = false;
    this.snapshotModelFresh = false;
    this.attachSessionControls();
    this.stopping = false;
    this.sessionId = null;
    this.lastContext = null;
    this.modelWindow = null;
    this.setSessionModel(null);
    this.historyCache = null;
    this.seenRowIds.clear();
    this.seenToolCallIds.clear();
    this.lastTitle = "新会话";
    this.liveModelReady = false;

    const createdRuntime = this.defaultRuntime;
    this.setSessionModel(createdRuntime ? { providerId: createdRuntime.providerId, modelId: createdRuntime.modelId } : null);
    this.sessionRuntime = createdRuntime;
    await this.sendRequest("session/create", {
      workspace: this.ws(),
      mode: "build",
    });

    if (!this.sessionId) {
      this.opts.onEvent({
        type: "session_error",
        data: {
          message:
            "Session created but sessionId was not captured from requestRuntimePreferences",
        },
      });
      return;
    }

    await this.afterSessionAttached("created", applyModel, createdRuntime, undefined, newSessionDefaults);
  }

  async resumeSession(sessionId: string, known?: SessionSummary): Promise<void> {
    return this.serializeSessionChange(() => this.resumeSessionInner(sessionId, known));
  }

  private async resumeSessionInner(sessionId: string, known?: SessionSummary): Promise<void> {
    const changingSession = this.sessionId !== sessionId;
    this.releaseStopWait();
    this.runtimeNeedsRevalidation = true;
    this.sessionGeneration++;
    this.snapshotSettingsFresh = false;
    this.snapshotModelFresh = false;
    this.attachSessionControls(sessionId);
    this.stopping = false;
    if (changingSession) {
      this.historyCache = null;
      this.lastContext = null;
      this.modelWindow = null;
      this.setSessionModel(null);
    }
    this.sessionId = sessionId;
    this.seenRowIds.clear();
    this.seenToolCallIds.clear();
    this.lastTitle = "";
    this.liveModelReady = false;

    try {
      const mine = known?.sessionId === sessionId
        ? known
        : (await this.listSessions(true)).find((s) => s.sessionId === sessionId);
      this.applyListedSessionMeta(mine);
      const model =
        mine?.model || this.opts.rememberedModel?.(sessionId);
      if (model) await this.alignAndEmitModel(model);
    } catch (e) {
      logWarn("Could not align runtime before resume", e);
    }

    const resumeStarted = Date.now();
    const resumedSnapshot = await this.sendRequest("session/resume", {
      sessionId,
      workspace: this.ws(),
    });
    this.activeTiming?.add("session/resume", Date.now() - resumeStarted);

    this.sessionId = sessionId;
    await this.afterSessionAttached("resumed", false, null, resumedSnapshot as SessionSnapshot | undefined);
    if (!this.liveModelReady || !this.lastTitle) await this.adoptResumedModel();
  }

  async prepareViewChange(): Promise<void> {
    this.acceptLive = false;
    this.heldSessionEvents = [];
  }

  endViewChange(): void {
    if (this.acceptLive) return;
    this.acceptLive = true;
    this.stopping = false;
    this.seenToolCallIds.clear();
    const held = this.heldSessionEvents;
    this.heldSessionEvents = [];
    for (const params of held) this.handleSessionEvent(params, true);
    if (this.replica?.seq !== null && this.replica?.topic === `conversation/${this.sessionId}`) {
      this.reconcileProjectionActivity();
      if (!this.historyDelivered(this.sessionId)) this.publishTranscript();
      this.publishQueue();
      this.publishGoal();
      this.publishProjectionStatus(true);
    }
    this.replayPendingInteractions();
  }

  private replayPendingInteractions(): void {
    for (const request of this.pendingPermissions.values()) {
      if (request.sessionId !== this.sessionId) continue;
      this.opts.onEvent({ type: "permission_request", data: request });
    }
    for (const request of this.pendingUserInputs.values()) {
      if (request.sessionId !== this.sessionId) continue;
      this.opts.onEvent({ type: "user_input_request", data: request });
    }
  }

  private shouldShowInteraction(owner?: string): boolean {
    if (!this.acceptLive || !this.sessionId) return false;
    return !!owner && owner === this.sessionId;
  }

  async newSession(defaults?: NewSessionDefaults): Promise<void> {
    return this.serializeSessionChange(() => this.createSession(true, defaults));
  }

  async switchSession(sessionId: string): Promise<{
    items: HistoryItem[];
    truncated: boolean;
  }> {
    return this.serializeSessionChange(async () => {
      await this.resumeSessionInner(sessionId);
      return this.loadHistory();
    });
  }

  private async afterSessionAttached(
    kind: "created" | "resumed",
    applyModel: boolean,
    createdRuntime: ResolvedRuntime | null = null,
    resumedSnapshot?: SessionSnapshot,
    newSessionDefaults?: NewSessionDefaults
  ): Promise<void> {
    if (!this.sessionId) return;
    this.lastContext = null;
    this.modelWindow = null;
    const requestedRuntime = kind === "created" && applyModel ? createdRuntime : null;
    const reusableSnapshot = kind === "resumed"
      && resumedSnapshot?.session?.sessionId === this.sessionId
      && Number.isSafeInteger(resumedSnapshot.runtime?.eventSeq)
      && (resumedSnapshot.runtime?.eventSeq ?? -1) >= 0
      && !!resumedSnapshot.settings;
    const isCurrent = this.sessionScope();
    let attachedSnapshot: SessionSnapshot | undefined;
    try {
      const subscribeStarted = Date.now();
      const sub = ((await this.sendRequest("session/subscribe", {
        sessionId: this.sessionId,
        deliveryKind: "desktop-continuous",
        afterSeq: 0,
        includeSnapshot: !reusableSnapshot,
      })) ?? {}) as {
        snapshot?: SessionSnapshot;
        eventSeq?: number;
        session?: { title?: unknown; model?: unknown };
      };
      this.activeTiming?.add("session/subscribe", Date.now() - subscribeStarted);
      if (!isCurrent()) return;
      if (reusableSnapshot && !sub?.snapshot) {
        // Subscribe still replays interactions. Only reuse unchanged metadata;
        // a running task may have advanced while the subscription was pending.
        const unchanged = sub?.eventSeq === resumedSnapshot?.runtime?.eventSeq
          && typeof resumedSnapshot?.runtime?.stateRevision === "number"
          && resumedSnapshot.runtime.stateRevision >= this.lastRevision;
        sub.snapshot = unchanged ? resumedSnapshot : await this.readSessionSnapshot();
        if (!isCurrent()) return;
        this.activeTiming?.addCount(unchanged ? "resumeSnapshotReuse" : "resumeSnapshotRefresh");
      }
      this.adoptTitle(
        extractTitle(sub?.snapshot?.session) || extractTitle(sub?.session)
      );
      attachedSnapshot = sub?.snapshot;
      this.slashCommands = (attachedSnapshot?.slashCommands ?? [])
        .filter((command): command is { name: string; description: string; inputHint: string } =>
          typeof command?.name === "string" && command.name.length > 0)
        .map(command => ({
          name: command.name,
          description: typeof command.description === "string" ? command.description : "",
          inputHint: typeof command.inputHint === "string" ? command.inputHint : `/${command.name}`,
        }));
      this.applySnapshotSettings(sub?.snapshot);
      if (sub?.snapshot) this.noteSnapshotCompleteness(sub.snapshot);
      this.noteRevision(sub?.snapshot?.runtime?.stateRevision);
      const snapModel = extractModel(
        sub?.snapshot?.session?.model ||
          sub?.snapshot?.settings?.model?.current ||
          sub?.session?.model
      );
      if (snapModel) {
        await this.alignAndEmitModel(snapModel);
        this.liveModelReady = true;
      }
    } catch (e) {
      logWarn("session/subscribe failed", e);
    }

    try {
      if (kind === "created" && !this.liveModelReady && attachedSnapshot?.settings?.model?.available?.length === 0) {
        // Announce the created identity first: the host persists its workspace
        // metadata on session_ready. Configuring a shell before that can make
        // even valid providers appear absent from the workspace registry.
      } else if (!this.liveModelReady && requestedRuntime) {
        // Login configuration is not the workspace registry. Only use its
        // provider identifier when the server actually advertises that model.
        const available = attachedSnapshot ? modelsFromSnapshot(attachedSnapshot).available : [];
        const registered = available.find(model => !model.disabledReason &&
          model.providerId === requestedRuntime.providerId && model.modelId === requestedRuntime.modelId);
        if (registered) await this.setModel(registered.providerId, registered.modelId);
        else await this.ensureSessionModel();
      } else await this.ensureSessionModel();
    } catch (e) {
      logWarn("Could not apply model to session", e);
      if (kind === "created") {
        // Model setup may fail while the new conversation itself is usable.
        // Attach its replica so choosing another model can recover this session.
        try { await this.subscribeConversation(); }
        catch (syncError) { logWarn("Could not attach failed session for recovery", syncError); }
        throw e;
      }
    }

    if (!this.lastTitle) this.lastTitle = "新会话";
    const hasNewDefaults = kind === "created" && !!newSessionDefaults
      && Object.keys(newSessionDefaults).length > 0;
    if (hasNewDefaults) {
      // Index the identity before applying explicit defaults. Cold workspaces
      // can populate their model registry only after the host persists it.
      this.opts.onEvent({
        type: "session_title",
        data: { title: this.lastTitle, sessionId: this.sessionId },
      });
      if (!this.liveModelReady) {
        try { await this.ensureSessionModel(); }
        catch (error) {
          try { await this.subscribeConversation(); }
          catch (syncError) { logWarn("Could not attach failed session for recovery", syncError); }
          throw error;
        }
      }
      await this.applyNewSessionDefaults(newSessionDefaults!);
    }
    this.activeTiming?.mark("sessionAttachedMs");
    this.opts.onEvent({
      type: "session_ready",
      data: { sessionId: this.sessionId, kind, title: this.lastTitle, slashCommands: this.slashCommands },
    });
    if (!hasNewDefaults) {
      this.opts.onEvent({
        type: "session_title",
        data: { title: this.lastTitle, sessionId: this.sessionId },
      });
      if (kind === "created" && !this.liveModelReady) {
        // session_title has now let the host index this identity. Resolve the
        // advertised/CLI default here so reasoning controls are ready on return.
        try { await this.ensureSessionModel(); }
        catch (error) {
          try { await this.subscribeConversation(); }
          catch (syncError) { logWarn("Could not attach failed session for recovery", syncError); }
          throw error;
        }
      }
    }
    await this.emitSessionControls();
    this.startPlanQuota();
    await this.subscribeConversation();
  }

  private async applyNewSessionDefaults(defaults: NewSessionDefaults): Promise<void> {
    const warn = (message: string) => this.opts.onEvent({ type: "session_defaults_warning", data: { message } });
    let requestedModelApplied = !defaults.model || sameSessionModel(defaults.model, this.sessionModel);
    if (defaults.model && !sameSessionModel(defaults.model, this.sessionModel)) {
      const isCurrent = this.sessionScope();
      try {
        // The session snapshot's advertised catalog can lag or omit models
        // that are selectable from the desktop/configured provider catalog.
        // Treat the saved choice like a manual model selection and let the
        // backend command decide whether it is actually usable.
        const runtime = await this.opts.resolveSessionRuntime?.(defaults.model);
        if (!isCurrent()) return;
        if (runtime === false) {
          requestedModelApplied = false;
          warn("新会话默认模型当前不可用，已沿用 ZCode 默认模型。");
        } else {
          if (runtime) this.sessionRuntime = { ...runtime, modelId: defaults.model.modelId };
          await this.setModel(defaults.model.providerId, defaults.model.modelId);
          requestedModelApplied = true;
        }
      } catch (error) {
        requestedModelApplied = false;
        logWarn("Could not apply new-session model default", error);
        warn("新会话默认模型未能应用，已沿用 ZCode 默认模型。");
      }
    }

    if (defaults.mode && defaults.mode !== this.currentMode()) {
      try {
        await this.setMode(defaults.mode);
      } catch (error) {
        logWarn("Could not apply new-session permission default", error);
        warn("新会话权限默认值未能应用，已沿用 ZCode 默认设置。");
      }
    }

    if (defaults.thoughtLevel && requestedModelApplied && defaults.thoughtLevel !== this.lastControls.thoughtLevel) {
      const supported = this.lastControls.thoughtEnabled
        && this.lastControls.thoughtLevels.some(level => level.value === defaults.thoughtLevel);
      if (!supported) {
        warn("所选模型不支持该推理强度，已使用模型默认值。");
      } else {
        try {
          await this.setThoughtLevel(defaults.thoughtLevel);
        } catch (error) {
          logWarn("Could not apply new-session reasoning default", error);
          warn("所选模型未能应用该推理强度，已使用模型默认值。");
        }
      }
    }
  }

  private adoptTitle(title: string | undefined): void {
    const next = title?.trim();
    if (!next) return;
    this.lastTitle = next;
  }

  private attachSessionControls(sessionId?: string): void {
    if (this.sessionId) this.sessionControlStates.set(this.sessionId, {baseMode:this.baseMode, planEnabled:this.planEnabled});
    const saved = sessionId ? this.sessionControlStates.get(sessionId) : undefined;
    this.baseMode = saved?.baseMode ?? "build";
    this.planEnabled = saved?.planEnabled ?? false;
    this.lastControls = {...this.lastControls, mode:this.displayedMode(), baseMode:this.baseMode, planEnabled:this.planEnabled};
  }

  private displayedMode(): string {
    return this.planEnabled ? "plan" : this.baseMode || "build";
  }

  /** Returns whether the plan flag or the base permission mode changed. */
  private adoptPlanState(source: unknown): boolean {
    const plan = readPlanFlag(source);
    const base = readBaseSessionMode(source);
    const previousPlan = this.planEnabled;
    const previousBase = this.baseMode;
    // Session lists and snapshots also carry projection.mode, which stays at
    // its default "build". That string is not the saved permission. A real
    // mode change includes planEnabled, and settings use mode.current.
    const row = source && typeof source === "object"
      ? source as { mode?: unknown; planEnabled?: unknown }
      : undefined;
    const bareProjectionMode = typeof row?.mode === "string" && typeof row.planEnabled !== "boolean";
    if (base && !bareProjectionMode) this.baseMode = base;
    if (plan !== undefined) this.planEnabled = plan;
    return this.planEnabled !== previousPlan || this.baseMode !== previousBase;
  }

  private applySnapshotSettings(snapshot: SessionSnapshot | undefined): void {
    this.emitContextUsage(snapshot);
    if (!snapshot?.settings) return;
    const thought = snapshot.settings.thoughtLevel;
    const available = (thought?.available ?? this.lastControls.thoughtLevels)
      .filter((row) => !!row.value)
      .map((row) => ({
        value: String(row.value),
        label: row.label || String(row.value),
        description: row.description,
      }));
    this.adoptPlanState(snapshot.session);
    this.adoptPlanState(snapshot);
    // settings.mode.current is getMode(), the saved permission. It wins over
    // the projection mode copied onto session.
    this.adoptPlanState(snapshot.settings);
    this.lastControls = {
      mode: this.displayedMode(),
      baseMode: this.baseMode,
      planEnabled: this.planEnabled,
      thoughtEnabled: thought?.enabled !== undefined ? thought.enabled && available.length > 0
        : Array.isArray(thought?.available) ? available.length > 0 : this.lastControls.thoughtEnabled,
      thoughtLevel: thought?.current ?? thought?.defaultLevel ?? this.lastControls.thoughtLevel,
      thoughtLevels: available,
    };
  }

  private noteSnapshotCompleteness(snapshot: SessionSnapshot): void {
    const settings = snapshot.settings;
    // A partial snapshot must not suppress model-dependent controls reads.
    this.snapshotModelFresh = !!extractModel(snapshot.session?.model || settings?.model?.current);
    this.snapshotSettingsFresh = this.snapshotModelFresh
      && !!(settings?.mode?.current || settings?.permission?.mode)
      && typeof settings?.thoughtLevel?.enabled === "boolean"
      && (settings.thoughtLevel.enabled === false ||
        (Array.isArray(settings.thoughtLevel.available) && settings.thoughtLevel.available.length > 0
          && !!(settings.thoughtLevel.current || settings.thoughtLevel.defaultLevel)));
  }

  private async readSessionSnapshot(): Promise<SessionSnapshot | undefined> {
    if (!this.sessionId || this.disposed) return undefined;
    const sessionId = this.sessionId;
    const isCurrent = this.sessionScope();
    const started = Date.now();
    try {
      const snapshot = (await this.sendRequest("session/read", {
        sessionId,
        deliveryKind: "desktop-continuous",
        messageLimit: 1,
      })) as SessionSnapshot;
      this.activeTiming?.add("session/read", Date.now() - started);
      if (!isCurrent()) return undefined;
      this.noteRevision(snapshot.runtime?.stateRevision);
      this.noteSnapshotCompleteness(snapshot);
      return snapshot;
    } catch (e) {
      this.activeTiming?.add("session/read", Date.now() - started);
      logWarn("session/read failed", e);
      return undefined;
    }
  }

  private applyListedSessionMeta(mine: SessionSummary | undefined): void {
    if (!mine) return;
    this.adoptTitle(mine.title);
    // Listed mode is the projection default, not the saved permission.
    if (mine.mode === "plan") {
      this.planEnabled = true;
      this.lastControls = {
        ...this.lastControls,
        mode: this.displayedMode(),
        baseMode: this.baseMode,
        planEnabled: this.planEnabled,
      };
    }
  }

  private async alignAndEmitModel(model: {
    providerId: string;
    modelId: string;
  }): Promise<void> {
    const isCurrent = this.sessionScope();
    await this.alignSessionRuntime(model);
    if (!isCurrent()) return;
    this.opts.onEvent({ type: "model_info", data: model });
    const catalog = modelContextWindow(model.providerId, model.modelId);
    if (catalog) {
      this.modelWindow = catalog;
      this.applyModelWindow();
    }
  }

  private async adoptResumedModel(): Promise<void> {
    try {
      const listed = await this.listSessions(true);
      const mine = listed.find((s) => s.sessionId === this.sessionId);
      if (mine) {
        const previousTitle = this.lastTitle;
        this.applyListedSessionMeta(mine);
        if (this.lastTitle && this.lastTitle !== previousTitle) {
          this.opts.onEvent({
            type: "session_title",
            data: { title: this.lastTitle, sessionId: this.sessionId },
          });
        }
      }
      const model =
        mine?.model ||
        (this.sessionId ? this.opts.rememberedModel?.(this.sessionId) : undefined);
      if (model) await this.alignAndEmitModel(model);
    } catch (e) {
      logWarn("Could not read resumed session model", e);
    }
  }

  async loadHistory(): Promise<{ items: HistoryItem[]; truncated: boolean; queue?: ConversationQueueItem[] }> {
    const sessionId = this.sessionId;
    const generation = this.sessionGeneration;
    if (!sessionId) return { items: [], truncated: false };
    if (this.replica?.topic === `conversation/${sessionId}` && this.replica.seq !== null) {
      return { items: this.projectionHistory(), truncated: this.projectionTruncated, queue: this.replica.queue };
    }
    try {
      const page = await this.fetchMessages(ZCodeClient.historyPage, sessionId);
      if (this.sessionId !== sessionId || this.sessionGeneration !== generation) {
        return { items: [], truncated: false };
      }
      if (!page.truncated) {
        this.historyCache = { sessionId, items: page.items };
      }
      return page;
    } catch (e) {
      logWarn("session/messages failed", e);
      return { items: [], truncated: false };
    }
  }

  /** Messages older than the current cutoff. A dot click passes throughId so the slice starts there. */
  async olderMessages(
    oldestId: string,
    throughId?: string
  ): Promise<{ items: HistoryItem[]; more: boolean }> {
    const sessionId = this.sessionId;
    const generation = this.sessionGeneration;
    if (!sessionId) return { items: [], more: false };
    const beforeRowId = this.historyRowIds.get(oldestId);
    if (beforeRowId !== undefined && this.replica) {
      const epoch = this.replica.logEpoch;
      let before = beforeRowId;
      let more = false;
      let items: HistoryItem[] = [];
      do {
        const result = await this.sendRequest("v4/conversation/rowsRange", {
          sessionId, clientMode: "desktop-continuous", beforeRowId: before, limit: 200,
        }) as { rows: unknown[]; hasMore: boolean; atLogEpoch: string };
        if (this.sessionId !== sessionId || this.sessionGeneration !== generation || result.atLogEpoch !== epoch) return { items: [], more: false };
        const rows = result.rows.map(slimRow).filter((row): row is ConvRow => row !== null);
        items = [...this.projectionHistory(rows), ...items];
        more = result.hasMore;
        const first = rows[0]?.rowId;
        if (first === undefined || first >= before) break;
        before = first;
      } while (throughId && more && !items.some(item => item.id === throughId));
      return { items, more };
    }
    let all =
      this.historyCache?.sessionId === sessionId ? this.historyCache.items : null;
    if (!all) {
      const full = await this.fetchMessages(undefined, sessionId);
      if (this.sessionId !== sessionId || this.sessionGeneration !== generation) {
        return { items: [], more: false };
      }
      all = full.items;
      this.historyCache = { sessionId, items: all };
    }
    const end = all.findIndex((item) => item.id === oldestId);
    if (end <= 0) return { items: [], more: false };
    let start = Math.max(0, end - ZCodeClient.historyPage);
    if (throughId) {
      const at = all.findIndex((item) => item.id === throughId);
      if (at >= 0 && at < end) start = at;
    }
    return { items: all.slice(start, end), more: start > 0 };
  }

  private async fetchMessages(
    limit?: number,
    sessionId = this.sessionId
  ): Promise<{ items: HistoryItem[]; truncated: boolean }> {
    const result = (await this.sendRequest(
      "session/messages",
      limit
        ? { sessionId, limit }
        : { sessionId },
      limit ? 30000 : 120000
    )) as { messages?: unknown[] };
    const raw = result?.messages ?? [];
    const items = raw
      .map((m) => this.normalizeHistoryItem(m, sessionId ?? undefined))
      .filter((m): m is HistoryItem => m !== null);
    return { items, truncated: limit != null && raw.length >= limit };
  }

  private normalizeHistoryItem(raw: unknown, sessionId = this.sessionId ?? undefined): HistoryItem | null {
    const msg = raw as {
      info?: {
        role?: string;
        id?: string;
        synthetic?: boolean;
        visibility?: string;
        semantics?: { uiVisibility?: string };
        time?: { created?: number; completed?: number };
        finish?: string;
        error?: unknown;
      };
      time?: { created?: number; completed?: number };
      finish?: string;
      error?: unknown;
      role?: string;
      parts?: Array<{
        id?: string;
        type?: string;
        text?: string;
        synthetic?: boolean;
        callId?: string;
        callID?: string;
        time?: { start?: number; end?: number };
        tool?: string;
        state?: {
          status?: string;
          input?: unknown;
          output?: unknown;
          error?: string;
        };
      }>;
    };
    const role = msg.info?.role ?? msg.role;
    if (role !== "user" && role !== "assistant") return null;
    const vis =
      msg.info?.visibility ?? msg.info?.semantics?.uiVisibility ?? "visible";
    if (vis === "hidden") return null;

    let text = "";
    const reasoning: string[] = [];
    let reasoningMs = 0;
    const steps: HistoryStep[] = [];
    const tools: HistoryItem["tools"] = [];
    let goalSteps = 0;
    for (const part of msg.parts ?? []) {
      if (part.type === "reasoning" && part.text?.trim()) {
        reasoning.push(part.text);
        steps.push({ kind: "reasoning", text: part.text, partId: part.id });
        const start = messageTimeMs(part.time?.start);
        const end = messageTimeMs(part.time?.end);
        if (start && end && end > start) reasoningMs += end - start;
      } else if (part.type === "text" && part.text && !part.synthetic) {
        text += part.text;
        if (part.text.trim()) steps.push({ kind: "text", text: part.text, partId: part.id });
      } else if (part.type === "timeline" && (part as { timelineType?: string }).timelineType === "goal_verification") {
        // Goal verifications arrive as timeline separators; render them as a
        // compact pass/fail marker instead of dropping the whole message.
        const verification = (part as { verification?: { passed?: unknown }; goalIteration?: unknown }).verification;
        const iteration = (part as { goalIteration?: unknown }).goalIteration;
        steps.push({
          kind: "goal",
          passed: verification?.passed === true,
          ...(typeof iteration === "number" && iteration > 0 ? { iteration } : {}),
        });
        goalSteps++;
      } else if (part.type === "timeline" && (part as { timelineType?: string }).timelineType === "model_change") {
        // Stored parts keep selection objects. The app-server rewrites those
        // into fromModel/toModel before session/messages returns them.
        const change = part as {
          fromModel?: unknown;
          toModel?: unknown;
          fromModelSelection?: unknown;
          toModelSelection?: unknown;
        };
        const fromPart = modelChangeParts(change.fromModel);
        const fromSelection = modelChangeParts(change.fromModelSelection);
        const toPart = modelChangeParts(change.toModel);
        const toSelection = modelChangeParts(change.toModelSelection);
        const from = fromPart.name ?? fromSelection.name;
        const to = toPart.name ?? toSelection.name;
        const fromProvider = fromPart.provider ?? fromSelection.provider;
        const toProvider = toPart.provider ?? toSelection.provider;
        // The initial model selection is not a switch. Keep the same rule as
        // the live replica path, including provider-only changes.
        if (!isModelSwitch(from, fromProvider, to, toProvider)) continue;
        steps.push({
          kind: "model",
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(fromProvider ? { fromProvider } : {}),
          ...(toProvider ? { toProvider } : {}),
        });
        goalSteps++;
      } else if (part.type === "tool") {
        const toolName = part.tool ?? "tool";
        const tool = {
          toolCallId: part.callId || part.callID || undefined,
          toolName,
          status: mapToolStatus(part.state?.status ?? "completed"),
          inputText: stringifyMaybe(part.state?.input),
          outputText:
            stringifyMaybe(part.state?.output) ||
            (part.state?.error ? String(part.state.error) : ""),
          fileChange: parseFileChange(
            toolName,
            part.state?.input,
            part.state?.output
          ) ?? undefined,
        };
        tools.push(tool);
        steps.push({ kind: "tool", ...tool });
      }
    }
    const workText = reasoning.join("\n\n");
    if (!text.trim() && tools.length === 0 && !workText && goalSteps === 0) return null;
    const id = msg.info?.id ? String(msg.info.id) : undefined;
    const createdAt = messageCreatedAt(msg);
    const started = messageTimeMs(msg.info?.time?.created ?? msg.time?.created);
    const ended = messageTimeMs(msg.info?.time?.completed ?? msg.time?.completed);
    const durationMs =
      started && ended && ended > started ? ended - started : reasoningMs > 0 ? reasoningMs : undefined;
    const finish = msg.info?.finish ?? msg.finish ?? "";
    const hasError = msg.info?.error != null || msg.error != null;
    const interrupted = hasError || /interrupt|cancel/i.test(finish);
    const running = role === "assistant" && !finish && !hasError;
    const work = workText
      ? {
          text: workText,
          ...(durationMs ? { durationMs } : {}),
          ...(interrupted ? { interrupted: true } : {}),
        }
      : undefined;
    return {
      id,
      role,
      text,
      tools,
      ...(createdAt ? { createdAt } : {}),
      ...(ended ? { endedAt: ended } : {}),
      ...(running ? { running: true } : {}),
      ...(steps.length ? { steps } : {}),
      ...(work ? { work } : {}),
    };
  }

  async readAvailableModels(): Promise<{
    current?: { providerId: string; modelId: string };
    available: AvailableModel[];
  }> {
    const snapshot = await this.readSessionSnapshot();
    if (!snapshot) return { available: [] };
    return modelsFromSnapshot(snapshot);
  }

  private emitContextUsage(source: unknown): void {
    this.noteModelWindow(source);
    const usage = readContextUsage(source);
    const max = chooseContextMax(usage?.max, this.modelWindow);
    const used =
      usage && usage.used > 0 ? usage.used : this.lastContext?.used ?? usage?.used;
    if (typeof used === "number" && max) {
      this.lastContext = { used, max };
    } else if (usage && !(usage.used <= 0 && this.lastContext && this.lastContext.used > 0)) {
      this.lastContext = usage;
    }
    this.publishUsage();
  }

  private noteModelWindow(source: unknown): void {
    const selected = selectionContextWindow(source);
    if (selected) {
      this.modelWindow = selected;
      return;
    }
    if (!source || typeof source !== "object") return;
    const root = source as {
      session?: { model?: unknown };
      settings?: { model?: { current?: unknown } };
    };
    const model =
      extractModel(root.settings?.model?.current) ||
      extractModel(root.session?.model) ||
      this.sessionModel;
    if (!model) return;
    const catalog = modelContextWindow(model.providerId, model.modelId);
    if (catalog) this.modelWindow = catalog;
  }

  private applyModelWindow(): void {
    if (!this.modelWindow) return;
    const max = chooseContextMax(this.lastContext?.max, this.modelWindow);
    if (!max) return;
    this.lastContext = { used: this.lastContext?.used ?? 0, max };
    this.publishUsage();
  }

  private handleConversationFrame(params: unknown): void {
    const logical = this.wireDecoder.push(params);
    if (!logical) return;
    const topic = (logical as { topic?: unknown }).topic;
    if (typeof topic === "string" && topic !== `conversation/${this.sessionId}`) return;
    if (this.pendingConversationFrames) {
      this.pendingConversationFrames.push(logical);
      return;
    }
    const replica = this.replica;
    if (!replica) return;
    const previous = replica.rows;
    const previousGoalChecks = replica.goal?.verifications.length ?? 0;
    const result = replica.receive(logical);
    if (result === "resync") {
      void this.resyncConversation();
      return;
    }
    if (result !== "applied") return;
    for (const patch of usagePatchesInFrame(logical)) this.emitContextUsage(patch);
    this.conversationRows = replica.rows;
    this.lastLogEpoch = replica.logEpoch;
    this.conversationRevision = replica.revision ?? null;
    this.noteRevision(replica.revision);
    this.reconcileProjectionActivity();
    const snapshot = payloadKind(logical) === "snapshot";
    if (snapshot) {
      this.resetResyncRetry();
      const data = logical as { payload: { snapshot: { rows: { totalCount?: number } } } };
      this.projectionTruncated = (data.payload.snapshot.rows.totalCount ?? replica.rows.length) > replica.rows.length;
      this.snapshotWait?.();
    }
    this.publishConversation();
    if (!this.acceptLive) return;
    // A goal often arrives on the same frame as the new user row. Publish it
    // before the structural transcript path returns.
    this.publishGoal();
    // The completion sentence is stored on the turn when the check finishes.
    // That write is not a new question, so without a redraw it waits for the
    // next send. A restored session already shows it, because loading reads
    // the same record back.
    const goalCheckRecorded = (replica.goal?.verifications.length ?? 0) > previousGoalChecks;
    const finishedGoalMarker = replica.rows.some(row => {
      if (row.kind !== "timelineMarker" || row.marker?.type !== "goalVerify") return false;
      const outcome = row.marker.outcome;
      if (!outcome || outcome === "running" || row.marker.detail === "cancelled") return false;
      const old = previous.find(item => item.rowId === row.rowId);
      return !old || old.marker?.outcome !== outcome;
    });
    // /compact updates one timeline marker in place: running → success. Redraw
    // so the end-of-turn reminder swaps from "compressing" to "compressed".
    const compactMarkerChanged = replica.rows.some(row => {
      if (row.kind !== "timelineMarker" || row.marker?.type !== "compact") return false;
      const old = previous.find(item => item.rowId === row.rowId);
      return !old || old.marker?.status !== row.marker.status || old.marker?.type !== "compact";
    });
    // A desktop model switch is its own timeline row. The chip updates from
    // the session selection, so the separator has to redraw on its own too.
    const modelMarkerChanged = replica.rows.some(row => {
      if (row.kind !== "timelineMarker" || row.marker?.type !== "modelChange") return false;
      const old = previous.find(item => item.rowId === row.rowId);
      return !old || old.marker?.fromProvider !== row.marker.fromProvider || old.marker?.fromModel !== row.marker.fromModel
        || old.marker?.toProvider !== row.marker.toProvider || old.marker?.toModel !== row.marker.toModel;
    });
    // Structural corrections replace the transcript; ordinary streamed text
    // updates exactly one stable row without rebuilding the view.
    if (snapshot || finishedGoalMarker || compactMarkerChanged || modelMarkerChanged || goalCheckRecorded || previous.some(row => !replica.rows.some(next => next.rowId === row.rowId)) ||
        replica.rows.some(row => row.kind === "userInput" && !previous.some(old => old.rowId === row.rowId))) {
      this.publishTranscript();
      this.publishProjectionStatus(true);
      this.replayPendingInteractions();
      return;
    }
    for (const row of replica.rows) {
      const old = previous.find(item => item.rowId === row.rowId);
      if ((row.kind === "assistantText" || row.kind === "reasoning") &&
          (row.text !== old?.text || row.state !== old?.state)) {
        this.opts.onEvent({
          type: row.kind === "reasoning" ? "assistant_reasoning_delta" : "assistant_text_delta",
          data: { fullText: row.text ?? "", partId: this.projectionPartId(row), authoritative: true,
            streaming: !this.stopping && row.state === "streaming" && (this.projectionPhase() === undefined || ["running", "prewarming"].includes(this.projectionPhase()!)) },
        });
      }
    }
    this.publishQueue();
    this.publishProjectionStatus();
  }

  private projectionPhase(): string | undefined {
    if (this.replica?.topic !== `conversation/${this.sessionId}`) return undefined;
    const control = this.replica.control;
    if (control?.phase) return control.phase;
    const header = [...this.conversationRows].reverse().find(row => row.kind === "turnHeader");
    return header?.state;
  }

  private reconcileProjectionActivity(): void {
    const phase = this.projectionPhase();
    if (!phase || !this.sessionId) return;
    const running = phase === "running" || phase === "prewarming";
    const was = this.runningSessionIds.has(this.sessionId);
    if (running) {
      this.runningSessionIds.add(this.sessionId);
      if (!this.runningSince.has(this.sessionId)) this.runningSince.set(this.sessionId, Date.now());
    } else {
      this.stopping = false;
      if (this.stopWatch) { clearTimeout(this.stopWatch); this.stopWatch = null; }
      this.runningSessionIds.delete(this.sessionId);
      this.runningSince.delete(this.sessionId);
    }
    if (was !== running) this.opts.onEvent({ type: "session_activity", data: { sessionId: this.sessionId, running } });
  }

  private publishProjectionStatus(force = false): void {
    const phase = this.projectionPhase();
    if (!phase) return;
    const status = phase === "prewarming" ? "running" : phase === "draft" ? "completedSuccess" : phase === "failed" ? "error" : phase;
    if (this.stopping && status === "running") return;
    const header = [...this.conversationRows].reverse().find(row => row.kind === "turnHeader");
    const hasOutput = this.conversationRows.some(row => (!header || row.turnId === header.turnId) &&
      ((["assistantText", "reasoning"].includes(row.kind) && !!row.text) || row.kind === "toolCall"));
    const message = status === "running" && !hasOutput ? "等待模型响应…" : this.replica?.control?.lastError?.message;
    const data = { sessionId: this.sessionId, status, message };
    const key = JSON.stringify(data);
    if (!force && key === this.projectionStatusKey) return;
    this.projectionStatusKey = key;
    this.opts.onEvent({ type: "status", data });
  }

  private projectionPartId(row: ConvRow): string {
    return `projection:${this.lastLogEpoch}:${row.rowId}`;
  }

  private projectionHistory(rows = this.conversationRows): HistoryItem[] {
    const items: HistoryItem[] = [];
    const turnHeaders = new Map([...this.conversationRows, ...rows].filter(row => row.kind === "turnHeader" && row.turnId).map(row => [row.turnId, row]));
    for (const row of rows) {
      const header = turnHeaders.get(row.turnId);
      const workDurationMs = header?.activeMs ?? (header?.startedAt !== undefined && header.endedAt !== undefined
        ? Math.max(0, header.endedAt - header.startedAt) : undefined);
      const phase = this.projectionPhase();
      const active = phase === undefined ? undefined : phase === "running" || phase === "prewarming";
      const running = active === false ? false : header ? header.state === "running" : row.state === "streaming";
      const identity = { turnId: row.turnId, rowId: row.rowId, logEpoch: this.lastLogEpoch };
      // Row-level time first: an inserted prompt splits the turn, and each
      // segment must restart its clock from its own first row, not the header.
      const timing = { ...identity, createdAt: row.createdAt ?? header?.startedAt, endedAt: header?.endedAt, workDurationMs };
      const id = (row.kind === "userInput" ? row.entityId : undefined) ?? `projection:${row.rowId}`;
      this.historyRowIds.set(id, row.rowId);
      if (row.kind === "userInput") {
        // Harness reminders ride the transcript as user rows; only real user
        // input renders as a bubble. Otherwise the injected row becomes the
        // last question, and the real question loses its edit pen.
        const hiddenRuntimeInput = row.synthetic === true ||
          row.visibility === "hidden" || row.visibility === "model-only" ||
          row.transcriptVisibility === "hidden" || row.transcriptVisibility === "model-only" ||
          row.uiVisibility === "hidden" || row.uiVisibility === "model-only" ||
          row.source === "todo_reminder" || row.source === "background_task";
        if (hiddenRuntimeInput || (row.origin && row.origin !== "realUser")) continue;
        items.push({ id, ...identity, sourceCommandId: row.sourceCommandId, role: "user", text: row.text ?? "", createdAt: row.createdAt, tools: [], attachments: row.attachments?.length ? row.attachments : header?.attachments, ...(row.entityId ? {attachmentTarget:{rowId:row.rowId,entityId:row.entityId}} : {}) });
      } else if (row.kind === "assistantText" || row.kind === "reasoning") {
        const text = row.text ?? "";
        const reasoning = row.kind === "reasoning";
        items.push({ id, role: "assistant", text: reasoning ? "" : text, ...timing,
          running, tools: [],
          work: reasoning ? { text, durationMs: row.durationMs, interrupted: row.state === "interrupted" || header?.state === "completedInterrupted" } : undefined,
          steps: [{ kind: reasoning ? "reasoning" : "text", text, partId: this.projectionPartId(row) }] });
      } else if (row.kind === "timelineMarker" && row.marker?.type === "goalVerify") {
        const outcome = row.marker.outcome;
        // A check still running, or one cancelled before it finished, is not the
        // closing sentence. That sentence belongs to a pass or a miss.
        if (!outcome || outcome === "running" || row.marker.detail === "cancelled") continue;
        const passed = outcome === "pass";
        const iteration = row.marker.iteration;
        const goalStep: HistoryStep = {
          kind: "goal",
          passed,
          ...(typeof iteration === "number" && iteration > 0 ? { iteration } : {}),
        };
        // Keep the sentence on the turn it closed. A separate trailing item would
        // become the group's last row and could clear a still-running clock.
        const previous = items.at(-1);
        if (previous?.role === "assistant" && previous.turnId === row.turnId && previous.steps) {
          previous.steps.push(goalStep);
        } else {
          items.push({ id, role: "assistant", text: "", ...timing, running: false, tools: [], steps: [goalStep] });
        }
      } else if (row.kind === "timelineMarker" && row.marker?.type === "compact") {
        const status = row.marker.status;
        if (
          status !== "running" &&
          status !== "success" &&
          status !== "failed" &&
          status !== "noop" &&
          status !== "cancelled"
        ) {
          continue;
        }
        const compactStep: HistoryStep = {
          kind: "compact",
          status,
          ...(row.marker.origin === "auto" || row.marker.origin === "manual"
            ? { origin: row.marker.origin }
            : {}),
        };
        const previous = items.at(-1);
        if (previous?.role === "assistant" && previous.turnId === row.turnId && previous.steps) {
          const index = previous.steps.findIndex(step => step.kind === "compact");
          if (index >= 0) previous.steps[index] = compactStep;
          else previous.steps.push(compactStep);
        } else {
          // The mark itself carries the running state; a bare compact row must
          // not open an empty work fold.
          items.push({ id, role: "assistant", text: "", ...timing, running: false, tools: [], steps: [compactStep] });
        }
      } else if (row.kind === "timelineMarker" && row.marker?.type === "modelChange") {
        const to = modelShortName(row.marker.toModel);
        const from = modelShortName(row.marker.fromModel);
        const fromProvider = providerId(row.marker.fromProvider);
        const toProvider = providerId(row.marker.toProvider);
        // The first turn records the starting model without a previous one.
        // That is not a switch. A later turn carries both names.
        if (!isModelSwitch(from, fromProvider, to, toProvider)) continue;
        const modelStep: HistoryStep = {
          kind: "model",
          from,
          to,
          ...(fromProvider ? { fromProvider } : {}),
          ...(toProvider ? { toProvider } : {}),
        };
        // The row is stamped with the upcoming turn and sits before that
        // question, so it stays its own item and paints between replies.
        items.push({ id, role: "assistant", text: "", ...timing, running: false, tools: [], steps: [modelStep] });
      } else if (row.kind === "toolCall") {
        const inputText = row.inputText ?? (row.input ? JSON.stringify(row.input) : "");
        const tool = { toolCallId: row.toolCallId, toolName: row.toolName ?? "Tool",
          status: mapToolStatus(row.status ?? "running"), inputText, outputText: row.output?.text,
          fileChange: parseFileChange(row.toolName ?? "", row.input) ?? undefined };
        items.push({ id, role: "assistant", text: "", ...timing,
          running: active === false ? false : header ? header.state === "running" : tool.status === "running",
          tools: [tool], steps: [{ kind: "tool", ...tool }] });
      }
    }
    this.appendStoredGoalSteps(items);
    if (rows === this.conversationRows && this.sessionId) this.historyVersions.set(items, this.historyVersion());
    return items;
  }

  /** Verifications saved on the goal, including ones restored from the session store. */
  private appendStoredGoalSteps(items: HistoryItem[]): void {
    const verifications = this.replica?.goal?.verifications ?? [];
    if (!verifications.length) return;
    const seen = new Set<string>();
    for (const item of items) {
      for (const step of item.steps ?? []) {
        if (step.kind === "goal") seen.add(`${step.passed ? "pass" : "fail"}:${step.iteration ?? 0}`);
      }
    }
    for (const entry of verifications) {
      const key = `${entry.passed ? "pass" : "fail"}:${entry.iteration}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const step: HistoryStep = {
        kind: "goal",
        passed: entry.passed,
        ...(entry.iteration > 0 ? { iteration: entry.iteration } : {}),
      };
      let host: HistoryItem | undefined;
      if (typeof entry.anchorRowId === "number") {
        for (const item of items) {
          if (item.rowId !== undefined && item.rowId <= entry.anchorRowId) host = item;
        }
      }
      if (host?.role === "assistant" && host.steps) {
        host.steps.push(step);
        continue;
      }
      const index = host ? items.indexOf(host) + 1 : items.length;
      items.splice(index, 0, {
        id: `goal:${key}`,
        role: "assistant",
        text: "",
        tools: [],
        steps: [step],
        running: false,
        turnId: host?.turnId,
        rowId: entry.anchorRowId,
        createdAt: host?.createdAt,
      });
    }
  }

  private publishTranscript(): void {
    this.opts.onEvent({ type: "transcript_sync", data: {
      sessionId: this.sessionId, items: this.projectionHistory(), truncated: this.projectionTruncated, queue: this.replica?.queue,
    } });
  }

  queuedMessages(): ConversationQueueItem[] | undefined { return this.replica?.queue; }

  private publishQueue(): void {
    const items = this.replica?.queue;
    if (!items) return;
    const key = JSON.stringify(items);
    if (key === this.queueViewKey) return;
    this.queueViewKey = key;
    this.opts.onEvent({ type: "queue_sync", data: { sessionId: this.sessionId, items } });
  }

  /** The webview renders its goal status strip and iteration markers from this. */
  private publishGoal(): void {
    const goal = this.replica?.goal ?? null;
    const key = JSON.stringify(goal);
    if (key === this.goalViewKey) return;
    this.goalViewKey = key;
    this.opts.onEvent({ type: "goal_state", data: { sessionId: this.sessionId, goal } });
  }

  private resetResyncRetry(): void {
    if (this.resyncRetryTimer) clearTimeout(this.resyncRetryTimer);
    this.resyncRetryTimer = null;
    this.resyncFailures = 0;
  }

  private async resyncConversation(): Promise<void> {
    const gen = this.conversationGen;
    const replica = this.replica;
    if (this.disposed || !replica || this.resyncGeneration === gen || this.snapshotWait || this.resyncRetryTimer) return;
    this.resyncGeneration = gen;
    this.opts.onEvent({type: "sync_status", data: {sessionId: this.sessionId, active: true}});
    const wait = this.expectSnapshot();
    void wait.catch(() => undefined);
    try {
      await this.sendRequest("v4/conversation/resync", {
        topic: replica.topic, subscriptionId: replica.subscriptionId, connectionId: "zcode-vscode",
        base: replica.seq === null ? null : { logEpoch: replica.logEpoch, seq: replica.seq }, forceSnapshot: true,
      });
      await wait;
    } catch (e) {
      if (gen === this.conversationGen && !this.disposed) {
        this.cancelSnapshotWait();
        this.resyncFailures++;
        if (this.resyncFailures === 1) this.opts.onEvent({ type: "session_error", data: { message: t("会话同步失败：{0}", { 0: userFacingError(e) }) } });
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.resyncFailures - 1, 5));
        // Retry even if no new frame arrives; incoming frames cannot bypass cooldown.
        this.resyncRetryTimer = setTimeout(() => {
          this.resyncRetryTimer = null;
          if (gen === this.conversationGen && !this.disposed) void this.resyncConversation();
        }, delay);
      }
      logWarn("conversation resync failed", e);
    } finally {
      if (this.resyncGeneration === gen) this.resyncGeneration = null;
      if (gen === this.conversationGen && !this.disposed) this.opts.onEvent({type: "sync_status", data: {sessionId: this.sessionId, active: false}});
    }
  }

  private publishConversation(): void {
    const view = buildConversationView(this.conversationRows);
    const key = JSON.stringify(view);
    if (key === this.conversationViewKey) return;
    this.conversationViewKey = key;
    this.opts.onEvent({
      type: "conversation_sync",
      data: { ...view, sessionId: this.sessionId },
    });
  }

  private cancelSnapshotWait(): void {
    this.snapshotWait?.();
  }

  private expectSnapshot(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.snapshotWait = null;
        reject(new LocalizedError("会话快照同步超时，请重新切换会话"));
      }, 15000);
      this.snapshotWait = () => {
        clearTimeout(timer);
        this.snapshotWait = null;
        resolve();
      };
    });
  }

  private async subscribeConversation(): Promise<void> {
    if (!this.sessionId) return;
    this.snapshotWait?.();
    this.resetResyncRetry();
    const gen = ++this.conversationGen;
    const nextTopic = `conversation/${this.sessionId}`;
    const prevTopic = this.conversationTopic;
    const prevSub = this.conversationSubId;
    this.replica = null;
    this.historyRowIds.clear();
    this.pendingConversationFrames = [];
    this.conversationRows = [];
    this.conversationViewKey = "";
    this.queueViewKey = "";
    this.goalViewKey = "";
    this.projectionStatusKey = "";
    this.lastLogEpoch = "";
    this.conversationRevision = null;
    this.wireDecoder.reset();
    if (prevSub && prevTopic) {
      try {
        await this.sendRequest(
          "v4/conversation/unsubscribe",
          {
            topic: prevTopic,
            subscriptionId: prevSub,
            connectionId: "zcode-vscode",
          },
          5000
        );
      } catch (e) {
        logWarn("conversation unsubscribe failed", e);
      }
    }
    if (gen !== this.conversationGen) return;
    const wait = this.expectSnapshot();
    void wait.catch(() => undefined);
    try {
      const subscribeStarted = Date.now();
      const result = (await this.sendRequest("v4/conversation/subscribe", {
        topic: nextTopic,
        connectionId: "zcode-vscode",
        clientMode: "desktop-continuous",
        visibility: "foreground",
      })) as {
        ack?: {
          subscriptionId?: string;
          logEpoch?: string;
          openTiming?: {
            cliSessionRestoreMs?: number;
            initialFrameEncodeMs?: number;
            sessionRuntimeState?: string;
            snapshotRowCount?: number;
          };
        };
      };
      const openTiming = result.ack?.openTiming;
      if (typeof openTiming?.cliSessionRestoreMs === "number") this.activeTiming?.set("cliSessionRestoreMs", openTiming.cliSessionRestoreMs);
      if (typeof openTiming?.initialFrameEncodeMs === "number") this.activeTiming?.set("initialFrameEncodeMs", openTiming.initialFrameEncodeMs);
      if (openTiming?.sessionRuntimeState === "cold" || openTiming?.sessionRuntimeState === "warm") {
        this.activeTiming?.note("sessionRuntimeState", openTiming.sessionRuntimeState);
      }
      if (typeof openTiming?.snapshotRowCount === "number") this.activeTiming?.note("snapshotRowCount", openTiming.snapshotRowCount);
      if (gen !== this.conversationGen) {
        this.activeTiming?.add("conversationSubscribe", Date.now() - subscribeStarted);
        return;
      }
      this.conversationTopic = nextTopic;
      this.conversationSubId = result.ack?.subscriptionId ?? "";
      if (!this.conversationSubId) throw new LocalizedError("会话订阅未返回 subscriptionId");
      this.replica = new ConversationReplica(nextTopic, this.conversationSubId);
      const frames = this.pendingConversationFrames ?? [];
      this.pendingConversationFrames = null;
      for (const frame of frames) this.handleConversationFrame(frame);
      if (result.ack?.logEpoch) this.lastLogEpoch = result.ack.logEpoch;
      await wait;
      this.activeTiming?.add("conversationSubscribe", Date.now() - subscribeStarted);
      if (gen !== this.conversationGen) return;
      this.publishConversation();
      logInfo("conversation subscribed", {
        sessionId: this.sessionId,
        rows: this.conversationRows.length,
        revision: this.conversationRevision,
        snapshotRowCount: result.ack?.openTiming?.snapshotRowCount,
      });
    } catch (e) {
      this.snapshotWait?.();
      throw e;
    }
  }

  private startPlanQuota(): void {
    this.quotaStarted = true;
    if (!this.viewVisible) return;
    void this.refreshPlanQuota();
    if (this.quotaTimer) return;
    this.quotaTimer = setInterval(() => void this.refreshPlanQuota(), 3 * 60 * 1000);
  }

  setViewVisible(visible: boolean): void {
    if (this.viewVisible === visible || this.disposed) return;
    this.viewVisible = visible;
    if (visible) {
      if (this.quotaStarted) this.startPlanQuota();
      return;
    }
    // Ignore a network result started before the panel was hidden.
    this.quotaRequest++;
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = null;
    }
  }

  refreshQuotaNow(): void {
    if (this.quotaStarted && this.viewVisible) void this.refreshPlanQuota();
  }

  private async refreshPlanQuota(): Promise<void> {
    if (this.disposed || !this.viewVisible) return;
    const request = ++this.quotaRequest;
    const isCurrent = this.sessionScope();
    const model = this.sessionModel;
    const isModelCurrent = () => this.sessionModel?.providerId === model?.providerId
      && this.sessionModel?.modelId === model?.modelId;
    if (model?.providerId && this.opts.fetchProviderQuota) {
      try {
        const quota = await this.opts.fetchProviderQuota(model.providerId);
        if (!this.viewVisible || !isCurrent() || !isModelCurrent() || request !== this.quotaRequest) return;
        if (quota?.length) {
          this.lastQuota = quota;
          this.lastQuotaProviderId = model.providerId;
          this.publishUsage();
          return;
        }
      } catch (e) {
        logWarn("Provider quota adapter unavailable; falling back to ZCode quota", e);
      }
      if (!this.viewVisible || !isCurrent() || !isModelCurrent() || request !== this.quotaRequest) return;
    }
    const plan = this.opts.readQuotaPlan ? this.opts.readQuotaPlan() : readPlanSelection();
    if (!plan) {
      if (this.lastQuota.length > 0 || this.lastPlanQuota.length > 0) {
        this.lastPlanQuota = [];
        this.lastQuota = [];
        this.lastQuotaProviderId = undefined;
        this.publishUsage();
      }
      return;
    }
    try {
      const readPlan = this.opts.fetchPlanQuota ?? fetchPlanQuota;
      const quota = await readPlan(plan, this.desktopAppVersion);
      if (!this.viewVisible || !isCurrent() || !isModelCurrent() || request !== this.quotaRequest) return;
      this.lastPlanQuota = quota;
      this.lastQuota = quota;
      this.lastQuotaProviderId = undefined;
      this.publishUsage();
    } catch (e) {
      logWarn("Plan quota refresh failed", e);
      if (!this.viewVisible || !isCurrent() || !isModelCurrent() || request !== this.quotaRequest) return;
      // A failed provider adapter must never leave its old balance in the panel.
      // Reuse only the last known ZCode plan quota as the fallback.
      this.lastQuota = this.lastPlanQuota;
      this.lastQuotaProviderId = undefined;
      this.publishUsage();
    }
  }

  private publishUsage(): void {
    const context =
      this.lastContext && this.lastContext.max > 0 ? this.lastContext : undefined;
    this.opts.onEvent({
      type: "context_usage",
      data: {
        ...(context ? { used: context.used, max: context.max } : {}),
        quota: this.lastQuotaProviderId && this.lastQuotaProviderId !== this.sessionModel?.providerId
          ? this.lastPlanQuota
          : this.lastQuota,
      },
    });
  }

  private noteRevision(value?: number): void {
    if (typeof value === "number" && Number.isFinite(value)) {
      this.lastRevision = value;
    }
  }

  private async ensureSessionModel(): Promise<void> {
    if (this.liveModelReady) return;
    const isCurrent = this.sessionScope();
    const snapshot = await this.readSessionSnapshot();
    if (!isCurrent()) return;
    if (snapshot) {
      this.applySnapshotSettings(snapshot);
      this.noteRevision(snapshot.runtime?.stateRevision);
    }
    const current = extractModel(snapshot?.settings?.model?.current) || extractModel(snapshot?.session?.model);
    if (current) {
      await this.alignAndEmitModel(current);
      if (!isCurrent()) return;
      this.liveModelReady = true;
      return;
    }
    const catalog = snapshot ? modelsFromSnapshot(snapshot) : { available: [] };
    const cliDefault = !catalog.available.length ? (this.opts.readDefaultModel ?? (() => readConfiguredDefaultModel(this.defaultRuntime)))() : undefined;
    const tries = [
      ...(cliDefault ? [cliDefault] : []),
      ...catalog.available.filter((m) => !m.disabledReason),
      ...(Array.isArray(snapshot?.settings?.model?.available) ? [] : listStoredProviderModels()),
    ];
    // Cold sessions advertise an empty registry before the first send loads
    // their workspace profile. The backend resolves its configured default
    // after its identity is persisted; an empty shell is not evidence of an invalid model.
    if (!tries.length && Array.isArray(snapshot?.settings?.model?.available) && !snapshot.settings.model.available.length) return;
    let lastError: Error | undefined;
    for (const m of tries) {
      if (!isCurrent()) return;
      try {
        let runtime: ResolvedRuntime | null | false | undefined;
        try {
          runtime = await this.opts.resolveSessionRuntime?.(m);
        } catch (error) {
          logWarn("Could not validate default model against desktop inventory", m.providerId, m.modelId, error);
        }
        if (!isCurrent()) return;
        if (runtime === false) {
          logWarn("Skipping unavailable default model", m.providerId, m.modelId);
          continue;
        }
        if (runtime) this.sessionRuntime = { ...runtime, modelId: m.modelId };
        await this.setModel(m.providerId, m.modelId);
        return;
      } catch (e) {
        lastError = e as Error;
        logWarn("Model candidate rejected", m.providerId, m.modelId, e);
      }
    }
    if (isCurrent()) throw lastError ?? new LocalizedError("暂时没有可用的模型。");
  }

  async setModel(providerId: string, modelId: string): Promise<void> {
    if (!this.sessionId) throw new LocalizedError("没有活动会话");
    const sessionId = this.sessionId;
    const isCurrent = this.sessionScope();
    let result: {
      status?: string;
      reasonCode?: string;
      message?: string;
      revisionAtDecision?: number;
    } = {};
    let thought = this.lastControls.thoughtLevel || "max";
    let retriedWithTargetThought = false;
    let staleAttempts = 0;
    const retryModelSwitchWithTargetThought = async (error: unknown): Promise<boolean> => {
      const message = error instanceof Error ? error.message : String(error);
      if (retriedWithTargetThought || !/reasoning level is required|unsupported reasoning effort/i.test(message)) {
        return false;
      }
      // Some app-server versions can apply the new model before rejecting an
      // effort inherited from the previous model. Read the now-active model's
      // controls and retry only when the snapshot confirms the requested model.
      const snapshot = await this.readSessionSnapshot();
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      const activeModel = extractModel(snapshot?.settings?.model?.current)
        || extractModel(snapshot?.session?.model)
        || extractModel(snapshot?.settings?.model?.lastUsed);
      if (!activeModel || activeModel.providerId !== providerId || activeModel.modelId !== modelId) return false;
      const levelSettings = snapshot?.settings?.thoughtLevel;
      const supported = (levelSettings?.available ?? [])
        .map(level => String(level.value ?? "").trim())
        .filter(Boolean);
      if (!supported.length) return false;
      thought = [levelSettings?.current, levelSettings?.defaultLevel, ...supported]
        .find(level => typeof level === "string" && supported.includes(level))!;
      retriedWithTargetThought = true;
      this.applySnapshotSettings(snapshot);
      logWarn("Retrying model switch with a reasoning level supported by the target model", {
        providerId,
        modelId,
        thought,
      });
      return true;
    };
    while (staleAttempts < 3) {
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      try {
        result = (await this.sendRequest("v4/command", {
          commandId: crypto.randomUUID(),
          clientId: "zcode-vscode",
          sessionId,
          type: "switchModelConfig",
          baseRevision: this.lastRevision,
          payload: { provider: providerId, model: modelId, thought },
          issuedAt: Date.now(),
        })) as typeof result;
      } catch (error) {
        if (await retryModelSwitchWithTargetThought(error)) continue;
        throw error;
      }
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      this.noteRevision(result.revisionAtDecision);
      if (result.status === "stale") {
        staleAttempts++;
        continue;
      }
      if (result.status && result.status !== "accepted" && result.reasonCode !== "config.unchanged") {
        const error = new Error(result.message || result.reasonCode || result.status);
        if (await retryModelSwitchWithTargetThought(error)) continue;
        throw error;
      }
      break;
    }
    if (result.status && result.status !== "accepted") {
      if (result.reasonCode === "config.unchanged") {
        /* already on this model */
      } else {
        throw new Error(result.message || result.reasonCode || result.status);
      }
    }
    await this.alignAndEmitModel({ providerId, modelId });
    if (!isCurrent()) return;
    this.liveModelReady = true;
    // Thought levels depend on the model that was just selected. The subscribe
    // snapshot was taken before that, so the next controls read must hit the server.
    this.snapshotSettingsFresh = false;
    this.snapshotModelFresh = true;
    await this.emitSessionControls();
    if (this.quotaStarted) void this.refreshPlanQuota();
  }

  async renameSession(title: string): Promise<void> {
    const next = title.trim();
    if (!next || !this.sessionId) return;
    this.adoptTitle(next);
    this.opts.onEvent({
      type: "session_title",
      data: { title: next, sessionId: this.sessionId },
    });
    try {
      await this.sendRequest("v4/command", {
        commandId: crypto.randomUUID(),
        clientId: "zcode-vscode",
        sessionId: this.sessionId,
        type: "renameSession",
        payload: { title: next },
        issuedAt: Date.now(),
      });
    } catch (e) {
      logWarn("Live session rename command failed; title was still persisted", e);
    }
  }

  currentMode(): string {
    return this.lastControls.mode || "build";
  }

  confirmedModel(): { providerId: string; modelId: string } | undefined {
    return this.sessionModel ? { ...this.sessionModel } : undefined;
  }

  confirmedControls(): SessionControls {
    return { ...this.lastControls, mode: this.displayedMode(), baseMode: this.baseMode,
      planEnabled: this.planEnabled, thoughtLevels: this.lastControls.thoughtLevels.map(level => ({ ...level })) };
  }

  async setMode(mode: string): Promise<void> {
    if (!this.sessionId) throw new LocalizedError("没有活动会话");
    const sessionId = this.sessionId;
    const isCurrent = this.sessionScope();
    await this.sendRequest("session/setMode", {
      sessionId,
      mode,
    });
    if (!isCurrent()) return;
    if (mode === "plan") this.planEnabled = true;
    else {
      this.planEnabled = false;
      if (BASE_SESSION_MODES.has(mode)) this.baseMode = mode;
    }
    this.lastControls = { ...this.lastControls, mode: this.displayedMode(), baseMode: this.baseMode, planEnabled: this.planEnabled };
    this.opts.onEvent({
      type: "session_controls",
      data: this.lastControls,
    });
  }

  async setThoughtLevel(thoughtLevel: string): Promise<void> {
    if (!this.sessionId) throw new LocalizedError("没有活动会话");
    const sessionId = this.sessionId;
    const isCurrent = this.sessionScope();
    await this.sendRequest("session/setThoughtLevel", {
      sessionId,
      thoughtLevel,
      persistAsWorkspaceLastUsed: false,
    });
    if (!isCurrent()) return;
    this.lastControls = { ...this.lastControls, thoughtLevel };
    this.opts.onEvent({
      type: "session_controls",
      data: this.lastControls,
    });
  }

  async emitSessionControls(): Promise<SessionControls> {
    const isCurrent = this.sessionScope();
    if (!this.snapshotSettingsFresh) {
      try {
        const snapshot = await this.readSessionSnapshot();
        if (!isCurrent()) return this.lastControls;
        if (snapshot) this.applySnapshotSettings(snapshot);
      } catch (e) {
        logWarn("Could not read session mode/thought settings", e);
      }
    }
    if (!isCurrent()) return this.lastControls;
    this.opts.onEvent({
      type: "session_controls",
      data: this.lastControls,
    });
    return this.lastControls;
  }

  answerPermission(requestId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    const option = pending.options.find((o) => o.optionId === optionId);
    const result = permissionDecisionFromOption(option, optionId);
    this.respondToServer(pending.rpcIds, result);
    this.opts.onEvent({ type: "status", data: { status: "running" } });
    return true;
  }

  answerUserInput(
    requestId: string,
    result: { action: "accept" | "decline" | "cancel"; content?: unknown; reason?: string }
  ): boolean {
    const pending = this.pendingUserInputs.get(requestId);
    if (!pending) return false;
    this.pendingUserInputs.delete(requestId);
    this.respondToServer(pending.rpcIds, result);
    this.opts.onEvent({ type: "status", data: { status: "running" } });
    return true;
  }

  async sendMessage(content: string, attachments: ImageAttachment[] = []): Promise<void> {
    if (!this.sessionId) throw new LocalizedError("没有活动会话，请先启动 ZCode。");
    if (!this.acceptLive) throw new LocalizedError("正在切换会话，请稍后发送。");
    const sessionId = this.sessionId;
    // Serialize admission, not generation. A send accepted by the UI must reach
    // its original session before a queued switch changes the runtime/model.
    return this.serializeSessionChange(async () => {
      if (attachments.length) {
        if (sessionId !== this.sessionId) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
        await this.ensureSessionModel();
        await this.insertQueuedMessage(content,{immediate:true,attachments});
      } else await this.sendMessageInner(sessionId, content);
    });
  }

  private async requireAvailableSessionModel(): Promise<void> {
    const isCurrent = this.sessionScope();
    const model = this.sessionModel ?? this.defaultRuntime;
    if (!model || !this.opts.isSessionModelAvailable) return;
    const available = await this.opts.isSessionModelAvailable(model);
    if (!isCurrent() || !sameSessionModel(model, this.sessionModel ?? this.defaultRuntime)) {
      throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    }
    if (!available) throw new LocalizedError("该模型已不可用，请刷新模型列表后重新选择。");
  }

  private async sendMessageInner(sessionId: string, content: string): Promise<void> {
    if (sessionId !== this.sessionId) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    await this.ensureSessionModel();
    this.releaseStopWait();
    const goal = parseGoalCommand(content);
    if (goal) {
      await this.dispatchGoalCommand(sessionId, goal);
      this.stopping = false;
      return;
    }
    // Use the same desktop command path as follow-ups and attachments. A
    // legacy session/send turn does not drive the v4 queue's auto-drain.
    if (this.replica?.topic === `conversation/${sessionId}` && this.replica.seq !== null) {
      await this.insertQueuedMessage(content, { immediate: true });
      this.stopping = false;
      return;
    }
    await this.requireAvailableSessionModel();
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await this.sendRequest(
          "session/send",
          {
            sessionId,
            content,
          },
          0
        );
        this.stopping = false;
        return;
      } catch (e) {
        lastError = e as Error;
        const message = lastError.message;
        if (this.stopping && isStopLikeError(message)) {
          logDebug("session/send ignored after stop", message);
          this.stopping = false;
          return;
        }
        if (/-32010|already running/i.test(message) && attempt < 7) {
          await delay(200);
          continue;
        }
        logWarn("session/send failed", message);
        throw lastError;
      }
    }
    throw lastError ?? new Error("session/send failed");
  }

  async insertQueuedMessage(
    content: string,
    opts?: { immediate?: boolean; commandId?: string; attachments?: ImageAttachment[] }
  ): Promise<string> {
    if (!this.sessionId) {
      throw new LocalizedError("没有活动会话，请先启动 ZCode。");
    }
    const sessionId = this.sessionId;
    const isCurrent = this.sessionScope();
    const commandId = opts?.commandId || crypto.randomUUID();
    const goal = !opts?.attachments?.length ? parseGoalCommand(content) : null;
    if (goal) return this.dispatchGoalCommand(sessionId, goal, commandId);
    await this.requireAvailableSessionModel();
    if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    const result = (await this.sendRequest("v4/command", {
      commandId,
      clientId: "zcode-vscode",
      sessionId,
      type: "sendText",
      payload: {
        text: content,
        ...(opts?.attachments?.length ? {attachments:opts.attachments} : {}),
        requestedDelivery: opts?.immediate ? "startNow" : "queue",
      },
      issuedAt: Date.now(),
    })) as {
      status?: string;
      type?: string;
      reasonCode?: string;
      message?: string;
      revisionAtDecision?: number;
    };
    if (
      result?.status &&
      result.status !== "accepted" &&
      result.type !== "inputAccepted"
    ) {
      throw new Error(result.message || result.reasonCode || result.status);
    }
    const accepted = result?.status === "accepted" || result?.type === "inputAccepted";
    // An explicit acceptance is final for this command even after switching
    // sessions. An ambiguous response still restores the draft for retry.
    if (!isCurrent() && !accepted) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    if (isCurrent()) this.noteRevision(result.revisionAtDecision);
    return commandId;
  }

  /** `/goal` updates session goal state. Sending those characters as a prompt does not. */
  private async dispatchGoalCommand(sessionId: string, command: GoalCommand, commandId: string = crypto.randomUUID()): Promise<string> {
    if (sessionId !== this.sessionId) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    const isCurrent = this.sessionScope();
    logDebug("goal command", command.kind);
    if (command.kind === "clear") {
      const result = await this.sendRequest("session/goal", { sessionId, inputId: commandId, action: "clear" }) as { status?: string } | undefined;
      if (!isCurrent() && result?.status && result.status !== "accepted" && result.status !== "duplicate") {
        throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      }
      return commandId;
    }
    if (command.kind === "pause" || command.kind === "resume") {
      // pauseGoal and resumeGoal are compare-and-swap commands. Without the
      // conversation revision the server rejects them and the strip never moves.
      await this.v4Cas(command.kind === "pause" ? "pauseGoal" : "resumeGoal", {});
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      return commandId;
    }
    await this.requireAvailableSessionModel();
    if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    const result = (await this.sendRequest("v4/command", {
      commandId,
      clientId: "zcode-vscode",
      sessionId,
      type: "sendGoalCommand",
      payload: { text: command.objective, displayText: command.displayText },
      issuedAt: Date.now(),
    })) as {
      status?: string;
      type?: string;
      reasonCode?: string;
      message?: string;
      revisionAtDecision?: number;
    };
    if (result?.status && result.status !== "accepted" && result.type !== "inputAccepted") {
      throw new Error(result.message || result.reasonCode || result.status);
    }
    const accepted = result?.status === "accepted" || result?.type === "inputAccepted";
    if (!isCurrent() && !accepted) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    if (isCurrent()) this.noteRevision(result.revisionAtDecision);
    return commandId;
  }

  async editUserQuery(
    target: RowTarget,
    newText: string,
    workspaceMode: "preserve" | "rewind",
    attachments?: ImageAttachment[]
  ): Promise<void> {
    const text = newText.trim();
    if (!text && !attachments?.length) throw new LocalizedError("编辑内容不能为空");
    const isCurrent = this.sessionScope();
    const sessionId = this.sessionId;
    await this.requireAvailableSessionModel();
    if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    // A stop that did not abort the foreground turn must not keep swallowing the
    // rewritten turn, and the rewrite itself has to preempt that turn first.
    this.releaseStopWait();
    if (sessionId && this.turnActive()) {
      try {
        await this.requestSessionStop(sessionId);
        if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
        await this.waitForTurnIdle(4000);
      } catch (e) {
        if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
        const message = e instanceof Error ? e.message : String(e);
        if (!/guard\.stopTargetChanged/.test(message)) logWarn("stop before edit failed", e);
      }
    }
    if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    if (!this.lastLogEpoch) await this.subscribeConversation();
    if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    if (!this.lastLogEpoch) throw new LocalizedError("还没有同步到桌面会话，暂时不能编辑");
    const ack = await this.v4Cas("editUserQuery", {
      target,
      newText: text,
      workspaceMode,
      // An empty array means the user removed every image while editing;
      // omitting the field would silently keep the original attachments.
      ...(attachments !== undefined ? { attachments } : {}),
    });
    const body = ack.result as { disposition?: string; reasonCode?: string } | undefined;
    if (body?.disposition === "blocked") {
      throw new Error(editBlockedMessage(body.reasonCode, workspaceMode));
    }
    if (!isCurrent()) return;
    this.seenToolCallIds.clear();
    this.stopping = false;
  }

  async conversationFileChanges(target: RowTarget): Promise<GitFileChange[]> {
    if (!this.sessionId) throw new LocalizedError("没有活动会话");
    const sessionId = this.sessionId;
    const isCurrent = this.sessionScope();
    if (!this.lastLogEpoch || this.conversationRevision === null) {
      await this.subscribeConversation();
    }
    const query = () => {
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      return this.sendRequest("v4/conversation/fileChanges", {
        sessionId,
        target,
        baseRevision: this.conversationRevision ?? this.lastRevision,
        baseLogEpoch: this.lastLogEpoch,
      });
    };
    try {
      const result = await query();
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      return readGitFiles(result);
    } catch (e) {
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      const message = (e as Error).message;
      if (!/staleRevision|staleLogEpoch/.test(message)) throw e;
      await this.subscribeConversation();
      const result = await query();
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      return readGitFiles(result);
    }
  }

  async rewindTurnFiles(target: RowTarget): Promise<void> {
    const isCurrent = this.sessionScope();
    if (!this.lastLogEpoch) await this.subscribeConversation();
    if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
    const ack = await this.v4Cas("applyFileRewind", { target });
    const body = ack.result as { applied?: boolean; response?: string } | undefined;
    if (body && body.applied === false) {
      throw body.response ? new Error(body.response) : new LocalizedError("这些文件改动不能撤销");
    }
  }

  async editQueuedMessage(queueItemId: string, newText: string): Promise<void> {
    await this.v4Cas("editQueueItem", { queueItemId, newText });
  }

  async reorderQueuedMessage(queueItemId: string, beforeQueueItemId: string | null): Promise<void> {
    await this.v4Cas("reorderQueueItem", { queueItemId, beforeQueueItemId });
  }

  async deleteQueuedMessage(queueItemId: string): Promise<void> {
    await this.v4Cas("deleteQueueItem", { queueItemId });
  }

  async sendQueuedNow(queueItemId: string): Promise<void> {
    await this.v4Cas("sendQueuedNow", { queueItemId });
  }

  private async v4Cas(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = 30000
  ): Promise<{
    status?: string;
    reasonCode?: string;
    message?: string;
    revisionAtDecision?: number;
    result?: unknown;
  }> {
    if (!this.sessionId) {
      throw new LocalizedError("没有活动会话，请先启动 ZCode。");
    }
    const sessionId = this.sessionId;
    const isCurrent = this.sessionScope();
    let result: {
      status?: string;
      reasonCode?: string;
      message?: string;
      revisionAtDecision?: number;
      result?: unknown;
    } = {};
    let refreshedEpoch = false;
    if (type === "sendQueuedNow" || type === "editUserQuery" || type === "resumeGoal") await this.requireAvailableSessionModel();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!isCurrent()) throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      const envelope: Record<string, unknown> = {
        commandId: crypto.randomUUID(),
        clientId: "zcode-vscode",
        sessionId,
        type,
        baseRevision: this.conversationRevision ?? this.lastRevision,
        payload,
        issuedAt: Date.now(),
      };
      if (this.lastLogEpoch) envelope.baseLogEpoch = this.lastLogEpoch;
      result = (await this.sendRequest("v4/command", envelope, timeoutMs)) as typeof result;
      if (!isCurrent()) {
        if (result.status === "accepted" || result.status === "duplicate") return result;
        throw new LocalizedError("会话已切换，请在当前会话重新发送。");
      }
      if (typeof result.revisionAtDecision === "number") {
        this.noteRevision(result.revisionAtDecision);
        this.conversationRevision = result.revisionAtDecision;
      }
      if (result.status === "stale") {
        if (result.reasonCode === "proto.staleLogEpoch" && !refreshedEpoch) {
          refreshedEpoch = true;
          try {
            await this.subscribeConversation();
          } catch (e) {
            logWarn("conversation resubscribe after stale epoch failed", e);
          }
        }
        continue;
      }
      break;
    }
    if (
      result.status &&
      result.status !== "accepted" &&
      result.status !== "duplicate"
    ) {
      throw new Error(result.message || result.reasonCode || result.status);
    }
    return result;
  }

  async stopGeneration(): Promise<void> {
    if (!this.sessionId || this.disposed || this.stopInFlight) return;
    const sessionId = this.sessionId;
    const isCurrent = this.sessionScope();
    const epoch = ++this.stopEpoch;
    if (this.stopWatch) { clearTimeout(this.stopWatch); this.stopWatch = null; }
    this.stopInFlight = true;
    this.stopping = true;
    this.opts.onEvent({ type: "status", data: { sessionId, status: "stopping" } });
    try {
      await this.requestSessionStop(sessionId);
      if (!isCurrent() || epoch !== this.stopEpoch) return;
      this.denyPendingInteractions("Stopped", sessionId);
      // The projection publishes the real interrupted phase. Announcing it here
      // left the reply streaming with the stop control already dismissed.
      this.observeStoppedTurn(sessionId, epoch, isCurrent);
    } catch (e) {
      if (!isCurrent() || epoch !== this.stopEpoch) return;
      this.stopping = false;
      // A rejected stop is not a completed turn. Restore the server's state.
      if (this.projectionPhase()) this.publishProjectionStatus(true);
      else this.opts.onEvent({ type: "status", data: { sessionId, status: "running" } });
      logWarn("stop failed", e);
      throw e;
    } finally {
      if (epoch === this.stopEpoch) this.stopInFlight = false;
    }
  }

  private releaseStopWait(): void {
    this.stopEpoch++;
    this.stopInFlight = false;
    this.stopping = false;
    if (this.stopWatch) { clearTimeout(this.stopWatch); this.stopWatch = null; }
  }

  isGenerating(): boolean {
    return this.turnActive();
  }

  private turnActive(): boolean {
    const phase = this.projectionPhase();
    if (phase) return phase === "running" || phase === "prewarming";
    return !!this.sessionId && this.runningSessionIds.has(this.sessionId);
  }

  private async waitForTurnIdle(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.turnActive() && Date.now() < deadline) await delay(50);
  }

  private foregroundExecutionId(): string | undefined {
    for (const work of this.replica?.control?.activeWorks ?? []) {
      if (work?.foregroundExecutionId) return work.foregroundExecutionId;
    }
    return undefined;
  }

  /** v4 turns live on a foreground execution. session/stop only aborts the legacy controller. */
  private async requestSessionStop(sessionId: string): Promise<void> {
    const expected = this.foregroundExecutionId();
    try {
      await this.v4Cas("stop", expected ? { expectedForegroundExecutionId: expected } : {}, 5000);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/guard\.stopTargetChanged/.test(message)) return;
      if (!/notImplemented|capabilityUnsupported|-32601|method not found|unknown command/i.test(message)) throw e;
      await this.sendRequest("session/stop", { sessionId }, 5000);
    }
  }

  private observeStoppedTurn(sessionId: string, epoch: number, isCurrent: () => boolean): void {
    const phase = this.projectionPhase();
    const producing = phase === "running" || phase === "prewarming"
      || (!phase && this.runningSessionIds.has(sessionId));
    if (!producing) {
      this.stopping = false;
      if (phase) this.publishProjectionStatus(true);
      return;
    }
    this.stopWatch = setTimeout(() => {
      this.stopWatch = null;
      if (epoch !== this.stopEpoch || !isCurrent() || !this.stopping) return;
      const now = this.projectionPhase();
      if (now && now !== "running" && now !== "prewarming") {
        this.stopping = false;
        this.publishProjectionStatus(true);
        return;
      }
      this.stopping = false;
      logWarn("stop did not end the turn");
      if (now) this.publishProjectionStatus(true);
      else this.opts.onEvent({ type: "status", data: { sessionId, status: "running" } });
    }, 2000);
  }

  private handleServerRequest(
    id: string | number,
    method: string,
    params: unknown
  ): void {
    if (method === "session/requestRuntimePreferences") {
      this.activeTiming?.mark("runtimePreferencesRequestedMs");
      this.activeTiming?.addCount("runtimePreferencesRequests");
      const p = params as { sessionId?: string };
      if (p?.sessionId && !this.sessionId) {
        this.sessionId = p.sessionId;
      }
      this.write({
        id,
        result: {
          nativeSearchEnhancementsEnabled: true,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
          modelContextBudgetStrategy: "preflight-v1",
        },
      });
      return;
    }

    if (method === "interaction/requestPermission") {
      this.handlePermissionRequest(id, params);
      return;
    }

    if (method === "interaction/requestUserInput") {
      this.handleUserInputRequest(id, params);
      return;
    }

    if (method === "interaction/requestProviderRuntimeHeaders") {
      void this.handleProviderRuntimeHeaders(id, params);
      return;
    }

    logDebug("Unhandled server request, acking empty", method);
    this.write({ id, result: {} });
  }

  private async handleProviderRuntimeHeaders(
    id: string | number,
    params: unknown
  ): Promise<void> {
    const timing = this.activeTiming;
    const started = performance.now();
    timing?.addCount("runtimeHeadersRequests");
    const p = (params ?? {}) as { providerId?: string; rejectedProjectTokenFingerprint?: string; expectedAccountScope?: string };
    const providerId = p.providerId?.trim() || "";
    try {
      await this.awaitStartupLogin();
      if (this.disposed) return;
      const cached = this.reusableRuntime({ providerId });
      const held = cached?.apiKeyId ? null : cached;
      timing?.addCount(held ? "runtimeHeadersCacheHits" : "runtimeHeadersCacheMisses");
      const stale = this.loginStale ? [this.sessionRuntime, this.defaultRuntime].find(
        runtime => runtime?.apiKeyId && sameDesktopLogin(runtime, providerId)
      ) : undefined;
      const rejectedFingerprint = p.rejectedProjectTokenFingerprint ?? (stale
        ? createHash("sha256").update(stale.apiKey).digest("hex") : undefined);
      const auth: PlanAuth | null = held
        ? { apiKey: held.apiKey, apiKeyId: held.apiKeyId }
        : providerId
          ? await (this.opts.resolveProviderAuth ?? resolveProviderRequestAuth)(providerId, this.desktopAppVersion, rejectedFingerprint)
          : null;
      if (this.disposed) return;
      if (!auth?.apiKey || (p.expectedAccountScope && p.expectedAccountScope !== auth.accountScope)) {
        this.write({
          id,
          result: {
            headersApplied: false,
            errorMessage: p.expectedAccountScope && auth?.apiKey
              ? "The desktop account or plan changed during this request"
              : "No ZCode desktop login is available for this plan",
          },
        });
        return;
      }
      // Refresh matching caches only after obtaining a usable replacement key.
      for (const field of ["sessionRuntime", "defaultRuntime"] as const) {
        const runtime = this[field];
        if (runtime && sameDesktopLogin(runtime, providerId)) {
          this[field] = { ...runtime, apiKey: auth.apiKey, apiKeyId: auth.apiKeyId };
          this.loginStale = false;
        }
      }
      this.write({
        id,
        result: {
          headersApplied: true,
          requestAuth: { apiKey: auth.apiKey, ...(auth.apiKeyId ? { apiKeyId: auth.apiKeyId, accountScope: auth.accountScope } : {}) },
        },
      });
    } catch (e) {
      if (this.disposed) return;
      logWarn("provider runtime headers failed", e);
      this.write({
        id,
        result: {
          headersApplied: false,
          errorMessage: (e as Error).message,
        },
      });
    } finally {
      timing?.add("runtimeHeadersMs", performance.now() - started);
    }
  }

  private handlePermissionRequest(id: string | number, params: unknown): void {
    const p = (params ?? {}) as {
      requestId?: string;
      sessionId?: string;
      toolCallId?: string;
      toolName?: string;
      reason?: string;
      riskLevel?: string;
      input?: unknown;
      options?: Array<{
        optionId?: string;
        kind?: string;
        name?: string;
        description?: string;
        response?: PermissionDecision;
      }>;
    };
    const requestId = p.requestId || String(id);
    const owner = p.sessionId || this.sessionId || undefined;
    const existing = this.pendingPermissions.get(requestId);
    if (existing) {
      existing.rpcIds.push(id);
      if (!existing.sessionId && owner) existing.sessionId = owner;
      if (this.shouldShowInteraction(existing.sessionId)) {
        this.opts.onEvent({ type: "permission_request", data: existing });
      }
      return;
    }
    let options = (p.options ?? []).filter((o) => o.optionId) as PermissionOption[];
    if (options.length === 0) {
      options = [
        {
          optionId: "allow_once",
          kind: "allow_once",
          name: "Allow once",
          response: { decision: "allow", reason: "Approved once" },
        },
        {
          optionId: "deny",
          kind: "deny",
          name: "Deny",
          response: { decision: "deny", reason: "Denied" },
        },
      ];
    }
    const request: PermissionRequest = {
      rpcIds: [id],
      requestId,
      sessionId: owner,
      toolCallId: p.toolCallId,
      toolName: p.toolName || "tool",
      reason: p.reason,
      riskLevel: p.riskLevel,
      input: p.input,
      options,
    };
    this.pendingPermissions.set(requestId, request);
    if (!this.shouldShowInteraction(owner)) return;
    this.beginAssistantSegment();
    logInfo("Permission requested", {
      requestId,
      toolName: request.toolName,
      riskLevel: request.riskLevel,
    });
    this.opts.onEvent({ type: "permission_request", data: request });
  }

  private handleUserInputRequest(id: string | number, params: unknown): void {
    const p = (params ?? {}) as {
      requestId?: string;
      sessionId?: string;
      toolName?: string;
      prompt?: string;
      schema?: unknown;
      questions?: Array<{
        question?: string;
        header?: string;
        multiSelect?: boolean;
        options?: Array<{
          value?: string;
          label?: string;
          description?: string;
          preview?: string;
        }>;
      }>;
    };
    const requestId = p.requestId || String(id);
    const owner = p.sessionId || this.sessionId || undefined;
    const existing = this.pendingUserInputs.get(requestId);
    if (existing) {
      existing.rpcIds.push(id);
      if (!existing.sessionId && owner) existing.sessionId = owner;
      if (this.shouldShowInteraction(existing.sessionId)) {
        this.opts.onEvent({ type: "user_input_request", data: existing });
      }
      return;
    }
    const request: UserInputRequest = {
      rpcIds: [id],
      requestId,
      sessionId: owner,
      toolName: p.toolName,
      prompt: p.prompt,
      schema: p.schema,
      questions: (p.questions ?? []).map((q) => ({
        question: q.question || q.header || "Question",
        header: q.header,
        multiSelect: q.multiSelect,
        options: (q.options ?? []).map((o) => ({
          value: o.value || o.label || "",
          label: o.label || o.value || "",
          description: o.description,
          preview: o.preview,
        })),
      })),
    };
    this.pendingUserInputs.set(requestId, request);
    if (!this.shouldShowInteraction(owner)) return;
    this.beginAssistantSegment();
    this.opts.onEvent({ type: "user_input_request", data: request });
  }

  private denyPendingInteractions(reason: string, sessionId?: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (sessionId && pending.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(id);
      this.respondToServer(pending.rpcIds, {
        decision: "deny",
        reason,
      });
    }
    for (const [id, pending] of this.pendingUserInputs) {
      if (sessionId && pending.sessionId !== sessionId) continue;
      this.pendingUserInputs.delete(id);
      this.respondToServer(pending.rpcIds, {
        action: "cancel",
        reason,
      });
    }
  }

  private respondToServer(ids: Array<string | number>, result: unknown): void {
    const seen = new Set<string>();
    for (const id of ids) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        this.write({ id, result });
      } catch (e) {
        logWarn("Failed to answer server request", e);
      }
    }
  }

  private sendRequest(
    method: string,
    params?: unknown,
    timeoutMs = 30000
  ): Promise<unknown> {
    if (this.startupError) return Promise.reject(this.startupError);
    if (this.proc && (this.proc.exitCode !== null || this.proc.signalCode)) {
      return Promise.reject(this.startupError ?? new LocalizedError("ZCode app-server 未在运行"));
    }
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.has(id)) {
                this.pending.delete(id);
                reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
              }
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer, method, timing: this.activeTiming });
      this.write({ id, method, params });
    });
  }

  private write(msg: ZCodeMessage): void {
    if (!this.proc?.stdin) {
      throw new LocalizedError("ZCode 标准输入不可用");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string): void {
    line = line.trim();
    if (!line) return;

    let msg: ZCodeMessage;
    const parseStarted = performance.now();
    try {
      msg = JSON.parse(line);
    } catch {
      logError("Failed to parse line", line.slice(0, 200));
      return;
    }
    const parseMs = performance.now() - parseStarted;

    if ("id" in msg && "method" in msg) {
      this.handleServerRequest(msg.id, msg.method, msg.params);
    } else if ("method" in msg && !("id" in msg)) {
      const timing = this.activeTiming;
      const started = performance.now();
      try { this.handleNotification(msg as ZCodeNotification); }
      finally { timing?.add("notificationHandlingMs", performance.now() - started); }
    } else if ("id" in msg && "result" in msg) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        if (pending.method === "session/resume") {
          pending.timing?.mark("resumeReplyReceivedMs");
          pending.timing?.note("resumeReplyBytes", Buffer.byteLength(line, "utf8"));
          pending.timing?.add("resumeReplyParseMs", parseMs);
        }
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (!this.serverReady && this.spawnedAt) {
          this.activeTiming?.set("spawnToFirstRpc", Date.now() - this.spawnedAt);
        }
        this.serverReady = true;
        pending.resolve(msg.result);
      }
    } else if ("id" in msg && "error" in msg) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        const err = msg as ZCodeErrorResponse;
        const message = `${err.error.code}: ${err.error.message}`;
        if (/\b401\b|unauthorized/i.test(message)) this.loginStale = true;
        pending.reject(
          new Error(`ZCode error ${message}`)
        );
      }
    }
  }

  private handleNotification(msg: ZCodeNotification): void {
    if (msg.method === "state.updated") {
      this.handleStateUpdated(msg.params);
    } else if (msg.method === "session/event") {
      this.handleSessionEvent(msg.params);
    } else if (msg.method === "v4/conversation/frame") {
      this.handleConversationFrame(msg.params);
    }
    this.opts.onEvent({ type: "raw", data: msg });
  }

  private runningSessionIds = new Set<string>();
  private runningSince = new Map<string, number>();

  activitySince(sessionId?: string | null): number | undefined {
    if (!sessionId) return undefined;
    const since = this.runningSince.get(sessionId);
    return since && since > 0 ? since : undefined;
  }

  pollBackgroundRuns(): void {
    if (!this.runningSince.size) return;
    const current = this.sessionId;
    const done = sessionsFinishedSince(
      [...this.runningSince.entries()]
        .filter(([sessionId]) => sessionId !== current)
        .map(([sessionId, since]) => ({ sessionId, since }))
    );
    for (const sessionId of done) {
      this.runningSince.delete(sessionId);
      this.runningSessionIds.delete(sessionId);
      this.opts.onEvent({
        type: "session_activity",
        data: { sessionId, running: false },
      });
    }
  }

  private noteSessionTurn(sessionId: string | undefined, type: string): void {
    if (!sessionId) return;
    const start = type === "turn.started" || type === "model.streaming";
    const stop = type === "turn.completed" || type === "turn.failed";
    if (!start && !stop) return;
    const was = this.runningSessionIds.has(sessionId);
    if (start) {
      if (!this.runningSince.has(sessionId)) this.runningSince.set(sessionId, Date.now());
      this.runningSessionIds.add(sessionId);
    }
    if (stop) {
      this.runningSessionIds.delete(sessionId);
      this.runningSince.delete(sessionId);
    }
    if (was === this.runningSessionIds.has(sessionId)) return;
    this.opts.onEvent({
      type: "session_activity",
      data: { sessionId, running: this.runningSessionIds.has(sessionId) },
    });
  }

  private handleSessionEvent(params: unknown, replay = false): void {
    const p = params as {
      eventId?: string;
      timestamp?: number;
      seq?: number;
      sessionId?: string;
      type?: string;
      payload?: {
        kind?: string;
        partId?: string;
        assistantMessageId?: string;
        delta?: string;
        title?: string;
        toolName?: string;
        status?: string;
        message?: string;
      };
    };

    if (!p?.type) return;
    if (p.type === "model.streaming") return;
    if (p.sessionId === this.sessionId && this.projectionPhase() && (p.type === "turn.started" || p.type === "turn.completed" || p.type === "turn.failed")) {
      if (p.type !== "turn.started") void this.resyncConversation();
      return;
    }
    if (!replay) this.noteSessionTurn(p.sessionId, p.type);
    if (!this.acceptLive) {
      if (p.sessionId) this.heldSessionEvents.push(params);
      return;
    }
    if (p.sessionId && this.sessionId && p.sessionId !== this.sessionId) return;

    if (p.type === "session.updated" && p.payload) {
      this.emitContextUsage(p.payload);
      if (this.adoptPlanState(p.payload)) {
        this.lastControls = { ...this.lastControls, mode: this.displayedMode(), baseMode: this.baseMode, planEnabled: this.planEnabled };
        this.opts.onEvent({ type: "session_controls", data: this.lastControls });
      }
    }

    if (p.type === "turn.started") {
      this.stopping = false;
          this.seenToolCallIds.clear();
      this.opts.onEvent({ type: "status", data: { status: "running" } });
    } else if (p.type === "turn.completed") {
      this.stopping = false;
      this.opts.onEvent({
        type: "status",
        data: { status: "completedSuccess" },
      });
      void this.refreshPlanQuota();
      // Reconcile the final text even when a final fragmented frame had no successor to expose a gap.
      void this.resyncConversation();
    } else if (p.type === "turn.failed") {
      const payload = p.payload as
        | {
            message?: string;
            error?: { message?: string; detail?: string; type?: string };
          }
        | undefined;
      const message =
        payload?.error?.message ||
        payload?.error?.detail ||
        payload?.message ||
        "The model failed to complete this turn";
      logWarn("turn.failed", message, payload?.error);
      this.opts.onEvent({
        type: "session_error",
        data: { message },
      });
    } else if (p.type === "session.titleUpdated" && p.payload?.title) {
      this.lastTitle = p.payload.title;
      this.opts.onEvent({
        type: "session_title",
        data: { title: p.payload.title, sessionId: this.sessionId },
      });
    } else if (p.type === "tool.updated") {
      this.emitToolCall(normalizeToolUpdated(p.payload));
    }
  }

  private beginAssistantSegment(): void {
  }



  private emitToolCall(data: {
    toolCallId?: string;
    rowId?: string | number;
    toolName?: string;
    status: string;
    inputText?: string;
    outputText?: string;
    fileChange?: FileChange;
  }): void {
    if (!data.toolName && !data.toolCallId && data.rowId == null) return;
    const id = data.toolCallId || (data.rowId != null ? `row:${data.rowId}` : "");
    if (id && !this.seenToolCallIds.has(id)) {
      this.seenToolCallIds.add(id);
      this.beginAssistantSegment();
    }
    this.opts.onEvent({ type: "tool_call", data });
  }

  private handleStateUpdated(params: unknown): void {
    const owner = (params as { sessionId?: string })?.sessionId;
    if (owner && owner !== this.sessionId) return;
    const patch = (params as { patch?: Record<string, unknown> })?.patch;
    if (!patch) return;

    this.adoptControlsFromPatch(patch);
    this.emitContextUsage(patch);

    const rows = (patch as { rows?: { window?: ZCodeRow[] } }).rows;
    if (!rows?.window || !this.acceptLive) return;

    for (const row of rows.window) {
      const seen = this.seenRowIds.has(row.rowId);
      if (seen && row.kind !== "toolCall") continue;
      this.seenRowIds.add(row.rowId);

      switch (row.kind) {
        case "userInput":
          this.opts.onEvent({
            type: "user_input_echo",
            data: { text: (row as { text?: string }).text ?? "", rowId: row.rowId },
          });
          break;
        case "toolCall": {
          this.emitToolCall(normalizeToolRow(row));
          break;
        }
        case "turnHeader": {
          if (this.projectionPhase()) break;
          const state = (row as { state?: string }).state ?? "running";
          if (state === "running") {
            this.opts.onEvent({
              type: "status",
              data: { status: "running", rowId: row.rowId },
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private adoptControlsFromPatch(patch: Record<string, unknown>): void {
    const mode = patch.mode as { current?: string } | undefined;
    const permission = patch.permission as { mode?: string } | undefined;
    const thought = patch.thoughtLevel as
      | {
          enabled?: boolean;
          current?: string;
          defaultLevel?: string;
          available?: Array<{ value?: string; label?: string; description?: string }>;
        }
      | undefined;
    const outerPlanTouched = this.adoptPlanState(patch);
    const settingsPlanTouched = this.adoptPlanState(patch.settings);
    const planTouched = outerPlanTouched || settingsPlanTouched;
    if (!mode && !permission && !thought && !planTouched) return;

    const available = (thought?.available ?? this.lastControls.thoughtLevels)
      .map((row) => ({
        value: String(row.value ?? ""),
        label: row.label || String(row.value ?? ""),
        description: row.description,
      }))
      .filter((row) => row.value);

    this.lastControls = {
      mode: this.displayedMode(),
      baseMode: this.baseMode,
      planEnabled: this.planEnabled,
      thoughtEnabled:
        thought?.enabled !== undefined
          ? thought.enabled && available.length > 0
          : Array.isArray(thought?.available) ? available.length > 0 : this.lastControls.thoughtEnabled,
      thoughtLevel: thought?.current ?? thought?.defaultLevel ?? this.lastControls.thoughtLevel,
      thoughtLevels: available,
    };
    this.opts.onEvent({
      type: "session_controls",
      data: this.lastControls,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.releaseStopWait();
    this.conversationGen++;
    this.resetResyncRetry();
    this.snapshotWait?.();
    this.sessionGeneration++;
    this.denyPendingInteractions("Client disposed");
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new LocalizedError("ZCode 客户端已关闭"));
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;
    this.errRl?.close();
    this.errRl = null;
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = null;
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (this.proc) {
      const proc = this.proc;
      try {
        proc.stdin?.end();
      } catch {
        // ignore
      }
      proc.kill("SIGTERM");
      this.killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000);
      this.proc = null;
    }
  }
}

function readContextUsage(
  source: unknown
): { used: number; max: number } | null {
  if (!source || typeof source !== "object") return null;
  const root = source as {
    querySource?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      input?: number;
      output?: number;
      total?: number;
      contextWindow?: { usedTokens?: number; maxTokens?: number } | null;
    } | null;
    runtime?: { contextUsage?: { used?: number; size?: number } | null };
    projection?: { contextUsed?: number | null; contextWindow?: number | null };
    contextWindow?: { usedTokens?: number; maxTokens?: number } | number | null;
    contextUsed?: number | null;
    messages?: unknown[];
  };
  if (typeof root.querySource === "string" && root.querySource !== "main_turn") {
    return null;
  }

  const runtime = root.runtime?.contextUsage;
  if (positive(runtime?.used) && positive(runtime?.size)) {
    return { used: runtime.used, max: runtime.size };
  }

  const reported = root.usage?.contextWindow;
  if (positive(reported?.usedTokens) && positive(reported?.maxTokens)) {
    return { used: reported.usedTokens, max: reported.maxTokens };
  }

  const max = contextMax(root);
  const modelUsed = modelTurnTokens(root.usage);
  if (modelUsed && max) return { used: modelUsed, max };

  const fromMessages = latestPositiveMessageTokens(root.messages);
  if (fromMessages && max) return { used: fromMessages, max };

  const projected = root.projection?.contextUsed ?? root.contextUsed;
  if (max && typeof projected === "number" && projected >= 0) {
    return { used: projected, max };
  }
  return null;
}

function messageTimeMs(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
}

function messageCreatedAt(msg: {
  info?: { time?: { created?: number } };
  time?: { created?: number };
}): number | undefined {
  return messageTimeMs(msg.info?.time?.created ?? msg.time?.created);
}

/** "account:bigmodel-team-coding-plan/GLM-5.3" → "GLM-5.3" for switch banners. */
function modelShortName(label: unknown): string | undefined {
  if (typeof label !== "string" || !label) return undefined;
  const tail = label.split("/").pop()?.trim();
  return tail || undefined;
}

function providerId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Provider id kept beside a selection label such as "deepseek/deepseek-flash". */
function providerFromLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const slash = label.lastIndexOf("/");
  if (slash <= 0 || slash >= label.length - 1) return undefined;
  const provider = label.slice(0, slash).trim();
  return provider || undefined;
}

/** Selection labels, rewritten fromModel/toModel objects, or a bare model id. */
function modelChangeParts(value: unknown): { name?: string; provider?: string } {
  if (typeof value === "string") return { name: modelShortName(value), provider: providerFromLabel(value) };
  if (!value || typeof value !== "object") return {};
  const model = value as { label?: unknown; modelId?: unknown; modelID?: unknown; providerId?: unknown; providerID?: unknown };
  return {
    name: modelShortName(model.label) ?? modelShortName(model.modelId) ?? modelShortName(model.modelID),
    provider: providerId(model.providerId) ?? providerId(model.providerID) ?? providerFromLabel(model.label),
  };
}

/** Model names can repeat across providers, so compare the complete known selection. */
function isModelSwitch(from?: string, fromProvider?: string, to?: string, toProvider?: string): boolean {
  if (!from || !to) return false;
  if (from !== to) return true;
  return Boolean(fromProvider && toProvider && fromProvider !== toProvider);
}

function payloadKind(params: unknown): string {  const kind = (params as { payload?: { kind?: unknown } } | null)?.payload?.kind;
  return typeof kind === "string" ? kind : "";
}

function editBlockedMessage(reason: string | undefined, workspaceMode: string): string {
  if (
    workspaceMode === "rewind" &&
    (reason === "guard.workspaceRewindApplyConflict" || reason === "guard.actionUnavailable")
  ) {
    return t("文件无法安全重置。可以改用“发送”只重发对话。");
  }
  return reason ? t("这次编辑没有生效：{0}", { 0: reason }) : t("这次编辑没有生效");
}

function usagePatchesInFrame(params: unknown): unknown[] {
  const patches: unknown[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const row = value as { op?: string; patch?: unknown; ops?: unknown };
    if (row.op === "state.updated" && row.patch) patches.push(row.patch);
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(params, 0);
  return patches;
}

function contextMax(root: {
  projection?: { contextWindow?: number | null };
  contextWindow?: { maxTokens?: number } | number | null;
  runtime?: { contextUsage?: { size?: number } | null };
}): number | null {
  const numeric = root.contextWindow;
  if (positive(typeof numeric === "number" ? numeric : numeric?.maxTokens)) {
    return typeof numeric === "number" ? numeric : (numeric?.maxTokens as number);
  }
  if (positive(root.runtime?.contextUsage?.size)) return root.runtime.contextUsage.size;
  if (positive(root.projection?.contextWindow)) return root.projection.contextWindow;
  return null;
}

function modelTurnTokens(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        input?: number;
        output?: number;
        total?: number;
      }
    | null
    | undefined
): number | null {
  if (!usage) return null;
  const output = finite(usage.outputTokens)
    ? usage.outputTokens
    : finite(usage.output)
      ? usage.output
      : 0;
  const input = finite(usage.inputTokens)
    ? usage.inputTokens
    : finite(usage.input)
      ? usage.input
      : finite(usage.totalTokens)
        ? Math.max(0, usage.totalTokens - output)
        : finite(usage.total)
          ? Math.max(0, usage.total - output)
          : null;
  if (input !== null && input + output > 0) return input + output;
  if (positive(usage.totalTokens)) return usage.totalTokens;
  if (positive(usage.total)) return usage.total;
  return null;
}

function latestPositiveMessageTokens(messages: unknown[] | undefined): number | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      info?: { role?: string; summary?: unknown; tokens?: unknown };
      parts?: Array<{ type?: string; compactBoundary?: Record<string, unknown> }>;
    };
    const info = msg?.info;
    if (!info) continue;
    if (info.role === "user" && info.summary) {
      for (const part of msg.parts ?? []) {
        const boundary = part?.compactBoundary;
        const compacted = finite(boundary?.truePostCompactTokenCount)
          ? boundary.truePostCompactTokenCount
          : finite(boundary?.postCompactTokenCount)
            ? boundary.postCompactTokenCount
            : null;
        if (positive(compacted)) return compacted;
      }
    }
    if (info.role !== "assistant" || info.summary) continue;
    const tokens = messageTokens(info.tokens);
    if (positive(tokens)) return tokens;
  }
  return null;
}

function messageTokens(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const tokens = raw as { total?: number; input?: number; output?: number };
  if (positive(tokens.total)) return tokens.total;
  const input = finite(tokens.input) ? tokens.input : 0;
  const output = finite(tokens.output) ? tokens.output : 0;
  return input + output > 0 ? input + output : null;
}

const DEFAULT_SESSION_WINDOW = 200_000;

function chooseContextMax(
  reported: number | undefined,
  modelWindow: number | null
): number | undefined {
  if (
    modelWindow &&
    (!reported || (reported === DEFAULT_SESSION_WINDOW && modelWindow !== reported))
  ) {
    return modelWindow;
  }
  return reported ?? modelWindow ?? undefined;
}

function selectionContextWindow(source: unknown): number | null {
  if (!source || typeof source !== "object") return null;
  const row = source as { contextWindow?: unknown; modelSelection?: unknown };
  if (!row.modelSelection || typeof row.contextWindow !== "number" || row.contextWindow <= 0) {
    return null;
  }
  return Math.floor(row.contextWindow);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStopLikeError(message: string): boolean {
  return /stopped|abort|interrupt|-32010|already running/i.test(message);
}


function modelsFromSnapshot(snapshot: SessionSnapshot): {
  current?: { providerId: string; modelId: string };
  available: AvailableModel[];
} {
  const current =
    extractModel(snapshot.settings?.model?.current) ||
    extractModel(snapshot.settings?.model?.lastUsed) ||
    extractModel(snapshot.session?.model);
  const available: AvailableModel[] = [];
  for (const row of snapshot.settings?.model?.available ?? []) {
    const ref = extractModel(row.ref) || extractModel(row);
    if (!ref) continue;
    available.push({
      providerId: ref.providerId,
      modelId: ref.modelId,
      label: row.label || ref.modelId,
      providerLabel: row.providerLabel,
      disabledReason: row.disabledReason,
    });
  }
  return { current, available };
}

function extractModel(
  raw: unknown
): { providerId: string; modelId: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const nested =
    o.model && typeof o.model === "object"
      ? (o.model as Record<string, unknown>)
      : o.ref && typeof o.ref === "object"
        ? (o.ref as Record<string, unknown>)
        : o;
  const providerId = nested.providerId ?? nested.providerID;
  const modelId = nested.modelId ?? nested.modelID;
  if (typeof providerId !== "string" || typeof modelId !== "string") return undefined;
  if (!providerId.trim() || !modelId.trim()) return undefined;
  return { providerId, modelId };
}

function extractTitle(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (!raw || typeof raw !== "object") return "";
  const o = raw as Record<string, unknown>;
  const nested =
    o.session && typeof o.session === "object"
      ? (o.session as Record<string, unknown>)
      : undefined;
  for (const value of [o.title, o.name, o.sessionTitle, nested?.title, nested?.name]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringifyMaybe(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function mapToolStatus(status?: string): string {
  switch (status) {
    case "success":
    case "completed":
      return "completed";
    case "error":
    case "failed":
    case "cancelled":
    case "denied":
      return "error";
    default:
      return "running";
  }
}

function normalizeToolRow(row: ZCodeRow): {
  toolCallId?: string;
  rowId: number;
  toolName: string;
  status: string;
  inputText: string;
  outputText: string;
  fileChange?: FileChange;
} {
  const toolRow = row as {
    toolCallId?: string;
    toolName?: string;
    status?: string;
    inputText?: string;
    input?: unknown;
    outputText?: string;
    output?: unknown;
    error?: { message?: string } | string;
  };
  const errorText =
    typeof toolRow.error === "string"
      ? toolRow.error
      : toolRow.error?.message ?? "";
  const toolName = toolRow.toolName ?? "tool";
  return {
    toolCallId: toolRow.toolCallId,
    rowId: row.rowId,
    toolName,
    status: mapToolStatus(toolRow.status),
    inputText: toolRow.inputText || stringifyMaybe(toolRow.input),
    outputText:
      stringifyMaybe(toolRow.output) ||
      toolRow.outputText ||
      errorText,
    fileChange:
      parseFileChange(toolName, toolRow.input, toolRow.output) ?? undefined,
  };
}

function normalizeToolUpdated(raw: unknown): {
  toolCallId?: string;
  rowId?: string;
  toolName?: string;
  status: string;
  inputText: string;
  outputText: string;
  fileChange?: FileChange;
} {
  const p = (raw ?? {}) as {
    kind?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    result?: unknown;
    error?: { message?: string; detail?: string } | string;
    stdoutTail?: string;
    stderrTail?: string;
  };
  const kind = p.kind ?? "";
  let status = "running";
  let outputText = "";
  if (kind === "result") {
    status = "completed";
    outputText = stringifyMaybe(p.result);
  } else if (kind === "error") {
    status = "error";
    outputText =
      typeof p.error === "string"
        ? p.error
        : p.error?.message || p.error?.detail || stringifyMaybe(p.error);
  } else if (kind === "progress") {
    outputText = [p.stdoutTail, p.stderrTail].filter(Boolean).join("\n");
  }
  return {
    toolCallId: p.toolCallId,
    rowId: p.toolCallId,
    toolName: p.toolName,
    status: mapToolStatus(status),
    inputText: stringifyMaybe(p.input),
    outputText,
    fileChange:
      parseFileChange(p.toolName || "", p.input, p.result) ?? undefined,
  };
}

function permissionDecisionFromOption(
  option: PermissionOption | undefined,
  optionId: string
): PermissionDecision {
  if (option?.response?.decision) return option.response;
  const key = `${option?.optionId ?? optionId} ${option?.kind ?? ""}`.toLowerCase();
  if (/(allow_once|allowonce)/.test(key)) {
    return { decision: "allow", reason: "Approved once" };
  }
  if (/(allow_always|allowalways|allow_project)/.test(key)) {
    return option?.response ?? { decision: "allow", reason: "Approved for this project" };
  }
  return { decision: "deny", reason: "Denied" };
}
