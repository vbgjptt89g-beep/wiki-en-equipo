import { prisma } from "../models/client.js";
import type { Actor } from "../permissions/access.js";
import { assertCanEditPage } from "../permissions/access.js";
import { conflict, notFound } from "../services/errors.js";

export async function syncPage(actor: Actor, input: { operationId: string; pageId: string; baseVersion: number; title?: string; content: unknown; background?: unknown }) {
  const previous = await prisma.syncOperation.findUnique({ where: { userId_operationId: { userId: actor.id, operationId: input.operationId } } });
  if (previous) return JSON.parse(previous.resultJson);
  return prisma.$transaction(async (tx) => {
    const page = await tx.page.findFirst({ where: { id: input.pageId, deletedAt: null }, include: { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } } } });
    if (!page) throw notFound("No se encontró la página.");
    assertCanEditPage(page, actor);
    if (page.version !== input.baseVersion) throw conflict("Hay cambios más recientes en esta página. Revisa la versión actual y vuelve a sincronizar.", { currentVersion: page.version, current: { title: page.title, content: JSON.parse(page.contentJson), background: page.backgroundJson ? JSON.parse(page.backgroundJson) : null, updatedAt: page.updatedAt } });
    await tx.pageHistory.create({ data: { pageId: page.id, changedById: actor.id, version: page.version, snapshotJson: JSON.stringify({ title: page.title, contentJson: page.contentJson, backgroundJson: page.backgroundJson, visibility: page.visibility, parentId: page.parentId }) } });
    const updated = await tx.page.update({ where: { id: page.id }, data: { ...(input.title === undefined ? {} : { title: input.title.trim() }), contentJson: JSON.stringify(input.content), ...(input.background === undefined ? {} : { backgroundJson: JSON.stringify(input.background) }), version: { increment: 1 } }, select: { id: true, title: true, version: true, updatedAt: true } });
    const result = { status: "synced", page: updated };
    await tx.syncOperation.create({ data: { operationId: input.operationId, userId: actor.id, pageId: page.id, resultJson: JSON.stringify(result) } });
    return result;
  });
}
