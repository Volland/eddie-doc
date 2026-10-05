/**
 * Progress, cancellation and cooperative yielding for long operations.
 *
 * Reading a few hundred PDF pages is minutes of work on a phone, and a host that
 * runs it on its UI thread freezes unless the work hands control back. The core
 * therefore reports per-page progress, honours an `AbortSignal`, and yields to
 * the event loop on a time budget rather than on every page.
 */
export interface Progress {
  /** Called after each unit of work. `label` says what, e.g. "page". */
  report?(done: number, total: number, label?: string): void;
  /** Aborting makes the operation reject with {@link CancelledError} at the next page. */
  signal?: AbortSignal;
}

export class CancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (e as { name?: string })?.name === "CancelledError";
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

const microtask = (run: () => void): void => void Promise.resolve().then(run);
let schedule: (run: () => void) => void = microtask;

/**
 * Choose how {@link yieldToUi} hands control back. The default is a microtask, which
 * keeps the core free of timer globals; a host with a UI thread to protect installs a
 * macrotask scheduler (a zero-delay timer) so rendering can interleave.
 */
export function setUiScheduler(fn?: (run: () => void) => void): void {
  schedule = fn ?? microtask;
}

/** Let the event loop (and so the UI) run. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => schedule(resolve));
}

/**
 * A yielder that only actually yields once `budgetMs` of work has passed since
 * the last time it did. Call `tick()` after every unit; it is nearly free when it
 * does not yield.
 */
export function timeSlicer(budgetMs = 24, now: () => number = () => Date.now()) {
  let last = now();
  return {
    async tick(): Promise<void> {
      if (now() - last >= budgetMs) {
        await yieldToUi();
        last = now();
      }
    },
  };
}
