This directory defines the high-level concepts, business logic, and architecture of this project using markdown. It is managed by [lat.md](https://www.npmjs.com/package/lat.md) — a tool that anchors source code to these definitions. Install the `lat` command with `npm i -g lat.md` and run `lat --help`.

- [[architecture]] — the host-neutral core, the ports a Host provides, and how the boundary is enforced
- [[review-pipeline]] — from an annotated PDF to placed, tracked review items and the outputs
- [[review-model]] — the review sidecar, rounds and mappings, numbering, layout and interop
- [[obsidian]] — the Obsidian plugin: panel, editor markup, `.adoc` ownership, PDF preview, mobile
- [[vscode]] — the VS Code extension and what it shares with Obsidian
- [[tests]] — test specifications, each tied to the test that checks it
