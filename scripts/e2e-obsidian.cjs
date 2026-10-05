#!/usr/bin/env node
/**
 * End-to-end check of the built Obsidian plugin in a REAL Obsidian.
 *
 *   npm run build && npm run e2e:obsidian
 *
 * Launches its own Obsidian instance with a private user-data directory and a
 * throwaway vault under the OS temp folder, drives it over Chromium's debugging
 * port, asserts what a user would see, and removes everything afterwards. It never
 * opens, reads or modifies any of your own vaults, and it stops only the process
 * it started.
 *
 * Needs: the Obsidian desktop app (set OBSIDIAN_BIN if it is not at the macOS
 * default) and a built plugin in dist/obsidian. Not run in CI: CI has no Obsidian.
 *
 *   E2E_SHOTS=<dir>      save a screenshot after each scenario
 *   E2E_ASCIIDOC_LIVE=1  also install AsciiDoc Live into the throwaway vault (downloads
 *                        a public community plugin from GitHub) and test the pairing
 *   E2E_PLUGIN_DIR=<dir> test the main.js, manifest.json and styles.css in <dir> instead of
 *                        dist/obsidian: e.g. the files downloaded from a GitHub release, to
 *                        prove that what was published is what was tested
 *   E2E_KEEP=1           leave the temp directory and the app running for inspection
 *   E2E_ASAR_FROM=<dir>  copy obsidian-*.asar from <dir> into the private data folder, to test a
 *                        newer app build the app has already downloaded (it is used only if
 *                        the installed shell is new enough to accept it; the title shows which)
 *
 * What it cannot show: a phone. Mobile is checked with Obsidian's built-in mobile
 * emulation, which exercises the layout and the platform checks but still runs on
 * desktop Electron.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const BIN = process.env.OBSIDIAN_BIN || "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const SHOTS = process.env.E2E_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- reporting
let failures = 0;
const results = [];
function check(cond, name, detail = "") {
  results.push([!!cond, name]);
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------- environment
if (!fs.existsSync(BIN)) {
  console.log(`e2e-obsidian: skipped — Obsidian not found at ${BIN} (set OBSIDIAN_BIN).`);
  process.exit(0);
}
const dist = process.env.E2E_PLUGIN_DIR ? path.resolve(process.env.E2E_PLUGIN_DIR) : path.join(root, "dist/obsidian");
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  if (!fs.existsSync(path.join(dist, f))) {
    console.error(`e2e-obsidian: ${f} missing from ${dist} — run: npm run build`);
    process.exit(1);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eddie-e2e-"));
const vault = path.join(tmp, "vault");
const userData = path.join(tmp, "userdata");
const plugin = path.join(vault, ".obsidian/plugins/eddie-doc");
fs.mkdirSync(plugin, { recursive: true });
fs.mkdirSync(path.join(vault, "Manuscript"), { recursive: true });
fs.mkdirSync(path.join(vault, "Inbox"), { recursive: true });
fs.mkdirSync(userData, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(dist, f), path.join(plugin, f));
fs.copyFileSync(path.join(root, "sample/chapter-01.adoc"), path.join(vault, "Manuscript/chapter-01.adoc"));
fs.copyFileSync(path.join(root, "sample/chapter-01.annotated.pdf"), path.join(vault, "Inbox/chapter-01.annotated.pdf"));
fs.copyFileSync(path.join(root, "sample/chapter-01.pdf"), path.join(vault, "Inbox/chapter-01.pdf"));
fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["eddie-doc"]));
if (process.env.E2E_ASAR_FROM) {
  for (const f of fs.readdirSync(process.env.E2E_ASAR_FROM).filter((n) => /^obsidian-[\d.]+\.asar$/.test(n))) {
    fs.copyFileSync(path.join(process.env.E2E_ASAR_FROM, f), path.join(userData, f));
  }
}
fs.writeFileSync(
  path.join(userData, "obsidian.json"),
  JSON.stringify({ vaults: { eddie0e2e0000001: { path: vault, ts: Date.now(), open: true } } })
);

let child;
/**
 * Stop the app we started and delete the temp directory. Electron runs helper
 * processes that can outlive the main one, so the app is started in its own
 * process group and the whole group is stopped: politely first, then for certain.
 * Only that group is touched; nothing else on the machine is.
 */
