import { promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import type { DirEntry, Storage } from "../../core/host/storage.js";

/**
 * {@link Storage} over Node's filesystem. Paths are the absolute, `/`-separated
 * strings the core uses; Node accepts forward slashes on Windows, so no
 * conversion is needed on the way in.
 *
 * `root` resolves workspace-relative paths (the CLI's working directory, or a
 * VS Code workspace folder). Absolute paths pass through untouched.
 */
export class NodeStorage implements Storage {
  constructor(private readonly root: string = process.cwd()) {}

  private abs(p: string): string {
    return nodePath.isAbsolute(p) ? p : nodePath.resolve(this.root, p);
  }

  async readText(path: string): Promise<string> {
    return fsp.readFile(this.abs(path), "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(this.abs(path)));
  }

  async writeText(path: string, text: string): Promise<void> {
    const f = this.abs(path);
    await fsp.mkdir(nodePath.dirname(f), { recursive: true });
    await fsp.writeFile(f, text, "utf8");
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const f = this.abs(path);
    await fsp.mkdir(nodePath.dirname(f), { recursive: true });
    await fsp.writeFile(f, bytes);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await fsp.unlink(this.abs(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  async copy(from: string, to: string): Promise<void> {
    const dest = this.abs(to);
    await fsp.mkdir(nodePath.dirname(dest), { recursive: true });
    await fsp.copyFile(this.abs(from), dest);
  }

  async list(dir: string): Promise<DirEntry[]> {
    try {
      const entries = await fsp.readdir(this.abs(dir), { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  }
}
