import { rankWorkspaceFiles, workspaceSearchPatterns } from "./fileSearch";
import { existingWorkspaceFile, previewFileKind, previewFilesForReply } from "./filePreview";
import { resolveFileTarget } from "./workspaceFiles";
import { prepareFileContext } from "./fileContext";
import { decodeImage, imageMime } from "./imageAttachments";
import { readImageAttachments, IMAGE_MAX_BYTES, type ImageAttachment } from "./attachmentTypes";
import { createHash, randomUUID } from "crypto";
import { desktopVersion, redactHome, issueCategory, type IssueCategory } from "./diagnostics";
import { errorGuidance, COMMUNITY_URL, type RecoveryAction } from "./errorGuidance";
import { hostT as t, userFacingError } from "./hostI18n";
import { resolveUiLanguage, LANGUAGE_SETTINGS, type LanguageSetting } from "./i18n";
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ZCodeClient, ZCodeEvent, SessionSummary, type AvailableModel } from "./zcodeClient";
import { FileChange } from "./toolFiles";
import {
  ContextChip,
  SessionReference,
  buildPrompt,
} from "./promptContext";
import { getNonce, getWebviewHtml, type ComposerChrome } from "./webviewHtml";
import {
  PickerModel,
  ResolvedRuntime,
  desktopFamilyFingerprint,
  resolveBinaryPath,
  localLoginCanOverlapSpawn,
  readPickerResolution,
  isSessionModelAvailable,
  resolveRuntime,
  resolveRuntimeForSession,
  runtimeEnv,
  syncCliConfig,
  type ResolveResult,
} from "./desktop";
import { disposeLog, getLog, logDebug, logError, logInfo, logWarn } from "./log";
import { redactSecrets } from "./redact";
import { parseWebviewMessage } from "./webviewMessages";
import {
  MATH_FONT_VERSION, MATH_FONTS_SHA256, formulaFontMode, installMathFontPack,
  loadMathFontPack, mathFontDataHref, mathFontFaceCss, mathFontPackReady,
} from "./mathFonts";
import { StartupTiming } from "./startupTiming";
import { defenderExclusionCommand, isSlowWindowsStartup, pluginScanFolders } from "./startupSlowness";
import { SendTiming } from "./sendTiming";
import { locateAppServer } from "./serverPath";
import { materializeGitDiff, type StructuredPatch } from "./conversation";
import { DiffDocuments } from "./diffDocuments";
import { sameWorkspacePath, preferredWorkspacePath } from "./workspacePath";
import { normalizeNewSessionDefaults, type NewSessionDefaults } from "./newSessionDefaults";
import { readConfiguredProviderApiKey, readV2Config, readV2Settings, v2Dir } from "./credentials";
import { buildQuotaAdapterRegistry, fetchQuotaAdapter, quotaSecretStorageKey, type QuotaAdapterConfig } from "./quotaAdapters";
import {
  loadTaskFlags,
  loadSessionArchiveTimes,
  loadOverriddenTitles,
  persistCliSession,
  setSessionDisplayTitle,
  SessionSyncError,
  setTaskArchived,
  setTaskDeleted,
  upsertDesktopTask,
  listSessionQuestions,
  nativeSqliteAvailable,
  disposeSqliteSnapshots,
  cleanupOrphanedSqliteSnapshots,
  type SessionQuestion,
} from "./taskIndex";

const LAST_SESSION_KEY = "zcode.lastSessionId";
const LAST_BINARY_KEY = "zcode.lastBinaryPath";
const SESSION_MODELS_KEY = "zcode.sessionModels";
const NEW_SESSION_DEFAULTS_KEY = "newSessionDefaults";
const DEFENDER_NOTICE_KEY = "zcode.defenderNoticeDismissed";

function configuredQuotaAdapters(): QuotaAdapterConfig[] {
  const raw = vscode.workspace.getConfiguration("zcode").get<unknown>("quotaAdapters", []);
  return buildQuotaAdapterRegistry(raw);
}

async function fetchConfiguredProviderQuota(context: vscode.ExtensionContext, providerId: string) {
  const adapter = configuredQuotaAdapters().find(item => item.providerId === providerId);
  if (!adapter) return null;
  const picker = await readPickerResolution();
  if (!quotaProviderIsSelectable(providerId, picker)) return null;
  if (adapter.apiKeySource === "zcode") {
    const credential = await readConfiguredProviderApiKey(adapter.providerId, adapter.providerTemplateId);
    if (!credential) return null;
    return fetchQuotaAdapter(adapter, credential.apiKey, credential.baseURL ?? adapter.providerBaseURL);
  }
  const secret = adapter.auth === "none" ? undefined : await context.secrets.get(quotaSecretStorageKey(adapter.id));
  return fetchQuotaAdapter(adapter, secret);
}

export function quotaProviderIsSelectable(
  providerId: string,
  resolution: Awaited<ReturnType<typeof readPickerResolution>>
): boolean {
  if (!resolution.providerInventoryAuthoritative || providerId.startsWith("account:") || providerId.startsWith("builtin:")) return true;
  return resolution.managedProviderIds.includes(providerId) && resolution.picker.some(model =>
    model.providerId === providerId && model.hasKey && !model.disabledReason
  );
}

export function mergeAvailablePickerModels(
  configured: readonly PickerModel[],
  available: readonly AvailableModel[],
  disabledModelKeys: ReadonlySet<string> = new Set(),
  managedProviderIds: ReadonlySet<string> = new Set(),
  providerInventoryAuthoritative = false
): PickerModel[] {
  const merged = configured
    .filter(model => !disabledModelKeys.has(`${model.providerId}\0${model.modelId}`))
    .map(model => ({ ...model }));
  const indexes = new Map(merged.map((model, index) => [`${model.providerId}\0${model.modelId}`, index]));
  for (const model of available) {
    if (!model.providerId?.trim() || !model.modelId?.trim()) continue;
    const isAccountOrBuiltin = model.providerId.startsWith("account:") || model.providerId.startsWith("builtin:");
    if (providerInventoryAuthoritative && !isAccountOrBuiltin && !managedProviderIds.has(model.providerId)) continue;
    const key = `${model.providerId}\0${model.modelId}`;
    if (disabledModelKeys.has(key)) continue;
    if (managedProviderIds.has(model.providerId) && !indexes.has(key)) continue;
    const index = indexes.get(key);
    if (index !== undefined) {
      const existing = merged[index];
      merged[index] = {
        ...existing,
        providerName: model.providerLabel?.trim() || existing.providerName,
        label: model.label?.trim() || existing.label,
        hasKey: true,
        ...(model.disabledReason ? { disabledReason: model.disabledReason } : { disabledReason: undefined }),
      };
      continue;
    }
    indexes.set(key, merged.length);
    merged.push({
      providerId: model.providerId,
      providerName: model.providerLabel?.trim() || model.providerId,
      kind: "unknown",
      modelId: model.modelId,
      label: model.label?.trim() || model.modelId,
      // A model advertised as available by the active app-server is selectable
      // even when it is absent from config.json (for example, a desktop shortcut).
      hasKey: true,
      ...(model.disabledReason ? { disabledReason: model.disabledReason } : {}),
    });
  }
  return merged;
}

export function activate(context: vscode.ExtensionContext) {
  getLog();
  context.subscriptions.push({ dispose: disposeLog });
  context.subscriptions.push({ dispose: disposeSqliteSnapshots });
  void cleanupOrphanedSqliteSnapshots().catch(() => undefined);
  logInfo("ZCode extension activating");

  const provider = new ZCodeViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("zcode.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const register = (id: string, fn: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("zcode.openChat", () =>
    vscode.commands.executeCommand("workbench.view.extension.zcode-sidebar")
  );
  register("zcode.newSession", () => provider.newSession());
  register("zcode.stopGeneration", () => provider.stopGeneration());
  register("zcode.switchSession", () => provider.quickSwitchSession());
  register("zcode.selectModel", () => provider.quickSelectModel());
  register("zcode.showLog", () => getLog().show(true));
  register("zcode.sendSelection", () => provider.insertEditorContext("selection"));
  register("zcode.sendCurrentFile", () => provider.insertEditorContext("file"));
  register("zcode.showChromeSettings", () => provider.showChromeSettings());
  register("zcode.setQuotaApiKey", () => provider.setQuotaApiKey());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("zcode.language")) provider.pushLanguage();
      if (e.affectsConfiguration("zcode.formulaFonts")) provider.syncMathFonts();
      if (e.affectsConfiguration("zcode.quotaAdapters")) provider.refreshQuota();
      if (["binaryPath", "nodePath", "workspacePath", "model"].some(key => e.affectsConfiguration(`zcode.${key}`))) {
        logInfo("ZCode settings changed; restarting session");
        void provider.restart("Settings changed");
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider.restart("Workspace folders changed");
    }),
    watchDesktopFamily(() => {
      logInfo("ZCode desktop personal/team selection changed; restarting");
      void provider.restart("Desktop login selection changed");
    }),
    watchDesktopProviderModels(() => {
      void provider.refreshDesktopModels();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.pushEditorContext()),
    vscode.window.onDidChangeTextEditorSelection(() =>
      provider.pushEditorContext()
    )
  );

  context.subscriptions.push({ dispose: () => provider.dispose() });
}

export function deactivate() {
  // provider dispose is registered on activate
}

function watchDesktopFamily(onChange: () => void): vscode.Disposable {
  const dir = v2Dir();
  let last = desktopFamilyFingerprint();
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const next = desktopFamilyFingerprint();
      if (next === last) return;
      last = next;
      onChange();
    }, 400);
  };
  try {
    if (fs.existsSync(dir)) {
      watcher = fs.watch(dir, (_event, filename) => {
        const name = filename?.toString() ?? "";
        if (!name || name === "setting.json" || name === "config.json") fire();
      });
    }
  } catch (e) {
    logWarn("Could not watch ZCode desktop settings", e);
  }
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

/** Refresh shortcut model metadata without restarting the app-server process. */
function watchDesktopProviderModels(onChange: () => void): vscode.Disposable {
  const dir = v2Dir();
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    if (fs.existsSync(dir)) {
      watcher = fs.watch(dir, (_event, filename) => {
        const name = filename?.toString() ?? "";
        if (!name || name === "provider_config.json") {
          if (timer) clearTimeout(timer);
          timer = setTimeout(onChange, 350);
        }
      });
    }
  } catch (e) {
    logWarn("Could not watch ZCode provider shortcuts", e);
  }
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

