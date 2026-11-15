import * as Sentry from "@sentry/node";
import { config } from "./config.js";
import { logger } from "./logger.js";

const enabled = Boolean(config.SENTRY_DSN);

if (enabled) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    release: config.APP_VERSION,
    environment: config.NODE_ENV,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
  });
}

/** Log and report an error with structured context. Never throws. */
export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  logger.error({ err, ...context }, err instanceof Error ? err.message : "error");
  if (!enabled) return;
  try {
    Sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
      if (typeof context.roomId === "string") scope.setTag("room_id", context.roomId);
      if (typeof context.sessionId === "string") scope.setTag("session_id", context.sessionId);
      if (typeof context.component === "string") scope.setTag("component", context.component);
      Sentry.captureException(err);
    });
  } catch {
    /* ignore */
  }
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs).catch(() => undefined);
}
