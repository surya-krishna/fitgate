/**
 * @fitgate/shared — the single source of truth for every data shape that crosses
 * a boundary in FitGate: CLI ⇄ local daemon, daemon ⇄ server, server ⇄ LLM.
 *
 * Everything here is a zod schema + inferred type. Keep it dependency-free
 * (zod only) so the CLI stays tiny.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Agents we can intercept
// ---------------------------------------------------------------------------

/** Every coding agent FitGate knows how to hook into. */
export const AgentId = z.enum([
  "claude-code",
  "cursor",
  "copilot",
  "codex",
  "gemini",
  "windsurf",
  "amp",
  "augment",
  "kiro",
  "cline",
  "mcp", // generic: agent called our MCP tool
  "wrap", // generic: PTY wrapper detected a y/n prompt
  "unknown",
]);
export type AgentId = z.infer<typeof AgentId>;

// ---------------------------------------------------------------------------
// Micro-tasks (the thing you do at the gate)
// ---------------------------------------------------------------------------

export const MicroTaskKind = z.enum([
  "pushups",
  "squats",
  "lunges",
  "plank",
  "wall_sit",
  "calf_raises",
  "jumping_jacks",
  "high_knees",
  "glute_bridge",
  "chair_dips",
  "desk_stretch",
  "neck_shoulder_mobility",
  "hip_flexor_stretch",
  "walk",
  "stairs",
  "breathing",
  "eye_rest", // 20-20-20 rule
  "hydrate",
  "posture_reset",
  "custom",
]);
export type MicroTaskKind = z.infer<typeof MicroTaskKind>;

export const Intensity = z.enum(["restorative", "light", "moderate", "vigorous"]);
export type Intensity = z.infer<typeof Intensity>;

/**
 * A single micro-task template inside a plan. The daemon instantiates one of
 * these at each gate. Reps/seconds are *targets*; the user self-reports.
 */
export const MicroTaskTemplate = z.object({
  id: z.string().min(1),
  kind: MicroTaskKind,
  /** Short imperative label shown in the gate UI, e.g. "5 push-ups". */
  label: z.string().min(1).max(80),
  /** One or two lines of form cues. */
  instructions: z.string().max(600).default(""),
  reps: z.number().int().positive().optional(),
  seconds: z.number().int().positive().optional(),
  intensity: Intensity.default("light"),
  /** Relative weight when the daemon picks the next task (default 1). */
  weight: z.number().positive().default(1),
  /** Max times per day this template may be served. */
  maxPerDay: z.number().int().positive().optional(),
  /** Free-text reasons this exists in the plan (clinician-visible). */
  rationale: z.string().max(400).optional(),
});
export type MicroTaskTemplate = z.infer<typeof MicroTaskTemplate>;

// ---------------------------------------------------------------------------
// Plan — what the LLM drafts, the clinician reviews, the user accepts
// ---------------------------------------------------------------------------

export const PlanStatus = z.enum([
  "draft", // LLM generated, nobody has looked at it
  "pending_review", // sent to a clinician
  "changes_requested", // clinician wants edits
  "reviewed", // clinician signed off
  "active", // user accepted a reviewed plan; synced to devices
  "paused",
  "archived",
]);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const GateRules = z.object({
  /** Minimum minutes between two gates (so approvals aren't gated every 30s). */
  cooldownMinutes: z.number().int().min(0).max(240).default(20),
  /** Hard cap on gates served per calendar day (local time). */
  maxGatesPerDay: z.number().int().min(0).max(100).default(12),
  /** Local-time quiet hours during which gates always pass, "HH:MM". */
  quietHours: z
    .array(z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }))
    .default([]),
  /** Seconds the hook will wait for the user before giving up. */
  waitTimeoutSeconds: z.number().int().min(30).max(3600).default(480),
  /** What to do when the user skips or the wait times out. */
  onSkip: z.enum(["pass", "deny"]).default("pass"),
});
export type GateRules = z.infer<typeof GateRules>;

