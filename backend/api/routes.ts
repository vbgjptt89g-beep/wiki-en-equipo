import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { prisma } from "../models/client.js";
import type { Actor } from "../permissions/access.js";
import { badRequest, forbidden, notFound } from "../services/errors.js";
import * as auth from "../services/auth-service.js";
import * as departments from "../services/department-service.js";
import * as files from "../services/file-service.js";
import * as pages from "../services/page-service.js";
import * as templates from "../services/template-service.js";
import { syncPage } from "../sync/service.js";
import { uploadSingleFile, isInlineSafeImage } from "../storage/files.js";
import { openFile } from "../services/file-service.js";
import type { RealtimeHub } from "../realtime/hub.js";

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const bootstrapLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const id = z.string().min(1).max(100);
const email = z.string().email().max(254);
const password = z.string().min(12).max(200);
const title = z.string().trim().min(1).max(200);
const role = z.enum(["USER", "DEPARTMENT_ADMIN", "ADMIN"]);
const visibility = z.enum(["PRIVATE", "DEPARTMENT", "COMPANY"]);
const permission = z.enum(["READ", "EDIT"]);
const tags = z.array(z.string().trim().min(1).max(40)).max(30).optional();
const objectBody = <T extends z.ZodType>(schema: T, req: Request) => schema.parse(req.body) as z.infer<T>;
const actor = (req: Request): Actor => ({ id: req.auth!.sub, role: req.auth!.role, departmentId: req.auth!.departmentId });
const currentUserId = (req: Request) => req.auth?.sub as string;
const param = (req: Request, name: string) => id.parse(req.params[name]);

router.post("/auth/bootstrap", bootstrapLimiter, async (req, res) => {
  const body = objectBody(z.object({ name: z.string().trim().min(1).max(100), email, password, departmentName: z.string().trim().min(2).max(100), secret: z.string().min(1) }), req);
  res.status(201).json(await auth.bootstrapAdmin(body));
});

router.post("/auth/login", loginLimiter, async (req, res) => {
  const body = objectBody(z.object({ email, password: z.string().min(1).max(200) }), req);
  res.json(await auth.login(body.email, body.password));
});

router.use(requireAuth);

router.get("/auth/me", async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: currentUserId(req), active: true }, select: { id: true, name: true, email: true, role: true, departmentId: true, department: { select: { name: true, slug: true } } } });
  if (!user) throw notFound("No se encontró el usuario.");
  res.json({ user });
});

router.post("/auth/password", async (req, res) => {
  const body = objectBody(z.object({ currentPassword: z.string().min(1), newPassword: password }), req);
  await auth.changePassword(currentUserId(req), body.currentPassword, body.newPassword);
  res.status(204).end();
});

router.get("/departments", async (req, res) => res.json({ departments: await departments.listDepartments(actor(req)) }));
router.post("/departments", requireRole("ADMIN"), async (req, res) => {
  const body = objectBody(z.object({ name: z.string().trim().min(2).max(100) }), req);
  res.status(201).json({ department: await departments.createDepartment(body.name) });
});
router.put("/departments/:departmentId/wall", async (req, res) => {
  const body = objectBody(z.object({ pageId: id }), req);
  res.json({ page: await departments.setDepartmentWall(actor(req), param(req, "departmentId"), body.pageId) });
});
router.delete("/departments/:departmentId/wall", async (req, res) => {
  await departments.clearDepartmentWall(actor(req), param(req, "departmentId"));
  res.status(204).end();
});
router.get("/departments/:departmentId/featured", async (req, res) => res.json({ pages: await departments.listFeaturedPages(actor(req), param(req, "departmentId")) }));
router.put("/departments/:departmentId/featured", async (req, res) => {
  const body = objectBody(z.object({ pageIds: z.array(id).max(12) }), req);
  res.json({ pages: await departments.setFeaturedPages(actor(req), param(req, "departmentId"), body.pageIds) });
});
router.get("/company/wall", async (req, res) => {
  const wall = await departments.getCompanyWall();
  if (!wall) throw notFound("Todavía no se configuró el muro de la empresa.");
  res.json({ page: await pages.findAccessiblePage(wall.id, actor(req)) });
});
router.put("/company/wall", requireRole("ADMIN"), async (req, res) => {
  const body = objectBody(z.object({ pageId: id }), req);
  res.json({ page: await departments.setCompanyWall(actor(req), body.pageId) });
});
router.delete("/company/wall", requireRole("ADMIN"), async (req, res) => {
  await departments.clearCompanyWall(actor(req)); res.status(204).end();
});

