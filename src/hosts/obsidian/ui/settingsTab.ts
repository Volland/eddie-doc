import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type EddiePlugin from "../main.js";

/** The Eddie Doc settings page. Every control writes through `plugin.updateSettings`. */
export class EddieSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: EddiePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl: el } = this;
    el.empty();
    const s = this.plugin.settings;
    const set = (patch: Parameters<EddiePlugin["updateSettings"]>[0]) =>
      void this.plugin.updateSettings(patch);
    const slider = (
      name: string,
      desc: string,
      key: "matchThreshold" | "highConfidence" | "lexicalThreshold" | "semanticThreshold"
    ) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addSlider((sl) =>
          sl
            .setLimits(0, 1, 0.01)
            .setValue(s[key])
            .onChange((v) => set({ [key]: v }))
        );

    new Setting(el).setName("Reviews").setHeading();

    new Setting(el)
      .setName("Review folder")
      .setDesc(
        "Where mappings, reports and copies of annotated PDFs are kept, relative to the vault. " +
          "Keep it a visible folder: Obsidian does not index or sync folders starting with a dot, " +
          "so a review kept there would not reach your phone."
      )
      .addText((t) =>
        t.setPlaceholder("Eddie Reviews").setValue(s.reviewFolder).onChange((v) => set({ reviewFolder: v }))
      );

    new Setting(el)
      .setName("Copy annotated PDFs into the vault")
      .setDesc(
        "Always on in Obsidian. A PDF outside the vault cannot be read on mobile, and a round " +
          "stays readable after the download folder is cleared."
      )
      .addToggle((t) => t.setValue(true).setDisabled(true));

    new Setting(el)
      .setName("Stamped PDFs")
      .setDesc("Where a reviewed PDF is written.")
      .addDropdown((d) =>
        d
          .addOptions({ reviewFolder: "In the review folder", besidePdf: "Beside the source PDF" })
          .setValue(s.stampOutput)
          .onChange((v) => set({ stampOutput: v as typeof s.stampOutput }))
      );

    new Setting(el)
      .setName("Reports")
      .setDesc("Where an exported report is written.")
      .addDropdown((d) =>
        d
          .addOptions({ reviewFolder: "In the review folder", besideSource: "Beside the source file" })
          .setValue(s.reportOutput)
          .onChange((v) => set({ reportOutput: v as typeof s.reportOutput }))
      );

    new Setting(el).setName("Matching").setHeading();
    slider("Match threshold", "Minimum score for a mark to be linked to a source line.", "matchThreshold");
    slider(
      "High-confidence threshold",
      "Marks scoring at or above this are Open; below it they need review.",
      "highConfidence"
    );
    new Setting(el)
      .setName("Character-trigram fallback")
      .setDesc("Rescue marks the word matcher could not place, using character overlap.")
      .addToggle((t) => t.setValue(s.lexicalFallback).onChange((v) => set({ lexicalFallback: v })));
    slider("Trigram threshold", "Minimum similarity for the fallback.", "lexicalThreshold");

    if (Platform.isDesktopApp) {
      new Setting(el).setName("Semantic matching (desktop)").setHeading();
      new Setting(el)
        .setName("Use a local embedding model")
        .setDesc("Rescue paraphrased marks through an Ollama server. Off by default; nothing leaves your machine.")
        .addToggle((t) => t.setValue(s.semanticFallback).onChange((v) => set({ semanticFallback: v })));
      new Setting(el)
        .setName("Ollama URL")
        .addText((t) => t.setValue(s.ollamaUrl).onChange((v) => set({ ollamaUrl: v })));
      new Setting(el)
        .setName("Embedding model")
        .addText((t) => t.setValue(s.embedModel).onChange((v) => set({ embedModel: v })));
      slider("Semantic threshold", "Minimum cosine similarity to accept a semantic link.", "semanticThreshold");
    }

    new Setting(el).setName("Editor").setHeading();
    new Setting(el)
      .setName("Show resolved annotations")
      .addToggle((t) => t.setValue(s.showResolved).onChange((v) => set({ showResolved: v })));
    new Setting(el)
      .setName("Show end-of-line markers")
      .setDesc("A small glyph after each annotated line. Display only; never written to your file.")
      .addToggle((t) => t.setValue(s.inlineMarkers).onChange((v) => set({ inlineMarkers: v })));
    new Setting(el)
      .setName("Anchor annotations when mapping")
      .setDesc(
        "Write a `// eddie:<id>` comment above each annotated paragraph when a PDF is mapped. " +
          "AsciiDoc strips comments when rendering, so nothing shows up in the output. The marks then stay " +
          "attached when the text is rewritten."
      )
      .addToggle((t) => t.setValue(s.autoAnchor).onChange((v) => set({ autoAnchor: v })));
    new Setting(el)
      .setName("Open the first unanswered thread")
      .setDesc("When the review panel opens, show the first annotation you have not replied to.")
      .addToggle((t) => t.setValue(s.expandThreads).onChange((v) => set({ expandThreads: v })));

    new Setting(el).setName("You").setHeading();
    new Setting(el)
      .setName("Your name on replies")
      .setDesc("Obsidian cannot read your git identity, so Eddie asks once if this is empty.")
      .addText((t) => t.setValue(s.authorName).onChange((v) => set({ authorName: v })));

    new Setting(el).setName("PDF preview").setHeading();
    new Setting(el)
      .setName("Preview with")
      .setDesc(
        "Eddie's viewer draws the page and the marked rectangle itself. Obsidian's own viewer opens the PDF at " +
          "the annotation's page; in Obsidian 1.8.4 it does not draw the rectangle."
      )
      .addDropdown((d) =>
        d
          .addOptions({ own: "Eddie's viewer", builtin: "Obsidian's PDF viewer" })
          .setValue(s.pdfPreview)
          .onChange((v) => set({ pdfPreview: v as typeof s.pdfPreview }))
      );
    new Setting(el)
      .setName("Rectangle coordinates")
      .setDesc(
        "Only for Obsidian's viewer. If the highlighted rectangle lands in the wrong place, try the other origin."
      )
      .addDropdown((d) =>
        d
          .addOptions({ "pdf-user": "PDF (origin bottom-left)", "top-left": "Page (origin top-left)" })
          .setValue(s.pdfRectMode)
          .onChange((v) => set({ pdfRectMode: v as typeof s.pdfRectMode }))
      );

    new Setting(el).setName("AsciiDoc files").setHeading();
    new Setting(el)
      .setName("Open .adoc files with Eddie")
      .setDesc(
        "Auto: Eddie opens .adoc and .asciidoc in the source editor if no other plugin has claimed them. " +
          "Never: leave them to another AsciiDoc plugin; Eddie still marks up its editor. Reload the plugin to apply."
      )
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Auto", never: "Never" })
          .setValue(s.claimAdoc)
          .onChange((v) => set({ claimAdoc: v as typeof s.claimAdoc }))
      );
  }
}
