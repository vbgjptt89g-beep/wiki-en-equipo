/**
 * Edición en vivo con Yjs (protocolo y-websocket, Yjs v13: compatible con BlockNote y con
 * `WebsocketProvider` de y-websocket en el navegador).
 *
 *   ws(s)://<backend>/collab/pagina-<pageId>?token=<JWT>
 *
 * - Al conectar valida la sesión (JWT, cuenta activa, sessionVersion) y el acceso a la página.
 *   Sin sesión responde 401 y sin acceso 403, antes de abrir el WebSocket.
 * - Quien solo puede leer recibe el documento y los cambios, pero los suyos se ignoran.
 * - Los permisos se vuelven a comprobar: cada 30 s (latido), antes de aplicar cambios si la última
 *   comprobación tiene más de 10 s, y al instante cuando la API cambia permisos (refreshPage/refreshUser).
 *   Si pierde el acceso se cierra con el código 4403.
 * - Si el contenido se reemplaza por otra vía (restaurar una versión, sincronizar cambios sin conexión),
 *   resetPage() cierra las conexiones con 4409 y descarta el documento: el editor vuelve a cargar la página.
 * - Presencia (awareness): cada conexión solo puede publicar sus propios estados (los de quien sale quedan
 *   reservados un minuto para su reconexión) y el nombre que ven los demás es siempre el de su cuenta.
 * - El documento se guarda en PageCollabState (2 s después del último cambio, como máximo cada 10 s,
 *   y al salir la última persona), junto con la versión de la página a la que corresponde.
 * - Límites: tamaño de mensaje, conexiones por persona y por página, y latido para cerrar conexiones muertas.
 *
 * Las salas viven en la memoria de este proceso: con varias instancias del backend hace falta un bus
 * compartido (ver PENDIENTES_BACKEND.md).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { verifyAccessToken } from "../auth/token.js";
import { prisma } from "../models/client.js";
import { canEditPage, canReadPage, type Actor, type PageAccessRecord } from "../permissions/access.js";
import { resetHttpCollab } from "./http-collab.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
export const COLLAB_PATH = "/collab/";
const ROOM_PREFIX = "pagina-";
const LOAD_ORIGIN = Symbol("carga");

type Access = "edit" | "read";
type Identity = { actor: Actor; name: string; sessionVersion: number };
type Client = {
  socket: WebSocket;
  identity: Identity;
  access: Access;
  /** Estados de presencia (clientID de Yjs) que publicó esta conexión. */
  clientIds: Set<number>;
  checkedAt: number;
  alive: boolean;
  /** Los mensajes se procesan en orden, aunque alguno espere una comprobación de permisos. */
  queue: Promise<void>;
};
type Room = {
  pageId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<Client>;
  /** Conexiones aceptadas que todavía no terminan el saludo: la sala no se cierra mientras haya. */
  pending: number;
  loaded: Promise<void>;
  saveTimer?: NodeJS.Timeout;
  dirtySince?: number;
  saving: Promise<void>;
  /** La sala se descartó (resetPage): no se guarda nada más de ella. */
  discarded: boolean;
  /** clientIDs de quien acaba de salir: quedan reservados un minuto para esa persona (reconexión). */
  reserved: Map<number, { userId: string; until: number }>;
};

export type CollabOptions = {
  saveDelayMs?: number;
  maxSaveDelayMs?: number;
  heartbeatMs?: number;
  editRecheckMs?: number;
  maxMessageBytes?: number;
  maxAwarenessBytes?: number;
  maxClientsPerRoom?: number;
  maxConnectionsPerUser?: number;
  maxStateBytes?: number;
  allowedOrigins?: string[];
};

const numberFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Opciones a partir de las variables de entorno (ver .env.example). */
export function collabOptionsFromEnv(): CollabOptions {
  const origins = [process.env.FRONTEND_ORIGIN ?? "http://localhost:3000", ...(process.env.COLLAB_ALLOWED_ORIGINS ?? "").split(",")]
    .map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean);
  return {
    saveDelayMs: numberFromEnv("COLLAB_SAVE_DELAY_MS", 2_000),
    maxClientsPerRoom: numberFromEnv("COLLAB_MAX_CLIENTS_PER_PAGE", 50),
    maxConnectionsPerUser: numberFromEnv("COLLAB_MAX_CONNECTIONS_PER_USER", 20),
    allowedOrigins: origins,
  };
}

