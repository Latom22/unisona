import { config } from "../config.js";
import type { RoomRow } from "../db.js";
import { logger } from "../logger.js";
import { reportError } from "../sentry.js";
import { Room, type RoomDeps } from "./room.js";

const SWEEP_MS = 15_000;
export const SESSION_FRESH_MS = 45_000;

/** Owns the in-memory rooms on this machine. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room>>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly deps: RoomDeps) {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  async get(row: RoomRow): Promise<Room> {
    const existing = this.rooms.get(row.id);
    if (existing) return existing;
    let pending = this.loading.get(row.id);
    if (!pending) {
      pending = (async () => {
        const org = await this.deps.db.getOrg(row.org_id);
        if (!org) throw new Error(`organization ${row.org_id} not found`);
        const room = new Room(row, org, this.deps);
        this.rooms.set(row.id, room);
        return room;
      })().finally(() => this.loading.delete(row.id));
      this.loading.set(row.id, pending);
    }
    return pending;
  }

  stats() {
    let listeners = 0;
    let live = 0;
    for (const r of this.rooms.values()) {
      listeners += r.listenerCount;
      if (r.isLive) live++;
    }
    return { rooms: this.rooms.size, liveSessions: live, listeners };
  }

  /**
   * Drop idle rooms, and redirect listeners waiting on this machine when the
   * room's live session is running on another machine (multi-machine deploys).
   */
  private async sweep(): Promise<void> {
    for (const [id, room] of this.rooms) {
      if (room.idle) {
        this.rooms.delete(id);
        continue;
      }
      if (room.isLive || room.listenerCount === 0 || config.DISABLE_FLY_REPLAY || !config.FLY_MACHINE_ID) continue;
      try {
        const s = await this.deps.db.getFreshLiveSession(id, SESSION_FRESH_MS);
        if (s?.machine_id && s.machine_id !== config.FLY_MACHINE_ID) {
          logger.info({ roomId: id, owner: s.machine_id }, "redirecting waiting listeners to session owner");
          room.redirectListeners();
        }
      } catch (err) {
        reportError(err, { component: "room_sweep", roomId: id });
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.rooms.values()].map((r) => r.shutdown()));
  }
}
