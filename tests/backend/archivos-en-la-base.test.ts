import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileStorage, uploadDirectory } from "../../backend/storage/files.js";
import { createDepartment, createPage, createUser, prisma, readFileStatus, resetDatabase, startApi, uploadImage, type TestApi, type TestUser } from "./helpers";

// Las funciones de Vercel no conservan el disco: los archivos van a la base (FILE_STORAGE=database).
let api: TestApi;
let duena: TestUser, otra: TestUser, admin: TestUser;
const before = process.env.FILE_STORAGE;

beforeAll(async () => {
  process.env.FILE_STORAGE = "database";
  await resetDatabase();
  const tecnologia = await createDepartment("Tecnología");
  duena = await createUser("Usuario Tecnología", tecnologia.id);
  otra = await createUser("Usuario Compras", (await createDepartment("Compras")).id);
  admin = await createUser("Administrador", tecnologia.id, "ADMIN");
  api = await startApi();
});
afterAll(() => { api.close(); process.env.FILE_STORAGE = before; });

const upload = (user: TestUser, file: Blob, name: string, target: { pageId?: string } = {}) => {
  const form = new FormData();
  form.set("file", file, name);
  if (target.pageId) form.set("pageId", target.pageId);
  return fetch(`${api.base}/api/files`, { method: "POST", headers: { Authorization: `Bearer ${user.token}` }, body: form });
};
const content = (user: TestUser, id: string) => fetch(`${api.base}/api/files/${id}/content`, { headers: { Authorization: `Bearer ${user.token}` } });

describe("archivos guardados en la base de datos", () => {
  it("guarda los bytes en la base, no en el disco, y los entrega iguales", async () => {
    const page = await createPage(api, duena);
    const { status, body } = await uploadImage(api, duena, { pageId: page.id });
    expect(status).toBe(201);
    expect(body.file).not.toHaveProperty("data");
    const blob = await prisma.fileBlob.findUnique({ where: { storageName: body.file.storageName } });
    expect(blob?.data.length).toBe(body.file.sizeBytes);
    expect(existsSync(path.join(uploadDirectory, body.file.storageName))).toBe(false);

    const res = await content(duena, body.file.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(blob!.data))).toBe(true);
  });

  it("revisa los permisos antes de entregar: otra persona no ve el archivo de una página privada", async () => {
    const page = await createPage(api, duena);
    const { body } = await uploadImage(api, duena, { pageId: page.id });
    expect(await readFileStatus(api, otra, body.file.id)).toBe(403);
    expect(await readFileStatus(api, admin, body.file.id)).toBe(200);
    await api.as(duena).put(`/pages/${page.id}/shares/${otra.id}`, { permission: "READ" });
    expect(await readFileStatus(api, otra, body.file.id)).toBe(200);
  });

  it("quien solo puede leer la página no puede subirle archivos y no se guarda nada", async () => {
    const page = await createPage(api, duena);
    await api.as(duena).put(`/pages/${page.id}/shares/${otra.id}`, { permission: "READ" });
    const blobs = await prisma.fileBlob.count();
    const res = await upload(otra, new Blob([Buffer.from("hola")], { type: "text/plain" }), "nota.txt", { pageId: page.id });
    expect(res.status).toBe(403);
    expect(await prisma.fileBlob.count()).toBe(blobs);
  });

  it("mantiene los tipos permitidos y el límite de 4 MB", async () => {
    const blobs = await prisma.fileBlob.count();
    expect((await upload(duena, new Blob(["<script>"], { type: "text/html" }), "pagina.html")).status).toBe(415);
    const big = await upload(duena, new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "application/pdf" }), "grande.pdf");
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("FILE_TOO_LARGE");
    expect((await upload(duena, new Blob([new Uint8Array(4 * 1024 * 1024)], { type: "application/pdf" }), "justo.pdf")).status).toBe(201);
    expect(await prisma.fileBlob.count()).toBe(blobs + 1);
  });

  it("al eliminar el archivo o la página definitivamente, sus bytes salen de la base", async () => {
    const suelto = (await uploadImage(api, duena)).body.file;
    expect((await api.as(duena).delete(`/files/${suelto.id}`)).status).toBe(204);
    expect(await prisma.fileBlob.findUnique({ where: { storageName: suelto.storageName } })).toBeNull();

    const page = await createPage(api, duena);
    const deLaPagina = (await uploadImage(api, duena, { pageId: page.id })).body.file;
    await api.as(duena).delete(`/pages/${page.id}`);
    expect((await api.as(duena).delete(`/pages/${page.id}/permanent`)).status).toBe(204);
    expect(await prisma.fileBlob.findUnique({ where: { storageName: deLaPagina.storageName } })).toBeNull();
  });

  it("una página creada desde una plantilla recibe su propia copia del archivo en la base", async () => {
    const file = (await uploadImage(api, duena)).body.file;
    const template = (await api.as(duena).post("/templates", { title: "Con foto", scope: "PRIVATE", content: [{ id: "b1", type: "image", data: { url: `/archivos/${file.id}`, alt: "Foto" } }] })).body.template;
    const page = (await api.as(duena).post(`/pages/from-template/${template.id}`, { title: "Desde plantilla" })).body.page;
    const copyId = String(page.contentJson).match(/\/archivos\/([A-Za-z0-9_-]+)/)![1];
    expect(copyId).not.toBe(file.id);
    const copy = await prisma.fileAsset.findUnique({ where: { id: copyId }, include: { blob: true } });
    expect(copy?.pageId).toBe(page.id);
    expect(copy?.blob?.data.length).toBe(file.sizeBytes);
  });

  it("los archivos que ya estaban en disco se siguen leyendo después de cambiar al modo base", async () => {
    const storageName = "archivo-viejo-en-disco";
    await writeFile(path.join(uploadDirectory, storageName), "contenido viejo");
    const asset = await prisma.fileAsset.create({ data: { storageName, originalName: "viejo.txt", mimeType: "text/plain", sizeBytes: 15, ownerId: duena.id } });
    const res = await content(duena, asset.id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("contenido viejo");
  });

  it("FILE_STORAGE solo acepta disk o database; sin definir depende de si hay Turso", () => {
    process.env.FILE_STORAGE = "nube";
    expect(() => fileStorage()).toThrow(/disk.*database/);
    process.env.FILE_STORAGE = "";
    expect(fileStorage()).toBe(process.env.WIKI_TEST_TURSO === "1" ? "database" : "disk");
    process.env.FILE_STORAGE = "database";
  });
});
