import WebSocket from "ws";
import type { ServerMessage } from "../protocol.js";

const DROP_BINARY_ABOVE = 1 * 1024 * 1024;
const CLOSE_ABOVE = 8 * 1024 * 1024;

/** Thin wrapper over a client socket: JSON helpers, backpressure, liveness flag. */
export class Peer {
  isAlive = true;
  readonly connectedAt = Date.now();

  constructor(
    readonly ws: WebSocket,
    readonly id: string,
    readonly ip: string | undefined,
  ) {
    ws.on("pong", () => {
      this.isAlive = true;
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: ServerMessage): void {
    if (!this.open) return;
    if (this.ws.bufferedAmount > CLOSE_ABOVE) {
      this.close(4008, "slow_consumer");
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Audio is droppable: skip frames for clients that cannot keep up. Returns false if dropped. */
  sendBinary(chunk: Buffer): boolean {
    if (!this.open || this.ws.bufferedAmount > DROP_BINARY_ABOVE) return false;
    this.ws.send(chunk, { binary: true });
    return true;
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
    }
  }
}
