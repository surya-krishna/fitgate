# Roadmap

## v0.1 — MVP (this release)

* Hook-based interception for Claude Code, Cursor, Copilot CLI, Codex CLI, Gemini CLI, Windsurf, Augment, Kiro, Amp, Cline.
* MCP tool + rules snippet for everything else; experimental `fitgate wrap`.
* Local daemon with cooldown / daily cap / quiet hours / pause; gate web UI; OS notifications; fail-open everywhere.
* Optional pairing with a FitGate server (self-hosted or FitGate Cloud — separate repo) for personalised plans, clinician review, and dashboard.
* Workout completion is **self-reported** (Done / Skip).

## v0.2 — polish

* `fitgate` published to npm; Homebrew tap; winget manifest.
* VS Code / Cursor extension: status-bar item showing the open gate and a Done button (no browser tab).
* System tray app (Tauri) as an alternative to the browser page.
* Weekly email digest; plan progression suggestions (LLM proposes +10 % volume every 2 weeks → clinician one-click re-approve).
* i18n for gate UI (hi, te, ta, es, pt, de, ja first).

## v0.3 — measured completion (community connectors)

The `GateEvent.reported` field and a `Verifier` interface in the daemon exist so completion can come from somewhere other than a button:

* **Wear OS** companion app (accelerometer rep counting for push-ups/squats; heart-rate delta for walks).
* **Apple Watch** companion (HealthKit workout sessions).
* **Fitbit / Garmin / Whoop** via their web APIs (walk / step deltas).
* **Phone camera** rep counting via MediaPipe pose, fully on-device.
* **Smart scale / standing desk** integrations for posture tasks.

Verification stays optional and configurable per task kind; unverifiable tasks (hydrate, eye rest) remain self-reported.

## v0.4 — teams (tracked in the FitGate Cloud repo)

Org workspaces, leaderboards and challenges, SSO — these are server/dashboard features and live in that repo's roadmap, not here.

## Later / ideas

* Gate on other waits: CI pipelines, long builds, `docker pull`, model downloads.
* Standing-desk nudges; posture detection.

## Help wanted

Wearable connectors, agent adapters for tools not listed above, translations, and clinician feedback on the safety envelope in `packages/llm/src/plan.ts`. Look for issues labelled `good first issue` and `connector`.