async function cleanup() {
  if (process.env.E2E_KEEP) return console.log(`\nkept: ${tmp} (app still running, debugging port ${PORT})`);
  const gone = () => { try { process.kill(-child.pid, 0); return false; } catch { return true; } };
  if (child && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 20 && !gone(); i++) await sleep(250);
    if (!gone()) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } await sleep(500); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); }
  catch (e) { console.log(`(could not remove ${tmp}: ${e.message})`); }
}
process.on("SIGINT", () => cleanup().finally(() => process.exit(130)));

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

// ---------------------------------------------------------------- CDP client
let PORT, cdp, base = 0, pages = 0;
async function connect() {
  let t;
  for (let i = 0; i < 60 && !t; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = list.find((x) => x.type === "page" && x.url.startsWith("app://obsidian.md/index.html")); // not a Settings popout
    } catch { /* not up yet */ }
    if (!t) await sleep(500);
  }
  if (!t) throw new Error("Obsidian window did not appear");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pend = new Map(); const events = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
    else events.push(d);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  await sleep(500); // Runtime.enable replays the old console buffer; ignore it
  cdp = { send, events, ws };
  base = events.length;
}
const ev = async (expr) => {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error("page exception: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]);
  return r.result.value;
};
const waitFor = async (expr, ms = 15000, step = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await ev(expr)) return true; } catch { /* page busy */ } await sleep(step); }
  return false;
};
async function key(k, vk) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: type === "keyDown" && k === "Enter" ? "\r" : undefined });
  }
}
async function shot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    const r = await Promise.race([cdp.send("Page.captureScreenshot", { format: "png" }), sleep(15000).then(() => { throw new Error("timeout"); })]);
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
  } catch (e) { console.log(`    (screenshot ${name} failed: ${e.message})`); }
}
function consoleProblems() {
  const out = [];
  for (const e of cdp.events.slice(base)) {
    if (e.method === "Runtime.exceptionThrown") out.push("exception: " + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text).split("\n")[0]);
    if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") out.push("console.error: " + e.params.args.map((a) => a.value ?? a.description ?? "").join(" ").split("\n")[0].slice(0, 200));
  }
  return out;
}

const P = `app.plugins.plugins["eddie-doc"]`;
const ADOC = "Manuscript/chapter-01.adoc";
const sidecarOf = (rev = "rev-1") => path.join(vault, `Eddie Reviews/Manuscript/chapter-01/${rev}/chapter-01.review.json`);
const readSidecar = () => JSON.parse(fs.readFileSync(sidecarOf(), "utf8"));
const pick = async (filter) => {
  await waitFor(`!!document.querySelector(".prompt-input")`, 8000);
  await ev(`(()=>{const i=document.querySelector(".prompt-input"); i.value=${JSON.stringify(filter)}; i.dispatchEvent(new Event("input",{bubbles:true}))})()`);
  await sleep(300);
  await key("Enter", 13);
};

