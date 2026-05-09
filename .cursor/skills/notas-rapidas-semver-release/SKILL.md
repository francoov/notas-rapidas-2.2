---
name: notas-rapidas-semver-release
description: Define versionado SemVer (0.x.y) para Notas Rápidas, cuándo subir major/minor/patch y cómo construir releases Windows sin tocar la versión en desarrollo local. Usar al preparar builds, al cambiar package.json o cuando el usuario pregunte por versiones o npm run build:win.
---

# Versionado y releases — Notas Rápidas

## Fuente de verdad

- La versión vive **solo** en `package.json` → campo `"version"`.
- La app muestra esa versión en **Configuración** (footer) vía `app.getVersion()` en Electron.
- **`npm start`** no modifica la versión.

## Formato SemVer

`MAJOR.MINOR.PATCH` (ej. `0.5.0`).

| Segmento | Significado en este proyecto | Ejemplos |
|----------|------------------------------|----------|
| **MAJOR** (primero) | Cambio **estructural** o incompatible: arquitectura, modelo de datos irreversible, flujos que rompen expectativas, migraciones obligatorias. | Replantear almacenamiento, cambiar formato de export/import de forma incompatible. |
| **MINOR** (segundo) | **Paquete** de funcionalidad o conjunto de mejoras/fixes medianos; compatible hacia atrás. | Nueva pantalla, Kanban grande, lote de features coordinadas. |
| **PATCH** (tercero) | Ajustes **pequeños**: correcciones puntuales, copy, un bugfix, micro-optimización. | Fix de un crash, typo, ajuste de estilo. |

Si dudas entre minor y patch: **pocos archivos / un solo tema** → patch; **varios temas o release “de paquete”** → minor.

## Cómo subir versión al construir (Windows)

Solo al empaquetar, el script `scripts/build-win.js`:

1. Incrementa `version` en `package.json` según el tipo elegido.
2. Ejecuta `electron-packager` con carpeta de salida `notas-rapidas-v<versión>-win32-x64` (sin espacios) y ejecutable `notas-rapidas.exe`.

### Comandos

| Comando | Efecto |
|---------|--------|
| `npm run build:win` | Igual que **patch** (build pequeño por defecto). |
| `npm run build:win:patch` | +0.0.1 |
| `npm run build:win:minor` | +0.1.0 (reset patch a 0) |
| `npm run build:win:major` | +1.0.0 (reset minor y patch) |
| `npm run build:win:no-bump` | Empaqueta **sin** cambiar versión (pruebas de empaquetado). |

## Flujo recomendado

1. Desarrollo diario: `npm start` — versión sin tocar.
2. Antes de un release: decide **patch / minor / major** según la tabla.
3. Ejecuta el script correspondiente y prueba el `.exe` en `dist/`.
4. Opcional: commit de `package.json` con mensaje del tipo `chore: release v0.5.1`.

## Notas

- El nombre del producto empaquetado incluye la versión para distinguir carpetas en `dist/`.
- No dupliques versión en HTML/JS a mano: siempre `package.json` + build.
