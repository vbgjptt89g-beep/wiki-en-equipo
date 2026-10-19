# Backend de Wiki en equipo

API REST en Node.js, TypeScript, Express y Prisma, con edición en vivo (Yjs) en el mismo servidor. SQLite se usa como configuración inicial para desarrollo local; antes de desplegar para varias instancias o muchos usuarios, el equipo debe elegir un motor de base de datos compartido.

## Requisitos y puesta en marcha

- Node.js 20 o superior y pnpm (`corepack pnpm`).
- Desde esta carpeta, instala dependencias con `pnpm install`.
- Copia `.env.example` a `.env`, configura `JWT_SECRET` (32 caracteres o más) y `BOOTSTRAP_SECRET` con valores aleatorios largos, y ajusta las demás variables si hace falta.
- Genera el cliente y aplica las migraciones con `pnpm run db:generate` y `pnpm run db:deploy`.
- Inicia en modo desarrollo con `pnpm run dev` (API en `http://localhost:4000` y edición en vivo en `ws://localhost:4000/collab`). En producción: `pnpm run build && pnpm start`.
- El primer administrador se crea una sola vez con `POST /api/auth/bootstrap`; envía la clave configurada como `BOOTSTRAP_SECRET`. Después del primer usuario, esa ruta queda cerrada. El proceso crea tres plantillas predeterminadas para la empresa y los departamentos, con su icono.
- Pruebas: `pnpm test` (Vitest). Viven en `../tests/backend/` y usan una base aparte (`models/test.db`) que se crea desde cero con las migraciones. `pnpm run test:turso` corre las mismas pruebas como en producción: adaptador de Turso (libSQL) sobre ese archivo y migraciones aplicadas por `models/migrate-turso.ts`, sin internet.
- Producción en Turso: con `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`, Prisma usa `@prisma/adapter-libsql` y el servidor aplica al arrancar las migraciones que falten (`prisma migrate deploy` no llega a Turso). A mano: `pnpm run db:deploy:turso`. Detalle en el README de la raíz, sección "Despliegue".

No subas `.env`, la base de datos ni los archivos cargados al repositorio.

### Variables de entorno

| Variable | Uso |
| --- | --- |
| `DATABASE_URL`, `PORT`, `UPLOAD_DIR`, `MAX_UPLOAD_BYTES`, `MAX_UPLOADS_PER_USER` | Base de datos, puerto y archivos |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Producción en Turso (vacías en local) |
| `FILE_STORAGE` | `disk` (`UPLOAD_DIR`) o `database` (tabla `FileBlob`); sin definir, `database` con Turso y `disk` sin él |
| `JWT_SECRET`, `BOOTSTRAP_SECRET` | Secretos (nunca en el repositorio) |
| `FRONTEND_ORIGIN` | Dirección del frontend: CORS, enlaces compartidos y orígenes permitidos para la edición en vivo |
| `TRUST_PROXY` | Proxies que pueden informar la IP real (`loopback` por defecto, un número de saltos o una lista de IP). Nunca `true` |
| `TRASH_RETENTION_DAYS` | Días en la papelera antes de borrarse para siempre (30; `0` lo desactiva) |
| `COLLAB_ALLOWED_ORIGINS`, `COLLAB_SAVE_DELAY_MS`, `COLLAB_MAX_CLIENTS_PER_PAGE`, `COLLAB_MAX_CONNECTIONS_PER_USER` | Edición en vivo (opcionales) |

## Acceso

La API devuelve un token JWT de ocho horas. En cada petición autenticada envía `Authorization: Bearer <token>`. El inicio de sesión no está abierto al público: un administrador debe crear los usuarios.

Roles: `USER`, `DEPARTMENT_ADMIN` y `ADMIN`. Los usuarios siempre pertenecen a un departamento.

El inicio de sesión cuenta solo los intentos fallidos: 10 por cuenta desde la misma IP y 50 por IP cada 15 minutos. Como el frontend inicia sesión desde su servidor, el backend usa la IP real que este reenvía en `X-Forwarded-For` (`TRUST_PROXY`).

## Rutas principales