// ---------------------------------------------------------------- scenarios
async function main() {
  PORT = await freePort();
  child = spawn(BIN, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: "ignore", detached: true });
  child.on("exit", (c) => { if (c) console.log(`(obsidian exited with ${c})`); });
  await connect();
  // Newer Obsidian asks, the first time it opens a vault that ships plugins, whether to
  // trust the author; nothing loads until it is accepted. Accept it as a user would.
  if (await waitFor(`!![...document.querySelectorAll(".modal button")].find(b=>/trust/i.test(b.textContent))`, 6000)) {
    await ev(`[...document.querySelectorAll(".modal button")].find(b=>/trust/i.test(b.textContent)).click()`);
    console.log("(accepted Obsidian's \"trust the author of this vault\" prompt)");
    // Accepting reloads the window to start the plugins; let that finish, then reattach.
    await sleep(6000);
    await connect();
    // Newer Obsidian also leaves its Settings open in a separate window, and opens
    // modals in the active window; close it so the dialogs below appear in the main one.
    await ev(`(()=>{try{app.setting.close()}catch{}})()`);
    await sleep(800);
  }
  const title = await ev(`document.title`);
  console.log(`Obsidian: "${title}" (shell ${await ev(`navigator.userAgent.match(/obsidian\\/([\\d.]+)/)?.[1] || "?"`)}) on ${process.platform}`);

  section("1. Loads and registers");
  check(await waitFor(`!!${P}`, 20000), "the plugin loaded in Obsidian");
  check(await ev(`app.plugins.manifests["eddie-doc"].version`) === JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8")).version, "Obsidian reads the version from the manifest it was given");
  check(await ev(`Object.keys(app.commands.commands).filter(c=>c.startsWith("eddie-doc:")).length`) >= 32, "all commands are registered");
  check(await ev(`["eddie-review","eddie-pdf-preview"].every(t=>t in app.viewRegistry.viewByType)`), "both views are registered");
  check(await ev(`JSON.stringify(${P}.claimed)`) === `["adoc","asciidoc"]`, "claimed .adoc and .asciidoc when nothing else holds them", await ev(`JSON.stringify(${P}.claimed)`));
  check(await ev(`app.viewRegistry.typeByExtension.adoc`) === "markdown", "the view registry maps adoc to the markdown view");
  check(await ev(`${P}.workerMode`) === "worker", "PDF parsing uses a Blob worker (not the fallback)", await ev(`${P}.workerMode`));
  // pdfjs's worker module sets this window global when imported. Obsidian's own PDF viewer
  // reads it, so leaving ours behind makes the built-in viewer run OUR worker code.
  check(await ev(`typeof window.pdfjsWorker`) === "undefined", "the plugin leaves no pdfjsWorker global in the window", await ev(`typeof window.pdfjsWorker`));
  check(await ev(`!document.querySelector("script[src^='blob:']")`), "and creates no script elements");

  section("2. A manuscript opens as source");
  await ev(`(async()=>{await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath(${JSON.stringify(ADOC)}))})()`);
  await sleep(1200);
  check(await ev(`(()=>{const v=app.workspace.getLeavesOfType("markdown")[0].view; return v.getViewType()==="markdown" && v.getState().source===true && v.file.path===${JSON.stringify(ADOC)}})()`), "chapter-01.adoc opens in the built-in editor in source mode");
  check(await ev(`!!document.querySelector(".cm-content.eddie-adoc")`), "the AsciiDoc styling reset is applied");

  section("3. Map a PDF (Open PDF review)");
  await ev(`app.commands.executeCommandById("eddie-doc:open-review")`);
  check(await waitFor(`document.querySelector(".prompt-input")?.placeholder?.includes("annotated PDF")`, 8000), "the PDF picker opens");
  await pick("annotated");
  check(await waitFor(`document.querySelector(".prompt-input")?.placeholder?.includes("belong to")`, 8000), "it then asks which source the PDF belongs to");
  await key("Enter", 13);
  check(await waitFor(`${P}.store.all().length===1 && !!${P}.store.get(${JSON.stringify(ADOC)})?.items.every(i=>i.anchor)`, 40000), "mapping finishes and anchors every annotation");
  const s = JSON.parse(await ev(`(()=>{const s=${P}.store.get(${JSON.stringify(ADOC)}); return JSON.stringify({n:s.items.length, mapped:s.items.filter(i=>i.match).length, sidecar:s.sidecarPath, pdf:s.pdfPath, kinds:s.items.map(i=>i.kind)})})()`));
  check(s.n === 5 && s.mapped === 5, "5 annotations extracted, all mapped to source", JSON.stringify(s));
  check(s.sidecar === "Eddie Reviews/Manuscript/chapter-01/rev-1/chapter-01.review.json", "the sidecar is at the vault-relative path");
  await sleep(600);
  check(fs.existsSync(sidecarOf()), "the sidecar file exists on disk");
  check(fs.existsSync(path.join(vault, "Eddie Reviews/Manuscript/chapter-01/rev-1/pdf/chapter-01.pdf")), "the PDF was copied into the round");
  check((fs.readFileSync(path.join(vault, ADOC), "utf8").match(/^\/\/ eddie:/gm) || []).length === 5, "5 anchor comments were written into the manuscript");
  check(await waitFor(`app.workspace.getLeavesOfType("eddie-review").length===1`, 5000), "the review panel opened");
  check(await waitFor(`document.querySelectorAll(".eddie-row").length===5`, 5000), "the panel lists 5 annotations");
  check(await waitFor(`document.querySelectorAll(".cm-line.eddie-line").length>0 && document.querySelectorAll(".eddie-badge").length>0`, 5000), "the editor shows highlighted lines and gutter badges");
  check(/r1 · 5 open/.test(await ev(`document.querySelector(".eddie-status")?.textContent||""`)), "the status bar shows the round and open count");
  await shot("3-mapped");

  section("4. Work through an annotation");
  const commentId = await ev(`${P}.store.get(${JSON.stringify(ADOC)}).items.find(i=>i.kind==="comment").id`);
  await ev(`[...document.querySelectorAll(".eddie-row")].find(r=>r.dataset.id===${JSON.stringify(commentId)}).click()`);
  check(await waitFor(`!!document.querySelector(".eddie-detail")`, 4000), "clicking a row shows its thread");
  check(await ev(`${P}.selection?.id`) === commentId, "the row is selected");
  check(await ev(`document.querySelector(".eddie-root .eddie-post-author")?.textContent`) === "Editor", "the Reviewer's mark is the root post");
  await ev(`(()=>{const t=document.querySelector("textarea.eddie-reply-box"); t.value="Will redraw this figure."; t.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector(".eddie-send").click()})()`);
  check(await waitFor(`document.querySelector(".modal h3")?.textContent==="Your name on replies"`, 5000), "the first reply asks for your name once");
  await ev(`(()=>{const i=document.querySelector(".modal input.eddie-modal-input"); i.value="Test Author"; i.focus()})()`);
  await key("Enter", 13);
  check(await waitFor(`${P}.store.findItem(${JSON.stringify(ADOC)},${JSON.stringify(commentId)}).replies?.[0]?.body==="Will redraw this figure."`, 6000), "the reply is added with that name");
  await sleep(800);
  check(fs.readFileSync(sidecarOf(), "utf8").includes("Will redraw this figure."), "the reply reached the sidecar on disk");
  await ev(`[...document.querySelectorAll(".eddie-detail .eddie-actions button")].find(b=>b.textContent==="Resolve").click()`);
  check(await waitFor(`${P}.store.findItem(${JSON.stringify(ADOC)},${JSON.stringify(commentId)}).resolved===true`, 4000), "Resolve marks it resolved");
  await sleep(800);
  check(/r1 · 4 open/.test(await ev(`document.querySelector(".eddie-status")?.textContent||""`)), "the status bar count drops to 4 open");
  await shot("4-thread");

  section("5. PDF preview");
  await ev(`${P}.updateSettings({pdfPreview:"own"})`);
  await ev(`[...document.querySelectorAll(".eddie-detail .eddie-actions button")].find(b=>b.textContent==="Preview PDF").click()`);
  check(await waitFor(`!!document.querySelector(".eddie-pdfview-page canvas")`, 15000), "Eddie's viewer draws a page");
  const pv = JSON.parse(await ev(`(()=>{const c=document.querySelector(".eddie-pdfview-page canvas"); const m=document.querySelector(".eddie-pdfview-mark"); const r=m?.getBoundingClientRect(), cr=c.getBoundingClientRect(); const d=c.getContext("2d").getImageData(0,0,c.width,c.height).data; let dark=0; for(let i=0;i<d.length;i+=4*97) if(d[i]<128) dark++; return JSON.stringify({page:document.querySelector(".eddie-pdfview-bar .eddie-muted")?.textContent, painted: dark>5, markInside: !!r && r.left>=cr.left-1 && r.right<=cr.right+1 && r.top>=cr.top-1 && r.bottom<=cr.bottom+1})})()`));
  check(pv.page === "3 / 5", "it shows the annotation's page (3 of 5)", pv.page);
  check(pv.painted, "the page is actually painted, not blank");
  check(pv.markInside, "the marker rectangle lies on the page");
  await shot("5-own-viewer");
  await ev(`app.workspace.getLeavesOfType("eddie-pdf-preview").forEach(l=>l.detach())`);
  await ev(`${P}.updateSettings({pdfPreview:"builtin"})`);
  await ev(`[...document.querySelectorAll(".eddie-detail .eddie-actions button")].find(b=>b.textContent==="Preview PDF").click()`);
  check(await waitFor(`app.workspace.getLeavesOfType("pdf").length===1`, 10000), "Obsidian's built-in viewer opens the PDF");
  // The viewer loads the document asynchronously; wait for it to report a page.
  const viewerPage = `(()=>{try{return app.workspace.getLeavesOfType("pdf")[0].view.viewer.child.pdfViewer.pdfViewer.currentPageNumber}catch{return -1}})()`;
  await waitFor(`${viewerPage} === 3`, 12000);
  const landed = await ev(viewerPage);
  check(landed === 3, "and lands on page 3", `it reported page ${landed}`);
  await ev(`app.workspace.getLeavesOfType("pdf").forEach(l=>l.detach())`);
  await ev(`${P}.updateSettings({pdfPreview:"own"})`);

  section("6. Apply an edit to the source");
  const strike = JSON.parse(await ev(`(()=>{const it=${P}.store.get(${JSON.stringify(ADOC)}).items.find(i=>i.kind==="strikeout"); return JSON.stringify({id:it.id, text:it.markedText||it.anchoredText})})()`));
  await ev(`${P}.select(${JSON.stringify(strike.id)})`);
  await waitFor(`!!document.querySelector(".eddie-detail")`, 4000);
  const ed = `app.workspace.getLeavesOfType("markdown")[0].view.editor`;
  const before = await ev(`${ed}.getValue()`);
  await ev(`[...document.querySelectorAll(".eddie-detail button")].find(b=>b.textContent==="Delete struck text").click()`);
  await waitFor(`${P}.store.findItem(${JSON.stringify(ADOC)},${JSON.stringify(strike.id)}).resolved===true`, 4000);
  const after = await ev(`${ed}.getValue()`);
  const removed = before.length - after.length;
  check(removed >= strike.text.length && removed <= strike.text.length + 1, "only the struck words (plus one space) were removed", `removed ${removed}, struck "${strike.text}" (${strike.text.length})`);
  check(!after.includes(strike.text) && before.includes(strike.text), "the struck text is gone from the manuscript");
  await ev(`${ed}.undo()`);
  await sleep(500);
  check(await ev(`${ed}.getValue()`) === before, "one Undo restores the original text exactly");
  await shot("6-applied");

  section("7. The vault changes under the plugin");
  const j = readSidecar();
  const target = j.items[0];
  target.state.replies = [{ id: "r-remote01", author: "Sam (phone)", createdAt: "2026-10-05T15:00:00.000Z", body: "Typed on the other device." }];
  fs.writeFileSync(sidecarOf(), JSON.stringify(j, null, 2) + "\n");
  check(await waitFor(`${P}.store.get(${JSON.stringify(ADOC)}).items.find(i=>i.id===${JSON.stringify(target.id)})?.replies?.some(r=>r.id==="r-remote01")`, 10000), "a reply written into the sidecar from outside appears in the plugin");
  await ev(`(async()=>{await app.fileManager.renameFile(app.vault.getAbstractFileByPath(${JSON.stringify(ADOC)}), "Manuscript/ch1.adoc")})()`);
  check(await waitFor(`${P}.store.sessionsFor("Manuscript/ch1.adoc").length===1 && ${P}.store.sessionsFor(${JSON.stringify(ADOC)}).length===0`, 8000), "renaming the manuscript keeps its review attached");
  await sleep(1000);
  check(readSidecar().source.path.endsWith("/ch1.adoc"), "and the sidecar's recorded source path was rewritten");
  check(readSidecar().items[0].state.replies?.[0]?.body === "Typed on the other device.", "the other device's reply survived the rename");
  await ev(`(async()=>{await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Eddie Reviews"), "Reviews")})()`);
  check(await waitFor(`${P}.settings.reviewFolder==="Reviews"`, 8000), "renaming the review folder updates the setting");
  check((await ev(`${P}.store.all()[0].sidecarPath`)).startsWith("Reviews/"), "and the loaded review moves with it");

  section("8. Commands are offered only when they apply");
  const gate = JSON.parse(await ev(`(()=>{const o={}; for(const id of ["open-review","stamp-pdf","merge-mappings","switch-mapping","cancel-operation","toggle-resolved"]){ const c=app.commands.commands["eddie-doc:"+id]; o[id]=c.checkCallback(true) } return JSON.stringify(o)})()`));
  check(gate["open-review"] && gate["stamp-pdf"] && gate["toggle-resolved"], "context commands are offered with a review and a selection");
  check(!gate["merge-mappings"] && !gate["switch-mapping"] && !gate["cancel-operation"], "merge, switch-mapping and cancel are hidden when they cannot apply");

  section("9. Unload is clean");
  await ev(`(async()=>{await app.plugins.disablePlugin("eddie-doc")})()`);
  await sleep(1000);
  // Obsidian keeps a disabled plugin's tabs in place (so they keep their position
  // across an update); what must go is the view type itself.
  check(await ev(`!("eddie-review" in app.viewRegistry.viewByType) && !("eddie-pdf-preview" in app.viewRegistry.viewByType)`), "disabling unregisters both view types");
  check(await ev(`!document.querySelector(".eddie-status") && !document.querySelector(".eddie-badge")`), "and the status bar item and editor badges");
  check(await ev(`!(app.viewRegistry.typeByExtension.adoc)`), "and releases the .adoc claim", await ev(`String(app.viewRegistry.typeByExtension.adoc)`));
  check(await ev(`!Object.keys(app.commands.commands).some(c=>c.startsWith("eddie-doc:"))`), "and removes its commands");
  await ev(`(async()=>{await app.plugins.enablePlugin("eddie-doc")})()`);
  check(await waitFor(`!!${P} && Object.keys(app.commands.commands).filter(c=>c.startsWith("eddie-doc:")).length>=32`, 8000), "it enables again");
  check(await waitFor(`${P}.store.all().length===1`, 15000), "and finds its review again");

  section("9b. Without Web Workers (the fallback a phone's WebView may need)");
  // Make `new Worker` throw before the plugin starts, as a WebView that refuses Blob workers
  // would, and check that PDF parsing still works by running on the main thread.
  await ev(`(async()=>{ await app.plugins.disablePlugin("eddie-doc"); window.__realWorker = window.Worker; window.Worker = function(){ throw new Error("Workers are blocked") }; await app.plugins.enablePlugin("eddie-doc"); })()`);
  check(await waitFor(`!!${P} && ${P}.store.all().length===1`, 15000), "the plugin starts with Workers unavailable");
  check(await ev(`${P}.workerMode`) === "main-thread", "and falls back to parsing on the main thread", await ev(`${P}.workerMode`));
  const fb = JSON.parse(await ev(`(async()=>{
    const src = app.vault.getAbstractFileByPath("Manuscript/ch1.adoc");
    await app.vault.copy(src, "Manuscript/fallback.adoc");
    const s = await ${P}.store.loadReview("Manuscript/fallback.adoc", "Inbox/chapter-01.annotated.pdf", {threshold:0.5, revision:{id:"rev-1",ordinal:1}, importPdf:false});
    const out = JSON.stringify({items: s.items.length, mapped: s.items.filter(i=>i.match).length});
    await ${P}.store.deleteMapping(s.sidecarPath);
    return out })()`));
  check(fb.items === 5 && fb.mapped === 5, "mapping the sample PDF still finds all 5 annotations", JSON.stringify(fb));
  check(await ev(`!document.querySelector("script[src^='blob:']")`), "no script element was created to do it");
  check(await ev(`typeof window.pdfjsWorker`) === "undefined", "and the fallback leaves no pdfjsWorker global behind either");
  await ev(`(async()=>{ await app.plugins.disablePlugin("eddie-doc"); window.Worker = window.__realWorker; await app.plugins.enablePlugin("eddie-doc"); const f=app.vault.getAbstractFileByPath("Manuscript/fallback.adoc"); if(f) await app.vault.delete(f); })()`);
  check(await waitFor(`!!${P} && ${P}.workerMode==="worker" && ${P}.store.all().length===1`, 15000), "with Workers restored it uses a worker again");

  section("10. Phone layout (Obsidian's mobile emulation)");
  await ev(`app.emulateMobile(true)`);
  await sleep(6000);
  await connect();
  check(await waitFor(`!!${P} && app.isMobile`, 20000), "the plugin loads in mobile mode");
  check(await ev(`!document.querySelector(".eddie-status")`), "the desktop-only status bar item is not created");
  await ev(`(async()=>{await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath("Manuscript/ch1.adoc")); await ${P}.showPanel()})()`);
  check(await waitFor(`document.querySelectorAll(".eddie-row").length===5`, 10000), "the panel lists the annotations");
  const m = JSON.parse(await ev(`JSON.stringify({narrow: document.querySelector(".eddie-panel").classList.contains("eddie-narrow"), minBtn: Math.min(...[...document.querySelectorAll(".eddie-panel button")].map(b=>Math.round(b.getBoundingClientRect().height))), minRow: Math.min(...[...document.querySelectorAll(".eddie-row")].map(r=>Math.round(r.getBoundingClientRect().height)))})`));
  check(m.narrow, "the panel uses the narrow layout");
  check(m.minBtn >= 44 && m.minRow >= 44, "touch targets are at least 44px", JSON.stringify(m));
  await ev(`document.querySelectorAll(".eddie-row")[0].click()`);
  check(await waitFor(`!!document.querySelector(".eddie-detail") && !document.querySelector(".eddie-list") && !!document.querySelector(".eddie-back")`, 4000), "tapping a row shows the thread alone, with a back button");
  await shot("10-mobile");
  await ev(`app.emulateMobile(false)`);
  await sleep(6000);
  await connect();

  if (process.env.E2E_ASCIIDOC_LIVE) await pairing();

  section("Console");
  const problems = consoleProblems();
  check(problems.length === 0, "no console errors or exceptions during the run", problems.join(" | "));
}

