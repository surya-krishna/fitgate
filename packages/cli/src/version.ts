import fs from "node:fs";

// Replaced with a literal string by esbuild (--define) when bundled into a
// standalone SEA executable, which has no package.json on disk to read.
declare const __FITGATE_SEA_VERSION__: string | undefined;

let cached: string | null = null;

/** Version from package.json (works from both src/ via tsx and dist/). */
export function cliVersion(): string {
  if (cached) return cached;
  if (typeof __FITGATE_SEA_VERSION__ !== "undefined") {
    cached = __FITGATE_SEA_VERSION__;
    return cached;
  }
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    cached = String((JSON.parse(raw) as { version?: string }).version ?? "0.0.0");
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
