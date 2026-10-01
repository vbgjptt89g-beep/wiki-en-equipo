import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Actor, PageAccessRecord } from "../permissions/access.js";
import { assertCanEditPage, assertCanReadPage } from "../permissions/access.js";
import { prisma } from "../models/client.js";
import { uploadDirectory } from "../storage/files.js";
import { badRequest, forbidden, notFound } from "./errors.js";

export async function saveUploadedFile(actor: Actor, file: Express.Multer.File, pageId?: string) {
  const maxFiles = Number(process.env.MAX_UPLOADS_PER_USER ?? 1000);
  const total = await prisma.fileAsset.count({ where: { ownerId: actor.id } });
  if (total >= maxFiles) { await rm(file.path, { force: true }); throw badRequest("Alcanzaste el límite de archivos subidos."); }
  if (pageId) {
    const page = await prisma.page.findFirst({ where: { id: pageId, deletedAt: null }, include: { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } } } });
    if (!page) { await rm(file.path, { force: true }); throw notFound("No se encontró la página."); }
    try { assertCanEditPage(page as PageAccessRecord, actor); } catch (error) { await rm(file.path, { force: true }); throw error; }
  }
  try {
    return await prisma.fileAsset.create({ data: { storageName: path.basename(file.filename), originalName: path.basename(file.originalname).slice(0, 240), mimeType: file.mimetype, sizeBytes: file.size, ownerId: actor.id, pageId: pageId ?? null } });
  } catch (error) { await rm(file.path, { force: true }); throw error; }
}

export async function listPageFiles(actor: Actor, pageId: string) {
  const page = await prisma.page.findFirst({ where: { id: pageId, deletedAt: null }, include: { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } } } });
  if (!page) throw notFound("No se encontró la página.");
  assertCanReadPage(page as PageAccessRecord, actor);
  return prisma.fileAsset.findMany({ where: { pageId }, orderBy: { createdAt: "asc" }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true, ownerId: true, createdAt: true } });
}

export async function findReadableFile(actor: Actor, id: string) {
  const asset = await prisma.fileAsset.findUnique({ where: { id } });
  if (!asset) throw notFound("No se encontró el archivo.");
  if (asset.pageId) {
    const page = await prisma.page.findFirst({ where: { id: asset.pageId, deletedAt: null }, include: { shares: { select: { userId: true, permission: true } }, departmentWall: { select: { id: true } } } });
    if (!page) throw notFound("No se encontró el archivo.");
    assertCanReadPage(page as PageAccessRecord, actor);
  } else if (asset.ownerId !== actor.id && actor.role !== "ADMIN") throw forbidden("No tienes permiso para ver este archivo.");
  return { ...asset, path: path.join(uploadDirectory, path.basename(asset.storageName)) };
}

export async function deleteFile(actor: Actor, id: string) {
  const asset = await prisma.fileAsset.findUnique({ where: { id } });
  if (!asset) throw notFound("No se encontró el archivo.");
  if (asset.ownerId !== actor.id && actor.role !== "ADMIN") throw forbidden("Solo quien subió el archivo puede eliminarlo.");
  await prisma.fileAsset.delete({ where: { id } });
  await rm(path.join(uploadDirectory, path.basename(asset.storageName)), { force: true });
}

export function openFile(filePath: string) { return createReadStream(filePath); }
