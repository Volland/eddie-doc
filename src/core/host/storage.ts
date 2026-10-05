/**
 * The core's only way to touch files.
 *
 * Every **Host** brings its own: VS Code and the CLI back it with `fs.promises`,
 * Obsidian with `app.vault.adapter` (the one API that exists on mobile). All of
 * it is async because the vault adapter is — see ADR 0001. Paths are `/`
 * separated strings, workspace-relative or absolute (see `util/path.ts`); the
 * implementation decides what they point at.
 *
 * Methods reject on failure, except where noted. `exists`/`list` never reject:
 * a missing folder is an ordinary answer, not an error.
 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

// @lat: [[architecture#Ports#Storage]]
export interface Storage {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Writes `text` as UTF-8, creating parent folders. Replaces any existing file. */
  writeText(path: string, text: string): Promise<void>;
  /** Writes `bytes`, creating parent folders. Replaces any existing file. */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** True for a file or a folder. Never rejects. */
  exists(path: string): Promise<boolean>;
  /** Deletes a file. Resolves quietly when it is already gone. */
  remove(path: string): Promise<void>;
  /** Copies a file, creating the target's parent folders. */
  copy(from: string, to: string): Promise<void>;
  /** Entries directly inside `dir`; `[]` when it does not exist. Never rejects. */
  list(dir: string): Promise<DirEntry[]>;
}
