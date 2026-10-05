# Review saves are queued, not synchronous

`ReviewStore` changes memory immediately and queues the sidecar write; writes are coalesced per sidecar, serialized, and reachable through `await store.flush()`. Only the operations that read files (load, map, re-map, merge, migrate, delete) are `async`.

The alternative — making every mutator `async` and awaiting its write — would have pushed `await` through all ~2,600 lines of the VS Code extension and into every panel click, to protect a guarantee (the file is on disk when the call returns) that nothing in the UI needs. Queuing also turns a burst of edits into one write, which matters on a phone and on a synced vault. The price is that a test or a caller that reads the file straight after a mutation must `flush()` first, and that a crash between a change and its write loses that change; `deactivate` and plugin unload flush for that reason.

## Consequences

- Operations that must see the file on disk (merging deletes sidecars after the target is written; migrating moves them) flush first.
- A mapping deleted while a save is queued is dropped from the queue, so it is not resurrected.
- Not done: detecting that another device changed a sidecar between our read and our write. Two hosts editing one review at once can overwrite each other; the design for hash-checked replay is in `openspec/changes/archive/2026-10-05-obsidian-plugin`.
