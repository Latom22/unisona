import { describe, expect, it } from "vitest";
import { arabicRatio, normalizeArabic, QuranMatcher } from "../src/pipeline/quranMatcher.js";
import { parseScriptureRef } from "../src/pipeline/scripture.js";

// Al-Fatiha (1:1-7) and Ayat al-Kursi opening (2:255, truncated), with tashkeel.
const ROWS = [
  { chapter: 1, verse: 1, text: "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ" },
  { chapter: 1, verse: 2, text: "ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ" },
  { chapter: 1, verse: 3, text: "ٱلرَّحْمَٰنِ ٱلرَّحِيمِ" },
  { chapter: 1, verse: 4, text: "مَٰلِكِ يَوْمِ ٱلدِّينِ" },
  { chapter: 1, verse: 5, text: "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ" },
  { chapter: 1, verse: 6, text: "ٱهْدِنَا ٱلصِّرَٰطَ ٱلْمُسْتَقِيمَ" },
  { chapter: 1, verse: 7, text: "صِرَٰطَ ٱلَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ ٱلْمَغْضُوبِ عَلَيْهِمْ وَلَا ٱلضَّآلِّينَ" },
  { chapter: 2, verse: 255, text: "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ ۚ لَا تَأْخُذُهُۥ سِنَةٌ وَلَا نَوْمٌ" },
  { chapter: 112, verse: 1, text: "قُلْ هُوَ ٱللَّهُ أَحَدٌ" },
  { chapter: 112, verse: 2, text: "ٱللَّهُ ٱلصَّمَدُ" },
];

describe("Quran matching", () => {
  const matcher = new QuranMatcher(ROWS);

  it("normalises diacritics and letter variants", () => {
    expect(normalizeArabic("ٱلْحَمْدُ لِلَّهِ")).toBe("الحمد لله");
    expect(normalizeArabic("إِيَّاكَ")).toBe("اياك");
  });

  it("detects Arabic script", () => {
    expect(arabicRatio("الحمد لله رب العالمين")).toBe(1);
    expect(arabicRatio("Today we read الفاتحة together")).toBeLessThan(0.6);
  });

  it("matches an undiacritised transcript to the right ayah", () => {
    const m = matcher.match("اياك نعبد واياك نستعين", 0.72);
    expect(m).toMatchObject({ chapter: 1, verseFrom: 5, verseTo: 5 });
  });

  it("matches recitation crossing an ayah boundary", () => {
    const m = matcher.match("اهدنا الصراط المستقيم صراط الذين انعمت عليهم", 0.72);
    expect(m?.chapter).toBe(1);
    expect(m?.verseFrom).toBe(6);
    expect(m?.verseTo).toBe(7);
  });

  it("matches a partial ayah", () => {
    const m = matcher.match("الله لا اله الا هو الحي القيوم", 0.72);
    expect(m).toMatchObject({ chapter: 2, verseFrom: 255 });
  });

  it("rejects ordinary Arabic speech", () => {
    expect(matcher.match("نرحب بكم جميعا في المسجد اليوم ونشكركم على الحضور", 0.72)).toBeNull();
  });
});

describe("parseScriptureRef", () => {
  it("parses bible and quran refs", () => {
    expect(parseScriptureRef("John 3:16")).toMatchObject({ book: "John", chapter: 3, verseFrom: 16, verseTo: 16 });
    expect(parseScriptureRef("Psalm 23:1-3")).toMatchObject({ book: "Psalms", verseFrom: 1, verseTo: 3, display: "Psalms 23:1-3" });
    expect(parseScriptureRef("1 Corinthians 13:4")).toMatchObject({ book: "1 Corinthians", chapter: 13 });
    expect(parseScriptureRef("Quran 2:255")).toMatchObject({ tradition: "quran", chapter: 2, verseFrom: 255 });
  });

  it("rejects garbage", () => {
    expect(parseScriptureRef("the gospel")).toBeNull();
    expect(parseScriptureRef("John 3:20-10")).toBeNull();
  });
});
