import { Router, type Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
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
import type { CollabServer } from "../realtime/collab.js";
import type { RealtimeHub } from "../realtime/hub.js";

const router = Router();
const limiterDefaults = { standardHeaders: true, legacyHeaders: false, message: { error: { code: "TOO_MANY_REQUESTS", message: "Hiciste demasiados intentos. Espera unos minutos e inténtalo de nuevo." } } } as const;
// Con `trust proxy`, req.ip es la IP real de la persona. Solo cuentan los intentos fallidos:
// 10 por cuenta desde la misma IP y 50 en total por IP (varias personas pueden compartir la IP de un restaurante).
const loginEmailKey = (req: Request) => `${ipKeyGenerator(req.ip ?? "")}|${typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : ""}`;
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, keyGenerator: loginEmailKey, ...limiterDefaults });
const loginIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, skipSuccessfulRequests: true, ...limiterDefaults });
// Respaldo por cuenta, sin importar la IP: si alguien falsea o rota IPs, una misma cuenta no admite más de 30 fallos.
const loginAccountLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true, keyGenerator: (req) => `cuenta|${typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : ""}`, ...limiterDefaults });
const bootstrapLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, ...limiterDefaults });
// El buscador consulta mientras se escribe: 120 búsquedas por minuto y persona evitan que se use para volcar el directorio.
const directoryLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, keyGenerator: (req) => req.auth?.sub ?? ipKeyGenerator(req.ip ?? ""), ...limiterDefaults });
const id = z.string().min(1).max(100);
const email = z.string().email().max(254);
// Mínimo 8 caracteres (decisión del equipo: las cuentas de prueba usan una contraseña de 8).
const password = z.string().min(8).max(200);
const title = z.string().trim().min(1).max(200);
const role = z.enum(["USER", "DEPARTMENT_ADMIN", "ADMIN"]);
const visibility = z.enum(["PRIVATE", "DEPARTMENT", "COMPANY"]);
const permission = z.enum(["READ", "EDIT"]);
const tags = z.array(z.string().trim().min(1).max(40)).max(30).optional();
// Emoji, `lucide:<nombre>:<tono>` o `3d:<nombre>` (lo valida el frontend al mostrarlo); null lo quita.
const icon = z.string().trim().min(1).max(48).nullable().optional();
const objectBody = <T extends z.ZodType>(schema: T, req: Request) => schema.parse(req.body) as z.infer<T>;
const actor = (req: Request): Actor => ({ id: req.auth!.sub, role: req.auth!.role, departmentId: req.auth!.departmentId });
const currentUserId = (req: Request) => req.auth?.sub as string;
const param = (req: Request, name: string) => id.parse(req.params[name]);

router.post("/auth/bootstrap", bootstrapLimiter, async (req, res) => {
  const body = objectBody(z.object({ name: z.string().trim().min(1).max(100), email, password, departmentName: z.string().trim().min(2).max(100), secret: z.string().min(1) }), req);
  res.status(201).json(await auth.bootstrapAdmin(body));
});

router.post("/auth/login", loginIpLimiter, loginAccountLimiter, loginLimiter, async (req, res) => {
  const body = objectBody(z.object({ email, password: z.string().min(1).max(200) }), req);
  res.json(await auth.login(body.email, body.password));
});

router.use(requireAuth);

