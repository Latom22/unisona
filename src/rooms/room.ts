import { config } from "../config.js";
import type { Db, OrgRow, RoomRow } from "../db.js";
import { logger, type Logger } from "../logger.js";
import type { CaptionMessage, ScriptureMessage, ServerMessage } from "../protocol.js";
import { CloseCodes } from "../protocol.js";
import type { Providers } from "../providers/index.js";
import type { SttStream, SttStreamOptions, TranslationContext, TranslationResult } from "../providers/types.js";
import { arabicRatio, type QuranMatch } from "../pipeline/quranMatcher.js";
import type { ScriptureCard, ScriptureService } from "../pipeline/scripture.js";
import { Segmenter, type Segment } from "../pipeline/segmenter.js";
import { reportUsageToStripe, UsageTracker } from "../pipeline/usage.js";
import { reportError } from "../sentry.js";
import { SerialQueue } from "../util/backoff.js";
import type { Peer } from "./peer.js";

export interface RoomDeps {
  db: Db;
  providers: Providers;
  scripture: ScriptureService;
}

export interface BroadcastOptions {
  userId: string;
  encoding?: "linear16" | "opus";
  sampleRate?: number;
}

interface Listener {
  peer: Peer;
  lang: string;
  audio: boolean;
}

interface LangChannel {
  listeners: Set<Listener>;
  captions: SerialQueue;
  audio: SerialQueue;
  history: (CaptionMessage | ScriptureMessage)[];
}

const CARD_DEDUPE_MS = 60_000;
const MAX_TTS_BACKLOG = 3;
const HEARTBEAT_MS = 15_000;
const RECITATION_MIN_ARABIC = 0.6;

/** State for one live broadcast. */
class LiveSession {
  stt: SttStream | null = null;
  segmenter: Segmenter;
  seq = 0;
  recentSource: string[] = [];
  lastCard: { ref: string; at: number } | null = null;
  inflight = new Set<Promise<unknown>>();
  abort = new AbortController();
  ending = false;
  heartbeat: NodeJS.Timeout;

  constructor(
    readonly id: string,
    readonly usage: UsageTracker,
    readonly ctx: TranslationContext,
    readonly keywords: { term: string; boost?: number }[],
    readonly recitationMatching: boolean,
    onSegment: (seg: Segment) => void,
    onHeartbeat: () => void,
  ) {
    this.segmenter = new Segmenter({
      pauseMs: config.SEGMENT_PAUSE_MS,
      maxWords: config.SEGMENT_MAX_WORDS,
      onSegment,
    });
    this.heartbeat = setInterval(onHeartbeat, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }
}

export class Room {
  readonly id: string;
  private broadcaster: Peer | null = null;
  private broadcastOpts: BroadcastOptions | null = null;
  private session: LiveSession | null = null;
  private starting: Promise<void> | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private readonly channels = new Map<string, LangChannel>();
  private listenerStatsTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;

  constructor(
    readonly room: RoomRow,
    private org: OrgRow,
    private readonly deps: RoomDeps,
  ) {
    this.id = room.id;
    this.log = logger.child({ roomId: room.id, orgId: room.org_id });
  }

  get sourceLang(): string {
    return this.room.source_lang;
  }

  get isLive(): boolean {
    return this.session !== null;
  }

  get sessionId(): string | null {
    return this.session?.id ?? null;
  }

  get listenerCount(): number {
    let n = 0;
    for (const c of this.channels.values()) n += c.listeners.size;
    return n;
  }

  /** Nothing attached and nothing running: safe for the manager to drop. */
  get idle(): boolean {
    return !this.broadcaster && !this.session && !this.starting && this.listenerCount === 0;
  }

  /** Languages a listener may join. Empty target_langs = any language. */
  acceptsLanguage(lang: string): boolean {
    const targets = this.room.target_langs ?? [];
    return lang === this.sourceLang || targets.length === 0 || targets.includes(lang);
  }

  // ---------------------------------------------------------------- listeners

