import { t } from "../i18n";
import type { SessionReference } from "../promptContext";

export type MentionFile = { path: string; relPath: string };
export type MentionChoice =
  | { kind: "file"; file: MentionFile }
  | { kind: "session"; session: SessionReference };

/** A small composer-owned popup; stale replies can never select another draft. */
export function fileMentions(
  input: HTMLTextAreaElement,
  parent: HTMLElement,
  owner: () => string,
  request: (id: string, query: string, sessionId: string) => void,
  getSessions: () => SessionReference[],
  choose: (choice: MentionChoice, sessionId: string) => void,
) {
  const popup = document.createElement("div");
  popup.id = "file-mentions";
  popup.hidden = true;
  popup.setAttribute("role", "listbox");
  parent.append(popup);
  let active: { start: number; end: number; query: string; sessionId: string; id: string } | undefined;
  let errorState: string | undefined;
  let searchPending = false;
  let files: MentionFile[] = [];
  let sessionMatches: SessionReference[] = [];
  let items: MentionChoice[] = [];
  let selected = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let serial = 0;

  const close = () => {
    clearTimeout(timer);
    active = undefined;
    errorState = undefined;
    searchPending = false;
    files = [];
    sessionMatches = [];
    items = [];
    popup.hidden = true;
    input.removeAttribute("aria-controls");
    input.removeAttribute("aria-activedescendant");
  };

  function token() {
    if (input.selectionStart !== input.selectionEnd) return;
    const end = input.selectionStart;
    const match = /(?:^|\s)@(?:"([^"\r\n]*)"?|([^\s@"]*))$/.exec(input.value.slice(0, end));
    if (!match) return;
    return {
      start: match.index + (match[0].startsWith("@") ? 0 : 1),
      end,
      query: match[1] ?? match[2],
      sessionId: owner(),
    };
  }

  function matchingSessions(query: string): SessionReference[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return getSessions().slice(0, 10);
    return getSessions()
      .map((session, index) => ({ session, index, title: session.title.toLocaleLowerCase() }))
      .filter(item => item.title.includes(needle) || needle.split(/\s+/).every(part => item.title.includes(part)))
      .sort((a, b) => {
        const aPrefix = a.title.startsWith(needle) ? 0 : 1;
        const bPrefix = b.title.startsWith(needle) ? 0 : 1;
        return aPrefix - bPrefix || a.index - b.index;
      })
      .slice(0, 10)
      .map(item => item.session);
  }

  function rebuildItems(): void {
    items = [
      ...files.map(file => ({ kind: "file" as const, file })),
      ...sessionMatches.map(session => ({ kind: "session" as const, session })),
    ];
    selected = Math.min(selected, Math.max(0, items.length - 1));
  }

  function select(index: number): void {
    const now = token();
    const choice = items[index];
    if (!active || !now || now.start !== active.start || now.query !== active.query || now.sessionId !== active.sessionId || !choice) {
      close();
      return;
    }
    input.setRangeText("", active.start, active.end, "end");
    choose(choice, active.sessionId);
    close();
    input.dispatchEvent(new Event("input"));
    input.focus();
  }

  function retrySearch(): void {
    if (!active) return;
    errorState = undefined;
    searchPending = true;
    active.id = `files-${++serial}`;
    files = [];
    sessionMatches = matchingSessions(active.query);
    rebuildItems();
    paint();
    request(active.id, active.query, active.sessionId);
  }

  function addHeading(label: string): void {
    const heading = document.createElement("div");
    heading.className = "mention-heading";
    heading.textContent = t(label);
    popup.append(heading);
  }

  function paint(): void {
    if (!active) return;
    popup.replaceChildren();
    if (files.length || errorState || searchPending) {
      addHeading("工作区文件");
      if (errorState) {
        const error = document.createElement("div");
        error.className = "mention-empty";
        error.textContent = t(errorState === "noWorkspace" ? "请先打开工作区再搜索文件。" : "文件搜索失败，请重试。");
        popup.append(error);
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "mention-retry";
        retry.textContent = t("重试");
        retry.onmousedown = event => event.preventDefault();
        retry.onclick = retrySearch;
        popup.append(retry);
      } else if (searchPending && !files.length) {
        const pending = document.createElement("div");
        pending.className = "mention-empty";
        pending.textContent = t("正在搜索文件…");
        popup.append(pending);
      }
      files.forEach((file, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.id = `mention-${index}`;
        button.dataset.mentionIndex = String(index);
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(index === selected));
        const name = document.createElement("span");
        name.textContent = file.relPath.split(/[\\/]/).pop()!;
        const directory = document.createElement("small");
        directory.textContent = file.relPath.replace(/[^/\\]+$/, "");
        button.title = file.relPath;
        button.append(name, directory);
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => select(index);
        popup.append(button);
      });
    }
    if (sessionMatches.length) {
      addHeading("工作区会话");
      const offset = files.length;
      sessionMatches.forEach((session, index) => {
        const itemIndex = offset + index;
        const button = document.createElement("button");
        button.type = "button";
        button.id = `mention-${itemIndex}`;
        button.dataset.mentionIndex = String(itemIndex);
        button.className = "mention-session";
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(itemIndex === selected));
        const icon = document.createElement("span");
        icon.className = "mention-session-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 2v-2H3A1.5 1.5 0 0 1 1.5 10V5A1.5 1.5 0 0 1 3 3.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>';
        const title = document.createElement("span");
        title.className = "mention-session-title";
        title.textContent = session.title;
        const detail = document.createElement("small");
        detail.textContent = t("会话引用");
        button.title = session.title;
        button.append(icon, title, detail);
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => select(itemIndex);
        popup.append(button);
      });
    }
    if (!items.length && !errorState) {
      const empty = document.createElement("div");
      empty.className = "mention-empty";
      empty.textContent = t("没有匹配的文件或会话");
      popup.append(empty);
    }
    input.setAttribute("aria-controls", popup.id);
    const current = popup.querySelector<HTMLElement>(`[data-mention-index="${selected}"]`);
    if (current) {
      input.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function update(): void {
    const next = token();
    if (!next) {
      close();
      return;
    }
    if (active && next.start === active.start && next.query === active.query && next.sessionId === active.sessionId) return;
    clearTimeout(timer);
    active = { ...next, id: `files-${++serial}` };
    files = [];
    errorState = undefined;
    searchPending = true;
    sessionMatches = matchingSessions(next.query);
    selected = 0;
    popup.hidden = false;
    rebuildItems();
    paint();
    const pending = active;
    timer = setTimeout(() => {
      if (active === pending) request(pending.id, pending.query, pending.sessionId);
    }, 120);
  }

  input.addEventListener("input", event => { if (!(event instanceof InputEvent) || !event.isComposing) update(); });
  input.addEventListener("compositionstart", close);
  input.addEventListener("compositionend", update);
  input.addEventListener("click", update);
  input.addEventListener("keyup", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) update(); });
  input.addEventListener("keydown", event => {
    if (!active || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (items.length) {
        selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        paint();
      }
    } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      if (event.key === "Tab" && !items.length) { close(); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      if (items.length) select(selected);
      else if (errorState) retrySearch();
    }
  });
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));

  return {
    close,
    refresh() {
      if (!active) return;
      sessionMatches = matchingSessions(active.query);
      rebuildItems();
      paint();
    },
    receive(id: string, sessionId: string, foundFiles: MentionFile[], error?: string) {
      const now = token();
      if (!active || active.id !== id || active.sessionId !== sessionId || owner() !== sessionId || !now || now.query !== active.query || now.start !== active.start) return;
      files = foundFiles;
      errorState = error;
      searchPending = false;
      rebuildItems();
      paint();
    },
  };
}
