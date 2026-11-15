# Unisona realtime worker

Node.js + TypeScript WebSocket worker that turns a live sermon/khutbah into captions, translations, scripture cards and synthesized audio, one channel per language. Deploys to Fly.io.

```
broadcaster ──audio──▶ /broadcast ─▶ SttProvider (Deepgram, glossary keyterms)
                                       │ interim ─▶ broadcaster + source-language listeners
                                       ▼
                                   Segmenter  (punctuation · 600 ms pause · 18 words)
                                       │ save → segments
                    ┌──────────────────┼─────────────────────────┐
     mosque + Arabic recitation?   Translator (Claude) per target   scripture_ref?
     QuranMatcher → approved       language with ≥1 listener         → scripture_texts
     translation (no MT)               │                              → card per language
                                       ▼
                         captions ─▶ /listen?code=&lang=   (in order, per language)
                         TtsProvider (Azure) ─▶ audio frames to audio listeners
                         usage_events (per language) ─▶ Stripe meter at session end
```

## Endpoints

| Path | Who | Notes |
|---|---|---|
| `GET /health` | Fly checks | JSON with uptime, room/listener counts; 503 while draining |
| `WS /broadcast?room=<uuid>&token=<supabase jwt>` | Broadcaster | Token verified (JWKS, or HS256 if `SUPABASE_JWT_SECRET` is set); user must be in `org_members` for the room's org. Optional `encoding=linear16&sample_rate=16000` for raw PCM, otherwise send WebM/Ogg Opus chunks from `MediaRecorder`. |
| `WS /listen?code=<listen_code>&lang=<bcp47>[&audio=1]` | Anonymous listener | Joins the room+language channel. `audio=1` also receives TTS audio (target languages only). |

### Messages

Server → client (JSON): `joined` (with recent caption history for catch-up), `session_started`, `session_ended`, `broadcaster_status`, `interim`, `caption`, `scripture`, `audio_start` / binary frames / `audio_end`, `listeners` (broadcaster only), `pong`, `error`. Types live in [`src/protocol.ts`](src/protocol.ts).

Client → server: broadcaster sends binary audio plus `{"type":"stop"}` to end the session; listeners may send `{"type":"set_audio","enabled":true}`. Both may send `{"type":"ping"}`.

Captions carry `seq`. Translations for segment N are always delivered to a channel before N+1, and audio for a channel is serialized, so clients can play `audio_start`→`audio_end` blocks in order. TTS audio is the `AZURE_TTS_FORMAT` (MP3 by default; the MIME type is in `audio_start`).

Close codes: `4001` replaced by a newer broadcaster, `4008` slow consumer, `4012` session moved to another machine (reconnect), `4013` server restarting (reconnect), `4014` session failed to start.

## Behaviour

