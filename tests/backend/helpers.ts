/**
 * Utilidades de las pruebas del backend: base de datos limpia, usuarios con token y un
 * servidor HTTP real (Express + WebSockets) en un puerto libre.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app, attachWebSockets } from "../../backend/src/app.js";
import { signAccessToken } from "../../backend/auth/token.js";
import { prisma } from "../../backend/models/client.js";

export { prisma };

export type Role = "USER" | "DEPARTMENT_ADMIN" | "ADMIN";
export type TestUser = { id: string; name: string; email: string; role: Role; departmentId: string; token: string };
export type ApiResult<T = any> = { status: number; body: T };

let counter = 0;
const slug = (value: string) => value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Vacía todas las tablas (en el orden que permitan las llaves foráneas). */
export async function resetDatabase() {
  const tables = (await prisma.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> '_prisma_migrations' AND name NOT LIKE 'sqlite_%'",
  )).map((table) => table.name);
  let pending = tables;
  for (let pass = 0; pending.length && pass < 10; pass++) {
    const failed: string[] = [];
    for (const table of pending) {
      try { await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`); } catch { failed.push(table); }
    }
    pending = failed;
  }
  if (pending.length) throw new Error(`No se pudieron vaciar: ${pending.join(", ")}`);
}

export function createDepartment(name: string) {
  return prisma.department.create({ data: { name, slug: slug(name) } });
}

export async function createUser(name: string, departmentId: string, role: Role = "USER", options: { passwordHash?: string; active?: boolean; email?: string } = {}): Promise<TestUser> {
  const email = options.email ?? `${slug(name)}-${++counter}@wiki.test`;
  const searchName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const user = await prisma.user.create({ data: { name, searchName, email, passwordHash: options.passwordHash ?? "sin-contraseña", role, departmentId, active: options.active ?? true } });
  return { id: user.id, name: user.name, email: user.email, role, departmentId, token: signAccessToken({ sub: user.id, role, departmentId, sessionVersion: user.sessionVersion }) };
}

export type TestApi = Awaited<ReturnType<typeof startApi>>;

/** Levanta la API completa en 127.0.0.1 con un puerto libre. */
export async function startApi() {
  const server: Server = createServer(app);
  attachWebSockets(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function call<T = any>(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}/api${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  /** Atajos para llamar como una persona: `api.as(luis).get("/pages")`. */
  const as = (user: { token: string } | null) => ({
    get: <T = any>(path: string) => call<T>("GET", path, { token: user?.token }),
    post: <T = any>(path: string, body: unknown = {}) => call<T>("POST", path, { token: user?.token, body }),
    put: <T = any>(path: string, body: unknown = {}) => call<T>("PUT", path, { token: user?.token, body }),
    patch: <T = any>(path: string, body: unknown = {}) => call<T>("PATCH", path, { token: user?.token, body }),
    delete: <T = any>(path: string) => call<T>("DELETE", path, { token: user?.token }),
  });

  return {
    base,
    wsBase: base.replace(/^http/, "ws"),
    server,
    call,
    as,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** PNG de 1×1 para probar subidas. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

/** Sube una imagen (multipart) como `user`, opcionalmente para una página o plantilla. */
export async function uploadImage(api: TestApi, user: TestUser, target: { pageId?: string; templateId?: string } = {}) {
  const form = new FormData();
  form.set("file", new Blob([PNG], { type: "image/png" }), "foto.png");
  if (target.pageId) form.set("pageId", target.pageId);
  if (target.templateId) form.set("templateId", target.templateId);
  const res = await fetch(`${api.base}/api/files`, { method: "POST", headers: { Authorization: `Bearer ${user.token}` }, body: form });
  return { status: res.status, body: await res.json() as any };
}

/** Lee un archivo como `user` y devuelve solo el estado. */
export async function readFileStatus(api: TestApi, user: TestUser, fileId: string) {
  const res = await fetch(`${api.base}/api/files/${fileId}/content`, { headers: { Authorization: `Bearer ${user.token}` } });
  await res.arrayBuffer();
  return res.status;
}

/** Crea una página como `owner` y devuelve su registro. */
export async function createPage(api: TestApi, owner: TestUser, data: Record<string, unknown> = {}) {
  const res = await api.as(owner).post("/pages", { title: `Página ${++counter}`, ...data });
  if (res.status !== 201) throw new Error(`No se pudo crear la página: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.page as { id: string; title: string; version: number; visibility: string };
}
