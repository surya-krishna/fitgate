import { describe, it, expect } from "vitest";
import { DEFAULT_MICRO_TASKS, GateRules, type MicroTaskTemplate } from "@fitgate/shared";
import { evaluateRules, isInQuietHours, pickTask } from "../src/daemon/pick.js";

const t = (id: string, weight = 1, maxPerDay?: number): MicroTaskTemplate => ({
  id,
  kind: "squats",
  label: id,
  instructions: "",
  intensity: "light",
  weight,
  maxPerDay,
});

describe("pickTask", () => {
  it("returns null for an empty pool", () => {
    expect(pickTask([], {})).toBeNull();
  });

  it("respects maxPerDay", () => {
    const tasks = [t("a", 1, 2), t("b", 1, 1)];
    expect(pickTask(tasks, { a: 2, b: 1 })).toBeNull();
    expect(pickTask(tasks, { a: 2 })?.id).toBe("b");
    expect(pickTask(tasks, { b: 1 })?.id).toBe("a");
  });

  it("is weighted", () => {
    const tasks = [t("light", 1), t("heavy", 9)];
    const counts: Record<string, number> = { light: 0, heavy: 0 };
    let seed = 42;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) counts[pickTask(tasks, {}, rng)!.id]!++;
    expect(counts.heavy).toBeGreaterThan(counts.light! * 5);
  });

  it("deterministic with rng", () => {
    const tasks = [t("a", 1), t("b", 1), t("c", 1)];
    expect(pickTask(tasks, {}, () => 0)?.id).toBe("a");
    expect(pickTask(tasks, {}, () => 0.5)?.id).toBe("b");
    expect(pickTask(tasks, {}, () => 0.99)?.id).toBe("c");
  });

  it("works with the default pool", () => {
    expect(pickTask(DEFAULT_MICRO_TASKS, {})).not.toBeNull();
  });
});

describe("isInQuietHours", () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 5, h, m);

  it("simple window", () => {
    const w = [{ start: "09:00", end: "17:00" }];
    expect(isInQuietHours(w, at(8, 59))).toBe(false);
    expect(isInQuietHours(w, at(9, 0))).toBe(true);
    expect(isInQuietHours(w, at(16, 59))).toBe(true);
    expect(isInQuietHours(w, at(17, 0))).toBe(false);
  });

  it("window crossing midnight", () => {
    const w = [{ start: "22:00", end: "07:00" }];
    expect(isInQuietHours(w, at(21, 59))).toBe(false);
    expect(isInQuietHours(w, at(22, 0))).toBe(true);
    expect(isInQuietHours(w, at(23, 30))).toBe(true);
    expect(isInQuietHours(w, at(0, 0))).toBe(true);
    expect(isInQuietHours(w, at(6, 59))).toBe(true);
    expect(isInQuietHours(w, at(7, 0))).toBe(false);
    expect(isInQuietHours(w, at(12, 0))).toBe(false);
  });

  it("empty and degenerate windows", () => {
    expect(isInQuietHours([], at(12))).toBe(false);
    expect(isInQuietHours([{ start: "12:00", end: "12:00" }], at(12))).toBe(false);
  });
});

describe("evaluateRules", () => {
  const rules = GateRules.parse({ cooldownMinutes: 20, maxGatesPerDay: 3, quietHours: [{ start: "22:00", end: "07:00" }] });
  const now = new Date(2026, 8, 5, 12, 0, 0);
  const base = { rules, now, paused: false, lastGateAt: null, gatesServedToday: 0, hasTasks: true };

  it("serves a gate when nothing blocks", () => {
    expect(evaluateRules(base)).toBeNull();
  });
  it("paused wins", () => {
    expect(evaluateRules({ ...base, paused: true })).toBe("passed_paused");
  });
  it("quiet hours", () => {
    expect(evaluateRules({ ...base, now: new Date(2026, 8, 5, 23, 0) })).toBe("passed_quiet");
    expect(evaluateRules({ ...base, now: new Date(2026, 8, 5, 6, 30) })).toBe("passed_quiet");
  });
  it("cooldown", () => {
    const tenMinAgo = new Date(now.getTime() - 10 * 60_000).toISOString();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60_000).toISOString();
    expect(evaluateRules({ ...base, lastGateAt: tenMinAgo })).toBe("passed_cooldown");
    expect(evaluateRules({ ...base, lastGateAt: thirtyMinAgo })).toBeNull();
  });
  it("zero cooldown never blocks", () => {
    const r = GateRules.parse({ cooldownMinutes: 0 });
    expect(evaluateRules({ ...base, rules: r, lastGateAt: now.toISOString() })).toBeNull();
  });
  it("daily cap", () => {
    expect(evaluateRules({ ...base, gatesServedToday: 3 })).toBe("passed_cap");
    expect(evaluateRules({ ...base, gatesServedToday: 2 })).toBeNull();
  });
  it("no plan / no tasks", () => {
    expect(evaluateRules({ ...base, hasTasks: false })).toBe("passed_no_plan");
  });
  it("precedence: paused > quiet > cooldown > cap > no plan", () => {
    const all = { ...base, paused: true, now: new Date(2026, 8, 5, 23), lastGateAt: now.toISOString(), gatesServedToday: 9, hasTasks: false };
    expect(evaluateRules(all)).toBe("passed_paused");
    expect(evaluateRules({ ...all, paused: false })).toBe("passed_quiet");
    expect(evaluateRules({ ...all, paused: false, now, lastGateAt: new Date(now.getTime() - 60_000).toISOString() })).toBe("passed_cooldown");
    expect(evaluateRules({ ...all, paused: false, now, lastGateAt: null })).toBe("passed_cap");
    expect(evaluateRules({ ...all, paused: false, now, lastGateAt: null, gatesServedToday: 0 })).toBe("passed_no_plan");
  });
});
