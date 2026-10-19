import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../backend/auth/password.js";
import { createDepartment, createPage, createUser, prisma, resetDatabase, startApi, type TestApi, type TestUser } from "./helpers";

// Lo que necesita el backend al correr como función de Vercel.
const PASSWORD = "contraseña-de-prueba-larga";
let api: TestApi;
let luis: TestUser;

beforeAll(async () => {
  await resetDatabase();
  const tecnologia = await createDepartment("Tecnología");
  luis = await createUser("Luis Paz", tecnologia.id, "USER", { passwordHash: await hashPassword(PASSWORD) });
  api = await startApi();
});
afterAll(() => { api.close(); delete process.env.PROXY_SECRET; delete process.env.CRON_SECRET; });

const login = (ip: string, secret?: string) => api.call("POST", "/auth/login", {
  body: { email: luis.email, password: "incorrecta" },
  headers: { "X-Wiki-Client-Ip": ip, ...(secret && { "X-Wiki-Proxy-Secret": secret }) },
});

describe("IP real del inicio de sesión detrás de Vercel", () => {
  it("con PROXY_SECRET correcto, cada IP tiene su propio límite", async () => {
    process.env.PROXY_SECRET = "secreto-compartido-de-prueba";
    for (let i = 0; i < 10; i++) expect((await login("203.0.113.50", "secreto-compartido-de-prueba")).status).toBe(401);
    expect((await login("203.0.113.50", "secreto-compartido-de-prueba")).status).toBe(429);
    // Otra persona (otra IP) desde el mismo servidor de Next sigue pudiendo intentar.
    expect((await login("198.51.100.20", "secreto-compartido-de-prueba")).status).toBe(401);
  });

  it("sin el secreto (o con uno falso) la IP enviada se ignora: nadie puede falsearla", async () => {
    process.env.PROXY_SECRET = "secreto-compartido-de-prueba";
    // Estas peticiones cuentan para la IP real de la conexión (127.0.0.1), no para la que dicen ser.
    for (let i = 0; i < 10; i++) expect((await login(`192.0.2.${i + 1}`, "secreto-falso-de-la-misma-larga")).status).toBe(401);
    expect((await login("192.0.2.200")).status).toBe(429);
  });
});

describe("Vercel Cron: limpieza de la papelera", () => {
  it("sin CRON_SECRET la ruta no existe y con un secreto equivocado tampoco", async () => {
    delete process.env.CRON_SECRET;
    expect((await api.call("GET", "/cron/papelera")).status).toBe(404);
    process.env.CRON_SECRET = "secreto-del-cron";
    expect((await api.call("GET", "/cron/papelera", { headers: { Authorization: "Bearer otro-secreto-xx" } })).status).toBe(404);
  });

  it("con el secreto correcto borra lo que pasó el límite de días", async () => {
    process.env.CRON_SECRET = "secreto-del-cron";
    process.env.TRASH_RETENTION_DAYS = "30";
    const page = await createPage(api, luis);
    await api.as(luis).delete(`/pages/${page.id}`);
    await prisma.page.update({ where: { id: page.id }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) } });
    const res = await api.call("GET", "/cron/papelera", { headers: { Authorization: "Bearer secreto-del-cron" } });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(await prisma.page.findUnique({ where: { id: page.id } })).toBeNull();
    process.env.TRASH_RETENTION_DAYS = "0";
  });
});

describe("CORS de la edición en vivo por HTTP (el navegador llama directo al backend)", () => {
  const preflight = (origin: string) => fetch(`${api.base}/api/collab/una-pagina`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });

  it("autoriza al frontend y guarda la respuesta 2 h (menos invocaciones)", async () => {
    const res = await preflight("http://localhost:3000");
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-max-age")).toBe("7200");
  });

  it("no autoriza a otros sitios", async () => {
    const res = await preflight("https://sitio-malo.example");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("cuerpos grandes", () => {
  it("más de 4 MB responde 413 y no 500", async () => {
    const res = await api.as(luis).post("/collab/una-pagina-cualquiera", { update: "A".repeat(4.2 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
  });
});
