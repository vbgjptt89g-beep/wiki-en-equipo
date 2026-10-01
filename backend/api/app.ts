import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { makeRouter } from "./routes.js";
import { RealtimeHub } from "../realtime/hub.js";
import { HttpError } from "../services/errors.js";

export const realtimeHub = new RealtimeHub();
export const app = express();

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000", methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type"] }));
app.use(express.json({ limit: "2mb", strict: true }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api", makeRouter(realtimeHub));
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
