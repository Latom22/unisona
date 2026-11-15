/**
 * Vendor-neutral provider interfaces. The pipeline depends only on these, so
 * Deepgram / Claude / Azure can be swapped by writing another adapter and
 * changing `providers/index.ts`.
 */

// ---------- Speech-to-text ----------

export interface SttWord {
  word: string;
  /** Word as it should be displayed (with punctuation/casing) if the vendor provides it. */
  punctuated?: string;
  /** Seconds from start of the STT stream. */
  start: number;
  end: number;
}

export interface SttResult {
  /** true = this chunk of words will not change any more. */
  isFinal: boolean;
  /** Vendor's end-of-utterance signal (silence after speech). */
  speechFinal: boolean;
  transcript: string;
  words: SttWord[];
  /** BCP-47 language the vendor detected for this chunk, when it reports one. */
  detectedLanguage?: string;
}

export interface SttStreamOptions {
  /** BCP-47 source language, e.g. "en", "ar", or "multi" for code-switching. */
  language: string;
  /** Terms to boost (glossary). */
  keywords: { term: string; boost?: number }[];
  /** Raw PCM parameters. Omit for containerised audio (webm/ogg) which is auto-detected. */
  encoding?: "linear16" | "opus";
  sampleRate?: number;
  /** Silence (ms) that counts as end of utterance. */
  endpointingMs: number;
}

export interface SttStreamEvents {
  onResult(result: SttResult): void;
  /** Vendor signalled an utterance end (no words for a while). */
  onUtteranceEnd(): void;
  /** Stream became usable (also fired after a successful reconnect). */
  onOpen?(): void;
  /** Unrecoverable failure (reconnects exhausted). */
  onFatal(err: Error): void;
}

export interface SttStream {
  sendAudio(chunk: Buffer): void;
  /** Flush and close gracefully. */
  close(): Promise<void>;
}

export interface SttProvider {
  readonly name: string;
  openStream(opts: SttStreamOptions, events: SttStreamEvents): SttStream;
}

// ---------- Translation ----------

export interface GlossaryEntry {
  term: string;
  /** Preferred translation per target language. */
  translations: Record<string, string>;
  doNotTranslate: boolean;
}

/** Stable per-session context. Implementations may cache prompts derived from it. */
export interface TranslationContext {
  faithType: string | null;
  tradition: string | null;
  sourceLang: string;
  glossary: GlossaryEntry[];
  doNotTranslate: string[];
}

export interface TranslationRequest {
  text: string;
  targetLang: string;
  /** Up to the last two source sentences, oldest first. */
  previous: string[];
}

export interface TranslationResult {
  text: string;
  /** Canonical reference such as "John 3:16", "Psalm 23:1-3" or "Quran 2:255"; null if none. */
  scriptureRef: string | null;
}

export interface Translator {
  readonly name: string;
  translate(ctx: TranslationContext, req: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult | null>;
}

// ---------- Text-to-speech ----------

export interface TtsRequest {
  text: string;
  lang: string;
}

export interface TtsProvider {
  readonly name: string;
  /** MIME type of the produced audio, sent to clients in `audio_start`. */
  readonly mimeType: string;
  supports(lang: string): boolean;
  /** Yields encoded audio chunks as they arrive from the vendor. */
  synthesize(req: TtsRequest, signal?: AbortSignal): AsyncIterable<Buffer>;
}
