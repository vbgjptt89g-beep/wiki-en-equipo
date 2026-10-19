# CLAUDE.md — Wiki en equipo (Grupo Comidas)

Wiki interna tipo Notion para Grupo Comidas: documentación, procesos y guías organizados por departamento.

## Reparto del trabajo

| Persona | Área | Carpetas |
| --- | --- | --- |
| **A (frontend)** | Navegación, pantallas, editor por bloques, fondos, plantillas, compartir, estados de carga/error/acceso, diseño adaptable | `frontend/` (app, components, lib, styles), `assets/` |
| **B (backend)** | Datos, rutas REST, sesión y roles, permisos, publicación, subpáginas, historial, papelera, visitas, archivos | `backend/`, `shared/` |
| Ambos | Pruebas | `tests/` |

Desde el 16/10/2026, A termina todo lo que falta, también el backend (con permiso de B). Se puede modificar `backend/` y `shared/` respetando su estilo: rutas y validación con Zod en `api/routes.ts`, lógica en `services/`, permisos en `permissions/access.ts`, errores con `HttpError`, líneas compactas y mensajes en español.

## Reglas

- Textos de la interfaz en español, claros y en el tono de la empresa.
- Imágenes siempre con `next/image`; dominios en `frontend/next.config.ts`.
- Todo debe verse bien en celular, tablet y escritorio.
- Cada pantalla nueva: estado de carga, error, vacío y acceso denegado, y un título claro (`metadata` o `generateMetadata`; formato "<Página> | Wiki Grupo Comidas").
- Los permisos del frontend (`frontend/lib/permissions.ts`) solo muestran u ocultan botones; **decide el backend**.
- Cambios en el backend: actualizar `shared/types`, agregar pruebas en `tests/backend/` (sobre todo de permisos), migración de Prisma si cambia la base y actualizar el seed (`frontend/scripts/seed-dev.mjs` y las plantillas de `POST /api/auth/bootstrap`).
- Mantener el estilo visual de `frontend/styles/globals.css`, con los colores del logo: `brand` `#e2001a` (rojo; para texto, `brand-strong` `#b30015`), `sun` `#fddb00` (amarillo: **solo fondo o detalle, nunca texto**; texto sobre amarillo en `ink` y, si hace falta un amarillo legible, `sun-ink`), `ink` (negro), `sky` `#1f5fae` (enlaces, mensajes de éxito y detalles), además de paper, surface, muted, line y danger. Bricolage Grotesque para títulos y Figtree para texto. `tests/frontend/colores.test.ts` comprueba los tonos, que no vuelva el verde y el contraste AA.
- Nunca subir contraseñas, claves ni `.env`.
- Nunca commit/push/merge a `main` ni force push. Se trabaja en ramas y se abre un PR.
- Commits: `feat(frontend|backend): ...`, `fix(...): ...`, `docs: ...`, `test(...): ...`.
- Antes de cada push: `npm run build` + pruebas del frontend y `corepack pnpm test` del backend. No avanzar si no compila.
- Casos que siempre hay que comprobar: otro usuario **no** puede abrir una página privada; quien solo tiene **lectura no** puede editar.
- `docs/` no tiene reglas propias de GitHub.

## Requisitos funcionales (resumen)

- Páginas privadas por defecto. Se comparten en lectura o edición (modal), por enlace o invitando a un usuario. Se publican al departamento (cualquier usuario) o a la empresa (solo administradores).
- Contenido: texto con formato, imágenes, videos embebidos, enlaces externos (siempre con icono), enlaces a otras páginas, tablas, subpáginas. Fondos: Unsplash, degradados, colores, patrones de emojis. Etiquetas para filtrar.
- Editor por bloques arrastrables (BlockNote), edición simultánea (Yjs) y modo sin conexión (y-indexeddb) con conflictos.
- Plantillas propias (privadas/departamento/empresa) y por defecto de alta calidad; un administrador agrega o retira las predeterminadas.
- Muros: empresa (público) y departamento (solo miembros o administrador) con destacadas y más visitadas.
- Roles: `USER` (crea y publica en su departamento), `DEPARTMENT_ADMIN` (además edita el muro de su departamento), `ADMIN` (gestiona usuarios y permisos; lee todo lo público y todos los muros). Todos pertenecen a un departamento.
- Extras: subpáginas, historial, visitas (solo páginas públicas), papelera restaurable, límites de subida.

