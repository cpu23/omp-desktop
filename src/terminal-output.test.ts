import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { TerminalOutput } from "./terminal-output";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("repeated native backpressure preserves Unicode replay, live bytes, and exit order", async () => {
  const replay = ("x".repeat(16_382) + "😀").repeat(1024);
  const replayBytes = Buffer.byteLength(replay);
  const expectedHash = createHash("sha256").update(replay).digest("hex");
  const live = Buffer.from("live-after-replay");
  let socket: Socket | undefined;
  let hasDrained = false;
  const server = Bun.serve<{ output?: TerminalOutput }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, { data: {} }) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      backpressureLimit: 256 * 1024,
      closeOnBackpressureLimit: true,
      open(socket) {
        const output = socket.data.output = new TerminalOutput(socket);
        output.send(JSON.stringify({ type: "hello", replayBytes }));
        output.replay(replay, replayBytes);
        output.send(live);
        output.send(JSON.stringify({ type: "exit" }));
      },
      drain(peer) {
        hasDrained = true;
        peer.data.output?.drain();
        socket?.resume();
      },
      message() {},
      close(socket) { socket.data.output?.dispose(); },
    },
  });
  cleanup = () => {
    socket?.destroy();
    server.stop(true);
  };
  try {
    const result = await new Promise<{ hash: string; tail: Buffer; bytes: number }>((resolve, reject) => {
      const digest = createHash("sha256");
      const tail: Buffer[] = [];
      let carry = Buffer.alloc(0);
      let upgraded = false;
      let hello = false;
      let bytes = 0;
      socket = createConnection({ host: "127.0.0.1", port: server.port! });
      socket.on("error", reject);
      socket.on("end", () => reject(new Error("terminal socket ended before exit delivery")));
      socket.on("connect", () => socket!.write(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      ));
      socket.on("data", (chunk) => {
        try {
          if (typeof chunk === "string") throw new Error("expected binary TCP data");
          carry = Buffer.concat([carry, chunk]);
          if (!upgraded) {
            const boundary = carry.indexOf("\r\n\r\n");
            if (boundary < 0) return;
            if (!carry.subarray(0, boundary).toString().startsWith("HTTP/1.1 101"))
              throw new Error("WebSocket upgrade rejected");
            carry = carry.subarray(boundary + 4);
            upgraded = true;
            socket!.pause();
            if (hasDrained) socket!.resume();
          }
          while (carry.length >= 2) {
            const opcode = carry[0]! & 15;
            let length = carry[1]! & 127;
            let offset = 2;
            if (length === 126) {
              if (carry.length < 4) return;
              length = carry.readUInt16BE(2);
              offset = 4;
            } else if (length === 127) {
              if (carry.length < 10) return;
              length = Number(carry.readBigUInt64BE(2));
              offset = 10;
            }
            if (carry.length < offset + length) return;
            const payload = carry.subarray(offset, offset + length);
            carry = carry.subarray(offset + length);
            if (opcode === 2) {
              if (!hello) throw new Error("terminal bytes preceded hello");
              const prefix = Math.min(payload.length, Math.max(0, replayBytes - bytes));
              if (prefix) digest.update(payload.subarray(0, prefix));
              if (prefix < payload.length) tail.push(payload.subarray(prefix));
              bytes += payload.length;
            } else if (opcode === 1) {
              const message = JSON.parse(payload.toString()) as { type: string; replayBytes?: number };
              if (message.type === "hello") hello = message.replayBytes === replayBytes;
              if (message.type === "exit") resolve({ hash: digest.digest("hex"), tail: Buffer.concat(tail), bytes });
            } else if (opcode === 8) throw new Error("terminal socket closed before exit delivery");
          }
        } catch (error) { reject(error); }
      });
    });
    expect(result.hash).toBe(expectedHash);
    expect(result.tail.equals(live)).toBe(true);
    expect(result.bytes).toBe(replayBytes + live.length);
  } finally {
    cleanup?.();
    cleanup = undefined;
  }
}, 15_000);
