import jwt from "jsonwebtoken";
import { unauthorized } from "../services/errors.js";

export interface AuthClaims {
  sub: string;
  role: "USER" | "DEPARTMENT_ADMIN" | "ADMIN";
  departmentId: string;
  sessionVersion: number;
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET debe tener al menos 32 caracteres.");
  return value;
}

export function signAccessToken(user: AuthClaims): string {
  return jwt.sign({ role: user.role, departmentId: user.departmentId, sessionVersion: user.sessionVersion }, secret(), {
    subject: user.sub,
    expiresIn: "8h",
    issuer: "wiki-en-equipo",
    audience: "wiki-en-equipo-api",
  });
}

export function verifyAccessToken(token: string): AuthClaims {
  try {
    const value = jwt.verify(token, secret(), { issuer: "wiki-en-equipo", audience: "wiki-en-equipo-api" });
    if (typeof value === "string" || typeof value.sub !== "string" || typeof value.departmentId !== "string" || typeof value.sessionVersion !== "number" ||
      !["USER", "DEPARTMENT_ADMIN", "ADMIN"].includes(String(value.role))) throw unauthorized("La sesión no es válida.");
    return { sub: value.sub, departmentId: value.departmentId, role: value.role as AuthClaims["role"], sessionVersion: value.sessionVersion };
  } catch {
    throw unauthorized("La sesión expiró o no es válida.");
  }
}
