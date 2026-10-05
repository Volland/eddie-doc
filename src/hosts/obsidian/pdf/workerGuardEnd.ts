import { savedPdfjsWorker } from "./workerGuardBegin.js";

/** Second half of the guard: put the global back exactly as it was found. */
const g = window as unknown as { pdfjsWorker?: unknown };
if (savedPdfjsWorker.had) g.pdfjsWorker = savedPdfjsWorker.value;
else delete g.pdfjsWorker;