router.get("/users", requireRole("ADMIN"), async (_req, res) => res.json({ users: await auth.listUsers() }));
router.post("/users", requireRole("ADMIN"), async (req, res) => {
  const body = objectBody(z.object({ name: z.string().trim().min(1).max(100), email, password, role, departmentId: id }), req);
  res.status(201).json({ user: await auth.createUser(body) });
});
router.patch("/users/:userId", requireRole("ADMIN"), async (req, res) => {
  const body = objectBody(z.object({ name: z.string().trim().min(1).max(100).optional(), role: role.optional(), departmentId: id.optional(), active: z.boolean().optional() }).refine((data) => Object.keys(data).length > 0), req);
  const userId = param(req, "userId");
  if (userId === currentUserId(req) && (body.active === false || (body.role && body.role !== "ADMIN"))) throw forbidden("No puedes quitarte tu propio acceso de administrador.");
  res.json({ user: await auth.updateUser(userId, body) });
});

router.get("/pages/popular", async (req, res) => res.json({ pages: await pages.getMostVisited(actor(req), typeof req.query.departmentId === "string" ? req.query.departmentId : undefined) }));
router.get("/pages/trash", async (req, res) => res.json({ pages: await pages.listTrash(actor(req)) }));
router.post("/pages/:pageId/restore", async (req, res) => res.json({ page: await pages.restorePage(actor(req), param(req, "pageId")) }));

router.get("/pages", async (req, res) => {
  const departmentId = typeof req.query.departmentId === "string" ? id.parse(req.query.departmentId) : undefined;
  const parentId = typeof req.query.parentId === "string" ? id.parse(req.query.parentId) : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : undefined;
  const tag = typeof req.query.tag === "string" ? req.query.tag.slice(0, 40) : undefined;
  res.json({ pages: await pages.listAccessiblePages(actor(req), { q, tag, departmentId, parentId }) });
});
router.post("/pages", async (req, res) => {
  const body = objectBody(z.object({ title, content: z.unknown().optional(), background: z.unknown().optional(), visibility: visibility.optional(), parentId: id.nullable().optional(), tags }), req);
  res.status(201).json({ page: await pages.createPage(actor(req), body) });
});
router.post("/pages/from-template/:templateId", async (req, res) => {
  const template = await templates.getTemplate(actor(req), param(req, "templateId"));
  const body = objectBody(z.object({ title: title.optional(), parentId: id.nullable().optional() }), req);
  const page = await pages.createPage(actor(req), { title: body.title ?? template.title, content: JSON.parse(template.contentJson), background: template.backgroundJson ? JSON.parse(template.backgroundJson) : undefined, parentId: body.parentId });
  res.status(201).json({ page });
});
router.get("/pages/:pageId", async (req, res) => res.json({ page: await pages.findAccessiblePage(param(req, "pageId"), actor(req)) }));
router.patch("/pages/:pageId", async (req, res) => {
  const body = objectBody(z.object({ title: title.optional(), content: z.unknown().optional(), background: z.unknown().optional(), visibility: visibility.optional(), parentId: id.nullable().optional(), tags, expectedVersion: z.number().int().positive() }).refine((data) => Object.keys(data).length > 1), req);
  const page = await pages.updatePage(actor(req), param(req, "pageId"), body);
  hub.broadcast(page.id, { type: "page.refresh", pageId: page.id, version: page.version });
  res.json({ page });
});
router.delete("/pages/:pageId", async (req, res) => {
  res.json(await pages.trashPage(actor(req), param(req, "pageId")));
});
router.get("/pages/:pageId/history", async (req, res) => res.json({ history: await pages.pageHistory(actor(req), param(req, "pageId")) }));
router.post("/pages/:pageId/history/:version/restore", async (req, res) => {
  const version = z.coerce.number().int().positive().parse(req.params.version);
  res.json({ page: await pages.restoreVersion(actor(req), param(req, "pageId"), version) });
});
router.put("/pages/:pageId/shares/:userId", async (req, res) => {
  const body = objectBody(z.object({ permission }), req);
  res.json({ share: await pages.sharePage(actor(req), param(req, "pageId"), param(req, "userId"), body.permission) });
});
router.delete("/pages/:pageId/shares/:userId", async (req, res) => {
  await pages.revokeShare(actor(req), param(req, "pageId"), param(req, "userId")); res.status(204).end();
});
router.post("/pages/:pageId/share-links", async (req, res) => {
  const body = objectBody(z.object({ permission, expiresInHours: z.number().int().positive().max(8760).optional() }), req);
  const link = await pages.createShareLink(actor(req), param(req, "pageId"), body.permission, body.expiresInHours);
  res.status(201).json({ ...link, url: `${process.env.FRONTEND_ORIGIN ?? ""}/share/${link.token}` });
});
router.delete("/pages/:pageId/share-links/:linkId", async (req, res) => {
  await pages.revokeShareLink(actor(req), param(req, "pageId"), param(req, "linkId")); res.status(204).end();
});
router.post("/share/:token/accept", async (req, res) => {
  const token = z.string().min(20).max(200).parse(req.params.token);
  res.json(await pages.acceptShareLink(actor(req), token));
});

