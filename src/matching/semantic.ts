/**
 * Optional semantic fallback for annotations the token matcher leaves unmatched.
 *
 * When enabled, we embed the source's prose paragraphs and each unmatched
 * anchor with a local embedding model served by Ollama (e.g. `embeddinggemma`),
 * then link the anchor to its nearest paragraph by cosine similarity. This
 * rescues highlights/comments whose wording was paraphrased rather than quoted,
 * which token overlap alone can't catch.
 *
 * This module never imports `vscode` and fails soft: if Ollama is unreachable it
 * returns `{ ok: false }` and leaves the items untouched, so mapping still works
 * with the model off or absent.
 */
import type { ReviewItem } from "../model/types.js";
import { isStructuralLine } from "./normalize.js";

export interface SemanticOptions {
  /** Ollama base URL, e.g. http://localhost:11434 */
  url: string;
  /** Embedding model name, e.g. embeddinggemma / nomic-embed-text */
  model: string;
  /** Minimum cosine similarity to accept a semantic link. */
  threshold: number;
}

export interface SemanticResult {
  /** How many previously-unmatched items were linked. */
  applied: number;
  /** False when the embedding backend could not be reached at all. */
  ok: boolean;
}

/** A contiguous run of prose lines treated as one matchable unit. */
export interface SourceBlock {
  startLine: number;
  endLine: number;
  text: string;
}

/** Split source into paragraph blocks, skipping structural/blank lines. */
export function buildBlocks(source: string): SourceBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: SourceBlock[] = [];
  let start = -1;
  let buf: string[] = [];
  const flush = (endExclusive: number) => {
    if (start >= 0 && buf.length) {
      blocks.push({
        startLine: start,
        endLine: endExclusive - 1,
        text: buf.join(" ").replace(/\s+/g, " ").trim(),
      });
    }
    start = -1;
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (isStructuralLine(lines[i])) {
      flush(i);
      continue;
    }
    if (start < 0) start = i;
    buf.push(lines[i]);
  }
  flush(lines.length);
  return blocks.filter((b) => b.text.length > 0);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/** One embedding request; returns null on any failure (caller degrades). */
async function embed(
  url: string,
  model: string,
  input: string
): Promise<number[] | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: input.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embedding?: number[] };
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch {
    return null;
  }
}

/**
 * Link still-unmatched items to their nearest source paragraph by embedding
 * similarity. Mutates `items` in place; returns how many were linked and whether
 * the backend responded at all.
 */
export async function semanticFallback(
  items: ReviewItem[],
  source: string,
  opts: SemanticOptions
): Promise<SemanticResult> {
  const targets = items.filter(
    (it) =>
      !it.match &&
      it.manualLine == null &&
      (it.anchoredText || it.comment).trim().length > 0
  );
  if (targets.length === 0) return { applied: 0, ok: true };

  const blocks = buildBlocks(source);
  if (blocks.length === 0) return { applied: 0, ok: true };

  // Embed every paragraph once.
  const blockVecs: (number[] | null)[] = [];
  for (const b of blocks) {
    blockVecs.push(await embed(opts.url, opts.model, b.text));
  }
  if (blockVecs.every((v) => v === null)) return { applied: 0, ok: false };

  let applied = 0;
  for (const it of targets) {
    const query = (it.anchoredText || it.comment).trim();
    const qv = await embed(opts.url, opts.model, query);
    if (!qv) continue;

    let best = -1;
    let bestIdx = -1;
    for (let i = 0; i < blocks.length; i++) {
      const v = blockVecs[i];
      if (!v) continue;
      const s = cosine(qv, v);
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && best >= opts.threshold) {
      const b = blocks[bestIdx];
      it.match = {
        startLine: b.startLine,
        endLine: b.endLine,
        score: best,
        sourceExcerpt: b.text.slice(0, 200),
        method: "semantic",
      };
      applied++;
    }
  }
  return { applied, ok: true };
}
