import type { Db, ScriptureRow } from "../db.js";
import { logger } from "../logger.js";
import { reportError } from "../sentry.js";
import { QuranMatcher } from "./quranMatcher.js";

export interface ParsedRef {
  tradition: string | undefined;
  book: string;
  chapter: number;
  verseFrom: number;
  verseTo: number;
  /** Canonical display form, e.g. "John 3:16-17". */
  display: string;
}

export interface ScriptureCard {
  ref: string;
  lang: string;
  text: string | null;
  verses: { verse: number; text: string }[];
  translationName: string | null;
}

const BOOK_ALIASES: Record<string, string> = {
  psalm: "Psalms",
  ps: "Psalms",
  "song of songs": "Song of Solomon",
  canticles: "Song of Solomon",
  revelations: "Revelation",
  "the revelation": "Revelation",
  "qur'an": "Quran",
  "qur’an": "Quran",
  koran: "Quran",
  "al-quran": "Quran",
};

const REF_RE = /^\s*(.+?)\s+(\d{1,3})\s*[:.]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*$/u;

export function parseScriptureRef(ref: string): ParsedRef | null {
  const m = REF_RE.exec(ref);
  if (!m) return null;
  const rawBook = m[1]!.replace(/\s+/g, " ").trim();
  const book = BOOK_ALIASES[rawBook.toLowerCase()] ?? rawBook;
  const chapter = Number(m[2]);
  const verseFrom = Number(m[3]);
  const verseTo = m[4] ? Number(m[4]) : verseFrom;
  if (!chapter || !verseFrom || verseTo < verseFrom || verseTo - verseFrom > 30) return null;
  const isQuran = book.toLowerCase() === "quran";
  return {
    tradition: isQuran ? "quran" : undefined,
    book,
    chapter,
    verseFrom,
    verseTo,
    display: `${book} ${chapter}:${verseFrom}${verseTo !== verseFrom ? `-${verseTo}` : ""}`,
  };
}

function toCards(ref: ParsedRef, rows: ScriptureRow[], langs: string[]): ScriptureCard[] {
  return langs.map((lang) => {
    // One row per verse; if several translations exist prefer the approved one.
    const byVerse = new Map<number, ScriptureRow>();
    for (const r of rows) {
      if (r.lang !== lang) continue;
      const cur = byVerse.get(r.verse);
      if (!cur || (!cur.is_approved && r.is_approved)) byVerse.set(r.verse, r);
    }
    const verses = [...byVerse.values()].sort((a, b) => a.verse - b.verse);
    return {
      ref: ref.display,
      lang,
      text: verses.length ? verses.map((v) => v.text).join(" ") : null,
      verses: verses.map((v) => ({ verse: v.verse, text: v.text })),
      translationName: verses[0]?.translation_name ?? null,
    };
  });
}

export class ScriptureService {
  private quran: Promise<QuranMatcher> | null = null;

  constructor(private readonly db: Db) {}

  async lookup(refStr: string, langs: string[]): Promise<ScriptureCard[] | null> {
    const ref = parseScriptureRef(refStr);
    if (!ref) {
      logger.debug({ ref: refStr }, "unparseable scripture ref");
      return null;
    }
    const rows = await this.db.getScripture({
      tradition: ref.tradition,
      book: ref.book,
      chapter: ref.chapter,
      verseFrom: ref.verseFrom,
      verseTo: ref.verseTo,
      langs,
    });
    return toCards(ref, rows, langs);
  }

  /** Approved Quran translations for a matched recitation. */
  async quranCards(chapter: number, verseFrom: number, verseTo: number, langs: string[]): Promise<ScriptureCard[]> {
    const ref: ParsedRef = {
      tradition: "quran",
      book: "Quran",
      chapter,
      verseFrom,
      verseTo,
      display: `Quran ${chapter}:${verseFrom}${verseTo !== verseFrom ? `-${verseTo}` : ""}`,
    };
    const rows = await this.db.getScripture({ tradition: "quran", book: "Quran", chapter, verseFrom, verseTo, langs });
    // Arabic is the source text; every other language must be an approved translation.
    return toCards(ref, rows.filter((r) => r.lang === "ar" || r.is_approved), langs);
  }

  /** Lazily load the Quran index once per process and share it across rooms. */
  quranMatcher(): Promise<QuranMatcher> {
    if (!this.quran) {
      const started = Date.now();
      this.quran = this.db
        .loadQuranArabic()
        .then((rows) => {
          const m = new QuranMatcher(rows);
          logger.info({ ayat: m.size, ms: Date.now() - started }, "quran index loaded");
          return m;
        })
        .catch((err) => {
          this.quran = null; // allow a retry later
          reportError(err, { component: "quran_index" });
          throw err;
        });
    }
    return this.quran;
  }
}