export const FitnessPlan = z.object({
  id: z.string(),
  version: z.number().int().positive().default(1),
  status: PlanStatus.default("draft"),
  title: z.string().max(120),
  /** Plain-language summary for the user (and clinician). */
  summary: z.string().max(2000),
  /** Weekly goals the micro-tasks add up to, e.g. "60 push-ups/day, 20 min walking". */
  goals: z.array(z.string().max(200)).max(10),
  microTasks: z.array(MicroTaskTemplate).min(1).max(40),
  rules: GateRules.default({}),
  /** Things the user must NOT do — surfaced in UI and to the LLM on regeneration. */
  contraindications: z.array(z.string().max(200)).default([]),
  /** Clinician-facing safety notes produced by the generator. */
  safetyNotes: z.array(z.string().max(400)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FitnessPlan = z.infer<typeof FitnessPlan>;

/** Only what a device needs: the plan minus review metadata. Synced to ~/.fitgate/plan.json */
export const DevicePlan = FitnessPlan.pick({
  id: true,
  version: true,
  status: true,
  title: true,
  goals: true,
  microTasks: true,
  rules: true,
  contraindications: true,
  updatedAt: true,
});
export type DevicePlan = z.infer<typeof DevicePlan>;

// ---------------------------------------------------------------------------
// Health profile (server-side only; NEVER synced to devices)
// ---------------------------------------------------------------------------

export const FitnessLevel = z.enum(["sedentary", "beginner", "intermediate", "advanced"]);

/**
 * PAR-Q+ style screening. Any "true" here is a red flag that forces clinician
 * review before a plan can become active (see HEALTH-SAFETY.md).
 */
export const Screening = z.object({
  heartConditionOrDoctorAdvisedActivityLimit: z.boolean(),
  chestPainDuringActivity: z.boolean(),
  chestPainAtRestLastMonth: z.boolean(),
  dizzinessOrLossOfConsciousness: z.boolean(),
  boneOrJointProblemWorsenedByActivity: z.boolean(),
  prescribedBloodPressureOrHeartMedication: z.boolean(),
  pregnantOrRecentlyPostpartum: z.boolean(),
  otherReasonNotToExercise: z.boolean(),
});
export type Screening = z.infer<typeof Screening>;

export const HealthProfile = z.object({
  ageYears: z.number().int().min(16).max(110),
  sex: z.enum(["female", "male", "other", "prefer_not_to_say"]),
  heightCm: z.number().min(100).max(250).optional(),
  weightKg: z.number().min(25).max(400).optional(),
  fitnessLevel: FitnessLevel,
  screening: Screening,
  /** Free text — conditions, injuries, surgeries, medications. Shown to clinician + LLM. */
  conditions: z.string().max(4000).default(""),
  medications: z.string().max(2000).default(""),
  injuries: z.string().max(2000).default(""),
  /** What the user wants: "lose weight", "fix posture", "stop back pain". */
  goals: z.string().max(2000).default(""),
  /** Equipment at desk: none / resistance band / dumbbells / pull-up bar … */
  equipment: z.array(z.string().max(60)).default([]),
  /** Typical coding hours in local time, used for quiet hours. */
  workHours: z.object({ start: z.string(), end: z.string() }).optional(),
  timezone: z.string().default("UTC"),
});
export type HealthProfile = z.infer<typeof HealthProfile>;

/** True when any screening answer is a red flag. */
export function hasRedFlags(p: Pick<HealthProfile, "screening">): boolean {
  return Object.values(p.screening).some(Boolean);
}

// ---------------------------------------------------------------------------
// Gate events (device → server telemetry; also the daemon's local log)
// ---------------------------------------------------------------------------

export const GateOutcome = z.enum([
  "completed", // user pressed "Done"
  "skipped", // user pressed "Skip"
  "timeout", // waited waitTimeoutSeconds, gave up
  "passed_cooldown", // no gate served: cooldown active
  "passed_cap", // no gate served: daily cap reached
  "passed_quiet", // no gate served: quiet hours
  "passed_paused", // user paused FitGate
  "passed_no_plan", // no active plan, default pool disabled
  "error", // daemon unreachable etc. — always fail-open
]);
export type GateOutcome = z.infer<typeof GateOutcome>;

export const GateEvent = z.object({
  id: z.string(),
  deviceId: z.string(),
  agent: AgentId,
  /** e.g. "Bash", "Write", "mcp__github__create_pr" — never the full input. */
  tool: z.string().max(120).optional(),
  taskId: z.string().optional(),
  taskKind: MicroTaskKind.optional(),
  taskLabel: z.string().optional(),
  outcome: GateOutcome,
  /** Seconds from gate open to resolution. */
  durationSeconds: z.number().nonnegative().optional(),
  /** Optional self-reported reps/seconds actually done. */
  reported: z.object({ reps: z.number().int().optional(), seconds: z.number().int().optional() }).optional(),
  at: z.string().datetime(),
});
export type GateEvent = z.infer<typeof GateEvent>;

// ---------------------------------------------------------------------------
// Local daemon HTTP API (127.0.0.1:4820) — used by hooks, MCP server, web UI
// ---------------------------------------------------------------------------

export const DAEMON_DEFAULT_PORT = 4820;

export const GateOpenRequest = z.object({
  agent: AgentId,
  tool: z.string().max(120).optional(),
  /** One-line human-readable description of what the agent wants to do. */
  summary: z.string().max(300).optional(),
  sessionId: z.string().optional(),
});
export type GateOpenRequest = z.infer<typeof GateOpenRequest>;

export const GateState = z.enum(["open", "completed", "skipped", "timeout"]);

export const Gate = z.object({
  id: z.string(),
  agent: AgentId,
  tool: z.string().optional(),
  summary: z.string().optional(),
  task: MicroTaskTemplate,
  /** Short motivational line (LLM-generated or from a local pool). */
  nudge: z.string().max(240),
  state: GateState,
  openedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime(),
});
export type Gate = z.infer<typeof Gate>;

/** Daemon answer to a gate-open request. */
export const GateOpenResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("gate"), gate: Gate }),
  z.object({ status: z.literal("pass"), reason: GateOutcome }),
]);
export type GateOpenResponse = z.infer<typeof GateOpenResponse>;

