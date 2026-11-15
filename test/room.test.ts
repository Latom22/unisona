import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db, OrgRow, RoomRow } from "../src/db.js";
import { ScriptureService } from "../src/pipeline/scripture.js";
import type { Providers } from "../src/providers/index.js";
import type {
  SttStream,
  SttStreamEvents,
  TranslationContext,
  TranslationRequest,
} from "../src/providers/types.js";
import { Peer } from "../src/rooms/peer.js";
import { Room } from "../src/rooms/room.js";

class FakeWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: (Record<string, unknown> | Buffer)[] = [];
  send(data: string | Buffer) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  json(type?: string) {
    return this.sent.filter((m): m is Record<string, unknown> => !Buffer.isBuffer(m) && (!type || m.type === type));
  }
}

function peer(): { ws: FakeWs; peer: Peer } {
  const ws = new FakeWs();
  return { ws, peer: new Peer(ws as never, Math.random().toString(36), undefined) };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeDeps(org: Partial<OrgRow> = {}) {
  let sttEvents: SttStreamEvents | null = null;
  const audio: Buffer[] = [];
  const translateCalls: TranslationRequest[] = [];
  const contexts: TranslationContext[] = [];
  const db = {
    getOrg: vi.fn(async () => ({ id: "org", name: "Org", faith_type: "christian", tradition: "Catholic", stripe_customer_id: null, do_not_translate: ["Selah"], ...org })),
    getGlossary: vi.fn(async () => [{ term: "Eucharist", translations: { es: "Eucaristía" }, do_not_translate: false, boost: null }]),
    createSession: vi.fn(async () => "sess-1"),
    insertSegment: vi.fn(async () => "seg-id"),
    updateSegment: vi.fn(async () => undefined),
    insertUsageEvents: vi.fn(async () => undefined),
    endSession: vi.fn(async () => undefined),
    markUsageReported: vi.fn(async () => undefined),
    touchSession: vi.fn(async () => undefined),
    getScripture: vi.fn(async (q: { book: string; langs: string[]; tradition?: string }) =>
      q.langs.map((lang) => ({
        tradition: q.tradition ?? "bible", ref: "", book: q.book, chapter: 1, verse: 1, lang,
        text: `${q.book} text in ${lang}`, translation_name: "T", is_approved: true,
      })),
    ),
    loadQuranArabic: vi.fn(async () => [
      { chapter: 1, verse: 5, text: "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ" },
      { chapter: 1, verse: 6, text: "ٱهْدِنَا ٱلصِّرَٰطَ ٱلْمُسْتَقِيمَ" },
    ]),
  };
  const providers: Providers = {
    stt: {
      name: "fake",
      openStream: (_opts, events) => {
        sttEvents = events;
        const s: SttStream = { sendAudio: (c) => void audio.push(c), close: async () => undefined };
        return s;
      },
    },
    translator: {
      name: "fake",
      translate: async (ctx, req) => {
        contexts.push(ctx);
        translateCalls.push(req);
        return { text: `[${req.targetLang}] ${req.text}`, scriptureRef: req.text.includes("John") ? "John 3:16" : null };
      },
    },
    tts: {
      name: "fake",
      mimeType: "audio/mpeg",
      supports: () => true,
      async *synthesize() {
        yield Buffer.from("aa");
        yield Buffer.from("bb");
      },
    },
  };
  const scripture = new ScriptureService(db as unknown as Db);
  return { db, providers, scripture, audio, translateCalls, contexts, stt: () => sttEvents! };
}

const ROOM: RoomRow = { id: "room-1", org_id: "org", name: "Main", listen_code: "ABC", source_lang: "en", target_langs: [], recitation_matching: null };

function finalWords(text: string, start = 0) {
  return text.split(" ").map((w, i) => ({ word: w, punctuated: w, start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
}

describe("Room pipeline", () => {
  afterEach(() => vi.useRealTimers());

  it("transcribes, translates for active languages only, sends cards and audio, and bills", async () => {
    const d = makeDeps();
    const org = (await d.db.getOrg()) as OrgRow;
    const room = new Room(ROOM, org, d);

    const es = peer(); // captions + audio
    const fr = peer(); // captions only
    const en = peer(); // source language
    room.addListener(es.peer, "es", true);
    room.addListener(fr.peer, "fr", false);
    room.addListener(en.peer, "en", true);

    const b = peer();
    await room.attachBroadcaster(b.peer, { userId: "user-1" });
    expect(d.db.createSession).toHaveBeenCalled();
    expect(b.ws.json("joined")[0]).toMatchObject({ role: "broadcaster", sessionId: "sess-1", live: true });
    expect(es.ws.json("session_started")).toHaveLength(1);

    // Audio is forwarded to STT.
    b.ws.emit("message", Buffer.from([1, 2, 3]), true);
    expect(d.audio).toHaveLength(1);

    // Interim goes to broadcaster and source listeners only.
    d.stt().onResult({ isFinal: false, speechFinal: false, transcript: "For God so", words: finalWords("For God so") });
    expect(b.ws.json("interim").at(-1)).toMatchObject({ text: "For God so" });
    expect(en.ws.json("interim")).toHaveLength(1);
    expect(es.ws.json("interim")).toHaveLength(0);

    // Final with punctuation → segment.
    d.stt().onResult({ isFinal: true, speechFinal: false, transcript: "", words: finalWords("As John wrote, God loved the world.") });
    await flush();

    expect(en.ws.json("caption")[0]).toMatchObject({ seq: 1, text: "As John wrote, God loved the world.", source: true });
    expect(es.ws.json("caption")[0]).toMatchObject({ seq: 1, lang: "es", text: "[es] As John wrote, God loved the world." });
    expect(fr.ws.json("caption")[0]).toMatchObject({ lang: "fr" });
    expect(d.translateCalls.map((c) => c.targetLang).sort()).toEqual(["es", "fr"]);
    expect(d.contexts[0]).toMatchObject({ faithType: "christian", tradition: "Catholic", doNotTranslate: ["Selah"] });

    // Scripture card per language, and to the broadcaster in the source language.
    expect(es.ws.json("scripture")[0]).toMatchObject({ ref: "John 3:16", lang: "es", text: "John text in es", source: "lookup" });
    expect(b.ws.json("scripture")[0]).toMatchObject({ lang: "en" });

    // TTS only for the audio listener in a target language.
    expect(es.ws.json("audio_start")).toHaveLength(1);
    expect(es.ws.sent.filter(Buffer.isBuffer)).toHaveLength(2);
    expect(es.ws.json("audio_end")).toHaveLength(1);
    expect(fr.ws.json("audio_start")).toHaveLength(0);
    expect(en.ws.json("audio_start")).toHaveLength(0);

    // Context: the next segment carries the previous sentence.
    d.stt().onResult({ isFinal: true, speechFinal: false, transcript: "", words: finalWords("He gave his only Son.", 5) });
    await flush();
    expect(d.translateCalls.at(-1)!.previous).toEqual(["As John wrote, God loved the world."]);
    expect(d.db.updateSegment).toHaveBeenCalledWith("seg-id", expect.objectContaining({ scripture_ref: "John 3:16" }));

    await room.endSession("stopped");
    expect(d.db.insertUsageEvents).toHaveBeenCalled();
    const rows = d.db.insertUsageEvents.mock.calls.flat().flat() as unknown as { lang: string; kind: string }[];
    expect(new Set(rows.map((r) => `${r.lang}:${r.kind}`))).toEqual(new Set(["en:transcription", "es:translation", "fr:translation", "es:tts"]));
    expect(d.db.endSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({ end_reason: "stopped" }));
    expect(es.ws.json("session_ended")).toHaveLength(1);
  });

  it("replaces machine translation with the approved Quran translation in mosque sessions", async () => {
    const d = makeDeps({ faith_type: "islam" });
    const org = (await d.db.getOrg()) as OrgRow;
    const room = new Room({ ...ROOM, source_lang: "ar" }, org, d);
    const en = peer();
    room.addListener(en.peer, "en", false);
    const b = peer();
    await room.attachBroadcaster(b.peer, { userId: "u" });

    d.stt().onResult({ isFinal: true, speechFinal: true, transcript: "", words: finalWords("اياك نعبد واياك نستعين") });
    await flush();

    expect(d.translateCalls).toHaveLength(0);
    expect(en.ws.json("caption")[0]).toMatchObject({ kind: "recitation", text: "Quran text in en", scriptureRef: "Quran 1:5" });
    expect(en.ws.json("scripture")[0]).toMatchObject({ ref: "Quran 1:5", source: "approved" });
    await room.endSession("stopped");
  });

  it("keeps the session through a broadcaster reconnect within the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const d = makeDeps();
    const room = new Room(ROOM, (await d.db.getOrg()) as OrgRow, d);
    const l = peer();
    room.addListener(l.peer, "es", false);

    const b1 = peer();
    await room.attachBroadcaster(b1.peer, { userId: "u" });
    b1.ws.close();
    expect(l.ws.json("broadcaster_status").at(-1)).toMatchObject({ connected: false });

    vi.advanceTimersByTime(10_000);
    const b2 = peer();
    await room.attachBroadcaster(b2.peer, { userId: "u" });
    expect(b2.ws.json("joined")[0]).toMatchObject({ resumed: true, sessionId: "sess-1" });
    expect(d.db.createSession).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(d.db.endSession).not.toHaveBeenCalled();
    expect(room.isLive).toBe(true);
    vi.useRealTimers();
    await room.endSession("stopped");
  });
});
