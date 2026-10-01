import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type AuthClaims } from "./token.js";
import { forbidden, unauthorized } from "../services/errors.js";
import { prisma } from "../models/client.js";

declare global {
  namespace Express {
    interface Request { auth?: AuthClaims }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return next(unauthorized());
  try {
    const claims = verifyAccessToken(header.slice(7));
    const user = await prisma.user.findFirst({ where: { id: claims.sub, active: true }, select: { id: true, role: true, departmentId: true, sessionVersion: true } });
    if (!user || user.sessionVersion !== claims.sessionVersion) return next(unauthorized("La sesión fue revocada. Inicia sesión de nuevo."));
    req.auth = { sub: user.id, role: user.role as AuthClaims["role"], departmentId: user.departmentId, sessionVersion: user.sessionVersion };
    next();
  } catch (error) { next(error); }
}

export function requireRole(...roles: AuthClaims["role"][]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden());
    next();
  };
}
