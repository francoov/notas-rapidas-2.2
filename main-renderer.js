const { ipcRenderer } = require('electron');
require('./data-store');

let notes = [];
let filteredNotes = [];
let currentSearchQuery = ''; // Guardar la búsqueda actual
let isRendering = false; // Flag para evitar renders simultáneos
let updateIntervalId = null; // ID del intervalo para poder pausarlo
let lastNotesHash = ''; // Hash del estado de notas para detectar cambios

// Cargar notas del localStorage al iniciar
async function loadNotes() {
    const savedNotes = localStorage.getItem('notes');
    if (savedNotes) {
        notes = JSON.parse(savedNotes);
    }
    
    // Filtrar notas cerradas del listado principal
    const activeNotes = notes.filter(note => {
        return !(note.status === 'closed' || note.isClosed);
    });
    
    // Aplicar el filtro de búsqueda actual si existe
    if (currentSearchQuery) {
        await searchNotes(currentSearchQuery);
    } else {
        filteredNotes = [...activeNotes];
        await renderNotes();
    }
}

// Guardar notas en localStorage
function saveNotes() {
    localStorage.setItem('notes', JSON.stringify(notes));
}

// Fecha de hoy en formato DD-MM-AAAA
function getTodayDateString() {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
}

// Comprobar si ya existe una nota (activa o cerrada) con ese título
function hasNoteWithTitle(title) {
    if (!title || !notes.length) return false;
    const normalized = String(title).trim();
    return notes.some(n => (n.title || '').trim() === normalized);
}

// Clave para guardar si se desestimó la recomendación (por fecha)
const DISMISSED_RECOMMENDATION_KEY = 'dismissedDateRecommendation';

function wasDateRecommendationDismissed(dateStr) {
    try {
        return localStorage.getItem(DISMISSED_RECOMMENDATION_KEY) === dateStr;
    } catch (_) {
        return false;
    }
}

function dismissDateRecommendation(dateStr) {
    try {
        localStorage.setItem(DISMISSED_RECOMMENDATION_KEY, dateStr);
    } catch (_) {}
}

// Crear una nota con el título indicado, guardarla y abrirla
function createNoteWithTitle(title) {
    const id = Date.now().toString();
    const now = new Date().toISOString();
    const newNote = {
        id,
        title: title || '',
        blocks: [],
        createdAt: now,
        updatedAt: now,
        status: 'active',
        isClosed: false
    };
    notes.push(newNote);
    saveNotes();
    ipcRenderer.send('open-note', id);
}

// HTML de la card de recomendación (nota del día): clic en la card = crear y abrir, solo X para desestimar
function getRecommendationCardHTML(todayStr) {
    return `
        <div class="note-item note-item-recommendation" data-recommendation-date="${todayStr}" data-date="${todayStr}">
            <div class="note-item-header">
                <div class="note-title-wrapper">
                    <div class="note-title">${todayStr}</div>
                </div>
            </div>
            <div class="note-preview note-preview-recommendation">Recomendación: crea una nota para hoy</div>
            <div class="note-actions">
                <button type="button" class="note-action-btn dismiss-recommendation-btn" data-date="${todayStr}" title="Desestimar">
                    <i data-lucide="x" data-icon-name="x"></i>
                </button>
            </div>
        </div>
    `;
}

function initRecommendationIcons(container) {
    if (!container) return;
    const rec = container.querySelector('.note-item-recommendation');
    if (rec && typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            rec.querySelectorAll('[data-lucide]').forEach(el => {
                if (!el.querySelector('svg')) lucide.createIcons();
            });
        });
    }
}

// Mostrar recomendación de nota del día solo si no existe nota con ese título y no se desestimó hoy
function shouldShowDateRecommendation() {
    const todayStr = getTodayDateString();
    if (hasNoteWithTitle(todayStr)) return false;
    if (wasDateRecommendationDismissed(todayStr)) return false;
    return true;
}

