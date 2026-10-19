import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { verifyAccessToken } from "../auth/token.js";
import { prisma } from "../models/client.js";
import { canEditPage, canReadPage } from "../permissions/access.js";

type RoomClient = { socket: WebSocket; userId: string; role: "USER" | "DEPARTMENT_ADMIN" | "ADMIN"; departmentId: string };

export class RealtimeHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly rooms = new Map<string, Set<RoomClient>>();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly heartbeat: NodeJS.Timeout;

  /**
   * `heartbeatMs`: cada cuánto se envía un ping. Detrás de un proxy (Nginx...) las conexiones sin
   * tráfico se cortan; el ping las mantiene abiertas y cierra las que ya no responden.
   */
  constructor(heartbeatMs = 30_000) {
    this.wss.on("connection", (socket) => {
      this.alive.add(socket);
      socket.on("pong", () => this.alive.add(socket));
      this.onConnection(socket);
    });
    this.heartbeat = setInterval(() => {
      for (const socket of this.wss.clients) {
        if (!this.alive.has(socket)) { socket.terminate(); continue; }
        this.alive.delete(socket);
        socket.ping();
      }
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  close() {
    clearInterval(this.heartbeat);
    for (const socket of this.wss.clients) socket.close(1001, "server shutdown");
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(request, socket, head, (client) => this.wss.emit("connection", client, request));
  }

  broadcast(pageId: string, message: object, except?: WebSocket) {
    for (const client of this.rooms.get(pageId) ?? []) {
      if (client.socket !== except && client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message));
    }
  }

  private onConnection(socket: WebSocket) {
    let roomPageId: string | undefined;
    let member: RoomClient | undefined;
    const timeout = setTimeout(() => socket.close(4401, "authentication timeout"), 10_000);
    socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; token?: string; pageId?: string; version?: number };
        if (!member) {
          if (message.type !== "auth" || !message.token || !message.pageId) { socket.close(4401, "authenticate first"); return; }
          const claims = verifyAccessToken(message.token);
          const user = await prisma.user.findFirst({ where: { id: claims.sub, active: true } });
          const page = await prisma.page.findFirst({ where: { id: message.pageId, deletedAt: null }, include: { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } } } });
          if (!user || user.sessionVersion !== claims.sessionVersion || !page || !canReadPage(page, { id: user.id, role: user.role as RoomClient["role"], departmentId: user.departmentId })) { socket.close(4403, "page access denied"); return; }
          clearTimeout(timeout);
          roomPageId = page.id;
          member = { socket, userId: user.id, role: user.role as RoomClient["role"], departmentId: user.departmentId };
          const room = this.rooms.get(page.id) ?? new Set<RoomClient>();
          room.add(member); this.rooms.set(page.id, room);
          socket.send(JSON.stringify({ type: "ready", pageId: page.id, version: page.version }));
          return;
        }
        if (message.type === "page.changed" && roomPageId && member) {
          const page = await prisma.page.findFirst({ where: { id: roomPageId, deletedAt: null }, include: { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } } } });
          if (!page || !canEditPage(page, { id: member.userId, role: member.role, departmentId: member.departmentId })) { socket.close(4403, "edit access denied"); return; }
          this.broadcast(roomPageId, { type: "page.refresh", pageId: roomPageId, version: page.version, changedBy: member.userId }, socket);
        }
      } catch { socket.close(4400, "invalid message"); }
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (roomPageId && member) {
        const room = this.rooms.get(roomPageId); room?.delete(member);
        if (!room?.size) this.rooms.delete(roomPageId);
      }
    });
  }
}
