import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";

/**
 * Edición en vivo por HTTP (producción en Vercel, donde no hay WebSockets compartidos entre instancias).
 * Hace lo mismo que `WebsocketProvider` de y-websocket, con su misma interfaz (eventos `status`, `sync`,
 * `connection-error` y `closed`; `awareness`; `connect`, `disconnect` y `destroy`), consultando
 * `POST <url>/<pageId>` del backend: envía los cambios y la presencia propios y recibe los de los demás.
 *
 * Ritmo de las consultas (cada una cuenta como invocación y, sobre todo, CPU activa en Vercel; el plan Hobby
 * solo incluye 4 horas de CPU al mes, ver `docs/limites-vercel-hobby.md`):
 * - 5 s mientras hay actividad (cambios propios o ajenos, teclado o ratón en los últimos 30 s);
 * - 20 s hasta los 5 minutos sin actividad, 60 s hasta los 30 minutos y después en pausa;
 * - en pausa con la pestaña oculta. Cualquier actividad la reanuda al instante.
 * Los cambios propios salen enseguida (con al menos 1,5 s entre consultas), así que al escribir no se nota.
 *
 * Sin conexión los cambios quedan en el documento (y en IndexedDB): al volver se envía la diferencia contra
 * lo que tiene el servidor, y Yjs combina las dos versiones.
 */
export const HTTP_POLLING = {
  activeMs: 5_000,
  idleMs: 20_000,
  slowMs: 60_000,
  minGapMs: 1_500,
  /** Sin actividad durante estos tiempos se pasa al siguiente ritmo. */
  activeForMs: 30_000,
  idleForMs: 5 * 60_000,
  pauseAfterMs: 30 * 60_000,
};

type Status = "connected" | "connecting" | "disconnected";
type Events = {
  status: { status: Status };
  sync: boolean;
  "connection-error": undefined;
  closed: { code: number };
};
type Listener<K extends keyof Events> = (payload: Events[K]) => void;

/** Códigos equivalentes a los de cierre del WebSocket. */
export const CLOSE_CODES = { unauthorized: 4401, forbidden: 4403, replaced: 4409 } as const;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

type SyncResponse = { epoch: string; access: "edit" | "read"; cursor: number; update: string | null; full: boolean; awareness: string | null };

export class HttpCollabProvider {
  readonly awareness: awarenessProtocol.Awareness;
  /** Mismo nombre que en WebsocketProvider: hay comunicación con el servidor. */
  wsconnected = false;
  synced = false;
  access: "edit" | "read" | null = null;

  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();
  private epoch: string | null = null;
  private cursor = 0;
  /** Cambios propios todavía no confirmados por el servidor. */
  private pending: Uint8Array[] = [];
  private awarenessDirty = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private again = false;
  private stopped = false;
  private destroyed = false;
  private failures = 0;
  private lastActivity = Date.now();
  private lastRequest = 0;
  private token: string | null;

  constructor(private readonly url: string, private readonly pageId: string, readonly doc: Y.Doc, private readonly options: { token: string | null; getToken: () => Promise<string | null> }) {
    this.token = options.token;
    this.awareness = new awarenessProtocol.Awareness(doc);
    doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    if (typeof window !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
      window.addEventListener("online", this.onWake);
      for (const event of ["keydown", "pointerdown", "focus"]) window.addEventListener(event, this.onUserActivity, { passive: true });
    }
    this.connect();
  }

