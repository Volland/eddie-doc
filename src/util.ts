import type * as vscode from "vscode";

/**
 * Treat a document as AsciiDoc if the language service says so OR the file has a
 * known AsciiDoc extension. The latter covers users without an AsciiDoc
 * language extension installed, where .adoc opens as plaintext.
 */
export function isAdocPath(fsPath: string): boolean {
  return /\.(adoc|asciidoc|asc|ad)$/i.test(fsPath);
}

/**
 * Only real files on disk count. VS Code hands out plenty of documents that
 * borrow a source file's path or language without being it — a comment thread's
 * reply box, the left side of a diff, a git or search-result buffer. Treating
 * those as the manuscript made typing a reply shift every annotation anchor
 * under the cursor, since the keystrokes arrived as edits to "the .adoc".
 */
export function isAdocDoc(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return false;
  return doc.languageId === "asciidoc" || isAdocPath(doc.uri.fsPath);
}
