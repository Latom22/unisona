/**
 * Matches transcribed Arabic recitation against the Quran text so listeners get
 * the organisation's approved translation instead of machine translation.
 *
 * Approach: normalise Arabic (strip tashkeel, unify letter variants, drop clitic
 * prefixes), build an inverted index over ayat, generate candidates from rare
 * tokens, and score candidates (single ayah and ayah+next, for recitations that
 * cross an ayah boundary) by unigram + bigram containment of the transcript.
 */

export interface QuranMatch {
  chapter: number;
  verseFrom: number;
  verseTo: number;
  score: number;
}

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿ]/g;
const NON_ARABIC = /[^ء-ي\s]/g;

export function normalizeArabic(input: string): string {
  return input
    .replace(TASHKEEL, "")
    .replace(/ـ/g, "") // tatweel
    .replace(/[آأإٱ]/g, "ا") // آ أ إ ٱ -> ا
    .replace(/ى/g, "ي") // ى -> ي
    .replace(/ة/g, "ه") // ة -> ه
    .replace(/ؤ/g, "و") // ؤ -> و
    .replace(/ئ/g, "ي") // ئ -> ي
    .replace(/ء/g, "") // standalone hamza
    .replace(NON_ARABIC, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reduce a normalised token to a matching key: drop common clitic prefixes. */
export function tokenKey(token: string): string {
  let t = token;
  if (t.length > 3 && (t.startsWith("و") || t.startsWith("ف"))) t = t.slice(1);
  if (t.length > 3 && (t.startsWith("بال") || t.startsWith("كال") || t.startsWith("فال") || t.startsWith("وال"))) t = t.slice(3);
  else if (t.length > 3 && t.startsWith("لل")) t = t.slice(2);
  else if (t.length > 2 && t.startsWith("ال")) t = t.slice(2);
  // Uthmani script often writes a long vowel as a dagger alef (stripped above)
  // where everyday spelling has a full alef (الصرط vs الصراط): ignore medial alefs.
  if (t.length > 2) t = t[0] + t.slice(1).replace(/\u0627/g, "");
  return t;
}

export function tokenize(text: string): string[] {
  const n = normalizeArabic(text);
  return n ? n.split(" ").map(tokenKey).filter((t) => t.length > 0) : [];
}

export function arabicRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  const arabic = letters.filter((c) => /[؀-ۿݐ-ݿࢠ-ࣿ]/.test(c)).length;
  return arabic / letters.length;
}

interface Ayah {
  chapter: number;
  verse: number;
  tokens: string[];
  bigrams: Set<string>;
  tokenCounts: Map<string, number>;
}

function bigramsOf(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export class QuranMatcher {
  private readonly ayat: Ayah[] = [];
  private readonly index = new Map<string, number[]>();
  private readonly df = new Map<string, number>();

  constructor(rows: { chapter: number; verse: number; text: string }[]) {
    rows.forEach((r, i) => {
      const tokens = tokenize(r.text);
      this.ayat.push({
        chapter: r.chapter,
        verse: r.verse,
        tokens,
        bigrams: new Set(bigramsOf(tokens)),
        tokenCounts: counts(tokens),
      });
      for (const t of new Set(tokens)) {
        let list = this.index.get(t);
        if (!list) this.index.set(t, (list = []));
        list.push(i);
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    });
  }

  get size(): number {
    return this.ayat.length;
  }

  match(text: string, threshold: number): QuranMatch | null {
    const tokens = tokenize(text);
    if (tokens.length < 3 || !this.ayat.length) return null;

    // Candidate generation: weight hits by rarity (IDF-like).
    const n = this.ayat.length;
    const hits = new Map<number, number>();
    for (const t of new Set(tokens)) {
      const list = this.index.get(t);
      if (!list) continue;
      const weight = Math.log(1 + n / list.length);
      if (list.length > Math.max(50, n * 0.08)) continue; // too common to discriminate
      for (const idx of list) hits.set(idx, (hits.get(idx) ?? 0) + weight);
    }
    const candidates = [...hits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([idx]) => idx);

    const segBigrams = bigramsOf(tokens);
    let best: QuranMatch | null = null;
    for (const idx of candidates) {
      for (const span of [1, 2, 3]) {
        const group = this.ayat.slice(idx, idx + span);
        if (group.length < span || group.some((a) => a.chapter !== group[0]!.chapter)) break;
        const score = this.score(tokens, segBigrams, group);
        if (!best || score > best.score) {
          best = { chapter: group[0]!.chapter, verseFrom: group[0]!.verse, verseTo: group.at(-1)!.verse, score };
        }
      }
      // The recitation may also start at the end of the previous ayah.
      const prev = this.ayat[idx - 1];
      const cur = this.ayat[idx]!;
      if (prev && prev.chapter === cur.chapter) {
        const score = this.score(tokens, segBigrams, [prev, cur]);
        if (!best || score > best.score) best = { chapter: cur.chapter, verseFrom: prev.verse, verseTo: cur.verse, score };
      }
    }
    return best && best.score >= threshold ? best : null;
  }

  /** Fraction of the transcript found in the candidate text (penalise spans much longer than the transcript). */
  private score(tokens: string[], segBigrams: string[], group: Ayah[]): number {
    const pool = new Map<string, number>();
    const bigrams = new Set<string>();
    let length = 0;
    group.forEach((a, gi) => {
      for (const [t, c] of a.tokenCounts) pool.set(t, (pool.get(t) ?? 0) + c);
      for (const b of a.bigrams) bigrams.add(b);
      length += a.tokens.length;
      const next = group[gi + 1];
      if (next && a.tokens.length && next.tokens.length) bigrams.add(`${a.tokens.at(-1)} ${next.tokens[0]}`);
    });
    let uni = 0;
    for (const t of tokens) {
      const c = pool.get(t) ?? 0;
      if (c > 0) {
        uni++;
        pool.set(t, c - 1);
      }
    }
    const uniScore = uni / tokens.length;
    const biScore = segBigrams.length ? segBigrams.filter((b) => bigrams.has(b)).length / segBigrams.length : uniScore;
    const raw = 0.5 * uniScore + 0.5 * biScore;
    // Prefer the tightest span: small penalty when the candidate is far longer than what was heard.
    const lengthPenalty = Math.min(0.1, Math.max(0, (length - tokens.length * 2.5) / Math.max(1, length)) * 0.1);
    return raw - lengthPenalty;
  }
}
