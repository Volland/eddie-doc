import type * as vscode from "vscode";

/**
 * Treat a document as AsciiDoc if the language service says so OR the file has a
 * known AsciiDoc extension. The latter covers users without an AsciiDoc
 * language extension installed, where .adoc opens as plaintext.
 */
export function isAdocPath(fsPath: string): boolean {
  return /\.(adoc|asciidoc|asc|ad)$/i.test(fsPath);
}

export function isAdocDoc(doc: vscode.TextDocument): boolean {
  return doc.languageId === "asciidoc" || isAdocPath(doc.uri.fsPath);
}
