/**
 * POSIX-style path helpers for the host-neutral core.
 *
 * `node:path` is unavailable on Obsidian mobile, and its behaviour changes with
 * the platform it runs on. The core therefore works in one dialect: `/`
 * separated strings. A path is either **workspace-relative** (`manuscript/ch1.adoc`,
 * what Obsidian hands out) or **absolute** (`/home/me/book/ch1.adoc`, or
 * `C:/Users/me/ch1.adoc` — a drive letter counts). Hosts convert at their
 * boundary; a VS Code host on Windows turns `\` into `/` on the way in and
 * back on the way out, which Node accepts everywhere.
 */

// @lat: [[architecture#Path identity]]
/** Replace backslashes with `/`. The one conversion every host applies on entry. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

/** Collapse `.`/`..`/duplicate slashes. A relative path stays relative. */
export function normalize(p: string): string {
  p = toPosix(p);
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(p)?.[0] ?? "";
  const rest = drive ? p.slice(drive.length) : p;
  const abs = rest.startsWith("/");
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs && !drive) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const body = out.join("/");
  if (drive) return drive + "/" + body;
  if (abs) return "/" + body;
  return body || ".";
}

/** Join segments and normalize. An absolute later segment restarts the path. */
export function join(...parts: string[]): string {
  let acc = "";
  for (const part of parts) {
    if (!part) continue;
    acc = isAbsolute(toPosix(part)) || !acc ? part : acc + "/" + part;
  }
  return normalize(acc || ".");
}

/** Resolve against `base` (a path or workspace-relative root) like `path.resolve`. */
export function resolve(base: string, ...parts: string[]): string {
  return join(base, ...parts);
}

export function dirname(p: string): string {
  p = normalize(p);
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  if (/^[A-Za-z]:$/.test(p.slice(0, i))) return p.slice(0, i) + "/";
  return p.slice(0, i);
}

export function basename(p: string, ext?: string): string {
  p = normalize(p);
  let b = p.slice(p.lastIndexOf("/") + 1);
  if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
  return b;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i);
}

/** `to` expressed relative to the directory `from`. Both must share a root kind. */
export function relative(from: string, to: string): string {
  const a = normalize(from).split("/").filter((s) => s && s !== ".");
  const b = normalize(to).split("/").filter((s) => s && s !== ".");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => "..");
  return [...up, ...b.slice(i)].join("/");
}
