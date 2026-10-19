import type { Server } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { makeRouter } from "./routes.js";
import { COLLAB_PATH, CollabServer, collabOptionsFromEnv } from "../realtime/collab.js";
import { RealtimeHub } from "../realtime/hub.js";
import { HttpError } from "../services/errors.js";

/**
 * Qué proxies pueden informar la IP real en `X-Forwarded-For` (el login pasa por el servidor de Next).
 * `TRUST_PROXY`: "loopback" (por defecto, Next en la misma máquina), un número de saltos o una lista
 * de IP/subredes separadas por comas; "false" lo desactiva. Nunca `true`: cualquiera podría falsear su IP.
 */
export function trustProxySetting(value = "loopback"): string | number | false {
  const setting = value.trim();
  if (!setting || setting === "false" || setting === "0") return false;
  if (setting === "true") throw new Error("TRUST_PROXY=true permitiría falsear la IP. Usa loopback, un número de saltos o las IP del proxy.");
  return /^\d+$/.test(setting) ? Number(setting) : setting;
}

export const realtimeHub = new RealtimeHub();
export const collabServer = new CollabServer(collabOptionsFromEnv());
export const app = express();

app.disable("x-powered-by");
app.set("trust proxy", trustProxySetting(process.env.TRUST_PROXY));
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000", methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type"] }));
app.use(express.json({ limit: "2mb", strict: true }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api", makeRouter(realtimeHub, collabServer));
app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "La ruta solicitada no existe." } }));

const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Los datos enviados no son válidos.", details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
  if (error instanceof HttpError) return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return res.status(409).json({ error: { code: "ALREADY_EXISTS", message: "Ya existe un registro con esos datos." } });
    if (error.code === "P2025") return res.status(404).json({ error: { code: "NOT_FOUND", message: "No se encontró el recurso solicitado." } });
  }
  if (error instanceof Error && error.message.includes("File too large")) return res.status(413).json({ error: { code: "FILE_TOO_LARGE", message: "El archivo supera el límite permitido." } });
  if (error instanceof Error && error.message.includes("tipo de archivo no está permitido")) return res.status(415).json({ error: { code: "UNSUPPORTED_FILE_TYPE", message: error.message } });
  console.error(error);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Ocurrió un error interno." } });
};

app.use(errors);

/** Dirige las conexiones WebSocket del servidor HTTP: `/realtime` (avisos) y `/collab/pagina-<id>` (Yjs en vivo). */
export function attachWebSockets(server: Server) {
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname === "/realtime") return realtimeHub.handleUpgrade(request, socket, head);
    if (pathname.startsWith(COLLAB_PATH)) return void collabServer.handleUpgrade(request, socket, head);
    socket.destroy();
  });
}
