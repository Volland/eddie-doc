import { dirname, normalize } from "../util/path.js";
import type { DirEntry, Storage } from "./storage.js";

/**
 * In-memory {@link Storage}: what the core's tests run against, and a stand-in
 * for any host that has not wired a real one yet. Folders are implied by the
 * files inside them, which is also how Obsidian's adapter behaves.
 */
export class MemoryStorage implements Storage {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();

  constructor(initial: Record<string, string | Uint8Array> = {}) {
    for (const [p, v] of Object.entries(initial)) {
      this.put(p, typeof v === "string" ? new TextEncoder().encode(v) : v);
    }
  }

  private put(path: string, bytes: Uint8Array): void {
    const p = normalize(path);
    this.files.set(p, bytes);
    for (let d = dirname(p); d !== "." && d !== "/" && !this.dirs.has(d); d = dirname(d)) {
      this.dirs.add(d);
    }
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const b = this.files.get(normalize(path));
    if (!b) throw new Error(`ENOENT: no such file, open '${path}'`);
    return new Uint8Array(b);
  }

  async writeText(path: string, text: string): Promise<void> {
    this.put(path, new TextEncoder().encode(text));
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.put(path, new Uint8Array(bytes));
  }

  async exists(path: string): Promise<boolean> {
    const p = normalize(path);
    return this.files.has(p) || this.dirs.has(p);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(normalize(path));
  }

  async copy(from: string, to: string): Promise<void> {
    this.put(to, await this.readBytes(from));
  }

  async list(dir: string): Promise<DirEntry[]> {
    const d = normalize(dir);
    const prefix = d === "." ? "" : d.replace(/\/$/, "") + "/";
    const seen = new Map<string, boolean>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  /** Test helper: every stored path. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
