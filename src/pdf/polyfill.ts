// pdfjs-dist 4.x calls `Promise.withResolvers`, which only exists on Node 22+.
// The VS Code extension host runs an older Node (18–20), so this method is
// `undefined` there and `getDocument()` throws "Promise.withResolvers is not a
// function". Polyfill it. This module MUST be imported before pdfjs so the
// patch is applied before pdfjs' module code runs.
const P = Promise as unknown as {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};

if (typeof P.withResolvers !== "function") {
  P.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
