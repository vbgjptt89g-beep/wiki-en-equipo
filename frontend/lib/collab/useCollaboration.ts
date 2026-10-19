"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import { getRealtimeToken } from "@/app/actions/session";
import { HttpCollabProvider } from "./http-provider";
import { connectPageChannel, type ChannelStatus } from "./realtime";

export type Peer = { clientId: number; name: string; color: string };

const COLORS = ["#e2001a", "#1f5fae", "#b07d00", "#1b1717", "#7a4fa3", "#2f8f8a"];
export const colorFor = (seed: string) => {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
};

/**
 * Dirección de la edición en vivo del backend.
 * - `NEXT_PUBLIC_COLLAB_URL` con `ws(s)://…/collab`: servidor Yjs por WebSocket (protocolo y-websocket).
 * - `NEXT_PUBLIC_COLLAB_URL` con `http(s)://…/api/collab`: consultas periódicas por HTTP (producción en Vercel,
 *   ver http-provider.ts).
 * - `NEXT_PUBLIC_COLLAB_URL=off`: sin edición en vivo; se usa el canal de avisos `/realtime`.
 * - Sin definir: la misma máquina que `NEXT_PUBLIC_REALTIME_URL` o el puerto 4000 de este host.
 */
export function collabUrl(): string {
  const configured = process.env.NEXT_PUBLIC_COLLAB_URL?.trim();
  if (configured === "off") return "";
  if (configured) return configured.replace(/\/$/, "");
  const realtime = process.env.NEXT_PUBLIC_REALTIME_URL?.trim();
  if (realtime) return realtime.replace(/\/realtime\/?$/, "/collab");
  const secure = typeof location !== "undefined" && location.protocol === "https:";
  const host = typeof location !== "undefined" ? location.hostname : "localhost";
  return `${secure ? "wss" : "ws"}://${host}:4000/collab`;
}

/** Lo que este hook usa del proveedor: WebsocketProvider (local) o HttpCollabProvider (Vercel). */
type LiveProvider = {
  awareness: HttpCollabProvider["awareness"];
  wsconnected: boolean;
  on(event: "status", listener: (event: { status: string }) => void): void;
  on(event: "sync", listener: (synced: boolean) => void): void;
  on(event: "connection-error", listener: () => void): void;
  on(event: "closed", listener: (event: { code: number }) => void): void;
  connect(): void;
  disconnect(): void;
  destroy(): void;
};

/** La edición en vivo va por HTTP (consultas periódicas) en lugar de WebSocket. */
export const isHttpCollab = (url: string) => /^https?:///.test(url);

/** Códigos con los que el backend cierra la conexión en vivo (por HTTP, los mismos para 409 y 403). */
const ACCESS_REVOKED = 4403;
const CONTENT_REPLACED = 4409;
/** Intentos seguidos sin poder conectar antes de esperar un minuto (servidor caído o sin acceso). */
const MAX_FAILED_ATTEMPTS = 6;

/**
 * Documento colaborativo de una página:
 * - `Y.Doc` con el contenido del editor (fragmento) y datos de la página (mapa `meta`).
 * - y-indexeddb: guarda todo en este dispositivo, así se puede editar sin conexión.
 * - Edición en vivo con el servidor Yjs del backend: los cambios llegan al instante y se ve quién más
 *   está editando. Si el contenido se reemplaza por otra vía (restaurar una versión), el backend cierra
 *   la conexión (4409): se borra la copia local y se vuelve a cargar la página.
 * - Con la edición en vivo desactivada: el canal `/realtime` avisa cuando otra persona guarda.
 */
