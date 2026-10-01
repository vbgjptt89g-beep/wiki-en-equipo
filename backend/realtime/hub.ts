import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import { verifyAccessToken } from "../auth/token.js";
import { prisma } from "../models/client.js";
import { canEditPage, canReadPage } from "../permissions/access.js";

type RoomClient = { socket: WebSocket; userId: string; role: "USER" | "DEPARTMENT_ADMIN" | "ADMIN"; departmentId: string };

export class RealtimeHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly rooms = new Map<string, Set<RoomClient>>();

  attach(server: Server) {
    server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/realtime") { socket.destroy(); return; }
      this.wss.handleUpgrade(request, socket, head, (client) => this.wss.emit("connection", client, request));
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
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
