/**
 * Whether Eddie should register `.adoc` for itself (ADR 0002).
 *
 * Obsidian lets one view type own a file extension. Eddie claims `adoc` onto the
 * built-in markdown view only when nothing else has, so it never takes the file
 * away from an AsciiDoc plugin the user installed. `holder` is whatever the view
 * registry reports; `null` means its shape was not recognised (the registry
 * is undocumented) and is treated as "someone has it" — wrongly claiming would
 * break another plugin, wrongly abstaining only costs the standalone editor.
 */
export type Holder = string | undefined | null;

export type ClaimDecision = "claim" | "skip-held" | "skip-unknown" | "skip-setting";

// @lat: [[obsidian#AsciiDoc files]]
export function decideClaim(holder: Holder, setting: "auto" | "never"): ClaimDecision {
  if (setting === "never") return "skip-setting";
  if (holder === null) return "skip-unknown";
  if (holder !== undefined) return "skip-held";
  return "claim";
}

/** Extensions Eddie offers to open. `asc` and `ad` are left to other tools. */
export const CLAIMABLE_EXTENSIONS = ["adoc", "asciidoc"] as const;

/**
 * How Eddie opens a source file for review.
 *
 * - `default`: let Obsidian choose. Right for Markdown, and for an extension Eddie
 *   itself registered onto the markdown view.
 * - `markdown`: open it in Obsidian's built-in editor in source mode, explicitly.
 *   Right when another plugin owns the extension (its view cannot carry Eddie's
 *   markup — AsciiDoc Live's is a rendered preview with a plain textarea) or when
 *   nobody does (Obsidian has no viewer for it). The other plugin's preview and
 *   Eddie's marked-up source then sit side by side, which is how that plugin
 *   expects to be used: it refreshes from the built-in editor's changes.
 */
export type OpenMode = "default" | "markdown";

export function openModeFor(ext: string, claimed: readonly string[]): OpenMode {
  const e = ext.toLowerCase();
  if (e === "md") return "default";
  return claimed.includes(e) ? "default" : "markdown";
}
