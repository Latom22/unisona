import Stripe from "stripe";
import { config } from "../config.js";
import type { Db, UsageEventInsert } from "../db.js";
import { logger } from "../logger.js";
import { reportError } from "../sentry.js";

type Kind = UsageEventInsert["kind"];

/**
 * Accumulates speaking seconds per language and kind for one session.
 * Pending deltas are flushed to usage_events periodically and at session end;
 * session totals are reported to Stripe once the session ends.
 */
export class UsageTracker {
  private pending = new Map<string, number>();
  private totals = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly sessionId: string,
  ) {
    this.timer = setInterval(() => void this.flush(), config.USAGE_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  add(lang: string, kind: Kind, seconds: number): void {
    if (!(seconds > 0)) return;
    const key = `${lang}|${kind}`;
    this.pending.set(key, (this.pending.get(key) ?? 0) + seconds);
    this.totals.set(key, (this.totals.get(key) ?? 0) + seconds);
  }

  /** Total source speaking seconds (transcription), used as the billable session length. */
  get speakingSeconds(): number {
    let s = 0;
    for (const [k, v] of this.totals) if (k.endsWith("|transcription")) s += v;
    return s;
  }

  /** Seconds per language delivered (transcription for the source, translation for targets). */
  secondsByLanguage(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [k, v] of this.totals) {
      const [lang, kind] = k.split("|") as [string, Kind];
      if (kind === "tts") continue;
      out.set(lang, (out.get(lang) ?? 0) + v);
    }
    return out;
  }

  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (!this.pending.size) return;
      const snapshot = this.pending;
      this.pending = new Map();
      const rows: UsageEventInsert[] = [...snapshot].map(([k, seconds]) => {
        const [lang, kind] = k.split("|") as [string, Kind];
        return { org_id: this.orgId, session_id: this.sessionId, lang, kind, seconds: Math.round(seconds * 100) / 100 };
      });
      try {
        await this.db.insertUsageEvents(rows);
      } catch (err) {
        // Put the deltas back so the next flush retries them.
        for (const [k, v] of snapshot) this.pending.set(k, (this.pending.get(k) ?? 0) + v);
        reportError(err, { component: "usage_flush", sessionId: this.sessionId });
      }
    });
    return this.flushing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

const stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 3 }) : null;

/**
 * Report a finished session's usage to Stripe Billing Meters: one event per
 * language, value in seconds. The identifier makes retries idempotent.
 */
export async function reportUsageToStripe(input: {
  sessionId: string;
  stripeCustomerId: string | null;
  secondsByLanguage: Map<string, number>;
}): Promise<boolean> {
  if (!stripe) {
    logger.warn({ sessionId: input.sessionId }, "STRIPE_SECRET_KEY not set; skipping usage report");
    return false;
  }
  if (!input.stripeCustomerId) {
    logger.warn({ sessionId: input.sessionId }, "organization has no stripe_customer_id; skipping usage report");
    return false;
  }
  for (const [lang, seconds] of input.secondsByLanguage) {
    const value = Math.ceil(seconds);
    if (value <= 0) continue;
    await stripe.billing.meterEvents.create({
      event_name: config.STRIPE_METER_EVENT_NAME,
      identifier: `session:${input.sessionId}:${lang}`,
      payload: { stripe_customer_id: input.stripeCustomerId, value: String(value), language: lang },
    });
  }
  return true;
}
