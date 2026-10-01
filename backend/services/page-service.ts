import { createHash, randomBytes } from "node:crypto";
import type { Prisma, Page } from "@prisma/client";
import type { Actor, PageAccessRecord } from "../permissions/access.js";
import { assertCanEditPage, assertCanReadPage } from "../permissions/access.js";
import { prisma } from "../models/client.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";

const accessInclude = { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } }, tags: { select: { name: true } } } satisfies Prisma.PageInclude;
const snapshot = (page: Page & { tags?: { name: string }[] }) => JSON.stringify({ title: page.title, contentJson: page.contentJson, backgroundJson: page.backgroundJson, visibility: page.visibility, parentId: page.parentId, tags: page.tags?.map((tag) => tag.name) ?? [] });

export async function findAccessiblePage(id: string, actor: Actor) {
  const childWhere: Prisma.PageWhereInput = { deletedAt: null };
  if (actor.role !== "ADMIN") childWhere.OR = [
    { ownerId: actor.id },
    { shares: { some: { userId: actor.id } } },
    { visibility: "COMPANY" },
    { visibility: "DEPARTMENT", departmentId: actor.departmentId },
    { isWall: true, departmentId: actor.departmentId },
  ];
  const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: { ...accessInclude, children: { where: childWhere, select: { id: true, title: true, visibility: true, updatedAt: true } }, owner: { select: { id: true, name: true } } } });
  if (!page) throw notFound("No se encontró la página.");
  assertCanReadPage(page as PageAccessRecord, actor);
  if (page.visibility !== "PRIVATE") await prisma.pageVisit.create({ data: { pageId: page.id, userId: actor.id } });
  return page;
}

export async function listAccessiblePages(actor: Actor, query: { q?: string; tag?: string; departmentId?: string; parentId?: string }) {
  const where: Prisma.PageWhereInput = { deletedAt: null };
  if (query.q) where.title = { contains: query.q.trim() };
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.parentId) where.parentId = query.parentId;
  if (actor.role === "ADMIN") { /* admins can list every active page */ }
  else where.OR = [
    { ownerId: actor.id },
    { shares: { some: { userId: actor.id } } },
    { visibility: "COMPANY" },
    { visibility: "DEPARTMENT", departmentId: actor.departmentId },
  ];
  if (actor.role !== "ADMIN" && query.departmentId && query.departmentId !== actor.departmentId) {
    where.departmentId = query.departmentId;
    where.OR = [{ ownerId: actor.id }, { shares: { some: { userId: actor.id } } }, { visibility: "COMPANY" }];
  }
  if (query.tag) where.tags = { some: { name: query.tag } };
  const pages = await prisma.page.findMany({ where, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true, visibility: true, version: true, ownerId: true, departmentId: true, parentId: true, updatedAt: true, tags: { select: { name: true } } } });
  return pages;
}

async function tagsConnect(names: string[] | undefined) {
  const clean = [...new Set((names ?? []).map((name) => name.trim().slice(0, 40)).filter(Boolean))];
  return Promise.all(clean.map((name) => prisma.tag.upsert({ where: { name }, create: { name }, update: {} }).then((tag) => ({ id: tag.id }))));
}

export async function createPage(actor: Actor, input: { title: string; content?: unknown; background?: unknown; visibility?: string; parentId?: string | null; tags?: string[] }) {
  const visibility = input.visibility ?? "PRIVATE";
  if (!["PRIVATE", "DEPARTMENT", "COMPANY"].includes(visibility)) throw badRequest("El nivel de visibilidad no es válido.");
  if (visibility === "COMPANY" && actor.role !== "ADMIN") throw forbidden("Solo un administrador puede publicar a nivel empresa.");
  if (input.parentId) {
    const parent = await prisma.page.findFirst({ where: { id: input.parentId, deletedAt: null }, include: accessInclude });
    if (!parent) throw notFound("No se encontró la página superior.");
    assertCanEditPage(parent as PageAccessRecord, actor);
    if (parent.departmentId !== actor.departmentId && actor.role !== "ADMIN") throw forbidden("La subpágina debe pertenecer a tu departamento.");
  }
  const tags = await tagsConnect(input.tags);
  return prisma.page.create({ data: { title: input.title.trim(), contentJson: JSON.stringify(input.content ?? []), backgroundJson: input.background === undefined ? null : JSON.stringify(input.background), visibility, ownerId: actor.id, departmentId: actor.departmentId, parentId: input.parentId ?? null, tags: { connect: tags } }, include: { tags: { select: { name: true } } } });
}

