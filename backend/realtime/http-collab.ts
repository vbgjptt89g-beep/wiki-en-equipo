/**
 * Edición en vivo por HTTP, para producción en Vercel (sus funciones no comparten memoria entre instancias,
 * así que el servidor de WebSockets de collab.ts no sirve allí). Cada editor llama periódicamente a
 *
 *   POST /api/collab/:pageId  { epoch?, after?, update?, awareness?, clientId? }
 *
 * con lo que cambió en su documento y su presencia, y recibe lo de los demás. Todo vive en Turso:
 * - CollabUpdate: los cambios de Yjs, en el orden en que llegan (solo se agregan).
 * - CollabDoc: el documento compactado (`snapshot`) y hasta qué cambio incluye (`lastUpdateId`).
 * - CollabPresence: la presencia ("también editando") de cada cliente de Yjs.
 *
 * Permisos en cada petición (la sesión ya la valida requireAuth): sin acceso a la página, 403; quien solo
 * puede leer recibe el documento y los cambios, pero los suyos se ignoran. Si el contenido se reemplazó
 * por otra vía (restaurar una versión), el epoch cambia y el editor recibe 409 para volver a cargar.
 * La presencia de cada clientID es de quien la publicó (un minuto de reserva) y el nombre que ven los
 * demás es siempre el de la cuenta.
 */
import { randomUUID } from "node:crypto";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { prisma } from "../models/client.js";
import { canEditPage, canReadPage, type Actor, type PageAccessRecord } from "../permissions/access.js";
import { badRequest, forbidden, HttpError, notFound } from "../services/errors.js";

export const HTTP_COLLAB = {
  /** Tamaño máximo de un cambio de Yjs (Vercel no acepta cuerpos de más de 4,5 MB; va en base64). */
  maxUpdateBytes: 2 * 1024 * 1024,
  maxAwarenessBytes: 64 * 1024,
  /** Presencia visible: lo que se actualizó en los últimos 30 s (cada editor la renueva cada 15 s). */
  presenceTtlMs: 30_000,
  /** Un clientID queda reservado para quien lo publicó durante un minuto. */
  presenceReserveMs: 60_000,
  /** Se compacta cuando hay más de esta cantidad de cambios fuera del snapshot. */
  compactAfter: 50,
  /** Los cambios ya compactados se borran después de 5 minutos (una lectura en curso todavía los encuentra). */
  compactGraceMs: 5 * 60_000,
};

export type CollabSyncInput = { epoch?: string | null; after?: number; update?: string; awareness?: string; clientId?: number };
export type CollabSyncResult = {
  epoch: string;
  access: "edit" | "read";
  /** Último cambio incluido en la respuesta: el editor lo envía como `after` la próxima vez. */
  cursor: number;
  /** Cambios de Yjs combinados (base64). Si `full`, es el documento completo. */
  update: string | null;
  full: boolean;
  /** Presencia de los demás (actualización de awareness de y-protocols, base64). */
  awareness: string | null;
  /** El cambio enviado se ignoró: la persona solo puede leer. */
  ignored?: true;
};

const decode = (base64: string, max: number, what: string) => {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > max) throw new HttpError(413, "FILE_TOO_LARGE", `El ${what} es demasiado grande.`);
  return new Uint8Array(bytes);
};
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export class ContentReplacedError extends HttpError {
  constructor() { super(409, "CONFLICT", "El contenido de la página se reemplazó. Vuelve a cargarla."); }
}

async function pageAccess(pageId: string, actor: Actor): Promise<"edit" | "read"> {
  const page = await prisma.page.findFirst({ where: { id: pageId, deletedAt: null }, include: { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } } } });
  if (!page) throw notFound("No se encontró la página.");
  if (!canReadPage(page as PageAccessRecord, actor)) throw forbidden("No tienes acceso a esta página.");
  return canEditPage(page as PageAccessRecord, actor) ? "edit" : "read";
}

/** El documento de la página; se crea vacío la primera vez (el primer editor lo llena con el contenido guardado). */
async function openDoc(pageId: string) {
  const existing = await prisma.collabDoc.findUnique({ where: { pageId } });
  if (existing) return existing;
  try {
    return await prisma.collabDoc.create({ data: { pageId, epoch: randomUUID(), snapshot: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), lastUpdateId: 0 } });
  } catch {
    // Otro editor lo creó al mismo tiempo.
    const doc = await prisma.collabDoc.findUnique({ where: { pageId } });
    if (!doc) throw new Error("No se pudo abrir el documento en vivo.");
    return doc;
  }
}

/**
 * Revisa la presencia enviada: solo estados propios (un clientID de otra persona en su minuto de reserva se
 * ignora), con el nombre real de la cuenta y un color válido. Devuelve los clientID que publicó.
 */
async function savePresence(pageId: string, actor: Actor, name: string, update: Uint8Array) {
  const decoder = decoding.createDecoder(update);
  const length = Math.min(decoding.readVarUint(decoder), 16);
  const own: string[] = [];
  for (let i = 0; i < length; i++) {
    const clientId = String(decoding.readVarUint(decoder));
    const clock = decoding.readVarUint(decoder);
    const raw = JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown> | null;
    const current = await prisma.collabPresence.findUnique({ where: { pageId_clientId: { pageId, clientId } }, select: { userId: true, clock: true, updatedAt: true } });
    if (current && current.userId !== actor.id && Date.now() - current.updatedAt.getTime() < HTTP_COLLAB.presenceReserveMs) continue;
    own.push(clientId);
    if (current && current.userId === actor.id && current.clock > clock) continue;
    const user = raw && typeof raw.user === "object" && raw.user !== null ? raw.user as Record<string, unknown> : {};
    const color = typeof user.color === "string" && /^#[0-9a-f]{3,8}$/i.test(user.color) ? user.color : "#e2001a";
    const state = raw === null ? null : JSON.stringify({ ...raw, user: { ...user, name, color } });
    await prisma.collabPresence.upsert({
      where: { pageId_clientId: { pageId, clientId } },
      create: { pageId, clientId, userId: actor.id, clock, state },
      update: { userId: actor.id, clock, state },
    });
  }
  return own;
}