## Estado actual (19/10/2026)

En `main`: los PR #1, #2, #15, #16, #17 (usuarios de prueba y colores del logo), #18 (latido en `/realtime`), #19 (Turso y archivos en la base) y #20 (Back4App, ya retirado). Los issues #3 a #13 están cerrados.

**Despliegue: todo gratis y sin tarjeta (decisión del equipo; nunca planes de pago ni tarjeta).** Frontend y backend viven en Vercel; la base, en Turso.

- **Frontend:** Vercel, proyecto `wiki-en-equipo`, https://wiki-en-equipo.vercel.app.
- **Backend:** Vercel, proyecto `wiki-en-equipo-backend`, raíz `backend`, `backend/vercel.json` (`framework: express`, `buildCommand: pnpm run vercel-build`, región `iad1`, Cron diario). Express usa `src/app.ts` como exportación por defecto.
  - Variables en Production: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `FRONTEND_ORIGIN`, `JWT_SECRET`, `BOOTSTRAP_SECRET`, `PROXY_SECRET`, `CRON_SECRET`, `FILE_STORAGE=database`, `TRUST_PROXY=false`, `MAX_UPLOAD_BYTES=4194304`.
  - Las migraciones se aplican **al compilar** (`vercel-build` → `models/deploy-turso.ts --opcional --mantenimiento`), no en cada petición. Sin `TURSO_DATABASE_URL` (vistas previas) no hace nada.
  - Retirado Back4App Containers (y antes Render): único servicio gratis que publicaba un contenedor; se abandonó para tener las dos partes en Vercel, con una sola CLI y sin Docker. **El `backend/Dockerfile` ya no existe.**
- **Base:** Turso. Prisma usa `@prisma/adapter-libsql` si hay `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`; si no, el archivo de `DATABASE_URL` (local y pruebas, sin internet). `binaryTargets` incluye `rhel-openssl-3.0.x` para las funciones de Vercel.
  - `backend/models/migrate-turso.ts` aplica las migraciones que falten, cada una en una transacción con su registro en `_prisma_migrations`, y nunca borra. A mano: `pnpm run db:deploy:turso`.
- **Archivos:** `FILE_STORAGE` = `disk` | `database` (tabla `FileBlob`; por defecto `database` con Turso). Las funciones de Vercel no conservan disco. Límite de 4 MB.
- **Edición en vivo:** en local, WebSockets (`/collab`, `/realtime`). En producción, **consultas periódicas por HTTP** (`POST /api/collab/:pageId`, `frontend/lib/collab/http-provider.ts`), porque las funciones de Vercel no comparten memoria entre instancias. El ritmo se eligió según el plan Hobby: 5 s con actividad, 20 s / 60 s en reposo y en pausa tras 30 min o con la pestaña oculta (ver `docs/limites-vercel-hobby.md`).
- **IP real del login:** Vercel reescribe `X-Forwarded-For`, así que el servidor de Next manda la IP en `X-Wiki-Client-Ip` firmada con `PROXY_SECRET` (`TRUST_PROXY=false`).
- **Retención de la papelera:** Vercel Cron llama una vez al día a `/api/cron/papelera` con `CRON_SECRET`.
- El frontend tiene `maxDuration = 60` (layout raíz y `/archivos`) para esperar al backend mientras arranca.
- Inicio de sesión: fondo blanco cálido (`paper`) y tarjeta blanca pura con borde y sombra, sin rojo ni la curva amarilla (decisión del equipo).

Pruebas: backend 171 (`cd backend && corepack pnpm test`), las mismas con el adaptador de Turso (`corepack pnpm run test:turso`), y frontend 75+, de ellas las de integración contra el backend con el seed (`cd frontend && npm test`). `tests/backend/despliegue.test.ts` vigila `backend/vercel.json`. Los dos builds compilan. `npm audit` y `pnpm audit`: 0 vulnerabilidades.

**Producción, pendiente:** crear la base en Turso y el proyecto del backend en Vercel (pasos en el README, "Despliegue"), configurar el frontend (`BACKEND_URL`, `NEXT_PUBLIC_COLLAB_URL`, `NEXT_PUBLIC_MAX_UPLOAD_MB=4`, `PROXY_SECRET`) y crear los usuarios con el script de PowerShell (`scripts/crear-usuarios.ps1`). **Nunca reiniciar la base de producción ni correr `npm run seed` contra ella.**

