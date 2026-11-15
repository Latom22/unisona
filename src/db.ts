import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

/**
 * Data access. Column names follow supabase/migrations/0001_realtime_worker.sql;
 * adjust there and here together if your schema differs.
 */

export interface RoomRow {
  id: string;
  org_id: string;
  name: string | null;
  listen_code: string;
  source_lang: string;
  target_langs: string[] | null;
  /** null = decide from organization faith_type */
  recitation_matching: boolean | null;
}

export interface OrgRow {
  id: string;
  name: string | null;
  faith_type: string | null;
  tradition: string | null;
  stripe_customer_id: string | null;
  do_not_translate: string[] | null;
}

export interface GlossaryRow {
  term: string;
  translations: Record<string, string> | null;
  do_not_translate: boolean | null;
  boost: number | null;
}

export interface SessionRow {
  id: string;
  room_id: string;
  org_id: string;
  machine_id: string | null;
  status: string;
}

export interface ScriptureRow {
  tradition: string;
  ref: string;
  book: string;
  chapter: number;
  verse: number;
  lang: string;
  text: string;
  translation_name: string | null;
  is_approved: boolean | null;
}

export interface UsageEventInsert {
  org_id: string;
  session_id: string;
  lang: string;
  kind: "transcription" | "translation" | "tts";
  seconds: number;
}

export class Db {
  readonly client: SupabaseClient;

  constructor() {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async getRoomById(id: string): Promise<RoomRow | null> {
    const { data, error } = await this.client.from("rooms").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data as RoomRow | null;
  }

  async getRoomByCode(code: string): Promise<RoomRow | null> {
    const { data, error } = await this.client
      .from("rooms")
      .select("*")
      .ilike("listen_code", code) // codes are [A-Za-z0-9-] only (validated), so no wildcards
      .maybeSingle();
    if (error) throw error;
    return data as RoomRow | null;
  }

  async getOrg(id: string): Promise<OrgRow | null> {
    const { data, error } = await this.client.from("organizations").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data as OrgRow | null;
  }

  async isOrgMember(orgId: string, userId: string): Promise<boolean> {
    const { count, error } = await this.client
      .from("org_members")
      .select("user_id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("user_id", userId);
    if (error) throw error;
    return (count ?? 0) > 0;
  }

  async getGlossary(orgId: string): Promise<GlossaryRow[]> {
    const { data, error } = await this.client
      .from("glossary_terms")
      .select("term, translations, do_not_translate, boost")
      .eq("org_id", orgId)
      .limit(1000);
    if (error) throw error;
    return (data ?? []) as GlossaryRow[];
  }

  async getLiveSession(roomId: string): Promise<SessionRow | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("id, room_id, org_id, machine_id, status")
      .eq("room_id", roomId)
      .eq("status", "live")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as SessionRow | null;
  }

  async createSession(input: {
    room_id: string;
    org_id: string;
    started_by: string;
    source_lang: string;
    machine_id: string | null;
  }): Promise<string> {
    // A crashed machine may have left a stale live row; close it first.
    await this.client
      .from("sessions")
      .update({ status: "ended", ended_at: new Date().toISOString(), end_reason: "superseded" })
      .eq("room_id", input.room_id)
      .eq("status", "live");
    const { data, error } = await this.client
      .from("sessions")
      .insert({ ...input, status: "live", started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  async endSession(id: string, fields: { total_speaking_seconds: number; end_reason: string }): Promise<void> {
    const { error } = await this.client
      .from("sessions")
      .update({ status: "ended", ended_at: new Date().toISOString(), ...fields })
      .eq("id", id);
    if (error) throw error;
  }

  /** Liveness marker so other machines can tell a live session from a crashed one. */
  async touchSession(id: string): Promise<void> {
    const { error } = await this.client.from("sessions").update({ heartbeat_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  }

  async getFreshLiveSession(roomId: string, maxAgeMs: number): Promise<SessionRow | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("id, room_id, org_id, machine_id, status")
      .eq("room_id", roomId)
      .eq("status", "live")
      .gte("heartbeat_at", new Date(Date.now() - maxAgeMs).toISOString())
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as SessionRow | null;
  }

  async markUsageReported(id: string): Promise<void> {
    const { error } = await this.client
      .from("sessions")
      .update({ usage_reported_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  }

  async insertSegment(input: {
    session_id: string;
    seq: number;
    source_lang: string;
    text: string;
    start_ms: number;
    end_ms: number;
    kind: "speech" | "recitation";
    scripture_ref?: string | null;
  }): Promise<string> {
    const { data, error } = await this.client.from("segments").insert(input).select("id").single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  async updateSegment(
    id: string,
    fields: { translations?: Record<string, string>; scripture_ref?: string | null },
  ): Promise<void> {
    const { error } = await this.client.from("segments").update(fields).eq("id", id);
    if (error) throw error;
  }

  async getScripture(q: {
    /** Omit to search all traditions (book names disambiguate). */
    tradition?: string;
    book: string;
    chapter: number;
    verseFrom: number;
    verseTo: number;
    langs: string[];
    approvedOnly?: boolean;
  }): Promise<ScriptureRow[]> {
    let query = this.client
      .from("scripture_texts")
      .select("tradition, ref, book, chapter, verse, lang, text, translation_name, is_approved")
      .ilike("book", q.book)
      .eq("chapter", q.chapter)
      .gte("verse", q.verseFrom)
      .lte("verse", q.verseTo)
      .in("lang", q.langs)
      .order("verse", { ascending: true })
      .limit(500);
    if (q.tradition) query = query.eq("tradition", q.tradition);
    if (q.approvedOnly) query = query.eq("is_approved", true);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as ScriptureRow[];
  }

  /** Full Arabic Quran text for recitation matching (~6,236 rows), paginated. */
  async loadQuranArabic(): Promise<{ chapter: number; verse: number; text: string }[]> {
    const out: { chapter: number; verse: number; text: string }[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await this.client
        .from("scripture_texts")
        .select("chapter, verse, text")
        .eq("tradition", "quran")
        .eq("lang", "ar")
        .order("chapter", { ascending: true })
        .order("verse", { ascending: true })
        .range(from, from + page - 1);
      if (error) throw error;
      const rows = (data ?? []) as { chapter: number; verse: number; text: string }[];
      out.push(...rows);
      if (rows.length < page) break;
    }
    return out;
  }

  async insertUsageEvents(rows: UsageEventInsert[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.client.from("usage_events").insert(rows);
    if (error) throw error;
  }
}