| Método y ruta | Uso |
| --- | --- |
| `POST /api/auth/bootstrap` | Crear el primer administrador y su departamento |
| `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/password` | Sesión y cuenta |
| `GET/POST /api/departments`, `GET /api/departments/:idOrSlug`, `PATCH /api/departments/:id` | Departamentos con descripción e icono (403 si no es tu departamento, 404 si no existe) |
| `PUT/DELETE /api/departments/:id/wall`, `GET/PUT /api/departments/:id/featured` | Muro y destacadas del departamento |
| `GET/PUT/DELETE /api/company/wall`, `GET/PUT /api/company/featured` | Muro y destacadas de la empresa (cambiarlos: solo administradores) |
| `GET /api/users/directory?q=&limit=` | Buscar personas para invitar (cualquier usuario): solo id, nombre y departamento; máximo 20 |
| `GET/POST /api/users`, `PATCH /api/users/:userId` | Usuarios; solo administradores (`?includeInactive=1` incluye cuentas desactivadas) |
| `GET/POST /api/pages`, `GET/PATCH/DELETE /api/pages/:pageId` | Consultar, buscar (`?q=` en título y contenido), crear, editar y enviar a la papelera |
| `POST /api/pages/:pageId/visit` | Registrar una visita (solo la vista de lectura; páginas públicas; una cada 30 min por persona) |
| `GET /api/pages/popular`, `GET /api/pages/trash`, `POST /api/pages/:pageId/restore` | Más visitadas, papelera y restaurar |
| `DELETE /api/pages/:pageId/permanent`, `DELETE /api/pages/trash` | Eliminar definitivamente y vaciar la papelera propia |
| `GET /api/pages/:pageId/history`, `POST /api/pages/:pageId/history/:version/restore` | Historial y restauración de versiones |
| `PUT/DELETE /api/pages/:pageId/shares/:userId` | Compartir con una persona |
| `GET/POST /api/pages/:pageId/share-links`, `DELETE /api/pages/:pageId/share-links/:linkId` | Enlaces: listar los activos, crear y desactivar |
| `POST /api/share/:token/accept` | Aceptar un enlace de página o de plantilla (nunca baja un permiso que ya se tenía) |
| `GET/POST /api/templates`, `GET/PATCH/DELETE /api/templates/:templateId` | Plantillas personales, compartidas, de departamento y de empresa |
| `PUT/DELETE /api/templates/:id/shares/:userId`, `GET/POST /api/templates/:id/share-links`, `DELETE .../share-links/:linkId` | Compartir plantillas igual que las páginas |
| `POST /api/pages/from-template/:templateId` | Crear una página desde una plantilla (copia sus archivos) |
| `POST /api/files` (`pageId` o `templateId`), `GET /api/files/:fileId/content`, `DELETE /api/files/:fileId` | Archivos con límite de tamaño y tipos permitidos |
| `POST /api/sync/pages/:pageId` | Sincronización optimista por versión; devuelve `409` con la versión actual ante conflictos |
| WebSocket `/collab/pagina-<pageId>?token=` | Edición en vivo (Yjs) con presencia (local) |
| `POST /api/collab/:pageId` | Edición en vivo por HTTP (producción en Vercel, sin WebSockets) |
| WebSocket `/realtime` | Avisos de cambios a participantes autorizados |

Todas las rutas salvo `/health`, inicio de sesión y configuración inicial requieren autenticación. Las páginas son privadas por defecto. Los cambios incrementan `version` y guardan la versión anterior; `PATCH /api/pages/:pageId` requiere `expectedVersion`. Con `autosave: true`, los autoguardados de la misma persona en menos de 10 minutos no crean otra versión del historial. Las sesiones se invalidan al cambiar la contraseña y las cuentas inactivas pierden acceso inmediatamente.

Los listados de páginas (`GET /api/pages`, destacadas y más visitadas) traen `icon`, `backgroundJson`, `owner` y `myPermission` (`OWNER`, `EDIT`, `READ` o `null` si se ve por estar publicada o por ser administrador). `GET /api/pages/:id` trae además las personas con acceso con su nombre, la ruta de páginas superiores (`ancestors`) y `visitCount`. Los tipos de las respuestas están en `../shared/types`.

Las páginas aceptan `content` como JSON serializable de bloques y `background` como JSON serializable; el formato de bloques está en `shared/types` (`PageBlock`).