export const GateResolveRequest = z.object({
  outcome: z.enum(["completed", "skipped"]),
  reported: GateEvent.shape.reported,
});
export type GateResolveRequest = z.infer<typeof GateResolveRequest>;

export const DaemonStatus = z.object({
  version: z.string(),
  paused: z.boolean(),
  pausedUntil: z.string().datetime().optional(),
  plan: DevicePlan.pick({ id: true, version: true, title: true, status: true }).nullable(),
  today: z.object({
    gatesServed: z.number().int(),
    completed: z.number().int(),
    skipped: z.number().int(),
    streakDays: z.number().int(),
  }),
  openGate: Gate.nullable(),
  lastGateAt: z.string().datetime().nullable(),
  serverConnected: z.boolean(),
});
export type DaemonStatus = z.infer<typeof DaemonStatus>;

// ---------------------------------------------------------------------------
// Local config (~/.fitgate/config.json)
// ---------------------------------------------------------------------------

export const LocalConfig = z.object({
  port: z.number().int().default(DAEMON_DEFAULT_PORT),
  /** Base URL of a FitGate server (cloud or self-hosted). Null = fully offline mode. */
  serverUrl: z.string().url().nullable().default(null),
  deviceToken: z.string().nullable().default(null),
  deviceId: z.string().nullable().default(null),
  /** Serve the built-in default micro-task pool when no plan is synced. */
  useDefaultPoolWhenNoPlan: z.boolean().default(true),
  /** Rules override for offline mode (server plan rules win when a plan is active). */
  rules: GateRules.default({}),
  /** Optional local LLM key for offline nudges. Never required. */
  openrouterApiKey: z.string().nullable().default(null),
  /** Open the gate web page in the default browser when a gate opens. */
  openBrowser: z.boolean().default(true),
  /** Send an OS notification when a gate opens. */
  notify: z.boolean().default(true),
  /** Which agents have hooks installed (bookkeeping for `fitgate doctor`). */
  installedAgents: z.array(AgentId).default([]),
});
export type LocalConfig = z.infer<typeof LocalConfig>;

// ---------------------------------------------------------------------------
// Server API contracts (apps/server/app/api/v1/*)
// ---------------------------------------------------------------------------

/** POST /api/v1/device/pair — body */
export const DevicePairRequest = z.object({
  pairingCode: z.string().length(8),
  deviceName: z.string().max(80),
  platform: z.string().max(40),
});
/** POST /api/v1/device/pair — response */
export const DevicePairResponse = z.object({ deviceId: z.string(), deviceToken: z.string() });

