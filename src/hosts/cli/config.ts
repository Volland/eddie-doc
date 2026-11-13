/**
 * Where the CLI's workspace is and what its settings are.
 *
 * The CLI must put files exactly where the VS Code extension would, or a review
 * started in one would be invisible to the other. So it reads the same
 * `eddieDoc.*` keys from the same `.vscode/settings.json`, and resolves the
 * review folder against the same root: the folder VS Code would have open.
 *
 * Precedence, lowest first: core defaults → `.vscode/settings.json` →
 * `.eddie.json` → `EDDIE_DOC_*` environment variables → command-line flags.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../../core/host/services.js";
import { UsageError } from "./args.js";

/** Files that mark a directory as a workspace root, strongest first. */
const ROOT_MARKERS = [".eddie.json", ".vscode", ".eddie", ".git"];

/**
 * The workspace root for `start`: the nearest ancestor holding a root marker,
 * else `start` itself. This is the folder VS Code would have open.
 */
export function findWorkspaceRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (ROOT_MARKERS.some((m) => existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

/** Where each setting's effective value came from, for `eddie config`. */
export type SettingSource = "default" | "vscode" | "eddie.json" | "env" | "flag";

export interface LoadedSettings {
  settings: Settings;
  source: Record<keyof Settings, SettingSource>;
  files: string[];
}

/**
 * Remove `//` and `/* *\/` comments and trailing commas from JSONC, leaving
 * strings untouched — VS Code's settings file is JSONC, not JSON.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Coerce a raw string to the type of the setting's default. */
export function coerceSetting(key: keyof Settings, raw: unknown): unknown {
  const def = DEFAULT_SETTINGS[key];
  if (typeof raw !== "string") return typeof raw === typeof def ? raw : undefined;
  if (typeof def === "boolean") {
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    throw new UsageError(`${key} must be true or false, got "${raw}"`);
  }
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new UsageError(`${key} must be a number, got "${raw}"`);
    return n;
  }
  return raw;
}

function isKey(k: string): k is keyof Settings {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k);
}

/** `REVIEW_FOLDER` / `review-folder` / `reviewFolder` → `reviewFolder`. */
export function settingKey(name: string): keyof Settings | undefined {
  const camel = name
    .replace(/^eddieDoc\./, "")
    .toLowerCase()
    .replace(/[-_]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).find(
    (k) => k.toLowerCase() === camel.toLowerCase()
  );
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const v: unknown = JSON.parse(stripJsonc(readFileSync(file, "utf8")));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch (e) {
    throw new UsageError(`cannot parse ${file}: ${(e as Error).message}`);
  }
}

/**
 * Effective settings for `root`. `overrides` are `key=value` pairs from the
 * command line, already split; they win over every file.
 */
export function loadSettings(
  root: string,
  overrides: Array<[string, string]> = [],
  env: Record<string, string | undefined> = process.env
): LoadedSettings {
  const settings = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  const source = {} as Record<keyof Settings, SettingSource>;
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) source[k] = "default";
  const files: string[] = [];

  const apply = (key: keyof Settings, raw: unknown, from: SettingSource) => {
    const v = coerceSetting(key, raw);
    if (v === undefined) return;
    settings[key] = v;
    source[key] = from;
  };

  const vscodeFile = path.join(root, ".vscode", "settings.json");
  const vs = readJson(vscodeFile);
  if (vs) {
    files.push(vscodeFile);
    for (const [k, v] of Object.entries(vs)) {
      if (!k.startsWith("eddieDoc.")) continue;
      const key = k.slice("eddieDoc.".length);
      if (isKey(key)) apply(key, v, "vscode");
    }
  }

  const ownFile = path.join(root, ".eddie.json");
  const own = readJson(ownFile);
  if (own) {
    files.push(ownFile);
    for (const [k, v] of Object.entries(own)) {
      const key = settingKey(k);
      if (key) apply(key, v, "eddie.json");
    }
  }

  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("EDDIE_DOC_") || v === undefined) continue;
    const key = settingKey(k.slice("EDDIE_DOC_".length));
    if (key) apply(key, v, "env");
  }

  for (const [k, v] of overrides) {
    const key = settingKey(k);
    if (!key) throw new UsageError(`unknown setting "${k}" (see: eddie config)`);
    apply(key, v, "flag");
  }

  return { settings: settings as unknown as Settings, source, files };
}

/** Split `key=value`; a usage error when there is no `=`. */
export function splitAssignment(s: string): [string, string] {
  const i = s.indexOf("=");
  if (i <= 0) throw new UsageError(`--set expects key=value, got "${s}"`);
  return [s.slice(0, i).trim(), s.slice(i + 1)];
}
