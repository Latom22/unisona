/**
 * Wire protocol. All server→client control messages are JSON text frames;
 * TTS audio is sent as binary frames between `audio_start` and `audio_end`.
 *
 * Broadcaster → server: binary audio frames (WebM/Ogg Opus from MediaRecorder by
 * default, or raw PCM when connected with `encoding=linear16&sample_rate=16000`),
 * plus JSON `{type:"stop"}` / `{type:"ping"}`.
 *
 * Listener → server: JSON `{type:"set_audio", enabled}` / `{type:"ping"}`.
 */

export type CaptionKind = "speech" | "recitation";

export interface CaptionMessage {
  type: "caption";
  seq: number;
  lang: string;
  text: string;
  kind: CaptionKind;
  /** true when this caption is the source-language transcript, false for translations. */
  source: boolean;
  scriptureRef?: string | null;
}

export interface ScriptureMessage {
  type: "scripture";
  seq: number;
  ref: string;
  lang: string;
  text: string | null;
  verses: { verse: number; text: string }[];
  translationName: string | null;
  /** "approved" for Quran recitation matches; "lookup" for references found in speech. */
  source: "approved" | "lookup";
}

export type ServerMessage =
  | {
      type: "joined";
      role: "broadcaster" | "listener";
      roomId: string;
      roomName: string | null;
      lang: string;
      sourceLang: string;
      live: boolean;
      sessionId: string | null;
      resumed?: boolean;
      audio?: boolean;
      history?: (CaptionMessage | ScriptureMessage)[];
    }
  | { type: "session_started"; sessionId: string; sourceLang: string }
  | { type: "session_ended"; reason: string }
  | { type: "broadcaster_status"; connected: boolean }
  | { type: "interim"; text: string; lang: string }
  | CaptionMessage
  | ScriptureMessage
  | { type: "audio_start"; seq: number; lang: string; mimeType: string }
  | { type: "audio_end"; seq: number; lang: string }
  | { type: "listeners"; total: number; byLang: Record<string, { captions: number; audio: number }> }
  | { type: "pong"; t: number }
  | { type: "error"; code: string; message: string };

export type BroadcasterMessage = { type: "stop" } | { type: "ping" };
export type ListenerMessage = { type: "set_audio"; enabled: boolean } | { type: "ping" };

/** Application close codes (4000–4999). */
export const CloseCodes = {
  replaced: 4001,
  unauthorized: 4003,
  notFound: 4004,
  badRequest: 4000,
  slowConsumer: 4008,
  sessionElsewhere: 4012,
  shuttingDown: 4013,
  sessionFailed: 4014,
} as const;
