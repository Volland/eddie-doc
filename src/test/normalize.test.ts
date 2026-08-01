import * as assert from "node:assert";
import {
  normalizeText,
  tokenize,
  tokenizeSourceLine,
  isStructuralLine,
  commentLineFlags,
} from "../matching/normalize.js";

describe("normalize", () => {
  it("strips inline AsciiDoc markup but keeps prose words", () => {
    const n = normalizeText("An *entity* is a `node` with _meaning_.");
    assert.strictEqual(n, "an entity is a node with meaning");
  });

  it("keeps the visible label of a link/xref, drops the target", () => {
    assert.ok(
      tokenize("see xref:model.adoc[the data model] now").join(" ").includes(
        "the data model"
      )
    );
    assert.ok(
      !tokenize("see https://example.com/x[docs] here").join(" ").includes(
        "example"
      )
    );
  });

  it("preserves Unicode letters (Cyrillic)", () => {
    assert.strictEqual(normalizeText("*Граф* знань"), "граф знань");
  });

  it("recognises structural lines", () => {
    assert.ok(isStructuralLine(""));
    assert.ok(isStructuralLine("----"));
    assert.ok(isStructuralLine("===="));
    assert.ok(isStructuralLine("[source,ruby]"));
    assert.ok(isStructuralLine(":author: Jane"));
    assert.ok(isStructuralLine("// a comment"));
    assert.ok(isStructuralLine("include::chapter.adoc[]"));
    assert.ok(!isStructuralLine("A knowledge graph is a structure."));
  });

  it("flags line comments and whole //// blocks, including their prose", () => {
    const lines = [
      "Real prose.", // 0
      "// a line comment", // 1
      "////", // 2
      "Hidden prose inside a comment block.", // 3
      "////", // 4
      "More real prose.", // 5
    ];
    assert.deepStrictEqual(commentLineFlags(lines), [
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("treats an unterminated comment block as running to the end", () => {
    assert.deepStrictEqual(
      commentLineFlags(["ok", "////", "hidden", "also hidden"]),
      [false, true, true, true]
    );
  });

  it("removes prose-leading markers from source lines", () => {
    assert.deepStrictEqual(tokenizeSourceLine("== Introduction"), [
      "introduction",
    ]);
    assert.deepStrictEqual(tokenizeSourceLine("* a list item"), [
      "a",
      "list",
      "item",
    ]);
    assert.deepStrictEqual(tokenizeSourceLine("NOTE: be careful"), [
      "be",
      "careful",
    ]);
    assert.deepStrictEqual(tokenizeSourceLine("----"), []);
  });
});
