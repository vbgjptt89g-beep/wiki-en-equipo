import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HTTP_COLLAB } from "../../backend/realtime/http-collab.js";
import { awarenessProtocol, Y } from "./collab-client";
import { createDepartment, createPage, createUser, prisma, resetDatabase, startApi, type TestApi, type TestUser } from "./helpers";

// Edición en vivo por HTTP (producción en Vercel): cada editor consulta POST /api/collab/:pageId.
let api: TestApi;
let duena: TestUser, lectora: TestUser, editora: TestUser, ajena: TestUser, admin: TestUser;

beforeAll(async () => {
  await resetDatabase();
  const tecnologia = await createDepartment("Tecnología");
  const compras = await createDepartment("Compras");
  admin = await createUser("Administrador", tecnologia.id, "ADMIN");
  duena = await createUser("Usuario Tecnología", tecnologia.id);
  editora = await createUser("Pedro Gómez", tecnologia.id);
  lectora = await createUser("Usuario Compras", compras.id);
  ajena = await createUser("Rosa Lainez", compras.id);
  api = await startApi();
});
afterAll(() => api.close());

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

/** Un editor como el del navegador: documento Yjs, presencia y cursor de la última consulta. */
class Editor {
  doc = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.doc);
  epoch: string | null = null;
  cursor = 0;
  constructor(readonly user: TestUser, readonly pageId: string) {}
  text() { return this.doc.getText("t").toString(); }
  async sync(extra: { update?: Uint8Array; withAwareness?: boolean } = {}) {
    const res = await api.as(this.user).post(`/collab/${this.pageId}`, {
      epoch: this.epoch, after: this.cursor, clientId: this.doc.clientID,
      ...(extra.update && { update: b64(extra.update) }),
      ...(extra.withAwareness && { awareness: b64(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])) }),
    });
    if (res.status === 200) {
      this.epoch = res.body.epoch;
      this.cursor = res.body.cursor;
      if (res.body.update) Y.applyUpdate(this.doc, bytes(res.body.update), "servidor");
      if (res.body.awareness) awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes(res.body.awareness), "servidor");
    }
    return res;
  }
  /** Escribe y envía el cambio. */
  async write(text: string) {
    let update: Uint8Array | undefined;
    const keep = (u: Uint8Array) => { update = u; };
    this.doc.once("update", keep);
    this.doc.getText("t").insert(this.doc.getText("t").length, text);
    return this.sync({ update });
  }
}

describe("edición en vivo por HTTP: permisos", () => {
  it("sin sesión 401, sin acceso 403 y página inexistente 404", async () => {
    const page = await createPage(api, duena);
    expect((await api.as(null).post(`/collab/${page.id}`, {})).status).toBe(401);
    expect((await api.as(ajena).post(`/collab/${page.id}`, {})).status).toBe(403);
    expect((await api.as(duena).post(`/collab/no-existe-esta-pagina`, {})).status).toBe(404);
    expect((await api.as(duena).post(`/collab/${page.id}`, {})).status).toBe(200);
    expect((await api.as(admin).post(`/collab/${page.id}`, {})).body.access).toBe("edit");
  });

  it("quien solo puede leer recibe los cambios, pero los suyos se ignoran", async () => {
    const page = await createPage(api, duena);
    await api.as(duena).put(`/pages/${page.id}/shares/${lectora.id}`, { permission: "READ" });
    const owner = new Editor(duena, page.id);
    const reader = new Editor(lectora, page.id);
    await owner.sync();
    await owner.write("Hola");
    const first = await reader.sync();
    expect(first.body.access).toBe("read");
    expect(reader.text()).toBe("Hola");
    const attempt = await reader.write(" intruso");
    expect(attempt.status).toBe(200);
    expect(attempt.body.ignored).toBe(true);
    await owner.sync();
    expect(owner.text()).toBe("Hola");
    expect(await prisma.collabUpdate.count({ where: { pageId: page.id, userId: lectora.id } })).toBe(0);
  });

  it("al quitarle el acceso, la siguiente consulta responde 403", async () => {
    const page = await createPage(api, duena);
    await api.as(duena).put(`/pages/${page.id}/shares/${editora.id}`, { permission: "EDIT" });
    const guest = new Editor(editora, page.id);
    expect((await guest.write("Mientras puedo")).status).toBe(200);
    await api.as(duena).delete(`/pages/${page.id}/shares/${editora.id}`);
    expect((await guest.sync()).status).toBe(403);
    expect((await guest.write("ya no")).status).toBe(403);
  });
});

