import { pino } from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: {
    service: "unisona-realtime",
    version: config.APP_VERSION,
    machine: config.FLY_MACHINE_ID,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: ["token", "*.token", "req.headers.authorization", "headers.authorization", "apiKey", "*.apiKey"],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
