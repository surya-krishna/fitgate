# Contributing to FitGate

We built this because the dead time between "the agent needs approval" and "I clicked approve" adds up to a sedentary career. Fixing that for each other — one more agent adapter so someone else's tool is covered, one more safe exercise, one more bug caught before it ships — is the actual point of this project. Every contribution here reaches everyone who installs `fitgate`, free, forever — under the AGPL, at home and at work alike. That's the deal: this is a tribe of programmers keeping each other healthy, not a queue of anonymous PRs.

The best contributions right now are **agent adapters**, **wearable connectors**, **new micro-workouts**, and **translations**.

## Setup

```bash
pnpm install
pnpm build:packages
pnpm test
```

Node ≥ 20, pnpm 10. The CLI's end-to-end tests need `packages/cli/dist` — run `pnpm --filter fitgate build` first (or `pnpm build:packages`).

## Ground rules

1. **Fail open.** Nothing in `packages/cli` may block a user's work when FitGate itself is broken. Every new code path in `gate.ts`/the daemon needs a "what if this throws?" answer, and the answer is "pass".
2. **Safety rules are conservative by default.** Loosening anything in `packages/llm/src/plan.ts`'s constraints, or adding a new default micro-task, needs a clinician's rationale in the PR.
3. **Schemas first.** Cross-boundary shapes live in `packages/shared`. Change them there, bump `CONTRACT_VERSION` on breaking changes.
4. **Tests with fixtures.** Adapters ship with a real stdin sample under `packages/cli/test/fixtures/`.

## Adding an agent adapter

See "Contributing an adapter" in [docs/AGENT-INTEGRATIONS.md](docs/AGENT-INTEGRATIONS.md). Link the vendor's hook documentation in the PR — we only ship adapters built on documented interfaces.

## Adding a micro-workout

The built-in offline task pool is plain data, not code — `DEFAULT_MICRO_TASKS` in [packages/shared/src/index.ts](packages/shared/src/index.ts). This is the lowest-friction way to contribute if you're a physio, a trainer, or just someone with a good stretch to share: open a PR adding an entry (label, instructions, reps or seconds, intensity), or open an issue first if you're not sure it's safe for a default (conservative-by-default, ground rule 2).

## Adding a wearable connector

Connectors implement the `Verifier` idea in [docs/ROADMAP.md](docs/ROADMAP.md): given an open `Gate`, resolve it with `reported: {reps|seconds}` when the device observes the movement. Open an issue first so we can agree on the interface; the first two connectors will define it.

## Commit / PR style

Conventional commits (`feat(cli): …`, `fix(shared): …`, `docs: …`). Small PRs. CI must be green (`pnpm typecheck && pnpm test`).

## Licensing

FitGate is AGPL-3.0 ([LICENSE](LICENSE)), and everything you contribute ships to every user under that license — free, including commercial use.

We ask contributors to sign a [Contributor License Agreement](CLA.md). It's one comment on your first PR, and a bot handles it. **You keep the copyright in your work** — the CLA is a license grant, not an assignment.

Why we need one: we sell commercial licenses to organisations that can't take on the AGPL's copyleft, and that revenue is what funds this project. Selling a license for code means holding the right to license it that way, which we can only get from you. Without a CLA, every merged PR would be a piece of FitGate we couldn't include in that offering — and the funding model would quietly stop working. We'd rather be upfront about the trade than surprise anyone later.

Only contribute code you have the right to license this way: if your employer owns your output, get their sign-off first (the CLA has an entity path for this). Don't paste in code from a differently-licensed project.

## Recognition

Contributors are listed in the README — a tribe works better with names attached than an anonymous PR queue.

## Code of conduct

Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
