# Wiki en equipo

Wiki en equipo es un proyecto para crear un espacio interno de documentación para Grupo Comidas. La idea es reunir páginas, procesos y recursos, organizados por departamentos y protegidos según el usuario y sus permisos.

> **Estado actual:** la API (`backend/`: Node.js, TypeScript, Express, Prisma, SQLite y edición en vivo con Yjs) y la interfaz (`frontend/`: Next.js, React y BlockNote) cumplen todos los requisitos. Solo falta preparar la infraestructura para varias instancias (ver `frontend/PENDIENTES_BACKEND.md`).

## Objetivo

Construir una plataforma de documentación colaborativa inspirada en herramientas como Notion. Los usuarios podrán crear páginas privadas y compartirlas con otras personas, publicarlas en su departamento o, con los permisos adecuados, hacerlas visibles para toda la empresa.

## Funcionalidades previstas

- Páginas con texto enriquecido, imágenes, videos, enlaces, tablas, etiquetas y fondos personalizados.
- Editor por bloques con reordenamiento de contenido.
- Páginas privadas por defecto, con opciones para compartir en lectura o edición.
- Acceso a nivel de departamento o de empresa, controlado por roles.
- Plantillas personales y plantillas predeterminadas administradas por la organización.
- Páginas de inicio o muros para departamentos y para la empresa.
- Colaboración en tiempo real y edición sin conexión con resolución de conflictos.
- Subpáginas, historial de ediciones, visitas a páginas públicas y papelera restaurable.
- Límites para archivos subidos y visualización optimizada de imágenes.

Estas funciones describen el alcance del proyecto. Consulta [backend/README.md](backend/README.md) para ver las rutas del servidor y [frontend/README.md](frontend/README.md) para las pantallas, el editor y la demostración paso a paso.

## Roles previstos

| Rol | Responsabilidades principales |
| --- | --- |
| Usuario | Crear páginas y publicarlas dentro de su departamento, según los permisos definidos. |
| Administrador de departamento | Administrar el muro de su departamento y usar las funciones de usuario. |
| Administrador | Gestionar usuarios, permisos generales y contenido público de la empresa. |

Cada usuario pertenecerá a un departamento, incluidos los administradores.

## Estructura del repositorio

```text
assets/       Imágenes y recursos visuales
backend/      API, autenticación, datos, permisos, archivos y sincronización
  api/
  auth/
  models/
  permissions/
  realtime/
  services/
  storage/
  sync/
docs/         Documentación y decisiones del proyecto
frontend/     Interfaz de usuario y componentes
  app/
  components/
    departments/
    editor/
    pages/
    templates/
  lib/
  styles/
shared/       Tipos y utilidades compartidas
  types/
  utils/
tests/        Pruebas de frontend y backend
  frontend/
  backend/
```

Los archivos `.gitkeep` conservan las carpetas mientras estén vacías; pueden quitarse cuando cada carpeta tenga contenido real.

## Reparto sugerido para dos personas

- **Persona 1 — Interfaz:** páginas y navegación, editor por bloques, componentes de contenido, plantillas y muros de departamento/empresa.
- **Persona 2 — Servicios y permisos:** modelo de datos, API, usuarios, departamentos, roles, privacidad, compartir páginas, historial, papelera y almacenamiento.
- **Trabajo conjunto:** definir primero los tipos de datos y contratos de API. Después, conectar las pantallas con los servicios. Dejar la edición simultánea y el modo sin conexión para una etapa posterior.

## Plan inicial

1. Elegir tecnologías y documentar cómo ejecutar el proyecto.
2. Definir usuarios, departamentos, páginas, bloques y permisos.
3. Implementar autenticación, creación y lectura de páginas privadas.
4. Añadir compartir, publicación por departamento y roles administrativos.
5. Construir el editor, las plantillas y los muros.
6. Incorporar historial, papelera, visitas y manejo de archivos.
7. Explorar colaboración en tiempo real y edición sin conexión.

## Desarrollo

Para preparar el servidor, consulta [backend/README.md](backend/README.md); para la interfaz, [frontend/README.md](frontend/README.md). Pruebas: `cd backend && corepack pnpm test` y `cd frontend && npm test`.

### Usuarios de prueba

`npm run seed` (en `frontend/`, con el backend en marcha y la base vacía) crea estos usuarios. Todos usan la contraseña **12345abc** (decisión del equipo; la regla del backend pide al menos 8 caracteres).

| Nombre | Correo | Rol | Departamento |
|---|---|---|---|
| Administrador | adminwiki@grupocomidas.com | Administrador | Tecnología |
| Admin Contabilidad | contabilidadwiki@grupocomidas.com | Admin. de departamento | Contabilidad |
| Usuario Tecnología | tecnologiawiki@grupocomidas.com | Usuario | Tecnología |
| Usuario Compras | compraswiki@grupocomidas.com | Usuario | Compras |

