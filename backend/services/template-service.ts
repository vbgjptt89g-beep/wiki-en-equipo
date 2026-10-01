import { prisma } from "../models/client.js";
import type { Actor } from "../permissions/access.js";
import { badRequest, forbidden, notFound } from "./errors.js";

function canReadTemplate(template: { scope: string; ownerId: string | null; departmentId: string | null }, actor: Actor) {
  return actor.role === "ADMIN" || template.scope === "COMPANY" || template.ownerId === actor.id || (template.scope === "DEPARTMENT" && template.departmentId === actor.departmentId);
}

export async function listTemplates(actor: Actor) {
  const where = actor.role === "ADMIN" ? {} : { OR: [{ scope: "COMPANY" }, { ownerId: actor.id }, { scope: "DEPARTMENT", departmentId: actor.departmentId }] };
  return prisma.template.findMany({ where, orderBy: [{ isDefault: "desc" }, { title: "asc" }], select: { id: true, title: true, description: true, scope: true, isDefault: true, ownerId: true, departmentId: true, updatedAt: true } });
}

export async function getTemplate(actor: Actor, id: string) {
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template || !canReadTemplate(template, actor)) throw notFound("No se encontró la plantilla.");
  return template;
}

export async function createTemplate(actor: Actor, input: { title: string; description?: string; content?: unknown; background?: unknown; scope?: string }) {
  const scope = input.scope ?? "PRIVATE";
  if (!["PRIVATE", "DEPARTMENT", "COMPANY"].includes(scope)) throw badRequest("El alcance de la plantilla no es válido.");
  if (scope === "COMPANY" && actor.role !== "ADMIN") throw forbidden("Solo un administrador puede compartir plantillas con toda la empresa.");
  return prisma.template.create({ data: { title: input.title.trim(), description: input.description?.trim() ?? "", contentJson: JSON.stringify(input.content ?? []), backgroundJson: input.background === undefined ? null : JSON.stringify(input.background), scope, ownerId: actor.id, departmentId: scope === "DEPARTMENT" ? actor.departmentId : null } });
}

export async function updateTemplate(actor: Actor, id: string, input: { title?: string; description?: string; content?: unknown; background?: unknown; scope?: string; isDefault?: boolean }) {
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) throw notFound("No se encontró la plantilla.");
  if (actor.role !== "ADMIN" && template.ownerId !== actor.id) throw forbidden("Solo puedes modificar tus propias plantillas.");
  if (input.isDefault !== undefined && actor.role !== "ADMIN") throw forbidden("Solo un administrador puede administrar las plantillas predeterminadas.");
  if (input.scope && !["PRIVATE", "DEPARTMENT", "COMPANY"].includes(input.scope)) throw badRequest("El alcance de la plantilla no es válido.");
  if (input.scope === "COMPANY" && actor.role !== "ADMIN") throw forbidden("Solo un administrador puede compartir plantillas con toda la empresa.");
  if (input.isDefault === true && (input.scope ?? template.scope) !== "COMPANY") throw badRequest("Una plantilla predeterminada debe estar disponible para toda la empresa.");
  return prisma.template.update({ where: { id }, data: {
    ...(input.title === undefined ? {} : { title: input.title.trim() }),
    ...(input.description === undefined ? {} : { description: input.description.trim() }),
    ...(input.content === undefined ? {} : { contentJson: JSON.stringify(input.content) }),
    ...(input.background === undefined ? {} : { backgroundJson: JSON.stringify(input.background) }),
    ...(input.scope === undefined ? {} : { scope: input.scope, departmentId: input.scope === "DEPARTMENT" ? actor.departmentId : null }),
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
  } });
}

export async function deleteTemplate(actor: Actor, id: string) {
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) throw notFound("No se encontró la plantilla.");
  if (actor.role !== "ADMIN" && template.ownerId !== actor.id) throw forbidden("Solo puedes eliminar tus propias plantillas.");
  await prisma.template.delete({ where: { id } });
}