export async function updatePage(actor: Actor, id: string, input: { title?: string; content?: unknown; background?: unknown; visibility?: string; parentId?: string | null; tags?: string[]; expectedVersion?: number }) {
  return prisma.$transaction(async (tx) => {
    const page = await tx.page.findFirst({ where: { id, deletedAt: null }, include: accessInclude });
    if (!page) throw notFound("No se encontró la página.");
    assertCanEditPage(page as PageAccessRecord, actor);
    if (input.expectedVersion !== undefined && input.expectedVersion !== page.version) throw conflict("La página cambió desde que la abriste.", { currentVersion: page.version });
    if (input.visibility === "COMPANY" && actor.role !== "ADMIN") throw forbidden("Solo un administrador puede publicar a nivel empresa.");
    if (input.visibility && !["PRIVATE", "DEPARTMENT", "COMPANY"].includes(input.visibility)) throw badRequest("El nivel de visibilidad no es válido.");
    if (page.isWall && input.visibility === "PRIVATE") throw badRequest("El muro del departamento debe permanecer visible para el departamento.");
    if (page.isCompanyWall && input.visibility && input.visibility !== "COMPANY") throw badRequest("El muro de la empresa debe permanecer publicado a nivel empresa.");
    if (input.parentId !== undefined && input.parentId !== page.parentId) {
      if (input.parentId === id) throw badRequest("Una página no puede ser su propia página superior.");
      if (input.parentId) {
        const parent = await tx.page.findFirst({ where: { id: input.parentId, deletedAt: null }, include: accessInclude });
        if (!parent) throw notFound("No se encontró la página superior.");
        assertCanEditPage(parent as PageAccessRecord, actor);
        let ancestor: { id: string; parentId: string | null } | null = parent;
        while (ancestor) {
          if (ancestor.id === id) throw badRequest("La estructura de subpáginas no puede contener ciclos.");
          ancestor = ancestor.parentId ? await tx.page.findUnique({ where: { id: ancestor.parentId }, select: { id: true, parentId: true } }) : null;
        }
      }
    }
    await tx.pageHistory.create({ data: { pageId: id, changedById: actor.id, version: page.version, snapshotJson: snapshot(page) } });
    const tags = input.tags === undefined ? undefined : await Promise.all([...new Set(input.tags.map((name) => name.trim().slice(0, 40)).filter(Boolean))].map((name) => tx.tag.upsert({ where: { name }, create: { name }, update: {} }).then((tag) => ({ id: tag.id }))));
    return tx.page.update({ where: { id }, data: {
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.content === undefined ? {} : { contentJson: JSON.stringify(input.content) }),
      ...(input.background === undefined ? {} : { backgroundJson: JSON.stringify(input.background) }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(tags === undefined ? {} : { tags: { set: tags } }),
      version: { increment: 1 },
    }, include: { tags: { select: { name: true } } } });
  });
}

export async function trashPage(actor: Actor, id: string) {
  const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: accessInclude });
  if (!page) throw notFound("No se encontró la página.");
  if (actor.role !== "ADMIN" && page.ownerId !== actor.id) throw forbidden("Solo quien creó la página puede enviarla a la papelera.");
  const deletedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const ids = [id];
    let frontier = [id];
    while (frontier.length) {
      const children = await tx.page.findMany({ where: { parentId: { in: frontier }, deletedAt: null }, select: { id: true } });
      frontier = children.map((child) => child.id);
      ids.push(...frontier);
    }
    await tx.page.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } });
    await tx.department.updateMany({ where: { wallPageId: { in: ids } }, data: { wallPageId: null } });
    await tx.page.updateMany({ where: { id: { in: ids } }, data: { isWall: false } });
    await tx.companySettings.updateMany({ where: { wallPageId: { in: ids } }, data: { wallPageId: null } });
    await tx.page.updateMany({ where: { id: { in: ids } }, data: { isCompanyWall: false } });
  });
  return { id, deletedAt: deletedAt.toISOString() };
}

export async function listTrash(actor: Actor) {
  return prisma.page.findMany({ where: { deletedAt: { not: null }, ...(actor.role === "ADMIN" ? {} : { ownerId: actor.id }) }, orderBy: { deletedAt: "desc" }, select: { id: true, title: true, deletedAt: true, ownerId: true } });
}

export async function restorePage(actor: Actor, id: string) {
  const page = await prisma.page.findUnique({ where: { id } });
  if (!page || !page.deletedAt) throw notFound("No se encontró la página en la papelera.");
  if (actor.role !== "ADMIN" && page.ownerId !== actor.id) throw forbidden("Solo quien creó la página puede restaurarla.");
  return prisma.$transaction(async (tx) => {
    const ids = [id];
    let frontier = [id];
    while (frontier.length) {
      const children = await tx.page.findMany({ where: { parentId: { in: frontier }, deletedAt: { not: null } }, select: { id: true } });
      frontier = children.map((child) => child.id);
      ids.push(...frontier);
    }
    await tx.page.updateMany({ where: { id: { in: ids }, deletedAt: { not: null } }, data: { deletedAt: null, version: { increment: 1 } } });
    return tx.page.findUniqueOrThrow({ where: { id } });
  });
}

