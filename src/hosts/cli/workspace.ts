/**
 * The CLI as a **Host**: Node files, notices on stderr, settings from the
 * workspace, and the lookups every command shares — which document, which
 * mapping of it, which annotation.
 *
 * Each invocation builds one {@link ReviewStore}, loads what it needs from the
 * sidecars on disk, mutates, and flushes before exiting. Nothing is kept between
 * runs: the sidecar is the state, exactly as it is for the editor hosts.
 */
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HostServices, Settings } from "../../core/host/services.js";
import { NodeStorage } from "../node/nodeStorage.js";
import { ReviewStore } from "../../core/model/store.js";
import { resolveSourcePath } from "../../core/model/format.js";
import { legacySourceCandidates } from "../../core/model/layout.js";
import type { ReviewItem, ReviewSession } from "../../core/model/types.js";
import { UsageError } from "./args.js";
import type { LoadedSettings } from "./config.js";

/** Where a command writes. Results to stdout, everything else to stderr. */
export interface Io {
  /** A result line — the only channel machine-readable output may use. */
  out(line?: string): void;
  /** A diagnostic or progress line, always stderr. */
  note(line?: string): void;
  /** Ask a question on the terminal; resolves to the trimmed answer. */
  ask(question: string): Promise<string>;
  /** True when a person is at the keyboard (stdin and stderr are TTYs). */
  interactive: boolean;
  /** Read all of stdin, for `-` arguments. */
  readStdin(): Promise<string>;
}

export interface WorkspaceOptions {
  root: string;
  loaded: LoadedSettings;
  /** `--author`: the name stamped on replies. */
  author?: string;
  quiet?: boolean;
}

/** Thrown for an expected failure: printed without a stack, exit code 1. */
export class CliError extends Error {}

export class Workspace {
  readonly store: ReviewStore;
  readonly storage = new NodeStorage();
  readonly host: HostServices;
  private cachedAuthor?: string;

  constructor(
    readonly opts: WorkspaceOptions,
    readonly io: Io
  ) {
    const settings = () => opts.loaded.settings;
    this.host = {
      storage: this.storage,
      notify: {
        info: (m) => void (opts.quiet ? undefined : io.note(m)),
        warn: (m) => io.note(`warning: ${m}`),
      },
      settings,
      authorName: () => this.authorName(),
      capabilities: { semanticFallback: true, externalFiles: true },
      fetch: (url, init) => fetch(url, init),
    };
    this.store = new ReviewStore(this.host);
    this.store.configure({
      workspaceRoot: opts.root,
      reviewFolder: settings().reviewFolder,
    });
    this.store.useEmbedCacheFile(
      path.join(
        process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
        "eddie-doc",
        "embed-cache.json"
      )
    );
  }

  get settings(): Settings {
    return this.opts.loaded.settings;
  }