export function useCollaboration({ pageId, user, onRemoteSave, enabled = true }: {
  pageId: string;
  enabled?: boolean;
  user: { id: string; name: string };
  onRemoteSave: (version: number) => void;
}) {
  const url = collabUrl();
  const doc = useMemo(() => new Y.Doc(), [pageId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [localReady, setLocalReady] = useState(false);
  const [remoteSynced, setRemoteSynced] = useState(!url);
  const [status, setStatus] = useState<ChannelStatus>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [provider, setProvider] = useState<LiveProvider | null>(null);
  /** El contenido se reemplazó en el servidor: no hay que guardar nada más desde este editor. */
  const [replaced, setReplaced] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const persistenceRef = useRef<IndexeddbPersistence | null>(null);
  const onRemoteSaveRef = useRef(onRemoteSave);
  onRemoteSaveRef.current = onRemoteSave;

  const color = colorFor(user.id);

  // Copia local (IndexedDB). El nombre incluye al usuario para no mezclar borradores en un equipo compartido.
  useEffect(() => {
    if (!enabled) return;
    const persistence = new IndexeddbPersistence(`wiki-pagina-${pageId}-${user.id}`, doc);
    persistenceRef.current = persistence;
    persistence.once("synced", () => setLocalReady(true));
    return () => { persistenceRef.current = null; void persistence.destroy(); };
  }, [doc, pageId, user.id, enabled]);

  // Conexión en vivo.
  useEffect(() => {
    if (!enabled) return;
    if (url) {
      let ws: LiveProvider | null = null;
      let cancelled = false;
      let failures = 0;
      let retry: ReturnType<typeof setTimeout> | null = null;
      void getRealtimeToken().then((token) => {
        if (cancelled) return;
        ws = isHttpCollab(url)
          ? new HttpCollabProvider(url, pageId, doc, { token, getToken: getRealtimeToken }) as LiveProvider
          : new WebsocketProvider(url, `pagina-${pageId}`, doc, { params: token ? { token } : {} }) as unknown as LiveProvider;
        ws.awareness.setLocalStateField("user", { name: user.name, color });
        ws.on("status", ({ status: s }: { status: string }) => {
          if (s === "connected") failures = 0;
          setStatus(s === "connected" ? "online" : navigator.onLine ? "connecting" : "offline");
        });
        ws.on("sync", (synced: boolean) => { if (synced) setRemoteSynced(true); });
        // Sin sesión, sin acceso o servidor caído: tras varios intentos se espera un minuto.
        ws.on("connection-error", () => {
          if (++failures < MAX_FAILED_ATTEMPTS || !ws) return;
          ws.disconnect();
          setStatus("offline");
          retry = setTimeout(() => { failures = 0; ws?.connect(); }, 60_000);
        });
        ws.on("closed", ({ code }: { code: number }) => {
          if (code === ACCESS_REVOKED) { setAccessLost(true); setStatus("offline"); }
          if (code === CONTENT_REPLACED) {
            setReplaced(true);
            // Se borra la copia local (ya no sirve) y se recarga; un pequeño desfase evita que
            // varias personas carguen el contenido a la vez en el documento nuevo.
            void (persistenceRef.current?.clearData() ?? Promise.resolve()).finally(() => {
              setTimeout(() => window.location.reload(), 600 + Math.random() * 1400);
            });
          }
        });
        const updatePeers = () => {
          const list: Peer[] = [];
          ws!.awareness.getStates().forEach((state, clientId) => {
            const u = (state as { user?: { name: string; color: string } }).user;
            if (u && clientId !== doc.clientID) list.push({ clientId, name: u.name, color: u.color });
          });
          setPeers(list);
        };
        ws.awareness.on("change", updatePeers);
        setProvider(ws);
      });
      // Si no hay conexión al abrir, se trabaja con la copia local. Si sí hay conexión se espera la
      // sincronización: cargar el contenido antes haría que se duplicara al combinarse con el remoto.
      const fallback = setTimeout(() => { if (!ws?.wsconnected) setRemoteSynced(true); }, 4000);
      return () => { cancelled = true; clearTimeout(fallback); if (retry) clearTimeout(retry); ws?.destroy(); setProvider(null); };
    }
    return connectPageChannel({
      pageId,
      getToken: getRealtimeToken,
      onStatus: setStatus,
      onRefresh: (version) => onRemoteSaveRef.current(version),
    });
  }, [doc, pageId, user.name, color, enabled, url]);

  const collaboration = useMemo(
    () => (enabled && localReady && remoteSynced ? { fragment: doc.getXmlFragment("document-store"), user: { name: user.name, color }, provider: provider ?? undefined } : null),
    [doc, localReady, remoteSynced, provider, user.name, color, enabled],
  );

  return {
    doc, ready: !enabled || (localReady && remoteSynced), collaboration, status, peers,
    live: Boolean(url), replaced, accessLost,
  };
}
