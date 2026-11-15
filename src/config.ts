import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const EnvSchema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default("info"),
  APP_VERSION: z.string().default("dev"),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /** Legacy HS256 JWT secret. If unset, tokens are verified against the project's JWKS. */
  SUPABASE_JWT_SECRET: z.string().optional(),

  // Deepgram
  DEEPGRAM_API_KEY: z.string().min(1),
  DEEPGRAM_MODEL: z.string().default("nova-3"),

  // Translation (Claude)
  ANTHROPIC_API_KEY: z.string().min(1),
  TRANSLATION_MODEL: z.string().default("claude-opus-5-5"),
  /** Live captions are latency-sensitive; raise if quality on your content needs it. */
  TRANSLATION_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  TRANSLATION_TIMEOUT_MS: z.coerce.number().int().default(10_000),

  // Azure Neural TTS
  AZURE_SPEECH_KEY: z.string().min(1),
  AZURE_SPEECH_REGION: z.string().min(1),
  AZURE_TTS_FORMAT: z.string().default("audio-24khz-48kbitrate-mono-mp3"),
  /** JSON object overriding default voices, e.g. {"es":"es-MX-DaliaNeural"} */
  AZURE_TTS_VOICES: z.string().optional(),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_METER_EVENT_NAME: z.string().default("unisona_speaking_seconds"),

  // Sentry
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().default(0),

  // Behaviour
  BROADCASTER_GRACE_MS: z.coerce.number().int().default(30_000),
  SEGMENT_PAUSE_MS: z.coerce.number().int().default(600),
  SEGMENT_MAX_WORDS: z.coerce.number().int().default(18),
  USAGE_FLUSH_INTERVAL_MS: z.coerce.number().int().default(60_000),
  QURAN_MATCH_THRESHOLD: z.coerce.number().default(0.72),
  CAPTION_HISTORY: z.coerce.number().int().default(8),
  ALLOWED_ORIGINS: z.string().optional(),
  FLY_MACHINE_ID: z.string().optional(),
  DISABLE_FLY_REPLAY: bool,
});

export type Config = z.infer<typeof EnvSchema>;

function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    // Logger depends on config, so write directly.
    process.stderr.write(`Invalid environment:\n  ${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const config: Config = load();

export const allowedOrigins: string[] | null = config.ALLOWED_ORIGINS
  ? config.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : null;
