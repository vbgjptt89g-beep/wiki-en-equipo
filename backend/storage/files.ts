import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { prisma, tursoConfig } from "../models/client.js";

export const uploadDirectory = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
mkdirSync(uploadDirectory, { recursive: true });

/**
 * Dónde se guardan los archivos subidos (FILE_STORAGE): `disk` (UPLOAD_DIR, desarrollo) o `database`
 * (tabla FileBlob; producción en Vercel, cuyas funciones no conservan el disco). Sin definir: `database` con Turso
 * y `disk` sin él. Al leer o borrar se busca en los dos sitios, así que cambiar de modo no rompe los viejos.
 */
export function fileStorage(): "disk" | "database" {
  const mode = process.env.FILE_STORAGE?.trim();
  if (mode === "disk" || mode === "database") return mode;
  if (mode) throw new Error(`FILE_STORAGE debe ser "disk" o "database" (llegó "${mode}").`);
  return tursoConfig() ? "database" : "disk";
}

const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "application/pdf",
  "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// En memoria: el archivo se guarda en disco o en la base solo después de revisar los permisos.
export const uploadSingleFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024), files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!allowedTypes.has(file.mimetype)) { callback(new Error("Este tipo de archivo no está permitido.")); return; }
    callback(null, true);
  },
});

const diskPath = (storageName: string) => path.join(uploadDirectory, path.basename(storageName));

/**
 * Guarda los bytes de un archivo nuevo. En disco los escribe ya; en la base devuelve la fila de FileBlob para
 * crearla junto con su FileAsset (`prisma.fileAsset.create({ data: { ...datos, ...await storeFile() } })`).
 */
export async function storeFile(storageName: string, data: Buffer) {
  if (fileStorage() === "disk") { await writeFile(diskPath(storageName), data); return {}; }
  return { blob: { create: { data: new Uint8Array(data) } } };
}

/** Bytes de un archivo, esté en la base o en disco; `null` si ya no existe en ninguno. */
export async function readStoredFile(storageName: string): Promise<Buffer | null> {
  const blob = await prisma.fileBlob.findUnique({ where: { storageName }, select: { data: true } });
  if (blob) return Buffer.from(blob.data);
  try { return await readFile(diskPath(storageName)); } catch { return null; }
}

/** Borra los bytes (de la base y del disco). Sus FileAsset se borran aparte. */
export async function removeStoredFiles(storageNames: string[]) {
  if (!storageNames.length) return;
  await prisma.fileBlob.deleteMany({ where: { storageName: { in: storageNames } } });
  await Promise.all(storageNames.map((name) => rm(diskPath(name), { force: true })));
}

export function isInlineSafeImage(mimeType: string) {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType);
}
