/**
 * Edición en vivo por HTTP (como en Vercel) con el proveedor real del navegador contra el backend local y los
 * usuarios de `npm run seed`. Se omite si el backend no está en marcha o no tiene los datos del seed.
 */
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { backend, BACKEND_URL } from "../../frontend/lib/api/client";
import { CLOSE_CODES, HttpCollabProvider } from "../../frontend/lib/collab/http-provider";
import { SEED_PASSWORD, SEED_USERS } from "../../frontend/scripts/seed-users.mjs";

type Key = keyof typeof SEED_USERS;
const backendUp = await fetch(`${BACKEND_URL}/health`).then((r) => r.ok).catch(() => false);
const tokens: Partial<Record<Key, string>> = {};
async function tokenOf(key: Key) {
  if (tokens[key]) return tokens[key]!;
  const res = await backend<{ token: string }>("/auth/login", { method: "POST", body: { email: SEED_USERS[key].email, password: SEED_PASSWORD }, token: null });
  if (!res.ok) throw new Error(res.message);
  return (tokens[key] = res.data.token);
}
const ready = backendUp && (await tokenOf("tecnologia").then(() => true, () => false));
const url = `${BACKEND_URL}/api/collab`;

const providers: HttpCollabProvider[] = [];
afterEach(() => { for (const p of providers.splice(0)) p.destroy(); });
async function open(key: Key, pageId: string) {
  const token = await tokenOf(key);
  const provider = new HttpCollabProvider(url, pageId, new Y.Doc(), { token, getToken: async () => token });
  providers.push(provider);
  return provider;
}
const waitFor = async (check: () => boolean, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!check()) { if (Date.now() > until) throw new Error("tiempo agotado"); await new Promise((r) => setTimeout(r, 100)); }
};
const pageIdOf = async (key: Key, title: string) => {
  const list = await backend<{ pages: { id: string; title: string }[] }>(`/pages?q=${encodeURIComponent(title)}`, { token: await tokenOf(key) });
  const id = list.ok ? list.data.pages.find((p) => p.title === title)?.id : undefined;
  if (!id) throw new Error(`No encontré "${title}"`);
  return id;
};

describe.skipIf(!ready)("edición en vivo por HTTP con el proveedor del navegador", () => {
  it("dos personas ven los cambios y la presencia de la otra", async () => {
    const created = await backend<{ page: { id: string } }>("/pages", { method: "POST", token: await tokenOf("tecnologia"), body: { title: "Prueba en vivo por HTTP", content: [] } });
    if (!created.ok) throw new Error(created.message);
    const pageId = created.data.page.id;
    const comprasId = (await backend<{ user: { id: string } }>("/auth/me", { token: await tokenOf("compras") }));
    if (!comprasId.ok) throw new Error(comprasId.message);
    await backend(`/pages/${pageId}/shares/${comprasId.data.user.id}`, { method: "PUT", token: await tokenOf("tecnologia"), body: { permission: "EDIT" } });

    const a = await open("tecnologia", pageId);
    const b = await open("compras", pageId);
    a.awareness.setLocalStateField("user", { name: "cualquier nombre", color: "#e2001a" });
    await waitFor(() => a.synced && b.synced);
    a.doc.getText("t").insert(0, "Hola desde A.");
    await waitFor(() => b.doc.getText("t").toString().includes("Hola desde A."));
    b.doc.getText("t").insert(b.doc.getText("t").length, " Y desde B.");
    await waitFor(() => a.doc.getText("t").toString().includes("Y desde B."));
    await waitFor(() => [...b.awareness.getStates().values()].some((s) => (s as { user?: { name?: string } }).user?.name === "Usuario Tecnología"));

    await backend(`/pages/${pageId}`, { method: "DELETE", token: await tokenOf("tecnologia") });
    await backend(`/pages/${pageId}/permanent`, { method: "DELETE", token: await tokenOf("tecnologia") });
  });

  it("otra persona no entra a una página privada: el proveedor se cierra con 4403", async () => {
    const provider = await open("compras", await pageIdOf("tecnologia", "Mis notas"));
    let closed = 0;
    provider.on("closed", ({ code }) => { closed = code; });
    await waitFor(() => closed !== 0);
    expect(closed).toBe(CLOSE_CODES.forbidden);
    expect(provider.synced).toBe(false);
  });

  it("quien solo puede leer recibe el documento, pero sus cambios no llegan a los demás", async () => {
    const pageId = await pageIdOf("tecnologia", "Borrador: guía de VPN");
    const owner = await open("tecnologia", pageId);
    const reader = await open("compras", pageId);
    await waitFor(() => owner.synced && reader.synced);
    expect(reader.access).toBe("read");
    reader.doc.getText("intento").insert(0, "no debería llegar");
    owner.doc.getText("marca").insert(0, `dueño ${Date.now()}`);
    await waitFor(() => reader.doc.getText("marca").length > 0);
    // Una vuelta más para que el cambio del lector, si se aceptara, llegara al dueño.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(owner.doc.getText("intento").toString()).toBe("");
  });
});
