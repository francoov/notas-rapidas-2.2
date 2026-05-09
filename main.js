const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// Ruta del icono
const iconPath = path.join(__dirname, 'assets', 'icon.ico');

let mainWindow;
let noteWindows = new Map(); // Map para almacenar ventanas de notas por ID
let kanbanWindow = null;
let dataStore = null;

// Obtener ventana de nota por id (el id puede llegar como string desde la URL o como number desde la lista)
function getNoteWindowById(noteId) {
  if (noteWindows.has(noteId)) return noteWindows.get(noteId);
  const asString = String(noteId);
  if (noteWindows.has(asString)) return noteWindows.get(asString);
  const asNum = Number(noteId);
  if (!isNaN(asNum) && noteWindows.has(asNum)) return noteWindows.get(asNum);
  return null;
}

let settingsWindow = null; // Ventana de configuración
let closedNotesWindow = null; // Ventana de notas cerradas

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: true,
    resizable: true,
    title: 'Notas Rápidas 2',
    backgroundColor: '#333333',
    icon: iconPath
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createNoteWindow(noteId = null, referenceWindow = null) {
  const id = noteId || Date.now().toString();
  
  // Calcular posición desplazada si hay una ventana de referencia
  let x = undefined;
  let y = undefined;
  const offset = 30; // Desplazamiento en píxeles
  
  if (referenceWindow && !referenceWindow.isDestroyed()) {
    const [refX, refY] = referenceWindow.getPosition();
    x = refX + offset;
    y = refY + offset;
  }
  
  const noteWindow = new BrowserWindow({
    width: 500,
    height: 600,
    x: x,
    y: y,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: false,
    alwaysOnTop: false,
    resizable: true,
    backgroundColor: '#333333',
    skipTaskbar: false,
    icon: iconPath
  });

  noteWindow.loadFile('note.html', { query: { id: id } });

  noteWindow.on('closed', () => {
    noteWindows.delete(id);
    // Notificar a la ventana principal que la nota se cerró
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('note-closed', id);
    }
  });

  noteWindows.set(id, noteWindow);
  return id;
}

app.whenReady().then(() => {
  try {
    const { openStore } = require('./db/open');
    dataStore = openStore(app.getPath('userData'));
    console.log('[storage] SQLite backend activo:', dataStore.dbPath);
  } catch (err) {
    dataStore = null;
    console.warn('[storage] SQLite no disponible, usando localStorage. Motivo:', err.message);
  }
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  if (dataStore) {
    dataStore.close();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers
ipcMain.on('storage-get-sync', (event, key) => {
  try {
    if (!dataStore || !dataStore.isSqliteKey(key)) {
      event.returnValue = null;
      return;
    }
    event.returnValue = dataStore.getValue(key);
  } catch (err) {
    event.returnValue = null;
  }
});

ipcMain.on('storage-set-sync', (event, payload) => {
  try {
    const { key, value } = payload || {};
    if (!dataStore || !dataStore.isSqliteKey(key)) {
      event.returnValue = false;
      return;
    }
    dataStore.setValue(key, value);
    event.returnValue = true;
  } catch (err) {
    event.returnValue = false;
  }
});

ipcMain.on('storage-remove-sync', (event, key) => {
  try {
    if (!dataStore || !dataStore.isSqliteKey(key)) {
      event.returnValue = false;
      return;
    }
    dataStore.removeValue(key);
    event.returnValue = true;
  } catch (err) {
    event.returnValue = false;
  }
});

ipcMain.handle('storage-backend', () => {
  return {
    type: dataStore ? 'sqlite' : 'localStorage',
    dbPath: dataStore ? dataStore.dbPath : null
  };
});

ipcMain.on('storage-backend-sync', (event) => {
  event.returnValue = {
    type: dataStore ? 'sqlite' : 'localStorage',
    dbPath: dataStore ? dataStore.dbPath : null
  };
});

ipcMain.on('create-note', (event) => {
  // Obtener la ventana que envió el mensaje para desplazar la nueva nota
  const senderWindow = event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
  const id = createNoteWindow(null, senderWindow);
  if (event.sender) {
    event.reply('note-created', id);
  }
});

ipcMain.on('open-note', (event, noteId) => {
  if (!noteWindows.has(noteId)) {
    createNoteWindow(noteId);
  } else {
    const window = noteWindows.get(noteId);
    if (window && !window.isDestroyed()) {
      window.focus();
    }
  }
});

ipcMain.on('close-note', (event, noteId) => {
  const window = getNoteWindowById(noteId);
  if (window && !window.isDestroyed()) {
    window.close();
  }
});

ipcMain.on('delete-note', (event, noteId) => {
  // Primero notificar a la ventana principal para que actualice la lista (antes de cerrar, así visibilitychange no recarga datos viejos)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('note-deleted', noteId);
  }
  // Luego cerrar la ventana de la nota
  const window = getNoteWindowById(noteId);
  if (window && !window.isDestroyed()) {
    window.close();
  }
});

ipcMain.on('note-updated', (event, noteData) => {
  // Notificar a la ventana principal que la nota se actualizó
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('note-updated', noteData);
  }
  // Notificar al tablero Kanban si está abierto
  if (kanbanWindow && !kanbanWindow.isDestroyed()) {
    kanbanWindow.webContents.send('notes-updated');
  }
  // Notificar a la ventana de la nota si está abierta (pero no a la que envió la actualización,
  // para evitar re-render y pérdida de foco al escribir rápido)
  const noteWindow = noteWindows.get(noteData.id);
  if (noteWindow && !noteWindow.isDestroyed() && noteWindow.webContents !== event.sender) {
    noteWindow.webContents.send('note-data-updated', noteData);
  }
});

ipcMain.on('open-kanban', (event) => {
  if (kanbanWindow && !kanbanWindow.isDestroyed()) {
    kanbanWindow.focus();
    return;
  }

  kanbanWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: true,
    resizable: true,
    title: 'Tablero Kanban',
    backgroundColor: '#333333',
    icon: iconPath
  });

  kanbanWindow.loadFile('kanban.html');

  kanbanWindow.on('closed', () => {
    kanbanWindow = null;
  });
});