export class CollabServer {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  private readonly connectionsByUser = new Map<string, number>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly options: Required<CollabOptions>;
  private closed = false;

  constructor(options: CollabOptions = {}) {
    this.options = {
      saveDelayMs: 2_000,
      maxSaveDelayMs: 10_000,
      heartbeatMs: 30_000,
      editRecheckMs: 10_000,
      maxMessageBytes: 4 * 1024 * 1024,
      maxAwarenessBytes: 64 * 1024,
      maxClientsPerRoom: 50,
      maxConnectionsPerUser: 20,
      maxStateBytes: 20 * 1024 * 1024,
      allowedOrigins: [],
      ...options,
    };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.options.maxMessageBytes, perMessageDeflate: false });
    this.heartbeat = setInterval(() => this.beat(), this.options.heartbeatMs);
    this.heartbeat.unref();
  }

  /* ---------- Conexión ---------- */

  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    try {
      await this.upgrade(request, socket, head);
    } catch (error) {
      console.error("[colaboración] error al conectar:", error);
      reject(socket, 500, "Internal Server Error");
    }
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const roomName = url.pathname.slice(COLLAB_PATH.length);
    const pageId = roomName.startsWith(ROOM_PREFIX) ? roomName.slice(ROOM_PREFIX.length) : "";
    if (this.closed) return reject(socket, 503, "Service Unavailable");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(pageId)) return reject(socket, 404, "Not Found");
    // El navegador siempre envía Origin: solo se aceptan las páginas de la wiki (los clientes sin navegador no lo envían).
    const origin = request.headers.origin?.replace(/\/$/, "");
    if (origin && this.options.allowedOrigins.length && !this.options.allowedOrigins.includes(origin)) return reject(socket, 403, "Forbidden");

    const identity = await authenticate(url.searchParams.get("token"));
    if (!identity) return reject(socket, 401, "Unauthorized");
    const access = await pageAccess(pageId, identity.actor);
    if (!access) {
      console.warn(`[colaboración] acceso denegado a pagina-${pageId} (usuario ${identity.actor.id})`);
      return reject(socket, 403, "Forbidden");
    }
    if ((this.connectionsByUser.get(identity.actor.id) ?? 0) >= this.options.maxConnectionsPerUser) return reject(socket, 429, "Too Many Requests");

    const existing = this.rooms.get(pageId);
    if (existing && existing.clients.size + existing.pending >= this.options.maxClientsPerRoom) return reject(socket, 429, "Too Many Requests");
    const room = this.openRoom(pageId);
    room.pending++;
    try {
      await room.loaded;
      if (socket.destroyed) return;
      if (room.discarded) return reject(socket, 503, "Service Unavailable");
      await new Promise<void>((resolve) => {
        // Si el saludo falla, ws no llama al callback: el cierre del socket libera la espera.
        socket.once("close", () => resolve());
        this.wss.handleUpgrade(request, socket, head, (ws) => { this.join(room, ws, identity, access); resolve(); });
      });
    } finally {
      room.pending--;
      if (!room.clients.size) void this.closeRoomIfIdle(room);
    }
  }

  private join(room: Room, socket: WebSocket, identity: Identity, access: Access) {
    const client: Client = { socket, identity, access, clientIds: new Set(), checkedAt: Date.now(), alive: true, queue: Promise.resolve() };
    room.clients.add(client);
    this.connectionsByUser.set(identity.actor.id, (this.connectionsByUser.get(identity.actor.id) ?? 0) + 1);
    socket.binaryType = "arraybuffer";
    socket.on("pong", () => { client.alive = true; });
    socket.on("message", (data: ArrayBuffer | Buffer) => {
      const message = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      client.queue = client.queue.then(() => this.handleMessage(room, client, message)).catch((error) => {
        console.error(`[colaboración] mensaje inválido en pagina-${room.pageId}:`, error instanceof Error ? error.message : error);
        socket.close(4400, "invalid message");
      });
    });
    socket.on("close", () => this.leave(room, client));
    socket.on("error", () => socket.terminate());

    // Paso 1 de sincronización y presencia de quienes ya están en la página.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(client, encoding.toUint8Array(encoder));
    const states = room.awareness.getStates();
    if (states.size) send(client, awarenessMessage(room.awareness, [...states.keys()]));
  }

  private leave(room: Room, client: Client) {
    if (!room.clients.delete(client)) return;
    const count = (this.connectionsByUser.get(client.identity.actor.id) ?? 1) - 1;
    if (count > 0) this.connectionsByUser.set(client.identity.actor.id, count); else this.connectionsByUser.delete(client.identity.actor.id);
    const until = Date.now() + 60_000;
    for (const clientId of client.clientIds) room.reserved.set(clientId, { userId: client.identity.actor.id, until });
    if (client.clientIds.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...client.clientIds], null);
    if (!room.clients.size) void this.closeRoomIfIdle(room);
  }

  /* ---------- Mensajes ---------- */

  private async handleMessage(room: Room, client: Client, message: Uint8Array) {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const syncType = decoding.peekVarUint(decoder);
      // El paso 1 solo pide el documento. El paso 2 y las actualizaciones lo cambian: solo con permiso de edición.
      if (syncType !== syncProtocol.messageYjsSyncStep1) {
        if (Date.now() - client.checkedAt > this.options.editRecheckMs) await this.recheck(room, client);
        if (client.access !== "edit" || client.socket.readyState !== WebSocket.OPEN) return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, client);
      if (encoding.length(encoder) > 1) send(client, encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      if (update.length > this.options.maxAwarenessBytes) return;
      const checked = this.ownAwareness(room, client, update);
      if (checked) awarenessProtocol.applyAwarenessUpdate(room.awareness, checked, client);
    } else if (type === MESSAGE_QUERY_AWARENESS) {
      send(client, awarenessMessage(room.awareness, [...room.awareness.getStates().keys()]));
    }
  }

  /**
   * Revisa una actualización de presencia: rechaza estados de otras conexiones y pone el nombre real de
   * la cuenta (para que nadie se haga pasar por otra persona). Devuelve la actualización corregida.
   */
  private ownAwareness(room: Room, client: Client, update: Uint8Array): Uint8Array | null {
    const decoder = decoding.createDecoder(update);
    const encoder = encoding.createEncoder();
    const length = decoding.readVarUint(decoder);
    encoding.writeVarUint(encoder, length);
    for (let i = 0; i < length; i++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const state = JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown> | null;
      const reservation = room.reserved.get(clientId);
      if (reservation && reservation.until > Date.now() && reservation.userId !== client.identity.actor.id) return null;
      room.reserved.delete(clientId);
      for (const other of room.clients) {
        if (other === client || !other.clientIds.has(clientId)) continue;
        // La misma persona que se reconecta (la conexión vieja aún no se cerró) recupera su estado; nadie más.
        if (other.identity.actor.id !== client.identity.actor.id) return null;
        other.clientIds.delete(clientId);
      }
      if (state !== null) client.clientIds.add(clientId);
      const user = state && typeof state.user === "object" && state.user !== null ? state.user as Record<string, unknown> : {};
      const color = typeof user.color === "string" && /^#[0-9a-f]{3,8}$/i.test(user.color) ? user.color : "#2e6a4f";
      encoding.writeVarUint(encoder, clientId);
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarString(encoder, JSON.stringify(state === null ? null : { ...state, user: { ...user, name: client.identity.name, color } }));
    }
    return encoding.toUint8Array(encoder);
  }

  /* ---------- Permisos ---------- */

  /** Vuelve a validar sesión y acceso. Sin acceso cierra la conexión; si cambió, actualiza lectura/edición. */
  private async recheck(room: Room, client: Client) {
    client.checkedAt = Date.now();
    const user = await prisma.user.findFirst({ where: { id: client.identity.actor.id, active: true }, select: { id: true, name: true, role: true, departmentId: true, sessionVersion: true } });
    const identity = user && user.sessionVersion === client.identity.sessionVersion ? { actor: { id: user.id, role: user.role, departmentId: user.departmentId }, name: user.name, sessionVersion: user.sessionVersion } : null;
    const access = identity ? await pageAccess(room.pageId, identity.actor) : null;
    if (!identity || !access) { client.socket.close(4403, "access revoked"); return; }
    client.identity = identity;
    client.access = access;
  }

  /** La API avisa que cambiaron los permisos de una página (compartir, publicar, papelera...). */
  refreshPage(pageId: string) {
    const room = this.rooms.get(pageId);
    if (room) for (const client of room.clients) client.queue = client.queue.then(() => this.recheck(room, client)).catch(() => client.socket.terminate());
  }

  /**
   * El contenido de la página se reemplazó por otra vía (restaurar una versión, sincronizar cambios sin
   * conexión): el documento en memoria y el guardado ya no sirven. Se cierran las conexiones con 4409
   * para que el editor vuelva a cargar la página, y se borra el estado guardado.
   */
  async resetPage(pageId: string) {
    const room = this.rooms.get(pageId);
    if (room) {
      room.discarded = true;
      if (room.saveTimer) clearTimeout(room.saveTimer);
      this.rooms.delete(pageId);
      for (const client of room.clients) client.socket.close(4409, "document replaced");
      await room.saving;
      room.doc.destroy();
    }
    await prisma.pageCollabState.deleteMany({ where: { pageId } });
    // También la edición en vivo por HTTP (Vercel): los editores abiertos reciben 409 y vuelven a cargar.
    await resetHttpCollab(pageId);
  }

  /** Cambios que afectan a varias páginas a la vez (muros). */
  refreshAll() {
    for (const pageId of this.rooms.keys()) this.refreshPage(pageId);
  }

  /** La API avisa que cambió una cuenta (rol, departamento, desactivada, contraseña). */
  refreshUser(userId: string) {
    for (const room of this.rooms.values()) for (const client of room.clients) {
      if (client.identity.actor.id === userId) client.queue = client.queue.then(() => this.recheck(room, client)).catch(() => client.socket.terminate());
    }
  }

  /* ---------- Salas y guardado ---------- */

  private openRoom(pageId: string): Room {
    const existing = this.rooms.get(pageId);
    if (existing) return existing;
    const doc = new Y.Doc({ gc: true });
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const room: Room = { pageId, doc, awareness, clients: new Set(), pending: 0, loaded: Promise.resolve(), saving: Promise.resolve(), discarded: false, reserved: new Map() };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const client of room.clients) if (client !== origin) send(client, message);
      this.scheduleSave(room);
    });
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = [...added, ...updated, ...removed];
      if (!changed.length) return;
      const message = awarenessMessage(awareness, changed);
      for (const client of room.clients) send(client, message);
    });
    room.loaded = this.load(room);
    this.rooms.set(pageId, room);
    return room;
  }

  /** Carga el estado guardado si corresponde a la versión actual de la página; si no, se descarta. */
  private async load(room: Room) {
    try {
      const [saved, page] = await Promise.all([
        prisma.pageCollabState.findUnique({ where: { pageId: room.pageId } }),
        prisma.page.findUnique({ where: { id: room.pageId }, select: { version: true } }),
      ]);
      if (!saved || !page) return;
      if (saved.pageVersion !== page.version) { await prisma.pageCollabState.deleteMany({ where: { pageId: room.pageId } }); return; }
      Y.applyUpdate(room.doc, new Uint8Array(saved.state), LOAD_ORIGIN);
    } catch (error) {
      console.error(`[colaboración] no se pudo cargar pagina-${room.pageId}:`, error);
    }
  }

  private scheduleSave(room: Room) {
    const now = Date.now();
    room.dirtySince ??= now;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    const wait = Math.max(0, Math.min(this.options.saveDelayMs, room.dirtySince + this.options.maxSaveDelayMs - now));
    room.saveTimer = setTimeout(() => { void this.save(room); }, wait);
    room.saveTimer.unref();
  }

  private save(room: Room): Promise<void> {
    if (room.saveTimer) { clearTimeout(room.saveTimer); room.saveTimer = undefined; }
    if (room.dirtySince === undefined || room.discarded) return room.saving;
    room.dirtySince = undefined;
    const state = Y.encodeStateAsUpdate(room.doc);
    room.saving = room.saving.then(async () => {
      if (state.byteLength > this.options.maxStateBytes) { console.error(`[colaboración] pagina-${room.pageId} supera el tamaño máximo; no se guarda.`); return; }
      const page = await prisma.page.findUnique({ where: { id: room.pageId }, select: { version: true } });
      if (!page || room.discarded) return;
      await prisma.pageCollabState.upsert({ where: { pageId: room.pageId }, create: { pageId: room.pageId, state: Buffer.from(state), pageVersion: page.version }, update: { state: Buffer.from(state), pageVersion: page.version } });
    }).catch((error) => console.error(`[colaboración] no se pudo guardar pagina-${room.pageId}:`, error));
    return room.saving;
  }

  private async closeRoomIfIdle(room: Room) {
    await this.save(room);
    if (room.clients.size || room.pending || this.rooms.get(room.pageId) !== room) return;
    this.rooms.delete(room.pageId);
    room.doc.destroy();
  }

  /** Guarda ya todas las salas con cambios pendientes (pruebas y apagado). */
  async flushAll() {
    await Promise.all([...this.rooms.values()].map((room) => this.save(room)));
  }

  private beat() {
    for (const room of this.rooms.values()) for (const client of room.clients) {
      if (!client.alive) { client.socket.terminate(); continue; }
      client.alive = false;
      client.socket.ping();
      client.queue = client.queue.then(() => this.recheck(room, client)).catch(() => client.socket.terminate());
    }
  }

  /** Apagado ordenado: guarda y cierra todas las conexiones. */
  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    await this.flushAll();
    for (const room of this.rooms.values()) for (const client of room.clients) client.socket.close(1001, "server shutdown");
  }

  /** Para pruebas y monitoreo. */
  stats() {
    return { rooms: this.rooms.size, connections: [...this.rooms.values()].reduce((total, room) => total + room.clients.size, 0) };
  }
}

