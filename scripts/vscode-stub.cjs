/**
 * A `vscode` module for unit tests.
 *
 * `model/store.ts` is domain logic — which mapping belongs to which round, where
 * its sidecar goes, what state carries forward — but it reaches for `vscode` to
 * read settings and to tell the user things. Outside the extension host that
 * module does not exist, which would leave the store untestable.
 *
 * This stub provides only the surface the store touches, and records the
 * messages it would have shown so a test can assert on them. Mocha loads it via
 * `--require scripts/mocha-vscode.cjs`, which resolves `vscode` here.
 */
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const l of this.listeners) l(value);
  }
  dispose() {
    this.listeners = [];
  }
}

/** Messages the code under test tried to show, newest last. */
const shown = { info: [], warning: [], error: [] };

/** Settings a test wants `workspace.getConfiguration` to return. */
const settings = new Map();

const vscode = {
  EventEmitter,
  window: {
    showInformationMessage: (m) => {
      shown.info.push(m);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (m) => {
      shown.warning.push(m);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (m) => {
      shown.error.push(m);
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    }),
    workspaceFolders: undefined,
  },
  /** Test helpers, not part of the real API. */
  __test: {
    shown,
    settings,
    reset() {
      shown.info.length = 0;
      shown.warning.length = 0;
      shown.error.length = 0;
      settings.clear();
    },
  },
};

module.exports = vscode;
