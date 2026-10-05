import { Notice, Platform, requestUrl, type App } from "obsidian";
import type { FetchLike } from "../../core/matching/semantic.js";
import type { Capabilities, HostServices } from "../../core/host/services.js";
import type { ObsidianSettings } from "./pure/settingsMap.js";
import { ObsidianStorage } from "./storage.js";

// @lat: [[obsidian#Capabilities]]
/** What this device can do. Static per platform; probed further at runtime. */
export function detectCapabilities(): Capabilities {
  return {
    // Ollama listens on localhost, which a phone cannot reach.
    semanticFallback: Platform.isDesktopApp,
    // Mobile can read only what is inside the vault.
    externalFiles: false,
  };
}

/**
 * `fetch` over Obsidian's `requestUrl`. Plain `fetch` from a plugin is subject to
 * CORS, which a local Ollama server does not answer; `requestUrl` is not.
 */
const requestFetch: FetchLike = async (url, init) => {
  const res = await requestUrl({
    url,
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
    throw: false,
  });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    json: async () => res.json,
  };
};

/** The Obsidian {@link HostServices}. `settings` and `author` are read live. */
export function createObsidianHost(
  app: App,
  settings: () => ObsidianSettings,
  author: () => string
): HostServices {
  return {
    storage: new ObsidianStorage(app),
    notify: {
      info: (m) => void new Notice(m, 6000),
      warn: (m) => void new Notice(m, 10000),
    },
    settings,
    authorName: author,
    capabilities: detectCapabilities(),
    fetch: requestFetch,
  };
}