describe("edición en vivo por HTTP: sincronización", () => {
  it("dos editores ven los cambios del otro", async () => {
    const page = await createPage(api, duena);
    await api.as(duena).put(`/pages/${page.id}/shares/${editora.id}`, { permission: "EDIT" });
    const a = new Editor(duena, page.id);
    const b = new Editor(editora, page.id);
    await a.sync();
    await b.sync();
    expect(a.epoch).toBe(b.epoch);
    await a.write("Uno.");
    await b.write(" Dos.");
    await a.sync();
    expect(a.text()).toBe(b.text());
    expect(a.text()).toContain("Uno.");
    expect(a.text()).toContain("Dos.");
  });

  it("combina lo escrito sin conexión al volver (sin perder lo de los demás)", async () => {
    const page = await createPage(api, duena);
    await api.as(duena).put(`/pages/${page.id}/shares/${editora.id}`, { permission: "EDIT" });
    const a = new Editor(duena, page.id);
    const b = new Editor(editora, page.id);
    await a.write("Base.");
    await b.sync();
    // B se queda sin conexión y escribe; mientras, A sigue.
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(b.doc));
    b.doc.getText("t").insert(b.doc.getText("t").length, " Sin conexión.");
    await a.write(" En línea.");
    // Al reconectar, B envía la diferencia contra lo que tenía el servidor.
    const pending = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(offline));
    await b.sync({ update: pending });
    await a.sync();
    expect(a.text()).toBe(b.text());
    expect(a.text()).toContain("Sin conexión.");
    expect(a.text()).toContain("En línea.");
  });

  it("compacta los cambios sin perder nada, también para quien tenía un cursor viejo", async () => {
    const page = await createPage(api, duena);
    const a = new Editor(duena, page.id);
    await a.sync();
    const old = new Editor(duena, page.id);
    await old.sync();
    for (let i = 0; i < HTTP_COLLAB.compactAfter + 5; i++) await a.write(`${i},`);
    const doc = await prisma.collabDoc.findUnique({ where: { pageId: page.id } });
    expect(doc!.lastUpdateId).toBeGreaterThan(0);
    const fresh = new Editor(duena, page.id);
    await fresh.sync();
    await old.sync();
    expect(fresh.text()).toBe(a.text());
    expect(old.text()).toBe(a.text());
  });

  it("si el contenido se reemplazó (restaurar una versión), el editor abierto recibe 409", async () => {
    const page = await createPage(api, duena, { content: [] });
    await api.as(duena).patch(`/pages/${page.id}`, { title: "Cambio", expectedVersion: page.version });
    const a = new Editor(duena, page.id);
    await a.write("Algo");
    expect((await api.as(duena).post(`/pages/${page.id}/history/1/restore`)).status).toBe(200);
    expect((await a.sync()).status).toBe(409);
    const again = new Editor(duena, page.id);
    expect((await again.sync()).status).toBe(200);
    expect(again.epoch).not.toBe(a.epoch);
    expect(again.text()).toBe("");
  });

  it("rechaza cambios que no son de Yjs", async () => {
    const page = await createPage(api, duena);
    expect((await api.as(duena).post(`/collab/${page.id}`, { update: b64(new Uint8Array([255, 255, 255, 255])) })).status).toBe(400);
  });
});

describe("edición en vivo por HTTP: presencia", () => {
  it("los demás ven la presencia con el nombre real de la cuenta, y nadie ve la propia", async () => {
    const page = await createPage(api, duena);
    await api.as(duena).put(`/pages/${page.id}/shares/${editora.id}`, { permission: "EDIT" });
    const a = new Editor(duena, page.id);
    const b = new Editor(editora, page.id);
    a.awareness.setLocalStateField("user", { name: "Otra persona", color: "#123456" });
    const own = await a.sync({ withAwareness: true });
    expect(own.body.awareness).toBeNull();
    await b.sync();
    expect(b.awareness.getStates().get(a.doc.clientID)).toMatchObject({ user: { name: "Usuario Tecnología", color: "#123456" } });
  });

  it("nadie puede publicar presencia con el clientID de otra persona", async () => {
    const page = await createPage(api, duena);
    await api.as(duena).put(`/pages/${page.id}/shares/${editora.id}`, { permission: "EDIT" });
    const a = new Editor(duena, page.id);
    a.awareness.setLocalStateField("user", { name: "A", color: "#e2001a" });
    await a.sync({ withAwareness: true });
    // B fabrica un estado con el clientID de A.
    const fake = new Y.Doc();
    fake.clientID = a.doc.clientID;
    const fakeAwareness = new awarenessProtocol.Awareness(fake);
    fakeAwareness.setLocalStateField("user", { name: "B", color: "#000000" });
    for (let i = 0; i < 5; i++) fakeAwareness.setLocalStateField("cursor", i);
    await api.as(editora).post(`/collab/${page.id}`, { awareness: b64(awarenessProtocol.encodeAwarenessUpdate(fakeAwareness, [fake.clientID])) });
    const row = await prisma.collabPresence.findUnique({ where: { pageId_clientId: { pageId: page.id, clientId: String(a.doc.clientID) } } });
    expect(row?.userId).toBe(duena.id);
    expect(JSON.parse(row!.state!).user.name).toBe("Usuario Tecnología");
  });

  it("la presencia de quien solo lee también se ve (como con WebSockets)", async () => {
    const page = await createPage(api, duena);
    await api.as(duena).put(`/pages/${page.id}/shares/${lectora.id}`, { permission: "READ" });
    const reader = new Editor(lectora, page.id);
    reader.awareness.setLocalStateField("user", { name: "x", color: "#1f5fae" });
    await reader.sync({ withAwareness: true });
    const owner = new Editor(duena, page.id);
    await owner.sync();
    expect(owner.awareness.getStates().get(reader.doc.clientID)).toMatchObject({ user: { name: "Usuario Compras" } });
  });
});
