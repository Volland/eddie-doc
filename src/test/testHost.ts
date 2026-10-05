import { NodeStorage } from "../hosts/node/nodeStorage.js";
import {
  DEFAULT_SETTINGS,
  type HostServices,
  type Settings,
} from "../core/host/services.js";
import type { Storage } from "../core/host/storage.js";

/**
 * A {@link HostServices} for tests: real files by default (the store's paths are
 * what is under test), messages captured instead of shown, settings overridable.
 */
export function testHost(
  opts: { storage?: Storage; settings?: Partial<Settings>; semantic?: boolean } = {}
) {
  const shown = { info: [] as string[], warn: [] as string[] };
  const overrides: Partial<Settings> = { ...opts.settings };
  const host: HostServices = {
    storage: opts.storage ?? new NodeStorage(),
    notify: {
      info: (m) => void shown.info.push(m),
      warn: (m) => void shown.warn.push(m),
    },
    settings: () => ({ ...DEFAULT_SETTINGS, ...overrides }),
    authorName: () => "Author",
    capabilities: { semanticFallback: opts.semantic ?? true, externalFiles: true },
  };
  return { host, shown, overrides };
}
