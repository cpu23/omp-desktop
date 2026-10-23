import type { ServerWebSocket } from "bun";

const FRAME_BYTES = 64 * 1024;
const MAX_PENDING_LIVE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_FRAMES = 4096;

type Socket = Pick<ServerWebSocket<unknown>, "readyState" | "send" | "close">;
type Pending = { data: string | Uint8Array; offset: number; replay: boolean; bytes: number };

/** Preserve hello → snapshot → live → exit ordering while Bun applies backpressure. */
export class TerminalOutput {
  #socket: Socket;
  #pending: Array<Pending | undefined> = [];
  #index = 0;
  #liveBytes = 0;
  #blocked = false;
  #closed = false;
  #resumeScheduled = false;

  constructor(socket: Socket) {
    this.#socket = socket;
  }

  send(data: string | Uint8Array): void {
    this.#enqueue(data, false, typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);
  }

  replay(data: string, bytes: number): void {
    this.#enqueue(data, true, bytes);
  }

  #enqueue(data: string | Uint8Array, replay: boolean, bytes: number): void {
    if (this.#closed || bytes === 0) return;
    if ((!replay && this.#liveBytes + bytes > MAX_PENDING_LIVE_BYTES) || this.#pending.length - this.#index >= MAX_PENDING_FRAMES) {
      this.close();
      return;
    }
    this.#pending.push({ data, offset: 0, replay, bytes });
    if (!replay) this.#liveBytes += bytes;
    this.#flush();
  }

  drain(): void {
    if (this.#closed || this.#resumeScheduled) return;
    this.#resumeScheduled = true;
    // Resume outside Bun's drain callback so reblocking rearms the next wakeup.
    setImmediate(() => {
      this.#resumeScheduled = false;
      this.#blocked = false;
      this.#flush();
    });
  }

  dispose(): void {
    this.#closed = true;
    this.#pending = [];
    this.#index = 0;
    this.#liveBytes = 0;
  }

  close(): void {
    if (this.#closed) return;
    this.dispose();
    this.#socket.close(1013, "Terminal output backpressure; reconnect for a fresh snapshot");
  }

  #flush(): void {
    if (this.#blocked || this.#closed) return;
    if (this.#socket.readyState !== 1) {
      this.dispose();
      return;
    }
    while (this.#index < this.#pending.length) {
      const pending = this.#pending[this.#index]!;
      let frame: string | Uint8Array;
      let consumed: number;
      if (typeof pending.data === "string") {
        if (pending.replay) {
          let end = Math.min(pending.offset + FRAME_BYTES / 4, pending.data.length);
          const last = pending.data.charCodeAt(end - 1);
          if (end < pending.data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
          consumed = end - pending.offset;
          frame = Buffer.from(pending.data.slice(pending.offset, end), "utf8");
        } else {
          frame = pending.data;
          consumed = pending.data.length;
        }
      } else {
        frame = pending.data.subarray(pending.offset, pending.offset + FRAME_BYTES);
        consumed = frame.byteLength;
      }
      const sent = this.#socket.send(frame);
      if (sent === 0) {
        this.close();
        return;
      }
      const size = typeof frame === "string" ? pending.bytes : frame.byteLength;
      pending.offset += consumed;
      if (!pending.replay) this.#liveBytes -= size;
      const length = typeof pending.data === "string" ? pending.data.length : pending.data.byteLength;
      if (pending.offset >= length) {
        this.#pending[this.#index++] = undefined;
      }
      if (sent === -1) {
        this.#blocked = true;
        break;
      }
    }
    if (this.#index === this.#pending.length) {
      this.#pending = [];
      this.#index = 0;
    } else if (this.#index > 128) {
      this.#pending = this.#pending.slice(this.#index);
      this.#index = 0;
    }
  }
}
