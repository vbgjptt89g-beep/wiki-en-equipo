# Backend de Wiki en equipo

API REST en Node.js, TypeScript, Express y Prisma. SQLite se usa como configuración inicial para desarrollo local; antes de desplegar para varias instancias o muchos usuarios, el equipo debe elegir un motor de base de datos compartido.

## Requisitos y puesta en marcha

- Node.js 20 o superior y npm.
- Desde esta carpeta, instala dependencias con `pnpm install`.
- Copia `.env.example` a `.env`, configura `JWT_SECRET` y `BOOTSTRAP_SECRET` con valores aleatorios largos, y ajusta `DATABASE_URL` si hace falta.
- Genera el cliente y aplica la migración inicial con `pnpm run db:generate` y `pnpm run db:migrate -- --name initial`.
- Inicia en modo desarrollo con `pnpm run dev`.
- El primer administrador se crea una sola vez con `POST /api/auth/bootstrap`; envía la clave configurada como `BOOTSTRAP_SECRET`. Después del primer usuario, esa ruta queda cerrada. El proceso crea tres plantillas predeterminadas para la empresa y los departamentos. Los intentos de inicio de sesión y configuración inicial tienen límites por IP.

No subas `.env`, la base de datos ni los archivos cargados al repositorio.

## Acceso

La API devuelve un token JWT de ocho horas. En cada petición autenticada envía `Authorization: Bearer <token>`. El inicio de sesión no está abierto al público: un administrador debe crear los usuarios.

Roles: `USER`, `DEPARTMENT_ADMIN` y `ADMIN`. Los usuarios siempre pertenecen a un departamento.

## Rutas principales

| Método y ruta | Uso |
| --- | --- |
| `POST /api/auth/bootstrap` | Crear el primer administrador y su departamento |
| `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/password` | Sesión y cuenta |
| `GET/POST /api/departments`, `PUT/DELETE /api/departments/:departmentId/wall` | Departamentos y muro |
| `GET/PUT /api/departments/:departmentId/featured`, `GET/PUT/DELETE /api/company/wall` | Páginas destacadas y muro de empresa |
| `GET/POST /api/users`, `PATCH /api/users/:userId` | Usuarios; solo administradores |
| `GET/POST /api/pages`, `GET/PATCH/DELETE /api/pages/:pageId` | Consultar, crear, editar y enviar páginas a la papelera |
| `GET /api/pages/:pageId/history`, `POST /api/pages/:pageId/history/:version/restore` | Historial y restauración de versiones |
| `PUT/DELETE /api/pages/:pageId/shares/:userId` | Compartir con una persona |
| `POST /api/pages/:pageId/share-links`, `POST /api/share/:token/accept` | Enlaces de invitación para usuarios autenticados |
| `GET/POST /api/templates`, `GET/PATCH/DELETE /api/templates/:templateId` | Plantillas personales y compartidas |
| `POST /api/files`, `GET /api/files/:fileId/content`, `DELETE /api/files/:fileId` | Archivos con límite de tamaño y tipos permitidos |
| `POST /api/sync/pages/:pageId` | Sincronización optimista por versión; devuelve `409` con la versión actual ante conflictos |
| WebSocket `/realtime` | Notificaciones de cambios a participantes autorizados |

Todas las rutas salvo `/health`, inicio de sesión y configuración inicial requieren autenticación. Las páginas son privadas por defecto. Los cambios incrementan `version` y guardan la versión anterior; `PATCH /api/pages/:pageId` requiere `expectedVersion`. Las visitas se registran solo en páginas publicadas a departamento o empresa. Las sesiones se invalidan al cambiar la contraseña y las cuentas inactivas pierden acceso inmediatamente.

Las páginas aceptan `content` como JSON serializable de bloques y `background` como JSON serializable. El editor y el backend deben acordar las formas finales de esos objetos antes de integrar la interfaz.

## Realtime y modo sin conexión

El canal WebSocket requiere autenticar la conexión con `{ "type": "auth", "token": "...", "pageId": "..." }`. Después de editar, un cliente autorizado puede enviar `{ "type": "page.changed" }`; los demás reciben `page.refresh` y deben volver a leer la página por REST. El canal es de notificación, no transmite ni combina bloques.

La sincronización offline usa `operationId` para evitar aplicar dos veces la misma operación y `baseVersion` para detectar ediciones concurrentes. Si la página ya cambió, la API responde `409` y devuelve la versión actual para que el editor permita resolver y reenviar los cambios. La resolución visual de conflictos y la fusión de bloques corresponden al cliente.

## Límites y pendientes

- El almacenamiento de archivos es local al proceso; para producción debe reemplazarse por almacenamiento de objetos compartido.
- Los enlaces compartidos requieren que la persona inicie sesión y los acepte.
- El WebSocket mantiene salas en memoria; una instalación con varias instancias necesita un bus compartido.
- Antes del despliegue hay que elegir y configurar base de datos de producción, HTTPS, copias de seguridad, retención de papelera, rotación de secretos, límites de intentos de login y monitorización.
