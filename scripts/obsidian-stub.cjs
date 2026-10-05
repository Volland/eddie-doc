/**
 * The slice of `obsidian` that host modules touch at import time, for unit tests.
 *
 * Only what is needed to *load* a module is here (a state field the editor
 * extension reads). Anything that would run Obsidian's UI is out of scope: those
 * paths are covered by scripts/smoke-obsidian.cjs against the built bundle, and by
 * the manual checklist in docs/obsidian-qa.md.
 */
const { StateField } = require("@codemirror/state");

module.exports = {
  editorInfoField: StateField.define({
    create: () => ({ file: null }),
    update: (v) => v,
  }),
};
