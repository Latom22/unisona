import { describe, expect, it } from "vitest";
import { Segmenter, type Segment } from "../src/pipeline/segmenter.js";
import type { SttWord } from "../src/providers/types.js";

function words(text: string, start = 0, step = 0.3): SttWord[] {
  return text.split(" ").map((w, i) => ({ word: w.toLowerCase(), punctuated: w, start: start + i * step, end: start + i * step + 0.25 }));
}

function setup(maxWords = 18) {
  const out: Segment[] = [];
  let pending: (() => void) | null = null;
  const seg = new Segmenter({
    pauseMs: 600,
    maxWords,
    onSegment: (s) => out.push(s),
    setTimer: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  return { seg, out, fireTimer: () => pending?.() };
}

describe("Segmenter", () => {
  it("closes a segment on sentence punctuation", () => {
    const { seg, out } = setup();
    seg.pushFinal(words("Grace and peace to you. Let us"));
    expect(out.map((s) => s.text)).toEqual(["Grace and peace to you."]);
    expect(out[0]!.reason).toBe("punctuation");
    expect(seg.pendingText).toBe("Let us");
  });

  it("does not split on common abbreviations", () => {
    const { seg, out } = setup();
    seg.pushFinal(words("Welcome Rev. Smith today."));
    expect(out.map((s) => s.text)).toEqual(["Welcome Rev. Smith today."]);
  });

  it("splits at max words", () => {
    const { seg, out } = setup(5);
    seg.pushFinal(words("one two three four five six seven"));
    expect(out[0]!.text).toBe("one two three four five");
    expect(out[0]!.reason).toBe("max_words");
    expect(seg.pendingText).toBe("six seven");
  });

  it("splits on a 600ms gap between word timestamps", () => {
    const { seg, out } = setup();
    seg.pushFinal([...words("first part", 0), ...words("second part", 2)]);
    expect(out.map((s) => s.text)).toEqual(["first part"]);
    expect(out[0]!.reason).toBe("pause");
  });

  it("flushes on wall-clock silence", () => {
    const { seg, out, fireTimer } = setup();
    seg.pushFinal(words("and so we pray"));
    expect(out).toHaveLength(0);
    fireTimer();
    expect(out.map((s) => s.text)).toEqual(["and so we pray"]);
  });

  it("flushes on vendor endpoint and shows live text", () => {
    const { seg, out } = setup();
    seg.pushFinal(words("in the name"));
    expect(seg.liveText("of the")).toBe("in the name of the");
    seg.endpoint();
    expect(out[0]!.reason).toBe("endpoint");
    expect(seg.liveText("")).toBe("");
  });
});
