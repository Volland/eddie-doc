import * as assert from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, str, all, has, UsageError } from "../hosts/cli/args.js";
import { findWorkspaceRoot, loadSettings, stripJsonc } from "../hosts/cli/config.js";
import { runCli } from "../hosts/cli/run.js";
import { COMMANDS } from "../hosts/cli/commands.js";
import type { Io } from "../hosts/cli/workspace.js";
import { ReviewStore } from "../core/model/store.js";
import { testHost } from "./testHost.js";

const SAMPLE = path.join(__dirname, "..", "..", "sample");

/** An Io that records what a command printed, answering prompts from a script. */
function captureIo(answers: string[] = [], interactive = false) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    out: (l = "") => void stdout.push(l),
    note: (l = "") => void stderr.push(l),
    ask: async () => answers.shift() ?? "",
    interactive,
    readStdin: async () => "from stdin",
  };
  return { io, stdout, stderr, text: () => stdout.join("\n") };
}

/** A throwaway workspace holding the sample chapter, marked as a git root. */
function sampleWorkspace(): { root: string; adoc: string; pdf: string; clean: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "eddie-cli-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, "book"));
  for (const f of ["chapter-01.adoc", "chapter-01.annotated.pdf", "chapter-01.pdf"]) {
    copyFileSync(path.join(SAMPLE, f), path.join(root, "book", f));
  }
  return {
    root,
    adoc: path.join(root, "book/chapter-01.adoc"),
    pdf: path.join(root, "book/chapter-01.annotated.pdf"),
    clean: path.join(root, "book/chapter-01.pdf"),
  };
}

