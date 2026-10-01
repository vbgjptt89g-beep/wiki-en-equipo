import { prisma } from "../models/client.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signAccessToken } from "../auth/token.js";
import { badRequest, conflict, forbidden, unauthorized } from "./errors.js";

const publicUser = (user: { id: string; name: string; email: string; role: string; departmentId: string; department?: { id: string; name: string; slug: string } }) => ({
  id: user.id, name: user.name, email: user.email, role: user.role,
  departmentId: user.departmentId, department: user.department,
});

export async function bootstrapAdmin(input: { name: string; email: string; password: string; departmentName: string; secret: string }) {
  const bootstrapSecret = process.env.BOOTSTRAP_SECRET;
  if (!bootstrapSecret || input.secret !== bootstrapSecret) throw forbidden("La clave de configuración inicial no es válida.");
  if (await prisma.user.count() !== 0) throw conflict("La configuración inicial ya fue completada.");
  const email = input.email.trim().toLowerCase();
  const slug = input.departmentName.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw badRequest("El nombre del departamento no es válido.");
  const result = await prisma.$transaction(async (tx) => {
    const department = await tx.department.create({ data: { name: input.departmentName.trim(), slug } });
    const user = await tx.user.create({ data: { name: input.name.trim(), email, passwordHash: await hashPassword(input.password), role: "ADMIN", departmentId: department.id }, include: { department: true } });
    const defaults = [
      {
        title: "Documentación de proceso", description: "Estructura clara para documentar un proceso de trabajo.", scope: "COMPANY", isDefault: true,
        contentJson: JSON.stringify([
          { id: "purpose", type: "heading", data: { level: 1, text: "Propósito y alcance" } },
          { id: "summary", type: "paragraph", data: { text: "Explica qué resuelve este proceso, a quién aplica y cuándo debe utilizarse." } },
          { id: "owner", type: "callout", data: { title: "Responsable", text: "Nombre del equipo o persona responsable y canal de contacto." } },
          { id: "steps", type: "heading", data: { level: 2, text: "Pasos del proceso" } },
          { id: "steps-body", type: "paragraph", data: { text: "1. Describe el primer paso.\n2. Describe el siguiente paso.\n3. Indica cómo confirmar que el proceso terminó correctamente." } },
          { id: "exceptions", type: "heading", data: { level: 2, text: "Excepciones y ayuda" } },
          { id: "exceptions-body", type: "paragraph", data: { text: "Documenta casos especiales, riesgos conocidos y a quién contactar si algo falla." } },
          { id: "review", type: "paragraph", data: { text: "Última revisión: agrega fecha, responsable y enlace a la fuente relacionada." } },
        ]), backgroundJson: JSON.stringify({ type: "gradient", value: "linear-gradient(135deg, #eef6ff 0%, #f7f3ff 100%)" }), ownerId: user.id,
      },
      {
        title: "Bienvenida al departamento", description: "Guía de bienvenida con contactos, herramientas y primeros pasos.", scope: "COMPANY", isDefault: true,
        contentJson: JSON.stringify([
          { id: "welcome", type: "heading", data: { level: 1, text: "¡Bienvenido/a al equipo!" } },
          { id: "intro", type: "paragraph", data: { text: "Presenta qué hace el departamento y cómo su trabajo apoya a Grupo Comidas." } },
          { id: "people", type: "heading", data: { level: 2, text: "Personas y contactos" } },
          { id: "contacts", type: "table", data: { columns: ["Tema", "Contacto", "Canal"], rows: [["Liderazgo", "Nombre", "Enlace"], ["Soporte", "Nombre", "Enlace"]] } },
          { id: "tools", type: "heading", data: { level: 2, text: "Herramientas y accesos" } },
          { id: "tools-body", type: "paragraph", data: { text: "Incluye los sistemas que utiliza el equipo y dónde solicitar acceso. No escribas contraseñas aquí." } },
          { id: "first-weeks", type: "heading", data: { level: 2, text: "Tus primeras semanas" } },
          { id: "checklist", type: "paragraph", data: { text: "□ Completar la orientación\n□ Conocer los procesos principales\n□ Agendar una reunión con el equipo\n□ Leer la documentación recomendada" } },
        ]), backgroundJson: JSON.stringify({ type: "gradient", value: "linear-gradient(135deg, #e7f7f0 0%, #eef6ff 100%)" }), ownerId: user.id,
      },
      {
        title: "Inicio del departamento", description: "Base para crear el muro con prioridades, enlaces y páginas destacadas.", scope: "COMPANY", isDefault: true,
        contentJson: JSON.stringify([
          { id: "overview", type: "heading", data: { level: 1, text: "Departamento: visión general" } },
          { id: "mission", type: "callout", data: { title: "Nuestra misión", text: "Resume en una o dos frases el propósito del departamento." } },
          { id: "priorities", type: "heading", data: { level: 2, text: "Prioridades actuales" } },
          { id: "priorities-body", type: "paragraph", data: { text: "Indica los objetivos del periodo, las personas responsables y enlaces al seguimiento." } },
          { id: "resources", type: "heading", data: { level: 2, text: "Recursos del equipo" } },
          { id: "resources-body", type: "paragraph", data: { text: "Agrega enlaces a procesos frecuentes, herramientas, calendarios y canales de comunicación." } },
          { id: "updates", type: "heading", data: { level: 2, text: "Novedades" } },
          { id: "updates-body", type: "paragraph", data: { text: "Publica anuncios y cambios importantes. Mantén aquí solo información vigente." } },
        ]), backgroundJson: JSON.stringify({ type: "gradient", value: "linear-gradient(135deg, #fff4df 0%, #fff0ed 100%)" }), ownerId: user.id,
      },
    ];
    await tx.template.createMany({ data: defaults });
    return user;
  });
  return { user: publicUser(result), token: signAccessToken({ sub: result.id, role: "ADMIN", departmentId: result.departmentId, sessionVersion: result.sessionVersion }) };
}

