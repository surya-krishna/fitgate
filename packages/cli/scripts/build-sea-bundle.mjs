#!/usr/bin/env node
/**
 * Bundles the compiled CLI (packages/cli/dist/index.js, plus its
 * @fitgate/shared and @fitgate/llm dependencies) into a single CommonJS
 * file with everything inlined. That single file is what Node's Single
 * Executable Application (SEA) feature turns into a standalone binary —
 * SEA can't resolve a multi-file ESM package tree at runtime, only one
 * self-contained script.
 *
 * Requires `pnpm build:packages` to have run first (needs packages/cli/dist).
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"));

const entry = path.join(cliRoot, "dist", "index.js");
if (!fs.existsSync(entry)) {
  console.error(`fitgate: ${entry} not found — run "pnpm build:packages" first.`);
  process.exit(1);
}

const outDir = path.join(cliRoot, "dist-sea");
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, "bundle.cjs");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  legalComments: "none",
  define: {
    __FITGATE_SEA_VERSION__: JSON.stringify(pkg.version),
  },
  // Everything must be inlined — a SEA binary has no node_modules on disk.
  external: [],
});

console.log(`fitgate: wrote ${path.relative(cliRoot, outfile)}`);
