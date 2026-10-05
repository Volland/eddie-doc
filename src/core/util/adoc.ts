/** True for a path with a known AsciiDoc extension. */
export function isAdocPath(path: string): boolean {
  return /\.(adoc|asciidoc|asc|ad)$/i.test(path);
}
