import * as assert from "node:assert";
import {
  assignNumbers,
  initialsOf,
  maxNumber,
  numberLabel,
} from "../core/model/numbering.js";
import { itemRef, refPrefix } from "../core/model/refs.js";
import type { ReviewItem } from "../core/model/types.js";

function item(id: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    kind: "highlight",
    page: 1,
    comment: "",
    anchoredText: "",
    rect: [72, 700, 300, 712],
    match: null,
    resolved: false,
    ...over,
  };
}

describe("initialsOf", () => {
  it("takes the first letter of each name", () => {
    assert.strictEqual(initialsOf("Volodymyr Pavlyshyn"), "VP");
    assert.strictEqual(initialsOf("Jane Q. Doe"), "JQD");
  });

  it("reads the shapes PDF authors actually arrive in", () => {
    assert.strictEqual(initialsOf("jane.doe@acme.com"), "JD");
    assert.strictEqual(initialsOf("jane_doe"), "JD");
    assert.strictEqual(initialsOf("JaneDoe"), "JD");
    assert.strictEqual(initialsOf("Doe, Jane"), "JD");
    assert.strictEqual(initialsOf("  rachel  "), "R");
  });

  it("keeps non-Latin names", () => {
    assert.strictEqual(initialsOf("Володимир Павлишин"), "ВП");
  });

  it("caps long names at three letters", () => {
    assert.strictEqual(initialsOf("Anna Maria de la Cruz"), "AMD");
  });

  it("has nothing to say about an empty or name-less author", () => {
    assert.strictEqual(initialsOf(undefined), undefined);
    assert.strictEqual(initialsOf("   "), undefined);
    assert.strictEqual(initialsOf("1234"), undefined);
  });
});

describe("assignNumbers", () => {
  it("numbers in reading order: page, then top to bottom, then left to right", () => {
    const low = item("low", { page: 1, rect: [72, 100, 300, 112] });
    const high = item("high", { page: 1, rect: [72, 700, 300, 712] });
    const right = item("right", { page: 1, rect: [320, 700, 500, 712] });
    const next = item("next", { page: 2, rect: [72, 750, 300, 760] });
    // Deliberately out of order: the array is sorted by source line, not by page.
    assignNumbers([next, low, right, high]);
    assert.deepStrictEqual(
      [high, right, low, next].map((i) => i.number),
      [1, 2, 3, 4]
    );
  });

  it("never renumbers a remark that already has a number", () => {
    const a = item("a", { page: 3, number: 1 });
    const b = item("b", { page: 1 });
    assignNumbers([a, b]);
    assert.strictEqual(a.number, 1);
    assert.strictEqual(b.number, 2, "new marks continue after the highest number");
  });

  it("continues after the highest number, not after the count", () => {
    const items = [item("a", { number: 7 }), item("b", { page: 2 })];
    assignNumbers(items);
    assert.strictEqual(items[1].number, 8);
    assert.strictEqual(maxNumber(items), 8);
  });

  it("gives a number used twice to its first holder only", () => {
    const first = item("first", { page: 1, number: 4 });
    const second = item("second", { page: 2, number: 4 });
    assignNumbers([second, first]);
    assert.strictEqual(first.number, 4);
    assert.strictEqual(second.number, 5);
  });

  it("keeps each PDF's marks together, the mapping's own PDF first", () => {
    const added = item("pdf-2/a", { page: 1, pdfId: "pdf-2" });
    const own = item("b", { page: 9 });
    const later = item("pdf-10/c", { page: 1, pdfId: "pdf-10" });
    assignNumbers([later, added, own]);
    assert.deepStrictEqual([own.number, added.number, later.number], [1, 2, 3]);
  });

  it("takes initials from the PDF's author, else from whoever the mapping names", () => {
    const named = item("a", { author: "Rachel Green" });
    const anon = item("b", { page: 2 });
    assignNumbers([named, anon], () => "Acme Editorial");
    assert.strictEqual(named.initials, "RG");
    assert.strictEqual(anon.initials, "AE");
  });

  it("does not mistake a tool's placeholder author for a person", () => {
    const placeholder = item("a", { author: "Editor" });
    const unnamed = item("b", { author: "Editor", page: 2 });
    assignNumbers([placeholder], () => "Acme Editorial");
    assignNumbers([unnamed]);
    assert.strictEqual(placeholder.initials, "AE");
    assert.strictEqual(unnamed.initials, undefined, "no initials beats wrong ones");
  });

  it("fills initials in later, once someone is named, without renumbering", () => {
    const anon = item("a");
    assignNumbers([anon]);
    assert.strictEqual(anon.initials, undefined);
    assert.strictEqual(assignNumbers([anon], () => "Mo Rahimi"), true);
    assert.deepStrictEqual([anon.number, anon.initials], [1, "MR"]);
    assert.strictEqual(assignNumbers([anon], () => "Someone Else"), false);
    assert.strictEqual(anon.initials, "MR", "initials once given are kept");
  });
});

describe("item references", () => {
  it("leads with our number and initials", () => {
    assert.strictEqual(numberLabel(item("a", { number: 3, initials: "VP" })), "#3 VP");
    assert.strictEqual(numberLabel(item("a", { number: 3 })), "#3");
    assert.strictEqual(numberLabel(item("a")), undefined);
  });

  it("keeps the editor's own query number beside ours", () => {
    const it = item("a", { number: 3, initials: "VP", comment: "[12] Check this." });
    assert.strictEqual(itemRef(it), "#3 VP [12]");
    assert.strictEqual(refPrefix(it), "#3 VP [12] ");
  });

  it("falls back to the editor's number alone on an unnumbered item", () => {
    assert.strictEqual(itemRef(item("a", { comment: "[C7] Hmm." })), "[C7]");
    assert.strictEqual(refPrefix(item("a")), "");
  });
});