/** GET /api/v1/device/plan — response (Bearer deviceToken) */
export const DevicePlanResponse = z.object({ plan: DevicePlan.nullable(), paused: z.boolean() });

/** POST /api/v1/device/events — body (Bearer deviceToken) */
export const DeviceEventsRequest = z.object({ events: z.array(GateEvent).max(500) });

/** POST /api/v1/device/nudge — body/response (Bearer deviceToken) */
export const NudgeRequest = z.object({
  task: MicroTaskTemplate,
  agent: AgentId,
  todayCompleted: z.number().int(),
  streakDays: z.number().int(),
});
export const NudgeResponse = z.object({ nudge: z.string().max(240) });

/** POST /api/v1/plans/generate — body (session cookie) */
export const GeneratePlanRequest = z.object({
  /** Extra instructions from the user, e.g. "I have a standing desk". */
  notes: z.string().max(2000).optional(),
});

/** Clinician review submission — POST /api/review/[token] */
export const ReviewDecision = z.object({
  decision: z.enum(["approve", "request_changes"]),
  reviewerName: z.string().min(2).max(120),
  reviewerCredentials: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  /** Optional edited plan (clinician may adjust reps / remove tasks). */
  plan: FitnessPlan.pick({ microTasks: true, contraindications: true, rules: true, summary: true, goals: true })
    .partial()
    .optional(),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

// ---------------------------------------------------------------------------
// Default micro-task pool (used offline / before a plan exists)
// Conservative: bodyweight, low-impact, no contraindication-sensitive moves.
// ---------------------------------------------------------------------------

export const DEFAULT_MICRO_TASKS: MicroTaskTemplate[] = [
  { id: "d-pushups", kind: "pushups", label: "5 push-ups", instructions: "Knees down is fine. Chest to fist-height, elbows ~45°.", reps: 5, intensity: "light", weight: 2, maxPerDay: 8 },
  { id: "d-squats", kind: "squats", label: "10 bodyweight squats", instructions: "Feet shoulder-width, sit back, knees track over toes.", reps: 10, intensity: "light", weight: 2, maxPerDay: 8 },
  { id: "d-plank", kind: "plank", label: "30-second plank", instructions: "Forearms down, squeeze glutes, don't let hips sag.", seconds: 30, intensity: "light", weight: 1, maxPerDay: 4 },
  { id: "d-calf", kind: "calf_raises", label: "15 calf raises", instructions: "Slow up, slow down. Hold the desk for balance.", reps: 15, intensity: "light", weight: 1 },
  { id: "d-stretch", kind: "desk_stretch", label: "Stand up & stretch 45s", instructions: "Reach overhead, side bend each way, roll shoulders back 10×.", seconds: 45, intensity: "restorative", weight: 2 },
  { id: "d-neck", kind: "neck_shoulder_mobility", label: "Neck & shoulder reset", instructions: "Chin tucks ×10, slow neck circles each way, shoulder rolls ×10.", seconds: 45, intensity: "restorative", weight: 1 },
  { id: "d-hip", kind: "hip_flexor_stretch", label: "Hip flexor stretch 30s/side", instructions: "Half-kneel, tuck pelvis, gentle lean forward. Breathe.", seconds: 60, intensity: "restorative", weight: 1 },
  { id: "d-walk", kind: "walk", label: "2-minute walk", instructions: "Leave the desk. Water refill counts.", seconds: 120, intensity: "light", weight: 1, maxPerDay: 6 },
  { id: "d-eyes", kind: "eye_rest", label: "20-20-20 eye rest", instructions: "Look at something 20 feet away for 20 seconds. Blink.", seconds: 20, intensity: "restorative", weight: 1 },
  { id: "d-water", kind: "hydrate", label: "Drink a glass of water", instructions: "A full glass. Then come back.", intensity: "restorative", weight: 1, maxPerDay: 6 },
  { id: "d-breath", kind: "breathing", label: "Box breathing ×4", instructions: "In 4s, hold 4s, out 4s, hold 4s. Four rounds.", seconds: 64, intensity: "restorative", weight: 1 },
];

/** Version of the shared contract; bump on breaking changes. */
export const CONTRACT_VERSION = 1;