export class ZCodeViewProvider implements vscode.WebviewViewProvider {
  private readonly diffDocs = new DiffDocuments();
  private client: ZCodeClient | null = null;
  private view?: vscode.WebviewView;
  private viewVisibilityListener?: vscode.Disposable;
  private viewMessageListener?: vscode.Disposable;
  private viewDisposeListener?: vscode.Disposable;
  private starting: Promise<void> | null = null;
  private mathFontTask?: Promise<void>;
  private mathFontPhase: "idle" | "downloading" | "failed" = "idle";
  private mathFontCssCache?: { key: string; css: string };
  private mathFontReported = "";
  private timing: StartupTiming | null = null;
  private appServerPath = "";
  private defenderNoticeShown = false;
  private readonly sendTiming = new SendTiming(data => logInfo("send timing", data));
  private webviewEpoch = 0;
  private pushedEpoch = -1;
  private questionIndexCache: { key: string; questions: SessionQuestion[] } | null = null;
  private readSessionQuestions: (sessionId: string) => SessionQuestion[] = listSessionQuestions;
  private runtime: ResolvedRuntime | null = null;
  private sessions: SessionSummary[] = [];
  private picker: PickerModel[] = [];
  private disabledModelKeys = new Set<string>();
  private managedProviderIds = new Set<string>();
  private providerInventoryAuthoritative = false;
  private desktopAppVersion: string | null = null;
  private resolveSessionModelRuntime = (model: Parameters<typeof resolveRuntimeForSession>[0]) =>
    resolveRuntimeForSession(model, this.desktopAppVersion);
  private pickerRefreshRevision = 0;
  private livePicker: { client: ZCodeClient; sessionId: string; models: AvailableModel[] } | null = null;
  private currentModel?: { providerId: string; modelId: string };
  /** Chosen while a reply is running. That reply keeps its model; the next question applies this one. */
  private pendingModel: { sessionId: string; providerId: string; modelId: string } | null = null;
  /** Model switch separators wait for each session's next question; rapid re-picks collapse within that session. */
  private readonly pendingSwitchBanners = new Map<string, { from?: { providerId: string; modelId: string }; to: { providerId: string; modelId: string } }>();
  private readonly sessionsWithUserMessages = new Set<string>();
  private workspacePath = "";
  private fileSearchCache?: { root: string; query: string; at: number; files: string[] };
  private fileSearchCancellation?: vscode.CancellationTokenSource;
  private recentFiles: string[] = [];
  private diagnosticStatus = "disconnected";
  private recentIssues: Array<{at: string; category: IssueCategory}> = [];
  private pendingChip?: ContextChip;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(
      this.diffDocs,
      vscode.workspace.registerTextDocumentContentProvider(DiffDocuments.scheme, this.diffDocs)
    );
  }

  private switchTicket = 0;

  private viewScope(): () => boolean {
    const client = this.client;
    const sessionId = client?.currentSessionId;
    const ticket = this.switchTicket;
    return () => client === this.client && sessionId === client?.currentSessionId && ticket === this.switchTicket;
  }

  private interfaceLanguage() {
    const configured = vscode.workspace.getConfiguration("zcode").get<string>("language", "auto");
    const setting: LanguageSetting = LANGUAGE_SETTINGS.includes(configured as LanguageSetting) ? configured as LanguageSetting : "auto";
    return { setting, locale: resolveUiLanguage(setting, vscode.env.language), vscodeLanguage: vscode.env.language };
  }

  pushLanguage(): void {
    const language = this.interfaceLanguage();
    this.post({ type: "ui_language", language: language.locale, setting: language.setting });
  }

  private currentFormulaFontMode() {
    return formulaFontMode(vscode.workspace.getConfiguration("zcode").get("formulaFonts", "auto"));
  }

  private mathFontDirectory(): string | undefined {
    const root = this.context.globalStorageUri?.fsPath;
    return root ? path.join(root, "math-fonts", MATH_FONT_VERSION) : undefined;
  }

  /** Tell the open page whether formula fonts are available. Does not reload it. */
  private pushMathFonts(): void {
    const mode = this.currentFormulaFontMode();
    const directory = this.mathFontDirectory();
    const ready = !!directory && mathFontPackReady(directory, MATH_FONTS_SHA256);
    let status = mode === "off" ? "disabled"
      : ready ? "ready"
      : this.mathFontPhase === "downloading" ? "downloading"
      : this.mathFontPhase === "failed" ? "failed"
      : "absent";
    let css = "";
    if (status === "ready" && directory && this.view) {
      try {
        css = this.mathFontCssFor(directory);
      } catch (error) {
        logWarn("Could not build formula font CSS", error);
        this.mathFontCssCache = undefined;
      }
    }
    if (status === "ready" && this.view && !css) status = "failed";
    const report = `${mode}:${status}`;
    if (report !== this.mathFontReported) {
      this.mathFontReported = report;
      logInfo("formula fonts", { mode, status, ...(css ? { cssBytes: css.length } : {}) });
    }
    this.post({ type: "math_fonts", mode, status, css });
  }

  private mathFontCssFor(directory: string): string {
    const key = `${directory}\0${MATH_FONTS_SHA256}`;
    if (this.mathFontCssCache?.key === key) return this.mathFontCssCache.css;
    const css = mathFontFaceCss(file => mathFontDataHref(fs.readFileSync(path.join(directory, "fonts", file))));
    this.mathFontCssCache = { key, css };
    return css;
  }

  syncMathFonts(): void {
    if (this.currentFormulaFontMode() === "on") {
      void this.ensureMathFonts().catch(error => logWarn("Formula font setup failed", error));
      return;
    }
    this.mathFontPhase = "idle";
    this.pushMathFonts();
  }

  private async enableMathFonts(): Promise<void> {
    try {
      await vscode.workspace.getConfiguration("zcode").update("formulaFonts", "on", vscode.ConfigurationTarget.Global);
    } catch (error) {
      logWarn("Could not enable formula fonts", error);
      this.mathFontPhase = "failed";
      this.pushMathFonts();
      return;
    }
    await this.ensureMathFonts(true);
  }

  private async ensureMathFonts(force = false): Promise<void> {
    if (!force && this.currentFormulaFontMode() !== "on") {
      this.pushMathFonts();
      return;
    }
    const directory = this.mathFontDirectory();
    if (!directory) {
      this.mathFontPhase = "failed";
      this.pushMathFonts();
      return;
    }
    if (mathFontPackReady(directory, MATH_FONTS_SHA256)) {
      this.mathFontPhase = "idle";
      this.pushMathFonts();
      return;
    }
    if (!this.mathFontTask) {
      this.mathFontPhase = "downloading";
      this.pushMathFonts();
      this.mathFontTask = this.installMathFonts(directory).finally(() => { this.mathFontTask = undefined; });
    }
    await this.mathFontTask;
  }

  private async installMathFonts(directory: string): Promise<void> {
    try {
      const bytes = await loadMathFontPack();
      await installMathFontPack(bytes, directory, MATH_FONTS_SHA256);
      this.mathFontPhase = "idle";
    } catch (error) {
      logWarn("Formula font download failed", error);
      this.mathFontPhase = "failed";
    }
    this.pushMathFonts();
  }

  private composerChrome(): ComposerChrome {
    const saved = this.context.globalState?.get<Partial<ComposerChrome>>("composerChrome") ?? {};
    const on = (key: keyof ComposerChrome) => saved[key] !== false;
    const off = (key: keyof ComposerChrome) => saved[key] === true;
    return {
      showQuestionJump: on("showQuestionJump"),
      showUsageChevron: on("showUsageChevron"),
      showContextRing: on("showContextRing"),
      showFiveHourRing: on("showFiveHourRing"),
      showConnectionStatus: on("showConnectionStatus"),
      sessionControlsIcons: off("sessionControlsIcons"),
      foldSessionControls: off("foldSessionControls"),
      frostedGlass: on("frostedGlass"),
    };
  }

  pushChrome(): void {
    this.post({ type: "composer_chrome", chrome: this.composerChrome() });
  }

  private newSessionDefaults(): NewSessionDefaults {
    return normalizeNewSessionDefaults(this.context.globalState?.get<unknown>(NEW_SESSION_DEFAULTS_KEY));
  }

  private pushNewSessionDefaults(): void {
    this.post({
      type: "new_session_defaults",
      defaults: this.newSessionDefaults(),
      models: this.modelChoices(),
      currentModel: this.currentModel,
    });
  }

  private postHistory(
    page: { items: unknown[]; truncated: boolean; queue?: import("./conversation").ConversationQueueItem[] },
    viewGen?: number,
    renderSource: "snapshot" | "transcript-sync" = "snapshot"
  ): void {
    const sessionId = this.client?.currentSessionId;
    const activeSince = this.client?.activitySince(sessionId);
    if (sessionId && page.items.some(item =>
      typeof item === "object" && item !== null && (item as { role?: unknown }).role === "user")) {
      this.sessionsWithUserMessages.add(sessionId);
    }
    this.client?.noteHistoryDelivered(page.items);
    this.timing?.addCount("historyPosts");
    this.timing?.note("historyItems", page.items.length);
    this.post({
      type: "history",
      items: page.items,
      truncated: page.truncated,
      queue: page.queue ?? this.client?.queuedMessages(),
      renderSource,
      ...(typeof viewGen === "number" ? { viewGen } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(activeSince ? { activeSince } : {}),
    });
    const questionsStarted = Date.now();
    const questions = sessionId ? this.sessionQuestions(sessionId, page.items) : [];
    // A truncated page may contain only assistant rows. The existing question
    // index still proves this is an established conversation, not a new chat.
    if (sessionId && questions.length) this.sessionsWithUserMessages.add(sessionId);
    const questionIndexMs = Date.now() - questionsStarted;
    this.timing?.add("questionIndex", questionIndexMs);
    if (renderSource === "transcript-sync") {
      logInfo("transcript sync index", { itemCount: page.items.length, indexedQuestionCount: questions.length, questionIndexMs });
    }
    this.post({
      type: "question_index",
      questions,
      ...(typeof viewGen === "number" ? { viewGen } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
  }

  /** The database scan is repeated only when the delivered user rows change. */
  private sessionQuestions(sessionId: string, items: unknown[]): SessionQuestion[] {
    const users = items.flatMap((item) => {
      const row = item as { role?: unknown; id?: unknown; text?: unknown };
      return row?.role === "user" && typeof row.id === "string" && row.id ? [{ id: row.id, text: typeof row.text === "string" ? row.text : "" }] : [];
    });
    const digest = createHash("sha1");
    for (const user of users) digest.update(user.id).update("\u0000").update(user.text).update("\u0001");
    const key = `${sessionId}\u0000${digest.digest("hex")}`;
    const cached = this.questionIndexCache;
    if (cached?.key === key) {
      this.timing?.addCount("questionIndexCacheHits");
      return cached.questions;
    }
    const questions = this.readSessionQuestions(sessionId);
    // A row the database has not persisted yet must be re-read next time.
    const indexed = new Set(questions.map((question) => question.id));
    this.questionIndexCache = users.every((user) => indexed.has(user.id)) ? { key, questions } : null;
    return questions;
  }

  private finishTiming(timing: StartupTiming): void {
    timing.dispose();
    const snapshot = timing.snapshot();
    logInfo("session timing", snapshot);
    if (this.timing === timing) this.timing = null;
    this.client?.clearTiming(timing);
    if (isSlowWindowsStartup(process.platform, snapshot)) {
      void this.offerDefenderExclusion(Number(snapshot["session/resume"]));
    }
  }

  /** Explain the measured Defender cost of a cold plugin scan; the user decides. */
  private async offerDefenderExclusion(resumeMs: number): Promise<void> {
    if (this.defenderNoticeShown || this.context.globalState.get<boolean>(DEFENDER_NOTICE_KEY)) return;
    const folders = pluginScanFolders(this.appServerPath, os.homedir(), fs.existsSync);
    if (!folders.length) return;
    this.defenderNoticeShown = true;
    const details = t("查看原因和处理方法");
    const never = t("不再提示");
    const choice = await vscode.window.showWarningMessage(
      t("本次启动恢复会话用了 {0} 秒，Windows 上常见原因是 Microsoft Defender 实时扫描 ZCode 插件文件。",
        { 0: Math.round(resumeMs / 1000) }),
      details, never);
    if (choice === never) {
      await this.context.globalState.update(DEFENDER_NOTICE_KEY, true);
      return;
    }
    if (choice !== details) return;
    const copy = t("复制排除命令");
    const picked = await vscode.window.showWarningMessage(
      t("启动变慢的原因"),
      {
        modal: true,
        detail: t("长时间未启动后，ZCode 服务端恢复会话前会同步读取插件文件。Microsoft Defender 会在首次打开时逐个扫描这些文件，可能耗时数十秒；短时间内重新打开会命中扫描缓存，所以通常只有几秒。\n\n可选处理：在管理员 PowerShell 中把下列目录加入 Defender 排除项：\n{0}\n\n排除后这些目录不再被实时扫描，请自行权衡。不要排除 Code.exe 进程。复制的命令包含撤销方法。",
          { 0: folders.join("\n") }),
      },
      copy);
    if (picked !== copy) return;
    await vscode.env.clipboard.writeText(defenderExclusionCommand(folders,
      t("在管理员 PowerShell 中运行；只排除 ZCode 插件目录，不要排除 Code.exe。"),
      t("如需撤销，去掉下一行开头的 # 后运行：")));
    void vscode.window.showInformationMessage(t("已复制。请在管理员 PowerShell 中运行，然后重启 VS Code。"));
  }

  private paintTitle(title?: string): void {
    const next = (title || this.client?.currentTitle || "").trim();
    if (!next) return;
    this.post({ type: "session_title", title: next, sessionId: this.client?.currentSessionId });
    if (this.view) this.view.title = next;
  }

  private indexCurrentSession(title?: string): void {
    const sessionId = this.client?.currentSessionId;
    if (!sessionId || !this.workspacePath) return;
    const task = {
      workspacePath: this.workspacePath,
      sessionId,
      title: title || this.client?.currentTitle || "新会话",
      model: this.currentModel
        ? `${this.currentModel.providerId}/${this.currentModel.modelId}`
        : this.runtime
          ? `${this.runtime.providerId}/${this.runtime.modelId}`
          : undefined,
      updatedAt: Date.now(),
      mode: this.client?.currentMode(),
    };
    if (!persistCliSession(task)) return;
    upsertDesktopTask(task);
  }

  private releaseViewListeners(): void {
    this.viewVisibilityListener?.dispose();
    this.viewMessageListener?.dispose();
    this.viewDisposeListener?.dispose();
    this.viewVisibilityListener = this.viewMessageListener = this.viewDisposeListener = undefined;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.releaseViewListeners();
    this.view = webviewView;
    // The view is destroyed when the user closes or moves it; drop it so nothing posts into a disposed webview.
    this.viewDisposeListener = webviewView.onDidDispose?.(() => {
      if (this.view !== webviewView) return;
      this.releaseViewListeners();
      this.view = undefined;
      this.client?.setViewVisible(false);
      this.setRunningPollVisibility(false);
    });
    this.viewVisibilityListener = webviewView.onDidChangeVisibility?.(() => {
      if (this.view !== webviewView) return;
      const visible = webviewView.visible === true;
      this.client?.setViewVisible(visible);
      this.setRunningPollVisibility(visible);
    });
    const visible = webviewView.visible === true;
    this.client?.setViewVisible(visible);
    this.setRunningPollVisibility(visible);
    webviewView.webview.options = {
      enableScripts: true,
      // Fonts are inlined as data URIs. The cache directory is not a webview resource.
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    const nonce = getNonce();
    webviewView.webview.html = getWebviewHtml(
      webviewView.webview,
      this.context.extensionUri,
      nonce,
      this.interfaceLanguage(),
      this.composerChrome()
    );

    this.viewMessageListener = webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const parsed = parseWebviewMessage(raw);
      if (!parsed.ok) {
        logDebug("Dropped webview message", parsed.rejection);
        return;
      }
      const msg = parsed.message;
      const isCurrent = this.viewScope();
      if (msg.type === "stop") {
        if (!msg.sessionId || msg.sessionId !== this.client?.currentSessionId) return;
        void this.stopGeneration();
        return;
      }
      if (msg.type === "insert" && (msg.text || readImageAttachments(msg.attachments).length)) {
        const sessionId = msg.sessionId;
        const client = this.client;
        let planModeApplied = false;
        const operation = client && !!sessionId && sessionId === client.currentSessionId
          ? (async () => {
              if (this.pendingModelFor(client.currentSessionId)) {
                const applied = await this.applyPendingModel(client);
                if (!applied) {
                  throw new Error(client === this.client && sessionId === client.currentSessionId
                    ? t("该模型已不可用，请刷新模型列表后重新选择。")
                    : t("会话已切换，请在当前会话重新发送。"));
                }
                if (client !== this.client || sessionId !== client.currentSessionId) {
                  throw new Error(t("会话已切换，请在当前会话重新发送。"));
                }
              }
              if (msg.planMode) {
                await client.setMode("plan");
                if (client !== this.client || sessionId !== client.currentSessionId) {
                  throw new Error(t("会话已切换，请在当前会话重新发送。"));
                }
                planModeApplied = true;
              }
              const payload = buildPrompt(msg.text || "", prepareFileContext(msg.chips ?? [], this.workspacePath, vscode.workspace.textDocuments ?? []), this.sessionReferences(msg.sessionRefs));
              return client.insertQueuedMessage(payload, { immediate: !!msg.immediate, commandId: msg.queueItemId, attachments: readImageAttachments(msg.attachments) });
            })()
          : Promise.reject(new Error(t("会话已切换，请在当前会话重新发送。")));
        void operation.then(commandId => {
          this.post({ type: "queue_admitted", commandId, sessionId });
        }).catch(e => {
          logError("insert message failed", e);
          if (msg.planMode && !planModeApplied && client && client === this.client && sessionId === client.currentSessionId) {
            this.post({ type: "session_controls", ...client.confirmedControls() });
          }
          // Recovery belongs to the original draft even after the user switches.
          this.post({ type: "queue_rejected", commandId: msg.queueItemId, sessionId,
            text: msg.recoveryText ?? msg.text, chips: msg.chips ?? [], ...(msg.sessionRefs?.length ? { sessionRefs: msg.sessionRefs } : {}), ...(readImageAttachments(msg.attachments).length ? { attachments: readImageAttachments(msg.attachments) } : {}), ...(msg.keepDraft === false ? { keepDraft: false } : {}), message: userFacingError(e) });
        });
        return;
      }
      if (["queueEdit", "queueDelete", "queueSendNow", "queueReorder"].includes(msg.type) && msg.queueItemId) {
        const client = this.client;
        const sessionId = msg.sessionId;
        if (!client || !sessionId || sessionId !== client.currentSessionId) {
          if (msg.type === "queueEdit") this.post({ type: "queue_edit_result", sessionId,
            queueItemId: msg.queueItemId, requestId: msg.requestId, viewGen: msg.viewGen, ok: false,
            message: t("会话已切换，请在当前会话重新发送。") });
          return;
        }
        const stillOwned = () => client === this.client && client.currentSessionId === sessionId;
        const operation = msg.type === "queueEdit" ? client.editQueuedMessage(msg.queueItemId, msg.text || "")
          : msg.type === "queueDelete" ? client.deleteQueuedMessage(msg.queueItemId)
          : msg.type === "queueReorder" ? client.reorderQueuedMessage(msg.queueItemId, msg.beforeQueueItemId ?? null)
          : this.pendingModelFor(client.currentSessionId)
            ? this.applyPendingModel(client).then(applied => {
                if (!applied) throw new Error(t(stillOwned()
                  ? "该模型已不可用，请刷新模型列表后重新选择。"
                  : "会话已切换，请在当前会话重新发送。"));
                if (!stillOwned()) throw new Error(t("会话已切换，请在当前会话重新发送。"));
                return client.sendQueuedNow(msg.queueItemId!);
              })
            : client.sendQueuedNow(msg.queueItemId);
        const editResult = (ok: boolean, error?: unknown) => {
          if (msg.type === "queueEdit") this.post({ type: "queue_edit_result", sessionId,
            queueItemId: msg.queueItemId, requestId: msg.requestId, viewGen: msg.viewGen, ok,
            ...(error ? { message: userFacingError(error) } : {}) });
        };
        const refresh = () => {
          if (isCurrent() && stillOwned()) this.post({ type: "queue_sync", sessionId, items: client.queuedMessages() ?? [] });
        };
        void operation.then(() => { editResult(true); if (msg.type !== "queueReorder" && msg.type !== "queueEdit") refresh(); }).catch(e => {
          editResult(false, e);
          if (!isCurrent()) return;
          refresh();
          logError("queue command failed", e);
          if (msg.type !== "queueEdit") this.post({ type: "toast", text: userFacingError(e) });
        });
        return;
      }
      if (msg.type === "userInputAnswer" && msg.requestId && msg.action) {
        this.client?.answerUserInput(msg.requestId, {
          action: msg.action,
          content: msg.content,
          reason: msg.reason,
        });
        return;
      }
      if (msg.type === "permissionAnswer" && msg.requestId && msg.optionId) {
        this.client?.answerPermission(msg.requestId, msg.optionId);
        return;
      }
      void this.onWebviewMessage(msg).catch((e) => {
        if (!isCurrent()) return;
        const message = userFacingError(e);
        logError("webview message failed", e);
        this.post({ type: "session_error", message });
      });
    });

    if (!this.client) {
      void this.startZCode();
    }
  }

  private async copyDiagnostics(): Promise<void> {
    const runtime = this.client?.diagnosticSummary();
    const home = os.homedir();
    const rawWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || home;
    const report = {
      format: "zcode-diagnostics-v1", generatedAt: new Date().toISOString(),
      platform: process.platform, architecture: process.arch,
      vscodeVersion: vscode.version, extensionVersion: this.context.extension?.packageJSON?.version ?? "unknown",
      desktopVersion: desktopVersion(runtime?.binaryPath || "") ?? "unknown",
      nodeVersion: process.version, status: this.diagnosticStatus,
      workspace: {
        vscodePath: redactHome(rawWorkspace, home),
        configuredPath: redactHome(vscode.workspace.getConfiguration("zcode").get<string>("workspacePath") || "", home),
        effectivePath: redactHome(this.workspacePath, home),
        folderCount: vscode.workspace.workspaceFolders?.length ?? 0,
      },
      runtime: runtime ? {
        binaryPath: redactHome(runtime.binaryPath, home), nodePath: redactHome(runtime.nodePath, home),
        serverReady: runtime.serverReady, sessionAttached: runtime.sessionAttached,
        synchronizationFailures: runtime.synchronizationFailures,
        pendingPermissions: runtime.pendingPermissions, pendingQuestions: runtime.pendingQuestions,
      } : null,
      recentIssues: this.recentIssues,
      // Deliberately omit raw errors, messages, session IDs, settings and credentials.
    };
    await vscode.env.clipboard.writeText(redactSecrets(JSON.stringify(report, null, 2)));
    this.post({type: "toast", text: t("诊断信息已复制（不含聊天内容或登录凭据）。")});
  }

  private async runWebviewSessionAction(sessionId: string, actionRequestId: string | undefined, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } finally {
      if (actionRequestId) this.post({ type: "session_action_complete", sessionId, actionRequestId });
    }
  }

  private async onWebviewMessage(msg: WebviewIn): Promise<void> {
    switch (msg.type) {
      case "historyRenderTiming": {
        const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
        const source = msg.historyRenderSource === "transcript-sync" || msg.historyRenderSource === "older" ? msg.historyRenderSource : "snapshot";
        logInfo("history render", {
          source,
          syncMs: count(msg.historySyncMs),
          twoFrameMs: count(msg.historyFrameMs),
          itemCount: count(msg.historyItemCount),
          previousDomRows: count(msg.historyPreviousDomRows),
          currentDomRows: count(msg.historyCurrentDomRows),
          truncated: msg.historyTruncated === true,
          visible: msg.historyVisible === true,
          renderMode: msg.historyRenderMode === "append" ? "append" : "full",
        });
        break;
      }
      case "responsePainted":
        if (msg.sessionId && msg.timingId) this.sendTiming.visible(msg.sessionId, msg.timingId, msg.frameWaitMs);
        break;
      case "copyDiagnostics":
        await this.copyDiagnostics();
        break;
      case "setLanguage": {
        if (!LANGUAGE_SETTINGS.includes(msg.language as LanguageSetting)) throw new Error("Unsupported interface language");
        await vscode.workspace.getConfiguration("zcode").update("language", msg.language, vscode.ConfigurationTarget.Global);
        this.pushLanguage();
        break;
      }
      case "installMathFonts":
        await this.enableMathFonts();
        break;
      case "setChrome": {
        const current = this.composerChrome();
        const key = msg.chromeKey as keyof ComposerChrome | undefined;
        if (!key || !(key in current) || typeof msg.enabled !== "boolean") break;
        try {
          await this.context.globalState.update("composerChrome", { ...current, [key]: msg.enabled });
          this.pushChrome();
        } catch (e) {
          logWarn("composer chrome save failed", e);
        }
        break;
      }
      case "setNewSessionDefaults": {
        const defaults = normalizeNewSessionDefaults(msg.defaults);
        try {
          await this.context.globalState.update(NEW_SESSION_DEFAULTS_KEY, defaults);
          this.pushNewSessionDefaults();
        } catch (error) {
          logWarn("new-session defaults save failed", error);
        }
        break;
      }
      case "ready":
        // The page posts "ready" once per load. A reload without a new
        // resolveWebviewView (Reload Webviews, renderer recovery) is still a
        // blank page that needs the full state again.
        this.webviewEpoch++;
        this.pushLanguage();
        this.pushChrome();
        this.pushNewSessionDefaults();
        void this.syncMathFonts();
        this.flushOpenSettings();
        if (this.starting) await this.starting;
        if (!this.client) await this.startZCode();
        else if (this.pushedEpoch !== this.webviewEpoch) await this.pushSessionState({ forceHistory: true });
        this.pushEditorContext();
        if (this.pendingChip) {
          this.post({ type: "addChip", chip: this.pendingChip });
          this.pendingChip = undefined;
        }
        break;
      case "fileReferenceDetails": {
        const document=(vscode.workspace.textDocuments ?? []).find(doc=>msg.path && sameWorkspacePath(doc.uri.fsPath,msg.path));
        this.post({type:"file_reference_details",path:msg.path,sessionId:msg.sessionId,requestId:msg.requestId,dirty:document?.isDirty});
        break;
      }
      case "searchWorkspaceFiles": {
        const root=this.workspacePath,query=(msg.text || "").slice(0,128);
        if (!msg.requestId) break;
        this.fileSearchCancellation?.cancel();this.fileSearchCancellation?.dispose();
        const cancellation=new vscode.CancellationTokenSource();this.fileSearchCancellation=cancellation;
        if (!root) { this.post({type:"workspace_files",requestId:msg.requestId,sessionId:msg.sessionId,files:[],error:"noWorkspace"});break; }
        try {
          this.pushEditorContext();
          let cache=this.fileSearchCache;
          if (!cache || cache.root!==root || cache.query!==query || Date.now()-cache.at>15000) {
            const lists=await Promise.all(workspaceSearchPatterns(query).map(pattern=>vscode.workspace.findFiles(new vscode.RelativePattern(root,pattern),"**/{.git,node_modules,.venv,venv,dist,build,out}/**",query ? 5000 : 1000,cancellation.token)));
            if(cancellation.token.isCancellationRequested || root!==this.workspacePath)break;
            cache={root,query,at:Date.now(),files:lists.flat().map(uri=>path.relative(root,uri.fsPath))};
            if(root===this.workspacePath)this.fileSearchCache=cache;
          }
          const recent=[...this.recentFiles,...(vscode.workspace.textDocuments ?? []).filter(doc=>doc.uri.scheme==="file").map(doc=>doc.uri.fsPath)].map(file=>path.relative(root,file)).filter(file=>file && !path.isAbsolute(file) && file!==".." && !file.startsWith(".."+path.sep) && !/(^|[\\/])(?:node_modules|\.git|dist|build|out|\.venv|venv)([\\/]|$)/.test(file));
          const files=rankWorkspaceFiles([...recent,...cache.files],query,40,recent).map(relPath=>({relPath,path:path.join(root,relPath)}));
          if(!cancellation.token.isCancellationRequested)this.post({type:"workspace_files",requestId:msg.requestId,sessionId:msg.sessionId,files});
        } catch {
          if(!cancellation.token.isCancellationRequested)this.post({type:"workspace_files",requestId:msg.requestId,sessionId:msg.sessionId,files:[],error:"searchFailed"});
        }
        break;
      }
      case "pickAttachments": {
        const client = this.client;
        const owner = client?.currentSessionId;
        if (!client || !owner || (msg.sessionId && msg.sessionId !== owner)) break;
        const files = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, defaultUri: vscode.Uri.file(this.workspacePath || os.homedir()) });
        this.post({type:"attachment_picker_closed", sessionId:owner});
        if (!files) break;
        await this.attachFiles(files, client, owner, msg.maxImages, msg.edit === true, msg.editRequestId);
        break;
      }
      case "attachFileUris": {
        const client = this.client; const owner = msg.sessionId;
        if (!client || !owner || owner !== client.currentSessionId || !Array.isArray(msg.uris)) break;
        const uris: vscode.Uri[] = [];
        for (const value of msg.uris.slice(0, 20)) {
          if (typeof value !== "string") continue;
          try { const uri = vscode.Uri.parse(value, true); if (uri.scheme === "file" && !uri.authority && !uri.query && !uri.fragment) uris.push(uri); } catch { /* Ignore malformed drag data. */ }
        }
        await this.attachFiles(uris, client, owner, msg.maxImages, msg.edit === true, msg.editRequestId); break;
      }
      case "uploadImage": {
        const client = this.client;
        const owner = msg.sessionId;
        try {
          if (!client || !owner) throw new Error(t("会话已切换，请在当前会话重新发送。"));
          const bytes = decodeImage(msg.dataUrl || "");
          const attachment = await client.uploadImage(bytes, msg.fileName || "image.png", owner);
          this.post({ type: "image_ready", sessionId: owner, imageId: msg.imageId, attachment, ...(msg.edit ? {edit:true, editRequestId:msg.editRequestId} : {}) });
        } catch (error) { this.post({ type: "image_failed", sessionId: owner, imageId: msg.imageId, message: userFacingError(error), ...(msg.edit ? {edit:true, editRequestId:msg.editRequestId} : {}) }); }
        break;
      }
      case "thumbnailImage":
      case "previewImage": {
        try {
          const attachment = readImageAttachments(msg.attachments)[0];
          if (!this.client || !msg.sessionId || !attachment) break;
          const bytes = await this.client.readImage(attachment, msg.sessionId, Number.isSafeInteger(msg.rowId) && msg.entityId && Number.isSafeInteger(msg.attachmentIndex) && msg.attachmentIndex! >= 0 ? {target:{rowId:msg.rowId!,entityId:msg.entityId},attachmentIndex:msg.attachmentIndex!} : undefined);
          this.post({ type: msg.type === "thumbnailImage" ? "image_thumbnail" : "image_preview", requestId: msg.requestId, dataUrl: "data:" + attachment.mime + ";base64," + bytes.toString("base64") });
        } catch (error) {
          if(msg.type === "thumbnailImage")this.post({type:"image_thumbnail",requestId:msg.requestId});
          else this.post({ type: "toast", message: userFacingError(error) });
        }
        break;
      }
      case "send": {
        let sessionId = msg.sessionId || this.client?.currentSessionId;
        const timingId = randomUUID();
        let planModeApplied = false;
        if (sessionId && sessionId === this.client?.currentSessionId) this.sendTiming.start(sessionId, timingId, msg.sentAt);
        try {
          if (!this.client) await this.startZCode();
          const client = this.client;
          sessionId ||= client?.currentSessionId;
          const isCurrent = this.viewScope();
          if (!client || (!msg.text && !readImageAttachments(msg.attachments).length)) throw new Error(t("当前没有可发送的内容。"));
          if (msg.planMode && (!msg.sessionId || msg.sessionId !== client.currentSessionId)) throw new Error(t("会话已切换，请在当前会话重新发送。"));
          if (msg.sessionId && msg.sessionId !== client.currentSessionId) throw new Error(t("会话已切换，请在当前会话重新发送。"));
          if (this.pendingModelFor(client.currentSessionId)) {
            const applied = await this.applyPendingModel(client);
            if (!applied) throw new Error(t(client === this.client && sessionId === client.currentSessionId
              ? "该模型已不可用，请刷新模型列表后重新选择。"
              : "会话已切换，请在当前会话重新发送。"));
            if (client !== this.client || (msg.sessionId && msg.sessionId !== client.currentSessionId)) throw new Error(t("会话已切换，请在当前会话重新发送。"));
          }
          if (msg.planMode) {
            await client.setMode("plan");
            if (client !== this.client || !sessionId || client.currentSessionId !== sessionId) {
              throw new Error(t("会话已切换，请在当前会话重新发送。"));
            }
            planModeApplied = true;
          }
          const prompt = buildPrompt(msg.text || "", prepareFileContext(msg.chips ?? [], this.workspacePath, vscode.workspace.textDocuments ?? []), this.sessionReferences(msg.sessionRefs));
          this.sendTiming.mark(timingId, "promptPreparedMs");
          const sentSessionId = sessionId ?? client.currentSessionId ?? "";
          const hadPriorUserMessage = this.sessionsWithUserMessages.has(sentSessionId);
          await client.sendMessage(prompt, readImageAttachments(msg.attachments));
          this.sendTiming.admitted(timingId);
          this.flushSwitchBanner(sentSessionId, hadPriorUserMessage);
          if (sentSessionId) this.sessionsWithUserMessages.add(sentSessionId);
          this.post({ type: "send_admitted", commandId: msg.commandId, sessionId: sessionId ?? undefined });
          if (isCurrent()) this.indexCurrentSession();
        } catch (error) {
          this.sendTiming.end("rejected", timingId);
          logError("send message failed", error);
          const client = this.client;
          if (msg.planMode && !planModeApplied && client && client.currentSessionId === sessionId) {
            this.post({ type: "session_controls", ...client.confirmedControls() });
          }
          this.post({ type: "send_rejected", commandId: msg.commandId, sessionId,
            text: msg.recoveryText ?? msg.text, chips: msg.chips ?? [], ...(msg.sessionRefs?.length ? { sessionRefs: msg.sessionRefs } : {}), ...(readImageAttachments(msg.attachments).length ? { attachments: readImageAttachments(msg.attachments) } : {}), ...(msg.keepDraft === false ? { keepDraft: false } : {}), message: userFacingError(error) });
        }
        break;
      }
      case "stop":
        await this.client?.stopGeneration();
        break;
      case "newSession":
        await this.newSession();
        break;
      case "listSessions":
        await this.refreshSessions(!!msg.includeArchived);
        break;
      case "switchSession":
        if (msg.sessionId) await this.switchSession(msg.sessionId);
        break;
      case "loadOlder":
      case "loadThrough": {
        const client = this.client;
        const sessionId = client?.currentSessionId;
        const viewGen = this.switchTicket;
        if (!client || !sessionId || !msg.oldestId || (msg.type === "loadThrough" && !msg.messageId)) break;
        if ((msg.sessionId && msg.sessionId !== sessionId) || (msg.viewGen !== undefined && msg.viewGen !== viewGen)) break;
        const isCurrent = () => client === this.client && sessionId === client.currentSessionId && viewGen === this.switchTicket;
        try {
          const page = await client.olderMessages(msg.oldestId, msg.type === "loadThrough" ? msg.messageId : undefined);
          if (isCurrent()) this.post({ type: "historyOlder", sessionId, viewGen, requestId: msg.requestId,
            items: page.items, more: page.more, ...(msg.type === "loadThrough" ? { jumpId: msg.messageId } : {}) });
        } catch (error) {
          logWarn("history page load failed", error);
          if (isCurrent()) this.post({ type: "history_load_failed", sessionId, viewGen, requestId: msg.requestId,
            ...(msg.type === "loadThrough" ? { jumpId: msg.messageId } : {}), message: userFacingError(error) });
        }
        break;
      }
      case "archiveSession":
        if (msg.sessionId) await this.runWebviewSessionAction(msg.sessionId, msg.actionRequestId, () => this.archiveSession(msg.sessionId!, true));
        break;
      case "unarchiveSession":
        if (msg.sessionId) await this.runWebviewSessionAction(msg.sessionId, msg.actionRequestId, () => this.archiveSession(msg.sessionId!, false));
        break;
      case "deleteSession":
        if (msg.sessionId) await this.runWebviewSessionAction(msg.sessionId, msg.actionRequestId, () => this.deleteSession(msg.sessionId!));
        break;
      case "renameSession":
        if (msg.sessionId) {
          await this.runWebviewSessionAction(msg.sessionId, msg.actionRequestId, async () => {
            if (msg.commit && msg.title) {
              if (msg.actionRequestId) this.post({ type: "session_action_started", sessionId: msg.sessionId, actionRequestId: msg.actionRequestId, action: "rename" });
              await this.applyRename(msg.sessionId!, msg.title!);
            } else await this.renameSession(msg.sessionId!, msg.title, msg.actionRequestId);
          });
        }
        break;
      case "selectModel":
        if (msg.providerId && msg.modelId) {
          await this.selectModel(msg.providerId, msg.modelId, !!msg.restart);
        }
        break;
      case "retry":
        await this.startZCode({ force: true });
        break;
      case "retryLast": {
        const ticket = this.switchTicket;
        const attachments = readImageAttachments(msg.attachments);
        let client = this.client;
        let sessionId = msg.sessionId || client?.currentSessionId;
        if (!msg.text && !attachments.length) break;
        try {
          if (!client) {
            await this.startZCode();
            client = this.client;
            sessionId ||= client?.currentSessionId;
          }
          const assertRetryOwner = (candidate: ZCodeClient | null): ZCodeClient => {
            if (!candidate || candidate !== this.client || !sessionId || candidate.currentSessionId !== sessionId || ticket !== this.switchTicket) {
              throw new Error(t("会话已切换，请在当前会话重新发送。"));
            }
            return candidate;
          };
          const retryClient = assertRetryOwner(client);
          if (this.pendingModelFor(sessionId) && !await this.applyPendingModel(retryClient)) {
            throw new Error(t(retryClient === this.client && retryClient.currentSessionId === sessionId
              ? "该模型已不可用，请刷新模型列表后重新选择。"
              : "会话已切换，请在当前会话重新发送。"));
          }
          const activeClient = assertRetryOwner(client);
          const prompt = buildPrompt(msg.text || "", prepareFileContext(msg.chips ?? [], this.workspacePath, vscode.workspace.textDocuments ?? []));
          await activeClient.sendMessage(prompt, attachments);
          if (activeClient === this.client && activeClient.currentSessionId === sessionId && ticket === this.switchTicket) this.indexCurrentSession();
        } catch (error) {
          logError("retry last message failed", error);
          this.post({
            type: "send_rejected",
            sessionId,
            text: msg.text,
            chips: msg.chips ?? [],
            ...(attachments.length ? { attachments } : {}),
            message: userFacingError(error),
          });
        }
        break;
      }
      case "openRecoverySettings":
        if (msg.setting === "binaryPath" || msg.setting === "nodePath") await this.runRecoveryAction(msg.setting);
        break;
      case "openCommunity":
        await vscode.env.openExternal(vscode.Uri.parse(COMMUNITY_URL));
        break;
      case "showLog":
        getLog().show(true);
        break;
      case "openFile":
        if (msg.path) await this.openWorkspaceFile(msg.path);
        break;
      case "openMarkdownFile":
        if (msg.path && msg.sessionId && msg.sessionId === this.client?.currentSessionId) {
          await this.openMarkdownFile(msg.path, msg.line, msg.endLine);
        }
        break;
      case "openDiff":
        if (msg.fileChange) await this.openFileDiff(msg.fileChange);
        break;
      case "editLast":
        if (msg.editRequestId && msg.commandId && msg.viewGen === this.switchTicket && this.client && msg.sessionId && msg.sessionId === this.client.currentSessionId &&
            (msg.text || readImageAttachments(msg.attachments).length) && msg.rowId != null && msg.entityId) {
          const client = this.client;
          const sessionId = msg.sessionId;
          const isCurrent = this.viewScope();
          try {
            if (this.pendingModelFor(sessionId)) {
              const applied = await this.applyPendingModel(client);
              if (!applied) throw new Error(t(client === this.client && client.currentSessionId === sessionId
                ? "该模型已不可用，请刷新模型列表后重新选择。"
                : "会话已切换，请在当前会话重新发送。"));
              if (client !== this.client || client.currentSessionId !== sessionId) break;
            }
            const editedPrompt = buildPrompt(msg.text || "", [], this.sessionReferences(msg.sessionRefs));
            if (client !== this.client || client.currentSessionId !== sessionId) break;
            await client.editUserQuery(
              { rowId: msg.rowId, entityId: msg.entityId },
              editedPrompt,
              msg.workspaceMode === "rewind" ? "rewind" : "preserve",
              readImageAttachments(msg.attachments)
            );
            if (!isCurrent() || client !== this.client || client.currentSessionId !== sessionId) break;
            this.post({ type: "query_rewound", text: editedPrompt, sessionId, viewGen: msg.viewGen, editRequestId: msg.editRequestId, commandId: msg.commandId, entityId: msg.entityId, attachments: readImageAttachments(msg.attachments) });
            this.indexCurrentSession();
          } catch (e) {
            if (!isCurrent()) break;
            logWarn("editUserQuery failed", e);
            this.post({ type: "query_edit_rejected", sessionId, viewGen: msg.viewGen, editRequestId: msg.editRequestId, commandId: msg.commandId, entityId: msg.entityId, message: userFacingError(e) });
          }
        }
        break;
      case "loadFileChanges":
        if (this.client && msg.rowId != null && msg.entityId && msg.turnId) {
          const isCurrent = this.viewScope();
          try {
            const files = await this.client.conversationFileChanges({
              rowId: msg.rowId,
              entityId: msg.entityId,
            });
            if (!isCurrent()) break;
            this.post({ type: "file_changes", turnId: msg.turnId, files });
          } catch (e) {
            if (!isCurrent()) break;
            logWarn("fileChanges failed", e);
            this.post({
              type: "file_changes",
              turnId: msg.turnId,
              files: [],
              error: userFacingError(e),
            });
          }
        }
        break;
      case "loadPreviewFiles":
        if (this.client && msg.sessionId === this.client.currentSessionId && msg.turnId && msg.signature &&
            Array.isArray(msg.previewCandidates)) {
          const isCurrent = this.viewScope();
          const candidates = msg.previewCandidates.filter((value): value is string =>
            typeof value === "string" && value.length <= 2048).slice(0, 15);
          const needsChanges = candidates.some(value => {
            const kind = previewFileKind(value)?.kind;
            return kind === "markdown" || kind === "html";
          });
          let changedPaths: string[] = [];
          if (needsChanges && msg.fileChangesState !== "reverted" && msg.rowId != null && msg.entityId) {
            try {
              const files = await this.client.conversationFileChanges({ rowId: msg.rowId, entityId: msg.entityId });
              changedPaths = files.map(file => file.path);
            } catch (e) {
              logWarn("Could not verify preview file changes", e);
            }
          }
          if (!isCurrent()) break;
          this.post({ type: "preview_files", sessionId: msg.sessionId, turnId: msg.turnId,
            signature: msg.signature,
            cards: previewFilesForReply(this.workspacePath, candidates, changedPaths, msg.fileChangesState) });
        }
        break;
      case "rewindFiles":
        if (this.client && msg.sessionId && msg.sessionId === this.client.currentSessionId && msg.rowId != null && msg.entityId) {
          const client = this.client;
          const sessionId = msg.sessionId;
          const isCurrent = this.viewScope();
          try {
            await client.rewindTurnFiles({
              rowId: msg.rowId,
              entityId: msg.entityId,
            });
            if (!isCurrent() || client !== this.client || client.currentSessionId !== sessionId) break;
            this.post({ type: "toast", text: t("已撤销这些文件改动") });
          } catch (e) {
            if (!isCurrent()) break;
            logWarn("applyFileRewind failed", e);
            this.post({ type: "toast", text: userFacingError(e) });
          }
        }
        break;
      case "openGitDiff":
        if (msg.path && msg.patches) {
          await this.openGitDiff(msg.path, msg.patches, !!msg.reverted);
        }
        break;
      case "copy":
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          this.post({ type: "copied" });
        }
        break;
      case "permissionAnswer":
        if (msg.requestId && msg.optionId) {
          this.client?.answerPermission(msg.requestId, msg.optionId);
        }
        break;
      case "userInputAnswer":
        if (msg.requestId && msg.action) {
          this.client?.answerUserInput(msg.requestId, {
            action: msg.action,
            content: msg.content,
            reason: msg.reason,
          });
        }
        break;
      case "setMode":
        if (msg.mode && msg.sessionId && msg.sessionId === this.client?.currentSessionId
          && (msg.viewGen === undefined || msg.viewGen === this.switchTicket)) {
          const client = this.client;
          const ticket = this.switchTicket;
          try {
            await client.setMode(msg.mode);
          } catch (e) {
            logError("setMode failed", e);
            if (client !== this.client || msg.sessionId !== client.currentSessionId || ticket !== this.switchTicket) break;
            this.post({ type: "session_controls", ...client.confirmedControls() });
            vscode.window.showErrorMessage(t("切换权限模式失败：{0}", { 0: userFacingError(e) }));
          }
        }
        break;
      case "setThoughtLevel":
        if (msg.thoughtLevel && msg.sessionId && msg.sessionId === this.client?.currentSessionId && msg.viewGen === this.switchTicket) {
          const client = this.client;
          const ticket = this.switchTicket;
          try {
            await client?.setThoughtLevel(msg.thoughtLevel);
          } catch (e) {
            logError("setThoughtLevel failed", e);
            if (client !== this.client || msg.sessionId !== client?.currentSessionId || ticket !== this.switchTicket) break;
            this.post({ type: "session_controls", ...client.confirmedControls() });
            vscode.window.showErrorMessage(
              t("切换推理强度失败：{0}", { 0: userFacingError(e) })
            );
          }
        }
        break;
    }
  }

  private sessionReferences(references?: SessionReference[]): SessionReference[] {
    if (!Array.isArray(references)) return [];
    const available = new Map(this.sessions.filter(session => !session.archivedAt).map(session => [session.sessionId, session.title]));
    const seen = new Set<string>();
    return references.flatMap(reference => {
      if (!reference || typeof reference.sessionId !== "string" || !/^sess_[A-Za-z0-9_-]+$/.test(reference.sessionId)) {
        throw new Error(t("引用的会话已不可用，请重新搜索后添加。"));
      }
      if (seen.has(reference.sessionId)) return [];
      const title = available.get(reference.sessionId);
      if (!title) throw new Error(t("引用的会话已不可用，请重新搜索后添加。"));
      seen.add(reference.sessionId);
      return [{ sessionId: reference.sessionId, title }];
    });
  }

  async newSession(): Promise<void> {
    if (!this.client) {
      await this.startZCode({ createNew: true });
      return;
    }
    const client = this.client;
    const ticket = ++this.switchTicket;
    await client.prepareViewChange();
    try {
      const defaults = this.newSessionDefaults();
      const modelOverride = defaults.model
        ? ""
        : vscode.workspace.getConfiguration("zcode").get<string>("model") || "";
      const resolved = await resolveRuntime({
        appVersion: this.desktopAppVersion,
        modelOverride,
        preferredProviderId: defaults.model?.providerId,
        preferredModelId: defaults.model?.modelId,
      });
      if (ticket !== this.switchTicket || client !== this.client) return;
      this.picker = resolved.picker;
      this.disabledModelKeys = new Set(resolved.disabledModelKeys ?? []);
      this.managedProviderIds = new Set(resolved.managedProviderIds ?? []);
      this.providerInventoryAuthoritative = resolved.providerInventoryAuthoritative ?? false;
      if (resolved.ok && resolved.runtime) {
        this.runtime = resolved.runtime;
        client.setDefaultRuntime(resolved.runtime);
        syncCliConfig(resolved.runtime, readV2Config(), false);
      } else if (!this.runtime) {
        vscode.window.showErrorMessage(
          resolved.reason || t("无法复用当前 ZCode 桌面端登录。")
        );
        this.post({ type: "setup", reason: resolved.reason, hint: resolved.hint, picker: resolved.picker });
        return;
      }
      this.post({ type: "view_reset", clear: true, viewGen: ticket });
      await client.newSession(defaults);
      if (ticket !== this.switchTicket || client !== this.client) return;
      if (client.currentSessionId) this.rememberSession(client.currentSessionId);
      await this.pushSessionState();
    } catch (e) {
      if (ticket === this.switchTicket && client === this.client) {
        if (client.currentSessionId) this.post({type:"session_ready",sessionId:client.currentSessionId,kind:"created",title:client.currentTitle || t("新会话"),viewGen:ticket});
        this.post({ type: "stream_release" });
        client.endViewChange();
        this.post({ type: "session_error", message: userFacingError(e) });
        logError("New session initialization failed", e);
      }
      throw e;
    } finally {
      if (ticket === this.switchTicket && client === this.client) client.endViewChange();
    }
  }

  async stopGeneration(): Promise<void> {
    const isCurrent = this.viewScope();
    try { await this.client?.stopGeneration(); }
    catch (e) {
      if (isCurrent()) vscode.window.showErrorMessage(t("停止失败：{0}", { 0: userFacingError(e) }));
    }
  }

  pushEditorContext(): void {
    // Remember navigation for search ranking; never attach editor context implicitly.
    const uri=vscode.window.activeTextEditor?.document.uri;
    if(uri?.scheme==="file")this.recentFiles=[uri.fsPath,...this.recentFiles.filter(file=>!sameWorkspacePath(file,uri.fsPath))].slice(0,30);
  }

  private async attachFiles(files: readonly vscode.Uri[], client: ZCodeClient, owner: string, maxImages = 8, edit = false, editRequestId?: string): Promise<void> {
    let addedImages = 0;
    const limit = Number.isSafeInteger(maxImages) ? Math.max(0, Math.min(8, maxImages)) : 8;
    let warned = false;
        for (const uri of files.slice(0, 20)) {
          if (uri.scheme !== "file") continue;
          if (/\.(png|jpe?g|webp|gif)$/i.test(uri.fsPath)) {
            if (addedImages >= limit) { if (!warned) this.post({type:"toast", text:t("最多添加 8 张图片。")}); warned = true; continue; }
            addedImages++;
            const id = randomUUID();
            const routed = edit ? { edit: true, editRequestId } : {};
            try {
              const stat = await fs.promises.stat(uri.fsPath);
              if (!stat.isFile() || stat.size > IMAGE_MAX_BYTES) throw new Error(t("每张图片不能超过 20 MB。"));
              const bytes = await fs.promises.readFile(uri.fsPath);
              const mime = imageMime(bytes);
              if (!mime) throw new Error(t("请选择 PNG、JPEG、WebP 或 GIF 图片。"));
              this.post({ type: "image_pending", sessionId: owner, imageId: id, fileName: path.basename(uri.fsPath), mime, bytes: bytes.length, ...routed });
              const attachment = await client.uploadImage(bytes, path.basename(uri.fsPath), owner);
              this.post({ type: "image_ready", sessionId: owner, imageId: id, attachment, dataUrl: "data:" + mime + ";base64," + bytes.toString("base64"), ...routed });
            } catch (error) { this.post({ type: "image_failed", sessionId: owner, imageId: id, message: userFacingError(error), ...routed }); }
          } else if (!edit) {
            const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === uri.fsPath);
            const snapshot = document?.isDirty ? document.getText() : undefined;
            if (snapshot && snapshot.length > 1024 * 1024) { this.post({type:"toast", message:t("未保存的文件过大，请选中需要引用的内容。")}); continue; }
            this.post({ type: "file_added", sessionId: owner, chip: { path: uri.fsPath, relPath: path.relative(this.workspacePath || os.homedir(), uri.fsPath), ...(snapshot !== undefined ? {snapshot, languageId:document?.languageId} : {}) } });
          }
        }
  }

  private readEditorChip(implicit: boolean): ContextChip | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return null;
    const sel = editor.selection;
    const hasSel = !sel.isEmpty;
    if (!implicit && !hasSel && editor.document.isDirty && editor.document.getText().length > 1024 * 1024) return null;
    let endLine = sel.end.line + 1;
    if (hasSel && sel.end.character === 0 && sel.end.line > sel.start.line) {
      endLine = sel.end.line;
    }
    return {
      path: editor.document.uri.fsPath,
      relPath: path.relative(this.workspacePath || os.homedir(), editor.document.uri.fsPath),
      languageId: editor.document.languageId,
      sourceDirty: editor.document.isDirty,
      implicit,
      ...(!implicit && !hasSel && editor.document.isDirty ? { snapshot: editor.document.getText() } : {}),
      ...(hasSel
        ? {
            selectionStart: sel.start.line + 1,
            selectionEnd: endLine,
            selectedText: editor.document.getText(sel),
          }
        : {}),
    };
  }

  async insertEditorContext(kind: "selection" | "file"): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage(t("没有打开的编辑器。"));
      return;
    }
    if (kind === "selection" && editor.selection.isEmpty) {
      vscode.window.showInformationMessage(t("请先选中一段文本。"));
      return;
    }
    const chip = this.readEditorChip(false);
    if (!chip) {
      vscode.window.showInformationMessage(t("当前没有可发送的内容。"));
      return;
    }
    if (kind === "file") {
      delete chip.selectionStart;
      delete chip.selectionEnd;
      delete chip.selectedText;
      if (editor.document.isDirty) {
        const snapshot = editor.document.getText();
        if (snapshot.length > 1024 * 1024) { vscode.window.showInformationMessage(t("未保存的文件过大，请选中需要引用的内容。")); return; }
        chip.snapshot = snapshot;
      }
    }
    await vscode.commands.executeCommand("workbench.view.extension.zcode-sidebar");
    if (this.view) this.post({ type: "addChip", chip });
    else this.pendingChip = chip;
  }

  private workspaceRoots(): string[] {
    return [this.workspacePath, ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)].filter(Boolean);
  }

  /** Resolve a webview path; files outside the workspace need an explicit modal confirmation. */
  private async confirmedFileTarget(filePath: string): Promise<string | undefined> {
    const target = resolveFileTarget(this.workspaceRoots(), filePath);
    if (!target) {
      vscode.window.showErrorMessage(t("无法打开此文件：路径无效。"));
      return undefined;
    }
    if (target.insideWorkspace) return target.absolute;
    const open = t("仍然打开");
    const choice = await vscode.window.showWarningMessage(
      t("{0} 不在当前工作区内，确定要打开吗？", { 0: target.absolute }), { modal: true }, open);
    return choice === open ? target.absolute : undefined;
  }

  private async openWorkspaceFile(filePath: string): Promise<void> {
    const abs = await this.confirmedFileTarget(filePath);
    if (!abs) return;
    const uri = vscode.Uri.file(abs);
    try {
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (e) {
      vscode.window.showErrorMessage(t("无法打开 {0}：{1}", { 0: filePath, 1: userFacingError(e) }));
    }
  }

  private async openMarkdownFile(filePath: string, line?: number, endLine?: number): Promise<void> {
    const file = existingWorkspaceFile(this.workspacePath, filePath);
    if (!file) {
      vscode.window.showErrorMessage(t("无法打开此文件：文件不在当前工作区内或已被移动。"));
      return;
    }
    try {
      const selection = Number.isSafeInteger(line) && line! > 0 && line! <= 10000000
        ? new vscode.Range(line! - 1, 0, Number.isSafeInteger(endLine) && endLine! >= line! && endLine! <= 10000000 ? endLine! - 1 : line! - 1, 0)
        : undefined;
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file.absolute), { preview: true, ...(selection ? { selection } : {}) });
    } catch (e) {
      vscode.window.showErrorMessage(t("无法打开 {0}：{1}", { 0: filePath, 1: userFacingError(e) }));
    }
  }

  private async openGitDiff(
    filePath: string,
    patches: StructuredPatch[],
    reverted: boolean
  ): Promise<void> {
    const name = path.basename(filePath);
    let disk: string | null = null;
    if (!reverted) {
      // Reverted diffs are rebuilt from the patches alone; only a disk read needs the boundary check.
      const abs = await this.confirmedFileTarget(filePath);
      if (!abs) return;
      try {
        if (fs.existsSync(abs)) {
          const buf = fs.readFileSync(abs);
          if (!buf.includes(0)) disk = buf.toString("utf8");
        }
      } catch (e) {
        logWarn("Could not read file for git diff", e);
      }
    }
    const diff = materializeGitDiff(disk, patches);
    const beforeUri = this.diffDocs.uri("before", filePath, diff.before);
    const afterUri = this.diffDocs.uri("after", filePath, diff.after);
    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      afterUri,
      t("{0}（ZCode 改动）", { 0: name }),
      { preview: true }
    );
  }

  private async openFileDiff(change: FileChange): Promise<void> {
    const name = path.basename(change.path);
    const before = change.before ?? "";
    const snippetDiff =
      change.kind === "edit" && typeof change.after === "string";
    // Snippet diffs stay virtual; opening the real file on the right needs the boundary check.
    const abs = snippetDiff ? undefined : await this.confirmedFileTarget(change.path);
    if (!snippetDiff && !abs) return;
    const beforeUri = this.diffDocs.uri("before", change.path, before);
    // Prefer the real workspace file on the right when this is a live write;
    // snippet edits and missing files stay on the virtual readonly scheme.
    const afterUri =
      abs && fs.existsSync(abs)
        ? vscode.Uri.file(abs)
        : this.diffDocs.uri("after", change.path, change.after ?? "");
    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      afterUri,
      t("{0}（ZCode 改动）", { 0: name }),
      { preview: true }
    );
  }

  async quickSwitchSession(): Promise<void> {
    await this.refreshSessions();
    if (this.sessions.length === 0) {
      vscode.window.showInformationMessage(t("此工作区还没有会话。"));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      this.sessions.map((s) => ({
        label: s.title || t("未命名"),
        description: s.model?.modelId,
        detail: s.sessionId,
        sessionId: s.sessionId,
      })),
      { placeHolder: t("切换 ZCode 会话") }
    );
    if (picked) await this.switchSession(picked.sessionId);
  }

  async quickSelectModel(): Promise<void> {
    const items = this.modelChoices();
    if (items.length === 0) {
      this.showStartupError(t("暂时没有可用的模型。"), "retry");
      return;
    }
    const picks: Array<
      vscode.QuickPickItem & { m?: PickerModel }
    > = [];
    let lastGroup = "";
    for (const m of items) {
      if (m.providerName !== lastGroup) {
        picks.push({ label: m.providerName, kind: vscode.QuickPickItemKind.Separator });
        lastGroup = m.providerName;
      }
      picks.push({
        label: m.modelId,
        description: m.providerName,
        detail: m.disabledReason,
        m,
      });
    }
    const client = this.client;
    const sessionId = client?.currentSessionId;
    const ticket = this.switchTicket;
    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: t("选择 ZCode 模型"),
      matchOnDescription: true,
    });
    if (picked?.m && client === this.client && sessionId === client?.currentSessionId && ticket === this.switchTicket) {
      await this.selectModel(picked.m.providerId, picked.m.modelId);
    }
  }

  private modelChoices(): PickerModel[] {
    const client = this.client;
    const sessionId = client?.currentSessionId;
    const live = this.livePicker?.client === client && this.livePicker.sessionId === sessionId
      ? this.livePicker.models
      : [];
    return mergeAvailablePickerModels(
      this.picker,
      live,
      this.disabledModelKeys,
      this.managedProviderIds,
      this.providerInventoryAuthoritative
    ).filter((p) => p.hasKey && !p.disabledReason);
  }

  async refreshDesktopModels(): Promise<void> {
    const revision = ++this.pickerRefreshRevision;
    try {
      const resolution = await readPickerResolution();
      if (revision !== this.pickerRefreshRevision) return;
      this.picker = resolution.picker;
      this.disabledModelKeys = new Set(resolution.disabledModelKeys);
      this.managedProviderIds = new Set(resolution.managedProviderIds);
      this.providerInventoryAuthoritative = resolution.providerInventoryAuthoritative;
      await this.pushModels();
    } catch (error) {
      logWarn("Could not refresh desktop model shortcuts", error);
    }
  }

  /** Source label for the switch banner, e.g. the desktop's “(团队套餐)”. */
  private modelSourceLabel(model: { providerId: string; modelId: string } | undefined): string | undefined {
    if (!model) return undefined;
    const entry = this.picker.find((p) => p.providerId === model.providerId && p.modelId === model.modelId);
    return entry?.providerName || undefined;
  }

  async restart(reason: string): Promise<void> {
    logInfo("Restarting ZCode", reason);
    this.disposeClient();
    await this.startZCode({ force: true });
  }

  private sessionIsArchived(sessionId: string): boolean {
    if (this.sessions.some((s) => s.sessionId === sessionId && s.archivedAt)) return true;
    return !!this.workspacePath && loadTaskFlags(this.workspacePath).archived.includes(sessionId);
  }

  private async switchSession(sessionId: string): Promise<void> {
    if (this.sessionIsArchived(sessionId)) {
      this.post({ type: "toast", text: t("请先取消归档再打开") });
      return;
    }
    if (!this.client) {
      await this.startZCode({ resumeSessionId: sessionId });
      return;
    }
    if (this.client.currentSessionId === sessionId) return;
    const client = this.client;
    const timing = new StartupTiming("switch", true);
    this.timing = timing;
    client.setTiming(timing);
    const ticket = ++this.switchTicket;
    try {
      await client.prepareViewChange();
      if (ticket !== this.switchTicket || client !== this.client) return;
      this.post({ type: "view_reset", viewGen: ticket });
      this.currentModel = undefined;
      try {
        const history = await client.switchSession(sessionId);
        if (ticket !== this.switchTicket || client !== this.client) return;
        this.rememberSession(sessionId);
        this.post({
          type: "session_ready",
          sessionId,
          title: client.currentTitle || "新会话",
          kind: "resumed",
          viewGen: ticket,
        });
        this.paintTitle(client.currentTitle);
        if (!client.historyDelivered(sessionId)) this.postHistory(history, ticket);
        // History is visible now. Resume streaming before loading sidebar metadata.
        client.endViewChange();
        await this.refreshSessions();
        if (ticket !== this.switchTicket || client !== this.client) return;
        await this.pushModels();
        if (ticket === this.switchTicket && client === this.client) await client.emitSessionControls();
      } catch (e) {
        if (ticket === this.switchTicket) this.post({ type: "stream_release" });
        throw e;
      } finally {
        if (ticket === this.switchTicket && client === this.client) client.endViewChange();
      }
    } finally {
      this.finishTiming(timing);
    }
  }

  private async selectModel(
    providerId: string,
    modelId: string,
    restart = false
  ): Promise<void> {
    const selectionIsCurrent = this.viewScope();
    if (this.disabledModelKeys.has(`${providerId}\0${modelId}`)) {
      await this.pushModels();
      if (!selectionIsCurrent()) return;
      vscode.window.showWarningMessage(t("该模型已在 ZCode 桌面端禁用，请先启用后再选择。"));
      return;
    }
    if (this.providerInventoryAuthoritative && !this.modelChoices().some(model => model.providerId === providerId && model.modelId === modelId)) {
      await this.pushModels();
      if (!selectionIsCurrent()) return;
      vscode.window.showWarningMessage(t("该模型已不可用，请刷新模型列表后重新选择。"));
      void this.refreshDesktopModels();
      return;
    }
    if (restart || !this.client) {
      await this.startZCode({
        force: true,
        preferredProviderId: providerId,
        preferredModelId: modelId,
      });
      return;
    }

    const client = this.client;
    const sessionId = client.currentSessionId;
    const ticket = this.switchTicket;
    const isCurrent = () => client === this.client && sessionId === client.currentSessionId && ticket === this.switchTicket;
    if (sessionId && client.isGenerating()) {
      this.pendingModel = { sessionId, providerId, modelId };
      this.currentModel = { providerId, modelId };
      client.stageSessionModel(this.currentModel);
      this.post({
        type: "models",
        current: this.currentModel,
        available: this.modelChoices(),
      });
      return;
    }
    if (this.pendingModel?.sessionId === sessionId) this.pendingModel = null;
    const previous = this.currentModel;
    try {
      const runtime = await this.resolveSessionModelRuntime({ providerId, modelId });
      if (!isCurrent()) return;
      if (runtime === false) {
        vscode.window.showWarningMessage(t("该模型已不可用，请刷新模型列表后重新选择。"));
        await this.pushModels();
        return;
      }
      if (runtime) {
        client.setSessionRuntime(runtime);
        syncCliConfig(runtime, readV2Config(), false);
      }
      await client.setModel(providerId, modelId);
      if (!isCurrent()) return;
      this.currentModel = { providerId, modelId };
      this.rememberSessionModel(client.currentSessionId, this.currentModel);
      this.indexCurrentSession();
      await this.pushModels();
      if (isCurrent() && (previous?.providerId !== providerId || previous?.modelId !== modelId)) {
        this.noteSwitchBanner(previous, this.currentModel);
      }
    } catch (e) {
      if (!isCurrent()) return;
      logError("setModel failed", e);
      this.currentModel = client.confirmedModel();
      await this.pushModels(true);
      if (!isCurrent()) return;
      vscode.window.showErrorMessage(t("切换模型失败：{0}", { 0: userFacingError(e) }));
    }
  }

  private pendingModelFor(
    sessionId?: string | null
  ): { providerId: string; modelId: string } | undefined {
    if (!this.pendingModel || !sessionId || this.pendingModel.sessionId !== sessionId) return undefined;
    return { providerId: this.pendingModel.providerId, modelId: this.pendingModel.modelId };
  }

  private async applyPendingModel(client: ZCodeClient): Promise<boolean> {
    const pending = this.pendingModelFor(client.currentSessionId);
    if (!pending) return true;
    if (!client.currentSessionId) return false;
    const sessionId = client.currentSessionId;
    const previous = this.currentModel ? { ...this.currentModel } : undefined;
    const runtime = await this.resolveSessionModelRuntime(pending);
    if (client !== this.client || client.currentSessionId !== sessionId) return false;
    if (runtime === false || (this.providerInventoryAuthoritative && !this.modelChoices().some(model => model.providerId === pending.providerId && model.modelId === pending.modelId))) {
      this.pendingModel = null;
      if (this.currentModel?.providerId === pending.providerId && this.currentModel.modelId === pending.modelId) {
        this.currentModel = undefined;
      }
      vscode.window.showWarningMessage(t("该模型已不可用，请刷新模型列表后重新选择。"));
      await this.pushModels();
      return false;
    }
    if (runtime && typeof runtime === "object") {
      client.setSessionRuntime(runtime);
      syncCliConfig(runtime, readV2Config(), false);
    }
    await client.setModel(pending.providerId, pending.modelId);
    if (client !== this.client || client.currentSessionId !== sessionId) return false;
    this.pendingModel = null;
    this.currentModel = pending;
    this.rememberSessionModel(sessionId, pending);
    this.noteSwitchBanner(previous, pending);
    return true;
  }

  /** Hold the separator until the next message goes out; re-picks only update the target. */
  private noteSwitchBanner(
    from: { providerId: string; modelId: string } | undefined,
    to: { providerId: string; modelId: string }
  ): void {
    const sessionId = this.client?.currentSessionId;
    if (!sessionId) return;
    if (from && from.providerId === to.providerId && from.modelId === to.modelId) {
      this.pendingSwitchBanners.delete(sessionId);
      return;
    }
    const pending = this.pendingSwitchBanners.get(sessionId);
    const base = pending?.from ?? from;
    const target = pending?.to.providerId === to.providerId && pending?.to.modelId === to.modelId
      ? pending.to
      : to;
    if (base && base.providerId === target.providerId && base.modelId === target.modelId) {
      this.pendingSwitchBanners.delete(sessionId);
      return;
    }
    this.pendingSwitchBanners.set(sessionId, { ...(base ? { from: base } : {}), to: target });
  }

  /** The separator becomes part of the transcript in front of the newly sent question. */
  private flushSwitchBanner(sessionId: string, hasPriorUserMessage: boolean): void {
    const banner = this.pendingSwitchBanners.get(sessionId);
    if (!banner) return;
    this.pendingSwitchBanners.delete(sessionId);
    if (!hasPriorUserMessage) return;
    this.post({
      type: "model_switched",
      sessionId,
      from: banner.from ? { ...banner.from, source: this.modelSourceLabel(banner.from) } : undefined,
      to: { ...banner.to, source: this.modelSourceLabel(banner.to) },
    });
  }

  private async startZCode(opts?: {
    force?: boolean;
    createNew?: boolean;
    resumeSessionId?: string;
    preferredProviderId?: string;
    preferredModelId?: string;
  }): Promise<void> {
    if (this.starting) {
      await this.starting;
      if (!opts?.force) return;
    }
    this.starting = this.startZCodeInner(opts);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startZCodeInner(opts?: {
    force?: boolean;
    createNew?: boolean;
    resumeSessionId?: string;
    preferredProviderId?: string;
    preferredModelId?: string;
  }): Promise<void> {
    const timing = new StartupTiming("open", true);
    this.timing = timing;
    try {
    const config = vscode.workspace.getConfiguration("zcode");
    let binaryPath: string;
    const locateStarted = Date.now();
    try {
      binaryPath = await locateAppServer(config.get<string>("binaryPath") || "", {
        preferred: this.context.globalState.get<string>(LAST_BINARY_KEY) || "",
      });
      this.appServerPath = binaryPath;
      timing.add("locateBinary", Date.now() - locateStarted);
    } catch (e) {
      timing.add("locateBinary", Date.now() - locateStarted);
      const message = userFacingError(e);
      logError("Could not locate ZCode app-server", e);
      this.showStartupError(message);
      this.post({ type: "session_error", message });
      return;
    }
    const nodePath = config.get<string>("nodePath") || "";
    const defaults = this.newSessionDefaults();
    const modelOverride = opts?.createNew && defaults.model ? "" : config.get<string>("model") || "";
    let workspacePath = config.get<string>("workspacePath") || "";
    if (!workspacePath) {
      workspacePath =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    }
    workspacePath = preferredWorkspacePath(workspacePath, readV2Settings()?.recentProjects);
    this.workspacePath = workspacePath;

    this.post({ type: "status", status: "resolving_credentials" });

    const loginStarted = Date.now();
    this.desktopAppVersion = desktopVersion(binaryPath);
    const loginRequest = {
      appVersion: this.desktopAppVersion,
      modelOverride,
      preferredProviderId: opts?.preferredProviderId ?? (opts?.createNew ? defaults.model?.providerId : undefined),
      preferredModelId: opts?.preferredModelId ?? (opts?.createNew ? defaults.model?.modelId : undefined),
    };
    const overlapLogin = localLoginCanOverlapSpawn(loginRequest);
    if (overlapLogin) timing.note("loginOverlap", true);
    const loginPromise = this.settleStartupLogin(loginRequest);
    if (overlapLogin) {
      await this.startWhileLoginRuns(timing, loginStarted, loginPromise, {
        binaryPath,
        nodePath,
        workspacePath,
        remembered: opts?.resumeSessionId || (opts?.createNew ? undefined : this.context.workspaceState.get<string>(LAST_SESSION_KEY)),
        createNew: opts?.createNew,
        newSessionDefaults: defaults,
      });
      return;
    }
    let resolved = await loginPromise;
    let loginNetwork = resolved.exchangedLogin === true;
    this.picker = resolved.picker;
    this.disabledModelKeys = new Set(resolved.disabledModelKeys ?? []);
    this.managedProviderIds = new Set(resolved.managedProviderIds ?? []);
    this.providerInventoryAuthoritative = resolved.providerInventoryAuthoritative ?? false;

    timing.add("resolveRuntime", Date.now() - loginStarted);
    timing.note("loginNetwork", loginNetwork);
    if (!resolved.ok || !resolved.runtime) {
      this.post({
        type: "setup",
        reason: resolved.reason,
        hint: resolved.hint,
        picker: resolved.picker,
      });
      this.post({ type: "models", available: resolved.picker, needsSelection: true });
      this.pushNewSessionDefaults();
      return;
    }

    const runtime = resolved.runtime;
    if (!runtime) return;
    this.runtime = runtime;
    if (resolved.warning) {
      vscode.window.showWarningMessage(`ZCode: ${resolved.warning}`);
    }
    const configStarted = Date.now();
    syncCliConfig(runtime, readV2Config());
    timing.add("syncCliConfig", Date.now() - configStarted);

    this.post({ type: "status", status: "connecting" });
    this.disposeClient();

    const remembered =
      opts?.resumeSessionId ||
      (opts?.createNew ? undefined : this.context.workspaceState.get<string>(LAST_SESSION_KEY));

    const client = new ZCodeClient({
      binaryPath,
      nodePath: nodePath || undefined,
      workspacePath,
      env: runtimeEnv(runtime),
      compileCachePath: path.join(this.context.globalStorageUri.fsPath, "runtime-compile-cache"),
      runtime,
      resolveSessionRuntime: (model) => this.resolveSessionModelRuntime(model),
      isSessionModelAvailable,
      rememberedModel: (sessionId) => this.sessionModelFor(sessionId),
      fetchProviderQuota: (providerId) => fetchConfiguredProviderQuota(this.context, providerId),
      onEvent: (event) => {
        if (this.client === client) this.handleZCodeEvent(event);
      },
    });
    this.client = client;
    client.setViewVisible(this.view?.visible === true);
    client.setTiming(timing);
    this.startRunningPoll();

    try {
      await client.start({
        createNew: opts?.createNew,
        resumeSessionId: remembered,
        applyModel: !!opts?.createNew,
        newSessionDefaults: defaults,
        chooseResume: (listed, rejected) => this.chooseStartupSession(listed, remembered, rejected),
      });
      if (this.client !== client) return;
      void this.context.globalState.update(LAST_BINARY_KEY, binaryPath);
      if (this.client.currentSessionId) {
        this.rememberSession(this.client.currentSessionId);
      }
      await this.pushSessionState({ startupList: client.takeStartupSessions() });
    } catch (e) {
      if (this.client !== client) return;
      const message = userFacingError(e);
      logError("ZCode startup failed", e);
      this.showStartupError(message);
      this.post({ type: "session_error", message });
    }
    } finally {
      this.finishTiming(timing);
    }
  }

  private async settleStartupLogin(request: {
    appVersion?: string | null;
    modelOverride?: string;
    preferredProviderId?: string;
    preferredModelId?: string;
  }): Promise<ResolveResult> {
    let resolved = await resolveRuntime(request);
    if (resolved.ok && resolved.runtime) return resolved;
    logWarn("Could not reuse desktop defaults", resolved.reason);
    const fallbackPick = resolved.picker.find(
      (p) =>
        p.hasKey &&
        !p.providerId.includes("coding-plan") &&
        !p.providerId.includes("start-plan")
    );
    if (!fallbackPick) return resolved;
    const fallback = await resolveRuntime({
      appVersion: request.appVersion,
      preferredProviderId: fallbackPick.providerId,
      preferredModelId: fallbackPick.modelId,
    });
    if (!fallback.ok || !fallback.runtime) {
      return { ...resolved, exchangedLogin: resolved.exchangedLogin || fallback.exchangedLogin };
    }
    logWarn("Starting with a fallback provider so sessions still load", {
      providerId: fallback.runtime.providerId,
    });
    return { ...fallback, exchangedLogin: resolved.exchangedLogin || fallback.exchangedLogin };
  }

  /** Spawn the app-server while the desktop plan key is still being exchanged. */
  private async startWhileLoginRuns(
    timing: StartupTiming,
    loginStarted: number,
    loginPromise: Promise<ResolveResult>,
    launch: {
      binaryPath: string;
      nodePath: string;
      workspacePath: string;
      remembered?: string;
      createNew?: boolean;
      newSessionDefaults?: NewSessionDefaults;
    }
  ): Promise<void> {
    this.post({ type: "status", status: "connecting" });
    this.disposeClient();
    const client = new ZCodeClient({
      binaryPath: launch.binaryPath,
      nodePath: launch.nodePath || undefined,
      workspacePath: launch.workspacePath,
      pendingLogin: loginPromise,
      compileCachePath: path.join(this.context.globalStorageUri.fsPath, "runtime-compile-cache"),
      resolveSessionRuntime: (model) => this.resolveSessionModelRuntime(model),
      isSessionModelAvailable,
      rememberedModel: (sessionId) => this.sessionModelFor(sessionId),
      fetchProviderQuota: (providerId) => fetchConfiguredProviderQuota(this.context, providerId),
      onEvent: (event) => {
        if (this.client === client) this.handleZCodeEvent(event);
      },
    });
    this.client = client;
    client.setViewVisible(this.view?.visible === true);
    client.setTiming(timing);
    this.startRunningPoll();
    const startup = client.start({
      createNew: launch.createNew,
      resumeSessionId: launch.remembered,
      applyModel: !!launch.createNew,
      newSessionDefaults: launch.newSessionDefaults,
      chooseResume: (listed, rejected) => this.chooseStartupSession(listed, launch.remembered, rejected),
    });
    const settled = loginPromise.then((resolved) => {
      timing.add("resolveRuntime", Date.now() - loginStarted);
      timing.note("loginNetwork", resolved.exchangedLogin === true);
      if (this.client !== client) return false;
      this.picker = resolved.picker;
      this.disabledModelKeys = new Set(resolved.disabledModelKeys ?? []);
      this.managedProviderIds = new Set(resolved.managedProviderIds ?? []);
      this.providerInventoryAuthoritative = resolved.providerInventoryAuthoritative ?? false;
      if (!resolved.ok || !resolved.runtime) return false;
      this.runtime = resolved.runtime;
      if (resolved.warning) vscode.window.showWarningMessage(`ZCode: ${resolved.warning}`);
      const configStarted = Date.now();
      syncCliConfig(resolved.runtime, readV2Config());
      timing.add("syncCliConfig", Date.now() - configStarted);
      client.setDefaultRuntime(resolved.runtime);
      return true;
    });
    const [started, ready] = await Promise.allSettled([startup, settled]);
    if (this.client !== client) return;
    if (ready.status === "rejected" || ready.value === false) {
      const resolved = await loginPromise.catch(() => null);
      if (this.client === client) this.disposeClient();
      this.post({
        type: "setup",
        reason: resolved?.reason,
        hint: resolved?.hint,
        picker: resolved?.picker ?? this.picker,
      });
      this.post({ type: "models", available: resolved?.picker ?? this.picker, needsSelection: true });
      this.pushNewSessionDefaults();
      return;
    }
    if (started.status === "rejected") {
      const message = userFacingError(started.reason);
      logError("ZCode startup failed", started.reason);
      this.showStartupError(message);
      this.post({ type: "session_error", message });
      return;
    }
    void this.context.globalState.update(LAST_BINARY_KEY, launch.binaryPath);
    if (client.currentSessionId) this.rememberSession(client.currentSessionId);
    await this.pushSessionState({ startupList: client.takeStartupSessions() });
  }

  private async runRecoveryAction(action: RecoveryAction): Promise<void> {
    if (action === "binaryPath" || action === "nodePath") {
      await vscode.commands.executeCommand("workbench.action.openSettings", `@id:zcode.${action}`);
    } else if (action === "pickModel") await this.quickSelectModel();
    else await this.startZCode({ force: true });
  }

  private showStartupError(message: string, recoveryOverride?: RecoveryAction): void {
    const guidance = errorGuidance(message);
    const action = recoveryOverride ?? guidance.action;
    const primary = t(recoveryOverride === "retry" ? "重新读取登录" : guidance.label);
    const logLabel = t("打开日志"), communityLabel = t("社区提问");
    void vscode.window.showErrorMessage(`${t(guidance.title)}\n${t(guidance.hint)}`, primary, logLabel, communityLabel)
      .then(async choice => {
        if (choice === primary) await this.runRecoveryAction(action);
        else if (choice === logLabel) getLog().show(true);
        else if (choice === communityLabel) await vscode.env.openExternal(vscode.Uri.parse(COMMUNITY_URL));
      }).then(undefined, error => logWarn("Recovery action failed", error));
  }

  private async pushSessionState(opts?: { forceHistory?: boolean; startupList?: SessionSummary[] }): Promise<void> {
    const client = this.client;
    const sessionId = client?.currentSessionId;
    const ticket = this.switchTicket;
    if (!client || !sessionId) return;
    const isCurrent = () => client === this.client && sessionId === client.currentSessionId && ticket === this.switchTicket;
    this.post({ type: "session_ready", sessionId, title: client.currentTitle || "新会话", viewGen: ticket });
    this.paintTitle(client.currentTitle);
    if (opts?.forceHistory || !client.historyDelivered(sessionId)) {
      const history = await client.loadHistory();
      if (!isCurrent()) return;
      this.postHistory(history, ticket);
    }
    client.endViewChange();
    const indexStarted = Date.now();
    this.indexCurrentSession();
    this.timing?.add("currentTaskIndex", Date.now() - indexStarted);
    await this.refreshSessions(false, opts?.startupList);
    if (!isCurrent()) return;
    const current = this.sessions.find((s) => s.sessionId === sessionId);
    if (current?.title) this.paintTitle(current.title);
    await this.pushModels();
    if (isCurrent()) await client.emitSessionControls();
    if (isCurrent()) {
      this.pushedEpoch = this.webviewEpoch;
      this.timing?.mark("metadataReadyMs");
    }
  }

  private async refreshSessions(includeArchived = false, startupList?: SessionSummary[]): Promise<void> {
    const client = this.client;
    const ticket = this.switchTicket;
    if (!client) return;
    try {
      const serverList = startupList ?? await client.listSessions(true);
      if (client !== this.client || ticket !== this.switchTicket) return;
      const indexStarted = Date.now();
      const archiveTimes = loadSessionArchiveTimes(serverList.map(s => s.sessionId));
      const listed = serverList.map(s => archiveTimes.has(s.sessionId)
        ? { ...s, archivedAt: archiveTimes.get(s.sessionId) || undefined }
        : s);
      // Persistent flags are authoritative and must be read after the list returns.
      const flags = this.workspacePath
        ? loadTaskFlags(this.workspacePath)
        : { archived: [], deleted: [] };
      const archived = new Set(flags.archived);
      const deleted = new Set(flags.deleted);
      const overridden = loadOverriddenTitles(this.workspacePath);
      this.sessions = listed
        .map((s) => {
          const title = overridden[s.sessionId] || s.title;
          const model = s.model || this.sessionModelFor(s.sessionId);
          return { ...s, title, model };
        })
        .filter((s) => !deleted.has(s.sessionId))
        .filter((s) =>
          includeArchived
            ? archived.has(s.sessionId) || !!s.archivedAt
            : !archived.has(s.sessionId) && !s.archivedAt
        )
        .map((s) => ({
          ...s,
          archivedAt: s.archivedAt ?? (archived.has(s.sessionId) ? 1 : undefined),
        }));
      this.post({
        type: "sessions",
        sessions: this.sessions,
        currentId: this.client.currentSessionId,
        includeArchived,
      });
      let indexed = 0;
      for (const s of listed) {
        const ws = this.workspacePath || s.workspacePath || "";
        if (!ws || deleted.has(s.sessionId)) continue;
        upsertDesktopTask({
          workspacePath: ws,
          sessionId: s.sessionId,
          title: s.title,
          model: s.model
            ? `${s.model.providerId}/${s.model.modelId}`
            : this.runtime
              ? `${this.runtime.providerId}/${this.runtime.modelId}`
              : undefined,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          archived: archived.has(s.sessionId) || !!s.archivedAt,
          mode:
            s.sessionId === this.client.currentSessionId
              ? this.client.currentMode()
              : undefined,
        });
        indexed++;
      }
      // A server list may be paginated. Never delete desktop tasks absent from it.
      this.timing?.add("sessionListIndex", Date.now() - indexStarted);
      this.timing?.addCount("sessionListIndexCount", indexed);
    } catch (e) {
      logWarn("listSessions failed", e);
    }
  }

  private async runSessionOperation(
    action: () => string,
    operation: (saved: () => void) => Promise<void>
  ): Promise<void> {
    let saved = false;
    try {
      await operation(() => { saved = true; });
    } catch (e) {
      logError("session management operation failed", e);
      // Management failures must never terminate the running conversation UI.
      // Report even after a switch: the user still needs the operation's outcome.
      this.post({ type: "toast", text: e instanceof SessionSyncError ? userFacingError(e) : saved
        ? t("{0}已保存，但后续同步未完成：{1}", { 0: action(), 1: userFacingError(e) })
        : t("{0}未能完成：{1}", { 0: action(), 1: userFacingError(e) }) });
    }
  }

  private async applyRename(sessionId: string, title: string): Promise<void> {
    await this.runSessionOperation(() => t("重命名会话"), async saved => {
      const next = title.trim();
      if (!next) return;
      if (this.workspacePath) {
        setSessionDisplayTitle(this.workspacePath, sessionId, next);
        saved();
      }
      if (this.client?.currentSessionId === sessionId) {
        await this.client.renameSession(next);
      }
      this.post({
        type: "session_title",
        title: next,
        sessionId,
      });
      await this.refreshSessions();
      this.post({ type: "toast", text: t("已重命名") });
    });
  }

  private async renameSession(sessionId: string, suggested?: string, actionRequestId?: string): Promise<void> {
    const current =
      suggested ||
      this.sessions.find((s) => s.sessionId === sessionId)?.title ||
      (this.client?.currentSessionId === sessionId
        ? this.client.currentTitle
        : "") ||
      "";
    const value = await vscode.window.showInputBox({
      prompt: t("会话名称"),
      value: current,
      placeHolder: t("输入新的会话名称"),
    });
    if (value == null) return;
    if (value.trim() && actionRequestId) this.post({ type: "session_action_started", sessionId, actionRequestId, action: "rename" });
    await this.applyRename(sessionId, value);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    await this.runSessionOperation(() => t("删除会话"), async saved => {
      if (!this.workspacePath) return;
      const flags = loadTaskFlags(this.workspacePath);
      const session = this.sessions.find((s) => s.sessionId === sessionId);
      const archived =
        !!session?.archivedAt || flags.archived.includes(sessionId);
      if (!archived) {
        this.post({ type: "toast", text: t("请先归档再删除") });
        return;
      }
      const title = session?.title || t("该会话");
      const deleteLabel = t("删除");
      const choice = await vscode.window.showWarningMessage(
        t("删除会话「{0}」？会从侧栏移除，与 ZCode 桌面端删除一致。", { 0: title }),
        { modal: true },
        deleteLabel
      );
      if (choice !== deleteLabel) return;
      setTaskDeleted(this.workspacePath, sessionId);
      saved();
      const client = this.client;
      const ticket = this.switchTicket;
      if (this.client?.currentSessionId === sessionId) {
        const listed = await this.client.listSessions(false);
        const next = this.nextUsableSession(listed, [sessionId]);
        if (client === this.client && ticket === this.switchTicket && client?.currentSessionId === sessionId) {
          if (next) await this.switchSession(next.sessionId);
          else await this.newSession();
        }
      }
      // Deleting only starts from the archived tab; keep the list there instead
      // of bouncing the user back to the active tab.
      await this.refreshSessions(true);
      this.post({ type: "toast", text: t("会话已删除") });
    });
  }

  private async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    await this.runSessionOperation(() => t(archived ? "归档会话" : "恢复会话"), async saved => {
      if (!this.workspacePath) return;
      setTaskArchived(this.workspacePath, sessionId, archived);
      saved();
      const client = this.client;
      const ticket = this.switchTicket;
      if (archived && client?.currentSessionId === sessionId) {
        const listed = await client.listSessions(false);
        const next = this.nextUsableSession(listed, [sessionId]);
        if (client === this.client && ticket === this.switchTicket && client.currentSessionId === sessionId) {
          if (next) await this.switchSession(next.sessionId);
          else await this.newSession();
        }
      }
      await this.refreshSessions(!archived);
      this.post({
        type: "toast",
        text: t(archived ? "会话已归档" : "会话已恢复"),
      });
    });
  }

  private async pushModels(forceRead = false): Promise<void> {
    const client = this.client;
    const sessionId = client?.currentSessionId;
    const ticket = this.switchTicket;
    const pendingModel = this.pendingModelFor(sessionId);
    const hasFreshCurrent = !forceRead && !!client && client.hasFreshSessionModel() && !!(pendingModel || this.currentModel);
    const hasLiveCatalog = !!client && this.livePicker?.client === client && this.livePicker.sessionId === sessionId;
    if (client && sessionId && (!hasLiveCatalog || !hasFreshCurrent)) {
      try {
        const live = await client.readAvailableModels(!forceRead);
        if (client !== this.client || sessionId !== client.currentSessionId || ticket !== this.switchTicket) return;
        this.livePicker = {
          client,
          sessionId,
          models: live.available,
        };
        if (live.current && !pendingModel && !hasFreshCurrent) this.currentModel = live.current;
      } catch (e) {
        logWarn("Could not read live session model", e);
      }
    }
    const pending = this.pendingModelFor(this.client?.currentSessionId);
    this.post({
      type: "models",
      current:
        pending ??
        this.currentModel ??
        (this.runtime
          ? {
              providerId: this.runtime.providerId,
              modelId: this.runtime.modelId,
            }
          : undefined),
      available: this.modelChoices(),
    });
    this.pushNewSessionDefaults();
  }

  /** session/list can lag the desktop index. Read archive flags only after that list returns. */
  private sessionExclusions(extra: Iterable<string> = []): Set<string> {
    const flags = this.workspacePath
      ? loadTaskFlags(this.workspacePath)
      : { archived: [], deleted: [] };
    return new Set([...flags.archived, ...flags.deleted, ...extra]);
  }

  private nextUsableSession(
    listed: Array<{ sessionId: string; archivedAt?: number }>,
    extra: string[] = []
  ): { sessionId: string; archivedAt?: number } | undefined {
    const excluded = this.sessionExclusions(extra);
    return listed.find((s) => !excluded.has(s.sessionId) && !s.archivedAt);
  }

  private chooseStartupSession(
    listed: SessionSummary[],
    remembered: string | undefined,
    rejected: ReadonlySet<string>
  ): string | undefined {
    const excluded = this.sessionExclusions(rejected);
    if (remembered && !excluded.has(remembered)) {
      const known = listed.find((s) => s.sessionId === remembered);
      // Absent from this page: the list is capped, so keep a session the index still allows.
      if (!known || !known.archivedAt) return remembered;
    }
    return listed.find((s) => !excluded.has(s.sessionId) && !s.archivedAt)?.sessionId;
  }

  private rememberSession(sessionId: string): void {
    void this.context.workspaceState.update(LAST_SESSION_KEY, sessionId);
  }

  private sessionModels(): Record<string, { providerId: string; modelId: string }> {
    return (
      this.context.workspaceState.get<
        Record<string, { providerId: string; modelId: string }>
      >(SESSION_MODELS_KEY) ?? {}
    );
  }

  private sessionModelFor(
    sessionId?: string | null
  ): { providerId: string; modelId: string } | undefined {
    if (!sessionId) return undefined;
    return this.sessionModels()[sessionId];
  }

  private rememberSessionModel(
    sessionId: string | null | undefined,
    model: { providerId: string; modelId: string }
  ): void {
    if (!sessionId || !model.providerId || !model.modelId) return;
    const all = { ...this.sessionModels(), [sessionId]: model };
    void this.context.workspaceState.update(SESSION_MODELS_KEY, all);
  }

  private handleZCodeEvent(event: ZCodeEvent) {
    if (event.type === "model_info") {
      const model = event.data as { providerId: string; modelId: string };
      this.rememberSessionModel(this.client?.currentSessionId, model);
      if (!this.pendingModelFor(this.client?.currentSessionId)) this.currentModel = model;
    }
    if (!this.view) return;
    switch (event.type) {
      case "session_ready": {
        const data = event.data as {
          sessionId: string;
          title?: string;
          kind?: string;
          slashCommands?: Array<{ name: string; description: string; inputHint: string }>;
        };
        this.post({
          type: "session_ready",
          sessionId: data.sessionId,
          title: data.title || "新会话",
          kind: data.kind,
          slashCommands: data.slashCommands ?? [],
        });
        this.paintTitle(data.title);
        break;
      }
      case "assistant_text":
        this.post({
          type: "assistant_text",
          text: (event.data as { text: string }).text,
        });
        break;
      case "transcript_sync": {
        const data = event.data as { sessionId: string; items: unknown[]; truncated: boolean };
        if (data.sessionId === this.client?.currentSessionId) this.postHistory(data, this.switchTicket, "transcript-sync");
        break;
      }
      case "assistant_text_delta":
        this.post({
          type: "assistant_text_delta",
          ...(event.data as object),
          partId: (event.data as { partId?: string }).partId,
          delta: (event.data as { delta: string }).delta,
          fullText: (event.data as { fullText: string }).fullText,
        });
        break;
      case "assistant_reasoning_delta":
        this.post({
          type: "assistant_reasoning_delta",
          ...(event.data as object),
          partId: (event.data as { partId?: string }).partId,
          delta: (event.data as { delta: string }).delta,
          fullText: (event.data as { fullText: string }).fullText,
        });
        break;
      case "tool_call":
        this.post({ type: "tool_call", ...(event.data as object) });
        break;
      case "status":
        this.post({
          type: "status",
          ...(event.data as { status: string; message?: string }),
        });
        break;
      case "sync_status":
        this.post({type: "sync_status", ...(event.data as object)});
        break;
      case "session_error":
        this.post({
          type: "session_error",
          message: (event.data as { message?: string }).message,
        });
        break;
      case "session_defaults_warning":
        this.post({ type: "toast", text: (event.data as { message: string }).message });
        break;
      case "session_title": {
        const data = event.data as { title: string; sessionId?: string };
        this.paintTitle(data.title);
        this.indexCurrentSession(data.title);
        break;
      }
      case "model_info": {
        const pending = this.pendingModelFor(this.client?.currentSessionId);
        const model = pending ?? (event.data as { providerId: string; modelId: string });
        if (!pending) this.currentModel = model;
        this.post({
          type: "models",
          current: model,
          available: this.modelChoices(),
        });
        break;
      }
      case "permission_request":
        this.post({ type: "permission_request", ...(event.data as object) });
        break;
      case "user_input_request":
        this.post({ type: "user_input_request", ...(event.data as object) });
        break;
      case "session_controls":
        this.post({ type: "session_controls", ...(event.data as object) });
        break;
      case "queue_sync":
        this.post({ type: "queue_sync", ...(event.data as object) });
        break;
      case "goal_state":
        this.post({ type: "goal_state", ...(event.data as object) });
        break;
      case "context_usage":
        this.post({ type: "context_usage", ...(event.data as object) });
        break;
      case "conversation_sync":
        this.post({ type: "conversation_sync", ...(event.data as object) });
        break;
      case "session_activity":
        this.post({ type: "session_activity", ...(event.data as object) });
        break;
    }
  }

  private runningPoll: NodeJS.Timeout | undefined;

  private startRunningPoll(): void {
    this.setRunningPollVisibility(this.view?.visible === true);
  }

  private setRunningPollVisibility(visible: boolean): void {
    if (!visible) {
      if (this.runningPoll) clearInterval(this.runningPoll);
      this.runningPoll = undefined;
      return;
    }
    if (!this.client || this.runningPoll) return;
    // Catch up immediately after reopening the panel, then resume the regular
    // poll. Hidden panels do not need to keep background badges current.
    this.client.pollBackgroundRuns();
    // An unsupported runtime cannot read session storage; avoid repeatedly retrying at the normal rate.
    this.runningPoll = setInterval(() => this.client?.pollBackgroundRuns(), nativeSqliteAvailable() ? 1500 : 15000);
  }

  private pendingOpenSettings = false;

  showChromeSettings(): void {
    this.pendingOpenSettings = true;
    void vscode.commands.executeCommand("workbench.view.extension.zcode-sidebar").then(() => {
      this.flushOpenSettings();
    });
  }

  refreshQuota(): void {
    this.client?.refreshQuotaNow();
  }

  async setQuotaApiKey(): Promise<void> {
    const choices = configuredQuotaAdapters()
      .filter(adapter => adapter.auth !== "none" && adapter.apiKeySource !== "zcode")
      .map(adapter => ({ label: adapter.displayName, description: adapter.providerId, adapter }));
    if (choices.length === 0) {
      const action = await vscode.window.showInformationMessage(
        t("当前没有可保存密钥的额度适配器，请检查 zcode.quotaAdapters。"),
        t("打开设置")
      );
      if (action) await vscode.commands.executeCommand("workbench.action.openSettings", "zcode.quotaAdapters");
      return;
    }
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: t("选择要保存 API Key 的额度适配器") });
    if (!selected) return;
    const value = await vscode.window.showInputBox({
      title: selected.adapter.displayName,
      prompt: t("API Key 将保存在 VS Code 安全存储中，不会写入 settings.json。留空可删除已有密钥。"),
      placeHolder: t("输入 API Key"),
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    const key = quotaSecretStorageKey(selected.adapter.id);
    try {
      if (value.trim()) await this.context.secrets.store(key, value.trim());
      else await this.context.secrets.delete(key);
    } catch {
      await vscode.window.showErrorMessage(t("无法访问 VS Code 安全存储，额度 API Key 未保存。"));
      return;
    }
    await vscode.window.showInformationMessage(t("额度适配器密钥已更新：{0}", { 0: selected.adapter.displayName }));
    this.refreshQuota();
  }

  private flushOpenSettings(): void {
    if (!this.pendingOpenSettings || !this.view) return;
    this.pendingOpenSettings = false;
    this.post({ type: "openSettings" });
  }

  private post(msg: Record<string, unknown>): void {
    if (msg.type === "view_reset") this.sendTiming.clear();
    if (["assistant_text_delta", "assistant_reasoning_delta"].includes(String(msg.type)) && msg.streaming !== false &&
        typeof (msg.fullText ?? msg.delta) === "string" && String(msg.fullText ?? msg.delta).length > 0) {
      const sessionId = this.client?.currentSessionId;
      const timingId = sessionId ? this.sendTiming.firstOutput(sessionId) : undefined;
      if (timingId) msg = { ...msg, timingId, sessionId };
    }
    if (msg.type === "status") {
      const status = String(msg.status || "");
      const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : this.client?.currentSessionId;
      if (sessionId && status === "running") this.sendTiming.running(sessionId);
      if (sessionId && ["completedSuccess", "completedInterrupted", "error", "exited"].includes(status)) {
        this.sendTiming.endForSession(sessionId, status === "completedSuccess" ? "completed" : "interrupted");
      }
      if (["connecting", "resolving_credentials", "running", "stopping", "completedSuccess", "completedInterrupted", "exited", "error"].includes(status)) this.diagnosticStatus = status;
    } else if (msg.type === "session_ready") this.diagnosticStatus = "connected";
    if (msg.type === "session_error" || msg.type === "status" && ["error", "exited"].includes(String(msg.status))) {
      this.recentIssues.push({at: new Date().toISOString(), category: issueCategory(String(msg.message || msg.status || ""))});
      this.recentIssues = this.recentIssues.slice(-10);
    }
    const fields = msg.type === "toast" ? ["text"]
      : msg.type === "setup" ? ["reason", "hint"]
      : msg.type === "status" || msg.type === "session_error" ? ["message"]
      : msg.type === "file_changes" ? ["error"] : [];
    const localized = { ...msg };
    for (const field of fields) {
      if (typeof localized[field] === "string") localized[field] = t(localized[field] as string);
    }
    void this.view?.webview.postMessage(localized);
  }

  private disposeClient(): void {
    this.sendTiming.clear();
    if (this.runningPoll) {
      clearInterval(this.runningPoll);
      this.runningPoll = undefined;
    }
    this.indexCurrentSession();
    this.client?.dispose();
    this.client = null;
  }

  dispose(): void {
    this.fileSearchCancellation?.cancel();this.fileSearchCancellation?.dispose();
    this.releaseViewListeners();
    this.disposeClient();
  }
}