En producción, cada persona debe cambiar su contraseña al entrar por primera vez (su nombre en la barra lateral → **Mi cuenta** → Cambiar contraseña).

## Despliegue

Todo con planes gratis y **sin tarjeta**: frontend y backend en Vercel, y base de datos en Turso.

### Dónde corre cada parte

- **Frontend:** Vercel, con la carpeta raíz `frontend`. Dirección: https://wiki-en-equipo.vercel.app. Cada PR genera su propia vista previa.
- **Backend:** Vercel, un proyecto aparte con la carpeta raíz `backend` (funciones de Vercel, `framework: express`). Dirección: `https://<tu-backend>.vercel.app`.
- **Base de datos:** Turso, que es SQLite en la nube, también gratis. El backend usa el mismo esquema y las mismas migraciones que en local.
- **Archivos subidos:** dentro de la base de datos (`FILE_STORAGE=database`), porque las funciones de Vercel no conservan disco. Límite de 4 MB por archivo.

### Por qué Vercel para el backend

Vercel no pide tarjeta y ya aloja el frontend, así que el backend va como un segundo proyecto del mismo repositorio. Se
compararon en octubre de 2026 otros servicios que publican Node.js gratis y ninguno servía sin tarjeta (Koyeb la pide,
Hugging Face cobra el Docker, SnapDeploy cobra los WebSockets, Railway da un crédito único); Back4App Containers
también servía, pero se retiró en favor de Vercel para tener las dos partes en el mismo sitio y una sola CLI.

Lo que hay que tener en cuenta:
- El plan Hobby incluye **4 horas de CPU activa** y 1 millón de invocaciones al mes. Con 10 personas editando caben,
  pero sin mucho margen: el cálculo completo está en [`docs/limites-vercel-hobby.md`](docs/limites-vercel-hobby.md).
- Las funciones de Vercel **no comparten memoria entre instancias**, así que la edición en vivo en producción va por
  **consultas periódicas por HTTP** (cada 5 s con actividad) en lugar de WebSockets. En local se siguen usando WebSockets.
- La retención de la papelera la dispara **Vercel Cron** una vez al día (`/api/cron/papelera`).

Si algo falla no se pierde nada: todo vive en Turso. La edición en vivo se reconecta sola y el frontend espera hasta 60 s a que el backend responda.

### Cómo funciona la base en Turso

- Con `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`, Prisma usa el adaptador de libSQL (`@prisma/adapter-libsql`). Sin ellas, en local y en las pruebas, usa el archivo de `DATABASE_URL` sin internet.
- `prisma migrate deploy` no llega a Turso. Por eso el backend aplica las migraciones de `backend/models/migrations` que falten:
  - en Vercel, **al compilar** (`pnpm run vercel-build` llama a `models/deploy-turso.ts`), no en cada petición, para que las funciones arranquen rápido;
  - en local, al arrancar el servidor;
  - en orden, cada una en una transacción, junto con su registro en `_prisma_migrations`;
  - si una falla, se deshace completa y el proceso no sigue;
  - nunca borra datos.
- Para aplicarlas a mano: `cd backend && pnpm run db:deploy:turso`, con las dos variables definidas.
- Para probar todo como en producción, sin internet: `cd backend && corepack pnpm run test:turso`.

### Variables de entorno del backend en Vercel

| Variable | Valor |
|---|---|
| `TURSO_DATABASE_URL` | la URL `libsql://…` de Turso |
| `TURSO_AUTH_TOKEN` | el token de Turso (lectura y escritura, sin vencimiento) |
| `FRONTEND_ORIGIN` | `https://wiki-en-equipo.vercel.app` |
| `JWT_SECRET` | texto aleatorio de 32+ caracteres |
| `BOOTSTRAP_SECRET` | otro texto aleatorio, distinto (solo para crear el primer administrador) |
| `PROXY_SECRET` | el mismo valor que en el frontend: el servidor de Next firma con él la IP real del login |
| `CRON_SECRET` | Vercel lo envía en `Authorization: Bearer` al Cron de la papelera |
| `FILE_STORAGE` | `database` (las funciones no conservan disco) |
| `TRUST_PROXY` | `false` (Vercel reescribe `X-Forwarded-For`; la IP real llega por `X-Wiki-Client-Ip` con `PROXY_SECRET`) |
| `MAX_UPLOAD_BYTES` | `4194304` (4 MB) |
| `TRASH_RETENTION_DAYS` | `30` |

Para generar cada texto aleatorio:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 1. Base de datos en Turso

1. Entra a https://turso.tech y crea una cuenta gratis con **GitHub**.
2. Crea una base (*Create Database*) llamada `wiki-en-equipo`, en la región **AWS US East (Virginia)**, la más cercana a Honduras.
3. Abre la base y copia su **URL**, que empieza con `libsql://`.
4. En la misma página crea un **token** (*Create Token* o *Generate Token*), con permiso de lectura y escritura y sin vencimiento. Cópialo: solo se muestra una vez.

