import { TFile, normalizePath, type App } from "obsidian";
import { dirname } from "../../core/util/path.js";
import type { DirEntry, Storage } from "../../core/host/storage.js";

// @lat: [[obsidian#Plugin shell#Storage on a vault]]
/**
 * {@link Storage} over an Obsidian vault.
 *
 * Reads and writes go through `app.vault.adapter` — the one file API present on
 * desktop and mobile, and the only one that reaches folders Obsidian does not
 * index (a dot-folder review folder). A file Obsidian *has* indexed is modified
 * through the vault instead, so the metadata cache, other plugins and Sync all
 * see the change as an ordinary edit.
 *
 * Ids are vault-relative; there is no Node here, and no absolute path.
 */
export class ObsidianStorage implements Storage {
  constructor(private readonly app: App) {}

  private get adapter() {
    return this.app.vault.adapter;
  }

  private indexed(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  async readText(path: string): Promise<string> {
    const p = normalizePath(path);
    const f = this.indexed(p);
    return f ? this.app.vault.read(f) : this.adapter.read(p);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const f = this.indexed(p);
    const buf = f ? await this.app.vault.readBinary(f) : await this.adapter.readBinary(p);
    return new Uint8Array(buf);
  }

  async writeText(path: string, text: string): Promise<void> {
    const p = normalizePath(path);
    const f = this.indexed(p);
    if (f) return this.app.vault.modify(f, text);
    await this.mkdirp(dirname(p));
    await this.adapter.write(p, text);
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const p = normalizePath(path);
    // The adapter wants an ArrayBuffer of exactly the bytes, not the backing store.
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const f = this.indexed(p);
    if (f) return this.app.vault.modifyBinary(f, buf);
    await this.mkdirp(dirname(p));
    await this.adapter.writeBinary(p, buf);
  }

  async exists(path: string): Promise<boolean> {
    try {
      return await this.adapter.exists(normalizePath(path));
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    if (await this.adapter.exists(p)) await this.adapter.remove(p);
  }

  async copy(from: string, to: string): Promise<void> {
    await this.writeBytes(to, await this.readBytes(from));
  }

  async list(dir: string): Promise<DirEntry[]> {
    try {
      const d = normalizePath(dir);
      if (!(await this.adapter.exists(d))) return [];
      const { files, folders } = await this.adapter.list(d);
      const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
      return [
        ...folders.map((p) => ({ name: name(p), isDirectory: true })),
        ...files.map((p) => ({ name: name(p), isDirectory: false })),
      ];
    } catch {
      return [];
    }
  }

  /**
   * Create `dir` and its parents one segment at a time: a recursive `mkdir` is
   * not guaranteed by every adapter (mobile's differs from desktop's).
   */
  private async mkdirp(dir: string): Promise<void> {
    if (!dir || dir === "." || dir === "/") return;
    let acc = "";
    for (const seg of normalizePath(dir).split("/")) {
      if (!seg) continue;
      acc = acc ? `${acc}/${seg}` : seg;
      if (!(await this.adapter.exists(acc))) await this.adapter.mkdir(acc);
    }
  }
}
