import type { TtsProvider, TtsRequest } from "./types.js";

/** Default neural voices by base language. Override with AZURE_TTS_VOICES. */
const DEFAULT_VOICES: Record<string, string> = {
  en: "en-US-AvaMultilingualNeural",
  es: "es-MX-DaliaNeural",
  fr: "fr-FR-DeniseNeural",
  de: "de-DE-KatjaNeural",
  it: "it-IT-ElsaNeural",
  pt: "pt-BR-FranciscaNeural",
  ar: "ar-SA-ZariyahNeural",
  ur: "ur-PK-UzmaNeural",
  fa: "fa-IR-DilaraNeural",
  tr: "tr-TR-EmelNeural",
  id: "id-ID-GadisNeural",
  ms: "ms-MY-YasminNeural",
  bn: "bn-BD-NabanitaNeural",
  hi: "hi-IN-SwaraNeural",
  zh: "zh-CN-XiaoxiaoNeural",
  ko: "ko-KR-SunHiNeural",
  ja: "ja-JP-NanamiNeural",
  vi: "vi-VN-HoaiMyNeural",
  tl: "fil-PH-BlessicaNeural",
  fil: "fil-PH-BlessicaNeural",
  ru: "ru-RU-SvetlanaNeural",
  uk: "uk-UA-PolinaNeural",
  pl: "pl-PL-AgnieszkaNeural",
  ro: "ro-RO-AlinaNeural",
  sw: "sw-KE-ZuriNeural",
  am: "am-ET-MekdesNeural",
  so: "so-SO-UbaxNeural",
  he: "he-IL-HilaNeural",
  nl: "nl-NL-FennaNeural",
  ht: "fr-FR-DeniseNeural",
};

const MIME_BY_PREFIX: [string, string][] = [
  ["audio-", "audio/mpeg"],
  ["ogg-", "audio/ogg; codecs=opus"],
  ["webm-", "audio/webm; codecs=opus"],
  ["raw-", "audio/L16"],
  ["riff-", "audio/wav"],
];

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export class AzureTtsProvider implements TtsProvider {
  readonly name = "azure";
  readonly mimeType: string;
  private readonly voices: Record<string, string>;
  private readonly endpoint: string;

  constructor(
    private readonly key: string,
    region: string,
    private readonly format: string,
    voiceOverrides?: Record<string, string>,
  ) {
    this.endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    this.voices = { ...DEFAULT_VOICES, ...voiceOverrides };
    this.mimeType = MIME_BY_PREFIX.find(([p]) => format.startsWith(p))?.[1] ?? "application/octet-stream";
  }

  private voiceFor(lang: string): string | undefined {
    return this.voices[lang] ?? this.voices[lang.split("-")[0]!.toLowerCase()];
  }

  supports(lang: string): boolean {
    return Boolean(this.voiceFor(lang));
  }

  async *synthesize(req: TtsRequest, signal?: AbortSignal): AsyncIterable<Buffer> {
    const voice = this.voiceFor(req.lang);
    if (!voice) throw new Error(`No Azure voice configured for ${req.lang}`);
    const xmlLang = voice.split("-").slice(0, 2).join("-");
    const body = escapeXml(req.text);
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}">` +
      `<voice name="${voice}">${body}</voice></speak>`;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": this.format,
        "User-Agent": "unisona-realtime",
      },
      body: ssml,
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Azure TTS ${res.status}: ${detail.slice(0, 200)}`);
    }
    // Azure streams the encoded audio as it is synthesised; forward chunks as they arrive.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      yield Buffer.from(chunk);
    }
  }
}
