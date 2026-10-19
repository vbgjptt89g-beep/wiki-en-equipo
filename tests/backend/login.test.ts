import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trustProxySetting } from "../../backend/src/app.js";
import { hashPassword } from "../../backend/auth/password.js";
import { createDepartment, createUser, resetDatabase, startApi, type TestApi, type TestUser } from "./helpers";

const PASSWORD = "contraseña-de-prueba-larga";
let api: TestApi;
let luis: TestUser, maria: TestUser;

beforeAll(async () => {
  await resetDatabase();
  const tecnologia = await createDepartment("Tecnología");
  const passwordHash = await hashPassword(PASSWORD);
  luis = await createUser("Luis Paz", tecnologia.id, "USER", { passwordHash });
  maria = await createUser("María Zelaya", tecnologia.id, "USER", { passwordHash });
  api = await startApi();
});
afterAll(() => api.close());

// El frontend (servidor de Next en la misma máquina) reenvía la IP real en X-Forwarded-For.
const login = (email: string, password: string, ip: string) =>
  api.call("POST", "/auth/login", { body: { email, password }, headers: { "X-Forwarded-For": ip } });

describe("límite de inicios de sesión con la IP real (trust proxy)", () => {
  it("bloquea a una persona tras 10 intentos fallidos sin afectar a las demás", async () => {
    for (let i = 0; i < 10; i++) expect((await login(luis.email, "incorrecta", "203.0.113.10")).status).toBe(401);
    expect((await login(luis.email, PASSWORD, "203.0.113.10")).status).toBe(429);
    // Otra persona en la misma oficina (misma IP) sigue entrando.
    expect((await login(maria.email, PASSWORD, "203.0.113.10")).status).toBe(200);
    // La misma cuenta desde otra IP no está bloqueada: el límite no es de toda la empresa.
    expect((await login(luis.email, PASSWORD, "198.51.100.7")).status).toBe(200);
  });

  it("los inicios de sesión correctos no cuentan para el límite", async () => {
    for (let i = 0; i < 12; i++) expect((await login(maria.email, PASSWORD, "192.0.2.44")).status).toBe(200);
  });

  it("una misma cuenta no admite más de 30 fallos aunque cambie de IP", async () => {
    const victima = await createUser("Rosa Lainez", luis.departmentId, "USER", { passwordHash: await hashPassword(PASSWORD) });
    for (let i = 0; i < 30; i++) expect((await login(victima.email, "incorrecta", `198.18.0.${i + 1}`)).status).toBe(401);
    expect((await login(victima.email, PASSWORD, "198.18.1.1")).status).toBe(429);
  }, 60_000); // 31 comprobaciones de bcrypt: en una máquina ocupada pasa de 20 s

  it("TRUST_PROXY nunca acepta `true` y entiende saltos y listas", () => {
    expect(() => trustProxySetting("true")).toThrow();
    expect(trustProxySetting("1")).toBe(1);
    expect(trustProxySetting("false")).toBe(false);
    expect(trustProxySetting("loopback, 10.0.0.5")).toBe("loopback, 10.0.0.5");
    expect(trustProxySetting(undefined)).toBe("loopback");
  });
});
