import type { Storage } from "./storage.js";
import type { FetchLike } from "../matching/semantic.js";

/**
 * What the core asks of its **Host** besides files: telling the user something,
 * reading settings, and knowing who they are.
 *
 * `ReviewStore` used to call `vscode.window.show*Message`,
 * `vscode.workspace.getConfiguration` and `vscode.EventEmitter` directly. Those
 * three, and the author lookup that shelled out to `git`, are the whole of the
 * host surface the core needs.
 */

/** Everything configurable. Same keys and meaning as the `eddieDoc.*` settings. */
export interface Settings {
  reviewFolder: string;
  importPdfs: boolean;
  stampOutput: "reviewFolder" | "besidePdf";
  reportOutput: "reviewFolder" | "besideSource";
  matchThreshold: number;
  showResolved: boolean;
  autoAnchor: boolean;
  inlineMarkers: boolean;
  expandThreads: boolean;
  highConfidence: number;
  semanticFallback: boolean;
  ollamaUrl: string;
  embedModel: string;
  semanticThreshold: number;
  lexicalFallback: boolean;
  authorName: string;
  lexicalThreshold: number;
}

/** The defaults every host starts from; a host overrides what differs. */
export const DEFAULT_SETTINGS: Settings = {
  reviewFolder: ".eddie",
  importPdfs: false,
  stampOutput: "reviewFolder",
  reportOutput: "reviewFolder",
  matchThreshold: 0.5,
  showResolved: true,
  autoAnchor: true,
  inlineMarkers: true,
  expandThreads: false,
  highConfidence: 0.75,
  semanticFallback: false,
  ollamaUrl: "http://localhost:11434",
  embedModel: "embeddinggemma",
  semanticThreshold: 0.62,
  lexicalFallback: true,
  authorName: "",
  lexicalThreshold: 0.6,
};

/** A user-facing message. The host decides how loud it is. */
export interface Notifier {
  info(message: string): void;
  warn(message: string): void;
}

// @lat: [[architecture#Ports#Host services]]
/** Operations a host may not be able to perform. See {@link Capabilities}. */
export interface Capabilities {
  /** Reach a local embedding server. False on mobile: there is no localhost. */
  semanticFallback: boolean;
  /** Read or write files outside the workspace (a PDF in Downloads). */
  externalFiles: boolean;
}

// @lat: [[architecture#Ports#Host services]]
export interface HostServices {
  storage: Storage;
  notify: Notifier;
  /** Current settings. Read on every use: a settings change takes effect live. */
  settings(): Settings;
  /** Name stamped on replies; the host falls back however it can (git, a prompt). */
  authorName(): string;
  capabilities: Capabilities;
  /**
   * Transport for the semantic fallback's HTTP calls. Defaults to global
   * `fetch`; Obsidian supplies one built on `requestUrl` so CORS cannot block it.
   */
  fetch?: FetchLike;
}

/** A tiny typed event. Replaces `vscode.EventEmitter` inside the core. */
export class Emitter<T> {
  private listeners = new Set<(e: T) => void>();

  /** Subscribe; returns a function that unsubscribes. */
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* one bad listener must not stop the rest */
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