Correo de los commits: la cuenta de GitHub bloquea los push que muestran el Gmail; en este repo `user.email` es el `noreply` de GitHub (`206388899+carlos388mendoza@users.noreply.github.com`).

## Decisiones tomadas

- **Cerrar sesión (opción a):** se borra todo lo que la wiki guardó en el dispositivo (IndexedDB de páginas y borradores, caché de páginas del service worker, `wiki-ultimo-usuario`). Si hay cambios sin subir, se listan y se pide confirmación (`components/auth/LogoutButton.tsx`, `lib/collab/local-data.ts`).
- **Iconos:** columna `icon` en páginas, plantillas y departamentos (antes iba dentro de `background`; la migración los copió y el frontend sigue leyendo los viejos). Valores: emoji, `lucide:<nombre>:<tono>`, `3d:<nombre>` (3dicons, CC0, en `assets/templates/3dicons/`) o `marca:grupo-comidas` (el logo). Todo se dibuja con `components/ui/PageIcon.tsx`.
- **Logo:** original en `assets/brand/` (con `LEEME.md`), copia de 512 px en `frontend/public/brand/`, componente `components/ui/BrandLogo.tsx` (next/image). Favicon con la convención de Next: `app/icon.png` (32), `app/icon1.png` (192) con las esquinas transparentes y `app/apple-icon.png` (180) con fondo blanco porque iOS pinta de negro lo transparente. `app/manifest.ts` (192 y 512). El service worker los guarda.
- **Editor:** BlockNote (construido sobre TipTap).
- **Sesión:** cookie httpOnly `wiki_token`; el navegador solo recibe el token para los WebSockets.
- **Edición en vivo:** en local, servidor Yjs del backend (`/collab`). El frontend usa `ws://<host>:4000/collab` si no se define `NEXT_PUBLIC_COLLAB_URL` (`off` lo desactiva y se usan los avisos de `/realtime`). En **producción** (Vercel) `NEXT_PUBLIC_COLLAB_URL` apunta a `https://<backend>/api/collab` y se usan consultas periódicas por HTTP (`frontend/lib/collab/http-provider.ts`), sin WebSockets. Se quitó el servidor de desarrollo `collab:dev`.
- **Visitas:** solo `POST /api/pages/:id/visit` desde la vista de lectura (`components/page/VisitCounter.tsx`), una vez cada 30 minutos por persona y solo en páginas públicas.
- **Retención de la papelera:** 30 días (`TRASH_RETENTION_DAYS`; `0` la desactiva).
- **Directorio:** solo id, nombre y departamento; mínimo 2 letras, máximo 20 resultados; busca por nombre sin tildes o por correo completo exacto.

## Backend (lo que hay que saber)

Node 20+, Express 5, Prisma + SQLite (en producción Turso con `@prisma/adapter-libsql`), Zod, JWT, Yjs 13 (y-protocols). Gestor: **pnpm** (vía `corepack pnpm`, desde la carpeta `backend/`: desde la raíz corepack usa otra versión). Detalle de rutas y permisos en `backend/README.md`.

### Correrlo en local

```bash
cd backend
corepack pnpm install
cp .env.example .env        # poner JWT_SECRET (>= 32 caracteres) y BOOTSTRAP_SECRET aleatorios
corepack pnpm run db:generate
corepack pnpm run db:deploy # aplica las migraciones
corepack pnpm run dev       # http://localhost:4000 y ws://localhost:4000/collab
corepack pnpm test          # pruebas en ../tests/backend (base aparte: models/test.db)
corepack pnpm run test:turso # las mismas, con el adaptador de Turso (libSQL) sobre un archivo local
```