- **Session start**: the first broadcaster connection creates a `sessions` row (stale `live` rows for the room are closed), loads the org's glossary and faith settings, and opens a Deepgram stream with glossary terms as `keyterm`s (nova-3) or `keywords` (older models).
- **Segmentation**: a segment ends on sentence punctuation, a 600 ms pause (word-timestamp gap, Deepgram endpoint, or wall-clock silence), or 18 words. All three are configurable.
- **Translation**: only for target languages that currently have at least one listener. The system prompt carries faith type, tradition, glossary and the do-not-translate list (kept byte-stable per session so it can be prompt-cached); the user turn carries the target language and the last two source sentences as context. Output is constrained to JSON `{text, scripture_ref}`.
- **Scripture cards**: `scripture_ref` is parsed (`John 3:16`, `Psalm 23:1-3`, `Quran 2:255`) and looked up in `scripture_texts` for the source language and every active language. The same reference is not repeated within 60 s.
- **Quran recitation**: in mosque sessions (`rooms.recitation_matching`, or org `faith_type` matching islam/muslim when it's null), segments that are mostly Arabic script are matched against the Quran text (normalized Arabic, rare-token candidates, unigram+bigram containment, spans up to 3 ayat). On a match listeners get the **approved** translation (`is_approved = true`) instead of machine translation, plus a card.
- **TTS**: languages with audio listeners get Azure Neural TTS, streamed chunk-by-chunk as Azure returns it. If TTS falls more than 3 segments behind on a channel, audio for new segments is skipped (captions keep flowing).
- **Usage**: speaking seconds are tracked per language and kind (`transcription` for the source, `translation` for targets, `tts`) and flushed to `usage_events` every 60 s and at session end. At session end, one Stripe Billing Meter event per language (value = seconds) is sent with the idempotency identifier `session:<id>:<lang>`; on success `sessions.usage_reported_at` is set.

### Reconnects

- **Broadcaster**: if the socket drops, the session stays open for `BROADCASTER_GRACE_MS` (30 s). Reconnecting resumes the same session and reopens STT for the new audio stream; listeners see `broadcaster_status`. After the grace period the session ends and is billed.
- **Deepgram**: unexpected closes reconnect with exponential backoff (8 attempts). Audio is buffered (up to 4 MB) while it reconnects, and the WebM/Ogg header chunk is re-sent so the new stream decodes. Timestamps stay monotonic.
- **Listeners**: just reconnect. `joined` replays the last few captions/cards for their language.
- **Dead sockets**: ping every 25 s; clients that miss a pong are terminated.

### Multiple machines

Broadcaster and listeners of a room must be in the same process. The owning machine id and a 15 s heartbeat are stored on the session. Connections that land elsewhere are redirected with Fly's `fly-replay: instance=…` header (only once, never looping). Listeners who were waiting before the session started on another machine get close code `4012` and reconnect. If you prefer one machine, set `min_machines_running = 1` and don't scale out.

Deploys end live sessions: on `SIGTERM` the worker flushes, ends and bills every session, then closes clients with `4013` so they reconnect to the new machine (which starts a new session).

## Swapping vendors

The pipeline depends only on the interfaces in [`src/providers/types.ts`](src/providers/types.ts):

- `SttProvider.openStream(opts, events)` → `SttStream` (`sendAudio`, `close`)
- `Translator.translate(ctx, req)` → `{ text, scriptureRef } | null`
- `TtsProvider.synthesize(req)` → `AsyncIterable<Buffer>`

Add an adapter next to the existing ones and change [`src/providers/index.ts`](src/providers/index.ts).

## Database

[`supabase/migrations/0001_realtime_worker.sql`](supabase/migrations/0001_realtime_worker.sql) lists every table and column the worker uses: `organizations`, `org_members`, `rooms`, `sessions`, `segments`, `glossary_terms`, `scripture_texts`, `usage_events`. It's additive (`create table if not exists` / `add column if not exists`), but compare it with your existing schema before applying. The worker uses the service-role key, so RLS does not apply to it.

`scripture_texts` needs the Arabic Quran (`tradition='quran'`, `lang='ar'`, `book='Quran'`), approved translations per language, and the Bible translations you want cards for (canonical English book names in `book`).

## Configuration

See [`.env.example`](.env.example) and [`src/config.ts`](src/config.ts). Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`. Optional: `STRIPE_SECRET_KEY`, `STRIPE_METER_EVENT_NAME`, `SENTRY_DSN`, `SUPABASE_JWT_SECRET`, `ALLOWED_ORIGINS`, `AZURE_TTS_VOICES`, and the tuning values (`SEGMENT_PAUSE_MS`, `SEGMENT_MAX_WORDS`, `BROADCASTER_GRACE_MS`, `QURAN_MATCH_THRESHOLD`, `TRANSLATION_EFFORT`, …).

Translation uses `claude-opus-5-5` at effort `low` because captions are latency-sensitive. Raise `TRANSLATION_EFFORT` if quality on your content needs it. Server-side refusal fallback (`fallbacks: "default"`) is on, so a false-positive safety decline is retried on a fallback model instead of dropping the caption.

## Develop

```bash
npm install
```

```bash
cp .env.example .env   # fill in keys
```

```bash
node --env-file=.env --import tsx src/index.ts
```

```bash
npm test
```

```bash
npm run typecheck
```

## Deploy to Fly.io

```bash
fly launch --no-deploy --copy-config --name unisona-realtime
```

```bash
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DEEPGRAM_API_KEY=... ANTHROPIC_API_KEY=... AZURE_SPEECH_KEY=... STRIPE_SECRET_KEY=... SENTRY_DSN=...
```

```bash
fly deploy
```

Set `AZURE_SPEECH_REGION` and the tuning values in `[env]` in `fly.toml`. In Stripe, create a meter whose event name matches `STRIPE_METER_EVENT_NAME`, using sum aggregation and the default payload keys (`stripe_customer_id`, `value`).

## Known limitations

- Recitation detection needs the transcript in Arabic script. That works when the room's `source_lang` is `ar`. For English-language khutbahs with recited passages, use an STT language setting that keeps Arabic in Arabic script (or add a second Arabic STT stream). The matcher handles fragments and ayah boundaries, but very short recitations (under 3 words) are not matched.
- Ended sessions whose Stripe report failed keep `usage_reported_at = null`. Run a periodic job to re-send them; the identifiers make a retry safe.
