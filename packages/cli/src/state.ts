/**
 * Daemon runtime state (~/.fitgate/state.json) + the append-only event log
 * (~/.fitgate/events.jsonl). Counters are per *local* calendar day and reset
 * automatically when the date changes.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GateEvent } from "@fitgate/shared";
import { files } from "./paths.js";
import { readJsonFile, writeJsonAtomic } from "./fsutil.js";

export const PersistedState = z.object({
  /** Local date (YYYY-MM-DD) the counters below belong to. */
  date: z.string().default(""),
  gatesServed: z.number().int().default(0),
  completed: z.number().int().default(0),
  skipped: z.number().int().default(0),
  /** Times each task template id was served today. */
  perTask: z.record(z.number().int()).default({}),
  lastGateAt: z.string().nullable().default(null),
  /** Consecutive local days with >= 1 completed gate, as of `lastCompletedDate`. */
  streakDays: z.number().int().default(0),
  lastCompletedDate: z.string().nullable().default(null),
  paused: z.boolean().default(false),
  pausedUntil: z.string().nullable().default(null),
  /** Pause flag pushed by the server (dashboard toggle). */
  serverPaused: z.boolean().default(false),
  /** Number of lines of events.jsonl already pushed to the server. */
  eventsCursor: z.number().int().default(0),
});
export type PersistedState = z.infer<typeof PersistedState>;

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d + days);
  return localDate(dt);
}

export class StateStore {
  private state: PersistedState;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.state = this.load();
    this.rollover();
  }

  private load(): PersistedState {
    let raw: unknown;
    try {
      raw = readJsonFile(files.state());
    } catch {
      raw = undefined;
    }
    const parsed = PersistedState.safeParse(raw ?? {});
    return parsed.success ? parsed.data : PersistedState.parse({});
  }

  save(): void {
    try {
      writeJsonAtomic(files.state(), this.state);
    } catch {
      /* never crash the daemon over a state write */
    }
  }

  /** Reset the daily counters if the local date moved on. */
  rollover(): void {
    const today = localDate(this.now());
    if (this.state.date !== today) {
      this.state.date = today;
      this.state.gatesServed = 0;
      this.state.completed = 0;
      this.state.skipped = 0;
      this.state.perTask = {};
      this.save();
    }
    if (this.state.paused && this.state.pausedUntil) {
      if (new Date(this.state.pausedUntil).getTime() <= this.now().getTime()) {
        this.state.paused = false;
        this.state.pausedUntil = null;
        this.save();
      }
    }
  }

  get(): Readonly<PersistedState> {
    this.rollover();
    return this.state;
  }

  /** Current streak: 0 if the last completion was before yesterday. */
  currentStreak(): number {
    this.rollover();
    const last = this.state.lastCompletedDate;
    if (!last) return 0;
    const today = this.state.date;
    if (last === today || last === shiftDate(today, -1)) return this.state.streakDays;
    return 0;
  }

  recordGateServed(taskId: string, at: Date): void {
    this.rollover();
    this.state.gatesServed += 1;
    this.state.perTask[taskId] = (this.state.perTask[taskId] ?? 0) + 1;
    this.state.lastGateAt = at.toISOString();
    this.save();
  }

  recordCompleted(): void {
    this.rollover();
    this.state.completed += 1;
    const today = this.state.date;
    if (this.state.lastCompletedDate !== today) {
      if (this.state.lastCompletedDate === shiftDate(today, -1)) this.state.streakDays += 1;
      else this.state.streakDays = 1;
      this.state.lastCompletedDate = today;
    }
    this.save();
  }

  recordSkipped(): void {
    this.rollover();
    this.state.skipped += 1;
    this.save();
  }

  pause(minutes?: number): void {
    this.state.paused = true;
    this.state.pausedUntil = minutes && minutes > 0 ? new Date(this.now().getTime() + minutes * 60_000).toISOString() : null;
    this.save();
  }

  resume(): void {
    this.state.paused = false;
    this.state.pausedUntil = null;
    this.save();
  }

  setServerPaused(v: boolean): void {
    if (this.state.serverPaused !== v) {
      this.state.serverPaused = v;
      this.save();
    }
  }

  isPaused(): boolean {
    this.rollover();
    return this.state.paused || this.state.serverPaused;
  }

  // ---- events -------------------------------------------------------------

  appendEvent(event: GateEvent): void {
    try {
      fs.mkdirSync(path.dirname(files.events()), { recursive: true });
      fs.appendFileSync(files.events(), JSON.stringify(event) + "\n", "utf8");
    } catch {
      /* ignore */
    }
  }

  /** All events (parsed), newest last. Optional `since` ISO filter. */
  readEvents(since?: string, limit = 200): GateEvent[] {
    const lines = readEventLines();
    const out: GateEvent[] = [];
    const sinceMs = since ? new Date(since).getTime() : Number.NEGATIVE_INFINITY;
    for (const line of lines) {
      const ev = parseEvent(line);
      if (!ev) continue;
      if (new Date(ev.at).getTime() >= sinceMs) out.push(ev);
    }
    return out.slice(-limit);
  }

  /** Events not yet pushed to the server, with the cursor to advance to on success. */
  unsyncedEvents(max = 500): { events: GateEvent[]; nextCursor: number } {
    const lines = readEventLines();
    const start = Math.min(this.state.eventsCursor, lines.length);
    const slice = lines.slice(start, start + max);
    const events = slice.map(parseEvent).filter((e): e is GateEvent => Boolean(e));
    return { events, nextCursor: start + slice.length };
  }

  setEventsCursor(cursor: number): void {
    this.state.eventsCursor = cursor;
    this.save();
  }
}

function readEventLines(): string[] {
  try {
    return fs
      .readFileSync(files.events(), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function parseEvent(line: string): GateEvent | null {
  try {
    const r = GateEvent.safeParse(JSON.parse(line));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
