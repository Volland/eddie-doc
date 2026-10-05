import { TAbstractFile, TFile, normalizePath, type App } from "obsidian";
import { dirname } from "../../core/util/path.js";
import type { DirEntry, Storage } from "../../core/host/storage.js";

/** True when any segment starts with a dot: Obsidian does not index those folders. */
function isHidden(path: string): boolean {
  return path.split("/").some((s) => s.startsWith("."));
}

/** Obsidian's "already exists" errors, which mean the file is on disk but not indexed yet. */
function alreadyExists(e: unknown): boolean {
  return /already exists/i.test(String(e));
}

/**
 * {@link Storage} over an Obsidian vault.
 *
 * The Vault API is used wherever Obsidian indexes the path, so the metadata cache,
 * other plugins and Sync see an ordinary edit. The Adapter API is the fallback for what
 * the index cannot see: a folder whose name starts with a dot (never indexed), a file
 * Obsidian has not noticed yet (just synced in, or just written), and directory
 * listings, which must reflect the disk rather than a cache that can lag behind it.
 *
 * Ids are vault-relative; there is no Node here, and no absolute path.
 */
export class ObsidianStorage implements Storage {
  constructor(private readonly app: App) {}

  private get adapter() {
    return this.app.vault.adapter;
  }

  private entry(path: string): TAbstractFile | null {
    return this.app.vault.getAbstractFileByPath(path);
  }

  private indexed(path: string): TFile | null {
    const f = this.entry(path);
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
    if (f) {
      await this.app.vault.process(f, () => text);
      return;
    }
    await this.mkdirp(dirname(p));
    if (!isHidden(p)) {
      try {
        await this.app.vault.create(p, text);
        return;
      } catch (e) {
        if (!alreadyExists(e)) throw e;
        // On disk but not indexed yet (a sync just delivered it): overwrite it directly.
      }
    }
    await this.adapter.write(p, text);
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const p = normalizePath(path);
    // The Vault API wants an ArrayBuffer of exactly the bytes, not the backing store.
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const f = this.indexed(p);
    if (f) {
      await this.app.vault.modifyBinary(f, buf);
      return;
    }
    await this.mkdirp(dirname(p));
    if (!isHidden(p)) {
      try {
        await this.app.vault.createBinary(p, buf);
        return;
      } catch (e) {
        if (!alreadyExists(e)) throw e;
      }
    }
    await this.adapter.writeBinary(p, buf);
  }

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    if (this.entry(p)) return true;
    try {
      return await this.adapter.exists(p);
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    const f = this.indexed(p);
    // Through the file manager, so the user's "deleted files" preference (system
    // trash, Obsidian's .trash, or permanent) decides what happens to it.
    if (f) await this.app.fileManager.trashFile(f);
    else if (await this.adapter.exists(p)) await this.adapter.remove(p);
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
   * Create `dir` and its parents one segment at a time: a recursive mkdir is not
   * guaranteed by every adapter (mobile's differs from desktop's). A folder Obsidian
   * indexes is made through the Vault so it appears at once; a dot-folder, which it
   * never indexes, through the Adapter.
   */
  private async mkdirp(dir: string): Promise<void> {
    if (!dir || dir === "." || dir === "/") return;
    let acc = "";
    for (const seg of normalizePath(dir).split("/")) {
      if (!seg) continue;
      acc = acc ? `${acc}/${seg}` : seg;
      if (this.entry(acc)) continue;
      if (isHidden(acc)) {
        if (!(await this.adapter.exists(acc))) await this.adapter.mkdir(acc);
        continue;
      }
      try {
        await this.app.vault.createFolder(acc);
      } catch (e) {
        if (!alreadyExists(e)) throw e;
      }
    }
  }
}
