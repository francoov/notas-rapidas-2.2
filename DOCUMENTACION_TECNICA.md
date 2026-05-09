# Documentación Técnica - Notas Rápidas 2

## 📋 Índice
1. [Arquitectura General](#arquitectura-general)
2. [Modelo de Datos](#modelo-de-datos)
3. [Almacenamiento de Datos](#almacenamiento-de-datos)
4. [Comunicación entre Ventanas](#comunicación-entre-ventanas)
5. [Flujo de Datos](#flujo-de-datos)
6. [Mejores Prácticas Implementadas](#mejores-prácticas-implementadas)
7. [Estructura de Archivos](#estructura-de-archivos)

---

## 🏗️ Arquitectura General

### ¿Qué es Electron?
Esta aplicación está construida con **Electron**, que es una tecnología que permite crear aplicaciones de escritorio usando tecnologías web (HTML, CSS, JavaScript). 

**Concepto clave**: Electron tiene dos tipos de procesos:
- **Proceso Principal (Main Process)**: `main.js` - Controla las ventanas y la aplicación
- **Procesos de Renderizado (Renderer Processes)**: Cada ventana HTML tiene su propio proceso JavaScript

### Ventanas de la Aplicación

La aplicación tiene **5 tipos de ventanas**:

1. **Ventana Principal** (`index.html` + `main-renderer.js`)
   - Lista todas las notas activas
   - Permite crear nuevas notas
   - Búsqueda y filtrado

2. **Ventanas de Notas** (`note.html` + `note-renderer.js`)
   - Cada nota es una ventana independiente
   - Puede haber múltiples ventanas de notas abiertas simultáneamente
   - Edición de contenido en bloques

3. **Tablero Kanban** (`kanban.html` + `kanban-renderer.js`)
   - Visualización de bloques de todas las notas en formato Kanban
   - Filtros por persona, prioridad, etiqueta, fecha

4. **Configuración** (`settings.html` + `settings-renderer.js`)
   - Gestión de personas
   - Gestión de etiquetas

5. **Notas Cerradas** (`closed-notes.html` + `closed-notes-renderer.js`)
   - Lista de notas archivadas/cerradas

---

## 💾 Modelo de Datos

### Estructura de una Nota

```javascript
{
  id: "1234567890",                    // ID único (timestamp)
  title: "Mi Nota",                     // Título de la nota
  content: "...",                        // Contenido HTML (legacy, se usa blocks)
  blocks: [                              // Array de bloques de texto
    {
      content: "<p>Texto del bloque</p>", // Contenido HTML del bloque
      status: "pendiente",                // Estado: '', 'pendiente', 'en-progreso', 'hecho'
      priority: "p1",                    // Prioridad: '', 'p5', 'p4', 'p3', 'p2', 'p1'
      assignedPerson: {                  // Persona asignada (objeto completo)
        id: "person-123",
        firstName: "Franco",
        lastName: "Ovalle"
      },
      tag: {                            // Etiqueta (objeto completo)
        id: "tag-456",
        name: "Macrotopo"
      },
      createdAt: "2026-02-05T10:30:00.000Z",  // Fecha de creación del bloque
      blockUpdatedAt: "2026-02-05T11:00:00.000Z", // Última actualización del bloque
      marked: false                      // Si el bloque está marcado (bandera roja)
    }
  ],
  createdAt: "2026-02-05T10:00:00.000Z",    // Fecha de creación de la nota
  updatedAt: "2026-02-05T11:00:00.000Z",     // Última actualización de la nota
  status: "active",                     // Estado de la nota: 'active', 'closed'
  isClosed: false,                      // Si la nota está cerrada
  summary: "Resumen generado por IA",   // Resumen opcional
  contentHash: "abc123..."             // Hash del contenido para cache
}
```

### Estructura de una Persona

```javascript
{
  id: "person-123",                     // ID único
  firstName: "Franco",                  // Nombre
  lastName: "Ovalle"                    // Apellido (opcional)
}
```

### Estructura de una Etiqueta

```javascript
{
  id: "tag-456",                        // ID único
  name: "Macrotopo"                     // Nombre de la etiqueta
}
```

### Conceptos Importantes

**Bloques**: Cada nota está dividida en "bloques" de texto. Cada bloque puede tener:
- Su propio contenido de texto
- Estado (pendiente, en progreso, hecho)
- Prioridad (P1 a P5)
- Persona asignada
- Etiqueta
- Fecha de creación y actualización

**¿Por qué bloques?**: Permite gestionar tareas individuales dentro de una nota, similar a un sistema de gestión de proyectos.

---

## 💿 Almacenamiento de Datos

### ¿Dónde se guarda la información?

**Toda la información se guarda en el navegador usando `localStorage`**.

`localStorage` es una tecnología del navegador que permite guardar datos de forma permanente en la computadora del usuario, incluso después de cerrar la aplicación.

### Ubicación Física

En Windows, los datos se guardan en:
```
C:\Users\[TuUsuario]\AppData\Roaming\Notas Rápidas 2\Local Storage\
```

O si usas Electron directamente:
```
C:\Users\[TuUsuario]\AppData\Roaming\Electron\Local Storage\
```

### Claves de Almacenamiento

La aplicación usa **3 claves principales** en localStorage:

1. **`notes`**: Array JSON con todas las notas
   ```javascript
   localStorage.setItem('notes', JSON.stringify(notes));
   ```

2. **`persons`**: Array JSON con todas las personas
   ```javascript
   localStorage.setItem('persons', JSON.stringify(persons));
   ```

3. **`tags`**: Array JSON con todas las etiquetas
   ```javascript
   localStorage.setItem('tags', JSON.stringify(tags));
   ```

### ¿Cómo funciona el guardado?

**1. Guardado Automático (Debouncing)**
- Cuando escribes en una nota, NO se guarda inmediatamente
- Se espera 400ms después de que dejas de escribir
- Esto evita guardar demasiadas veces y mejora el rendimiento

```javascript
// En note-renderer.js
const SAVE_NOTE_DEBOUNCE_MS = 400;
let saveNoteDebounceTimer = null;

function saveNote() {
    clearTimeout(saveNoteDebounceTimer);
    saveNoteDebounceTimer = setTimeout(() => {
        // Guardar aquí
    }, SAVE_NOTE_DEBOUNCE_MS);
}
```

**2. Sincronización entre Ventanas**
- Cuando guardas una nota, se envía un mensaje a otras ventanas
- La ventana principal actualiza su lista
- El Kanban se actualiza si está abierto

---

## 📡 Comunicación entre Ventanas

### Sistema IPC (Inter-Process Communication)

Electron usa **IPC** para que las ventanas se comuniquen entre sí.

**Concepto**: Es como un sistema de mensajería entre ventanas.

### Flujo de Mensajes

```
Ventana de Nota ──[IPC]──> Proceso Principal ──[IPC]──> Ventana Principal
                                    │
                                    └──[IPC]──> Tablero Kanban
```

### Mensajes Principales

**Desde Ventana de Nota:**
- `note-updated`: Notifica que una nota fue actualizada
- `create-note`: Solicita crear una nueva nota
- `open-kanban`: Solicita abrir el tablero Kanban
- `open-settings`: Solicita abrir configuración

**Desde Proceso Principal:**
- `note-updated`: Notifica a otras ventanas que una nota cambió
- `note-closed`: Notifica que una nota se cerró
- `note-deleted`: Notifica que una nota fue eliminada
- `notes-updated`: Notifica que hay cambios en las notas

**Ejemplo Real:**

```javascript
// En note-renderer.js (cuando guardas una nota)
ipcRenderer.send('note-updated', noteData);

// En main.js (recibe el mensaje)
ipcMain.on('note-updated', (event, noteData) => {
    // Envía a la ventana principal
    mainWindow.webContents.send('note-updated', noteData);
    
    // Envía al Kanban si está abierto
    if (kanbanWindow) {
        kanbanWindow.webContents.send('notes-updated');
    }
});

// En main-renderer.js (recibe la actualización)
ipcRenderer.on('note-updated', (event, noteData) => {
    // Actualizar la lista de notas
    updateNoteInList(noteData);
});
```

---

## 🔄 Flujo de Datos

### Crear una Nueva Nota

1. Usuario hace clic en "Nueva Nota" en ventana principal
2. `main-renderer.js` envía mensaje IPC: `create-note`
3. `main.js` crea nueva ventana de nota con ID único (timestamp)
4. `note-renderer.js` carga la nota vacía
5. Usuario escribe contenido
6. Cada 400ms después de escribir, se guarda en localStorage
7. Se envía mensaje `note-updated` a otras ventanas

### Editar un Bloque

1. Usuario hace clic en el handle (⚙️) de un bloque
2. Se abre menú contextual
3. Usuario cambia estado/prioridad/persona/etiqueta
4. Se actualiza `noteData.blocks[index]`
5. Se guarda en localStorage
6. Se envía mensaje `note-updated`
7. Kanban se actualiza automáticamente

### Actualizar Tablero Kanban

1. Kanban carga todas las notas de localStorage
2. Extrae todos los bloques de todas las notas
3. Los agrupa por estado (Pendiente, En Progreso, Hecho)
4. Aplica filtros si hay
5. Renderiza las tarjetas

**Importante**: El Kanban NO se actualiza automáticamente cada X segundos. Solo se actualiza cuando:
- Recibe mensaje `notes-updated` desde el proceso principal
- El usuario realiza una acción (eliminar bloque, cambiar estado)
- Se abre la ventana del Kanban

---

## ✅ Mejores Prácticas Implementadas

### 1. Debouncing para Guardado

**Problema**: Si guardas en cada tecla presionada, se guarda cientos de veces por segundo.

**Solución**: Esperar 400ms después de que el usuario deja de escribir.

```javascript
// ❌ MAL: Guardar en cada tecla
input.addEventListener('input', () => {
    saveNote(); // Se ejecuta 100 veces por segundo
});

// ✅ BIEN: Debouncing
input.addEventListener('input', () => {
    clearTimeout(saveNoteDebounceTimer);
    saveNoteDebounceTimer = setTimeout(() => {
        saveNote(); // Se ejecuta solo después de 400ms sin escribir
    }, 400);
});
```

### 2. Prevención de Re-renders Innecesarios

**Problema**: Si actualizas la UI cada vez que hay un cambio, puede causar parpadeo.

**Solución**: Verificar si realmente cambió algo antes de renderizar.

```javascript
// En main-renderer.js
let lastNotesHash = '';

function shouldUpdate() {
    const currentHash = JSON.stringify(notes);
    if (currentHash === lastNotesHash) {
        return false; // No cambió nada
    }
    lastNotesHash = currentHash;
    return true; // Sí cambió
}
```

### 3. Gestión de Memoria (Undo Stack)

**Problema**: Guardar todo el historial puede consumir mucha memoria.

**Solución**: Limitar el stack de deshacer a 50 estados.

```javascript
const UNDO_STACK_MAX = 50;
let undoStack = [];

function pushUndoState() {
    undoStack.push(snapshot);
    if (undoStack.length > UNDO_STACK_MAX) {
        undoStack.shift(); // Eliminar el más antiguo
    }
}
```

### 4. Cache de Resúmenes

**Problema**: Generar resúmenes con IA es costoso y lento.

**Solución**: Guardar resúmenes y verificar si el contenido cambió.

```javascript
// Verificar si el contenido cambió
if (note.summary && note.contentHash === contentHash) {
    return note.summary; // Usar resumen guardado
}
```

### 5. Event Delegation

**Problema**: Agregar listeners a cada elemento es ineficiente.

**Solución**: Un solo listener en el contenedor padre.

```javascript
// ❌ MAL: Listener en cada botón
buttons.forEach(btn => {
    btn.addEventListener('click', handler);
});

// ✅ BIEN: Un solo listener
container.addEventListener('click', (e) => {
    if (e.target.classList.contains('button')) {
        handler(e.target);
    }
});
```

### 6. Prevención de Pérdida de Foco

**Problema**: Si actualizas el DOM mientras el usuario escribe, pierde el foco.

**Solución**: No re-renderizar si la ventana actual es la que está escribiendo.

```javascript
// En main.js
ipcMain.on('note-updated', (event, noteData) => {
    const noteWindow = noteWindows.get(noteData.id);
    // NO actualizar si es la misma ventana que envió el mensaje
    if (noteWindow && noteWindow.webContents !== event.sender) {
        noteWindow.webContents.send('note-data-updated', noteData);
    }
});
```

### 7. Optimización de Rendimiento (Visibility API)

**Problema**: Actualizar la UI cuando la ventana está en segundo plano es innecesario.

**Solución**: Solo actualizar cuando la ventana es visible.

```javascript
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Pausar actualizaciones
        clearInterval(updateIntervalId);
    } else {
        // Reanudar actualizaciones
        loadNotes();
    }
});
```

---

## 📁 Estructura de Archivos

```
notas-rapidas-2.2/
│
├── main.js                    # Proceso principal de Electron
│   └── Controla ventanas y comunicación IPC
│
├── index.html                 # Ventana principal
├── main-renderer.js           # Lógica de la ventana principal
├── styles.css                 # Estilos de la ventana principal
│
├── note.html                  # Plantilla de ventana de nota
├── note-renderer.js           # Lógica de edición de notas
├── note-styles.css            # Estilos de notas
│
├── kanban.html                # Tablero Kanban
├── kanban-renderer.js         # Lógica del Kanban
├── kanban-styles.css          # Estilos del Kanban
│
├── settings.html              # Ventana de configuración
├── settings-renderer.js       # Lógica de configuración
├── settings-styles.css        # Estilos de configuración
│
├── closed-notes.html         # Ventana de notas cerradas
├── closed-notes-renderer.js  # Lógica de notas cerradas
│
├── package.json               # Configuración del proyecto
└── assets/
    └── icon.ico               # Icono de la aplicación
```

---

## 🔍 Conceptos Técnicos Importantes

### 1. JSON.stringify / JSON.parse

**¿Qué es?**: Convierte objetos JavaScript a texto (string) y viceversa.

```javascript
// Guardar (objeto → texto)
const objeto = { nombre: "Franco" };
const texto = JSON.stringify(objeto);
// Resultado: '{"nombre":"Franco"}'
localStorage.setItem('data', texto);

// Cargar (texto → objeto)
const textoGuardado = localStorage.getItem('data');
const objetoCargado = JSON.parse(textoGuardado);
// Resultado: { nombre: "Franco" }
```

### 2. Timestamps como IDs

**¿Por qué usar timestamps?**: Son únicos y ordenables.

```javascript
const id = Date.now().toString(); // "1704547200000"
```

### 3. Deep Copy (Copia Profunda)

**Problema**: En JavaScript, `const copia = original` NO copia, solo referencia.

**Solución**: Usar `JSON.parse(JSON.stringify())` para copiar completamente.

```javascript
// ❌ MAL: Solo referencia
const copia = original;
copia.nombre = "Cambio";
// original.nombre también cambió!

// ✅ BIEN: Copia real
const copia = JSON.parse(JSON.stringify(original));
copia.nombre = "Cambio";
// original.nombre NO cambió
```

### 4. ContentEditable

**¿Qué es?**: Permite que un elemento HTML sea editable directamente.

```html
<div contenteditable="true">Puedes editar esto</div>
```

**Ventaja**: Más control sobre el formato.
**Desventaja**: Más complejo de manejar que un `<textarea>`.

---

## 🎯 Resumen Ejecutivo

### ¿Cómo funciona la aplicación?

1. **Inicio**: Se abre la ventana principal, carga notas de localStorage
2. **Crear Nota**: Se crea nueva ventana, se guarda en localStorage
3. **Editar**: Cambios se guardan automáticamente cada 400ms
4. **Sincronización**: Mensajes IPC mantienen todas las ventanas actualizadas
5. **Persistencia**: Todo se guarda en localStorage del navegador

### ¿Dónde está la información?

- **Físicamente**: En el disco duro del usuario (AppData/Roaming)
- **Tecnológicamente**: En localStorage del navegador Electron
- **Formato**: JSON (texto estructurado)

### ¿Cómo se comunican las ventanas?

- **IPC Messages**: Sistema de mensajería de Electron
- **Eventos**: Cuando algo cambia, se envía mensaje a otras ventanas
- **Sincronización**: Cada ventana escucha cambios y se actualiza

---

## 📝 Notas Finales

### Ventajas del Diseño Actual

✅ **Offline**: Funciona sin internet
✅ **Rápido**: localStorage es muy rápido
✅ **Simple**: No necesita base de datos compleja
✅ **Portable**: Los datos están en la computadora del usuario

### Limitaciones

⚠️ **localStorage tiene límite**: ~5-10MB por dominio
⚠️ **No hay sincronización**: Cada instalación es independiente
⚠️ **Sin backup automático**: El usuario debe hacer backup manual

### Posibles Mejoras Futuras

🔮 Exportar/Importar datos
🔮 Backup automático a archivo
🔮 Sincronización en la nube (opcional)
🔮 Base de datos local (IndexedDB) para más capacidad

---

**Última actualización**: Febrero 2026
