import * as vscode from "vscode";
import {
  DEFAULT_SETTINGS,
  type HostServices,
  type Settings,
} from "../../core/host/services.js";
import { NodeStorage } from "../node/nodeStorage.js";

/** Current `eddieDoc.*` settings, falling back to the core's defaults. */
export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("eddieDoc");
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    out[k] = cfg.get(k, (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]);
  }
  return out as unknown as Settings;
}

/**
 * The VS Code {@link HostServices}: Node files, `showInformationMessage` for
 * notices, the `eddieDoc.*` configuration for settings. `authorName` stays with
 * the extension because it falls back to `git config`.
 */
export function createVscodeHost(authorName: () => string): HostServices {
  return {
    storage: new NodeStorage(),
    notify: {
      info: (m) => void vscode.window.showInformationMessage(m),
      warn: (m) => void vscode.window.showWarningMessage(m),
    },
    settings: readSettings,
    authorName,
    capabilities: { semanticFallback: true, externalFiles: true },
    fetch: (url, init) => fetch(url, init),
  };
}
