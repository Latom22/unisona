import type { SttWord } from "../providers/types.js";

export interface Segment {
  text: string;
  words: SttWord[];
  /** Seconds, STT stream clock. */
  start: number;
  end: number;
  reason: "punctuation" | "pause" | "max_words" | "endpoint" | "flush";
}

export interface SegmenterOptions {
  pauseMs: number;
  maxWords: number;
  onSegment(seg: Segment): void;
  /** Injectable timers for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const SENTENCE_END = /[.!?؟。！？۔]["'”’»)\]]*$/u;
const ABBREVIATIONS = new Set(["mr.", "mrs.", "ms.", "dr.", "st.", "rev.", "fr.", "sr.", "jr.", "vs.", "etc.", "e.g.", "i.e.", "ch.", "vv.", "v."]);

export function wordText(w: SttWord): string {
  return w.punctuated ?? w.word;
}

export function endsSentence(token: string): boolean {
  if (!SENTENCE_END.test(token)) return false;
  return !ABBREVIATIONS.has(token.toLowerCase());
}

/**
 * Turns a stream of finalized STT words into caption segments. A segment closes on:
 *  - sentence-ending punctuation,
 *  - a pause of `pauseMs` (gap between word timestamps, a vendor endpoint, or wall-clock silence),
 *  - `maxWords` words.
 */
export class Segmenter {
  private buffer: SttWord[] = [];
  private timer: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly opts: SegmenterOptions) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get pendingText(): string {
    return this.buffer.map(wordText).join(" ");
  }

  /** Text to show live: finalized-but-unsegmented words followed by the current interim hypothesis. */
  liveText(interimTranscript: string): string {
    return [this.pendingText, interimTranscript.trim()].filter(Boolean).join(" ");
  }

  pushFinal(words: SttWord[]): void {
    const pauseSec = this.opts.pauseMs / 1000;
    for (const w of words) {
      const last = this.buffer.at(-1);
      if (last && w.start - last.end >= pauseSec) this.emit("pause");
      this.buffer.push(w);
      if (endsSentence(wordText(w))) this.emit("punctuation");
      else if (this.buffer.length >= this.opts.maxWords) this.emit("max_words");
    }
    this.armTimer();
  }

  /** Interim words arriving means the speaker is still talking; postpone the silence timer. */
  noteInterimActivity(hasWords: boolean): void {
    if (hasWords && this.buffer.length) this.armTimer();
  }

  /** Vendor detected end of speech. */
  endpoint(): void {
    this.emit("endpoint");
  }

  flush(): void {
    this.emit("flush");
  }

  dispose(): void {
    this.cancelTimer();
    this.buffer = [];
  }

  private armTimer(): void {
    this.cancelTimer();
    if (!this.buffer.length) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.emit("pause");
    }, this.opts.pauseMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private emit(reason: Segment["reason"]): void {
    if (!this.buffer.length) return;
    const words = this.buffer;
    this.buffer = [];
    this.cancelTimer();
    const text = words.map(wordText).join(" ").trim();
    if (!text) return;
    this.opts.onSegment({ text, words, start: words[0]!.start, end: words.at(-1)!.end, reason });
  }
}
