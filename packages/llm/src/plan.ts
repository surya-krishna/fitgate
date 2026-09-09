/**
 * Plan generation. The LLM never gets the final say on safety:
 *  1. a deterministic rules layer computes hard constraints from the profile,
 *  2. the LLM drafts a plan inside those constraints (structured output),
 *  3. the draft is post-filtered so anything the rules forbid is removed,
 *  4. the plan is marked `pending_review` — a clinician still signs off.
 */
import { z } from "zod";
import {
  FitnessPlan,
  GateRules,
  HealthProfile,
  MicroTaskKind,
  MicroTaskTemplate,
  hasRedFlags,
} from "@fitgate/shared";
import type { LlmClient } from "./providers.js";

/** Output schema the LLM must produce (a subset of FitnessPlan). */
export const PlanDraft = z.object({
  title: z.string().max(120),
  summary: z.string().max(2000),
  goals: z.array(z.string().max(200)).min(1).max(8),
  microTasks: z.array(MicroTaskTemplate.omit({ id: true })).min(4).max(20),
  contraindications: z.array(z.string().max(200)).max(15),
  safetyNotes: z.array(z.string().max(400)).max(10),
  rules: GateRules.partial(),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

export interface Constraints {
  allowedKinds: MicroTaskKind[];
  maxIntensity: "restorative" | "light" | "moderate" | "vigorous";
  maxRepsPerTask: number;
  maxSecondsPerTask: number;
  notes: string[];
  requiresClinicianReview: boolean;
}

const ALL_KINDS = MicroTaskKind.options;
const INTENSITY_RANK = { restorative: 0, light: 1, moderate: 2, vigorous: 3 } as const;

/** Deterministic safety envelope derived from the profile. Conservative on purpose. */
export function deriveConstraints(profile: HealthProfile): Constraints {
  const redFlags = hasRedFlags(profile);
  let allowed = [...ALL_KINDS];
  let maxIntensity: Constraints["maxIntensity"] = "moderate";
  let maxReps = 20;
  let maxSeconds = 120;
  const notes: string[] = [];

  if (profile.fitnessLevel === "sedentary") {
    maxIntensity = "light";
    maxReps = 10;
    maxSeconds = 60;
    notes.push("Sedentary baseline: light intensity only, small volumes, progression only after clinician review.");
  } else if (profile.fitnessLevel === "beginner") {
    maxIntensity = "light";
    maxReps = 15;
    maxSeconds = 90;
  } else if (profile.fitnessLevel === "advanced") {
    maxReps = 30;
    maxSeconds = 180;
  }

  if (redFlags) {
    // Any PAR-Q+ red flag: restorative movement only until a clinician approves.
    maxIntensity = "restorative";
    allowed = allowed.filter((k) =>
      (["desk_stretch", "neck_shoulder_mobility", "hip_flexor_stretch", "walk", "breathing", "eye_rest", "hydrate", "posture_reset"] as MicroTaskKind[]).includes(k),
    );
    maxSeconds = 60;
    notes.push("Screening red flag(s) present: plan restricted to restorative movement until clinician review.");
  }
  if (profile.screening.boneOrJointProblemWorsenedByActivity) {
    allowed = allowed.filter((k) => !(["jumping_jacks", "high_knees", "stairs", "lunges"] as MicroTaskKind[]).includes(k));
    notes.push("Joint problem reported: no impact or deep-lunge movements.");
  }
  if (profile.screening.pregnantOrRecentlyPostpartum) {
    allowed = allowed.filter((k) => !(["plank", "pushups", "jumping_jacks", "high_knees"] as MicroTaskKind[]).includes(k));
    notes.push("Pregnancy/postpartum reported: no prone, supine-loaded or impact movements.");
  }
  if (profile.ageYears >= 65) {
    maxIntensity = INTENSITY_RANK[maxIntensity] > 1 ? "light" : maxIntensity;
    allowed = allowed.filter((k) => !(["jumping_jacks", "high_knees"] as MicroTaskKind[]).includes(k));
    notes.push("Age ≥65: light intensity, balance-safe movements only.");
  }

  return {
    allowedKinds: allowed,
    maxIntensity,
    maxRepsPerTask: maxReps,
    maxSecondsPerTask: maxSeconds,
    notes,
    requiresClinicianReview: true, // always — see HEALTH-SAFETY.md
  };
}

/** Remove/clamp anything the constraints forbid. Returns the sanitized draft plus a list of what changed. */
export function enforceConstraints(draft: PlanDraft, c: Constraints): { draft: PlanDraft; changes: string[] } {
  const changes: string[] = [];
  const tasks = draft.microTasks
    .filter((t) => {
      const ok = c.allowedKinds.includes(t.kind);
      if (!ok) changes.push(`removed "${t.label}" (${t.kind} not allowed)`);
      return ok;
    })
    .map((t) => {
      const out = { ...t };
      if (INTENSITY_RANK[out.intensity] > INTENSITY_RANK[c.maxIntensity]) {
        changes.push(`downgraded "${t.label}" intensity ${t.intensity} → ${c.maxIntensity}`);
        out.intensity = c.maxIntensity;
      }
      if (out.reps && out.reps > c.maxRepsPerTask) {
        changes.push(`clamped "${t.label}" reps ${out.reps} → ${c.maxRepsPerTask}`);
        out.reps = c.maxRepsPerTask;
      }
      if (out.seconds && out.seconds > c.maxSecondsPerTask) {
        changes.push(`clamped "${t.label}" seconds ${out.seconds} → ${c.maxSecondsPerTask}`);
        out.seconds = c.maxSecondsPerTask;
      }
      return out;
    });
  return { draft: { ...draft, microTasks: tasks }, changes };
}

export function buildPlanPrompt(profile: HealthProfile, c: Constraints, notes?: string): { system: string; user: string } {
  const system = `You are an exercise-physiology assistant drafting a *micro-workout* plan for a software developer.
The plan is executed as tiny "gates": every time their AI coding agent asks for approval, they do ONE short task (10s–2min) before approving.
The draft WILL be reviewed by a licensed clinician before use. Be conservative, specific and kind.

HARD CONSTRAINTS (violations are deleted automatically):
- Only these task kinds: ${c.allowedKinds.join(", ")}
- Maximum intensity: ${c.maxIntensity}
- Max reps per task: ${c.maxRepsPerTask}; max seconds per task: ${c.maxSecondsPerTask}
${c.notes.map((n) => `- ${n}`).join("\n")}

Guidelines:
- 6–12 micro-tasks. Mix strength (push/squat/hinge), mobility, walking, eye/posture resets, hydration.
- Each task must be doable at a desk in office clothes with no warm-up. Include 1–2 lines of form cues.
- Use "weight" to bias toward the user's goals; use "maxPerDay" to cap strength volume.
- Write "contraindications" the user must respect and "safetyNotes" for the clinician (why each choice is safe for this profile).
- Suggest gate "rules": cooldownMinutes (15–45), maxGatesPerDay (6–24).
- No medical diagnosis. No supplements. No claims of treating conditions.
Respond with JSON only.`;

  const user = `PROFILE
age: ${profile.ageYears}, sex: ${profile.sex}, fitness level: ${profile.fitnessLevel}
height/weight: ${profile.heightCm ?? "?"} cm / ${profile.weightKg ?? "?"} kg
screening red flags: ${hasRedFlags(profile) ? "YES" : "none"}
conditions: ${profile.conditions || "none stated"}
medications: ${profile.medications || "none stated"}
injuries: ${profile.injuries || "none stated"}
equipment: ${profile.equipment.join(", ") || "none"}
user goals: ${profile.goals || "general fitness"}
work hours: ${profile.workHours ? `${profile.workHours.start}–${profile.workHours.end}` : "unknown"} (${profile.timezone})
${notes ? `extra notes from user: ${notes}` : ""}`;
  return { system, user };
}

export interface GeneratedPlan {
  plan: FitnessPlan;
  provider: string;
  model: string;
  enforcementChanges: string[];
}

/** Full pipeline: constraints → LLM draft → enforcement → FitnessPlan(pending_review). */
export async function generatePlan(
  llm: LlmClient,
  profile: HealthProfile,
  opts: { notes?: string; idFactory?: () => string; now?: () => Date } = {},
): Promise<GeneratedPlan> {
  const c = deriveConstraints(profile);
  const { system, user } = buildPlanPrompt(profile, c, opts.notes);
  const { data, provider, model } = await llm.completeJson(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    PlanDraft,
    { schemaName: "fitgate_plan", temperature: 0.5 },
  );
  const { draft, changes } = enforceConstraints(data, c);
  const id = opts.idFactory ?? (() => crypto.randomUUID());
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const plan = FitnessPlan.parse({
    id: id(),
    version: 1,
    status: "pending_review",
    title: draft.title,
    summary: draft.summary,
    goals: draft.goals,
    microTasks: draft.microTasks.map((t) => ({ ...t, id: id() })),
    rules: GateRules.parse(draft.rules),
    contraindications: draft.contraindications,
    safetyNotes: [...c.notes, ...draft.safetyNotes, ...(changes.length ? [`Auto-enforcement: ${changes.join("; ")}`] : [])],
    createdAt: now,
    updatedAt: now,
  });
  return { plan, provider, model, enforcementChanges: changes };
}