// Formatear fecha
function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffTime / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffTime / (1000 * 60));
    const diffSeconds = Math.floor(diffTime / 1000);

    // Si es menos de 1 minuto
    if (diffSeconds < 60) {
        return 'Ahora';
    }
    
    // Si es menos de 1 hora, mostrar minutos
    if (diffMinutes < 60) {
        return `Hace ${diffMinutes} ${diffMinutes === 1 ? 'minuto' : 'minutos'}`;
    }
    
    // Si es menos de 6 horas, mostrar horas
    if (diffHours < 6) {
        return `Hace ${diffHours} ${diffHours === 1 ? 'hora' : 'horas'}`;
    }
    
    // Si es más de 6 horas pero es hoy, mostrar fecha y hora
    if (diffDays === 0) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        return `${date.getDate()} ${months[date.getMonth()]} ${hours}:${minutes}`;
    }
    
    // Si es ayer
    if (diffDays === 1) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `Ayer ${hours}:${minutes}`;
    }
    
    // Si es hace menos de 7 días
    if (diffDays < 7) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        return `${date.getDate()} ${months[date.getMonth()]} ${hours}:${minutes}`;
    }
    
    // Si es más antiguo, mostrar fecha completa
    const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${date.getDate()} ${months[date.getMonth()]} ${hours}:${minutes}`;
}

// Obtener texto plano del contenido (sin HTML)
function getPlainText(content) {
    if (!content) return '';
    
    // Si hay bloques, obtener contenido de todos los bloques
    if (Array.isArray(content) && content.length > 0) {
        const blocksWithContent = content.filter(block => block && block.content && block.content.trim());
        if (blocksWithContent.length > 0) {
            const texts = blocksWithContent.map(block => {
                const div = document.createElement('div');
                div.innerHTML = block.content;
                return div.textContent || div.innerText || '';
            });
            return texts.join(' ').trim();
        }
    }
    
    // Fallback: tratar como HTML
    const div = document.createElement('div');
    div.innerHTML = content;
    return div.textContent || div.innerText || '';
}

// Cache de resúmenes para evitar llamadas repetidas
const summaryCache = new Map();

// Generar hash simple del contenido para comparar
function getContentHash(content) {
    const plainText = getPlainText(content);
    const limitedText = plainText.substring(0, 500);
    return limitedText.substring(0, 100); // Usar primeros 100 caracteres como hash
}

// Generar resumen con IA
async function generateSummary(content, note) {
    const plainText = getPlainText(content);
    
    // Si no hay contenido, retornar texto por defecto (no llamar a la API)
    if (!plainText || plainText.trim().length === 0) {
        return { text: 'Sin contenido', isEmpty: true };
    }
    
    // Limitar a los primeros 500 caracteres
    const limitedText = plainText.substring(0, 500);
    const contentHash = getContentHash(content);
    
    // Verificar si la nota ya tiene un resumen guardado y si el contenido no cambió
    if (note.summary && note.contentHash === contentHash) {
        return { text: note.summary, isEmpty: false };
    }
    
    // Verificar cache
    const cacheKey = `${note.id}_${contentHash}`;
    if (summaryCache.has(cacheKey)) {
        const cachedSummary = summaryCache.get(cacheKey);
        // Guardar en la nota
        note.summary = cachedSummary;
        note.contentHash = contentHash;
        return { text: cachedSummary, isEmpty: false };
    }
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'Eres un asistente que genera resúmenes concisos. Responde SOLO con un resumen de máximo 5 palabras, sin explicaciones adicionales.'
                    },
                    {
                        role: 'user',
                        content: `Genera un resumen de máximo 5 palabras del siguiente texto: ${limitedText}`
                    }
                ],
                max_tokens: 20,
                temperature: 0.3
            })
        });
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        const summary = data.choices[0]?.message?.content?.trim() || 'Sin resumen';
        
        // Guardar en cache
        summaryCache.set(cacheKey, summary);
        
        // Guardar en la nota
        note.summary = summary;
        note.contentHash = contentHash;
        
        // Guardar la nota actualizada en localStorage
        const savedNotes = localStorage.getItem('notes');
        if (savedNotes) {
            const notes = JSON.parse(savedNotes);
            const index = notes.findIndex(n => n.id === note.id);
            if (index !== -1) {
                notes[index].summary = summary;
                notes[index].contentHash = contentHash;
                localStorage.setItem('notes', JSON.stringify(notes));
            }
        }
        
        return { text: summary, isEmpty: false };
    } catch (error) {
        console.error('Error generando resumen:', error);
        // Fallback: usar primeras palabras del texto limitado
        const words = limitedText.split(' ').slice(0, 5).join(' ');
        return { text: words || 'Sin resumen', isEmpty: false };
    }
}

// Generar hash simple del estado de notas para detectar cambios
function getNotesHash() {
    const notesData = notes.map(n => ({
        id: n.id,
        title: n.title,
        updatedAt: n.updatedAt,
        status: n.status,
        isClosed: n.isClosed
    }));
    return JSON.stringify(notesData);
}

// Renderizar lista de notas
async function renderNotes() {
    // Evitar renders simultáneos
    if (isRendering) {
        return;
    }
    
    const notesList = document.getElementById('notesList');
    if (!notesList) return;
    
    const searchInput = document.getElementById('searchInput');
    const searchQuery = searchInput ? searchInput.value.trim() : '';
    
    // Calcular hash del estado actual
    const currentHash = getNotesHash();
    
    // Si no hay cambios reales y ya hay contenido renderizado, no re-renderizar
    if (currentHash === lastNotesHash && notesList.innerHTML.trim() !== '') {
        return;
    }
    
    isRendering = true;
    lastNotesHash = currentHash;
    
    try {
        const showRecommendation = !searchQuery && shouldShowDateRecommendation();
        const todayStr = getTodayDateString();

        if (filteredNotes.length === 0) {
            let html = '';
            if (showRecommendation) {
                html += getRecommendationCardHTML(todayStr);
            }
            if (searchQuery) {
                html += `
                    <div class="empty-state">
                        <p>No se encontraron notas</p>
                        <p>Intenta con otros términos de búsqueda</p>
                    </div>
                `;
            } else {
                html += `
                    <div class="empty-state">
                        <p>No hay notas</p>
                        <p>Haz clic en + para crear una nueva nota</p>
                    </div>
                `;
            }
            notesList.innerHTML = html;
            if (showRecommendation) initRecommendationIcons(notesList);
            return;
        }

        // Ordenar por fecha (más recientes primero)
        const sortedNotes = [...filteredNotes].sort((a, b) => {
            return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
        });

        // Renderizar notas con resúmenes
        const notesHTML = await Promise.all(sortedNotes.map(async (note) => {
            const date = formatDate(note.updatedAt || note.createdAt);
            const isClosed = note.status === 'closed' || note.isClosed;
            const summaryResult = await generateSummary(note.content || note.blocks, note);
            const summary = summaryResult.text;
            const isEmpty = summaryResult.isEmpty;
            const closeIcon = isClosed ? 'check-circle-2' : 'circle';
            
            return `
                <div class="note-item ${isClosed ? 'note-closed' : ''}" data-note-id="${note.id}">
                    <div class="note-item-header">
                        <div class="note-title-wrapper">
                            <div class="note-title">${note.title || 'Sin título'}</div>
                        </div>
                        <div class="note-header-right">
                            <div class="note-date">${date}</div>
                        </div>
                    </div>
                    <div class="note-preview ${isEmpty ? 'note-preview-empty' : ''}">${summary}</div>
                    <div class="note-actions">
                        <button class="note-action-btn close-btn" data-note-id="${note.id}" data-closed="${isClosed}" title="${isClosed ? 'Abrir nota' : 'Cerrar nota'}">
                            <i data-lucide="${closeIcon}" data-icon-name="${closeIcon}"></i>
                        </button>
                        <button class="note-action-btn delete-btn" data-note-id="${note.id}" title="Eliminar">
                            <i data-lucide="trash-2" data-icon-name="trash-2"></i>
                        </button>
                    </div>
                </div>
            `;
        }));

        let fullHTML = '';
        if (showRecommendation) {
            fullHTML += getRecommendationCardHTML(todayStr);
        }
        fullHTML += notesHTML.join('');
        notesList.innerHTML = fullHTML;

        if (showRecommendation) initRecommendationIcons(notesList);

        // Inicializar iconos de Lucide solo una vez después de renderizar
        if (typeof lucide !== 'undefined') {
            requestAnimationFrame(() => {
                const icons = notesList.querySelectorAll('[data-lucide]');
                icons.forEach(icon => {
                    if (!icon.querySelector('svg')) {
                        lucide.createIcons();
                    }
                });
            });
        }
    } finally {
        isRendering = false;
    }
}

// Mostrar modal de confirmación de eliminación
let pendingDeleteNoteId = null;

function showDeleteModal(noteId) {
    pendingDeleteNoteId = noteId;
    const modal = document.getElementById('deleteModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('show');
    } else {
        console.error('Modal no encontrado');
    }
}

function hideDeleteModal() {
    pendingDeleteNoteId = null;
    const modal = document.getElementById('deleteModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
}

// Modal de mensaje (mismo estilo que eliminación / configuración)
function showMessage(title, message) {
    const modal = document.getElementById('messageModal');
    const titleEl = document.getElementById('messageModalTitle');
    const messageEl = document.getElementById('messageModalMessage');
    const okBtn = document.getElementById('messageModalOkBtn');
    if (!modal || !titleEl || !messageEl || !okBtn) return;
    titleEl.textContent = title;
    messageEl.textContent = message;
    modal.style.display = 'flex';
    modal.classList.add('show');
    const close = () => {
        modal.style.display = 'none';
        modal.classList.remove('show');
        okBtn.removeEventListener('click', close);
        modal.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onEscape);
    };
    const onOverlay = (e) => { if (e.target === modal) close(); };
    const onEscape = (e) => { if (e.key === 'Escape') close(); };
    okBtn.addEventListener('click', close);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onEscape);
}

// Modal de confirmación (importar datos)
let confirmModalResolve = null;

function showConfirm(title, message) {
    return new Promise((resolve) => {
        confirmModalResolve = resolve;
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmModalTitle');
        const messageEl = document.getElementById('confirmModalMessage');
        const cancelBtn = document.getElementById('confirmModalCancelBtn');
        const okBtn = document.getElementById('confirmModalOkBtn');
        if (!modal || !titleEl || !messageEl || !cancelBtn || !okBtn) {
            resolve(false);
            return;
        }
        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.style.display = 'flex';
        modal.classList.add('show');
        const close = (result) => {
            modal.style.display = 'none';
            modal.classList.remove('show');
            confirmModalResolve = null;
            cancelBtn.removeEventListener('click', onCancel);
            okBtn.removeEventListener('click', onOk);
            modal.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onEscape);
            resolve(result);
        };
        const onCancel = () => close(false);
        const onOk = () => close(true);
        const onOverlay = (e) => { if (e.target === modal) close(false); };
        const onEscape = (e) => { if (e.key === 'Escape') close(false); };
        cancelBtn.addEventListener('click', onCancel);
        okBtn.addEventListener('click', onOk);
        modal.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onEscape);
    });
}

// Eliminar nota
async function deleteNote(noteId) {
    notes = notes.filter(note => note.id !== noteId);
    saveNotes();
    ipcRenderer.send('delete-note', noteId);
    hideDeleteModal();
    await loadNotes();
}

// Cerrar/abrir nota
async function toggleNoteClosed(noteId) {
    const note = notes.find(n => n.id === noteId);
    if (note) {
        const previousStatus = note.status === 'closed' || note.isClosed;
        if (previousStatus) {
            note.status = 'active';
            note.isClosed = false;
        } else {
            note.status = 'closed';
            note.isClosed = true;
            // Cerrar la ventana si está abierta
            ipcRenderer.send('close-note', noteId);
        }
        // NO actualizar updatedAt para mantener la posición en la lista
        saveNotes();
        ipcRenderer.send('note-updated', note);
        await loadNotes();
    }
}

// Buscar notas
async function searchNotes(query) {
    const searchQuery = query ? query.trim() : '';
    currentSearchQuery = searchQuery; // Guardar la búsqueda actual
    
    // Filtrar notas cerradas del listado principal
    const activeNotes = notes.filter(note => {
        return !(note.status === 'closed' || note.isClosed);
    });
    
    if (!searchQuery) {
        filteredNotes = [...activeNotes];
    } else {
        const lowerQuery = searchQuery.toLowerCase();
        filteredNotes = activeNotes.filter(note => {
            // Buscar en el título
            const title = (note.title || '').toLowerCase();
            if (title.includes(lowerQuery)) {
                return true;
            }
            
            // Buscar en el contenido de los bloques
            if (note.blocks && Array.isArray(note.blocks) && note.blocks.length > 0) {
                const blocksText = note.blocks
                    .map(block => {
                        if (block && block.content) {
                            // Extraer texto plano del HTML
                            const div = document.createElement('div');
                            div.innerHTML = block.content || '';
                            return div.textContent || div.innerText || '';
                        }
                        return '';
                    })
                    .filter(text => text.trim() !== '') // Filtrar bloques vacíos
                    .join(' ')
                    .toLowerCase();
                
                if (blocksText.includes(lowerQuery)) {
                    return true;
                }
            }
            
            // Buscar en contenido antiguo (formato legacy)
            if (note.content) {
                const plainText = getPlainText(note.content).toLowerCase();
                if (plainText.includes(lowerQuery)) {
                    return true;
                }
            }
            
            return false;
        });
    }
    await renderNotes();
}

// Event Listeners
document.getElementById('newNoteBtn').addEventListener('click', () => {
    ipcRenderer.send('create-note');
});

// Menú de opciones
let optionsMenuOpen = false;

function toggleOptionsMenu() {
    const menu = document.getElementById('optionsMenu');
    optionsMenuOpen = !optionsMenuOpen;
    if (optionsMenuOpen) {
        menu.classList.add('show');
        // Inicializar iconos
        if (typeof lucide !== 'undefined') {
            requestAnimationFrame(() => {
                lucide.createIcons();
            });
        }
    } else {
        menu.classList.remove('show');
    }
}

function closeOptionsMenu() {
    const menu = document.getElementById('optionsMenu');
    menu.classList.remove('show');
    optionsMenuOpen = false;
}

document.getElementById('optionsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOptionsMenu();
});

document.getElementById('kanbanMenuBtn').addEventListener('click', () => {
    closeOptionsMenu();
    ipcRenderer.send('open-kanban');
});

document.getElementById('closedNotesMenuBtn').addEventListener('click', () => {
    closeOptionsMenu();
    ipcRenderer.send('open-closed-notes');
});

document.getElementById('settingsMenuBtn').addEventListener('click', () => {
    closeOptionsMenu();
    ipcRenderer.send('open-settings');
});

// Exportar datos a archivo
async function exportData() {
    const notesData = localStorage.getItem('notes');
    const personsData = localStorage.getItem('persons');
    const tagsData = localStorage.getItem('tags');
    const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        notes: notesData ? JSON.parse(notesData) : [],
        persons: personsData ? JSON.parse(personsData) : [],
        tags: tagsData ? JSON.parse(tagsData) : []
    };
    const content = JSON.stringify(payload, null, 2);
    try {
        const result = await ipcRenderer.invoke('export-data', { content });
        if (result.canceled) return;
        if (result.success) {
            showMessage('Exportar datos', `Copia de seguridad guardada en:\n${result.path}`);
        } else {
            showMessage('Error al exportar', result.error || 'Error desconocido');
        }
    } catch (err) {
        showMessage('Error al exportar', err.message);
    }
}

// Importar datos desde archivo
async function importData() {
    try {
        const result = await ipcRenderer.invoke('import-data');
        if (result.canceled) return;
        if (!result.success) {
            showMessage('Error al importar', result.error ? `Error al leer el archivo: ${result.error}` : 'El archivo no es un respaldo válido de Notas Rápidas.');
            return;
        }
        const data = result.data;
        if (!data || typeof data !== 'object' || !Array.isArray(data.notes)) {
            showMessage('Error al importar', 'El archivo no es un respaldo válido de Notas Rápidas.');
            return;
        }
        const confirmed = await showConfirm('Importar datos', 'Se reemplazarán todos los datos actuales con los del archivo. ¿Continuar?');
        if (!confirmed) return;
        localStorage.setItem('notes', JSON.stringify(data.notes));
        localStorage.setItem('persons', JSON.stringify(Array.isArray(data.persons) ? data.persons : []));
        localStorage.setItem('tags', JSON.stringify(Array.isArray(data.tags) ? data.tags : []));
        ipcRenderer.send('data-imported');
        await loadNotes();
        showMessage('Importar datos', 'Datos importados correctamente.');
    } catch (err) {
        showMessage('Error al importar', err.message);
    }
}

document.getElementById('exportDataMenuBtn').addEventListener('click', () => {
    closeOptionsMenu();
    exportData();
});

document.getElementById('importDataMenuBtn').addEventListener('click', () => {
    closeOptionsMenu();
    importData();
});

// Cerrar menú al hacer click fuera
document.addEventListener('click', (e) => {
    const menu = document.getElementById('optionsMenu');
    const btn = document.getElementById('optionsBtn');
    if (menu && menu.classList.contains('show') && 
        !menu.contains(e.target) && 
        !btn.contains(e.target)) {
        closeOptionsMenu();
    }
});


// Event listener para el buscador
function setupSearchInput() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        // Remover listeners anteriores si existen
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        
        newSearchInput.addEventListener('input', async (e) => {
            const query = e.target.value || '';
            await searchNotes(query);
        });
        
        // También buscar al presionar Enter
        newSearchInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                await searchNotes(e.target.value || '');
            }
        });
    } else {
        console.error('searchInput no encontrado en el DOM');
    }
}

// Configurar el buscador cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSearchInput);
} else {
    setupSearchInput();
}

// Escuchar eventos del proceso principal
ipcRenderer.on('note-created', async (event, noteId) => {
    // La nota se guardará desde la ventana de la nota
    await loadNotes();
});

ipcRenderer.on('note-updated', async (event, noteData) => {
    const index = notes.findIndex(note => note.id === noteData.id);
    if (index !== -1) {
        const oldNote = notes[index];
        const newContentHash = getContentHash(noteData.content || noteData.blocks);
        
        // Si el contenido cambió, eliminar el resumen para que se regenere
        if (oldNote.contentHash !== newContentHash) {
            delete noteData.summary;
            delete noteData.contentHash;
        } else {
            // Mantener el resumen existente si el contenido no cambió
            noteData.summary = oldNote.summary;
            noteData.contentHash = oldNote.contentHash;
        }
        
        // Preservar updatedAt si el nuevo noteData no tiene uno más reciente
        // (para evitar que movimientos en Kanban sobrescriban la fecha de última modificación real)
        if (noteData.updatedAt) {
            const oldTime = new Date(oldNote.updatedAt || 0).getTime();
            const newTime = new Date(noteData.updatedAt).getTime();
            // Solo actualizar updatedAt si el nuevo es más reciente que el anterior
            if (newTime <= oldTime) {
                // Mantener el updatedAt anterior si el nuevo no es más reciente
                noteData.updatedAt = oldNote.updatedAt;
            }
        } else {
            // Si no viene updatedAt (desde Kanban), mantener el anterior
            noteData.updatedAt = oldNote.updatedAt;
        }
        
        notes[index] = { ...notes[index], ...noteData };
    } else {
        notes.push(noteData);
    }
    saveNotes();
    await loadNotes();
});

ipcRenderer.on('note-deleted', async (event, noteId) => {
    // Actualizar localStorage de forma síncrona para que, si visibilitychange dispara loadNotes() al cerrar la ventana, ya esté actualizado
    const savedNotes = localStorage.getItem('notes');
    let notesFromStorage = savedNotes ? JSON.parse(savedNotes) : [];
    notesFromStorage = notesFromStorage.filter(note => note.id != noteId);
    localStorage.setItem('notes', JSON.stringify(notesFromStorage));
    notes = notesFromStorage;
    // Limpiar cache del resumen para esta nota
    const cacheKeys = Array.from(summaryCache.keys()).filter(key => key.startsWith(String(noteId) + '_'));
    cacheKeys.forEach(key => summaryCache.delete(key));
    await loadNotes();
});

ipcRenderer.on('data-imported', async () => {
    await loadNotes();
});

// Inicializar event listeners del modal
function initDeleteModal() {
    const modal = document.getElementById('deleteModal');
    const cancelBtn = document.getElementById('modalCancelBtn');
    const confirmBtn = document.getElementById('modalConfirmBtn');
    
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            hideDeleteModal();
        });
    }
    
    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            if (pendingDeleteNoteId) {
                await deleteNote(pendingDeleteNoteId);
            }
        });
    }
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideDeleteModal();
            }
        });
    }
    
    // Cerrar con Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && modal.classList.contains('show')) {
            hideDeleteModal();
        }
    });
}

// Inicializar cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDeleteModal);
} else {
    initDeleteModal();
}

// Event delegation para evitar acumulación de listeners
function setupEventDelegation() {
    const notesList = document.getElementById('notesList');
    if (!notesList) return;
    
    // Usar un solo listener en el contenedor (event delegation)
    notesList.addEventListener('click', (e) => {
        // Desestimar recomendación (solo el botón X)
        const dismissBtn = e.target.closest('.dismiss-recommendation-btn');
        if (dismissBtn) {
            e.stopPropagation();
            const dateStr = dismissBtn.getAttribute('data-date');
            if (dateStr) {
                dismissDateRecommendation(dateStr);
                loadNotes();
            }
            return;
        }

        // Clic en la card de recomendación (cualquier parte salvo la X) = crear y abrir nota del día
        const recCard = e.target.closest('.note-item-recommendation');
        if (recCard) {
            const dateStr = recCard.getAttribute('data-date');
            if (dateStr) {
                createNoteWithTitle(dateStr);
                loadNotes();
            }
            return;
        }

        const noteItem = e.target.closest('.note-item');
        if (!noteItem) return;
        
        const noteId = noteItem.dataset.noteId;
        
        // Click en botón eliminar
        if (e.target.closest('.delete-btn')) {
            e.stopPropagation();
            showDeleteModal(noteId);
            return;
        }
        
        // Click en botón cerrar/abrir
        if (e.target.closest('.close-btn')) {
            e.stopPropagation();
            toggleNoteClosed(noteId);
            return;
        }
        
        // Click en el item (pero no en los botones)
        if (!e.target.closest('.note-actions')) {
            ipcRenderer.send('open-note', noteId);
        }
    });
}

// Cargar notas al iniciar
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        loadNotes();
        setupEventDelegation();
    });
} else {
    loadNotes();
    setupEventDelegation();
}

// Pausar intervalo cuando la ventana está en segundo plano
let isWindowVisible = true;
document.addEventListener('visibilitychange', () => {
    isWindowVisible = !document.hidden;
    if (isWindowVisible) {
        // Reanudar actualización cuando vuelve a primer plano
        if (!updateIntervalId) {
            startUpdateInterval();
        }
        // Cargar notas inmediatamente al volver
        loadNotes();
    } else {
        // Pausar cuando va a segundo plano
        if (updateIntervalId) {
            clearInterval(updateIntervalId);
            updateIntervalId = null;
        }
    }
});

// Función para iniciar el intervalo de actualización
function startUpdateInterval() {
    if (updateIntervalId) {
        clearInterval(updateIntervalId);
    }
    updateIntervalId = setInterval(async () => {
        // Solo actualizar si la ventana está visible y no está renderizando
        if (isWindowVisible && !isRendering) {
            await loadNotes();
        }
    }, 2000); // Aumentar a 2 segundos para reducir carga
}

// Iniciar intervalo de actualización
startUpdateInterval();