Datos de prueba: `cd frontend && npm run seed` (con la base vacía). Usuarios fijos en `frontend/scripts/seed-users.mjs` (tabla en el README), todos con la contraseña `12345abc` (decisión del equipo; el backend pide mínimo 8 caracteres): Administrador `adminwiki@grupocomidas.com` (ADMIN, Tecnología), Admin Contabilidad `contabilidadwiki@grupocomidas.com` (DEPARTMENT_ADMIN, Contabilidad), Usuario Tecnología `tecnologiawiki@grupocomidas.com` (USER, Tecnología), Usuario Compras `compraswiki@grupocomidas.com` (USER, Compras). Ya no existe `.dev-users.local.json`: las pruebas de integración usan esos usuarios y buscan las páginas por título. El seed también crea la plantilla "Visita técnica a sucursal" de Usuario Tecnología, compartida con Usuario Compras (lectura) y Admin Contabilidad (edición), y las destacadas de la empresa. Las pruebas del backend crean sus propias personas ficticias (Ana, Luis, María… con `@wiki.test`), independientes del seed.

Para empezar de cero: detener el backend, borrar `backend/models/dev.db` y `backend/uploads/`, `corepack pnpm run db:deploy`, arrancar y correr `npm run seed`.

### Frontend en local

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
npm test             # pruebas; las de integración necesitan el backend y el seed
npm run build && npm start   # producción (aquí se activa el service worker / modo sin conexión)
```

Para probar la edición en vivo con dos personas en el mismo navegador: una sesión en `http://localhost:3000` y otra en `http://127.0.0.1:3000` (las cookies son por host) y, solo en el `.env` local del backend, `COLLAB_ALLOWED_ORIGINS="http://127.0.0.1:3000"`.

## Problemas conocidos

- **OneDrive y `.next`:** el repo está dentro de OneDrive; a veces Next falla con `EINVAL: readlink …\.next\…`. Solución: borrar `frontend/.next` y volver a arrancar.
- **No correr `npm run build` con `npm run dev` abierto:** comparten `.next`.
- **Cambiar de rama con los servidores de desarrollo abiertos** rompe Next: detenerlos antes. En la rama `backend-pendientes` no hay `.gitignore` en la raíz: no agregar `frontend/node_modules` ni `.next` por error.
- **Límite de inicios de sesión:** cuenta solo intentos fallidos (10 por cuenta e IP, 50 por IP, 30 por cuenta). Las pruebas reutilizan los tokens del seed; si se agota, reiniciar el backend (el contador vive en memoria).
- **Service worker:** solo se registra en producción (o con `NEXT_PUBLIC_ENABLE_SW=1`).
- **Lanzar servidores desde Claude Code:** `.claude/launch.json` (local, no se sube) usa `cmd /c "cd backend && corepack pnpm run dev"` por el punto anterior de corepack.

## Pendientes del backend

Solo queda "varias instancias del backend" (baja prioridad, infraestructura): `frontend/PENDIENTES_BACKEND.md`.

### Sesión

- `POST /api/auth/login {email, password}` → `{ user, token }`. JWT de 8 h. Peticiones autenticadas con `Authorization: Bearer <token>`. El frontend envía la IP real en `X-Forwarded-For` (la última de la lista) y el backend confía en ella con `TRUST_PROXY` (por defecto `loopback`).
- `GET /api/auth/me` → `{ user: { id, name, email, role, departmentId, department: { name, slug } } }`.
- No hay registro público: los usuarios los crea un ADMIN (`POST /api/users`). El primer ADMIN se crea una sola vez con `POST /api/auth/bootstrap` (necesita `BOOTSTRAP_SECRET`).
- Cambiar la contraseña invalida las sesiones (`sessionVersion`), también las conexiones en vivo.

### Formato de errores

`{ "error": { "code": string, "message": string, "details"?: unknown } }`. Códigos: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `BAD_REQUEST`/`VALIDATION_ERROR` (400), `CONFLICT`/`ALREADY_EXISTS` (409), `FILE_TOO_LARGE` (413), `UNSUPPORTED_FILE_TYPE` (415), `TOO_MANY_REQUESTS` (429), `INTERNAL_ERROR` (500). El frontend los traduce a `ApiError` en `frontend/lib/api/client.ts`.

### Tipos (`shared/types/index.ts`)

Enumerados (`UserRole`, `PageVisibility`, `PagePermission`, `TemplateScope`, `MyPermission`), `PageBlock` (con list, quote, divider, subpage, code), `PageSummary`, `PageListItem`, `PageDetail`, `ShareEntry`, `ShareLinkSummary`, `CreatedShareLink`, `ShareAcceptResult`, `DirectoryUser`, `DepartmentSummary`, `TemplateListItem`, `TemplateDetail`, `VisitResult`, `ApiError`. El frontend los importa con `import type` desde `@shared/types`.

