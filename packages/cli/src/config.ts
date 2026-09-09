/** ~/.fitgate/config.json — LocalConfig with zod validation and atomic writes. */
import { LocalConfig } from "@fitgate/shared";
import { files } from "./paths.js";
import { readJsonFile, writeJsonAtomic } from "./fsutil.js";

export function loadConfig(): LocalConfig {
  let raw: unknown;
  try {
    raw = readJsonFile(files.config());
  } catch {
    raw = undefined;
  }
  const parsed = LocalConfig.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // Salvage what we can: parse field by field against defaults.
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaults = LocalConfig.parse({});
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(LocalConfig.shape) as (keyof LocalConfig)[]) {
    if (key in obj) {
      const field = LocalConfig.shape[key];
      const r = field.safeParse(obj[key]);
      if (r.success) merged[key] = r.data;
    }
  }
  return LocalConfig.parse(merged);
}

export function saveConfig(config: LocalConfig): void {
  writeJsonAtomic(files.config(), LocalConfig.parse(config));
}

export function updateConfig(patch: Partial<LocalConfig>): LocalConfig {
  const next = LocalConfig.parse({ ...loadConfig(), ...patch });
  saveConfig(next);
  return next;
}

export function isPaired(config: LocalConfig): boolean {
  return Boolean(config.serverUrl && config.deviceToken);
}
