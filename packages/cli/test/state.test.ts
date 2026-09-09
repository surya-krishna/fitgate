import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore, localDate } from "../src/state.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fitgate-state-"));
  process.env.FITGATE_HOME = dir;
});
afterEach(() => {
  delete process.env.FITGATE_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("counts and persists", () => {
    let now = new Date(2026, 8, 5, 10, 0);
    const s = new StateStore(() => now);
    s.recordGateServed("a", now);
    s.recordCompleted();
    s.recordGateServed("a", now);
    s.recordSkipped();
    expect(s.get()).toMatchObject({ gatesServed: 2, completed: 1, skipped: 1, perTask: { a: 2 } });
    expect(s.currentStreak()).toBe(1);

    const reloaded = new StateStore(() => now);
    expect(reloaded.get().gatesServed).toBe(2);
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);

    now = new Date(2026, 8, 6, 10, 0);
    expect(reloaded.get().gatesServed).toBe(0);
    expect(reloaded.get().date).toBe(localDate(now));
    expect(reloaded.currentStreak()).toBe(1); // yesterday completed → streak still alive
  });

  it("streak counts consecutive days and breaks after a gap", () => {
    let now = new Date(2026, 8, 5, 10, 0);
    const s = new StateStore(() => now);
    s.recordCompleted();
    s.recordCompleted();
    expect(s.currentStreak()).toBe(1);
    now = new Date(2026, 8, 6, 10, 0);
    s.recordCompleted();
    expect(s.currentStreak()).toBe(2);
    now = new Date(2026, 8, 7, 10, 0);
    s.recordCompleted();
    expect(s.currentStreak()).toBe(3);
    now = new Date(2026, 8, 9, 10, 0); // skipped the 8th
    expect(s.currentStreak()).toBe(0);
    s.recordCompleted();
    expect(s.currentStreak()).toBe(1);
  });

  it("pause with expiry", () => {
    let now = new Date(2026, 8, 5, 10, 0);
    const s = new StateStore(() => now);
    s.pause(30);
    expect(s.isPaused()).toBe(true);
    now = new Date(2026, 8, 5, 10, 31);
    expect(s.isPaused()).toBe(false);
    s.pause();
    now = new Date(2026, 8, 6, 10, 31);
    expect(s.isPaused()).toBe(true);
    s.resume();
    expect(s.isPaused()).toBe(false);
  });

  it("events log and sync cursor", () => {
    const s = new StateStore();
    const ev = (i: number) => ({ id: `e${i}`, deviceId: "local", agent: "cursor" as const, outcome: "completed" as const, at: new Date(1000 * i).toISOString() });
    s.appendEvent(ev(1));
    s.appendEvent(ev(2));
    s.appendEvent(ev(3));
    expect(s.readEvents()).toHaveLength(3);
    expect(s.readEvents(new Date(2500).toISOString())).toHaveLength(1);
    const u = s.unsyncedEvents(2);
    expect(u.events.map((e) => e.id)).toEqual(["e1", "e2"]);
    s.setEventsCursor(u.nextCursor);
    expect(s.unsyncedEvents().events.map((e) => e.id)).toEqual(["e3"]);
    // corrupt line is skipped
    fs.appendFileSync(path.join(dir, "events.jsonl"), "not json\n");
    expect(s.readEvents()).toHaveLength(3);
  });
});
