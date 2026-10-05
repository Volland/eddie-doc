import { App, FuzzySuggestModal, Modal, Setting } from "obsidian";

/** Pick one of `items` by fuzzy search; resolves undefined when dismissed. */
export function choose<T>(
  app: App,
  items: T[],
  text: (item: T) => string,
  placeholder: string
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let picked = false;
    class Picker extends FuzzySuggestModal<T> {
      getItems(): T[] {
        return items;
      }
      getItemText(item: T): string {
        return text(item);
      }
      onChooseItem(item: T): void {
        picked = true;
        resolve(item);
      }
      onClose(): void {
        // onChooseItem runs after close; defer so a pick is not mistaken for a dismiss.
        window.setTimeout(() => {
          if (!picked) resolve(undefined);
        }, 0);
      }
    }
    const m = new Picker(app);
    m.setPlaceholder(placeholder);
    m.open();
  });
}

class PromptModal extends Modal {
  private result: string | undefined;
  constructor(
    app: App,
    private readonly title: string,
    private readonly detail: string,
    private readonly initial: string,
    private readonly multiline: boolean,
    private readonly done: (v: string | undefined) => void
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    if (this.detail) contentEl.createEl("p", { text: this.detail, cls: "eddie-modal-detail" });
    const input = this.multiline
      ? contentEl.createEl("textarea", { cls: "eddie-modal-input" })
      : contentEl.createEl("input", { type: "text", cls: "eddie-modal-input" });
    input.value = this.initial;
    if (this.multiline) (input as HTMLTextAreaElement).rows = 4;
    input.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter" && (!this.multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.result = input.value;
        this.close();
      }
    });
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("OK")
          .setCta()
          .onClick(() => {
            this.result = input.value;
            this.close();
          })
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
  onClose(): void {
    this.contentEl.empty();
    this.done(this.result);
  }
}

/** Ask for a line (or a few) of text. Resolves undefined when cancelled. */
export function prompt(
  app: App,
  title: string,
  opts: { detail?: string; value?: string; multiline?: boolean } = {}
): Promise<string | undefined> {
  return new Promise((resolve) =>
    new PromptModal(app, title, opts.detail ?? "", opts.value ?? "", !!opts.multiline, resolve).open()
  );
}

class ConfirmModal extends Modal {
  private ok = false;
  constructor(
    app: App,
    private readonly title: string,
    private readonly detail: string,
    private readonly cta: string,
    private readonly done: (ok: boolean) => void
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    if (this.detail) {
      contentEl.createEl("pre", { text: this.detail, cls: "eddie-modal-detail eddie-modal-pre" });
    }
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(this.cta)
          .setCta()
          .onClick(() => {
            this.ok = true;
            this.close();
          })
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
  onClose(): void {
    this.contentEl.empty();
    this.done(this.ok);
  }
}

/** A yes/no question with a detail block. Resolves false when dismissed. */
export function confirm(app: App, title: string, detail: string, cta: string): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, title, detail, cta, resolve).open());
}
