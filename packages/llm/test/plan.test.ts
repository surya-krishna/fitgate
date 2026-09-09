import { describe, it, expect } from "vitest";
import { HealthProfile } from "@fitgate/shared";
import { deriveConstraints, enforceConstraints, generatePlan, LlmClient, type PlanDraft } from "../src/index.js";

const baseProfile = HealthProfile.parse({
  ageYears: 30,
  sex: "male",
  fitnessLevel: "beginner",
  screening: {
    heartConditionOrDoctorAdvisedActivityLimit: false,
    chestPainDuringActivity: false,
    chestPainAtRestLastMonth: false,
    dizzinessOrLossOfConsciousness: false,
    boneOrJointProblemWorsenedByActivity: false,
    prescribedBloodPressureOrHeartMedication: false,
    pregnantOrRecentlyPostpartum: false,
    otherReasonNotToExercise: false,
  },
  timezone: "Asia/Kolkata",
});

describe("deriveConstraints", () => {
  it("restricts to restorative when red flags exist", () => {
    const c = deriveConstraints({ ...baseProfile, screening: { ...baseProfile.screening, chestPainDuringActivity: true } });
    expect(c.maxIntensity).toBe("restorative");
    expect(c.allowedKinds).not.toContain("pushups");
    expect(c.allowedKinds).toContain("walk");
    expect(c.requiresClinicianReview).toBe(true);
  });
  it("beginner gets light intensity", () => {
    expect(deriveConstraints(baseProfile).maxIntensity).toBe("light");
  });
});

describe("enforceConstraints", () => {
  it("removes forbidden kinds and clamps reps", () => {
    const c = deriveConstraints(baseProfile);
    const draft: PlanDraft = {
      title: "t", summary: "s", goals: ["g"], contraindications: [], safetyNotes: [], rules: {},
      microTasks: [
        { kind: "pushups", label: "50 push-ups", instructions: "", reps: 50, intensity: "vigorous", weight: 1 },
        { kind: "walk", label: "walk", instructions: "", seconds: 30, intensity: "light", weight: 1 },
        { kind: "walk", label: "walk", instructions: "", seconds: 30, intensity: "light", weight: 1 },
        { kind: "walk", label: "walk", instructions: "", seconds: 30, intensity: "light", weight: 1 },
      ],
    };
    const { draft: out, changes } = enforceConstraints(draft, c);
    expect(out.microTasks[0]!.reps).toBe(15);
    expect(out.microTasks[0]!.intensity).toBe("light");
    expect(changes.length).toBe(2);
  });
});

describe("generatePlan with mocked provider chain", () => {
  it("fails over from a broken provider to a working one and returns pending_review", async () => {
    const good: PlanDraft = {
      title: "Desk starter", summary: "Light plan", goals: ["move hourly"],
      contraindications: ["stop if dizzy"], safetyNotes: ["all bodyweight"], rules: { cooldownMinutes: 20 },
      microTasks: [
        { kind: "pushups", label: "5 push-ups", instructions: "knees ok", reps: 5, intensity: "light", weight: 2 },
        { kind: "squats", label: "10 squats", instructions: "", reps: 10, intensity: "light", weight: 2 },
        { kind: "desk_stretch", label: "stretch", instructions: "", seconds: 45, intensity: "restorative", weight: 1 },
        { kind: "walk", label: "walk", instructions: "", seconds: 120, intensity: "light", weight: 1 },
      ],
    };
    let calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("openrouter")) return new Response("boom", { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(good) + "\n```" } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const llm = new LlmClient({
      providers: [
        { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "x", model: "m" },
        { name: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "y", model: "g" },
      ],
      fetchImpl,
    });
    const res = await generatePlan(llm, baseProfile);
    expect(calls.length).toBe(2);
    expect(res.provider).toBe("gemini");
    expect(res.plan.status).toBe("pending_review");
    expect(res.plan.microTasks.every((t) => t.id)).toBe(true);
    expect(res.plan.rules.cooldownMinutes).toBe(20);
  });
});
