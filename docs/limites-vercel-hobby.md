# Límites del plan gratis de Vercel (Hobby) y las consultas periódicas

Fecha: 19/10/2026. Fuentes: `vercel.com/docs/plans/hobby` y `vercel.com/docs/limits` (agosto de 2026).

## Lo que incluye el plan Hobby (gratis, sin tarjeta)

| Recurso | Incluido al mes |
|---|---|
| Invocaciones de función | 1.000.000 |
| CPU activa | 4 horas (~14.400 s) |
| Memoria aprovisionada | 360 GB-horas |
| Transferencia de datos | 100 GB |
| Cron jobs por proyecto | 100, mínimo **una vez al día** (±59 min) |
| Duración máxima de una función | 300 s |

Cada invocación se cobra por CPU activa *y* por memoria aprovisionada mientras la función está despierta (aunque
espere a la base). Por eso el intervalo de las consultas periódicas no se elige solo por las invocaciones.

## Cómo se gastan: 10 personas editando a la vez

Ritmo del proveedor HTTP (`frontend/lib/collab/http-provider.ts`): **2 s** mientras hay actividad
(teclado, ratón, cambios propios o ajenos), **5 s** hasta los 5 min sin actividad, **15 s** hasta los 30 min y
después en pausa. Con la pestaña oculta se detiene. Cada consulta va precedida de una comprobación previa
(OPTIONS) que el navegador guarda 2 h, así que en régimen estable es **una invocación por consulta**.

Supuesto realista para Grupo Comidas: la wiki se usa con pausas largas de lectura. Cálculo conservador con
10 personas que mantengan el ritmo activo (2 s) durante **2 horas** al día y reposo (15 s) el resto:

- activo: 10 × 2 h × 3.600 s / 2 s = **36.000 invocaciones/día**;
- reposo (22 h a 15 s): 10 × 22 h × 3.600 / 15 s = 52.800 → pero a los 30 min sin actividad el cliente se
  pausa, así que en la práctica son ~2 peticiones por persona por hora en reposo: **~450/día**;
- total ≈ **36.500 invocaciones/día** ≈ 1,1 M/mes.

Está justo en el límite de 1 M de invocaciones, así que **se ajusta el ritmo**: el proveedor ya arranca en 5 s
en lugar de 2 s en reposo real y el intervalo activo se mantiene en 2 s solo mientras hay teclado o ratón.

Ahora bien, el recurso que se agota primero **no son las invocaciones, sino la CPU activa (4 h/mes)**. Una
consulta a Turso es casi todo espera, pero una función que espera sigue consumiendo memoria aprovisionada y algo
de CPU. Medición en local con el backend en modo Turso (300 consultas seguidas, ver `docs/medicion-cpu.md`):
cada consulta consume ~0,35 s de CPU y ~0,4 s de tiempo de pared.

- 10 personas × 2 h/día de edición a 2 s = 36.000 consultas → 36.000 × 0,35 s ≈ **3,5 h de CPU** al mes;
- añadiendo el resto de la aplicación (abrir páginas, guardar, subir archivos) se pasa de las 4 h.

**Ajuste aplicado:** con el plan Hobby, en producción el ritmo activo baja a **5 s** y el de reposo a
**20 s/60 s**, y la consulta normal ya no manda presencia si no cambió (`awarenessDirty`). Con eso:

- 10 personas × 2 h/día a 5 s = 14.400 consultas/día → 14.400 × 0,35 s ≈ **1,4 h de CPU** al mes, de las 4 h;
- invocaciones ≈ 450.000 al mes, de 1 M.

Es decir: **10 personas editando a la vez caben en el plan gratis**, pero sin margen para tener 10 personas
editando 8 horas al día. Si el equipo crece o se edita mucho más, hay que subir a Pro (de pago) o mover el
backend a un servicio con proceso siempre encendido.

Los cambios propios siguen saliendo al instante (con un mínimo de 1,5 s entre consultas), así que la sensación
al escribir no cambia; lo que tarda 5 s como mucho es ver lo que escriben los demás cuando están inactivos.

## Otras comprobaciones

- **Prisma con el adaptador de libSQL en funciones de Vercel:** funciona. El cliente se genera en `vercel-build`
  con el motor `rhel-openssl-3.0.x` (`backend/models/schema.prisma`, campo `binaryTargets`), que es el de las
  funciones de Vercel (Amazon Linux 2023). El adaptador (`@prisma/adapter-libsql`) habla con Turso por HTTP, que
  es lo único que permite una función sin conexiones persistentes.
- **Migraciones:** se aplican **al compilar** (`pnpm run vercel-build` llama a `models/deploy-turso.ts`), no en
  cada petición. Si el despliegue se repite, no hace nada: cada migración queda registrada en
  `_prisma_migrations` y se aplica en una transacción.
- **Archivos:** `FILE_STORAGE=database` porque las funciones no conservan disco. Límite de 4 MB por archivo,
  por debajo de los 4,5 MB que acepta Vercel como cuerpo de una función.
- **WebSockets:** descartados en producción. Vercel los admite (beta), pero cada petición puede caer en una
  instancia distinta y no comparten memoria; el servidor Yjs del backend no podría sincronizar entre ellas.
  En local se mantienen.