export type WebviewIn = {
  timingId?: string;
  frameWaitMs?: number;
  historySyncMs?: number;
  historyFrameMs?: number;
  historyItemCount?: number;
  historyPreviousDomRows?: number;
  historyCurrentDomRows?: number;
  historyTruncated?: boolean;
  historyVisible?: boolean;
  historyRenderSource?: string;
  historyRenderMode?: string;
  renderSource?: string;
  sentAt?: number;
  setting?: "binaryPath" | "nodePath";
  type: string;
  attachments?: ImageAttachment[];
  imageId?: string;
  maxImages?: number;
  attachmentIndex?: number;
  dataUrl?: string;
  uris?: string[];
  fileName?: string;
  language?: LanguageSetting;
  chrome?: ComposerChrome;
  defaults?: NewSessionDefaults;
  chromeKey?: string;
  enabled?: boolean;
  text?: string;
  sessionId?: string;
  providerId?: string;
  modelId?: string;
  restart?: boolean;
  includeArchived?: boolean;
  requestId?: string;
  actionRequestId?: string;
  optionId?: string;
  mode?: string;
  planMode?: boolean;
  recoveryText?: string;
  thoughtLevel?: string;
  viewGen?: number;
  title?: string;
  commit?: boolean;
  action?: "accept" | "decline" | "cancel";
  content?: unknown;
  reason?: string;
  path?: string;
  fileChange?: FileChange;
  previewCandidates?: string[];
  signature?: string;
  fileChangesState?: string;
  chips?: ContextChip[];
  sessionRefs?: SessionReference[];
  chip?: ContextChip;
  edit?: boolean;
  editRequestId?: string;
  line?: number;
  endLine?: number;
  immediate?: boolean;
  keepDraft?: boolean;
  queueItemId?: string;
  beforeQueueItemId?: string | null;
  commandId?: string;
  oldestId?: string;
  messageId?: string;
  rowId?: number;
  entityId?: string;
  workspaceMode?: "preserve" | "rewind";
  turnId?: string;
  patches?: StructuredPatch[];
  reverted?: boolean;
};
