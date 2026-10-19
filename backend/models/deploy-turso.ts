import "dotenv/config";
import { createClient } from "@libsql/client";
import { tursoConfig } from "./client.js";
import { applyMigrations } from "./migrate-turso.js";

/**
 * Aplica las migraciones que falten en Turso (`pnpm run db:deploy:turso`).
 * - En Vercel corre al compilar (`pnpm run vercel-build`), no en cada petición: así las funciones arrancan rápido.
 *   Con `--opcional`, sin TURSO_DATABASE_URL (vistas previas de los PR) no hace nada en lugar de fallar.
 * - Con `--mantenimiento` corre también lo que el servidor local hace al arrancar: normalizar los nombres del
 *   directorio e indexar la búsqueda de las páginas que aún no lo están.
 */
const optional = process.argv.includes("--opcional");
const maintenance = process.argv.includes("--mantenimiento");
const turso = tursoConfig();
if (!turso) {
  if (optional) { console.log("Sin TURSO_DATABASE_URL: no se aplican migraciones (vista previa)."); process.exit(0); }
  console.error("Falta TURSO_DATABASE_URL.");
  process.exit(1);
}
const client = createClient(turso);
try {
  const applied = await applyMigrations(client);
  console.log(applied.length ? `Listo: ${applied.length} migraciones aplicadas.` : "La base ya tenía todas las migraciones.");
} finally { client.close(); }

if (maintenance) {
  const { prisma } = await import("./client.js");
  const { backfillSearchText, syncUserSearchNames } = await import("../services/search-text.js");
  try {
    console.log(`Directorio: ${await syncUserSearchNames()} nombres normalizados. Búsqueda: ${await backfillSearchText()} páginas indexadas.`);
  } finally { await prisma.$disconnect(); }
}
