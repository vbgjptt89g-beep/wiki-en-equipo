import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collabServer } from "../../backend/src/app.js";
import { awarenessProtocol, connectCollab, connectionStatus, sleep, waitFor, Y } from "./collab-client";
import { createDepartment, createPage, createUser, prisma, resetDatabase, startApi, type TestApi, type TestUser } from "./helpers";

let api: TestApi;
let luis: TestUser, pedro: TestUser, maria: TestUser, ana: TestUser;
const url = (pageId: string, token?: string) => `${api.wsBase}/collab/pagina-${pageId}${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`;
const roomsClosed = () => waitFor(() => collabServer.stats().rooms === 0);

beforeAll(async () => {
  await resetDatabase();
  const tecnologia = await createDepartment("Tecnología");
  const compras = await createDepartment("Compras");
  ana = await createUser("Ana Rivera", tecnologia.id, "ADMIN");
  luis = await createUser("Luis Paz", tecnologia.id);
  pedro = await createUser("Pedro Gómez", tecnologia.id);
  maria = await createUser("María Zelaya", compras.id);
  api = await startApi();
});
afterAll(() => api.close());

describe("conexión al servidor Yjs", () => {
  it("rechaza sin sesión, con sesión inválida y a quien no tiene acceso", async () => {
    const page = await createPage(api, luis);
    expect(await connectionStatus(url(page.id))).toBe(401);
    expect(await connectionStatus(url(page.id, "no-es-un-token"))).toBe(401);
    expect(await connectionStatus(url(page.id, maria.token))).toBe(403);
    expect(await connectionStatus(url(page.id, pedro.token))).toBe(403);
    expect(await connectionStatus(url("no-existe", luis.token))).toBe(403);
    expect(await connectionStatus(`${api.wsBase}/collab/otra-sala?token=${luis.token}`)).toBe(404);
    expect(await connectionStatus(url(page.id, luis.token))).toBe(101);
    expect(await connectionStatus(url(page.id, ana.token))).toBe(101);
    await roomsClosed();
  });

  it("rechaza cuentas desactivadas y sesiones revocadas", async () => {
    const page = await createPage(api, luis, { visibility: "DEPARTMENT" });
    await prisma.user.update({ where: { id: pedro.id }, data: { sessionVersion: { increment: 1 } } });
    expect(await connectionStatus(url(page.id, pedro.token))).toBe(401);
    await prisma.user.update({ where: { id: pedro.id }, data: { sessionVersion: { decrement: 1 } } });
    expect(await connectionStatus(url(page.id, pedro.token))).toBe(101);
    await roomsClosed();
  });

  it("solo acepta navegadores desde la wiki (Origin)", async () => {
    const page = await createPage(api, luis);
    expect(await connectionStatus(url(page.id, luis.token), { Origin: "https://otro-sitio.example" })).toBe(403);
    expect(await connectionStatus(url(page.id, luis.token), { Origin: "http://localhost:3000" })).toBe(101);
    await roomsClosed();
  });
});

describe("edición en vivo", () => {
  it("lo que escribe una persona aparece al instante en la otra", async () => {
    const page = await createPage(api, luis);
    await api.as(luis).put(`/pages/${page.id}/shares/${maria.id}`, { permission: "EDIT" });
    const a = await connectCollab(api.wsBase, page.id, luis.token);
    const b = await connectCollab(api.wsBase, page.id, maria.token);
    a.write("Hola ");
    await waitFor(() => b.text() === "Hola ");
    b.write("mundo");
    await waitFor(() => a.text() === "Hola mundo");
    await a.close(); await b.close(); await roomsClosed();
  });

  it("quien solo puede leer recibe los cambios pero los suyos se ignoran", async () => {
    const page = await createPage(api, luis, { visibility: "DEPARTMENT" });
    const editor = await connectCollab(api.wsBase, page.id, luis.token);
    const lector = await connectCollab(api.wsBase, page.id, pedro.token);
    editor.write("Checklist");
    await waitFor(() => lector.text() === "Checklist");
    lector.write(" (cambio no permitido)");
    await sleep(300);
    expect(editor.text()).toBe("Checklist");
    const otro = await connectCollab(api.wsBase, page.id, ana.token);
    expect(otro.text()).toBe("Checklist");
    // Sigue recibiendo los cambios de quien sí edita.
    editor.write(" listo");
    await waitFor(() => otro.text() === "Checklist listo");
    await editor.close(); await lector.close(); await otro.close(); await roomsClosed();
  });
});

