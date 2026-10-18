import { StartupTiming } from "./startupTiming";

/** Bounded, local diagnostics. Identities are used for ownership, never logged. */
export class SendTiming {
  private active?: { id: string; sessionId: string; timing: StartupTiming; first: boolean; visible: boolean; admitted: boolean };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly log: (data: Record<string, string | number | boolean>) => void) {}

  start(sessionId: string, id: string, uiSentAt?: number): void {
    this.clear();
    this.active = { sessionId, id, timing: new StartupTiming("send", true), first: false, visible: false, admitted: false };
    const bridgeWait = typeof uiSentAt === "number" ? Date.now() - uiSentAt : NaN;
    if (Number.isFinite(bridgeWait) && bridgeWait >= 0 && bridgeWait <= 180_000) this.active.timing.note("webviewToHostMs", Math.round(bridgeWait));
    this.timer = setTimeout(() => this.end("timeout"), 180_000);
    this.timer.unref();
  }

  mark(id: string, phase: string): void {
    if (this.active?.id === id) this.active.timing.mark(phase);
  }

  admitted(id: string): void {
    const active = this.active;
    if (active?.id !== id) return;
    active.admitted = true;
    active.timing.mark("admittedMs");
    this.log({ ...active.timing.snapshot(), stage: "admitted" });
    if (active.visible) this.clear();
  }

  firstOutput(sessionId: string): string | undefined {
    const active = this.active;
    if (!active || active.sessionId !== sessionId || active.first) return;
    active.first = true;
    active.timing.mark("firstOutputPostedMs");
    this.log({ ...active.timing.snapshot(), stage: "first_output" });
    return active.id;
  }

  running(sessionId: string): void {
    if (this.active?.sessionId === sessionId) this.active.timing.mark("runningStatusPostedMs");
  }

  endForSession(sessionId: string, stage: "completed" | "interrupted"): void {
    if (this.active?.sessionId === sessionId) this.end(stage);
  }

  visible(sessionId: string, id: string, renderWaitMs: unknown): void {
    const active = this.active;
    if (!active || active.id !== id || active.sessionId !== sessionId || !active.first || active.visible) return;
    if (typeof renderWaitMs !== "number" || !Number.isFinite(renderWaitMs) || renderWaitMs < 0 || renderWaitMs > 180_000) return;
    active.visible = true;
    active.timing.mark("firstOutputPaintAckMs");
    active.timing.note("webviewFrameWaitMs", Math.round(renderWaitMs));
    active.timing.dispose();
    this.log({ ...active.timing.snapshot(), stage: "paint_ack" });
    if (active.admitted) this.clear();
  }

  end(stage: "completed" | "interrupted" | "rejected" | "timeout", id?: string): void {
    if (!this.active || id && id !== this.active.id) return;
    this.active.timing.dispose();
    this.log({ ...this.active.timing.snapshot(), stage });
    this.clear();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.timing.dispose();
    this.active = undefined;
  }
}
