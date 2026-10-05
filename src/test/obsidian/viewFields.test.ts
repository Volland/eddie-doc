import * as assert from "node:assert";
import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * A field declared on a subclass of Obsidian's View replaces the base class's member
 * of the same name. `titleEl` did exactly that in the PDF preview view: Obsidian then
 * failed to open the view ("Cannot read properties of undefined (reading 'setText')").
 * TypeScript did not warn, because Obsidian's typings do not declare `titleEl` at all,
 * and no unit test of ours could see it; only a real Obsidian did.
 *
 * So the members to avoid come from two places: Obsidian's typings, and a list
 * observed on a live view instance (below).
 */

/**
 * The own properties Obsidian's constructor puts on every view instance, read from a
 * running Obsidian 1.8.4 (and still true on 1.13.7, where the same checks pass).
 * Undocumented; extend it if a newer Obsidian adds one.
 */
const RUNTIME_INSTANCE_MEMBERS = [
  "_loaded", "_events", "_children", "icon", "navigation", "app", "leaf", "containerEl",
  "canDropAnywhere", "headerEl", "contentEl", "backButtonEl", "forwardButtonEl",
  "titleParentEl", "titleEl", "titleContainerEl", "actionsEl", "moreOptionsButtonEl",
];

/** Methods a view is *meant* to override; every other base method name is off limits. */
const INTENDED_OVERRIDES = new Set([
  "getViewType", "getDisplayText", "getIcon", "onOpen", "onClose", "onResize",
  "getState", "setState", "getEphemeralState", "setEphemeralState", "onPaneMenu",
]);

const root = nodePath.resolve(".");
const dts = fs.readFileSync(nodePath.join(root, "node_modules/obsidian/obsidian.d.ts"), "utf8");

function members(cls: string): string[] {
  const m = new RegExp(`export (?:abstract )?class ${cls}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(dts);
  assert.ok(m, `${cls} not found in obsidian.d.ts`);
  return [...m[1].matchAll(/^\s{4}(?:abstract |readonly |static )*(\w+)\s*[?(:<]/gm)].map((x) => x[1]);
}

const dir = nodePath.join(root, "src/hosts/obsidian/ui");
const viewFiles = fs.readdirSync(dir).filter((f) => /View\.ts$/.test(f));

// @lat: [[tests#Obsidian host#View field names]]
describe("obsidian host: view subclasses", () => {
  const reserved = new Set([
    ...members("Component"), ...members("View"), ...members("ItemView"), ...RUNTIME_INSTANCE_MEMBERS,
  ]);

  it("knows the members it guards against, including the undocumented ones", () => {
    for (const must of ["titleEl", "headerEl", "actionsEl", "contentEl", "containerEl", "leaf", "app", "icon", "navigation", "addAction", "registerEvent"]) {
      assert.ok(reserved.has(must), `${must} should be a known View member`);
    }
  });

  it("finds the view files to check", () => {
    assert.ok(viewFiles.includes("ReviewView.ts") && viewFiles.includes("PdfPreviewView.ts"), viewFiles.join());
  });

  for (const file of viewFiles) {
    const src = fs.readFileSync(nodePath.join(dir, file), "utf8");
    const body = src.slice(src.indexOf("extends ItemView"));
    const fields = [...body.matchAll(/^ {2}(?:private |protected |public |readonly |static )*(\w+)[!?]?\s*(?::[^=;(]+)?(?:=[^;]*)?;/gm)].map((x) => x[1]);
    const methods = [...body.matchAll(/^ {2}(?:private |protected |public |static |async )*(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{/gm)].map((x) => x[1]).filter((n) => n !== "constructor");

    it(`${file} declares no field that shadows a View member`, () => {
      assert.ok(fields.length > 0, "the scan found no fields; it is broken");
      const clash = fields.filter((n) => reserved.has(n));
      assert.deepStrictEqual(clash, [], `would replace Obsidian's own: ${clash.join(", ")}`);
    });

    it(`${file} overrides only the methods a view is meant to override`, () => {
      assert.ok(methods.includes("getViewType"), "the scan found no methods; it is broken");
      const clash = methods.filter((n) => reserved.has(n) && !INTENDED_OVERRIDES.has(n));
      assert.deepStrictEqual(clash, [], `would replace Obsidian's own: ${clash.join(", ")}`);
    });
  }

  it("would catch the bug it exists for", () => {
    const bad = "class X extends ItemView {\n  private titleEl!: HTMLElement;\n}";
    const declared = [...bad.matchAll(/^ {2}(?:private |protected |public |readonly |static )*(\w+)[!?]?\s*(?::[^=;(]+)?(?:=[^;]*)?;/gm)].map((x) => x[1]);
    assert.deepStrictEqual(declared.filter((n) => reserved.has(n)), ["titleEl"]);
  });
});
