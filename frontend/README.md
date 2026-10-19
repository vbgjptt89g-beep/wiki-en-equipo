# Wiki Grupo Comidas: frontend (Persona A)

Next.js 15 (App Router) + React 19 + Tailwind CSS 4 + lucide-react + TypeScript.
Editor BlockNote, Yjs + y-indexeddb para edición simultánea y modo sin conexión.

## Arrancar en local

1. Levanta el backend (ver `../backend/README.md` o `../CLAUDE.md`). Queda en http://localhost:4000, con la edición en vivo en `ws://localhost:4000/collab`.
2. En esta carpeta:

```bash
npm install
cp .env.example .env.local   # opcional, ver variables abajo
npm run seed                 # solo la primera vez, con la base recién migrada
npm run dev
```

Abre http://localhost:3000 e inicia sesión con uno de estos usuarios (los crea `npm run seed`, definidos en `scripts/seed-users.mjs`). Todos usan la contraseña **12345abc**; en producción, cada persona debe cambiarla al entrar por primera vez.

| Nombre | Correo | Rol | Departamento |
|---|---|---|---|
| Administrador | adminwiki@grupocomidas.com | Administrador | Tecnología |
| Admin Contabilidad | contabilidadwiki@grupocomidas.com | Admin. de departamento | Contabilidad |
| Usuario Tecnología | tecnologiawiki@grupocomidas.com | Usuario | Tecnología |
| Usuario Compras | compraswiki@grupocomidas.com | Usuario | Compras |

Casos para probar: Usuario Compras no puede abrir "Mis notas" de Usuario Tecnología (privada); ve "Borrador: guía de VPN" en solo lectura y puede editar "Checklist de soporte en sucursales". Usuario Compras no entra al muro de Tecnología. Admin Contabilidad edita el muro de Contabilidad. Administrador ve "Administración". Cualquier persona puede invitar a otra desde "Compartir" (buscador por nombre). Usuario Tecnología compartió la plantilla "Visita técnica a sucursal" con Usuario Compras (lectura) y con Admin Contabilidad (edición).

> **OneDrive:** si el repositorio está dentro de una carpeta sincronizada con OneDrive, `.next` puede quedar con archivos "solo en la nube" y Next falla con `EINVAL: readlink`. Borra `.next` y vuelve a arrancar, o excluye la carpeta de la sincronización.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Compilación de producción (revisa tipos y genera la lista del service worker) |
| `npm start` | Sirve la compilación de producción (aquí se activa el modo sin conexión) |
| `npm test` | Pruebas (Vitest) de `../tests/frontend`; las de integración se omiten si el backend o el seed no están |
| `npm run seed` | Datos de prueba en el backend local (usuarios, páginas, muros y plantillas de Grupo Comidas) |

No corras `npm run build` con `npm run dev` abierto: ambos usan `.next`.

## Variables (`.env.local`)

`BACKEND_URL`, `NEXT_PUBLIC_COLLAB_URL`, `NEXT_PUBLIC_MAX_UPLOAD_MB`, `NEXT_PUBLIC_TRASH_RETENTION_DAYS`, `UNSPLASH_ACCESS_KEY`, `NEXT_PUBLIC_ENABLE_SW`, `PROXY_SECRET` (producción). Detalle en [.env.example](.env.example).

## Estructura

    app/
      login/                       Inicio de sesión (cookie httpOnly con el token del backend)
      share/[token]                Aceptar enlaces compartidos
      sin-conexion/                Borradores sin conexión (funciona sin internet)
      archivos/                    Subir (POST) y ver (GET /archivos/:id) archivos con la sesión
      fondos/buscar                Búsqueda opcional en Unsplash
      actions/                     Server actions: sesión, compartir, páginas/plantillas, administración, sincronización
      (wiki)/                      Pantallas con sesión: muros, páginas (ver, editar, historial), buscar,
                                   plantillas, papelera, administración
    components/
      editor/                      BlockNote, bloques propios, fondos, icono, etiquetas, plantillas, conflictos, presencia
      pages/ templates/ departments/ admin/ offline/ layout/ page/ ui/
    lib/
      types.ts                     Tipos (base en ../shared/types)
      blocks.ts                    Formato de bloques y fondo que se guarda en el backend
      editor/convert.ts            Conversión backend ↔ BlockNote
      editor/merge.ts              Fusión de tres vías para conflictos
      collab/                      Yjs, y-indexeddb, canal en tiempo real, borradores
      api/                         Capa de datos (lecturas) y cliente HTTP del backend
      session.ts permissions.ts uploads.ts default-templates.ts backgrounds.ts
    public/sw.js                   Service worker (páginas visitadas disponibles sin conexión)
    ../assets/templates/3dicons/   Iconos 3D (CC0) de las plantillas por defecto; se copian a public/iconos/3d al compilar
    public/brand/                  Logo de Grupo Comidas (el original está en ../assets/brand/)
    app/icon.png, icon1.png, apple-icon.png, manifest.ts   Favicon e iconos de la app instalable
    scripts/                       seed, copia de iconos 3D y lista de archivos del service worker

## Edición simultánea y sin conexión