// Después de un cambio que puede dar o quitar acceso (compartir, publicar, papelera, muros, cuentas),
// la edición en vivo vuelve a comprobar los permisos de quienes están conectados.
router.use((req, res, next) => {
  if (req.method !== "GET") res.on("finish", () => {
    if (res.statusCode >= 400) return;
    const pageId = /^\/pages\/([^/]+)/.exec(req.path)?.[1];
    if (pageId && !["trash", "from-template"].includes(pageId) && !req.path.endsWith("/visit")) collab.refreshPage(pageId);
    // Enviar a la papelera también afecta a las subpáginas, y los muros a varias páginas.
    if (/^\/(departments\/[^/]+|company)\/wall$/.test(req.path) || (req.method === "DELETE" && /^\/pages\/[^/]+$/.test(req.path))) collab.refreshAll();
    if (/^\/share\/[^/]+\/accept$/.test(req.path) && req.auth) collab.refreshUser(req.auth.sub);
    const userId = /^\/users\/([^/]+)$/.exec(req.path)?.[1];
    if (userId) collab.refreshUser(userId);
    if (req.path === "/auth/password" && req.auth) collab.refreshUser(req.auth.sub);
  });
  next();
});

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
  const body = objectBody(z.object({ name: z.string().trim().min(2).max(100), description: z.string().max(500).optional(), icon }), req);
  res.status(201).json({ department: await departments.createDepartment(body) });
});
router.get("/departments/:department", async (req, res) => res.json({ department: await departments.getDepartment(actor(req), param(req, "department")) }));
router.patch("/departments/:departmentId", async (req, res) => {
  const body = objectBody(z.object({ name: z.string().trim().min(2).max(100).optional(), description: z.string().max(500).optional(), icon }).refine((data) => Object.keys(data).length > 0), req);
  res.json({ department: await departments.updateDepartment(actor(req), param(req, "departmentId"), body) });
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
router.get("/company/featured", async (req, res) => res.json({ pages: await departments.listCompanyFeaturedPages(actor(req)) }));
router.put("/company/featured", requireRole("ADMIN"), async (req, res) => {
  const body = objectBody(z.object({ pageIds: z.array(id).max(12) }), req);
  res.json({ pages: await departments.setCompanyFeaturedPages(actor(req), body.pageIds) });
});
router.delete("/company/wall", requireRole("ADMIN"), async (req, res) => {
  await departments.clearCompanyWall(actor(req)); res.status(204).end();
});

router.get("/users/directory", directoryLimiter, async (req, res) => {
  const query = z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(20).default(10), offset: z.coerce.number().int().min(0).max(auth.DIRECTORY_MAX_MATCHES - 1).default(0) }).parse(req.query);
  res.json(await auth.searchDirectory(actor(req), query.q, query.limit, query.offset));
});
router.get("/users", requireRole("ADMIN"), async (req, res) => res.json({ users: await auth.listUsers(req.query.includeInactive === "1" || req.query.includeInactive === "true") }));
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
router.delete("/pages/trash", async (req, res) => res.json(await pages.emptyTrash(actor(req))));
router.delete("/pages/:pageId/permanent", async (req, res) => { await pages.deletePagePermanently(actor(req), param(req, "pageId")); res.status(204).end(); });
router.post("/pages/:pageId/restore", async (req, res) => res.json({ page: await pages.restorePage(actor(req), param(req, "pageId")) }));