/* ---------- Utilidades ---------- */

function reject(socket: Duplex, status: number, text: string) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function send(client: Client, message: Uint8Array) {
  const { socket } = client;
  if (socket.readyState !== WebSocket.OPEN) return;
  // Un cliente que no lee (red muy lenta o colgada) no debe acumular memoria sin límite.
  if (socket.bufferedAmount > 16 * 1024 * 1024) { socket.terminate(); return; }
  socket.send(message, (error) => { if (error) socket.terminate(); });
}

function awarenessMessage(awareness: awarenessProtocol.Awareness, clients: number[]) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

async function authenticate(token: string | null): Promise<Identity | null> {
  if (!token || token.length > 4096) return null;
  try {
    const claims = verifyAccessToken(token);
    const user = await prisma.user.findFirst({ where: { id: claims.sub, active: true }, select: { id: true, name: true, role: true, departmentId: true, sessionVersion: true } });
    if (!user || user.sessionVersion !== claims.sessionVersion) return null;
    return { actor: { id: user.id, role: user.role, departmentId: user.departmentId }, name: user.name, sessionVersion: user.sessionVersion };
  } catch {
    return null;
  }
}

async function pageAccess(pageId: string, actor: Actor): Promise<Access | null> {
  const page = await prisma.page.findFirst({ where: { id: pageId, deletedAt: null }, include: { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } } } });
  if (!page || !canReadPage(page as PageAccessRecord, actor)) return null;
  return canEditPage(page as PageAccessRecord, actor) ? "edit" : "read";
}
