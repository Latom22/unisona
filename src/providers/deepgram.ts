import WebSocket from "ws";
import { logger } from "../logger.js";
import { backoffDelay } from "../util/backoff.js";
import type { SttProvider, SttResult, SttStream, SttStreamEvents, SttStreamOptions, SttWord } from "./types.js";

const DG_URL = "wss://api.deepgram.com/v1/listen";
const MAX_RECONNECT_ATTEMPTS = 8;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const KEEPALIVE_MS = 8_000;
const MAX_KEYWORDS = 100;

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  language?: string;
}

interface DgMessage {
  type: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: { transcript: string; words?: DgWord[]; languages?: string[] }[];
    detected_language?: string;
  };
}

export class DeepgramProvider implements SttProvider {
  readonly name = "deepgram";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  openStream(opts: SttStreamOptions, events: SttStreamEvents): SttStream {
    return new DeepgramStream(this.apiKey, this.buildUrl(opts), opts, events);
  }

  buildUrl(opts: SttStreamOptions): string {
    const params = new URLSearchParams({
      model: this.model,
      language: opts.language,
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: String(opts.endpointingMs),
      utterance_end_ms: String(Math.max(1000, opts.endpointingMs)),
      vad_events: "true",
    });
    if (opts.encoding) {
      params.set("encoding", opts.encoding);
      params.set("sample_rate", String(opts.sampleRate ?? 16000));
      params.set("channels", "1");
    }
    // Nova-3 uses `keyterm` prompting; older models use `keywords=term:boost`.
    const nova3 = this.model.startsWith("nova-3");
    for (const kw of opts.keywords.slice(0, MAX_KEYWORDS)) {
      const term = kw.term.trim();
      if (!term) continue;
      if (nova3) params.append("keyterm", term);
      else params.append("keywords", `${term}:${kw.boost ?? 2}`);
    }
    return `${DG_URL}?${params.toString()}`;
  }
}

class DeepgramStream implements SttStream {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempts = 0;
  private buffer: Buffer[] = [];
  private bufferBytes = 0;
  /** First container chunk (WebM/Ogg header); replayed after reconnects. */
  private initChunk: Buffer | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private lastSendAt = Date.now();
  /** Timestamps restart at 0 on every new connection; keep them monotonic. */
  private timeOffset = 0;
  private maxEndSeen = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly log;

  constructor(
    private readonly apiKey: string,
    private readonly url: string,
    private readonly opts: SttStreamOptions,
    private readonly events: SttStreamEvents,
  ) {
    this.log = logger.child({ component: "deepgram" });
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url, { headers: { Authorization: `Token ${this.apiKey}` } });
    this.ws = ws;

    ws.on("open", () => {
      this.log.info({ attempt: this.attempts }, "deepgram connected");
      this.attempts = 0;
      if (this.initChunk && !this.opts.encoding) ws.send(this.initChunk);
      for (const chunk of this.buffer) ws.send(chunk);
      this.buffer = [];
      this.bufferBytes = 0;
      this.lastSendAt = Date.now();
      this.startKeepAlive();
      this.events.onOpen?.();
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: DgMessage;
      try {
        msg = JSON.parse(data.toString()) as DgMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    ws.on("unexpected-response", (_req, res) => {
      this.log.warn({ status: res.statusCode, dgError: res.headers["dg-error"] }, "deepgram rejected connection");
    });

    ws.on("error", (err) => {
      this.log.warn({ err: err.message }, "deepgram socket error");
    });

    ws.on("close", (code, reason) => {
      this.stopKeepAlive();
      if (this.ws === ws) this.ws = null;
      if (this.closedByUser) return;
      this.log.warn({ code, reason: reason.toString() }, "deepgram closed unexpectedly");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
      this.events.onFatal(new Error(`Deepgram reconnect failed after ${this.attempts} attempts`));
      return;
    }
    // New connection's clock starts at 0; continue from the last word we saw.
    this.timeOffset = this.maxEndSeen;
    const delay = backoffDelay(this.attempts++, { baseMs: 300, maxMs: 8_000 });
    this.log.info({ delay, attempt: this.attempts }, "deepgram reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private handleMessage(msg: DgMessage): void {
    if (msg.type === "Results") {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const words: SttWord[] = (alt.words ?? []).map((w) => ({
        word: w.word,
        punctuated: w.punctuated_word,
        start: w.start + this.timeOffset,
        end: w.end + this.timeOffset,
      }));
      const last = words.at(-1);
      if (last && last.end > this.maxEndSeen) this.maxEndSeen = last.end;
      const result: SttResult = {
        isFinal: Boolean(msg.is_final),
        speechFinal: Boolean(msg.speech_final),
        transcript: alt.transcript ?? "",
        words,
        detectedLanguage: msg.channel?.detected_language ?? alt.languages?.[0] ?? alt.words?.[0]?.language,
      };
      this.events.onResult(result);
    } else if (msg.type === "UtteranceEnd") {
      this.events.onUtteranceEnd();
    }
  }

  sendAudio(chunk: Buffer): void {
    if (this.closedByUser) return;
    if (!this.initChunk && !this.opts.encoding) this.initChunk = chunk;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
      this.lastSendAt = Date.now();
      return;
    }
    // Buffer while (re)connecting; drop oldest if the outage is long.
    this.buffer.push(chunk);
    this.bufferBytes += chunk.length;
    while (this.bufferBytes > MAX_BUFFER_BYTES && this.buffer.length > 1) {
      this.bufferBytes -= this.buffer.shift()!.length;
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAlive = setInterval(() => {
      const ws = this.ws;
      if (ws?.readyState === WebSocket.OPEN && Date.now() - this.lastSendAt >= KEEPALIVE_MS) {
        ws.send(JSON.stringify({ type: "KeepAlive" }));
        this.lastSendAt = Date.now();
      }
    }, KEEPALIVE_MS / 2);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopKeepAlive();
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      // Ask Deepgram to flush remaining finals, then wait briefly for close.
      ws.send(JSON.stringify({ type: "CloseStream" }));
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 3_000);
        ws.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    } else {
      ws.terminate();
    }
  }
}
