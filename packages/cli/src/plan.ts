/** ~/.fitgate/plan.json — the DevicePlan synced from a server, or absent. */
import { DevicePlan, DEFAULT_MICRO_TASKS, GateRules, type LocalConfig, type MicroTaskTemplate } from "@fitgate/shared";
import { files } from "./paths.js";
import { readJsonFile, removeIfExists, writeJsonAtomic } from "./fsutil.js";

export function loadPlan(): DevicePlan | null {
  try {
    const raw = readJsonFile(files.plan());
    if (raw === undefined) return null;
    const r = DevicePlan.safeParse(raw);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function savePlan(plan: DevicePlan | null): void {
  if (!plan) removeIfExists(files.plan());
  else writeJsonAtomic(files.plan(), plan);
}

export interface EffectivePlan {
  plan: DevicePlan | null;
  /** Task pool to serve from (may be empty → pass with passed_no_plan). */
  tasks: MicroTaskTemplate[];
  rules: GateRules;
  /** The synced plan itself is paused on the server side. */
  planPaused: boolean;
}

/** Combine the synced plan (if any) with local config into what the daemon should actually enforce. */
export function effectivePlan(config: LocalConfig, plan: DevicePlan | null): EffectivePlan {
  if (plan && plan.status === "active") {
    return { plan, tasks: plan.microTasks, rules: plan.rules, planPaused: false };
  }
  if (plan && plan.status === "paused") {
    return { plan, tasks: [], rules: plan.rules, planPaused: true };
  }
  return {
    plan,
    tasks: config.useDefaultPoolWhenNoPlan ? DEFAULT_MICRO_TASKS : [],
    rules: config.rules,
    planPaused: false,
  };
}