export async function login(emailInput: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: emailInput.trim().toLowerCase() }, include: { department: true } });
  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) throw unauthorized("Correo o contraseña incorrectos.");
  return { user: publicUser(user), token: signAccessToken({ sub: user.id, role: user.role as "USER" | "DEPARTMENT_ADMIN" | "ADMIN", departmentId: user.departmentId, sessionVersion: user.sessionVersion }) };
}

export async function createUser(input: { name: string; email: string; password: string; role: string; departmentId: string }) {
  if (!await prisma.department.findUnique({ where: { id: input.departmentId } })) throw badRequest("El departamento indicado no existe.");
  const user = await prisma.user.create({ data: { name: input.name.trim(), email: input.email.trim().toLowerCase(), passwordHash: await hashPassword(input.password), role: input.role, departmentId: input.departmentId }, include: { department: true } });
  return publicUser(user);
}

export async function listUsers() {
  return prisma.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, role: true, departmentId: true, department: { select: { name: true, slug: true } } } });
}

export async function updateUser(id: string, patch: { name?: string; role?: string; departmentId?: string; active?: boolean }) {
  if (patch.departmentId && !await prisma.department.findUnique({ where: { id: patch.departmentId } })) throw badRequest("El departamento indicado no existe.");
  const current = await prisma.user.findUnique({ where: { id } });
  if (!current) throw badRequest("No se encontró el usuario.");
  if (current.role === "ADMIN" && ((patch.role && patch.role !== "ADMIN") || patch.active === false)) {
    const activeAdmins = await prisma.user.count({ where: { role: "ADMIN", active: true } });
    if (activeAdmins <= 1) throw conflict("Debe quedar al menos un administrador activo.");
  }
  return prisma.user.update({ where: { id }, data: patch, select: { id: true, name: true, email: true, role: true, departmentId: true, active: true } });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) throw unauthorized("La contraseña actual es incorrecta.");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword), sessionVersion: { increment: 1 } } });
}
