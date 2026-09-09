/** Small filesystem helpers shared by config/state/adapters. */
import fs from "node:fs";
import path from "node:path";

/** Atomic write: write to a temp file in the same directory, then rename over the target. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

/** Read + parse a JSON file. Returns `undefined` when the file does not exist. Throws on malformed JSON. */
export function readJsonFile(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

/** Read a JSON object file, returning `{}` if absent. Throws if the file exists but is not a JSON object. */
export function readJsonObject(file: string): Record<string, unknown> {
  const v = readJsonFile(file);
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} is not a JSON object`);
  return v as Record<string, unknown>;
}

export function fileExists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function removeIfExists(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/** Is `bin` resolvable on PATH? Pure-JS check, no shelling out. */
export function onPath(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (fileExists(path.join(dir, bin + ext.toLowerCase())) || fileExists(path.join(dir, bin + ext))) return true;
    }
  }
  return false;
}