describe("presencia", () => {
  it("muestra el nombre real de la cuenta y no permite suplantar a otra conexión", async () => {
    const page = await createPage(api, luis, { visibility: "DEPARTMENT" });
    const a = await connectCollab(api.wsBase, page.id, luis.token);
    const b = await connectCollab(api.wsBase, page.id, pedro.token);
    a.awareness.setLocalState({ user: { name: "Impostor", color: "#c9861f" } });
    const nameOfA = () => (b.awareness.getStates().get(a.doc.clientID) as { user?: { name: string; color: string } } | undefined)?.user;
    await waitFor(() => nameOfA()?.name === "Luis Paz");
    expect(nameOfA()?.color).toBe("#c9861f");

    // Pedro intenta publicar un estado con el clientID de Luis.
    const fake = new Y.Doc();
    fake.clientID = a.doc.clientID;
    const fakeAwareness = new awarenessProtocol.Awareness(fake);
    fakeAwareness.setLocalState({ user: { name: "Luis (falso)", color: "#000000" } });
    b.sendRawAwareness(awarenessProtocol.encodeAwarenessUpdate(fakeAwareness, [fake.clientID]));
    await sleep(300);
    expect(nameOfA()?.name).toBe("Luis Paz");

    // Al salir, su presencia desaparece para los demás.
    await a.close();
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID));
    fakeAwareness.destroy();
    await b.close(); await roomsClosed();
  });
});

describe("permisos que cambian durante la sesión", () => {
  it("quitar el acceso cierra la conexión (4403)", async () => {
    const page = await createPage(api, luis);
    await api.as(luis).put(`/pages/${page.id}/shares/${maria.id}`, { permission: "EDIT" });
    const m = await connectCollab(api.wsBase, page.id, maria.token);
    await api.as(luis).delete(`/pages/${page.id}/shares/${maria.id}`);
    expect((await m.closed).code).toBe(4403);
    await roomsClosed();
  });

  it("pasar de edición a lectura ignora sus cambios desde ese momento", async () => {
    const page = await createPage(api, luis);
    await api.as(luis).put(`/pages/${page.id}/shares/${maria.id}`, { permission: "EDIT" });
    const owner = await connectCollab(api.wsBase, page.id, luis.token);
    const m = await connectCollab(api.wsBase, page.id, maria.token);
    m.write("antes ");
    await waitFor(() => owner.text() === "antes ");
    await api.as(luis).put(`/pages/${page.id}/shares/${maria.id}`, { permission: "READ" });
    await sleep(200);
    m.write("después");
    await sleep(300);
    expect(owner.text()).toBe("antes ");
    await owner.close(); await m.close(); await roomsClosed();
  });

  it("enviar la página a la papelera o desactivar la cuenta cierra las conexiones", async () => {
    const page = await createPage(api, luis, { visibility: "DEPARTMENT" });
    const p = await connectCollab(api.wsBase, page.id, pedro.token);
    await api.as(ana).patch(`/users/${pedro.id}`, { active: false });
    expect((await p.closed).code).toBe(4403);
    await api.as(ana).patch(`/users/${pedro.id}`, { active: true });

    const l = await connectCollab(api.wsBase, page.id, luis.token);
    await api.as(luis).delete(`/pages/${page.id}`);
    expect((await l.closed).code).toBe(4403);
    await roomsClosed();
  });
});