Esos dos valores van en Vercel, nunca en el repositorio. Las tablas las crea el backend al desplegar (las migraciones corren en el build).

### 2. Backend en Vercel

1. En Vercel, con el mismo repositorio `vbgjptt89g-beep/wiki-en-equipo`, pulsa **Add New → Project** e importa de nuevo el repositorio.
2. Configura el proyecto:
   - **Project Name:** `wiki-en-equipo-backend`
   - **Root Directory:** `backend`
   - **Framework Preset:** Express (lo detecta por `backend/vercel.json`)
   - **Branch:** `main`
   - **Build & Output Settings:** sin cambios: usa `backend/vercel.json`.
3. En **Settings → Environment Variables**, en **Production**, define las de la tabla de arriba.
4. **Deploy**. En los registros del build deben aparecer las migraciones aplicadas; en los *Runtime Logs*, `Wiki en equipo API escuchando…`.
5. Abre `/health` en la dirección del proyecto (`https://<tu-backend>.vercel.app/health`). Debe responder `{"status":"ok"}`.

### 3. Frontend en Vercel

En *Settings → Environment Variables*, en **Production**, define estas variables y vuelve a desplegar:

- `BACKEND_URL=https://<tu-backend>.vercel.app` (solo la usa el servidor de Next; el navegador nunca llama directo al backend)
- `NEXT_PUBLIC_COLLAB_URL=https://<tu-backend>.vercel.app/api/collab` (edición en vivo por consultas periódicas por HTTP)
- `NEXT_PUBLIC_MAX_UPLOAD_MB=4`: las subidas pasan por el servidor de Next, y en Vercel una función no acepta más de 4,5 MB.
- `PROXY_SECRET`: el mismo valor que en el backend; el servidor de Next firma con él la IP real del login.

`NEXT_PUBLIC_REALTIME_URL` **ya no hace falta** en producción: el canal de avisos por WebSocket `/realtime` es para local. Si `NEXT_PUBLIC_COLLAB_URL` usa `https://…`, la edición en vivo va por HTTP y no se abre ningún WebSocket.

Las variables `NEXT_PUBLIC_*` quedan dentro del código del navegador, así que hay que volver a desplegar después de cambiarlas.

### Copias de seguridad

Toda la información de la wiki vive en Turso. Antes de un cambio grande, saca una copia desde el panel de Turso o con su herramienta de línea de comandos (`turso db shell wiki-en-equipo .dump > copia.sql`).

### Crear o actualizar los 4 usuarios en producción

> **Advertencia:** este repositorio es público y la contraseña `12345abc` está escrita en él. El equipo decidió usarla también en producción, pero así cualquier persona que lea el repositorio puede entrar con esas cuentas, incluida la de administrador. Conviene cambiar las contraseñas en cuanto el equipo empiece a usar la wiki (cada persona: su nombre en la barra lateral → **Mi cuenta** → Cambiar contraseña).

**Nunca** borres ni reinicies la base de producción y **nunca** corras `npm run seed` contra ella (crea páginas de ejemplo y solo sirve con una base vacía). Primero despliega en el backend la versión que acepta contraseñas de 8 caracteres.

La forma recomendada en Windows es el script [`scripts/crear-usuarios.ps1`](scripts/crear-usuarios.ps1), que crea el administrador, los departamentos y los cuatro usuarios, y avisa si alguno ya existe. También se puede hacer a mano:

1. **Si la base de producción todavía no tiene usuarios**, crea el administrador una sola vez (pide `BOOTSTRAP_SECRET` a quien configuró el backend):

   ```bash
   curl -X POST https://<tu-backend>.vercel.app/api/auth/bootstrap -H "Content-Type: application/json" -d '{"name":"Administrador","email":"adminwiki@grupocomidas.com","password":"12345abc","departmentName":"Tecnología","secret":"<BOOTSTRAP_SECRET>"}'
   ```

   Si responde 409, la base ya tiene usuarios: no pasa nada, sigue con el paso 2.
2. Entra a la wiki con un administrador y abre **Administración → Usuarios**.
3. Si faltan los departamentos **Contabilidad** o **Compras**, créalos en esa misma pantalla.
4. Crea cada usuario que falte con **Nuevo usuario**, con su nombre, correo, rol y departamento de la tabla de [Usuarios de prueba](#usuarios-de-prueba) y la contraseña `12345abc`.
5. **Si alguno de esos correos ya existe**, no lo crees otra vez: en **Administración → Usuarios** puedes corregir su nombre, rol y departamento. La wiki no deja que un administrador cambie la contraseña de otra persona; esa persona tiene que entrar con su contraseña actual y cambiarla en **Mi cuenta**.
6. Comprueba que cada uno puede iniciar sesión.

## Seguridad

No guardes contraseñas, tokens, claves privadas ni datos reales de usuarios en este repositorio. Antes de publicar cambios, revisa que no incluyan secretos ni información interna que no deba ser pública.
