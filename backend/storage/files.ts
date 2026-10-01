import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import multer from "multer";

export const uploadDirectory = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
mkdirSync(uploadDirectory, { recursive: true });

const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "application/pdf",
  "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const uploadSingleFile = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024), files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!allowedTypes.has(file.mimetype)) { callback(new Error("Este tipo de archivo no está permitido.")); return; }
    callback(null, true);
  },
});

export function isInlineSafeImage(mimeType: string) {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType);
}
