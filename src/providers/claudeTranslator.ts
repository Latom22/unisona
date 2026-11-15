import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { logger } from "../logger.js";
import type { TranslationContext, TranslationRequest, TranslationResult, Translator } from "./types.js";

const OutputSchema = z.object({
  text: z.string(),
  scripture_ref: z.string().nullable(),
});

const OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "The translation in the target language." },
    scripture_ref: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Canonical scripture reference quoted or cited in the source, else null.",
    },
  },
  required: ["text", "scripture_ref"],
  additionalProperties: false,
} as const;

export interface ClaudeTranslatorOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
}

export class ClaudeTranslator implements Translator {
  readonly name = "claude";
  private readonly client: Anthropic;
  /** System prompts are stable per session; memoise so the bytes are identical (prompt-cache friendly). */
  private readonly systemCache = new WeakMap<TranslationContext, string>();

  constructor(
    apiKey: string,
    private readonly opts: ClaudeTranslatorOptions,
  ) {
    // Realtime: one quick retry is better than the default two slow ones.
    this.client = new Anthropic({ apiKey, timeout: opts.timeoutMs, maxRetries: 1 });
  }

  async translate(
    ctx: TranslationContext,
    req: TranslationRequest,
    signal?: AbortSignal,
  ): Promise<TranslationResult | null> {
    const system = this.systemPrompt(ctx);
    const context = req.previous.length
      ? `Previous sentences (context only, do not translate):\n${req.previous.map((s) => `- ${s}`).join("\n")}\n\n`
      : "";
    const glossaryForLang = ctx.glossary
      .filter((g) => !g.doNotTranslate && g.translations[req.targetLang])
      .map((g) => `- ${g.term} → ${g.translations[req.targetLang]}`);
    const glossaryBlock = glossaryForLang.length
      ? `Required glossary for ${req.targetLang}:\n${glossaryForLang.join("\n")}\n\n`
      : "";

    const user =
      `${glossaryBlock}${context}` +
      `Target language: ${req.targetLang}\n` +
      `Translate this segment:\n<segment>\n${req.text}\n</segment>`;

    const response = await this.client.beta.messages.create(
      {
        model: this.opts.model,
        max_tokens: 2048,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: this.opts.effort,
          format: { type: "json_schema", schema: OUTPUT_JSON_SCHEMA },
        },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      },
      { signal },
    );

    if (response.stop_reason === "refusal") {
      logger.warn({ category: response.stop_details?.category, lang: req.targetLang }, "translation refused");
      return null;
    }
    if (response.stop_reason === "max_tokens") {
      logger.warn({ lang: req.targetLang }, "translation truncated");
      return null;
    }

    const raw = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let parsed: z.infer<typeof OutputSchema>;
    try {
      parsed = OutputSchema.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err, lang: req.targetLang }, "translation output was not valid JSON");
      return null;
    }
    const ref = parsed.scripture_ref?.trim();
    return { text: parsed.text.trim(), scriptureRef: ref ? ref : null };
  }

  private systemPrompt(ctx: TranslationContext): string {
    const cached = this.systemCache.get(ctx);
    if (cached) return cached;

    const faith = [ctx.faithType, ctx.tradition].filter(Boolean).join(" / ") || "unspecified";
    const glossary = ctx.glossary
      .filter((g) => !g.doNotTranslate)
      .map((g) => {
        const t = Object.entries(g.translations)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([l, v]) => `${l}: ${v}`)
          .join("; ");
        return `- ${g.term}${t ? ` (${t})` : ""}`;
      });
    const dnt = [...new Set(ctx.doNotTranslate)].sort();

    const prompt = [
      `You translate live speech during a religious service for listeners who speak another language. The congregation's faith is ${faith}. The speaker's language is ${ctx.sourceLang}.`,
      "",
      "The input is one segment of an automatic speech transcript, so it may be a sentence fragment or contain recognition errors. Translate it faithfully and naturally into the target language, using the register and terminology this tradition uses in that language. Keep fragments as fragments rather than completing them, and do not add commentary, explanations or anything not in the segment. Use the previous sentences only to resolve pronouns, terms and ambiguity.",
      "",
      "When a glossary term appears, use the given translation for the target language. Terms on the do-not-translate list must appear exactly as written (you may transliterate only if the target script requires it).",
      "",
      "Set scripture_ref when the segment quotes or explicitly cites a scripture passage; otherwise null. Use canonical English book names and chapter:verse, e.g. \"John 3:16\", \"Psalm 23:1-3\", \"1 Corinthians 13:4\". For the Quran use \"Quran <surah>:<ayah>\", e.g. \"Quran 2:255\". Only give a reference you are confident of.",
      "",
      `Glossary:\n${glossary.length ? glossary.join("\n") : "(none)"}`,
      "",
      `Do not translate:\n${dnt.length ? dnt.map((t) => `- ${t}`).join("\n") : "(none)"}`,
    ].join("\n");

    this.systemCache.set(ctx, prompt);
    return prompt;
  }
}
