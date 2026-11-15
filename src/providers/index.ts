import { config } from "../config.js";
import { AzureTtsProvider } from "./azureTts.js";
import { ClaudeTranslator } from "./claudeTranslator.js";
import { DeepgramProvider } from "./deepgram.js";
import type { SttProvider, Translator, TtsProvider } from "./types.js";

export interface Providers {
  stt: SttProvider;
  translator: Translator;
  tts: TtsProvider;
}

/** Composition root for vendors. Swap an adapter here to change provider. */
export function createProviders(): Providers {
  let voices: Record<string, string> | undefined;
  if (config.AZURE_TTS_VOICES) {
    try {
      voices = JSON.parse(config.AZURE_TTS_VOICES) as Record<string, string>;
    } catch {
      throw new Error("AZURE_TTS_VOICES must be a JSON object");
    }
  }
  return {
    stt: new DeepgramProvider(config.DEEPGRAM_API_KEY, config.DEEPGRAM_MODEL),
    translator: new ClaudeTranslator(config.ANTHROPIC_API_KEY, {
      model: config.TRANSLATION_MODEL,
      effort: config.TRANSLATION_EFFORT,
      timeoutMs: config.TRANSLATION_TIMEOUT_MS,
    }),
    tts: new AzureTtsProvider(config.AZURE_SPEECH_KEY, config.AZURE_SPEECH_REGION, config.AZURE_TTS_FORMAT, voices),
  };
}

export type { SttProvider, Translator, TtsProvider } from "./types.js";