describe("cambios hechos fuera del editor en vivo", () => {
  it("restaurar una versión cierra la sala (4409) y descarta el documento en memoria", async () => {
    const page = await createPage(api, luis);
    await api.as(luis).patch(`/pages/${page.id}`, { title: "Segunda versión", expectedVersion: page.version });
    const a = await connectCollab(api.wsBase, page.id, luis.token);
    a.write("Contenido antes de restaurar");
    await sleep(100);
    expect((await api.as(luis).post(`/pages/${page.id}/history/${page.version}/restore`)).status).toBe(200);
    expect((await a.closed).code).toBe(4409);
    await sleep(50);
    expect(await prisma.pageCollabState.findUnique({ where: { pageId: page.id } })).toBeNull();
    const b = await connectCollab(api.wsBase, page.id, luis.token);
    expect(b.text()).toBe("");
    await b.close(); await roomsClosed();
  });

  it("sincronizar cambios hechos sin conexión también la reinicia", async () => {
    const page = await createPage(api, luis);
    const a = await connectCollab(api.wsBase, page.id, luis.token);
    await api.as(luis).post(`/sync/pages/${page.id}`, { operationId: crypto.randomUUID(), baseVersion: page.version, content: [] });
    expect((await a.closed).code).toBe(4409);
    await roomsClosed();
  });

  it("enviar a la papelera la página superior cierra al instante las salas de sus subpáginas", async () => {
    const padre = await createPage(api, luis, { visibility: "DEPARTMENT" });
    const hija = await createPage(api, luis, { visibility: "DEPARTMENT", parentId: padre.id });
    const p = await connectCollab(api.wsBase, hija.id, pedro.token);
    const started = Date.now();
    await api.as(luis).delete(`/pages/${padre.id}`);
    expect((await p.closed).code).toBe(4403);
    expect(Date.now() - started).toBeLessThan(3_000);
    await roomsClosed();
  });

  it("aceptar un enlace de edición permite editar en vivo sin reconectar", async () => {
    const page = await createPage(api, luis, { visibility: "DEPARTMENT" });
    const owner = await connectCollab(api.wsBase, page.id, luis.token);
    const p = await connectCollab(api.wsBase, page.id, pedro.token);
    const link = await api.as(luis).post(`/pages/${page.id}/share-links`, { permission: "EDIT" });
    await api.as(pedro).post(`/share/${link.body.token}/accept`);
    await sleep(200);
    p.write("Ahora edito");
    await waitFor(() => owner.text() === "Ahora edito");
    await owner.close(); await p.close(); await roomsClosed();
  });

  it("el estado de presencia de quien sale queda reservado para su reconexión", async () => {
    const page = await createPage(api, luis, { visibility: "DEPARTMENT" });
    const a = await connectCollab(api.wsBase, page.id, luis.token);
    const b = await connectCollab(api.wsBase, page.id, pedro.token);
    const clientId = a.doc.clientID;
    a.awareness.setLocalState({ user: { name: "Luis", color: "#2e6a4f" } });
    await waitFor(() => b.awareness.getStates().has(clientId));
    await a.close();
    await waitFor(() => !b.awareness.getStates().has(clientId));

    // Pedro intenta quedarse con el clientID que Luis acaba de liberar.
    const fake = new Y.Doc();
    fake.clientID = clientId;
    const fakeAwareness = new awarenessProtocol.Awareness(fake);
    fakeAwareness.setLocalState({ user: { name: "x", color: "#000000" } });
    b.sendRawAwareness(awarenessProtocol.encodeAwarenessUpdate(fakeAwareness, [clientId]));
    const c = await connectCollab(api.wsBase, page.id, ana.token);
    await sleep(300);
    expect(c.awareness.getStates().has(clientId)).toBe(false);
    fakeAwareness.destroy();
    await b.close(); await c.close(); await roomsClosed();
  });
});

describe("estado guardado", () => {
  it("el documento se guarda y se recupera al volver a abrir la página", async () => {
    const page = await createPage(api, luis);
    const a = await connectCollab(api.wsBase, page.id, luis.token);
    a.write("Texto que no se pierde");
    await sleep(100);
    await a.close();
    await roomsClosed();
    const saved = await prisma.pageCollabState.findUnique({ where: { pageId: page.id } });
    expect(saved?.pageVersion).toBe(page.version);
    const b = await connectCollab(api.wsBase, page.id, luis.token);
    expect(b.text()).toBe("Texto que no se pierde");
    await b.close(); await roomsClosed();
  });

  it("si la página cambió por otra vía (restaurar, sincronizar), el estado viejo se descarta", async () => {
    const page = await createPage(api, luis);
    const a = await connectCollab(api.wsBase, page.id, luis.token);
    a.write("Versión vieja");
    await sleep(100);
    await a.close();
    await roomsClosed();
    await api.as(luis).patch(`/pages/${page.id}`, { title: "Cambiada por REST", expectedVersion: page.version });
    const b = await connectCollab(api.wsBase, page.id, luis.token);
    expect(b.text()).toBe("");
    expect(await prisma.pageCollabState.findUnique({ where: { pageId: page.id } })).toBeNull();
    await b.close(); await roomsClosed();
  });
});