/** Actualización de awareness con la presencia vigente de los demás. */
function encodePresence(rows: { clientId: string; clock: number; state: string | null }[]) {
  if (!rows.length) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, rows.length);
  for (const row of rows) {
    encoding.writeVarUint(encoder, Number(row.clientId));
    encoding.writeVarUint(encoder, row.clock);
    encoding.writeVarString(encoder, row.state ?? "null");
  }
  return toBase64(encoding.toUint8Array(encoder));
}

/** Junta en el snapshot los cambios acumulados. Si otro editor compactó al mismo tiempo, no hace nada. */
async function compact(pageId: string) {
  const doc = await prisma.collabDoc.findUnique({ where: { pageId } });
  if (!doc) return;
  const updates = await prisma.collabUpdate.findMany({ where: { pageId, id: { gt: doc.lastUpdateId } }, orderBy: { id: "asc" }, select: { id: true, data: true } });
  if (updates.length <= HTTP_COLLAB.compactAfter) return;
  const snapshot = Y.mergeUpdates([new Uint8Array(doc.snapshot), ...updates.map((u) => new Uint8Array(u.data))]);
  const lastUpdateId = updates[updates.length - 1].id;
  const { count } = await prisma.collabDoc.updateMany({ where: { pageId, epoch: doc.epoch, lastUpdateId: doc.lastUpdateId }, data: { snapshot: Buffer.from(snapshot), lastUpdateId } });
  if (!count) return;
  const before = new Date(Date.now() - HTTP_COLLAB.compactGraceMs);
  await prisma.collabUpdate.deleteMany({ where: { pageId, id: { lte: lastUpdateId }, createdAt: { lt: before } } });
  await prisma.collabPresence.deleteMany({ where: { pageId, updatedAt: { lt: new Date(Date.now() - 2 * HTTP_COLLAB.presenceReserveMs) } } });
}

export async function syncCollab(actor: Actor, pageId: string, input: CollabSyncInput): Promise<CollabSyncResult> {
  const update = input.update ? decode(input.update, HTTP_COLLAB.maxUpdateBytes, "cambio") : null;
  const awareness = input.awareness ? decode(input.awareness, HTTP_COLLAB.maxAwarenessBytes, "estado de presencia") : null;
  const [access, user] = await Promise.all([
    pageAccess(pageId, actor),
    awareness ? prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }) : null,
  ]);

  const doc = await openDoc(pageId);
  if (input.epoch && input.epoch !== doc.epoch) throw new ContentReplacedError();

  let ignored = false;
  let inserted = false;
  if (update && update.length) {
    if (access !== "edit") ignored = true;
    else {
      try { Y.decodeUpdate(update); } catch { throw badRequest("El cambio enviado no es válido."); }
      await prisma.collabUpdate.create({ data: { pageId, userId: actor.id, data: Buffer.from(update) } });
      inserted = true;
    }
  }
  let own: string[] = [];
  if (awareness) {
    try { own = await savePresence(pageId, actor, user?.name ?? "", awareness); } catch (error) { if (error instanceof HttpError) throw error; throw badRequest("La presencia enviada no es válida."); }
  }

  const after = Number.isInteger(input.after) && input.after! > 0 ? input.after! : 0;
  const full = !input.epoch || after < doc.lastUpdateId;
  const since = full ? doc.lastUpdateId : after;
  const exclude = new Set([...own, ...(input.clientId === undefined ? [] : [String(input.clientId)])]);
  const [updates, presence] = await Promise.all([
    prisma.collabUpdate.findMany({ where: { pageId, id: { gt: since } }, orderBy: { id: "asc" }, select: { id: true, data: true } }),
    prisma.collabPresence.findMany({ where: { pageId, updatedAt: { gt: new Date(Date.now() - HTTP_COLLAB.presenceTtlMs) } }, select: { clientId: true, clock: true, state: true } }),
  ]);
  const parts = [...(full ? [new Uint8Array(doc.snapshot)] : []), ...updates.map((u) => new Uint8Array(u.data))];
  const merged = parts.length ? (parts.length === 1 ? parts[0] : Y.mergeUpdates(parts)) : null;
  const cursor = updates.length ? updates[updates.length - 1].id : Math.max(since, after);

  // Solo quien escribe paga la compactación (las consultas de lectura quedan baratas).
  if (inserted) {
    const pending = await prisma.collabUpdate.count({ where: { pageId, id: { gt: doc.lastUpdateId } } });
    if (pending > HTTP_COLLAB.compactAfter) await compact(pageId).catch((error) => console.error(`[colaboración] no se pudo compactar pagina-${pageId}:`, error));
  }

  return {
    epoch: doc.epoch, access, cursor, full,
    update: merged ? toBase64(merged) : null,
    awareness: encodePresence(presence.filter((row) => !exclude.has(row.clientId))),
    ...(ignored && { ignored: true as const }),
  };
}

/** El contenido se reemplazó por otra vía (restaurar una versión, cambios sin conexión): nuevo epoch. */
export async function resetHttpCollab(pageId: string) {
  await prisma.$transaction([
    prisma.collabUpdate.deleteMany({ where: { pageId } }),
    prisma.collabPresence.deleteMany({ where: { pageId } }),
    prisma.collabDoc.deleteMany({ where: { pageId } }),
  ]);
}
