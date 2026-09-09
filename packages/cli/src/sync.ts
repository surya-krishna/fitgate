/**
 * Server sync: pull the active plan, push queued events. Used by the daemon's
 * background loop and by `fitgate sync` when no daemon is running.
 * Never throws on network errors — returns a result object instead.
 */
import { DevicePlanResponse, type LocalConfig } from "@fitgate/shared";
import { isPaired } from "./config.js";
import { savePlan } from "./plan.js";
import type { StateStore } from "./state.js";

export interface SyncResult {
  ok: boolean;
  planPulled: boolean;
  planVersion: number | null;
  serverPaused: boolean;
  eventsPushed: number;
  error?: string;
}

function apiUrl(base: string, p: string): string {
  return base.replace(/\/+$/, "") + p;
}

export async function syncOnce(config: LocalConfig, state: StateStore, timeoutMs = 10_000): Promise<SyncResult> {
  const result: SyncResult = { ok: false, planPulled: false, planVersion: null, serverPaused: false, eventsPushed: 0 };
  if (!isPaired(config) || !config.serverUrl) {
    result.error = "not paired";
    return result;
  }
  const headers = { Authorization: `Bearer ${config.deviceToken}`, "Content-Type": "application/json" };

  try {
    const res = await fetch(apiUrl(config.serverUrl, "/api/v1/device/plan"), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`plan: HTTP ${res.status}`);
    const parsed = DevicePlanResponse.safeParse(await res.json());
    if (!parsed.success) throw new Error("plan: malformed response");
    savePlan(parsed.data.plan);
    state.setServerPaused(parsed.data.paused);
    result.planPulled = true;
    result.planVersion = parsed.data.plan?.version ?? null;
    result.serverPaused = parsed.data.paused;
  } catch (err) {
    result.error = `${(err as Error).message}`;
    return result;
  }

  try {
    for (let i = 0; i < 20; i++) {
      const { events, nextCursor } = state.unsyncedEvents(500);
      if (events.length === 0) {
        if (nextCursor !== state.get().eventsCursor) state.setEventsCursor(nextCursor);
        break;
      }
      const res = await fetch(apiUrl(config.serverUrl, "/api/v1/device/events"), {
        method: "POST",
        headers,
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`events: HTTP ${res.status}`);
      state.setEventsCursor(nextCursor);
      result.eventsPushed += events.length;
      if (events.length < 500) break;
    }
  } catch (err) {
    result.error = `${(err as Error).message}`;
    return result;
  }

  result.ok = true;
  return result;
}
