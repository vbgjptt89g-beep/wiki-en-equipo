import type { Page, User } from "@prisma/client";
import { forbidden } from "../services/errors.js";

export type Actor = Pick<User, "id" | "role" | "departmentId">;
export type PageAccessRecord = Pick<Page, "id" | "ownerId" | "departmentId" | "visibility" | "isWall"> & {
  shares?: { userId: string; permission: string }[];
  departmentWall?: { id: string } | null;
};

export function canReadPage(page: PageAccessRecord, actor: Actor): boolean {
  if (actor.role === "ADMIN") return true;
  if (page.ownerId === actor.id || page.shares?.some((share) => share.userId === actor.id)) return true;
  if (page.isWall && actor.departmentId === page.departmentId) return true;
  if (page.visibility === "COMPANY") return true;
  if (page.visibility === "DEPARTMENT" && actor.departmentId === page.departmentId) return true;
  return false;
}

export function canEditPage(page: PageAccessRecord, actor: Actor): boolean {
  if (actor.role === "ADMIN") return true;
  if (page.ownerId === actor.id) return true;
  if (page.shares?.some((share) => share.userId === actor.id && share.permission === "EDIT")) return true;
  return Boolean(page.isWall && actor.role === "DEPARTMENT_ADMIN" && actor.departmentId === page.departmentId);
}

export function assertCanReadPage(page: PageAccessRecord, actor: Actor): void {
  if (!canReadPage(page, actor)) throw forbidden("No tienes acceso a esta página.");
}

export function assertCanEditPage(page: PageAccessRecord, actor: Actor): void {
  if (!canEditPage(page, actor)) throw forbidden("Necesitas permiso de edición para cambiar esta página.");
}

export function canManageUsers(actor: Actor): boolean { return actor.role === "ADMIN"; }

export function canManageDepartment(actor: Actor, departmentId: string): boolean {
  return actor.role === "ADMIN" || (actor.role === "DEPARTMENT_ADMIN" && actor.departmentId === departmentId);
}