router.post("/sync/pages/:pageId", async (req, res) => {
  const body = objectBody(z.object({ operationId: z.string().uuid(), baseVersion: z.number().int().positive(), title: title.optional(), content: z.unknown(), background: z.unknown().optional() }), req);
  const result = await syncPage(actor(req), { ...body, pageId: param(req, "pageId") });
  if (result.status === "synced") hub.broadcast(param(req, "pageId"), { type: "page.refresh", pageId: param(req, "pageId"), version: result.page.version });
  res.json(result);
});

router.get("/templates", async (req, res) => res.json({ templates: await templates.listTemplates(actor(req)) }));
router.post("/templates", async (req, res) => {
  const body = objectBody(z.object({ title, description: z.string().max(1000).optional(), content: z.unknown().optional(), background: z.unknown().optional(), scope: z.enum(["PRIVATE", "DEPARTMENT", "COMPANY"]).optional() }), req);
  res.status(201).json({ template: await templates.createTemplate(actor(req), body) });
});
router.get("/templates/:templateId", async (req, res) => res.json({ template: await templates.getTemplate(actor(req), param(req, "templateId")) }));
router.patch("/templates/:templateId", async (req, res) => {
  const body = objectBody(z.object({ title: title.optional(), description: z.string().max(1000).optional(), content: z.unknown().optional(), background: z.unknown().optional(), scope: z.enum(["PRIVATE", "DEPARTMENT", "COMPANY"]).optional(), isDefault: z.boolean().optional() }).refine((data) => Object.keys(data).length > 0), req);
  res.json({ template: await templates.updateTemplate(actor(req), param(req, "templateId"), body) });
});
router.delete("/templates/:templateId", async (req, res) => { await templates.deleteTemplate(actor(req), param(req, "templateId")); res.status(204).end(); });

router.post("/files", (req, res, next) => uploadSingleFile.single("file")(req, res, next), async (req, res) => {
  if (!req.file) throw badRequest("Debes adjuntar un archivo en el campo 'file'.");
  const pageId = typeof req.body.pageId === "string" ? id.parse(req.body.pageId) : undefined;
  const file = await files.saveUploadedFile(actor(req), req.file, pageId);
  res.status(201).json({ file, url: `/api/files/${file.id}/content` });
});
router.get("/pages/:pageId/files", async (req, res) => res.json({ files: await files.listPageFiles(actor(req), param(req, "pageId")) }));
router.get("/files/:fileId/content", async (req, res) => {
  const file = await files.findReadableFile(actor(req), param(req, "fileId"));
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.sizeBytes));
  res.setHeader("Content-Disposition", `${isInlineSafeImage(file.mimeType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
  openFile(file.path).pipe(res);
});
router.delete("/files/:fileId", async (req, res) => { await files.deleteFile(actor(req), param(req, "fileId")); res.status(204).end(); });

export function makeRouter(realtime: RealtimeHub) {
  hub = realtime;
  return router;
}

let hub: RealtimeHub;
