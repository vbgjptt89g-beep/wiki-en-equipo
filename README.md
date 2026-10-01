# Wiki en equipo

Wiki en equipo es un proyecto para crear un espacio interno de documentación para Grupo Comidas. La idea es reunir páginas, procesos y recursos, organizados por departamentos y protegidos según el usuario y sus permisos.

> **Estado actual:** el repositorio contiene la estructura inicial de carpetas. La aplicación todavía no tiene funcionalidades implementadas ni tecnologías de desarrollo definidas.

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

Estas funciones describen el alcance deseado; aún deben diseñarse e implementarse.

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

Todavía no hay instrucciones de instalación o ejecución porque el proyecto no tiene una aplicación ni dependencias configuradas. Cuando se elijan las tecnologías, esta sección debe incluir los requisitos, los pasos para instalar dependencias, configurar variables de entorno y ejecutar la aplicación.

## Seguridad

No guardes contraseñas, tokens, claves privadas ni datos reales de usuarios en este repositorio. Antes de publicar cambios, revisa que no incluyan secretos ni información interna que no deba ser pública.