  addListener(peer: Peer, lang: string, audio: boolean): void {
    const channel = this.channel(lang);
    const listener: Listener = { peer, lang, audio: audio && lang !== this.sourceLang };
    channel.listeners.add(listener);

    peer.send({
      type: "joined",
      role: "listener",
      roomId: this.id,
      roomName: this.room.name,
      lang,
      sourceLang: this.sourceLang,
      live: this.isLive,
      sessionId: this.sessionId,
      audio: listener.audio,
      history: channel.history,
    });
    if (this.isLive) peer.send({ type: "broadcaster_status", connected: Boolean(this.broadcaster) });

    peer.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString()) as { type?: string; enabled?: unknown };
        if (msg.type === "set_audio") {
          listener.audio = Boolean(msg.enabled) && lang !== this.sourceLang;
          this.scheduleListenerStats();
        } else if (msg.type === "ping") {
          peer.send({ type: "pong", t: Date.now() });
        }
      } catch {
        /* ignore malformed */
      }
    });
    peer.ws.on("close", () => {
      channel.listeners.delete(listener);
      this.scheduleListenerStats();
    });
    this.scheduleListenerStats();
  }

  /** Close listeners so they reconnect (and get routed to the machine that owns the live session). */
  redirectListeners(): void {
    for (const c of this.channels.values()) {
      for (const l of c.listeners) l.peer.close(CloseCodes.sessionElsewhere, "session_elsewhere");
    }
  }

  private channel(lang: string): LangChannel {
    let c = this.channels.get(lang);
    if (!c) {
      c = { listeners: new Set(), captions: new SerialQueue(), audio: new SerialQueue(), history: [] };
      this.channels.set(lang, c);
    }
    return c;
  }

  private sendToLang(lang: string, msg: ServerMessage, opts: { record?: boolean } = {}): void {
    const c = this.channels.get(lang);
    if (opts.record && (msg.type === "caption" || msg.type === "scripture")) {
      const ch = this.channel(lang);
      ch.history.push(msg);
      if (ch.history.length > config.CAPTION_HISTORY) ch.history.splice(0, ch.history.length - config.CAPTION_HISTORY);
    }
    if (!c) return;
    for (const l of c.listeners) l.peer.send(msg);
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const c of this.channels.values()) for (const l of c.listeners) l.peer.send(msg);
  }

  /** Target languages (≠ source) with at least one listener. */
  private activeTargetLangs(): string[] {
    const out: string[] = [];
    for (const [lang, c] of this.channels) if (lang !== this.sourceLang && c.listeners.size > 0) out.push(lang);
    return out;
  }

  private audioListenerCount(lang: string): number {
    let n = 0;
    for (const l of this.channels.get(lang)?.listeners ?? []) if (l.audio) n++;
    return n;
  }

  private scheduleListenerStats(): void {
    if (this.listenerStatsTimer || !this.broadcaster) return;
    this.listenerStatsTimer = setTimeout(() => {
      this.listenerStatsTimer = null;
      const byLang: Record<string, { captions: number; audio: number }> = {};
      let total = 0;
      for (const [lang, c] of this.channels) {
        if (!c.listeners.size) continue;
        byLang[lang] = { captions: c.listeners.size, audio: this.audioListenerCount(lang) };
        total += c.listeners.size;
      }
      this.broadcaster?.send({ type: "listeners", total, byLang });
    }, 1000);
  }

  // -------------------------------------------------------------- broadcaster

  async attachBroadcaster(peer: Peer, opts: BroadcastOptions): Promise<void> {
    const previous = this.broadcaster;
    if (previous && previous !== peer) {
      this.log.info("broadcaster replaced by new connection");
      previous.close(CloseCodes.replaced, "replaced");
    }
    this.broadcaster = peer;
    this.broadcastOpts = opts;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }

    peer.ws.on("message", (data, isBinary) => {
      if (this.broadcaster !== peer) return;
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        this.session?.stt?.sendAudio(buf);
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === "stop") void this.endSession("stopped");
        else if (msg.type === "ping") peer.send({ type: "pong", t: Date.now() });
      } catch {
        /* ignore */
      }
    });
    peer.ws.on("close", () => this.onBroadcasterClose(peer));

    const resumed = Boolean(this.session);
    try {
      if (this.session) {
        // Reconnect within the grace window: same session, fresh STT stream
        // (the client's new MediaRecorder starts a new container stream).
        await this.restartStt();
        this.broadcastAll({ type: "broadcaster_status", connected: true });
      } else {
        await this.startSession(opts.userId);
      }
    } catch (err) {
      reportError(err, { component: "session_start", roomId: this.id });
      peer.send({ type: "error", code: "session_start_failed", message: "Could not start the session" });
      peer.close(CloseCodes.sessionFailed, "session_start_failed");
      return;
    }

    if (this.broadcaster !== peer) return; // replaced while starting
    peer.send({
      type: "joined",
      role: "broadcaster",
      roomId: this.id,
      roomName: this.room.name,
      lang: this.sourceLang,
      sourceLang: this.sourceLang,
      live: true,
      sessionId: this.sessionId,
      resumed,
    });
    this.scheduleListenerStats();
  }

  private onBroadcasterClose(peer: Peer): void {
    if (this.broadcaster !== peer) return;
    this.broadcaster = null;
    if (!this.session || this.session.ending) return;
    this.log.info({ graceMs: config.BROADCASTER_GRACE_MS }, "broadcaster disconnected; waiting for reconnect");
    this.broadcastAll({ type: "broadcaster_status", connected: false });
    // Emit whatever was said before the drop.
    this.session.segmenter.flush();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      void this.endSession("broadcaster_timeout");
    }, config.BROADCASTER_GRACE_MS);
  }

  private async startSession(userId: string): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { db } = this.deps;
      // Refresh org settings (faith, glossary) at each session start.
      const [org, glossary] = await Promise.all([db.getOrg(this.room.org_id), db.getGlossary(this.room.org_id)]);
      if (org) this.org = org;

      const ctx: TranslationContext = {
        faithType: this.org.faith_type,
        tradition: this.org.tradition,
        sourceLang: this.sourceLang,
        glossary: glossary.map((g) => ({
          term: g.term,
          translations: g.translations ?? {},
          doNotTranslate: Boolean(g.do_not_translate),
        })),
        doNotTranslate: [
          ...(this.org.do_not_translate ?? []),
          ...glossary.filter((g) => g.do_not_translate).map((g) => g.term),
        ],
      };
      const keywords = glossary.map((g) => ({ term: g.term, boost: g.boost ?? undefined }));
      const recitationMatching = this.room.recitation_matching ?? /islam|muslim|mosque/i.test(this.org.faith_type ?? "");

      const sessionId = await db.createSession({
        room_id: this.id,
        org_id: this.room.org_id,
        started_by: userId,
        source_lang: this.sourceLang,
        machine_id: config.FLY_MACHINE_ID ?? null,
      });
      const usage = new UsageTracker(db, this.room.org_id, sessionId);
      const session = new LiveSession(
        sessionId,
        usage,
        ctx,
        keywords,
        recitationMatching,
        (seg) => this.onSegment(seg),
        () => void db.touchSession(sessionId).catch((err) => this.log.warn({ err }, "session heartbeat failed")),
      );
      this.session = session;
      this.log.info({ sessionId, recitationMatching, glossary: glossary.length }, "session started");

      if (recitationMatching) {
        // Warm the shared index in the background.
        void this.deps.scripture.quranMatcher().catch(() => undefined);
      }
      await this.restartStt();
      this.broadcastAll({ type: "session_started", sessionId, sourceLang: this.sourceLang });
      this.broadcastAll({ type: "broadcaster_status", connected: true });
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async restartStt(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const old = session.stt;
    session.stt = null;
    if (old) await old.close().catch(() => undefined);
    session.segmenter.flush();

    const opts: SttStreamOptions = {
      language: this.sourceLang,
      keywords: session.keywords,
      encoding: this.broadcastOpts?.encoding,
      sampleRate: this.broadcastOpts?.sampleRate,
      endpointingMs: config.SEGMENT_PAUSE_MS,
    };
    let interim = "";
    session.stt = this.deps.providers.stt.openStream(opts, {
      onResult: (r) => {
        if (this.session !== session) return;
        if (r.isFinal) {
          interim = "";
          if (r.words.length) session.segmenter.pushFinal(r.words);
          if (r.speechFinal) session.segmenter.endpoint();
        } else {
          interim = r.transcript;
          session.segmenter.noteInterimActivity(r.words.length > 0);
        }
        const text = session.segmenter.liveText(interim);
        const msg: ServerMessage = { type: "interim", text, lang: this.sourceLang };
        this.broadcaster?.send(msg);
        this.sendToLang(this.sourceLang, msg);
      },
      onUtteranceEnd: () => {
        if (this.session === session) session.segmenter.endpoint();
      },
      onFatal: (err) => {
        reportError(err, { component: "stt", roomId: this.id, sessionId: session.id });
        this.broadcaster?.send({ type: "error", code: "stt_unavailable", message: "Transcription service unavailable" });
        void this.endSession("stt_failed");
      },
    });
  }

  // --------------------------------------------------------------- pipeline

  private onSegment(seg: Segment): void {
    const session = this.session;
    if (!session) return;
    const seq = ++session.seq;
    const previous = session.recentSource.slice(-2);
    session.recentSource.push(seg.text);
    if (session.recentSource.length > 2) session.recentSource.shift();

    const duration = Math.max(0, seg.end - seg.start) || seg.words.length * 0.4;
    session.usage.add(this.sourceLang, "transcription", duration);

    void session.track(
      this.processSegment(session, seg, seq, previous, duration).catch((err) =>
        reportError(err, { component: "segment_pipeline", roomId: this.id, sessionId: session.id, seq }),
      ),
    );
  }

  private async processSegment(
    session: LiveSession,
    seg: Segment,
    seq: number,
    previous: string[],
    duration: number,
  ): Promise<void> {
    const { db, scripture } = this.deps;
    const targets = this.activeTargetLangs();

    // 1. Recitation detection (mosque sessions).
    let recitation: QuranMatch | null = null;
    if (session.recitationMatching && arabicRatio(seg.text) >= RECITATION_MIN_ARABIC) {
      try {
        const matcher = await scripture.quranMatcher();
        recitation = matcher.match(seg.text, config.QURAN_MATCH_THRESHOLD);
      } catch {
        /* index unavailable: fall back to machine translation */
      }
    }
    const kind = recitation ? "recitation" : "speech";

    // 2. Source caption to broadcaster + source-language listeners.
    const sourceCaption: CaptionMessage = {
      type: "caption",
      seq,
      lang: this.sourceLang,
      text: seg.text,
      kind,
      source: true,
    };
    this.broadcaster?.send(sourceCaption);
    this.sendToLang(this.sourceLang, sourceCaption, { record: true });

    const segmentId = db
      .insertSegment({
        session_id: session.id,
        seq,
        source_lang: this.sourceLang,
        text: seg.text,
        start_ms: Math.round(seg.start * 1000),
        end_ms: Math.round(seg.end * 1000),
        kind,
      })
      .catch((err) => {
        reportError(err, { component: "segment_insert", sessionId: session.id, seq });
        return null;
      });

    // 3. Approved Quran translation in place of machine translation.
    let approved = new Map<string, ScriptureCard>();
    let recitationRef: string | null = null;
    if (recitation) {
      try {
        const cards = await scripture.quranCards(recitation.chapter, recitation.verseFrom, recitation.verseTo, [
          this.sourceLang,
          ...targets,
        ]);
        recitationRef = cards[0]?.ref ?? null;
        approved = new Map(cards.filter((c) => c.text).map((c) => [c.lang, c]));
        this.log.info({ seq, ref: recitationRef, score: recitation.score.toFixed(2) }, "recitation matched");
      } catch (err) {
        reportError(err, { component: "quran_lookup", sessionId: session.id });
      }
    }

    // 4. Translate per target language. Requests run in parallel; delivery per
    //    language is serialised so captions/audio stay in order.
    const results = new Map<string, TranslationResult>();
    const translations = targets.map((lang) => {
      const card = approved.get(lang);
      const work: Promise<TranslationResult | null> = card
        ? Promise.resolve({ text: card.text!, scriptureRef: recitationRef })
        : this.deps.providers.translator
            .translate(session.ctx, { text: seg.text, targetLang: lang, previous }, session.abort.signal)
            .catch((err) => {
              reportError(err, { component: "translate", sessionId: session.id, lang, seq });
              return null;
            });

      const channel = this.channel(lang);
      return channel.captions.push(async () => {
        const result = await work;
        if (!result?.text) return;
        results.set(lang, result);
        session.usage.add(lang, "translation", duration);
        this.sendToLang(
          lang,
          { type: "caption", seq, lang, text: result.text, kind, source: false, scriptureRef: result.scriptureRef },
          { record: true },
        );
        this.queueTts(session, lang, seq, result.text, duration);
      });
    });
    await Promise.allSettled(translations);

    // 5. Scripture cards (one per language channel, plus the broadcaster).
    const ref = recitationRef ?? [...results.values()].find((r) => r.scriptureRef)?.scriptureRef ?? null;
    if (ref) await this.sendScriptureCards(session, seq, ref, recitation ? approved : null, targets);

    // 6. Persist translations.
    const id = await segmentId;
    if (id && (results.size || ref)) {
      await db
        .updateSegment(id, {
          translations: Object.fromEntries([...results].map(([l, r]) => [l, r.text])),
          scripture_ref: ref,
        })
        .catch((err) => reportError(err, { component: "segment_update", sessionId: session.id, seq }));
    }
  }

  private async sendScriptureCards(
    session: LiveSession,
    seq: number,
    ref: string,
    approved: Map<string, ScriptureCard> | null,
    targets: string[],
  ): Promise<void> {
    const now = Date.now();
    if (session.lastCard && session.lastCard.ref === ref && now - session.lastCard.at < CARD_DEDUPE_MS) return;
    session.lastCard = { ref, at: now };

    const langs = [this.sourceLang, ...targets];
    let cards: ScriptureCard[] | null;
    if (approved) {
      cards = langs.map((l) => approved.get(l) ?? { ref, lang: l, text: null, verses: [], translationName: null });
    } else {
      try {
        cards = await this.deps.scripture.lookup(ref, langs);
      } catch (err) {
        reportError(err, { component: "scripture_lookup", sessionId: session.id, ref });
        return;
      }
    }
    if (!cards) return;
    for (const card of cards) {
      const msg: ScriptureMessage = {
        type: "scripture",
        seq,
        ref: card.ref,
        lang: card.lang,
        text: card.text,
        verses: card.verses,
        translationName: card.translationName,
        source: approved ? "approved" : "lookup",
      };
      if (card.lang === this.sourceLang) this.broadcaster?.send(msg);
      this.sendToLang(card.lang, msg, { record: true });
    }
  }

  private queueTts(session: LiveSession, lang: string, seq: number, text: string, duration: number): void {
    const { tts } = this.deps.providers;
    if (this.audioListenerCount(lang) === 0 || !tts.supports(lang)) return;
    const channel = this.channel(lang);
    if (channel.audio.size >= MAX_TTS_BACKLOG) {
      this.log.warn({ lang, seq, backlog: channel.audio.size }, "tts falling behind; skipping segment audio");
      return;
    }
    void channel.audio.push(async () => {
      const audioPeers = () => [...(this.channels.get(lang)?.listeners ?? [])].filter((l) => l.audio).map((l) => l.peer);
      if (!audioPeers().length) return;
      for (const p of audioPeers()) p.send({ type: "audio_start", seq, lang, mimeType: tts.mimeType });
      try {
        for await (const chunk of tts.synthesize({ text, lang }, session.abort.signal)) {
          for (const p of audioPeers()) p.sendBinary(chunk);
        }
        session.usage.add(lang, "tts", duration);
      } catch (err) {
        if (!session.abort.signal.aborted) reportError(err, { component: "tts", sessionId: session.id, lang, seq });
      } finally {
        for (const p of audioPeers()) p.send({ type: "audio_end", seq, lang });
      }
    });
  }

  // ------------------------------------------------------------------ end

  async endSession(reason: string): Promise<void> {
    const session = this.session;
    if (!session || session.ending) return;
    session.ending = true;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.log.info({ sessionId: session.id, reason }, "ending session");

    // Let STT flush its last finals, then emit the trailing segment.
    await session.stt?.close().catch(() => undefined);
    session.stt = null;
    session.segmenter.flush();
    session.segmenter.dispose();
    clearInterval(session.heartbeat);

    // Allow in-flight translations/TTS to finish (bounded), then abort the rest.
    const drain = Promise.allSettled([...session.inflight]);
    const timeout = new Promise((r) => setTimeout(r, 15_000).unref());
    await Promise.race([drain, timeout]);
    session.abort.abort();

    this.session = null;
    this.broadcastAll({ type: "session_ended", reason });
    if (this.broadcaster) {
      this.broadcaster.send({ type: "session_ended", reason });
      // On shutdown, tell the client to reconnect right away (it will land on another machine).
      if (reason === "server_shutdown") this.broadcaster.close(CloseCodes.shuttingDown, "server_restarting");
      else this.broadcaster.close(1000, "session_ended");
      this.broadcaster = null;
    }

    await session.usage.stop();
    const { db } = this.deps;
    try {
      await db.endSession(session.id, {
        total_speaking_seconds: Math.round(session.usage.speakingSeconds),
        end_reason: reason,
      });
    } catch (err) {
      reportError(err, { component: "session_end", sessionId: session.id });
    }
    try {
      const reported = await reportUsageToStripe({
        sessionId: session.id,
        stripeCustomerId: this.org.stripe_customer_id,
        secondsByLanguage: session.usage.secondsByLanguage(),
      });
      if (reported) await db.markUsageReported(session.id);
    } catch (err) {
      // sessions.usage_reported_at stays null; a backfill job can retry (identifiers are idempotent).
      reportError(err, { component: "stripe_usage", sessionId: session.id });
    }
    this.log.info({ sessionId: session.id, speakingSeconds: Math.round(session.usage.speakingSeconds) }, "session ended");
  }

  /** Graceful shutdown: end any live session and close every client. */
  async shutdown(): Promise<void> {
    await this.endSession("server_shutdown");
    for (const c of this.channels.values()) {
      for (const l of c.listeners) l.peer.close(CloseCodes.shuttingDown, "server_restarting");
    }
  }
}
