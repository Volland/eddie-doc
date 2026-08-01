/**
 * Zero-dependency lexical fallback for annotations the token matcher leaves
 * unmatched. Where the fuzzy matcher compares whole tokens (so an inflected or
 * typo'd word contributes nothing), this tier compares character trigrams:
 * "statements"/"statement" or "знання"/"знань" still share most of their
 * grams. Each unmatched anchor is scored against the source's paragraph blocks
 * by IDF-weighted trigram *containment* — how much of the anchor's gram mass
 * the paragraph covers — which stays comparable whether the paragraph is one
 * line or ten.
 *
 * Runs entirely in-process (no Ollama, no network); it's the always-available
 * sibling of the embedding fallback in `semantic.ts`.
 */
import type { ReviewItem } from "../model/types.js";
import { normalizeText } from "./normalize.js";
import { buildBlocks } from "./semantic.js";

const N = 3;

/** Bag of character trigrams over normalized text (space-padded, no all-space grams). */
export function charGrams(text: string): Map<string, number> {
  const s = normalizeText(text);
  const m = new Map<string, number>();
  if (!s) return m;
  const padded = ` ${s} `;
  for (let i = 0; i + N <= padded.length; i++) {
    const g = padded.slice(i, i + N);
    if (!g.trim()) continue;
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/**
 * Link still-unmatched items to their best source paragraph by trigram
 * containment. Mutates `items` in place; returns how many were linked.
 * Anchors with fewer than `MIN_GRAMS` distinct grams are left alone — too
 * little signal to place responsibly.
 */
export function lexicalFallback(
  items: ReviewItem[],
  source: string,
  threshold: number
): number {
  const targets = items.filter(
    (it) =>
      !it.match &&
      it.manualLine == null &&
      (it.anchoredText || it.comment).trim().length > 0
  );
  if (targets.length === 0) return 0;

  const blocks = buildBlocks(source);
  if (blocks.length === 0) return 0;

  const blockGrams = blocks.map((b) => charGrams(b.text));
  // Document frequency over blocks: grams shared by every paragraph ("the ")
  // say little about which paragraph an anchor belongs to.
  const df = new Map<string, number>();
  for (const bg of blockGrams) {
    for (const g of bg.keys()) df.set(g, (df.get(g) || 0) + 1);
  }
  // Grams absent from the source keep the highest weight: they can never be
  // covered, and their share of the denominator is what rejects paraphrases.
  const idf = (g: string) => Math.log(1 + blocks.length / (df.get(g) ?? 0.5));

  const MIN_GRAMS = 6;
  let applied = 0;
  for (const it of targets) {
    const q = charGrams(it.anchoredText || it.comment);
    if (q.size < MIN_GRAMS) continue;
    let denom = 0;
    for (const [g, c] of q) denom += c * idf(g);
    if (denom <= 0) continue;

    let best = 0;
    let bestIdx = -1;
    for (let i = 0; i < blocks.length; i++) {
      const bg = blockGrams[i];
      let num = 0;
      for (const [g, c] of q) {
        const bc = bg.get(g);
        if (bc) num += Math.min(c, bc) * idf(g);
      }
      const s = num / denom;
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && best >= threshold) {
      const b = blocks[bestIdx];
      it.match = {
        startLine: b.startLine,
        endLine: b.endLine,
        score: best,
        sourceExcerpt: b.text.slice(0, 200),
        method: "lexical",
      };
      applied++;
    }
  }
  return applied;
}
