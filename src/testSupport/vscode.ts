let provider: unknown;
let testFiles: string[] = [];
export class RelativePattern { constructor(public base: string, public pattern: string) {} }
export const setTestFiles = (files: string[]) => { testFiles = files; };
let languageSetting = "auto";
let confirmWarning = false;
let informationChoice: number | undefined;
export const setInformationChoice = (index: number | undefined) => { informationChoice = index; };
export const configUpdates: Array<{ key: string; value: unknown; target?: unknown }> = [];
const configValues = new Map<string, unknown>();
export const resetConfigValues = () => configValues.clear();
const disposable = () => ({ dispose() {} });
export const recoveryNotices: Array<{message:string;items:string[]}> = [];
export const window = {
  async showQuickPick(_items: unknown, _options?: unknown): Promise<any> { return undefined; },
  async showErrorMessage(message:string,...items:string[]){recoveryNotices.push({message,items});return undefined as string|undefined;},
  async showWarningMessage(_message: string, _options: unknown, ...items: string[]) { return confirmWarning ? items[0] : undefined; },
  async showInformationMessage(message: string, ...items: string[]) {
    recoveryNotices.push({ message, items });
    return informationChoice === undefined ? undefined : items[informationChoice];
  },
  createOutputChannel() { return { info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() {} }; },
  registerWebviewViewProvider(_id: string, value: unknown) { provider = value; return disposable(); },
  onDidChangeActiveTextEditor: disposable,
  onDidChangeTextEditorSelection: disposable,
};
export const recoveryCalls: Array<{command?:string;args?:unknown[];url?:string}> = [];
export const commands = { registerCommand: disposable, async executeCommand(command:string,...args:unknown[]){recoveryCalls.push({command,args});} };
const closedDocumentListeners = new Set<(document: { uri: { toString(): string } }) => void>();
export const closeTestDocument = (uri: { toString(): string }) => {
  for (const listener of closedDocumentListeners) listener({ uri });
};
export const workspace = {
  onDidCloseTextDocument(listener: (document: { uri: { toString(): string } }) => void) {
    closedDocumentListeners.add(listener);
    return { dispose() { closedDocumentListeners.delete(listener); } };
  },
  async findFiles() { return testFiles.map(fsPath => ({fsPath})); },
  getConfiguration() { return { get(key: string, fallback?: unknown) {
      if (key === "language") return languageSetting;
      return configValues.has(key) ? configValues.get(key) : fallback;
    },
    async update(key: string, value: unknown, target?: unknown) {
      configUpdates.push({ key, value, target });
      configValues.set(key, value);
      if (key === "language") languageSetting = String(value);
    }, }; },
  onDidChangeConfiguration: disposable,
  onDidChangeWorkspaceFolders: disposable,
  registerTextDocumentContentProvider: disposable,
};
export const getRegisteredProvider = () => provider;
export const Uri = {
  parse: (value: string) => value,
  joinPath: (...parts: unknown[]) => parts.map(String).join("/"),
  from(components: { scheme: string; path?: string; query?: string; authority?: string; fragment?: string }) {
    const path = components.path ?? "";
    const query = components.query ?? "";
    return {
      scheme: components.scheme,
      authority: components.authority ?? "",
      path,
      query,
      fragment: components.fragment ?? "",
      fsPath: path,
      with(change: Partial<typeof components>) { return Uri.from({ scheme: components.scheme, path, query, ...change }); },
      toString() {
        return `${components.scheme}:${path}${query ? `?${query}` : ""}`;
      },
    };
  },
  file: (fsPath: string) => Uri.from({ scheme: "file", path: fsPath }),
};
export const ConfigurationTarget = { Global: 1, Workspace: 2 };
export const env = { language: "zh-CN", async openExternal(url:string){recoveryCalls.push({url});return true;}, clipboard: { writeText() {} } };
export function setTestLanguage(setting: string, vscodeLanguage = "zh-CN"): void {
  languageSetting = setting;
  env.language = vscodeLanguage;
}
export const QuickPickItemKind = { Separator: -1 };

export const setTestConfirmation = (confirm: boolean) => { confirmWarning = confirm; };

export class CancellationTokenSource { token={isCancellationRequested:false}; cancel(){this.token.isCancellationRequested=true;} dispose(){} }

export class Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
  constructor(startLine:number,startCharacter:number,endLine:number,endCharacter:number) {
    this.start={line:startLine,character:startCharacter};this.end={line:endLine,character:endCharacter};
  }
}
