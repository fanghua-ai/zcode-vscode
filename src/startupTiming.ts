import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** Local operation timing. Values are durations and counts, never session or account ids. */
export class StartupTiming {
  private readonly started = Date.now();
  private readonly phases = new Map<string, number>();
  private readonly notes = new Map<string, string | number | boolean>();
  private readonly hostDelay?: ReturnType<typeof monitorEventLoopDelay>;
  private readonly hostUtilization?: ReturnType<typeof performance.eventLoopUtilization>;
  private hostMonitorStopped = false;

  constructor(private readonly kind: "open" | "switch" | "send", monitorHost = false) {
    if (monitorHost) {
      this.hostDelay = monitorEventLoopDelay({ resolution: 20 });
      this.hostUtilization = performance.eventLoopUtilization();
      this.hostDelay.enable();
    }
  }

  dispose(): void {
    if (!this.hostDelay || this.hostMonitorStopped) return;
    this.recordHostTiming();
    this.hostMonitorStopped = true;
    this.hostDelay.disable();
  }

  private recordHostTiming(): void {
    if (!this.hostDelay || this.hostMonitorStopped) return;
    this.note("hostEventLoopDelayMaxMs", Math.round(this.hostDelay.max / 1e6));
    const usage = performance.eventLoopUtilization(this.hostUtilization);
    // Some Electron hosts report zero for both fields despite handling events.
    // Missing telemetry must not be interpreted as an entirely idle host.
    const available = usage.active + usage.idle > 0;
    this.note("hostEventLoopUtilizationAvailable", available);
    if (available) {
      this.note("hostEventLoopActiveMs", Math.round(usage.active));
      this.note("hostEventLoopIdleMs", Math.round(usage.idle));
    }
  }

  mark(phase: string): void {
    if (!this.phases.has(phase)) this.set(phase, Date.now() - this.started);
  }

  add(phase: string, ms: number): void {
    this.phases.set(phase, (this.phases.get(phase) ?? 0) + Math.max(0, ms));
  }

  set(phase: string, ms: number): void {
    this.phases.set(phase, Math.max(0, ms));
  }

  note(key: string, value: string | number | boolean): void {
    this.notes.set(key, value);
  }

  addCount(key: string, by = 1): void {
    const current = this.notes.get(key);
    this.notes.set(key, (typeof current === "number" ? current : 0) + by);
  }

  snapshot(): Record<string, string | number | boolean> {
    this.recordHostTiming();
    return {
      kind: this.kind,
      totalMs: Date.now() - this.started,
      ...Object.fromEntries(this.phases),
      ...Object.fromEntries(this.notes),
    };
  }
}
