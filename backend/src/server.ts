import "dotenv/config";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import { app, attachWebSockets, collabServer, realtimeHub } from "./app.js";
import { prisma, tursoConfig } from "../models/client.js";
import { applyMigrations } from "../models/migrate-turso.js";
import { purgeExpiredTrash } from "../services/page-service.js";
import { backfillSearchText, syncUserSearchNames } from "../services/search-text.js";

const port = Number(process.env.PORT ?? 4000);

// Producción en Turso: antes de atender se aplican las migraciones que falten (prisma migrate deploy no llega a Turso).
const turso = tursoConfig();
if (turso) {
  const client = createClient(turso);
  try { await applyMigrations(client); } finally { client.close(); }
}
const server = createServer(app);
attachWebSockets(server);

server.listen(port, () => console.log(`Wiki en equipo API escuchando en http://localhost:${port} (edición en vivo en ws://localhost:${port}/collab)`));

// Retención de la papelera: al arrancar y cada 12 horas (TRASH_RETENTION_DAYS, 30 por defecto; 0 la desactiva).
const trashRetentionDays = Number(process.env.TRASH_RETENTION_DAYS ?? 30);
const purgeTrash = () => purgeExpiredTrash(trashRetentionDays).then((count) => { if (count) console.log(`Papelera: ${count} páginas eliminadas por antigüedad.`); }).catch((error) => console.error("No se pudo limpiar la papelera:", error));
void purgeTrash();
setInterval(purgeTrash, 12 * 3_600_000).unref();

// Directorio: nombres normalizados que la migración en SQL no dejó bien (tildes que no cubría).
syncUserSearchNames().then((count) => { if (count) console.log(`Directorio: ${count} nombres normalizados.`); }).catch((error) => console.error("No se pudo normalizar el directorio:", error));

// Páginas creadas antes de la búsqueda en el contenido: se indexan una sola vez al arrancar.
backfillSearchText().then((count) => { if (count) console.log(`Búsqueda: ${count} páginas indexadas.`); }).catch((error) => console.error("No se pudo indexar la búsqueda:", error));

async function shutdown() {
  // Primero se guardan los documentos de la edición en vivo y se cierran sus conexiones.
  await collabServer.close();
  realtimeHub.close();
  server.close();
  await prisma.$disconnect();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