describe("CLI", () => {
  // @lat: [[tests#CLI#Argument parsing]]
  describe("argument parsing", () => {
    const spec = { values: ["mapping", "set"], aliases: { m: "mapping" } };

    it("separates positionals, value flags, booleans and repeated flags", () => {
      const a = parseArgs(["doc.adoc", "-m", "acme", "--json", "--set", "a=1", "--set=b=2", "3"], spec);
      assert.deepStrictEqual(a.positional, ["doc.adoc", "3"]);
      assert.strictEqual(str(a, "mapping"), "acme");
      assert.deepStrictEqual(all(a, "set"), ["a=1", "b=2"]);
      assert.ok(has(a, "json"));
    });

    it("treats a lone dash, negative numbers and everything after -- as positional", () => {
      const a = parseArgs(["-", "-3", "--", "--not-a-flag"], spec);
      assert.deepStrictEqual(a.positional, ["-", "-3", "--not-a-flag"]);
    });

    it("rejects a value flag with no value", () => {
      assert.throws(() => parseArgs(["--mapping"], spec), UsageError);
    });
  });

  // @lat: [[tests#CLI#Settings like the editor]]
  describe("settings", () => {
    it("reads JSONC: comments and trailing commas, but not inside strings", () => {
      const v = JSON.parse(stripJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }'));
      assert.deepStrictEqual(v, { a: "http://x", b: [1, 2] });
    });

    it("layers defaults, .vscode/settings.json, .eddie.json, env and flags", () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "eddie-cfg-"));
      try {
        mkdirSync(path.join(root, ".vscode"));
        writeFileSync(
          path.join(root, ".vscode/settings.json"),
          '{\n  // review files\n  "eddieDoc.reviewFolder": "reviews",\n  "eddieDoc.matchThreshold": 0.4,\n  "editor.tabSize": 2,\n}'
        );
        writeFileSync(path.join(root, ".eddie.json"), '{ "match-threshold": 0.45, "autoAnchor": false }');
        const loaded = loadSettings(root, [["highConfidence", "0.9"]], {
          EDDIE_DOC_AUTHOR_NAME: "VP",
          EDDIE_DOC_AUTO_ANCHOR: "true",
        });
        assert.strictEqual(loaded.settings.reviewFolder, "reviews");
        assert.strictEqual(loaded.source.reviewFolder, "vscode");
        assert.strictEqual(loaded.settings.matchThreshold, 0.45);
        assert.strictEqual(loaded.settings.autoAnchor, true);
        assert.strictEqual(loaded.source.autoAnchor, "env");
        assert.strictEqual(loaded.settings.authorName, "VP");
        assert.strictEqual(loaded.settings.highConfidence, 0.9);
        assert.strictEqual(loaded.source.highConfidence, "flag");
        assert.strictEqual(findWorkspaceRoot(path.join(root, ".vscode")), root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("rejects an unknown --set key", () => {
      assert.throws(() => loadSettings(os.tmpdir(), [["nope", "1"]], {}), UsageError);
    });
  });

  // @lat: [[tests#CLI#Every command documented]]
  it("documents every command with a usage line and a group", async () => {
    for (const c of COMMANDS) {
      assert.ok(c.summary && c.usage, `${c.name} needs a summary and usage`);
      const cap = captureIo();
      assert.strictEqual(await runCli(["help", c.name], cap.io), 0);
      assert.match(cap.text(), new RegExp(`eddie ${c.name}`));
    }
    const top = captureIo();
    assert.strictEqual(await runCli(["--help"], top.io), 0);
    for (const c of COMMANDS) assert.ok(top.text().includes(c.name), `${c.name} missing from help`);
    assert.strictEqual(await runCli(["frobnicate"], captureIo().io), 2);
  });

  // @lat: [[tests#CLI#Review lifecycle from the terminal]]
  describe("review lifecycle", () => {
    let ws: ReturnType<typeof sampleWorkspace>;
    const run = (argv: string[], cap = captureIo()) =>
      runCli([...argv, "--root", ws.root, "--author", "Tester"], cap.io, { cwd: ws.root, env: {} }).then((code) => ({
        code,
        ...cap,
      }));

    before(() => {
      ws = sampleWorkspace();
    });
    after(() => rmSync(ws.root, { recursive: true, force: true }));

    it("maps a PDF into the review folder and anchors the source", async () => {
      const r = await run(["open", ws.adoc, ws.pdf, "--origin", "Acme", "--json"]);
      assert.strictEqual(r.code, 0, r.stderr.join("\n"));
      const m = JSON.parse(r.text());
      assert.strictEqual(m.ref, "rev-1/chapter-01");
      assert.strictEqual(m.origin, "Acme");
      assert.strictEqual(m.counts.total, 5);
      assert.ok(m.sidecar.includes(path.join(".eddie", "book", "chapter-01", "rev-1")));
      assert.ok(readFileSync(ws.adoc, "utf8").includes("// eddie:"), "markers written");
    });

    it("lists, resolves, replies and confirms by remark number", async () => {
      const listed = JSON.parse((await run(["list", ws.adoc, "--json"])).text());
      assert.strictEqual(listed.items.length, 5);
      assert.strictEqual(listed.items[0].number, 1);

      assert.strictEqual((await run(["resolve", ws.adoc, "#1", "2"])).code, 0);
      const reply = await run(["reply", ws.adoc, "3", "Diagram", "added"]);
      assert.strictEqual(reply.code, 0);
      const replyId = reply.text().trim();
      assert.match(replyId, /^r-/);
      assert.strictEqual((await run(["reply", ws.adoc, "3", "--edit", replyId, "Diagram added in fig 1.2"])).code, 0);
      assert.strictEqual((await run(["confirm", ws.adoc, "4"])).code, 0);

      const after = JSON.parse((await run(["list", ws.adoc, "--bucket", "resolved", "--json"])).text());
      assert.deepStrictEqual(after.items.map((i: { number: number }) => i.number), [1, 2]);
      const shown = JSON.parse((await run(["show", ws.adoc, "3", "--json"])).text());
      assert.strictEqual(shown.replies.length, 1);
      assert.strictEqual(shown.replies[0].author, "Tester");
      assert.strictEqual(shown.replies[0].body, "Diagram added in fig 1.2");
    });

    it("writes a sidecar the editor's store reads back unchanged", async () => {
      const { host } = testHost();
      const store = new ReviewStore(host);
      store.configure({ workspaceRoot: ws.root, reviewFolder: ".eddie" });
      const s = await store.tryLoadSidecar(ws.adoc);
      assert.ok(s);
      assert.deepStrictEqual(s.items.filter((i) => i.resolved).map((i) => i.number), [1, 2]);
      assert.strictEqual(s.items.find((i) => i.number === 3)?.replies?.[0].body, "Diagram added in fig 1.2");
      assert.strictEqual(s.mapping.origin, "Acme");
    });

    it("relinks by hand and re-maps one item back to automatic", async () => {
      assert.strictEqual((await run(["relink", ws.adoc, "5", "3"])).code, 0);
      let it = JSON.parse((await run(["show", ws.adoc, "5", "--json"])).text());
      assert.strictEqual(it.line, 3);
      assert.strictEqual(it.method, "manual");
      assert.strictEqual((await run(["relink", ws.adoc, "5", "99999"])).code, 2);
      await run(["remap-item", ws.adoc, "5"]);
      it = JSON.parse((await run(["show", ws.adoc, "5", "--json"])).text());
      assert.notStrictEqual(it.method, "manual");
    });

    it("plans confident edits, and refuses to write the source without --yes", async () => {
      const before = readFileSync(ws.adoc, "utf8");
      const plan = JSON.parse((await run(["apply", ws.adoc, "--dry-run", "--json"])).text());
      assert.ok(Array.isArray(plan));
      if (plan.length) {
        const refused = await run(["apply", ws.adoc]);
        assert.strictEqual(refused.code, 1);
        assert.match(refused.stderr.join("\n"), /--yes/);
        assert.strictEqual(readFileSync(ws.adoc, "utf8"), before);
        assert.strictEqual((await run(["apply", ws.adoc, "--yes"])).code, 0);
        assert.notStrictEqual(readFileSync(ws.adoc, "utf8"), before);
      }
    });

    it("exports the report and stamps a fresh render into the round folder", async () => {
      const rep = await run(["report", ws.adoc]);
      assert.strictEqual(rep.code, 0);
      const reportPath = path.resolve(ws.root, rep.text().trim());
      assert.ok(existsSync(reportPath) || existsSync(rep.text().trim()));
      const st = await run(["stamp", ws.clean, ws.adoc]);
      assert.strictEqual(st.code, 0, st.stderr.join("\n"));
      assert.match(st.text(), /rev-1[\\/]pdf[\\/]chapter-01\.reviewed\.pdf$/);
    });

    it("starts a new round that carries state forward, then lists both", async () => {
      const r = await run(["open", ws.adoc, ws.pdf, "--new-round", "--no-anchor", "--json"]);
      assert.strictEqual(r.code, 0, r.stderr.join("\n"));
      assert.strictEqual(JSON.parse(r.text()).round, 2);
      const rounds = JSON.parse((await run(["rounds", ws.adoc, "--json"])).text());
      assert.deepStrictEqual(rounds.map((m: { round: number }) => m.round), [1, 2]);
      const r1 = JSON.parse((await run(["list", ws.adoc, "--round", "1", "--json"])).text());
      assert.strictEqual(r1.mapping.round, 1);
      const everywhere = JSON.parse((await run(["rounds", "--json"])).text());
      assert.deepStrictEqual(everywhere.map((m: { ref: string }) => m.ref), ["rev-1/chapter-01", "rev-2/chapter-01"]);
      const status = JSON.parse((await run(["status", "--json"])).text());
      assert.strictEqual(status.documents.length, 1);
      assert.strictEqual(status.documents[0].rounds, 2);
    });

    it("deletes a mapping only when named and confirmed", async () => {
      assert.strictEqual((await run(["delete", ws.adoc])).code, 2);
      assert.strictEqual((await run(["delete", ws.adoc, "--round", "2"])).code, 1);
      assert.strictEqual((await run(["delete", ws.adoc, "--round", "2", "--yes"])).code, 0);
      const rounds = JSON.parse((await run(["rounds", ws.adoc, "--json"])).text());
      assert.strictEqual(rounds.length, 1);
    });

    it("fails clearly for a document with no review", async () => {
      const other = path.join(ws.root, "book/other.adoc");
      writeFileSync(other, "= Other\n");
      const r = await run(["list", other]);
      assert.strictEqual(r.code, 1);
      assert.match(r.stderr.join("\n"), /no review for other\.adoc/);
    });
  });
});
