import * as assert from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../hosts/cli/run.js";
import { loadSettings } from "../hosts/cli/config.js";
import { Workspace, type Io } from "../hosts/cli/workspace.js";
import { TuiApp, stripAnsi, type Key } from "../hosts/cli/tui/app.js";
import { ReviewStore } from "../core/model/store.js";
import { testHost } from "./testHost.js";

const SAMPLE = path.join(__dirname, "..", "..", "sample");

const io: Io = {
  out: () => undefined,
  note: () => undefined,
  ask: async () => "",
  interactive: false,
  readStdin: async () => "",
};

/** Keys as readline reports them. */
const K = {
  down: { name: "down" } as Key,
  up: { name: "up" } as Key,
  enter: { name: "return" } as Key,
  esc: { name: "escape" } as Key,
  clear: { name: "u", ctrl: true } as Key,
  ch: (c: string): Key => ({ name: c.toLowerCase(), sequence: c, shift: c !== c.toLowerCase() }),
};

async function type(app: TuiApp, text: string): Promise<void> {
  for (const c of text) await app.key(K.ch(c));
}

function frame(app: TuiApp, cols = 100, rows = 30): string {
  return app.render(cols, rows).map(stripAnsi).join("\n");
}

/** A fresh workspace with the sample chapter mapped once. */
async function mapped() {
  const root = mkdtempSync(path.join(os.tmpdir(), "eddie-tui-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, "book"));
  for (const f of ["chapter-01.adoc", "chapter-01.annotated.pdf"]) {
    copyFileSync(path.join(SAMPLE, f), path.join(root, "book", f));
  }
  const adoc = path.join(root, "book/chapter-01.adoc");
  const code = await runCli(["open", adoc, path.join(root, "book/chapter-01.annotated.pdf"), "--root", root, "--no-anchor"], io, {
    env: {},
  });
  assert.strictEqual(code, 0);
  const fresh = () => new Workspace({ root, loaded: loadSettings(root, [], {}), author: "Tester" }, io);
  const app = async (arg?: string) => {
    const a = new TuiApp(fresh(), { open: () => undefined });
    await a.start(arg);
    return a;
  };
  const reread = async () => {
    const { host } = testHost();
    const store = new ReviewStore(host);
    store.configure({ workspaceRoot: root, reviewFolder: ".eddie" });
    return (await store.tryLoadSidecar(adoc))!;
  };
  return { root, adoc, app, reread };
}

// @lat: [[tests#CLI#Terminal UI]]
describe("CLI terminal UI", () => {
  let ws: Awaited<ReturnType<typeof mapped>>;
  beforeEach(async () => {
    ws = await mapped();
  });
  afterEach(() => rmSync(ws.root, { recursive: true, force: true }));

  it("opens the only document and its only mapping, and fits the screen", async () => {
    const app = await ws.app();
    const f = frame(app, 80, 24);
    assert.match(f, /Revision 1 · chapter-01/);
    assert.match(f, /#1\s+OPEN\s+Highlight/);
    assert.match(f, /Strong framing — keep this\./, "detail pane shows the comment");
    const lines = app.render(80, 24).map(stripAnsi);
    assert.strictEqual(lines.length, 24);
    for (const l of lines) assert.ok(l.length <= 80, `too wide: ${l}`);
  });

  it("goes back to the mappings, and quits from the top", async () => {
    const app = await ws.app();
    await app.key(K.esc);
    assert.match(frame(app), /\* rev-1\/chapter-01/);
    assert.match(frame(app), /sidecar/);
    await app.key(K.enter);
    assert.match(frame(app), /#1\s+OPEN/);
    await app.key(K.ch("q"));
    assert.ok(app.done);
  });

  it("resolves, confirms and replies, and writes the sidecar", async () => {
    const app = await ws.app(ws.adoc);
    await app.key(K.ch("r"));
    assert.match(frame(app), /#1 resolved/);
    await app.key(K.ch("a"));
    await type(app, "Kept on purpose");
    assert.match(frame(app), /Reply to #\d+: Kept on purpose/);
    await app.key(K.enter);
    const s = await ws.reread();
    assert.ok(s.items.find((i) => i.number === 1)!.resolved);
    assert.ok(s.items.some((i) => i.replies?.[0]?.body === "Kept on purpose" && i.replies[0].author === "Tester"));
  });

  it("links an annotation to a typed line number", async () => {
    const app = await ws.app(ws.adoc);
    await app.key(K.ch("l"));
    await app.key(K.clear);
    await type(app, "3");
    await app.key(K.enter);
    assert.match(frame(app), /→ line 3/);
    const s = await ws.reread();
    assert.strictEqual(s.items.find((i) => i.number === 1)!.manualLine, 2);
  });

  it("filters by group and by text", async () => {
    const app = await ws.app(ws.adoc);
    await app.key(K.ch("r"));
    await app.key(K.ch("b"));
    assert.match(frame(app), /showing Open/);
    assert.doesNotMatch(frame(app), /DONE/);
    await app.key(K.ch("/"));
    await type(app, "diagram");
    await app.key(K.enter);
    const f = frame(app);
    assert.match(f, /#3\s+OPEN/);
    assert.doesNotMatch(f, /#2\s+OPEN/);
  });

  it("applies a strikeout's fix to the source after confirming", async () => {
    const app = await ws.app(ws.adoc);
    await app.key(K.ch("/"));
    await type(app, "too advanced");
    await app.key(K.enter);
    const before = readFileSync(ws.adoc, "utf8");
    await app.key(K.ch("f"));
    assert.match(frame(app), /Delete struck text/);
    await app.key(K.enter);
    assert.match(frame(app), /Apply/);
    assert.match(frame(app), /^- "/m, "shows the diff");
    assert.strictEqual(readFileSync(ws.adoc, "utf8"), before, "nothing written before confirming");
    await app.key(K.enter);
    assert.notStrictEqual(readFileSync(ws.adoc, "utf8"), before);
    const s = await ws.reread();
    assert.ok(s.items.find((i) => i.number === 2)!.resolved);
  });

  it("offers ranked lines to link from triage, and lists every key on ?", async () => {
    const app = await ws.app(ws.adoc);
    await app.key(K.ch("t"));
    assert.match(frame(app), /Link #1 to…/);
    assert.match(frame(app), /L\d+\s+\d\.\d\d/);
    await app.key(K.esc);
    await app.key(K.ch("?"));
    const f = frame(app, 100, 40);
    for (const k of ["resolve / reopen", "add a reply", "apply every confident edit", "export the mapping's report"]) {
      assert.ok(f.includes(k), `help lacks ${k}`);
    }
  });
});