### Rutas nuevas (resumen; todas en `backend/README.md`)

| Ruta | Notas |
| --- | --- |
| `GET /api/users/directory?q=&limit=` | Cualquier usuario; solo id, nombre y departamento |
| `GET /api/users?includeInactive=1` | ADMIN |
| `POST /api/pages/:id/visit` | Visitas (`GET` ya no cuenta) |
| `GET /api/pages?q=` | Título y contenido; `match` y `excerpt` |
| `GET /api/pages/:id/share-links` | Enlaces activos (sin token) |
| `DELETE /api/pages/:id/permanent`, `DELETE /api/pages/trash` | Papelera definitiva |
| `PUT/DELETE /api/templates/:id/shares/:userId`, `GET/POST /api/templates/:id/share-links`, `DELETE .../share-links/:linkId` | Compartir plantillas |
| `POST /api/share/:token/accept` | Páginas y plantillas: `{ type, pageId | templateId, permission }` |
| `GET/PUT /api/company/featured` | Destacadas de la empresa |
| `GET /api/departments/:idOrSlug`, `PATCH /api/departments/:id` | 403/404, descripción e icono |
| `PATCH /api/pages/:id` con `autosave: true` | Agrupa versiones del historial (10 min) |
| WebSocket `/collab/pagina-<id>?token=` | Yjs en vivo; cierra con 4403 (sin acceso) o 4409 (contenido reemplazado) |

### Permisos del backend (`backend/permissions/access.ts`)

- Páginas. Leer: ADMIN; dueño; compartida; muro de su departamento; `COMPANY`; `DEPARTMENT` del mismo departamento. Editar: ADMIN; dueño; compartida con `EDIT`; muro del propio departamento si es `DEPARTMENT_ADMIN`. Compartir = editar. Publicar a `COMPANY` solo ADMIN. Papelera, restaurar y eliminar definitivamente: dueño o ADMIN.
- Plantillas. Leer: ADMIN, empresa, su departamento, dueño o compartida. Editar y compartir: ADMIN, dueño o `EDIT`. Alcance y eliminar: dueño o ADMIN.

### Cómo se guardan los bloques y el fondo

- `content`: arreglo de bloques `{ id, type, data }` (`PageBlock`). El editor BlockNote convierte desde y hacia este formato (`frontend/lib/editor/convert.ts`).
- `background`: `{ type: "color" | "gradient" | "image" | "pattern" | "shapes", ... }` o `{ type: "none" }`. El icono va en su propio campo `icon`.

## Frontend

Next.js 15.5 (App Router) + React 19 + Tailwind CSS 4 + lucide-react + TypeScript + BlockNote 0.55 (Mantine) + Yjs 13. Detalle de carpetas, variables y demostración en `frontend/README.md`.

- `app/(wiki)/…` pantallas con sesión; `app/login` ("Acceso"); `app/share/[token]` acepta enlaces de páginas y plantillas; `app/sin-conexion` borradores offline; `app/not-found.tsx` 404 en español.
- `lib/api/` única capa de lecturas (`{ ok: true, data } | { ok: false, error, message }`); escrituras en `app/actions/*` (server actions). `lib/session.ts` sesión real; `lib/permissions.ts` reglas de visibilidad de botones.
- Compartir: `components/pages/ShareDialog.tsx` sirve para páginas y plantillas (visibilidad o alcance, invitar con buscador, personas con acceso, enlaces activos).
- Editor: `components/editor/PageEditor.tsx` (autoguardado con `expectedVersion` y `autosave`, conflictos, copia Yjs local) + `BlockEditor.tsx` (BlockNote con `withCollaboration`). Tiempo real: `lib/collab/useCollaboration.ts`.
- Pruebas: `npm test` (Vitest, en `tests/frontend/`). Los paquetes que importan directo (`yjs`, `y-indexeddb`, `fake-indexeddb`) necesitan alias en `frontend/vitest.config.mts`; lo mismo en `backend/vitest.config.mts` (Yjs apunta a su versión ESM para no cargarse dos veces).
- Seguridad ya cubierta: rutas internas validadas con `isInternalPath` (`lib/blocks.ts`), degradados sin `url()`, `/archivos` fuera del middleware (Next corta cuerpos de más de 10 MB), IP real en el login.