export async function pageHistory(actor: Actor, id: string) {
  const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: accessInclude });
  if (!page) throw notFound("No se encontró la página.");
  assertCanReadPage(page as PageAccessRecord, actor);
  return prisma.pageHistory.findMany({ where: { pageId: id }, orderBy: { version: "desc" }, include: { changedBy: { select: { id: true, name: true } } } });
}

export async function restoreVersion(actor: Actor, id: string, version: number) {
  const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: accessInclude });
  if (!page) throw notFound("No se encontró la página.");
  assertCanEditPage(page as PageAccessRecord, actor);
  const old = await prisma.pageHistory.findUnique({ where: { pageId_version: { pageId: id, version } } });
  if (!old) throw notFound("No se encontró esa versión.");
  const data = JSON.parse(old.snapshotJson) as { title: string; contentJson: string; backgroundJson: string | null; visibility: string; parentId: string | null; tags?: string[] };
  if (data.visibility === "COMPANY" && actor.role !== "ADMIN") throw forbidden("Solo un administrador puede restaurar una versión publicada a nivel empresa.");
  const { tags: oldTags, ...pageData } = data;
  return prisma.$transaction(async (tx) => {
    await tx.pageHistory.create({ data: { pageId: id, changedById: actor.id, version: page.version, snapshotJson: snapshot(page) } });
    const tagIds = oldTags ? await Promise.all(oldTags.map((name) => tx.tag.upsert({ where: { name }, create: { name }, update: {} }).then((tag) => ({ id: tag.id })))) : undefined;
    return tx.page.update({ where: { id }, data: { ...pageData, ...(tagIds ? { tags: { set: tagIds } } : {}), version: { increment: 1 } } });
  });
}

export async function sharePage(actor: Actor, id: string, userId: string, permission: "READ" | "EDIT") {
  const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: accessInclude });
  if (!page) throw notFound("No se encontró la página.");
  assertCanEditPage(page as PageAccessRecord, actor);
  if (userId === actor.id) throw badRequest("No necesitas compartir la página contigo mismo.");
  if (!await prisma.user.findFirst({ where: { id: userId, active: true } })) throw notFound("No se encontró al usuario.");
  return prisma.pageShare.upsert({ where: { pageId_userId: { pageId: id, userId } }, create: { pageId: id, userId, permission }, update: { permission } });
}

export async function revokeShare(actor: Actor, id: string, userId: string) {
  const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: accessInclude });
  if (!page) throw notFound("No se encontró la página.");
  assertCanEditPage(page as PageAccessRecord, actor);
  await prisma.pageShare.deleteMany({ where: { pageId: id, userId } });
}

export async function createShareLink(actor: Actor, id: string, permission: "READ" | "EDIT", expiresInHours?: number) {
  const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: accessInclude });
  if (!page) throw notFound("No se encontró la página.");
  assertCanEditPage(page as PageAccessRecord, actor);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3_600_000) : null;
  const record = await prisma.pageShareLink.create({ data: { pageId: id, tokenHash, permission, expiresAt } });
  return { id: record.id, token, permission, expiresAt };
}

export async function acceptShareLink(actor: Actor, token: string) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const link = await prisma.pageShareLink.findUnique({ where: { tokenHash }, include: { page: true } });
  if (!link || link.revokedAt || (link.expiresAt && link.expiresAt < new Date()) || link.page.deletedAt) throw notFound("El enlace no existe, venció o fue revocado.");
  await prisma.pageShare.upsert({ where: { pageId_userId: { pageId: link.pageId, userId: actor.id } }, create: { pageId: link.pageId, userId: actor.id, permission: link.permission }, update: { permission: link.permission } });
  return { pageId: link.pageId, permission: link.permission };
}

export async function revokeShareLink(actor: Actor, id: string, linkId: string) {
  const page = await prisma.page.findFirst({ where: { id, deletedAt: null }, include: accessInclude });
  if (!page) throw notFound("No se encontró la página.");
  assertCanEditPage(page as PageAccessRecord, actor);
  const result = await prisma.pageShareLink.updateMany({ where: { id: linkId, pageId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!result.count) throw notFound("No se encontró el enlace.");
}

export async function getMostVisited(actor: Actor, departmentId?: string) {
  const where: Prisma.PageWhereInput = { deletedAt: null, visibility: { in: ["DEPARTMENT", "COMPANY"] } };
  if (actor.role !== "ADMIN") where.OR = [{ visibility: "COMPANY" }, { visibility: "DEPARTMENT", departmentId: actor.departmentId }];
  if (departmentId && (actor.role === "ADMIN" || departmentId === actor.departmentId)) where.departmentId = departmentId;
  const pages = await prisma.page.findMany({ where, select: { id: true, title: true, visibility: true, departmentId: true, _count: { select: { visits: true } } }, orderBy: { visits: { _count: "desc" } }, take: 20 });
  return pages;
}
