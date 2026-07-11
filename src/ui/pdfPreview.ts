import * as fs from "node:fs";
import * as vscode from "vscode";

/**
 * A single reusable webview that renders the PDF page an annotation lives on and
 * highlights its rectangle. Rendering happens in the webview's browser context
 * via pdfjs, so no native canvas dependency is needed in the extension host.
 *
 * The panel keeps the currently-loaded PDF document alive: selecting another
 * annotation in the same PDF only sends a lightweight "goto" (page + rect), so
 * browsing the annotation list re-renders instantly without re-parsing the file.
 */
export class PdfPreviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private loadedPdf: string | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Is the preview panel currently open? */
  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Render `page` of `pdfPath`, highlighting `rect` ([x0,y0,x1,y1], PDF pts). */
  show(pdfPath: string, page: number, rect: number[], title: string): void {
    if (!fs.existsSync(pdfPath)) {
      vscode.window.showWarningMessage(
        `Eddie Doc: can't preview — PDF not found at ${pdfPath}.`
      );
      return;
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "eddieDocPdfPreview",
        "Eddie Doc: PDF Preview",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, "dist"),
          ],
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.loadedPdf = undefined;
      });
      this.panel.webview.html = this.html(this.panel.webview);
      this.loadedPdf = undefined;
    }

    this.panel.title = `Preview: ${title}`;
    const webview = this.panel.webview;
    if (this.loadedPdf !== pdfPath) {
      // Ship the bytes as base64 — VS Code webview messages are JSON-cloned, so
      // typed arrays don't survive the trip intact.
      const b64 = fs.readFileSync(pdfPath).toString("base64");
      webview.postMessage({ type: "load", data: b64, page, rect });
      this.loadedPdf = pdfPath;
    } else {
      webview.postMessage({ type: "goto", page, rect });
    }
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private html(webview: vscode.Webview): string {
    const asset = (name: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "dist", name)
      );
    const pdfUri = asset("pdf.min.mjs");
    const workerUri = asset("pdf.worker.min.mjs");
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval' 'wasm-unsafe-eval'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
  }
  #status { padding: 8px 12px; font-size: 12px; opacity: 0.8; }
  #wrap { position: absolute; inset: 34px 0 0 0; overflow: auto; text-align: center; }
  canvas { max-width: 100%; height: auto; box-shadow: 0 0 0 1px var(--vscode-panel-border); }
</style>
</head>
<body>
  <div id="status">Loading preview…</div>
  <div id="wrap"><canvas id="c"></canvas></div>
  <script nonce="${nonce}" type="module">
    const PDFJS_URI = ${JSON.stringify(String(pdfUri))};
    const WORKER_URI = ${JSON.stringify(String(workerUri))};
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById("c");
    const ctx = canvas.getContext("2d");
    const wrap = document.getElementById("wrap");
    const status = document.getElementById("status");
    let pdfjsLib = null;
    let pdfDoc = null;

    function b64ToBytes(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    async function ensureLib() {
      if (!pdfjsLib) {
        pdfjsLib = await import(PDFJS_URI);
        pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URI;
      }
      return pdfjsLib;
    }

    async function renderPage(pageNum, rect) {
      if (!pdfDoc) return;
      const n = Math.min(Math.max(1, pageNum || 1), pdfDoc.numPages);
      const page = await pdfDoc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const avail = Math.max(320, wrap.clientWidth - 24);
      const scale = Math.min(2.5, Math.max(1, avail / base.width));
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;

      if (rect && rect.length === 4) {
        const a = viewport.convertToViewportPoint(rect[0], rect[1]);
        const b = viewport.convertToViewportPoint(rect[2], rect[3]);
        const x = Math.min(a[0], b[0]);
        const y = Math.min(a[1], b[1]);
        const w = Math.max(2, Math.abs(b[0] - a[0]));
        const h = Math.max(2, Math.abs(b[1] - a[1]));
        ctx.save();
        ctx.fillStyle = "rgba(255, 196, 0, 0.28)";
        ctx.strokeStyle = "rgba(255, 140, 0, 0.95)";
        ctx.lineWidth = 2;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
        wrap.scrollTo({ top: Math.max(0, y - 100), behavior: "smooth" });
      }
      status.textContent = "Page " + n + " of " + pdfDoc.numPages;
    }

    window.addEventListener("message", async (e) => {
      const m = e.data;
      try {
        if (m.type === "load") {
          const lib = await ensureLib();
          status.textContent = "Rendering…";
          pdfDoc = await lib.getDocument({
            data: b64ToBytes(m.data),
            isEvalSupported: false,
            disableFontFace: false,
          }).promise;
          await renderPage(m.page, m.rect);
        } else if (m.type === "goto") {
          await renderPage(m.page, m.rect);
        }
      } catch (err) {
        status.textContent = "Preview failed: " + (err && err.message ? err.message : err);
      }
    });
  </script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 24; i++)
    s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