ipcMain.on('open-settings', (event) => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 500,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: true,
    resizable: true,
    title: 'Configuración',
    backgroundColor: '#333333',
    icon: iconPath
  });

  settingsWindow.loadFile('settings.html');

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
});

ipcMain.on('open-closed-notes', (event) => {
  if (closedNotesWindow && !closedNotesWindow.isDestroyed()) {
    closedNotesWindow.focus();
    return;
  }

  closedNotesWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: true,
    resizable: true,
    title: 'Notas Cerradas',
    backgroundColor: '#333333',
    icon: iconPath
  });

  closedNotesWindow.loadFile('closed-notes.html');

  closedNotesWindow.on('closed', () => {
    closedNotesWindow = null;
  });
});

ipcMain.on('open-note-from-kanban', (event, noteId, blockIndex) => {
  // Abrir la nota y enfocar el bloque específico
  if (!noteWindows.has(noteId)) {
    createNoteWindow(noteId);
    // Esperar a que la ventana se cargue completamente antes de enviar el mensaje
    const newWindow = noteWindows.get(noteId);
    if (newWindow && !newWindow.isDestroyed()) {
      newWindow.webContents.once('did-finish-load', () => {
        // Esperar un poco más para asegurar que el contenido esté renderizado
        setTimeout(() => {
          newWindow.webContents.send('focus-block', parseInt(blockIndex, 10));
        }, 1000);
      });
    }
  } else {
    const window = noteWindows.get(noteId);
    if (window && !window.isDestroyed()) {
      // Solo enfocar la ventana si no está ya enfocada para evitar parpadeo
      if (!window.isFocused()) {
        window.focus();
      }
      // Enviar mensaje a la ventana de la nota para enfocar el bloque sin delay
      window.webContents.send('focus-block', parseInt(blockIndex, 10));
    }
  }
});

ipcMain.on('focus-main-window', (event) => {
  // Si la ventana principal no existe o está destruida, crearla
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else {
    // Si existe, enfocarla
    mainWindow.focus();
    // Si la ventana está minimizada, restaurarla
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
  }
});

// Exportar datos a archivo (content; opcional: defaultPath, title para diálogo)
ipcMain.handle('export-data', async (event, { content, defaultPath, title }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    title: title || 'Guardar copia de seguridad',
    defaultPath: defaultPath || `notas-rapidas-backup-${Date.now()}.notas-rapidas.json`,
    filters: [
      { name: 'Respaldo Notas Rápidas', extensions: ['notas-rapidas.json'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Todos los archivos', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }
  try {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await fs.writeFile(result.filePath, text, 'utf8');
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Importar datos desde archivo
ipcMain.handle('import-data', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Abrir copia de seguridad',
    properties: ['openFile'],
    filters: [
      { name: 'Respaldo Notas Rápidas', extensions: ['json', 'notas-rapidas.json'] },
      { name: 'Todos los archivos', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
  try {
    const filePath = result.filePaths[0];
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Notificar a otras ventanas tras importar datos (para que refresquen)
ipcMain.on('data-imported', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('data-imported');
  }
  if (kanbanWindow && !kanbanWindow.isDestroyed()) {
    kanbanWindow.webContents.send('data-imported');
  }
  if (closedNotesWindow && !closedNotesWindow.isDestroyed()) {
    closedNotesWindow.webContents.send('data-imported');
  }
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
  if (typeof text === 'string') {
    clipboard.writeText(text);
    return true;
  }
  return false;
});

ipcMain.handle('get-app-version', () => app.getVersion());

