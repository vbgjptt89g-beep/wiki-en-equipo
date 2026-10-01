import { prisma } from "../models/client.js";
import type { Actor } from "../permissions/access.js";
import { canManageDepartment } from "../permissions/access.js";
import { badRequest, forbidden, notFound } from "./errors.js";

function makeSlug(value: string) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function listDepartments(actor: Actor) {
  return prisma.department.findMany({ where: actor.role === "ADMIN" ? {} : { id: actor.departmentId }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true, wallPage: { select: { id: true, title: true, updatedAt: true } }, _count: { select: { users: true, pages: true } } } });
}

export async function createDepartment(name: string) {
  const slug = makeSlug(name);
  if (!slug) throw badRequest("El nombre del departamento no es válido.");
  return prisma.department.create({ data: { name: name.trim(), slug } });
}

export async function setDepartmentWall(actor: Actor, departmentId: string, pageId: string) {
  if (!canManageDepartment(actor, departmentId)) throw forbidden("No puedes administrar este departamento.");
  return prisma.$transaction(async (tx) => {
    const department = await tx.department.findUnique({ where: { id: departmentId } });
    if (!department) throw notFound("No se encontró el departamento.");
    const page = await tx.page.findFirst({ where: { id: pageId, deletedAt: null } });
    if (!page) throw notFound("No se encontró la página.");
    if (actor.role !== "ADMIN" && page.departmentId !== departmentId) throw forbidden("La página debe pertenecer a tu departamento.");
    if (department.wallPageId && department.wallPageId !== pageId) await tx.page.update({ where: { id: department.wallPageId }, data: { isWall: false } });
    const updated = await tx.page.update({ where: { id: pageId }, data: { departmentId, isWall: true, visibility: "DEPARTMENT", version: { increment: 1 } } });
    await tx.department.update({ where: { id: departmentId }, data: { wallPageId: pageId } });
    return updated;
  });
}

export async function clearDepartmentWall(actor: Actor, departmentId: string) {
  if (!canManageDepartment(actor, departmentId)) throw forbidden("No puedes administrar este departamento.");
  return prisma.$transaction(async (tx) => {
    const department = await tx.department.findUnique({ where: { id: departmentId } });
    if (!department) throw notFound("No se encontró el departamento.");
    if (department.wallPageId) await tx.page.update({ where: { id: department.wallPageId }, data: { isWall: false } });
    return tx.department.update({ where: { id: departmentId }, data: { wallPageId: null } });
  });
}

export async function setFeaturedPages(actor: Actor, departmentId: string, pageIds: string[]) {
  if (!canManageDepartment(actor, departmentId)) throw forbidden("No puedes administrar este departamento.");
  if (pageIds.length > 12 || new Set(pageIds).size !== pageIds.length) throw badRequest("Puedes destacar hasta 12 páginas distintas.");
  const pages = await prisma.page.findMany({ where: { id: { in: pageIds }, departmentId, deletedAt: null } });
  if (pages.length !== pageIds.length) throw badRequest("Todas las páginas destacadas deben pertenecer al departamento.");
  if (pages.some((page) => page.visibility === "PRIVATE")) throw badRequest("Solo se pueden destacar páginas publicadas en el departamento o en la empresa.");
  await prisma.$transaction([
    prisma.departmentFeaturedPage.deleteMany({ where: { departmentId } }),
    prisma.departmentFeaturedPage.createMany({ data: pageIds.map((pageId, sortOrder) => ({ departmentId, pageId, sortOrder })) }),
  ]);
  return listFeaturedPages(actor, departmentId);
}

export async function listFeaturedPages(actor: Actor, departmentId: string) {
  if (actor.role !== "ADMIN" && actor.departmentId !== departmentId) throw forbidden("Solo puedes ver las páginas destacadas de tu departamento.");
  const records = await prisma.departmentFeaturedPage.findMany({ where: { departmentId, page: { deletedAt: null, visibility: { in: ["DEPARTMENT", "COMPANY"] } } }, orderBy: { sortOrder: "asc" }, include: { page: { select: { id: true, title: true, visibility: true, updatedAt: true } } } });
  return records.map(({ page }) => page);
}

export async function setCompanyWall(actor: Actor, pageId: string) {
  if (actor.role !== "ADMIN") throw forbidden("Solo un administrador puede cambiar el muro de la empresa.");
  return prisma.$transaction(async (tx) => {
    const page = await tx.page.findFirst({ where: { id: pageId, deletedAt: null } });
    if (!page) throw notFound("No se encontró la página.");
    const old = await tx.companySettings.findUnique({ where: { id: "main" } });
    if (old?.wallPageId && old.wallPageId !== pageId) await tx.page.update({ where: { id: old.wallPageId }, data: { isCompanyWall: false } });
    const updated = await tx.page.update({ where: { id: pageId }, data: { visibility: "COMPANY", isCompanyWall: true, version: { increment: 1 } } });
    await tx.companySettings.upsert({ where: { id: "main" }, create: { id: "main", wallPageId: pageId }, update: { wallPageId: pageId } });
    return updated;
  });
}

export async function getCompanyWall() {
  const settings = await prisma.companySettings.findUnique({ where: { id: "main" }, include: { wallPage: { select: { id: true, title: true, visibility: true, version: true, updatedAt: true } } } });
  return settings?.wallPage ?? null;
}

export async function clearCompanyWall(actor: Actor) {
  if (actor.role !== "ADMIN") throw forbidden("Solo un administrador puede cambiar el muro de la empresa.");
  return prisma.$transaction(async (tx) => {
    const settings = await tx.companySettings.findUnique({ where: { id: "main" } });
    if (settings?.wallPageId) await tx.page.update({ where: { id: settings.wallPageId }, data: { isCompanyWall: false } });
    if (settings) await tx.companySettings.update({ where: { id: "main" }, data: { wallPageId: null } });
  });
}
