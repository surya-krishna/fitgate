#!/usr/bin/env node
/**
 * Turns the SEA bundle (dist-sea/bundle.cjs, produced by
 * build-sea-bundle.mjs) into a standalone `fitgate` executable: no Node.js
 * install required on the machine that runs it.
 *
 * This must run on each target OS (Node's SEA injection embeds a real
 * platform-native Node binary — GitHub Actions' per-OS matrix runners are
 * how release-binaries.yml builds windows/macos/linux from one workflow).
 *
 * Usage: node scripts/build-sea-binary.mjs
 * Output: dist-sea/fitgate(.exe)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "postject";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "..");
const outDir = path.join(cliRoot, "dist-sea");
const bundlePath = path.join(outDir, "bundle.cjs");

if (!fs.existsSync(bundlePath)) {
  console.error("fitgate: dist-sea/bundle.cjs not found — run \"pnpm build:sea:bundle\" first.");
  process.exit(1);
}

const seaConfigPath = path.join(outDir, "sea-config.json");
const blobPath = path.join(outDir, "bundle.blob");
fs.writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: path.relative(outDir, bundlePath).split(path.sep).join("/"),
      output: path.relative(outDir, blobPath).split(path.sep).join("/"),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], {
  cwd: outDir,
  stdio: "inherit",
});

const exeName = process.platform === "win32" ? "fitgate.exe" : "fitgate";
const outExe = path.join(outDir, exeName);
fs.copyFileSync(process.execPath, outExe);
fs.chmodSync(outExe, 0o755);

if (process.platform === "darwin") {
  try {
    execFileSync("codesign", ["--remove-signature", outExe], { stdio: "inherit" });
  } catch {
    console.warn("fitgate: codesign --remove-signature failed or codesign not found — continuing.");
  }
}

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
await inject(outExe, "NODE_SEA_BLOB", fs.readFileSync(blobPath), {
  sentinelFuse: SENTINEL_FUSE,
  machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
});

if (process.platform === "darwin") {
  try {
    execFileSync("codesign", ["--sign", "-", outExe], { stdio: "inherit" });
  } catch {
    console.warn("fitgate: ad-hoc codesign failed or codesign not found — the binary may be blocked by Gatekeeper.");
  }
}

console.log(`fitgate: wrote ${path.relative(cliRoot, outExe)}`);
