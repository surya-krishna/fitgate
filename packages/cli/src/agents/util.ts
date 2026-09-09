/** Helpers shared by adapters: JSON merge, marker handling, stdin field extraction. */
import fs from "node:fs";
import path from "node:path";
import { readJsonObject, writeJsonAtomic, fileExists, onPath } from "../fsutil.js";
import type { ParsedStdin } from "./types.js";

export const MARKER = "_fitgate";

export type JsonObject = Record<string, unknown>;

export function isObj(v: unknown): v is JsonObject {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function isOurs(entry: unknown): boolean {
  return isObj(entry) && entry[MARKER] === true;
}

/** Remove entries we own from an array, then append the new one. */
export function upsertMarked(arr: unknown[], entry: JsonObject): unknown[] {
  return [...arr.filter((e) => !isOurs(e)), { ...entry, [MARKER]: true }];
}

export function removeMarked(arr: unknown[]): unknown[] {
  return arr.filter((e) => !isOurs(e));
}

export function hasMarked(arr: unknown[]): boolean {
  return arr.some(isOurs);
}

/** Read-modify-write a JSON object file. `mutate` receives the parsed object (or `{}`) and returns the object to write. */
export function editJsonFile(file: string, mutate: (obj: JsonObject) => JsonObject | void): void {
  const obj = readJsonObject(file);
  const next = mutate(obj) ?? obj;
  writeJsonAtomic(file, next);
}

export function readJsonSafe(file: string): JsonObject {
  try {
    return readJsonObject(file);
  } catch {
    return {};
  }
}

/** Nested object at obj[key] (created when missing). */
export function ensureObj(obj: JsonObject, key: string): JsonObject {
  const v = obj[key];
  if (isObj(v)) return v;
  const o: JsonObject = {};
  obj[key] = o;
  return o;
}

/** Delete `key` when it is an empty object/array (keeps configs tidy after uninstall). */
export function pruneEmpty(obj: JsonObject, key: string): void {
  const v = obj[key];
  if ((Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0)) delete obj[key];
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function detectByDirOrBin(dirs: string[], bins: string[]): boolean {
  return dirs.some(dirExists) || bins.some(onPath) || dirs.some(fileExists);
}

export function homePath(home: string, ...segments: string[]): string {
  return path.join(home, ...segments);
}

// ---- stdin extraction ------------------------------------------------------

const SUMMARY_KEYS = ["description", "command", "command_line", "cmd", "file_path", "filePath", "path", "url", "query", "pattern", "notebook_path"];

function firstString(obj: JsonObject, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function oneLine(s: string, max = 200): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** Best-effort one-line summary from a tool input object (never the full payload). */
export function summarizeInput(input: unknown): string | undefined {
  if (typeof input === "string") return oneLine(input);
  if (!isObj(input)) return undefined;
  const s = firstString(input, SUMMARY_KEYS);
  if (s) return oneLine(s);
  const keys = Object.keys(input);
  return keys.length ? oneLine(keys.join(", "), 80) : undefined;
}

/** Generic parser for Claude-Code-shaped stdin (`tool_name`, `tool_input`, `session_id`). */
export function parseClaudeShaped(json: unknown): ParsedStdin {
  if (!isObj(json)) return {};
  const tool = firstString(json, ["tool_name", "toolName", "tool"]);
  const input = json.tool_input ?? json.toolInput ?? json.input ?? json.args ?? json.arguments ?? json.parameters;
  const sessionId = firstString(json, ["session_id", "sessionId", "conversation_id", "conversationId"]);
  return {
    tool: tool ? oneLine(tool, 120) : undefined,
    summary: summarizeInput(input),
    sessionId,
  };
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