router.get("/pages", async (req, res) => {
  const departmentId = typeof req.query.departmentId === "string" ? id.parse(req.query.departmentId) : undefined;
  const parentId = typeof req.query.parentId === "string" ? id.parse(req.query.parentId) : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : undefined;
  const tag = typeof req.query.tag === "string" ? req.query.tag.slice(0, 40) : undefined;
  // ?ids=a,b,c: páginas concretas (subpáginas y menciones del contenido), hasta 100.
  if (req.query.ids !== undefined) {
    const rawIds = z.string().parse(req.query.ids).split(",").filter(Boolean);
    const ids = z.array(id).max(100).parse([...new Set(rawIds)]);
    const result = await pages.listAccessiblePages(actor(req), { q, tag, departmentId, parentId, ids });
    res.json({ pages: result.pages });
    return;
  }
  const cursor = typeof req.query.cursor === "string" ? id.parse(req.query.cursor) : undefined;
  const limit = z.coerce.number().int().min(1).max(100).catch(100).parse(req.query.limit ?? 100);
  res.json(await pages.listAccessiblePages(actor(req), { q, tag, departmentId, parentId, cursor, limit }));
});
router.post("/pages", async (req, res) => {
  const body = objectBody(z.object({ title, icon, content: z.unknown().optional(), background: z.unknown().optional(), visibility: visibility.optional(), parentId: id.nullable().optional(), tags }), req);
  res.status(201).json({ page: await pages.createPage(actor(req), body) });
});
router.post("/pages/from-template/:templateId", async (req, res) => {
  const body = objectBody(z.object({ title: title.optional(), parentId: id.nullable().optional() }), req);
  res.status(201).json({ page: await templates.createPageFromTemplate(actor(req), param(req, "templateId"), body) });
});
router.get("/pages/:pageId", async (req, res) => res.json({ page: await pages.findAccessiblePage(param(req, "pageId"), actor(req)) }));
router.post("/pages/:pageId/visit", async (req, res) => res.json(await pages.recordVisit(actor(req), param(req, "pageId"))));
router.patch("/pages/:pageId", async (req, res) => {
  const body = objectBody(z.object({ title: title.optional(), icon, content: z.unknown().optional(), background: z.unknown().optional(), visibility: visibility.optional(), parentId: id.nullable().optional(), tags, expectedVersion: z.number().int().positive(), autosave: z.boolean().optional() }).refine((data) => Object.keys(data).some((key) => key !== "expectedVersion" && key !== "autosave")), req);
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
  const page = await pages.restoreVersion(actor(req), param(req, "pageId"), version);
  // El contenido cambió fuera del editor en vivo: quienes lo tienen abierto vuelven a cargarlo.
  await collab.resetPage(page.id);
  res.json({ page });
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
router.get("/pages/:pageId/share-links", async (req, res) => res.json({ links: await pages.listShareLinks(actor(req), param(req, "pageId")) }));
router.get("/share/:token", async (req, res) => {
  const info = await pages.describeShareLink(z.string().min(20).max(200).parse(req.params.token));
  if (!info) throw notFound("El enlace no existe, venció o fue revocado.");
  res.json(info);
});
router.post("/share/:token/accept", async (req, res) => {
  const token = z.string().min(20).max(200).parse(req.params.token);
  // El mismo enlace /share/<token> sirve para páginas y plantillas.
  const accepted = await pages.acceptShareLink(actor(req), token) ?? await templates.acceptTemplateShareLink(actor(req), token);
  if (!accepted) throw notFound("El enlace no existe, venció o fue revocado.");
  res.json(accepted);
});

router.post("/sync/pages/:pageId", async (req, res) => {
  const body = objectBody(z.object({ operationId: z.string().uuid(), baseVersion: z.number().int().positive(), title: title.optional(), icon, content: z.unknown(), background: z.unknown().optional(), tags }), req);
  const result = await syncPage(actor(req), { ...body, pageId: param(req, "pageId") });
  if (result.status === "synced") await collab.resetPage(param(req, "pageId"));
  if (result.status === "synced") hub.broadcast(param(req, "pageId"), { type: "page.refresh", pageId: param(req, "pageId"), version: result.page.version });
  res.json(result);
});

router.get("/templates", async (req, res) => res.json({ templates: await templates.listTemplates(actor(req)) }));
router.post("/templates", async (req, res) => {
  const body = objectBody(z.object({ title, description: z.string().max(1000).optional(), icon, content: z.unknown().optional(), background: z.unknown().optional(), scope: z.enum(["PRIVATE", "DEPARTMENT", "COMPANY"]).optional() }), req);
  res.status(201).json({ template: await templates.createTemplate(actor(req), body) });
});
router.get("/templates/:templateId", async (req, res) => res.json({ template: await templates.getTemplate(actor(req), param(req, "templateId")) }));
router.patch("/templates/:templateId", async (req, res) => {
  const body = objectBody(z.object({ title: title.optional(), description: z.string().max(1000).optional(), icon, content: z.unknown().optional(), background: z.unknown().optional(), scope: z.enum(["PRIVATE", "DEPARTMENT", "COMPANY"]).optional(), isDefault: z.boolean().optional() }).refine((data) => Object.keys(data).length > 0), req);
  res.json({ template: await templates.updateTemplate(actor(req), param(req, "templateId"), body) });
});
router.delete("/templates/:templateId", async (req, res) => { await templates.deleteTemplate(actor(req), param(req, "templateId")); res.status(204).end(); });
router.put("/templates/:templateId/shares/:userId", async (req, res) => {
  const body = objectBody(z.object({ permission }), req);
  res.json({ share: await templates.shareTemplate(actor(req), param(req, "templateId"), param(req, "userId"), body.permission) });
});
router.delete("/templates/:templateId/shares/:userId", async (req, res) => {
  await templates.revokeTemplateShare(actor(req), param(req, "templateId"), param(req, "userId")); res.status(204).end();
});
router.get("/templates/:templateId/share-links", async (req, res) => res.json({ links: await templates.listTemplateShareLinks(actor(req), param(req, "templateId")) }));
router.post("/templates/:templateId/share-links", async (req, res) => {
  const body = objectBody(z.object({ permission, expiresInHours: z.number().int().positive().max(8760).optional() }), req);
  const link = await templates.createTemplateShareLink(actor(req), param(req, "templateId"), body.permission, body.expiresInHours);
  res.status(201).json({ ...link, url: `${process.env.FRONTEND_ORIGIN ?? ""}/share/${link.token}` });
});
router.delete("/templates/:templateId/share-links/:linkId", async (req, res) => {
  await templates.revokeTemplateShareLink(actor(req), param(req, "templateId"), param(req, "linkId")); res.status(204).end();
});

router.post("/files", (req, res, next) => uploadSingleFile.single("file")(req, res, next), async (req, res) => {
  if (!req.file) throw badRequest("Debes adjuntar un archivo en el campo 'file'.");
  const pageId = typeof req.body.pageId === "string" ? id.parse(req.body.pageId) : undefined;
  const templateId = typeof req.body.templateId === "string" ? id.parse(req.body.templateId) : undefined;
  const file = await files.saveUploadedFile(actor(req), req.file, { pageId, templateId });
  res.status(201).json({ file, url: `/api/files/${file.id}/content` });
});
router.get("/pages/:pageId/files", async (req, res) => res.json({ files: await files.listPageFiles(actor(req), param(req, "pageId")) }));
router.get("/files/:fileId/content", async (req, res) => {
  // Primero los permisos; después los bytes (de la base o del disco, según dónde se guardó).
  const { asset: file, data } = await files.readFileContent(actor(req), param(req, "fileId"));
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(data.length));
  res.setHeader("Content-Disposition", `${isInlineSafeImage(file.mimeType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
  res.end(data);
});
router.delete("/files/:fileId", async (req, res) => { await files.deleteFile(actor(req), param(req, "fileId")); res.status(204).end(); });

export function makeRouter(realtime: RealtimeHub, collabServer: CollabServer) {
  hub = realtime;
  collab = collabServer;
  return router;
}

let hub: RealtimeHub;
let collab: CollabServer;
