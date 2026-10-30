import "server-only";
import { createHash } from "node:crypto";
import type http from "node:http";
import type net from "node:net";

/**
 * ComfyUI's /ws, as far as Crackio's progress bar needs it, for the stand-ins that aren't a ComfyUI (a RunPod endpoint,
 * Comfy Cloud): the handshake, then a text frame per update. What the page sends (a keep-alive now and then) is read and
 * dropped; a close frame ends it.
 */
export function acceptSocket(sockets: Set<net.Socket>, req: http.IncomingMessage, socket: net.Socket) {
  const key = req.headers["sec-websocket-key"];
  if (!(req.url ?? "").startsWith("/ws") || typeof key !== "string") return socket.destroy();
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
  sockets.add(socket);
  socket.on("data", (chunk: Buffer) => {
    if (chunk.length && (chunk[0] & 0x0f) === 8) socket.end();
  });
  const drop = () => sockets.delete(socket);
  socket.on("close", drop);
  socket.on("error", drop);
}

/** One message to every open socket, as a text frame. */
export function broadcast(sockets: Set<net.Socket> | undefined, message: unknown) {
  if (!sockets?.size) return;
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length >= 65_536) return;
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  for (const socket of sockets) if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
}