- **En vivo con presencia:** el editor se conecta a la edición en vivo del backend. Lo que escribe una persona aparece al instante en las demás, con su cursor, y arriba a la derecha se ve **En vivo** y quién más está editando ("También editando"). Quien solo puede leer no puede abrir el editor y, aunque lo intentara, el servidor ignora sus cambios.
- **Local:** WebSocket al servidor Yjs del backend (`ws://<host actual>:4000/collab`, protocolo y-websocket).
- **Producción (Vercel):** `NEXT_PUBLIC_COLLAB_URL` con `https://…/api/collab`. Como las funciones de Vercel no comparten WebSockets entre instancias, la sincronización va por **consultas periódicas por HTTP** (`lib/collab/http-provider.ts`, `POST /api/collab/<pagina>`): cada 5 s con actividad, 20 s / 60 s en reposo y en pausa tras 30 min. El ritmo se eligió para caber en las 4 h de CPU del plan Hobby (`docs/limites-vercel-hobby.md`). Con `NEXT_PUBLIC_COLLAB_URL=off` se usa solo el canal de avisos `/realtime`.
- Cada página que se edita tiene además un documento **Yjs** guardado en **IndexedDB** (y-indexeddb). Si se cae la red, se sigue editando; al volver se sube con `POST /api/sync/pages/:id` (con `operationId` para no duplicar).
- Si alguien más cambió la página, se hace una **fusión de tres vías por bloque** (`lib/editor/merge.ts`): lo que no choca se combina solo; si dos personas editaron el mismo bloque, se muestra un diálogo para elegir.
- Si alguien restaura una versión del historial mientras otras personas editan, el servidor cierra la sala (código 4409): el editor borra su copia local y vuelve a cargar la versión restaurada. Si a alguien le quitan el acceso, se le avisa (4403).
- **Sin conexión fuera del editor:** en producción, el service worker guarda las páginas visitadas, los archivos de la aplicación y el logo. Sin internet se pueden abrir y editar esas páginas, y crear **borradores nuevos** en `/sin-conexion` que luego se suben como páginas privadas. Al cerrar sesión se borra la copia de páginas del dispositivo.

### Demostración paso a paso

Necesitas dos terminales y dos navegadores (o uno normal y una ventana de incógnito, para tener dos sesiones distintas).

1. **Backend** (terminal 1): `cd backend && corepack pnpm run dev`. Si la base está vacía, en `frontend/` corre `npm run seed`.
2. **Frontend** (terminal 2): `cd frontend && npm run dev`.
3. En el navegador A entra como **Usuario Tecnología** y en el B como **Usuario Compras** (contraseña `12345abc`). Ambos abren **Checklist de soporte en sucursales** → **Editar** (Usuario Tecnología es el dueño; Usuario Compras tiene permiso de edición).
4. Arriba a la derecha cada uno ve **En vivo** y el avatar de la otra persona ("También editando"). Lo que escribe uno aparece al instante en el otro, con su cursor.
5. **Solo lectura:** Usuario Compras abre **Borrador: guía de VPN**: no tiene botón Editar y, si entra a `/editar`, ve "Solo puedes leer esta página". El servidor también ignora los cambios de quien solo tiene lectura.
6. **Invitar:** Usuario Compras (usuario normal) abre **Compartir** en el checklist, escribe "contabilidad" y ve a Admin Contabilidad (solo nombre y departamento); lo invita con "Puede ver". La lista de acceso muestra los nombres y la sección de enlaces muestra los activos, que se pueden desactivar.
7. **Sin conexión y conflictos:** en el navegador B abre las herramientas de desarrollo → *Network* → *Offline*. Usuario Compras cambia un bloque; Usuario Tecnología cambia **el mismo** bloque y agrega otro. Al volver a *Online*, Usuario Compras ve el diálogo para elegir en el bloque en conflicto; el bloque nuevo de Usuario Tecnología se combina solo.
8. **Borradores sin conexión:** `npm run build && npm start`, abre algunas páginas, corta la red y entra a `/sin-conexion` → **Nuevo borrador**. Al volver la red, **Subir a la wiki**.

### Qué falta para producción

- **Infraestructura:** HTTPS; configurar `BACKEND_URL` y `NEXT_PUBLIC_COLLAB_URL` (`https://<backend>/api/collab`, edición por HTTP) y `PROXY_SECRET` (el servidor de Next firma con él la IP real del login, porque Vercel reescribe `X-Forwarded-For`). En local, la edición en vivo va por WebSocket y el token viaja en la URL (`?token=`).
- **Backend:** una sola instancia por ahora (ver [PENDIENTES_BACKEND.md](PENDIENTES_BACKEND.md)).
- **Datos locales:** al cerrar sesión se borra todo lo que la wiki guardó en el dispositivo (copias para trabajar sin conexión, borradores y páginas en caché). Si hay cambios sin subir, antes se listan y se pide confirmación (`components/auth/LogoutButton.tsx`). Si la sesión vence sin cerrar sesión, los datos quedan hasta el siguiente cierre; al entrar otra persona en el mismo navegador se borra la caché de páginas.