  /** `--author`, else the setting, else `git config user.name`, else the login. */
  authorName(): string {
    if (this.opts.author?.trim()) return this.opts.author.trim();
    if (this.settings.authorName.trim()) return this.settings.authorName.trim();
    if (this.cachedAuthor !== undefined) return this.cachedAuthor;
    try {
      this.cachedAuthor = execFileSync("git", ["config", "user.name"], {
        encoding: "utf8",
        timeout: 2000,
        cwd: this.opts.root,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      this.cachedAuthor = "";
    }
    if (!this.cachedAuthor) {
      try {
        this.cachedAuthor = os.userInfo().username || "Author";
      } catch {
        this.cachedAuthor = "Author";
      }
    }
    return this.cachedAuthor;
  }

  /** Absolute path of a file argument, which is relative to the cwd. */
  abs(p: string): string {
    return path.resolve(p);
  }

  /**
   * Load every mapping of `adoc` and fail clearly when it has none, which is
   * what every per-document command needs before it can do anything.
   */
  async requireDoc(adocArg: string | undefined): Promise<string> {
    if (!adocArg) throw new UsageError("missing <source.adoc>");
    const adoc = this.abs(adocArg);
    try {
      await fsp.access(adoc);
    } catch {
      throw new CliError(`no such file: ${adocArg}`);
    }
    await this.store.tryLoadSidecar(adoc);
    if (!this.store.sessionsFor(adoc).length) {
      throw new CliError(
        `no review for ${path.basename(adoc)} — map one first: eddie open ${adocArg} <annotated.pdf>`
      );
    }
    return adoc;
  }

  /**
   * The mapping a command acts on, and make it the document's active one so the
   * store's per-document methods address it.
   *
   * `selector` accepts a mapping id (`acme-copyedit`), `rev-2/acme-copyedit`, a
   * label or origin, or a sidecar path. `round` narrows to one revision. Without
   * either, the newest mapping is used — the one the editor shows by default.
   */
  pickMapping(adoc: string, selector?: string, round?: number): ReviewSession {
    let pool = this.store.sessionsFor(adoc);
    if (round != null) {
      pool = pool.filter((s) => s.revision.ordinal === round);
      if (!pool.length) throw new CliError(`${path.basename(adoc)} has no round ${round}`);
    }
    let pick: ReviewSession | undefined;
    if (selector) {
      const want = selector.toLowerCase();
      const asPath = path.resolve(selector);
      const tests: Array<(s: ReviewSession) => boolean> = [
        (s) => path.resolve(s.sidecarPath) === asPath,
        (s) => `${s.revision.id}/${s.mapping.id}`.toLowerCase() === want,
        (s) => s.mapping.id.toLowerCase() === want,
        (s) => (s.mapping.label ?? "").toLowerCase() === want,
        (s) => (s.mapping.origin ?? "").toLowerCase() === want,
      ];
      for (const t of tests) {
        const hits = pool.filter(t);
        if (hits.length === 1) {
          pick = hits[0];
          break;
        }
        if (hits.length > 1) {
          // The same mapping id recurs every round; the newest is the one meant.
          pick = hits[hits.length - 1];
          break;
        }
      }
      if (!pick) {
        throw new CliError(
          `no mapping "${selector}" for ${path.basename(adoc)} — see: eddie rounds ${path.relative(
            process.cwd(),
            adoc
          )}`
        );
      }
    } else {
      pick = pool[pool.length - 1];
    }
    this.store.setActive(pick.sidecarPath);
    return pick;
  }

  /**
   * The annotation `ref` names in `session`: `#3` or `3` by number, else an id,
   * else a unique id prefix.
   */
  findItem(session: ReviewSession, ref: string | undefined): ReviewItem {
    if (!ref) throw new UsageError("missing <item> (a number like #3, or an id)");
    const m = /^#?(\d+)$/.exec(ref.trim());
    if (m) {
      const n = Number(m[1]);
      const hit = session.items.find((i) => i.number === n);
      if (hit) return hit;
    }
    const exact = session.items.find((i) => i.id === ref);
    if (exact) return exact;
    const prefixed = session.items.filter((i) => i.id.startsWith(ref));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) throw new CliError(`"${ref}" matches ${prefixed.length} annotations; give more of the id`);
    throw new CliError(`no annotation "${ref}" in this mapping — see: eddie list`);
  }

  /**
   * Load every sidecar under the workspace, for commands that span documents
   * (`status`, `migrate`). Mirrors the editor's workspace scan, including the
   * pre-v2 sidecars that name their source only by their own file name.
   */
  async loadAll(): Promise<void> {
    for (const file of await findSidecars(this.opts.root)) {
      if (this.store.getBySidecar(file)) continue;
      let adoc: string | undefined;
      try {
        adoc = resolveSourcePath(await fsp.readFile(file, "utf8"), file);
      } catch {
        continue;
      }
      if (!adoc || !(await this.storage.exists(adoc))) {
        adoc = undefined;
        for (const c of legacySourceCandidates(file)) {
          if (/\.(adoc|asciidoc)$/i.test(c) && (await this.storage.exists(c))) {
            adoc = c;
            break;
          }
        }
      }
      if (adoc) await this.store.loadSidecarFile(file, adoc);
    }
  }

  /** Path for display: relative to the cwd when that is shorter. */
  show(p: string): string {
    const rel = path.relative(process.cwd(), p);
    return rel && !rel.startsWith("..") && rel.length < p.length ? rel : p;
  }
}

/** Every `*.review.json` under `root`, skipping dependency and VCS folders. */
export async function findSidecars(root: string): Promise<string[]> {
  const SKIP = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "out"]);
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(full, depth + 1);
      } else if (/\.review\.json$/i.test(e.name)) {
        found.push(full);
      }
    }
  };
  await walk(root, 0);
  return found.sort();
}
