const { ipcRenderer } = require('electron');

let notes = [];
let filteredNotes = [];
let currentSearchQuery = '';

// Cargar notas cerradas del localStorage al iniciar
async function loadNotes() {
    const savedNotes = localStorage.getItem('notes');
    if (savedNotes) {
        notes = JSON.parse(savedNotes);
    }
    
    // Filtrar solo notas cerradas
    const closedNotes = notes.filter(note => {
        return note.status === 'closed' || note.isClosed;
    });
    
    // Aplicar el filtro de búsqueda actual si existe
    if (currentSearchQuery) {
        await searchNotes(currentSearchQuery);
    } else {
        filteredNotes = [...closedNotes];
        await renderNotes();
    }
}

// Guardar notas en localStorage
function saveNotes() {
    localStorage.setItem('notes', JSON.stringify(notes));
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

    if (diffSeconds < 60) {
        return 'Ahora';
    }
    
    if (diffMinutes < 60) {
        return `Hace ${diffMinutes} ${diffMinutes === 1 ? 'minuto' : 'minutos'}`;
    }
    
    if (diffHours < 6) {
        return `Hace ${diffHours} ${diffHours === 1 ? 'hora' : 'horas'}`;
    }
    
    if (diffDays === 0) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        return `${date.getDate()} ${months[date.getMonth()]} ${hours}:${minutes}`;
    }
    
    if (diffDays === 1) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `Ayer ${hours}:${minutes}`;
    }
    
    if (diffDays < 7) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        return `${date.getDate()} ${months[date.getMonth()]} ${hours}:${minutes}`;
    }
    
    const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${date.getDate()} ${months[date.getMonth()]} ${hours}:${minutes}`;
}

// Obtener texto plano del contenido (sin HTML)
function getPlainText(content) {
    if (!content) return '';
    
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
    
    const div = document.createElement('div');
    div.innerHTML = content;
    return div.textContent || div.innerText || '';
}

// Cache de resúmenes
const summaryCache = new Map();

function getContentHash(content) {
    const plainText = getPlainText(content);
    const limitedText = plainText.substring(0, 500);
    return limitedText.substring(0, 100);
}

// Generar resumen con IA
async function generateSummary(content, note) {
    const plainText = getPlainText(content);
    
    if (!plainText || plainText.trim().length === 0) {
        return { text: 'Sin contenido', isEmpty: true };
    }
    
    const limitedText = plainText.substring(0, 500);
    const contentHash = getContentHash(content);
    
    if (note.summary && note.contentHash === contentHash) {
        return { text: note.summary, isEmpty: false };
    }
    
    const cacheKey = `${note.id}_${contentHash}`;
    if (summaryCache.has(cacheKey)) {
        const cachedSummary = summaryCache.get(cacheKey);
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
        
        summaryCache.set(cacheKey, summary);
        note.summary = summary;
        note.contentHash = contentHash;
        
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
        const words = limitedText.split(' ').slice(0, 5).join(' ');
        return { text: words || 'Sin resumen', isEmpty: false };
    }
}

// Renderizar lista de notas
async function renderNotes() {
    const notesList = document.getElementById('notesList');
    const searchInput = document.getElementById('searchInput');
    const searchQuery = searchInput ? searchInput.value.trim() : '';
    
    if (filteredNotes.length === 0) {
        if (searchQuery) {
            notesList.innerHTML = `
                <div class="empty-state">
                    <p>No se encontraron notas cerradas</p>
                    <p>Intenta con otros términos de búsqueda</p>
                </div>
            `;
        } else {
            notesList.innerHTML = `
                <div class="empty-state">
                    <p>No hay notas cerradas</p>
                </div>
            `;
        }
        return;
    }

    const sortedNotes = [...filteredNotes].sort((a, b) => {
        return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
    });

    const notesHTML = await Promise.all(sortedNotes.map(async (note) => {
        const date = formatDate(note.updatedAt || note.createdAt);
        const summaryResult = await generateSummary(note.content || note.blocks, note);
        const summary = summaryResult.text;
        const isEmpty = summaryResult.isEmpty;
        
        return `
            <div class="note-item note-closed" data-note-id="${note.id}">
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
                    <button class="note-action-btn close-btn" data-note-id="${note.id}" data-closed="true" title="Abrir nota">
                        <i data-lucide="check-circle-2" data-icon-name="check-circle-2"></i>
                    </button>
                    <button class="note-action-btn delete-btn" data-note-id="${note.id}" title="Eliminar">
                        <i data-lucide="trash-2" data-icon-name="trash-2"></i>
                    </button>
                </div>
            </div>
        `;
    }));
    
    notesList.innerHTML = notesHTML.join('');

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
    
    document.querySelectorAll('.note-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (!e.target.closest('.delete-btn') && 
                !e.target.closest('.close-btn') && 
                !e.target.closest('.note-actions')) {
                const noteId = item.dataset.noteId;
                ipcRenderer.send('open-note', noteId);
            }
        });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const noteId = btn.dataset.noteId;
            showDeleteModal(noteId);
        });
    });

    document.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const noteId = btn.dataset.noteId;
            await toggleNoteClosed(noteId);
        });
    });
}

// Mostrar modal de confirmación de eliminación
let pendingDeleteNoteId = null;

function showDeleteModal(noteId) {
    pendingDeleteNoteId = noteId;
    const modal = document.getElementById('deleteModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('show');
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

async function deleteNote(noteId) {
    notes = notes.filter(note => note.id !== noteId);
    saveNotes();
    ipcRenderer.send('delete-note', noteId);
    hideDeleteModal();
    await loadNotes();
}

async function toggleNoteClosed(noteId) {
    const note = notes.find(n => n.id === noteId);
    if (note) {
        note.status = 'active';
        note.isClosed = false;
        saveNotes();
        ipcRenderer.send('note-updated', note);
        await loadNotes();
    }
}

// Buscar notas
async function searchNotes(query) {
    const searchQuery = query ? query.trim() : '';
    currentSearchQuery = searchQuery;
    
    const closedNotes = notes.filter(note => {
        return note.status === 'closed' || note.isClosed;
    });
    
    if (!searchQuery) {
        filteredNotes = [...closedNotes];
    } else {
        const lowerQuery = searchQuery.toLowerCase();
        filteredNotes = closedNotes.filter(note => {
            const title = (note.title || '').toLowerCase();
            if (title.includes(lowerQuery)) {
                return true;
            }
            
            if (note.blocks && Array.isArray(note.blocks) && note.blocks.length > 0) {
                const blocksText = note.blocks
                    .map(block => {
                        if (block && block.content) {
                            const div = document.createElement('div');
                            div.innerHTML = block.content || '';
                            return div.textContent || div.innerText || '';
                        }
                        return '';
                    })
                    .filter(text => text.trim() !== '')
                    .join(' ')
                    .toLowerCase();
                
                if (blocksText.includes(lowerQuery)) {
                    return true;
                }
            }
            
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
document.getElementById('notesListBtn').addEventListener('click', () => {
    ipcRenderer.send('focus-main-window');
});

function setupSearchInput() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        
        newSearchInput.addEventListener('input', async (e) => {
            const query = e.target.value || '';
            await searchNotes(query);
        });
        
        newSearchInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                await searchNotes(e.target.value || '');
            }
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSearchInput);
} else {
    setupSearchInput();
}

// Escuchar eventos del proceso principal
ipcRenderer.on('note-updated', async (event, noteData) => {
    await loadNotes();
});

ipcRenderer.on('note-deleted', async (event, noteId) => {
    notes = notes.filter(note => note.id !== noteId);
    saveNotes();
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
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && modal.classList.contains('show')) {
            hideDeleteModal();
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDeleteModal);
} else {
    initDeleteModal();
}

// Cargar notas al iniciar
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        loadNotes();
    });
} else {
    loadNotes();
}

// Actualizar lista periódicamente
setInterval(async () => {
    await loadNotes();
}, 1000);