  on<K extends keyof Events>(event: K, listener: Listener<K>) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as (payload: never) => void);
  }

  off<K extends keyof Events>(event: K, listener: Listener<K>) {
    this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  private emit<K extends keyof Events>(event: K, payload: Events[K]) {
    for (const listener of this.listeners.get(event) ?? []) (listener as Listener<K>)(payload);
  }

  connect() {
    if (this.destroyed) return;
    this.stopped = false;
    this.emit("status", { status: "connecting" });
    this.schedule(0);
  }

  disconnect() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wsconnected = false;
    this.emit("status", { status: "disconnected" });
  }

  destroy() {
    if (this.destroyed) return;
    // Avisar que se va (los demás dejan de verlo) sin esperar la respuesta.
    if (this.epoch && this.token && this.wsconnected) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "salida");
      const awareness = toBase64(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      void fetch(`${this.url}/${encodeURIComponent(this.pageId)}`, { method: "POST", keepalive: true, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ epoch: this.epoch, after: this.cursor, clientId: this.doc.clientID, awareness }) }).catch(() => {});
    }
    this.destroyed = true;
    this.disconnect();
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.awareness.destroy();
    if (typeof window !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
      window.removeEventListener("online", this.onWake);
      for (const event of ["keydown", "pointerdown", "focus"]) window.removeEventListener(event, this.onUserActivity);
    }
  }

  /* ---------- Eventos ---------- */

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    this.lastActivity = Date.now();
    if (origin === this) return;
    this.pending.push(update);
    this.schedule(0);
  };

  private readonly onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this || origin === "salida") return;
    if (![...added, ...updated, ...removed].includes(this.doc.clientID)) return;
    this.awarenessDirty = true;
    // y-protocols renueva la presencia cada 15 s: en pausa (o pestaña oculta) solo se marca para la próxima consulta.
    if (this.nextInterval() !== null) this.schedule(this.minWait());
  };

  private readonly onVisibility = () => { if (!document.hidden) this.onWake(); };
  private readonly onWake = () => { this.lastActivity = Date.now(); this.failures = 0; this.schedule(0); };
  private readonly onUserActivity = () => {
    const paused = Date.now() - this.lastActivity > HTTP_POLLING.pauseAfterMs;
    this.lastActivity = Date.now();
    if (paused) this.schedule(0);
  };

  /* ---------- Consultas ---------- */

  private minWait() { return Math.max(0, this.lastRequest + HTTP_POLLING.minGapMs - Date.now()); }

  /** Cuánto esperar a la siguiente consulta periódica; null = en pausa. */
  private nextInterval(): number | null {
    if (typeof document !== "undefined" && document.hidden) return null;
    const quiet = Date.now() - this.lastActivity;
    if (quiet < HTTP_POLLING.activeForMs) return HTTP_POLLING.activeMs;
    if (quiet < HTTP_POLLING.idleForMs) return HTTP_POLLING.idleMs;
    if (quiet < HTTP_POLLING.pauseAfterMs) return HTTP_POLLING.slowMs;
    return null;
  }

  private schedule(delay: number) {
    if (this.stopped || this.destroyed) return;
    if (this.inFlight) { this.again = true; return; }
    const wait = Math.max(delay, this.minWait());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, wait);
  }

  private async sync() {
    if (this.stopped || this.destroyed || this.inFlight) return;
    this.inFlight = true;
    this.lastRequest = Date.now();
    // Antes de la primera respuesta no se sabe qué tiene el servidor: los cambios propios se envían después.
    const sending = this.epoch ? this.pending.splice(0) : [];
    const sendAwareness = this.awarenessDirty;
    this.awarenessDirty = false;
    let retryIn: number | null = null;
    try {
      const res = await this.post({
        epoch: this.epoch, after: this.cursor, clientId: this.doc.clientID,
        ...(sending.length && { update: toBase64(sending.length === 1 ? sending[0] : Y.mergeUpdates(sending)) }),
        ...(sendAwareness && this.awareness.getLocalState() !== null && { awareness: toBase64(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])) }),
      });
      if (this.stopped || this.destroyed) return;
      if (res.status === 409) return this.close(CLOSE_CODES.replaced);
      if (res.status === 403 || res.status === 404) return this.close(CLOSE_CODES.forbidden);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SyncResponse;
      const first = !this.epoch;
      this.epoch = data.epoch;
      this.cursor = data.cursor;
      this.access = data.access;
      if (data.update) {
        const update = fromBase64(data.update);
        Y.applyUpdate(this.doc, update, this);
        // Primera vez: lo que este editor tenía y el servidor no (cambios sin conexión) se envía ahora.
        if (first) {
          const diff = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVectorFromUpdate(update));
          // Una actualización vacía ocupa 2 bytes.
          this.pending = diff.length > 2 ? [diff] : [];
        }
      }
      if (data.awareness) awarenessProtocol.applyAwarenessUpdate(this.awareness, fromBase64(data.awareness), this);
      if (first) this.awarenessDirty = true;
      this.failures = 0;
      if (!this.wsconnected) { this.wsconnected = true; this.emit("status", { status: "connected" }); }
      if (!this.synced) { this.synced = true; this.emit("sync", true); }
      if (this.pending.length || this.awarenessDirty) retryIn = 0;
    } catch {
      // Sin conexión o error del servidor: se conservan los cambios y se reintenta con espera creciente.
      this.pending.unshift(...sending);
      if (sendAwareness) this.awarenessDirty = true;
      this.failures++;
      if (this.wsconnected) { this.wsconnected = false; this.emit("status", { status: "disconnected" }); }
      this.emit("connection-error", undefined);
      retryIn = Math.min(30_000, 1_000 * 2 ** Math.min(this.failures, 5));
    } finally {
      this.inFlight = false;
    }
    if (this.stopped || this.destroyed) return;
    if (this.again) { this.again = false; retryIn = 0; }
    const interval = retryIn ?? this.nextInterval();
    if (interval !== null) this.schedule(interval);
  }

  private async post(body: object) {
    const send = () => fetch(`${this.url}/${encodeURIComponent(this.pageId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.token && { Authorization: `Bearer ${this.token}` }) },
      body: JSON.stringify(body),
    });
    let res = await send();
    if (res.status === 401) {
      // El token venció (8 h): se pide uno nuevo una vez.
      this.token = await this.options.getToken().catch(() => null);
      if (!this.token) { this.close(CLOSE_CODES.unauthorized); return res; }
      res = await send();
    }
    return res;
  }

  private close(code: number) {
    this.disconnect();
    this.emit("closed", { code });
  }
}
