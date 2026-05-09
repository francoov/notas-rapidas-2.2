# Notas Rápidas 2

Aplicación de escritorio simple para crear notas tipo post-it. Funciona completamente offline y de forma local.

## Características

- ✅ Ventana principal con botón para crear notas
- ✅ Notas tipo post-it que aparecen en la pantalla
- ✅ Funciona completamente offline
- ✅ Interfaz simple y moderna

## Requisitos

- Node.js (versión 14 o superior)
- npm (viene con Node.js)

## Instalación

1. Instala las dependencias:
```bash
npm install
```

## Uso

### Modo Desarrollo

Para ejecutar la aplicación en modo desarrollo:

```bash
npm start
```

### Crear Ejecutable

Para crear un ejecutable para Windows se usa un script que empaqueta la app y **actualiza la versión** en `package.json` (el desarrollo con `npm start` no cambia la versión).

| Comando | Descripción |
|---------|-------------|
| `npm run build:win` | Incrementa el **patch** (tercer número, ej. `0.5.0` → `0.5.1`) y genera el build. |
| `npm run build:win:patch` | Igual que `build:win` (patch). |
| `npm run build:win:minor` | Incrementa el **minor** (segundo número, resetea el patch a 0). |
| `npm run build:win:major` | Incrementa el **major** (primer número). |
| `npm run build:win:no-bump` | Empaqueta **sin** cambiar la versión (útil para probar el empaquetado). |

La salida queda en `dist/` dentro de una carpeta **`notas-rapidas-v<versión>-win32-x64`** (sin espacios en el nombre). El ejecutable es **`notas-rapidas.exe`** dentro de esa carpeta.

La versión visible en la aplicación (Configuración, pie de página) coincide con el campo `"version"` de `package.json` y con lo que reporta Electron al empaquetar.

#### Si Windows dice que no tiene acceso al ejecutable

Ese mensaje suele ser del **sistema o del antivirus**, no de Electron en sí. Prueba en este orden:

1. Abre el `.exe` **desde el Explorador** entrando a `dist\notas-rapidas-v…-win32-x64\` (no uses un acceso directo viejo: **cada build cambia el nombre de la carpeta** si sube la versión).
2. Clic derecho en `notas-rapidas.exe` → **Propiedades**: si aparece **Desbloquear**, actívalo y acepta.
3. Añade una **excepción** en Windows Defender (o tu antivirus) para esa carpeta o el `.exe`.
4. Si `Documents` está en **OneDrive**, copia la carpeta del build a una ruta local (p. ej. `C:\Apps\`) y ejecuta desde ahí.

Tras cada `npm run build:win`, el script imprime en consola la **ruta completa** del ejecutable generado.

### Versionado (SemVer)

La versión oficial es **solo** la de `package.json` (`MAJOR.MINOR.PATCH`).

- **Major**: cambios estructurales o incompatibles (arquitectura, formato de datos, migraciones obligatorias).
- **Minor**: conjunto de funcionalidad o mejoras medianas, compatible con lo anterior.
- **Patch**: correcciones pequeñas, un bugfix puntual, ajustes menores.

Convención del proyecto documentada también en `.cursor/skills/notas-rapidas-semver-release/SKILL.md` (para el asistente en Cursor).

## Estructura del Proyecto

- `main.js` - Proceso principal de Electron
- `scripts/build-win.js` - Script de build Windows (semver + electron-packager)
- `index.html` - Ventana principal de la aplicación
- `note.html` - Plantilla para las notas post-it
- `styles.css` - Estilos de la ventana principal
- `note-styles.css` - Estilos de las notas post-it

## Notas

- Las notas aparecen como ventanas flotantes tipo post-it
- Puedes crear múltiples notas
- Las notas se pueden arrastrar por la pantalla
- Cierra cada nota individualmente con el botón ×

## Notas Técnicas

### Rendimiento del Tablero Kanban

**Problema conocido**: El tablero Kanban puede presentar parpadeo/flickering si se actualiza periódicamente.

**Solución implementada**: El Kanban NO se actualiza automáticamente cada X segundos. En su lugar, se actualiza solo cuando hay cambios reales a través de:
- Eventos IPC (`notes-updated`, `note-updated`)
- Acciones del usuario (eliminar bloque, cambiar estado, cerrar nota)

**Importante**: No agregar `setInterval` para actualizar el Kanban periódicamente, ya que esto causa parpadeo. El sistema de eventos IPC es suficiente para mantener el tablero sincronizado.


