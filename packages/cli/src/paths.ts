/**
 * Resolution of the FitGate home directory (~/.fitgate, or $FITGATE_HOME) and
 * the files inside it. Everything is a function so tests can point FITGATE_HOME
 * at a temp dir before the daemon starts.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function fitgateHome(): string {
  const env = process.env.FITGATE_HOME;
  if (env && env.trim()) return path.resolve(env);
  return path.join(os.homedir(), ".fitgate");
}

export function ensureHome(): string {
  const home = fitgateHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export const files = {
  config: () => path.join(fitgateHome(), "config.json"),
  plan: () => path.join(fitgateHome(), "plan.json"),
  state: () => path.join(fitgateHome(), "state.json"),
  events: () => path.join(fitgateHome(), "events.jsonl"),
  daemonLog: () => path.join(fitgateHome(), "daemon.log"),
  daemonPid: () => path.join(fitgateHome(), "daemon.pid"),
  gateLog: () => path.join(fitgateHome(), "gate.log"),
};

/** The user's real home directory (where agent configs live). Overridable for tests. */
export function userHome(): string {
  const env = process.env.FITGATE_USER_HOME;
  if (env && env.trim()) return path.resolve(env);
  return os.homedir();
}