## Permisos

Están en `permissions/access.ts`:

- **Páginas.** Leer: ADMIN, dueño, compartida, muro de su departamento, publicadas a la empresa o a su departamento. Editar: ADMIN, dueño, compartida con `EDIT`, muro de su departamento si es `DEPARTMENT_ADMIN`. Compartir = editar. Publicar a la empresa: solo ADMIN.
- **Plantillas.** Leer y usar: ADMIN, empresa, su departamento, dueño o compartida. Editar el contenido y compartir: ADMIN, dueño o compartida con `EDIT`. Cambiar el alcance, marcarla como predeterminada o eliminarla: dueño o ADMIN (predeterminada, solo ADMIN).
- **Archivos.** Los ve quien puede leer su página o su plantilla; uno suelto, solo quien lo subió.

## Edición en vivo (Yjs)

`realtime/collab.ts` implementa el protocolo y-websocket con Yjs v13 (compatible con BlockNote y con `WebsocketProvider` de `y-websocket`). La sala de cada página es `pagina-<pageId>` y el token va en `?token=`. Es lo que se usa en local.

- Valida la sesión y el acceso antes de abrir el WebSocket (401 o 403) y revisa el encabezado `Origin`.
- Quien solo puede leer recibe el documento y los cambios, pero sus cambios se ignoran.
- Vuelve a comprobar permisos en el latido (30 s), antes de aplicar cambios si la última comprobación tiene más de 10 s y al instante cuando la API cambia permisos. Sin acceso se cierra con el código `4403`.
- Presencia: cada conexión solo publica sus propios estados y el nombre es siempre el de su cuenta.
- Guarda el documento en `PageCollabState` con la versión de la página; si la página cambió por otra vía, el estado viejo se descarta y el editor carga el contenido guardado.
- Al restaurar una versión o sincronizar cambios sin conexión, la sala se reinicia: las conexiones se cierran con `4409` y el editor debe volver a cargar la página.

### Por HTTP (producción en Vercel)

`realtime/http-collab.ts` ofrece la misma edición en vivo con **consultas periódicas** (`POST /api/collab/:pageId`), porque las funciones de Vercel no comparten memoria entre instancias: cada petición lleva los cambios y la presencia propios y recibe los de los demás.

- El cuerpo es `{ epoch, after, clientId, update?, awareness? }` (`update` y `awareness` en base64). La respuesta es `{ epoch, access, cursor, update, full, awareness }`.
- `epoch` identifica la versión de la página: si cambió (restaurar versión, sincronizar cambios sin conexión), responde `409` y el editor vuelve a cargar.
- Mismos permisos que el WebSocket: sin acceso, `403`; quien solo tiene lectura nunca recibe `access: "edit"`.
- Guarda en las tablas `PageCollabHttp` / `PageCollabHttpUpdate` (documento compactado + cambios incrementales), compactando los cambios viejos.
- El ritmo de las consultas lo decide el cliente (`frontend/lib/collab/http-provider.ts`), ajustado al plan gratis de Vercel (`docs/limites-vercel-hobby.md`).

## Realtime y modo sin conexión

El canal `/realtime` requiere autenticar la conexión con `{ "type": "auth", "token": "...", "pageId": "..." }`. Después de editar, un cliente autorizado puede enviar `{ "type": "page.changed" }`; los demás reciben `page.refresh` y deben volver a leer la página por REST. Es un canal de avisos para cuando no se usa la edición en vivo.

La sincronización offline usa `operationId` para evitar aplicar dos veces la misma operación y `baseVersion` para detectar ediciones concurrentes. Si la página ya cambió, la API responde `409` y devuelve la versión actual para que el editor permita resolver y reenviar los cambios. La resolución visual de conflictos y la fusión de bloques corresponden al cliente.

## Límites y pendientes

- El almacenamiento de archivos es local al proceso y las salas de `/collab` y `/realtime` viven en memoria: para varias instancias hace falta almacenamiento de objetos y un bus compartido (por ejemplo Redis).
- Los enlaces compartidos requieren que la persona inicie sesión y los acepte.
- Antes del despliegue hay que elegir y configurar base de datos de producción, HTTPS/WSS, copias de seguridad, rotación de secretos y monitorización.
