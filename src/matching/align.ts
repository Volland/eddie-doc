/**
 * Character-level alignment between stripped PDF text and raw AsciiDoc source.
 *
 * Line matching (see fuzzyMatch) finds *which* line an annotation belongs to.
 * To edit precisely we need *which characters* — but the PDF text has no
 * AsciiDoc markup while the source does (`*bold*`, `_em_`, macros, wrapping).
 *
 * We build a monotonic normalization of the raw text: every raw character maps
 * to at most one normalized character (letters/digits lowercased, everything
 * else collapsed to a single space). Because it's monotonic we can carry an
 * offset map alongside it and translate a normalized substring back to a raw
 * character range. The struck/inserted text is normalized the same way and
 * located inside the raw span.
 */

export interface NormMap {
  /** Normalized text: lowercased alnum + single-space separators, trimmed. */
  norm: string;
  /** map[i] = index in the raw input of the i-th normalized character. */
  map: number[];
}

function isAlnum(code: number): boolean {
  // ASCII digits/letters fast path, then any Unicode letter/number.
  if (code >= 48 && code <= 57) return true;
  if (code >= 97 && code <= 122) return true;
  if (code >= 65 && code <= 90) return true;
  const ch = String.fromCharCode(code);
  return /[\p{L}\p{N}]/u.test(ch);
}

/** Monotonic normalization with a raw-offset map for each emitted character. */
export function normalizeWithMap(raw: string): NormMap {
  const norm: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true; // trims leading whitespace
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (isAlnum(ch.codePointAt(0)!)) {
      norm.push(ch.toLowerCase());
      map.push(i);
      lastWasSpace = false;
    } else if (!lastWasSpace) {
      norm.push(" ");
      map.push(i);
      lastWasSpace = true;
    }
  }
  // Trim a trailing collapsed space.
  if (norm.length && norm[norm.length - 1] === " ") {
    norm.pop();
    map.pop();
  }
  return { norm: norm.join(""), map };
}

export interface RawRange {
  /** Inclusive start offset into the raw input. */
  start: number;
  /** Exclusive end offset into the raw input. */
  end: number;
  /** 0-1 confidence (1 = exact normalized substring hit). */
  score: number;
}

/**
 * Locate `needle` inside `rawHaystack`, returning a raw character range. Tries
 * an exact normalized-substring match first, then a best-effort fuzzy window.
 * Returns null when nothing plausible is found.
 */
export function locate(
  needle: string,
  rawHaystack: string,
  minScore = 0.8
): RawRange | null {
  const hay = normalizeWithMap(rawHaystack);
  const target = normalizeWithMap(needle).norm;
  if (!target || !hay.norm) return null;

  const idx = hay.norm.indexOf(target);
  if (idx >= 0) {
    return {
      start: hay.map[idx],
      end: hay.map[idx + target.length - 1] + 1,
      score: 1,
    };
  }

  // Fuzzy fallback: slide a target-length window, score by matching chars.
  const L = target.length;
  if (hay.norm.length < L) {
    const s = charSim(target, hay.norm);
    if (s >= minScore)
      return { start: hay.map[0], end: hay.map[hay.map.length - 1] + 1, score: s };
    return null;
  }
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i + L <= hay.norm.length; i++) {
    const s = charSim(target, hay.norm.substr(i, L));
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  if (best >= 0 && bestScore >= minScore) {
    return {
      start: hay.map[best],
      end: hay.map[best + L - 1] + 1,
      score: bestScore,
    };
  }
  return null;
}

/** Fraction of positions that match between two equal-length-ish strings. */
function charSim(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let same = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return same / Math.max(a.length, b.length);
}