// Optional: another AsciiDoc plugin owns .adoc. Needs the network; runs a public community plugin.
async function pairing() {
  section("11. Pairing with AsciiDoc Live (E2E_ASCIIDOC_LIVE)");
  const dir = path.join(vault, ".obsidian/plugins/asciidoc-live");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) {
    const r = await fetch(`https://github.com/koshlensky/asciidoc-live/releases/latest/download/${f}`);
    if (!r.ok) return check(false, `could not download AsciiDoc Live ${f} (${r.status})`);
    fs.writeFileSync(path.join(dir, f), Buffer.from(await r.arrayBuffer()));
  }
  fs.writeFileSync(path.join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["eddie-doc", "asciidoc-live"]));
  await ev(`app.commands.executeCommandById("app:reload")`);
  await sleep(7000);
  await connect();
  check(await waitFor(`!!${P} && !!app.plugins.plugins["asciidoc-live"]`, 25000), "both plugins load");
  check(await ev(`JSON.stringify(${P}.claimed)`) === "[]", "Eddie leaves the extensions to AsciiDoc Live", await ev(`JSON.stringify(${P}.claimed)`));
  await ev(`(async()=>{await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath("Manuscript/ch1.adoc"))})()`);
  await sleep(2000);
  // leave only AsciiDoc Live's view open, so Reveal has to create Eddie's own tab
  await ev(`app.workspace.getLeavesOfType("markdown").forEach(l=>l.detach())`);
  await sleep(500);
  check(await ev(`app.workspace.getLeavesOfType("markdown").length===0 && app.workspace.getLeavesOfType("adoc").length===1`), "a normal open gives AsciiDoc Live's view");
  const id = await ev(`${P}.store.get("Manuscript/ch1.adoc").items.find(i=>!i.resolved).id`);
  await ev(`${P}.revealItem("Manuscript/ch1.adoc", ${JSON.stringify(id)})`);
  check(await waitFor(`app.workspace.getLeavesOfType("markdown").length===1 && app.workspace.getLeavesOfType("markdown")[0].getViewState().state.source===true`, 8000), "Reveal opens a source-mode tab beside it (Obsidian accepts a Markdown view for the held extension)");
  check(await waitFor(`document.querySelectorAll(".cm-line.eddie-line").length>0`, 5000), "Eddie's markup is shown in that tab");
  await ev(`app.workspace.getLeavesOfType("markdown")[0].view.editor.replaceRange("\\n\\nPAIRING-PROBE typed here.\\n",{line:3,ch:0})`);
  check(await waitFor(`app.workspace.getLeavesOfType("adoc")[0].view.containerEl.innerText.includes("PAIRING-PROBE")`, 8000), "AsciiDoc Live's preview follows edits made in Eddie's tab");
  await shot("11-paired");
}

main()
  .catch((e) => { console.error("\ne2e-obsidian crashed:", e.message); failures++; })
  .finally(() => {
    const passed = results.filter((r) => r[0]).length;
    console.log(`\n${failures ? "FAILED" : "PASSED"}: ${passed}/${results.length} checks${failures ? `, ${failures} failed` : ""}`);
    cleanup().finally(() => process.exit(failures ? 1 : 0));
  });
