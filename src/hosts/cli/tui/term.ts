/**
 * Connect a {@link TuiApp} to a real terminal: the alternate screen, raw key
 * input, resize, and a full redraw after every key. Keys are handled one at a
 * time — an action that awaits the store finishes before the next key runs.
 * The terminal is always restored, however the app ends.
 */
import { emitKeypressEvents } from "node:readline";
import type { Key, TuiApp } from "./app.js";

export function runTerminal(app: TuiApp): Promise<void> {
  const { stdin, stdout } = process;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[?25l");

  const draw = () => {
    const rows = stdout.rows || 24;
    const cols = stdout.columns || 80;
    const frame = app.render(cols, rows);
    stdout.write("\x1b[H" + frame.map((l) => l + "\x1b[K").join("\r\n") + "\x1b[J");
  };
  app.onRedraw = draw;

  return new Promise((resolve) => {
    let queue = Promise.resolve();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      stdin.off("keypress", onKey);
      stdout.off("resize", draw);
      process.off("exit", restore);
      restore();
      stdin.pause();
      resolve();
    };
    const restore = () => {
      try {
        stdin.setRawMode(false);
      } catch {
        /* already closed */
      }
      stdout.write("\x1b[?25h\x1b[?1049l");
    };
    const onKey = (seq: string | undefined, key: Key | undefined) => {
      queue = queue.then(async () => {
        if (finished) return;
        try {
          await app.key(key ?? { sequence: seq });
        } catch (e) {
          app.flash(String((e as Error)?.message ?? e), true);
        }
        if (app.done) finish();
        else draw();
      });
    };
    stdin.on("keypress", onKey);
    stdout.on("resize", draw);
    process.on("exit", restore);
    draw();
  });
}
