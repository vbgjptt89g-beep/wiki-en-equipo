import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const path = (file: string) => new URL(`../../${file}`, import.meta.url);
const read = (file: string) => readFileSync(path(file), "utf8").replace(/\r\n/g, "\n");
const vercel = JSON.parse(read("backend/vercel.json")) as { framework?: string; buildCommand?: string; regions?: string[]; crons?: { path: string; schedule: string }[] };
const scripts = (JSON.parse(read("backend/package.json")) as { scripts: Record<string, string> }).scripts;

describe("backend en Vercel (Express) + Turso", () => {
  it("es un proyecto Express cuya entrada es src/app.ts con la app como exportación por defecto", () => {
    expect(vercel.framework).toBe("express");
    expect(read("backend/src/app.ts")).toMatch(/^export default app;$/m);
    // Vercel convierte cada archivo de api/ en una función aparte: el backend ya no usa esa carpeta.
    expect(existsSync(path("backend/api"))).toBe(false);
  });

  it("aplica las migraciones al compilar, no en cada petición, y se salta sin Turso (vistas previas)", () => {
    expect(vercel.buildCommand).toBe("pnpm run vercel-build");
    expect(scripts["vercel-build"]).toMatch(/prisma generate/);
    expect(scripts["vercel-build"]).toMatch(/deploy-turso\.ts --opcional/);
    expect(read("backend/models/schema.prisma")).toMatch(/binaryTargets\s*=\s*\[[^\]]*"rhel-openssl-3\.0\.x"/);
  });

  it("limpia la papelera con Vercel Cron una vez al día (lo máximo en Hobby)", () => {
    expect(vercel.crons).toEqual([{ path: "/api/cron/papelera", schedule: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
    expect(vercel.regions).toEqual(["iad1"]);
  });

  it("no hay secretos en la configuración", () => {
    const config = read("backend/vercel.json") + read("frontend/.env.example") + read("backend/.env.example");
    expect(config).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // tokens JWT (Turso)
    expect(config).not.toMatch(/libsql:\/\/[a-z0-9-]+-[a-z0-9-]+\.turso\.io/i);
  });

  it("el frontend espera hasta 60 s a que el backend responda", () => {
    for (const file of ["frontend/app/layout.tsx", "frontend/app/archivos/route.ts", "frontend/app/archivos/[id]/route.ts"]) {
      expect(read(file), file).toMatch(/export const maxDuration = 60;/);
    }
  });
});
