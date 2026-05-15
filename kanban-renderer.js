const { ipcRenderer } = require('electron');
require('./data-store');
const {
    createLoadingController,
    createKanbanSkeleton,
    createPersonMetricsSkeleton
} = require('./skeleton-loader');

let allBlocks = []; // Array de todos los bloques con sus notas
let filteredBlocks = []; // Array de bloques filtrados según los filtros activos
let lastBlocksHash = null; // Hash de los bloques para comparar cambios

// Estado de ordenamiento por columna: null = sin ordenar, 'asc' = ascendente, 'desc' = descendente
const sortState = {
    'pendiente': null,
    'en-progreso': null,
    'hecho': null
};

// Estado de filtros globales
const filters = {
    personId: null, // ID de la persona asignada (null = todas)
    priority: null, // Prioridad (null = todas)
    tagId: null,     // ID de la etiqueta (null = todas)
    daysFilter: null // Días para filtrar por fecha de creación (null = sin filtro)
};
const KANBAN_LOADER_LEAD_MS = 180;

const kanbanLoadingController = createLoadingController({
    onShow: () => {
        const board = document.querySelector('.kanban-board');
        if (board) board.setAttribute('aria-busy', 'true');

        ['pendiente', 'en-progreso', 'hecho'].forEach(status => {
            const column = document.getElementById(`column-${status}`);
            if (column) {
                column.innerHTML = createKanbanSkeleton(3);
            }
        });

        const metrics = document.getElementById('personMetrics');
        if (metrics) {
            metrics.style.display = 'flex';
            metrics.innerHTML = createPersonMetricsSkeleton(7);
        }
    },
    onHide: () => {
        const board = document.querySelector('.kanban-board');
        if (board) board.removeAttribute('aria-busy');
    },
    delayMs: 0,
    minVisibleMs: 420
});

// Generar iniciales de una persona
function getPersonInitials(firstName, lastName) {
    const first = firstName ? firstName.charAt(0).toUpperCase() : '';
    const last = lastName ? lastName.charAt(0).toUpperCase() : '';
    return first + last;
}

// Generar hash de los bloques para comparar cambios
function generateBlocksHash(blocks) {
    return blocks.map(block => {
        const personId = block.assignedPerson ? block.assignedPerson.id : '';
        const tagId = block.tag ? block.tag.id : '';
        return `${block.noteId}-${block.blockIndex}-${block.status}-${block.priority}-${personId}-${tagId}-${block.content.substring(0, 50)}-${block.isClosed}`;
    }).join('|');
}

// Aplicar filtros a los bloques
function applyFilters(blocks) {
    return blocks.filter(block => {
        // Filtro por persona asignada
        if (filters.personId) {
            if (!block.assignedPerson || block.assignedPerson.id !== filters.personId) {
                return false;
            }
        }
        
        // Filtro por prioridad
        if (filters.priority) {
            if (!block.priority || block.priority !== filters.priority) {
                return false;
            }
        }
        
        // Filtro por etiqueta
        if (filters.tagId) {
            if (!block.tag || block.tag.id !== filters.tagId) {
                return false;
            }
        }
        
        // Filtro por días de creación reciente
        if (filters.daysFilter !== null && filters.daysFilter > 0) {
            // Usar createdAt del bloque o de la nota como fallback
            const createdAt = block.createdAt;
            if (!createdAt) {
                return false; // Si no tiene fecha de creación, excluir
            }
            
            try {
                const creationDate = new Date(createdAt);
                const now = new Date();
                
                // Validar que la fecha sea válida
                if (isNaN(creationDate.getTime())) {
                    return false;
                }
                
                // Calcular diferencia en días (redondear hacia abajo)
                const diffTime = now.getTime() - creationDate.getTime();
                const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                
                // Incluir bloques creados dentro del período (menor o igual al número de días)
                // diffDays = 0 significa hoy, 1 = ayer, etc.
                if (diffDays > filters.daysFilter) {
                    return false; // Excluir si es más antiguo que el filtro
                }
            } catch (e) {
                console.error('Error calculando fecha de creación:', e, createdAt);
                return false; // Si hay error, excluir
            }
        }
        
        return true;
    });
}

// Cargar todas las notas y extraer bloques con estado
function loadBlocks(forceRender = false, options = {}) {
    const { showLoader = forceRender, __deferred = false } = options;

    if (showLoader && !__deferred) {
        const stopLoading = kanbanLoadingController.start();
        setTimeout(() => {
            try {
                loadBlocks(forceRender, { showLoader: false, __deferred: true });
            } finally {
                Promise.resolve(stopLoading()).catch(() => {});
            }
        }, KANBAN_LOADER_LEAD_MS);
        return;
    }

    const savedNotes = localStorage.getItem('notes');
    if (!savedNotes) {
        allBlocks = [];
        lastBlocksHash = null;
        renderKanban();
        return;
    }

    const notes = JSON.parse(savedNotes);
    const newBlocks = [];

    notes.forEach(note => {
        if (!note.blocks || !Array.isArray(note.blocks)) {
            return;
        }

        note.blocks.forEach((block, blockIndex) => {
            // Solo incluir bloques que tengan un estado asignado
            if (block.status && block.status !== '') {
                // Extraer texto plano del contenido HTML
                const div = document.createElement('div');
                div.innerHTML = block.content || '';
                const plainText = div.textContent || div.innerText || '';
                
                newBlocks.push({
                    noteId: note.id,
                    noteTitle: note.title || 'Sin título',
                    blockIndex: blockIndex,
                    content: plainText,
                    status: block.status,
                    priority: block.priority || '',
                    assignedPerson: block.assignedPerson || null,
                    tag: block.tag || null, // Usar etiqueta del bloque
                    marked: block.marked || false,
                    isClosed: note.status === 'closed' || note.isClosed || false,
                    blockUpdatedAt: block.blockUpdatedAt || block.createdAt || note.updatedAt || note.createdAt || new Date().toISOString(),
                    createdAt: block.createdAt || note.createdAt || new Date().toISOString()
                });
            }
        });
    });

    // Guardar todos los bloques sin filtrar
    allBlocks = newBlocks;
    
    // Aplicar filtros para renderizado
    filteredBlocks = applyFilters(newBlocks);
    
    // Generar hash de los bloques filtrados
    const newHash = generateBlocksHash(filteredBlocks);
    
    // Solo re-renderizar si hay cambios o si se fuerza
    if (forceRender || newHash !== lastBlocksHash) {
        const wasEmpty = filteredBlocks.length === 0;
        lastBlocksHash = newHash;
        
        // Si estaba vacío o se fuerza, hacer renderizado completo
        // Si no, usar actualización incremental
        renderKanban(!forceRender && !wasEmpty);
        renderPersonMetrics();
    }
}

// Cache de tarjetas para evitar recrearlas innecesariamente
const cardCache = new Map(); // Map<noteId-blockIndex, HTMLElement>

// Renderizar el tablero Kanban
function renderKanban(onlyUpdateChanged = false) {
    // Si solo actualizamos cambios, usar renderizado incremental
    if (onlyUpdateChanged) {
        updateKanbanIncremental();
        return;
    }

    // Limpiar cache y columnas para renderizado completo
    cardCache.clear();
    document.getElementById('column-pendiente').innerHTML = '';
    document.getElementById('column-en-progreso').innerHTML = '';
    document.getElementById('column-hecho').innerHTML = '';

    // Contadores
    const counts = {
        'pendiente': 0,
        'en-progreso': 0,
        'hecho': 0
    };

    // Agrupar bloques por estado
    const blocksByStatus = {
        'pendiente': [],
        'en-progreso': [],
        'hecho': []
    };

    // Usar bloques filtrados para renderizar
    filteredBlocks.forEach(block => {
        if (blocksByStatus[block.status]) {
            blocksByStatus[block.status].push(block);
            counts[block.status]++;
        }
    });

    // Renderizar cada columna
    Object.keys(blocksByStatus).forEach(status => {
        const column = document.getElementById(`column-${status}`);
        const columnBlocks = blocksByStatus[status];

        columnBlocks.forEach(block => {
            const card = createCard(block);
            column.appendChild(card);
            // Guardar en cache
            const cacheKey = `${block.noteId}-${block.blockIndex}`;
            cardCache.set(cacheKey, card);
        });

        // Actualizar contador
        document.getElementById(`count-${status}`).textContent = counts[status];
    });

    // Configurar drag and drop en las columnas
    setupColumnDropZones();
    renderPersonMetrics();
}

// Actualización incremental del Kanban (solo actualiza lo que cambió)
function updateKanbanIncremental() {
    // Si el cache está vacío, hacer renderizado completo
    if (cardCache.size === 0) {
        renderKanban(false);
        return;
    }

    // Asegurar que filteredBlocks esté actualizado antes de usarlo
    filteredBlocks = applyFilters(allBlocks);

    // Crear un mapa de los bloques actuales (usar bloques filtrados)
    const currentBlocksMap = new Map();
    filteredBlocks.forEach(block => {
        const key = `${block.noteId}-${block.blockIndex}`;
        currentBlocksMap.set(key, block);
    });

    // Encontrar tarjetas que ya no existen o cambiaron de estado
    const cardsToRemove = [];
    const cardsToMove = [];
    
    cardCache.forEach((card, key) => {
        const block = currentBlocksMap.get(key);
        if (!block) {
            // El bloque ya no existe o no pasa los filtros, marcar para eliminar
            cardsToRemove.push(card);
            cardCache.delete(key);
        } else if (card.dataset.status !== block.status) {
            // El bloque cambió de estado, marcar para mover
            cardsToMove.push({ card, newStatus: block.status, block });
            cardCache.delete(key);
        } else {
            // El bloque existe y está en la misma columna, pero puede haber cambiado otros atributos
            // Actualizar estado de marcado
            if (block.marked && !card.classList.contains('marked')) {
                card.classList.add('marked');
            } else if (!block.marked && card.classList.contains('marked')) {
                card.classList.remove('marked');
            }
            // Actualizar otros atributos visuales si es necesario (prioridad, persona, etc.)
            // Esto se maneja mejor recreando la tarjeta si hay cambios significativos
        }
    });

    // Encontrar bloques nuevos que no tienen tarjeta
    const cardsToCreate = [];
    currentBlocksMap.forEach((block, key) => {
        if (!cardCache.has(key)) {
            cardsToCreate.push(block);
        }
    });

    // Usar requestAnimationFrame para agrupar las actualizaciones DOM
    requestAnimationFrame(() => {
        // Eliminar tarjetas que ya no existen
        cardsToRemove.forEach(card => {
            card.remove();
        });

        // Mover tarjetas que cambiaron de estado
        cardsToMove.forEach(({ card, newStatus, block }) => {
            // Verificar que el bloque aún pasa los filtros antes de moverlo
            const stillPassesFilters = applyFilters([block]).length > 0;
            
            if (!stillPassesFilters) {
                // El bloque ya no pasa los filtros, eliminarlo
                card.remove();
                return;
            }
            
            // Actualizar dataset
            card.dataset.status = newStatus;
            // Mover a la nueva columna
            const newColumn = document.getElementById(`column-${newStatus}`);
            if (newColumn) {
                // Si la nueva columna tiene ordenamiento, insertar en la posición correcta
                if (sortState[newStatus]) {
                    // Usar filteredBlocks que ya está actualizado
                    const columnBlocks = filteredBlocks.filter(b => b.status === newStatus);
                    const sortedBlocks = sortBlocksByPriority(columnBlocks, sortState[newStatus]);
                    const sortedIndex = sortedBlocks.findIndex(b => 
                        b.noteId === block.noteId && b.blockIndex === block.blockIndex
                    );
                    
                    // Insertar en la posición correcta
                    const existingCards = Array.from(newColumn.children);
                    if (sortedIndex >= 0 && sortedIndex < existingCards.length) {
                        newColumn.insertBefore(card, existingCards[sortedIndex]);
                    } else {
                        newColumn.appendChild(card);
                    }
                } else {
                    newColumn.appendChild(card);
                }
                // Volver a agregar al cache
                const key = `${block.noteId}-${block.blockIndex}`;
                cardCache.set(key, card);
            }
        });

        // Crear nuevas tarjetas (solo las que pasan los filtros)
        cardsToCreate.forEach(block => {
            // Verificar que el bloque pasa los filtros antes de crearlo
            const passesFilters = applyFilters([block]).length > 0;
            
            if (!passesFilters) {
                // El bloque no pasa los filtros, no crear la tarjeta
                return;
            }
            
            const card = createCard(block);
            const column = document.getElementById(`column-${block.status}`);
            if (column) {
                // Si la columna tiene ordenamiento activo, insertar en la posición correcta
                if (sortState[block.status]) {
                    // Usar filteredBlocks que ya está actualizado
                    const columnBlocks = filteredBlocks.filter(b => b.status === block.status);
                    const sortedBlocks = sortBlocksByPriority(columnBlocks, sortState[block.status]);
                    const sortedIndex = sortedBlocks.findIndex(b => 
                        b.noteId === block.noteId && b.blockIndex === block.blockIndex
                    );
                    
                    // Insertar en la posición correcta
                    const existingCards = Array.from(column.children);
                    if (sortedIndex >= 0 && sortedIndex < existingCards.length) {
                        column.insertBefore(card, existingCards[sortedIndex]);
                    } else {
                        column.appendChild(card);
                    }
                } else {
                    column.appendChild(card);
                }
                // Guardar en cache
                const key = `${block.noteId}-${block.blockIndex}`;
                cardCache.set(key, card);
            }
        });

        // Actualizar contadores (usar bloques filtrados)
        const counts = {
            'pendiente': 0,
            'en-progreso': 0,
            'hecho': 0
        };
        filteredBlocks.forEach(block => {
            if (counts.hasOwnProperty(block.status)) {
                counts[block.status]++;
            }
        });
        Object.keys(counts).forEach(status => {
            const countEl = document.getElementById(`count-${status}`);
            if (countEl) {
                countEl.textContent = counts[status];
            }
        });
        renderPersonMetrics();
    });
}

// Configurar zonas de drop en las columnas
function setupColumnDropZones() {
    const columns = document.querySelectorAll('.kanban-column');
    
    columns.forEach(column => {
        const columnContent = column.querySelector('.column-content');
        
        // Prevenir comportamiento por defecto
        columnContent.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            column.classList.add('drag-over');
        });
        
        columnContent.addEventListener('dragleave', (e) => {
            // Solo remover si realmente salimos de la columna
            if (!column.contains(e.relatedTarget)) {
                column.classList.remove('drag-over');
            }
        });
        
        columnContent.addEventListener('drop', (e) => {
            e.preventDefault();
            column.classList.remove('drag-over');
            
            if (draggedCard) {
                const newStatus = column.dataset.status;
                const oldStatus = draggedCardStatus;
                
                // Solo actualizar si cambió de columna
                if (newStatus !== oldStatus) {
                    const noteId = draggedCard.dataset.noteId;
                    const blockIndex = parseInt(draggedCard.dataset.blockIndex);
                    
                    // Actualizar el estado del bloque (con actualización optimista)
                    updateBlockStatus(noteId, blockIndex, newStatus);
                }
            }
        });
    });
}

// Crear una card para un bloque
function createCard(block) {
    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.draggable = true;
    card.dataset.noteId = block.noteId;
    card.dataset.blockIndex = block.blockIndex;
    card.dataset.status = block.status;

    // Contenido del bloque (texto)
    const contentDiv = document.createElement('div');
    contentDiv.className = 'card-content';
    contentDiv.textContent = block.content || 'Sin contenido';
    card.appendChild(contentDiv);

    // Footer con prioridad, persona asignada y nombre de nota (en hover)
    const footerDiv = document.createElement('div');
    footerDiv.className = 'card-footer';

    // Contenedor izquierdo para nombre de nota, prioridad y persona
    const leftContainer = document.createElement('div');
    leftContainer.style.display = 'flex';
    leftContainer.style.alignItems = 'center';
    leftContainer.style.gap = '8px';
    leftContainer.style.flex = '1';
    leftContainer.style.minWidth = '0';

    // Nombre de la nota (visible en hover)
    const noteNameDiv = document.createElement('div');
    noteNameDiv.className = 'card-note-name';
    noteNameDiv.textContent = block.noteTitle;
    leftContainer.appendChild(noteNameDiv);

    // Persona asignada (círculo con iniciales; título con "(Eliminado)" si aplica)
    if (block.assignedPerson) {
        const personAvatar = document.createElement('div');
        personAvatar.className = 'card-person-avatar';
        const initials = getPersonInitials(block.assignedPerson.firstName, block.assignedPerson.lastName);
        personAvatar.textContent = initials;
        personAvatar.title = getPersonDisplayName(block.assignedPerson);
        leftContainer.appendChild(personAvatar);
    }

    // Prioridad si existe
    if (block.priority) {
        const priorityChip = document.createElement('span');
        priorityChip.className = `card-priority chip-priority chip-${block.priority}`;
        
        const priorityLabels = {
            'p5': 'P5',
            'p4': 'P4',
            'p3': 'P3',
            'p2': 'P2',
            'p1': 'P1'
        };
        
        priorityChip.textContent = priorityLabels[block.priority] || block.priority;
        leftContainer.appendChild(priorityChip);
    }

    // Etiqueta de la nota si existe (muestra "(Eliminado)" si la etiqueta fue soft-deleted)
    if (block.tag && (block.tag.name || block.tag.id)) {
        const tagChip = document.createElement('span');
        tagChip.className = 'card-tag chip-tag';
        tagChip.textContent = getTagDisplayName(block.tag);
        leftContainer.appendChild(tagChip);
    }

    footerDiv.appendChild(leftContainer);

    // Contenedor derecho para botones de acción
    const rightContainer = document.createElement('div');
    rightContainer.style.display = 'flex';
    rightContainer.style.alignItems = 'center';
    rightContainer.style.gap = '4px';
    rightContainer.style.flexShrink = '0';
    rightContainer.style.width = '28px';
    rightContainer.style.justifyContent = 'flex-end';

    // Botón de eliminar (visible en hover)
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'card-action-btn card-delete-btn-footer';
    deleteBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    deleteBtn.title = 'Eliminar bloque';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        showDeleteModal(block.noteId, block.blockIndex);
    });
    rightContainer.appendChild(deleteBtn);

    footerDiv.appendChild(rightContainer);

    card.appendChild(footerDiv);

    // Event listeners para drag and drop
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);

    // Click para abrir la nota (solo si no se arrastró)
    let wasDragged = false;
    card.addEventListener('dragstart', () => {
        wasDragged = true;
    });
    card.addEventListener('click', (e) => {
        // No abrir si se hizo clic en el botón de eliminar
        if (e.target.closest('.card-delete-btn-footer')) {
            return;
        }
        // Solo abrir si no se arrastró la tarjeta
        if (!wasDragged) {
            ipcRenderer.send('open-note-from-kanban', block.noteId, block.blockIndex);
        }
        wasDragged = false; // Resetear para el próximo click
    });

    // Click derecho para mostrar menú contextual
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e, card, block);
    });

    // Aplicar clase "marked" si el bloque está marcado
    if (block.marked) {
        card.classList.add('marked');
    }

    // Inicializar iconos de Lucide en el botón
    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons({ container: deleteBtn });
        });
    }

    return card;
}

// Variables para drag and drop
let draggedCard = null;
let draggedCardStatus = null;

// Manejar inicio del drag
function handleDragStart(e) {
    draggedCard = this;
    draggedCardStatus = this.dataset.status;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
    
    // Crear imagen de arrastre personalizada
    const dragImage = this.cloneNode(true);
    dragImage.style.opacity = '0.5';
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
}

// Manejar fin del drag
function handleDragEnd(e) {
    this.classList.remove('dragging');
    
    // Remover clases de hover de todas las columnas
    document.querySelectorAll('.kanban-column').forEach(col => {
        col.classList.remove('drag-over');
    });
    
    draggedCard = null;
    draggedCardStatus = null;
}

// Actualizar estado del bloque en localStorage
function updateBlockStatus(noteId, blockIndex, newStatus) {
    // ACTUALIZACIÓN OPTIMISTA: Mover la tarjeta visualmente de inmediato
    const cardKey = `${noteId}-${blockIndex}`;
    const card = cardCache.get(cardKey);
    
    if (card) {
        const oldStatus = card.dataset.status;
        
        // Si cambió de estado, mover la tarjeta inmediatamente
        if (oldStatus !== newStatus) {
            // Actualizar dataset
            card.dataset.status = newStatus;
            
            // Mover visualmente a la nueva columna (actualización optimista)
            const newColumn = document.getElementById(`column-${newStatus}`);
            const oldColumn = document.getElementById(`column-${oldStatus}`);
            
            // Usar requestAnimationFrame para animación suave
            requestAnimationFrame(() => {
                // Si la nueva columna tiene ordenamiento, insertar en la posición correcta
                if (sortState[newStatus]) {
                    // Buscar el bloque en allBlocks y actualizar temporalmente su estado
                    const blockToMove = allBlocks.find(b => 
                        b.noteId === noteId && b.blockIndex === blockIndex
                    );
                    
                    if (blockToMove) {
                        // Guardar estado original
                        const originalStatus = blockToMove.status;
                        // Actualizar temporalmente para calcular posición
                        blockToMove.status = newStatus;
                        
                        // Aplicar filtros antes de ordenar
                        const tempFiltered = applyFilters(allBlocks);
                        const columnBlocks = tempFiltered.filter(b => b.status === newStatus);
                        const sortedBlocks = sortBlocksByPriority(columnBlocks, sortState[newStatus]);
                        const sortedIndex = sortedBlocks.findIndex(b => 
                            b.noteId === noteId && b.blockIndex === blockIndex
                        );
                        
                        // Restaurar estado original (se actualizará después)
                        blockToMove.status = originalStatus;
                        
                        // Insertar en la posición correcta
                        const existingCards = Array.from(newColumn.children);
                        if (sortedIndex >= 0 && sortedIndex < existingCards.length) {
                            newColumn.insertBefore(card, existingCards[sortedIndex]);
                        } else {
                            newColumn.appendChild(card);
                        }
                    } else {
                        newColumn.appendChild(card);
                    }
                } else {
                    newColumn.appendChild(card);
                }
                
                // Actualizar contadores optimistamente
                updateCountersOptimistic(oldStatus, newStatus);
            });
        }
    }
    
    // Actualizar en localStorage de forma asíncrona (no bloquea la UI)
    setTimeout(() => {
        const savedNotes = localStorage.getItem('notes');
        if (!savedNotes) return;

        const notes = JSON.parse(savedNotes);
        const note = notes.find(n => n.id === noteId);
        
        if (note && note.blocks && note.blocks[blockIndex]) {
            // Actualizar el estado del bloque
            note.blocks[blockIndex].status = newStatus;
            // Actualizar blockUpdatedAt para rastrear cuándo se modificó este bloque
            note.blocks[blockIndex].blockUpdatedAt = new Date().toISOString();
            // NO actualizar updatedAt cuando solo se mueve una tarjeta en el Kanban
            // updatedAt solo debe actualizarse cuando se modifica contenido desde la ventana de la nota
            
            // Guardar en localStorage
            localStorage.setItem('notes', JSON.stringify(notes));
            
            // Notificar al proceso principal (sin updatedAt actualizado)
            ipcRenderer.send('note-updated', note);
            
            // Actualizar los bloques en memoria y re-renderizar solo lo necesario
            const blockKey = `${noteId}-${blockIndex}`;
            const blockIndexInAll = allBlocks.findIndex(b => 
                b.noteId === noteId && b.blockIndex === blockIndex
            );
            
            if (blockIndexInAll !== -1) {
                allBlocks[blockIndexInAll].status = newStatus;
                
                // Actualizar currentContextBlock si el menú está abierto
                if (currentContextBlock && currentContextBlock.noteId === noteId && currentContextBlock.blockIndex === blockIndex) {
                    currentContextBlock = allBlocks[blockIndexInAll];
                    updateContextMenuValues(
                        currentContextBlock.status || '',
                        currentContextBlock.priority || '',
                        currentContextBlock.assignedPerson || null,
                        currentContextBlock.tag || null,
                        currentContextBlock.marked || false
                    );
                }
                
                // Aplicar filtros y actualizar hash
                filteredBlocks = applyFilters(allBlocks);
                lastBlocksHash = generateBlocksHash(filteredBlocks);
                // Actualización incremental (solo lo que cambió)
                updateKanbanIncremental();
                // Asegurar que los valores de los filtros se mantengan
                restoreFilterValues();
            } else {
                // Si no está en allBlocks, recargar
                loadBlocks(false);
                // Asegurar que los valores de los filtros se mantengan después de cargar
                restoreFilterValues();
            }
        }
    }, 0);
}

// Actualizar contadores de forma optimista
function updateCountersOptimistic(oldStatus, newStatus) {
    const oldCountEl = document.getElementById(`count-${oldStatus}`);
    const newCountEl = document.getElementById(`count-${newStatus}`);
    
    if (oldCountEl && newCountEl) {
        const oldCount = parseInt(oldCountEl.textContent) || 0;
        const newCount = parseInt(newCountEl.textContent) || 0;
        
        oldCountEl.textContent = Math.max(0, oldCount - 1);
        newCountEl.textContent = newCount + 1;
    }
}

// Variables para el modal de confirmación
let pendingDeleteNoteId = null;
let pendingDeleteBlockIndex = null;

// Mostrar modal de confirmación de eliminación
function showDeleteModal(noteId, blockIndex) {
    pendingDeleteNoteId = noteId;
    pendingDeleteBlockIndex = blockIndex;
    const modal = document.getElementById('deleteModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('show');
    }
}

// Ocultar modal de confirmación
function hideDeleteModal() {
    pendingDeleteNoteId = null;
    pendingDeleteBlockIndex = null;
    const modal = document.getElementById('deleteModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
}

// Eliminar bloque
function deleteBlock(noteId, blockIndex) {
    const savedNotes = localStorage.getItem('notes');
    if (!savedNotes) return;

    const notes = JSON.parse(savedNotes);
    const note = notes.find(n => n.id === noteId);
    
    if (note && note.blocks && note.blocks[blockIndex]) {
        // Eliminar el bloque del array
        note.blocks.splice(blockIndex, 1);
        // NO actualizar updatedAt cuando se elimina desde el Kanban
        // updatedAt solo debe actualizarse cuando se modifica contenido desde la ventana de la nota
        
        // Guardar en localStorage
        localStorage.setItem('notes', JSON.stringify(notes));
        
        // Notificar al proceso principal (sin updatedAt actualizado)
        ipcRenderer.send('note-updated', note);
        
        // Actualizar el Kanban de forma incremental
        const blockKey = `${noteId}-${blockIndex}`;
        const card = cardCache.get(blockKey);
        if (card) {
            card.remove();
            cardCache.delete(blockKey);
        }
        
        // Remover del array de bloques
        allBlocks = allBlocks.filter(b => 
            !(b.noteId === noteId && b.blockIndex === blockIndex)
        );
        
        // Actualizar hash y contadores
        lastBlocksHash = generateBlocksHash(allBlocks);
        updateKanbanIncremental();
        // Asegurar que los valores de los filtros se mantengan
        restoreFilterValues();
    }
    
    hideDeleteModal();
}

// Event listener para actualizar el tablero
document.getElementById('refreshBtn').addEventListener('click', () => {
    const refreshBtn = document.getElementById('refreshBtn');
    const refreshIcon = refreshBtn.querySelector('i, svg');
    
    // Activar animación de carga
    if (refreshIcon) {
        refreshIcon.classList.add('refreshing');
    }
    
    // Forzar recarga completa del tablero
    loadBlocks(true);
    
    // Detener animación después de un tiempo acotado (500ms)
    setTimeout(() => {
        if (refreshIcon) {
            refreshIcon.classList.remove('refreshing');
        }
    }, 500);
});

// Event listener para ir a lista de notas
document.getElementById('notesListBtn').addEventListener('click', () => {
    ipcRenderer.send('focus-main-window');
});

// Construir descripción de filtros activos para el informe
function getFilterDescription() {
    const parts = [];
    const personSelect = document.getElementById('filterPerson');
    const prioritySelect = document.getElementById('filterPriority');
    const tagSelect = document.getElementById('filterTag');
    const daysSelect = document.getElementById('filterDays');
    if (filters.personId && personSelect) {
        const opt = personSelect.options[personSelect.selectedIndex];
        if (opt) parts.push('Persona: ' + opt.text);
    }
    if (filters.priority && prioritySelect) {
        const opt = prioritySelect.options[prioritySelect.selectedIndex];
        if (opt) parts.push('Prioridad: ' + opt.text);
    }
    if (filters.tagId && tagSelect) {
        const opt = tagSelect.options[tagSelect.selectedIndex];
        if (opt) parts.push('Etiqueta: ' + opt.text);
    }
    if (filters.daysFilter !== null && filters.daysFilter > 0 && daysSelect) {
        const opt = daysSelect.options[daysSelect.selectedIndex];
        if (opt) parts.push('Creadas: ' + opt.text);
    }
    return parts.length ? parts.join('; ') : 'Sin filtros';
}

// Escapar caracteres que podrían romper Markdown
function escapeMarkdown(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/\n/g, ' ')
        .replace(/\r/g, '')
        .trim();
}

// Modal de mensaje (mismo estilo que en ventana principal)
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

// Generar informe del tablero en Markdown (tareas visibles según filtros actuales y columna Hecho visible/oculta)
async function exportKanbanReport() {
    const doneColumnHidden = localStorage.getItem('kanbanDoneColumnHidden') === 'true';
    const blocksForReport = doneColumnHidden
        ? filteredBlocks.filter(block => block.status !== 'hecho')
        : filteredBlocks;
    const statusLabels = { 'pendiente': 'Pendiente', 'en-progreso': 'En progreso', 'hecho': 'Hecho' };
    const priorityLabels = { 'p1': 'P1', 'p2': 'P2', 'p3': 'P3', 'p4': 'P4', 'p5': 'P5' };
    const statusesToExport = doneColumnHidden ? ['pendiente', 'en-progreso'] : ['pendiente', 'en-progreso', 'hecho'];
    const now = new Date();
    const dateStr = now.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const lines = [
        '# Informe del tablero Kanban',
        '',
        '*Exportado:* ' + dateStr,
        '*Filtros:* ' + getFilterDescription(),
        ...(doneColumnHidden ? ['*Columna Hecho:* oculta (no incluida en el informe)', ''] : ['']),
        '*Total tareas:* ' + blocksForReport.length,
        ''
    ];
    const byStatus = { 'pendiente': [], 'en-progreso': [], 'hecho': [] };
    blocksForReport.forEach(block => {
        if (byStatus[block.status]) byStatus[block.status].push(block);
    });
    // Orden de prioridades: alta (P1) a baja (P5), luego sin prioridad
    const priorityOrder = ['p1', 'p2', 'p3', 'p4', 'p5', ''];
    const prioritySectionLabels = { 'p1': 'P1', 'p2': 'P2', 'p3': 'P3', 'p4': 'P4', 'p5': 'P5', '': 'Sin prioridad' };
    statusesToExport.forEach(status => {
        const blocks = byStatus[status];
        if (blocks.length === 0) return;
        lines.push('## ' + statusLabels[status]);
        lines.push('');
        // Agrupar por prioridad dentro del estado
        const byPriority = {};
        priorityOrder.forEach(p => { byPriority[p] = []; });
        blocks.forEach(block => {
            const p = (block.priority && priorityOrder.includes(block.priority)) ? block.priority : '';
            byPriority[p].push(block);
        });
        priorityOrder.forEach(priorityKey => {
            const priorityBlocks = byPriority[priorityKey];
            if (priorityBlocks.length === 0) return;
            lines.push('### ' + prioritySectionLabels[priorityKey]);
            lines.push('');
            priorityBlocks.forEach(block => {
                const prioridad = block.priority ? (priorityLabels[block.priority] || block.priority) : '—';
                const asignado = block.assignedPerson
                    ? [block.assignedPerson.firstName, block.assignedPerson.lastName].filter(Boolean).join(' ')
                    : '—';
                const etiqueta = block.tag ? block.tag.name : '—';
                const marcado = block.marked ? ' [marcado]' : '';
                lines.push('- *' + escapeMarkdown(block.noteTitle) + '*' + marcado);
                lines.push('  - ' + (escapeMarkdown(block.content) || '(sin texto)'));
                lines.push('  - Prioridad: ' + prioridad + ' | Asignado: ' + asignado + ' | Etiqueta: ' + etiqueta);
                lines.push('');
            });
        });
    });
    const markdown = lines.join('\n');
    try {
        const ok = await ipcRenderer.invoke('copy-to-clipboard', markdown);
        if (ok) {
            showMessage('Informe del tablero', 'Informe copiado al portapapeles.');
        } else {
            showMessage('Informe del tablero', 'No se pudo copiar al portapapeles.');
        }
    } catch (err) {
        showMessage('Error', 'Error al copiar: ' + err.message);
    }
}

document.getElementById('exportReportBtn').addEventListener('click', () => {
    exportKanbanReport();
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
        confirmBtn.addEventListener('click', () => {
            if (pendingDeleteNoteId !== null && pendingDeleteBlockIndex !== null) {
                deleteBlock(pendingDeleteNoteId, pendingDeleteBlockIndex);
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

// Inicializar modal al cargar
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDeleteModal);
} else {
    initDeleteModal();
}

// Escuchar actualizaciones de notas
// Este listener se maneja más abajo junto con la repoblación de filtros

// Función para ordenar bloques por prioridad
function sortBlocksByPriority(blocks, order) {
    // Mapeo de prioridades a valores numéricos para ordenar
    const priorityValues = {
        'p1': 1,
        'p2': 2,
        'p3': 3,
        'p4': 4,
        'p5': 5,
        '': 6 // Sin prioridad va al final
    };

    const sorted = [...blocks].sort((a, b) => {
        const priorityA = priorityValues[a.priority || ''] || 6;
        const priorityB = priorityValues[b.priority || ''] || 6;
        
        if (order === 'asc') {
            // Ascendente: menor prioridad primero (P1 antes que P5)
            return priorityA - priorityB;
        } else {
            // Descendente: mayor prioridad primero (P1 antes que P5)
            return priorityB - priorityA;
        }
    });

    return sorted;
}

// Función para ordenar una columna específica
function sortColumn(status) {
    const column = document.getElementById(`column-${status}`);
    if (!column) return;

    // Alternar estado de ordenamiento: null -> 'asc' -> 'desc' -> null
    if (sortState[status] === null) {
        sortState[status] = 'asc';
    } else if (sortState[status] === 'asc') {
        sortState[status] = 'desc';
    } else {
        sortState[status] = null;
    }

    // Aplicar filtros antes de ordenar
    const tempFiltered = applyFilters(allBlocks);
    
    // Si se desactivó el ordenamiento, restaurar orden original
    if (sortState[status] === null) {
        // Re-renderizar la columna sin ordenamiento (pero con filtros aplicados)
        const columnBlocks = tempFiltered.filter(block => block.status === status);
        column.innerHTML = '';
        
        columnBlocks.forEach(block => {
            const cacheKey = `${block.noteId}-${block.blockIndex}`;
            let card = cardCache.get(cacheKey);
            if (!card) {
                card = createCard(block);
                cardCache.set(cacheKey, card);
            }
            column.appendChild(card);
        });
    } else {
        // Ordenar las tarjetas (ya filtradas)
        const columnBlocks = tempFiltered.filter(block => block.status === status);
        const sortedBlocks = sortBlocksByPriority(columnBlocks, sortState[status]);
        
        // Reordenar las tarjetas en el DOM
        column.innerHTML = '';
        sortedBlocks.forEach(block => {
            const cacheKey = `${block.noteId}-${block.blockIndex}`;
            let card = cardCache.get(cacheKey);
            if (!card) {
                card = createCard(block);
                cardCache.set(cacheKey, card);
            }
            column.appendChild(card);
        });
    }

    // Actualizar estado visual de los botones
    updateSortButtonsState();
}

// Actualizar estado visual de los botones de ordenar
function updateSortButtonsState() {
    Object.keys(sortState).forEach(status => {
        const btn = document.querySelector(`.column-sort-btn[data-status="${status}"]`);
        if (!btn) return;
        
        // Remover clases anteriores
        btn.classList.remove('active', 'asc', 'desc');
        
        // Determinar qué icono usar
        let iconName = 'arrow-up-down';
        if (sortState[status] === 'asc') {
            btn.classList.add('active', 'asc');
            btn.title = 'Ordenar: Ascendente (Menor a Mayor prioridad)';
            iconName = 'arrow-up';
        } else if (sortState[status] === 'desc') {
            btn.classList.add('active', 'desc');
            btn.title = 'Ordenar: Descendente (Mayor a Menor prioridad)';
            iconName = 'arrow-down';
        } else {
            btn.title = 'Ordenar por prioridad';
        }
        
        // Limpiar todo el contenido del botón (incluyendo SVGs de Lucide)
        btn.innerHTML = '';
        
        // Crear nuevo icono
        const newIcon = document.createElement('i');
        newIcon.setAttribute('data-lucide', iconName);
        btn.appendChild(newIcon);
        
        // Inicializar el icono con Lucide (con un pequeño delay para asegurar que funcione)
        if (typeof lucide !== 'undefined') {
            setTimeout(() => {
                lucide.createIcons({ container: btn });
            }, 0);
        }
    });
}

// Configurar event listeners para los botones de ordenar
function setupSortButtons() {
    const sortButtons = document.querySelectorAll('.column-sort-btn');
    sortButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const status = btn.dataset.status;
            if (status) {
                sortColumn(status);
            }
        });
    });
}

// Cargar personas desde localStorage (incluye eliminadas)
function loadPersons() {
    const savedPersons = localStorage.getItem('persons');
    const list = savedPersons ? JSON.parse(savedPersons) : [];
    list.forEach(p => { if (p.deleted === undefined) p.deleted = false; });
    return list;
}

// Solo personas activas (para asignar o filtrar)
function getActivePersons() {
    return loadPersons().filter(p => !p.deleted);
}

// Nombre a mostrar (con "(Eliminado)" si está soft-deleted)
function getPersonDisplayName(person) {
    if (!person || !person.id) return '';
    const all = loadPersons();
    const full = all.find(p => p.id === person.id);
    if (!full) {
        return person.lastName ? `${person.firstName} ${person.lastName}` : (person.firstName || '');
    }
    const name = full.lastName ? `${full.firstName} ${full.lastName}` : (full.firstName || '');
    return full.deleted ? name + ' (Eliminado)' : name;
}

// Restaurar valores de filtros en los selectores
function restoreFilterValues() {
    const personSelect = document.getElementById('filterPerson');
    const prioritySelect = document.getElementById('filterPriority');
    const tagSelect = document.getElementById('filterTag');
    const daysSelect = document.getElementById('filterDays');
    
    // Cargar filtro de días desde localStorage si existe
    const savedDaysFilter = localStorage.getItem('kanbanDaysFilter');
    if (savedDaysFilter !== null) {
        filters.daysFilter = parseInt(savedDaysFilter, 10);
    }
    
    // Restaurar filtro de persona
    if (personSelect) {
        if (filters.personId) {
            // Verificar que la opción existe antes de asignarla
            const optionExists = Array.from(personSelect.options).some(opt => opt.value === filters.personId);
            if (optionExists) {
                personSelect.value = filters.personId;
            } else {
                // Si la opción no existe, limpiar el filtro
                filters.personId = null;
                personSelect.value = '';
            }
        } else {
            personSelect.value = '';
        }
    }
    
    // Restaurar filtro de prioridad
    if (prioritySelect) {
        if (filters.priority) {
            prioritySelect.value = filters.priority;
        } else {
            prioritySelect.value = '';
        }
    }
    
    // Restaurar filtro de etiqueta
    if (tagSelect) {
        if (filters.tagId) {
            // Verificar que la opción existe antes de asignarla
            const optionExists = Array.from(tagSelect.options).some(opt => opt.value === filters.tagId);
            if (optionExists) {
                tagSelect.value = filters.tagId;
            } else {
                // Si la opción no existe, limpiar el filtro
                filters.tagId = null;
                tagSelect.value = '';
            }
        } else {
            tagSelect.value = '';
        }
    }
    
    // Restaurar filtro de días
    if (daysSelect) {
        if (filters.daysFilter !== null && filters.daysFilter > 0) {
            daysSelect.value = filters.daysFilter.toString();
        } else {
            daysSelect.value = '';
        }
    }
}

// Cargar personas en el selector de filtro
function populatePersonFilter() {
    const personSelect = document.getElementById('filterPerson');
    if (!personSelect) return;
    
    // Guardar el valor actual antes de limpiar
    const currentValue = personSelect.value;
    
    const persons = loadPersons();
    
    // Limpiar opciones existentes (excepto "Todas las personas")
    personSelect.innerHTML = '<option value="">Todas las personas</option>';
    
    // Agregar cada persona (solo activas)
    const activePersons = getActivePersons();
    activePersons.forEach(person => {
        const option = document.createElement('option');
        option.value = person.id;
        const fullName = person.lastName
            ? `${person.firstName} ${person.lastName}`
            : person.firstName;
        option.textContent = fullName;
        personSelect.appendChild(option);
    });
    
    // Restaurar el valor usando el estado de filters (más confiable que currentValue)
    if (filters.personId) {
        // Verificar que la opción existe antes de asignarla
        const optionExists = Array.from(personSelect.options).some(opt => opt.value === filters.personId);
        if (optionExists) {
            personSelect.value = filters.personId;
        } else {
            // Si la opción no existe, limpiar el filtro
            filters.personId = null;
        }
    } else {
        personSelect.value = '';
    }
}

// Cargar etiquetas desde localStorage (incluye eliminadas)
function loadTags() {
    const savedTags = localStorage.getItem('tags');
    const list = savedTags ? JSON.parse(savedTags) : [];
    list.forEach(t => { if (t.deleted === undefined) t.deleted = false; });
    return list;
}

// Solo etiquetas activas (para asignar o filtrar)
function getActiveTags() {
    return loadTags().filter(t => !t.deleted);
}

// Nombre a mostrar (con "(Eliminado)" si está soft-deleted)
function getTagDisplayName(tag) {
    if (!tag || !tag.id) return '';
    const all = loadTags();
    const full = all.find(t => t.id === tag.id);
    if (!full) return tag.name || '';
    return full.deleted ? (full.name || tag.name) + ' (Eliminado)' : (full.name || tag.name);
}

// Cargar etiquetas en el selector de filtro (solo activas)
function populateTagFilter() {
    const tagSelect = document.getElementById('filterTag');
    if (!tagSelect) return;

    const currentValue = tagSelect.value;

    const tags = getActiveTags();

    tagSelect.innerHTML = '<option value="">Todas las etiquetas</option>';

    tags.forEach(tag => {
        const option = document.createElement('option');
        option.value = tag.id;
        option.textContent = tag.name;
        tagSelect.appendChild(option);
    });
    
    // Restaurar el valor usando el estado de filters (más confiable que currentValue)
    if (filters.tagId) {
        // Verificar que la opción existe antes de asignarla
        const optionExists = Array.from(tagSelect.options).some(opt => opt.value === filters.tagId);
        if (optionExists) {
            tagSelect.value = filters.tagId;
        } else {
            // Si la opción no existe, limpiar el filtro
            filters.tagId = null;
        }
    } else {
        tagSelect.value = '';
    }
}

// Configurar event listeners para los filtros
function setupFilters() {
    const personSelect = document.getElementById('filterPerson');
    const prioritySelect = document.getElementById('filterPriority');
    const tagSelect = document.getElementById('filterTag');
    const daysSelect = document.getElementById('filterDays');
    const clearFiltersBtn = document.getElementById('clearFiltersBtn');
    
    // Filtro por persona
    if (personSelect) {
        personSelect.addEventListener('change', (e) => {
            filters.personId = e.target.value || null;
            loadBlocks(true); // Forzar re-renderizado con filtros
        });
    }
    
    // Filtro por prioridad
    if (prioritySelect) {
        prioritySelect.addEventListener('change', (e) => {
            filters.priority = e.target.value || null;
            loadBlocks(true); // Forzar re-renderizado con filtros
        });
    }
    
    // Filtro por etiqueta
    if (tagSelect) {
        tagSelect.addEventListener('change', (e) => {
            filters.tagId = e.target.value || null;
            loadBlocks(true); // Forzar re-renderizado con filtros
        });
    }
    
    // Filtro por días de actualización
    if (daysSelect) {
        daysSelect.addEventListener('change', (e) => {
            const days = e.target.value ? parseInt(e.target.value, 10) : null;
            filters.daysFilter = days;
            if (days) {
                localStorage.setItem('kanbanDaysFilter', days.toString());
            } else {
                localStorage.removeItem('kanbanDaysFilter');
            }
            loadBlocks(true); // Forzar re-renderizado con filtros
        });
    }
    
    // Botón limpiar filtros
    if (clearFiltersBtn) {
        clearFiltersBtn.addEventListener('click', () => {
            filters.personId = null;
            filters.priority = null;
            filters.tagId = null;
            filters.daysFilter = null;
            
            // Resetear selectores
            if (personSelect) personSelect.value = '';
            if (prioritySelect) prioritySelect.value = '';
            if (tagSelect) tagSelect.value = '';
            if (daysSelect) daysSelect.value = '';
            
            localStorage.removeItem('kanbanDaysFilter');
            
            loadBlocks(true); // Forzar re-renderizado sin filtros
        });
    }
    
    // Restaurar valores de filtros al inicializar
    restoreFilterValues();
}

// Colores de estado para la dona (alineados con las columnas)
const statusDonutColors = {
    pendiente: '#FFB74D', // naranja (columna Pendiente)
    'en-progreso': '#64B5F6', // azul (columna En progreso)
    marcado: '#F44336', // rojo (tarjeta marcada)
    empty: '#9E9E9E'
};

function calculatePersonMetrics(blocks) {
    const activePersonIds = new Set(getActivePersons().map(p => p.id));
    const personMap = new Map();
    blocks.forEach(block => {
        if (!block.assignedPerson) return;
        const personId = block.assignedPerson.id;
        if (!activePersonIds.has(personId)) return; // No mostrar personas quitadas definitivamente
        if (!personMap.has(personId)) {
            personMap.set(personId, {
                person: block.assignedPerson,
                total: 0,
                statusCounts: { pendiente: 0, 'en-progreso': 0 },
                markedTotal: 0,
                markedByStatus: { pendiente: 0, 'en-progreso': 0 }
            });
        }
        const m = personMap.get(personId);
        if (block.status === 'pendiente' || block.status === 'en-progreso') {
            m.total++;
            m.statusCounts[block.status]++;
            if (block.marked) {
                m.markedTotal++;
                m.markedByStatus[block.status]++;
            }
        }
    });
    return Array.from(personMap.values())
        .filter(m => m.total > 0)
        .sort((a, b) => b.total - a.total);
}

// Donut con segmentos por estado (Pendiente/En progreso) y opcional Marcados
function createDonutChart(metrics, size = 32) {
    const cx = size / 2;
    const cy = size / 2;
    const rOut = size / 2 - 2;
    const rIn = rOut - 4;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.classList.add('person-metric-chart-svg');

    // Función auxiliar para crear un segmento
    function createSegment(startFrac, endFrac, color) {
        const frac = endFrac - startFrac;
        
        // Caso especial: círculo completo (fracción = 1.0 o muy cercana)
        if (Math.abs(frac - 1.0) < 0.0001) {
            // Crear un anillo completo usando un path con fill-rule="evenodd"
            // Esto crea un círculo exterior con un agujero interior
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            // Dibujar el círculo exterior en sentido horario
            const outerPath = `M ${cx} ${cy - rOut} A ${rOut} ${rOut} 0 1 1 ${cx} ${cy + rOut} A ${rOut} ${rOut} 0 1 1 ${cx} ${cy - rOut}`;
            // Dibujar el círculo interior en sentido antihorario (para crear el agujero)
            const innerPath = `M ${cx} ${cy - rIn} A ${rIn} ${rIn} 0 1 0 ${cx} ${cy + rIn} A ${rIn} ${rIn} 0 1 0 ${cx} ${cy - rIn}`;
            path.setAttribute('d', outerPath + ' ' + innerPath);
            path.setAttribute('fill', color);
            path.setAttribute('fill-rule', 'evenodd');
            svg.appendChild(path);
            return;
        }
        
        // Caso normal: segmento parcial
        const startAngle = 2 * Math.PI * startFrac - Math.PI / 2;
        const endAngle = 2 * Math.PI * endFrac - Math.PI / 2;
        const x1 = cx + rOut * Math.cos(startAngle);
        const y1 = cy + rOut * Math.sin(startAngle);
        const x2 = cx + rOut * Math.cos(endAngle);
        const y2 = cy + rOut * Math.sin(endAngle);
        const x3 = cx + rIn * Math.cos(endAngle);
        const y3 = cy + rIn * Math.sin(endAngle);
        const x4 = cx + rIn * Math.cos(startAngle);
        const y4 = cy + rIn * Math.sin(startAngle);
        const large = frac > 0.5 ? 1 : 0;
        const d = `M ${x1} ${y1} A ${rOut} ${rOut} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${rIn} ${rIn} 0 ${large} 0 ${x4} ${y4} Z`;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', color);
        svg.appendChild(path);
    }

    let startFrac = 0;
    let hasAnySegment = false;
    
    const pend = metrics.statusCounts?.pendiente || 0;
    const enProg = metrics.statusCounts?.['en-progreso'] || 0;
    const markedPend = metrics.markedByStatus?.pendiente || 0;
    const markedEnProg = metrics.markedByStatus?.['en-progreso'] || 0;
    const markedTotal = metrics.markedTotal || 0;

    const pendUnmarked = Math.max(0, pend - markedPend);
    const enProgUnmarked = Math.max(0, enProg - markedEnProg);

    const segments = [
        { count: pendUnmarked, color: statusDonutColors.pendiente },
        { count: enProgUnmarked, color: statusDonutColors['en-progreso'] }
    ];
    if (markedTotal > 0) {
        segments.push({ count: markedTotal, color: statusDonutColors.marcado });
    }

    segments.forEach(seg => {
        if (seg.count <= 0) return;
        hasAnySegment = true;
        const frac = seg.count / metrics.total;
        const endFrac = Math.min(startFrac + frac, 1.0);
        createSegment(startFrac, endFrac, seg.color);
        startFrac = endFrac;
    });
    
    // Si no hay ningún segmento pero hay total > 0, mostrar un círculo completo gris
    if (!hasAnySegment && metrics.total > 0) {
        createSegment(0, 1, statusDonutColors.empty);
    }

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', cy);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('font-size', '10');
    text.setAttribute('font-weight', '600');
    text.setAttribute('fill', '#DDDDDD');
    text.textContent = metrics.total;
    svg.appendChild(text);
    return svg;
}

function renderPersonMetrics() {
    const container = document.getElementById('personMetrics');
    if (!container) return;
    const metrics = calculatePersonMetrics(filteredBlocks);
    if (metrics.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = 'flex';
    container.innerHTML = '';
    const personSelect = document.getElementById('filterPerson');
    metrics.forEach(metric => {
        const personId = metric.person.id;
        const personName = metric.person.lastName
            ? `${metric.person.firstName} ${metric.person.lastName}`
            : metric.person.firstName;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'person-metric-item';
        if (filters.personId === personId) item.classList.add('selected');
        item.dataset.personId = personId;
        const pend = metric.statusCounts.pendiente || 0;
        const enProg = metric.statusCounts['en-progreso'] || 0;
        const marked = metric.markedTotal || 0;
        const chartWrap = document.createElement('div');
        chartWrap.className = 'person-metric-chart';
        chartWrap.appendChild(createDonutChart(metric, 32));
        const nameEl = document.createElement('div');
        nameEl.className = 'person-metric-name';
        nameEl.textContent = personName;
        item.appendChild(chartWrap);
        item.appendChild(nameEl);
        item.addEventListener('click', () => {
            hidePersonMetricTooltip();
            if (filters.personId === personId) {
                filters.personId = null;
                if (personSelect) personSelect.value = '';
            } else {
                filters.personId = personId;
                if (personSelect) personSelect.value = personId;
            }
            restoreFilterValues();
            loadBlocks(true);
        });
        setupPersonMetricTooltip(item, pend, enProg, marked);
        container.appendChild(item);
    });
}

let personMetricTooltipTimeout = null;

function hidePersonMetricTooltip() {
    if (personMetricTooltipTimeout) {
        clearTimeout(personMetricTooltipTimeout);
        personMetricTooltipTimeout = null;
    }
    const tooltip = document.getElementById('personMetricTooltip');
    if (tooltip) {
        tooltip.classList.remove('show');
        tooltip.setAttribute('aria-hidden', 'true');
    }
}

function setupPersonMetricTooltip(item, pend, enProg, marked) {
    const tooltip = document.getElementById('personMetricTooltip');
    if (!tooltip) return;
    item.addEventListener('mouseenter', () => {
        personMetricTooltipTimeout = setTimeout(() => {
            const markedLine = marked > 0
                ? `<div class="person-metric-tooltip-line"><span class="person-metric-tooltip-label">Marcados:</span><span class="person-metric-tooltip-value">${marked}</span></div>`
                : '';
            tooltip.innerHTML = `
                <div class="person-metric-tooltip-line"><span class="person-metric-tooltip-label">Pendiente:</span><span class="person-metric-tooltip-value">${pend}</span></div>
                <div class="person-metric-tooltip-line"><span class="person-metric-tooltip-label">En progreso:</span><span class="person-metric-tooltip-value">${enProg}</span></div>
                ${markedLine}
            `;
            const rect = item.getBoundingClientRect();
            tooltip.style.left = rect.right + 8 + 'px';
            tooltip.style.top = rect.top + rect.height / 2 + 'px';
            tooltip.setAttribute('aria-hidden', 'false');
            tooltip.classList.add('show');
        }, 100);
    });
    item.addEventListener('mouseleave', () => {
        hidePersonMetricTooltip();
    });
}

function setupToggleFilters() {
    const btn = document.getElementById('toggleFiltersBtn');
    const filtersEl = document.getElementById('kanbanFilters');
    if (!btn || !filtersEl) return;
    const hidden = localStorage.getItem('kanbanFiltersHidden') === 'true';
    if (hidden) {
        filtersEl.classList.add('hidden');
        btn.classList.remove('active');
    } else {
        filtersEl.classList.remove('hidden');
        btn.classList.add('active');
    }
    btn.addEventListener('click', () => {
        const isHidden = filtersEl.classList.toggle('hidden');
        btn.classList.toggle('active', !isHidden);
        localStorage.setItem('kanbanFiltersHidden', isHidden ? 'true' : 'false');
    });
}

// Variables para el menú contextual
let currentContextCard = null;
let currentContextBlock = null;

function positionMenuToViewport(menuEl, desiredLeft, desiredTop, { margin = 8, anchorRect = null } = {}) {
    // Posicionamiento inicial
    menuEl.style.left = `${desiredLeft}px`;
    menuEl.style.top = `${desiredTop}px`;
    menuEl.style.position = 'fixed';

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = menuEl.getBoundingClientRect();

    let left = desiredLeft;
    let top = desiredTop;

    // Ajuste horizontal (evitar que se salga por la derecha/izquierda)
    if (rect.right > vw - margin) left = Math.max(margin, vw - rect.width - margin);
    if (left < margin) left = margin;

    // Ajuste vertical: si se sale por abajo, "flipping" hacia arriba
    if (rect.bottom > vh - margin) {
        if (anchorRect) {
            top = anchorRect.top - rect.height - margin;
        } else {
            top = desiredTop - rect.height;
        }
    }
    if (top < margin) top = margin;

    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
}

// Mostrar menú contextual
function showContextMenu(event, card, block) {
    const contextMenu = document.getElementById('cardContextMenu');
    if (!contextMenu) return;

    const menuAlreadyOpen = contextMenu.classList.contains('show');
    const isReopenOnOtherCard = menuAlreadyOpen && currentContextCard !== null && currentContextCard !== card;

    if (isReopenOnOtherCard) {
        // Cerrar rápido el menú anterior y luego abrir con animación suave en la nueva tarjeta
        contextMenu.classList.add('closing');
        contextMenu.classList.remove('show');
        setTimeout(() => {
            contextMenu.classList.remove('closing');
            currentContextCard = card;
            currentContextBlock = block;
            closeAllDropdowns();
            const x = event.clientX;
            const y = event.clientY;
            contextMenu.classList.add('show');
            requestAnimationFrame(() => positionMenuToViewport(contextMenu, x, y));
            updateContextMenuValues(block.status || '', block.priority || '', block.assignedPerson || null, block.tag || null, block.marked || false);
            populatePriorityDropdown(block.priority || '');
            populateTagDropdown(block.tag ? block.tag.id : '');
            if (typeof lucide !== 'undefined') {
                requestAnimationFrame(() => {
                    lucide.createIcons({ container: contextMenu });
                });
            }
            setTimeout(() => {
                const clickHandler = (e) => {
                    if (contextMenu.contains(e.target)) return;
                    closeContextMenu();
                };
                const contextMenuHandler = (e) => {
                    if (contextMenu.contains(e.target)) return;
                    closeContextMenu();
                };
                document.addEventListener('click', clickHandler, { once: true });
                document.addEventListener('contextmenu', contextMenuHandler, { once: true });
                window.addEventListener('scroll', () => closeContextMenu(), { once: true, passive: true });
                window.addEventListener('blur', () => closeContextMenu(), { once: true });
            }, 100);
        }, 90);
        return;
    }

    currentContextCard = card;
    currentContextBlock = block;
    closeAllDropdowns();

    const x = event.clientX;
    const y = event.clientY;
    contextMenu.classList.add('show');
    requestAnimationFrame(() => positionMenuToViewport(contextMenu, x, y));

    updateContextMenuValues(block.status || '', block.priority || '', block.assignedPerson || null, block.tag || null, block.marked || false);
    populatePriorityDropdown(block.priority || '');
    populateTagDropdown(block.tag ? block.tag.id : '');

    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons({ container: contextMenu });
        });
    }

    setTimeout(() => {
        const clickHandler = (e) => {
            if (contextMenu.contains(e.target)) return;
            closeContextMenu();
        };
        const contextMenuHandler = (e) => {
            if (contextMenu.contains(e.target)) return;
            closeContextMenu();
        };
        document.addEventListener('click', clickHandler, { once: true });
        document.addEventListener('contextmenu', contextMenuHandler, { once: true });
        window.addEventListener('scroll', () => closeContextMenu(), { once: true, passive: true });
        window.addEventListener('blur', () => closeContextMenu(), { once: true });
    }, 100);
}

// Cerrar menú contextual
function closeContextMenu() {
    const contextMenu = document.getElementById('cardContextMenu');
    if (contextMenu) {
        contextMenu.classList.remove('show');
    }
    closeAllDropdowns();
    currentContextCard = null;
    currentContextBlock = null;
}

// Cerrar todos los dropdowns
function closeAllDropdowns() {
    document.querySelectorAll('.kanban-menu-item').forEach(item => {
        item.classList.remove('active');
    });
    const personSearchResults = document.getElementById('personSearchResults');
    if (personSearchResults) {
        personSearchResults.innerHTML = '';
    }
    const personSearchInput = document.getElementById('personSearchInput');
    if (personSearchInput) {
        personSearchInput.value = '';
    }
}

// Actualizar valores mostrados en el menú
function updateContextMenuValues(status, priority, assignedPerson = null, tag = null, marked = false) {
    const priorityChip = document.getElementById('priorityChip');
    const priorityLabel = document.getElementById('priorityLabel');
    const personChip = document.getElementById('personChip');
    const personLabel = document.getElementById('personLabel');
    const tagChip = document.getElementById('tagChip');
    const tagLabel = document.getElementById('tagLabel');
    const markIcon = document.getElementById('markIcon');

    // Prioridad
    const priorityLabels = {
        '': 'Sin prioridad',
        'p1': 'P1',
        'p2': 'P2',
        'p3': 'P3',
        'p4': 'P4',
        'p5': 'P5'
    };
    if (priorityChip && priorityLabel) {
        if (priority) {
            priorityChip.textContent = priorityLabels[priority] || priority;
            priorityChip.className = `kanban-menu-chip card-priority chip-priority chip-${priority}`;
            priorityChip.classList.remove('empty');
        } else {
            priorityChip.className = 'kanban-menu-chip empty';
        }
    }

    // Persona
    if (personChip && personLabel) {
        if (assignedPerson) {
            const initials = getPersonInitials(assignedPerson.firstName, assignedPerson.lastName);
            personChip.textContent = initials;
            personChip.title = getPersonDisplayName(assignedPerson);
            personChip.className = 'kanban-menu-chip card-person-avatar';
            personChip.classList.remove('empty');
        } else {
            personChip.className = 'kanban-menu-chip empty';
        }
    }

    // Etiqueta
    if (tagChip && tagLabel) {
        if (tag) {
            tagChip.textContent = getTagDisplayName(tag);
            tagChip.className = 'kanban-menu-chip card-tag chip-tag';
            tagChip.classList.remove('empty');
        } else {
            tagChip.className = 'kanban-menu-chip empty';
        }
    }

    // Marcar (solo icono en el botón)
    if (markIcon) {
        if (marked) {
            markIcon.classList.remove('empty');
        } else {
            markIcon.classList.add('empty');
        }
    }
}

// Poblar dropdown de prioridades
function populatePriorityDropdown(currentPriority) {
    const dropdown = document.getElementById('priorityDropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '';
    const priorityLabels = {
        'p1': 'P1',
        'p2': 'P2',
        'p3': 'P3',
        'p4': 'P4',
        'p5': 'P5'
    };
    
    const priorities = [
        { value: 'p1', label: 'Muy alta' },
        { value: 'p2', label: 'Alta' },
        { value: 'p3', label: 'Media' },
        { value: 'p4', label: 'Baja' },
        { value: 'p5', label: 'Muy baja' }
    ];

    priorities.forEach(prio => {
        const option = document.createElement('div');
        option.className = 'kanban-menu-option';
        if (prio.value === currentPriority) {
            option.classList.add('selected');
        }
        option.setAttribute('data-priority', prio.value);

        const chip = document.createElement('span');
        chip.className = `kanban-menu-option-chip card-priority chip-priority chip-${prio.value}`;
        chip.textContent = priorityLabels[prio.value] || prio.value.toUpperCase();
        option.appendChild(chip);

        const label = document.createElement('span');
        label.textContent = prio.label;
        option.appendChild(label);

        option.addEventListener('click', () => {
            if (currentContextBlock) {
                updateBlockPriority(currentContextBlock.noteId, currentContextBlock.blockIndex, prio.value);
                closeAllDropdowns();
            }
        });

        dropdown.appendChild(option);
    });

    // Opción para quitar prioridad
    const noPriorityOption = document.createElement('div');
    noPriorityOption.className = 'kanban-menu-option';
    if (!currentPriority || currentPriority === '') {
        noPriorityOption.classList.add('selected');
    }
    noPriorityOption.setAttribute('data-priority', '');
    noPriorityOption.textContent = 'Sin prioridad';
    noPriorityOption.addEventListener('click', () => {
        if (currentContextBlock) {
            updateBlockPriority(currentContextBlock.noteId, currentContextBlock.blockIndex, '');
            closeAllDropdowns();
        }
    });
    dropdown.appendChild(noPriorityOption);

    // Inicializar iconos de Lucide
    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons({ container: dropdown });
        });
    }
}

// Poblar dropdown de etiquetas
function populateTagDropdown(currentTagId) {
    const dropdown = document.getElementById('tagDropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '';
    const tags = getActiveTags();

    if (tags.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'kanban-menu-option';
        empty.style.color = '#888888';
        empty.style.cursor = 'default';
        empty.textContent = 'No hay etiquetas';
        dropdown.appendChild(empty);
    } else {
        tags.forEach(tag => {
            const option = document.createElement('div');
            option.className = 'kanban-menu-option';
            if (tag.id === currentTagId) {
                option.classList.add('selected');
            }
            option.setAttribute('data-tag-id', tag.id);

            const chip = document.createElement('span');
            chip.className = 'kanban-menu-option-chip card-tag chip-tag';
            chip.textContent = tag.name;
            option.appendChild(chip);

            option.addEventListener('click', () => {
                if (currentContextBlock) {
                    updateBlockTag(currentContextBlock.noteId, currentContextBlock.blockIndex, tag.id);
                    closeAllDropdowns();
                }
            });

            dropdown.appendChild(option);
        });

        // Opción para quitar etiqueta
        const noTagOption = document.createElement('div');
        noTagOption.className = 'kanban-menu-option';
        if (!currentTagId || currentTagId === '') {
            noTagOption.classList.add('selected');
        }
        noTagOption.textContent = 'Sin etiqueta';
        noTagOption.addEventListener('click', () => {
            if (currentContextBlock) {
                updateBlockTag(currentContextBlock.noteId, currentContextBlock.blockIndex, '');
                closeAllDropdowns();
            }
        });
        dropdown.appendChild(noTagOption);
    }

    // Inicializar iconos de Lucide
    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons({ container: dropdown });
        });
    }
}

// Configurar event listeners del menú contextual
function setupContextMenu() {
    const contextMenu = document.getElementById('cardContextMenu');
    if (!contextMenu) return;

    // Botón de prioridad
    const priorityMenuBtn = document.getElementById('priorityMenuBtn');
    if (priorityMenuBtn) {
        priorityMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menuItem = priorityMenuBtn.closest('.kanban-menu-item');
            if (menuItem) {
                const isActive = menuItem.classList.contains('active');
                closeAllDropdowns();
                if (!isActive) {
                    menuItem.classList.add('active');
                }
            }
        });
    }

    // Botón de persona
    const personMenuBtn = document.getElementById('personMenuBtn');
    if (personMenuBtn) {
        personMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menuItem = personMenuBtn.closest('.kanban-menu-item');
            if (menuItem) {
                const isActive = menuItem.classList.contains('active');
                closeAllDropdowns();
                if (!isActive) {
                    menuItem.classList.add('active');
                    const input = document.getElementById('personSearchInput');
                    if (input) {
                        setTimeout(() => input.focus(), 50);
                    }
                }
            }
        });
    }

    // Búsqueda de personas
    const personSearchInput = document.getElementById('personSearchInput');
    if (personSearchInput) {
        setupContextPersonSearch(personSearchInput);
    }

    // Botón de etiqueta
    const tagMenuBtn = document.getElementById('tagMenuBtn');
    if (tagMenuBtn) {
        tagMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menuItem = tagMenuBtn.closest('.kanban-menu-item');
            if (menuItem) {
                const isActive = menuItem.classList.contains('active');
                closeAllDropdowns();
                if (!isActive) {
                    menuItem.classList.add('active');
                }
            }
        });
    }

    // Botón de marcar (activar/desactivar, sin dropdown)
    const markMenuBtn = document.getElementById('markMenuBtn');
    if (markMenuBtn) {
        markMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentContextBlock) {
                toggleBlockMark(currentContextBlock.noteId, currentContextBlock.blockIndex);
            }
        });
    }

    // Botón de eliminar
    const deleteMenuBtn = document.getElementById('deleteMenuBtn');
    if (deleteMenuBtn) {
        deleteMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentContextBlock) {
                closeContextMenu();
                showDeleteModal(currentContextBlock.noteId, currentContextBlock.blockIndex);
            }
        });
    }
}

// Configurar búsqueda de personas en el menú contextual
function setupContextPersonSearch(input) {
    let searchTimeout = null;
    let selectedIndex = -1;

    input.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        clearTimeout(searchTimeout);
        
        searchTimeout = setTimeout(() => {
            const results = document.getElementById('personSearchResults');
            if (!results) return;

            const persons = getActivePersons();
            let filtered = persons;

            if (query !== '') {
                filtered = persons.filter(p => {
                    const fullName = p.lastName 
                        ? `${p.firstName} ${p.lastName}`.toLowerCase()
                        : p.firstName.toLowerCase();
                    return fullName.includes(query);
                });
            }

            results.innerHTML = '';
            selectedIndex = -1;

            if (filtered.length === 0) {
                const noResults = document.createElement('div');
                noResults.className = 'kanban-menu-result-item';
                noResults.textContent = 'No se encontraron personas';
                noResults.style.color = '#888888';
                noResults.style.cursor = 'default';
                results.appendChild(noResults);
            } else {
                filtered.forEach((person, index) => {
                    const item = document.createElement('div');
                    item.className = 'kanban-menu-result-item';
                    item.setAttribute('data-person-id', person.id);
                    item.setAttribute('tabindex', '0');
                    
                    const avatar = document.createElement('span');
                    avatar.className = 'kanban-menu-result-avatar card-person-avatar';
                    avatar.textContent = getPersonInitials(person.firstName, person.lastName);
                    item.appendChild(avatar);
                    
                    const name = document.createElement('span');
                    name.textContent = person.lastName 
                        ? `${person.firstName} ${person.lastName}` 
                        : person.firstName;
                    item.appendChild(name);
                    
                    item.addEventListener('click', () => {
                        if (currentContextBlock) {
                            updateBlockPerson(currentContextBlock.noteId, currentContextBlock.blockIndex, person.id);
                            closeAllDropdowns();
                        }
                    });
                    
                    results.appendChild(item);
                });
            }
        }, 150);
    });

    input.addEventListener('keydown', (e) => {
        const results = document.getElementById('personSearchResults');
        if (!results) return;

        const items = Array.from(results.querySelectorAll('.kanban-menu-result-item[data-person-id]'));
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            items[selectedIndex].focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            if (selectedIndex >= 0) {
                items[selectedIndex].focus();
            } else {
                input.focus();
            }
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            const personId = items[selectedIndex].getAttribute('data-person-id');
            if (currentContextBlock && personId) {
                updateBlockPerson(currentContextBlock.noteId, currentContextBlock.blockIndex, personId);
                closeAllDropdowns();
            }
        }
    });
}


// Actualizar prioridad de un bloque
function updateBlockPriority(noteId, blockIndex, priority) {
    const savedNotes = localStorage.getItem('notes');
    if (!savedNotes) return;

    const notes = JSON.parse(savedNotes);
    const note = notes.find(n => n.id === noteId);
    
    if (note && note.blocks && note.blocks[blockIndex]) {
        note.blocks[blockIndex].priority = priority || undefined;
        note.blocks[blockIndex].blockUpdatedAt = new Date().toISOString();
        
        localStorage.setItem('notes', JSON.stringify(notes));
        ipcRenderer.send('note-updated', note);
        
        // Actualizar en memoria
        const blockKey = `${noteId}-${blockIndex}`;
        const blockIndexInAll = allBlocks.findIndex(b => 
            b.noteId === noteId && b.blockIndex === blockIndex
        );
        
        if (blockIndexInAll !== -1) {
            allBlocks[blockIndexInAll].priority = priority || undefined;
            filteredBlocks = applyFilters(allBlocks);
            lastBlocksHash = generateBlocksHash(filteredBlocks);
            
            // Actualizar currentContextBlock si el menú está abierto
            if (currentContextBlock && currentContextBlock.noteId === noteId && currentContextBlock.blockIndex === blockIndex) {
                currentContextBlock = allBlocks[blockIndexInAll];
                updateContextMenuValues(
                    currentContextBlock.status || '',
                    currentContextBlock.priority || '',
                    currentContextBlock.assignedPerson || null,
                    currentContextBlock.tag || null,
                    currentContextBlock.marked || false
                );
                // Repoblar dropdown para reflejar la selección actual
                populatePriorityDropdown(currentContextBlock.priority || '');
            }
            
            // Recrear la tarjeta para reflejar los cambios visuales
            const card = cardCache.get(blockKey);
            if (card) {
                const column = card.parentElement;
                const block = allBlocks[blockIndexInAll];
                const newCard = createCard(block);
                card.replaceWith(newCard);
                cardCache.set(blockKey, newCard);
            } else {
                updateKanbanIncremental();
            }
            restoreFilterValues();
        }
    }
}

// Actualizar persona asignada de un bloque
function updateBlockPerson(noteId, blockIndex, personId) {
    const savedNotes = localStorage.getItem('notes');
    if (!savedNotes) return;

    const notes = JSON.parse(savedNotes);
    const note = notes.find(n => n.id === noteId);
    
    if (note && note.blocks && note.blocks[blockIndex]) {
        if (personId) {
            const persons = loadPersons();
            const person = persons.find(p => p.id === personId);
            if (person) {
                note.blocks[blockIndex].assignedPerson = {
                    id: person.id,
                    firstName: person.firstName,
                    lastName: person.lastName || ''
                };
            }
        } else {
            note.blocks[blockIndex].assignedPerson = undefined;
        }
        note.blocks[blockIndex].blockUpdatedAt = new Date().toISOString();
        
        localStorage.setItem('notes', JSON.stringify(notes));
        ipcRenderer.send('note-updated', note);
        
        // Actualizar en memoria
        const blockKey = `${noteId}-${blockIndex}`;
        const blockIndexInAll = allBlocks.findIndex(b => 
            b.noteId === noteId && b.blockIndex === blockIndex
        );
        
        if (blockIndexInAll !== -1) {
            if (personId) {
                const persons = loadPersons();
                const person = persons.find(p => p.id === personId);
                if (person) {
                    allBlocks[blockIndexInAll].assignedPerson = {
                        id: person.id,
                        firstName: person.firstName,
                        lastName: person.lastName || ''
                    };
                }
            } else {
                allBlocks[blockIndexInAll].assignedPerson = undefined;
            }
            filteredBlocks = applyFilters(allBlocks);
            lastBlocksHash = generateBlocksHash(filteredBlocks);
            
            // Actualizar currentContextBlock si el menú está abierto
            if (currentContextBlock && currentContextBlock.noteId === noteId && currentContextBlock.blockIndex === blockIndex) {
                currentContextBlock = allBlocks[blockIndexInAll];
                updateContextMenuValues(
                    currentContextBlock.status || '',
                    currentContextBlock.priority || '',
                    currentContextBlock.assignedPerson || null,
                    currentContextBlock.tag || null,
                    currentContextBlock.marked || false
                );
            }
            
            // Recrear la tarjeta para reflejar los cambios visuales
            const card = cardCache.get(blockKey);
            if (card) {
                const column = card.parentElement;
                const block = allBlocks[blockIndexInAll];
                const newCard = createCard(block);
                card.replaceWith(newCard);
                cardCache.set(blockKey, newCard);
            } else {
                updateKanbanIncremental();
            }
            restoreFilterValues();
            renderPersonMetrics();
        }
    }
}

// Actualizar etiqueta de un bloque
function updateBlockTag(noteId, blockIndex, tagId) {
    const savedNotes = localStorage.getItem('notes');
    if (!savedNotes) return;

    const notes = JSON.parse(savedNotes);
    const note = notes.find(n => n.id === noteId);
    
    if (note && note.blocks && note.blocks[blockIndex]) {
        if (tagId) {
            const tags = loadTags();
            const tag = tags.find(t => t.id === tagId);
            if (tag) {
                note.blocks[blockIndex].tag = {
                    id: tag.id,
                    name: tag.name
                };
            }
        } else {
            note.blocks[blockIndex].tag = undefined;
        }
        note.blocks[blockIndex].blockUpdatedAt = new Date().toISOString();
        
        localStorage.setItem('notes', JSON.stringify(notes));
        ipcRenderer.send('note-updated', note);
        
        // Actualizar en memoria
        const blockKey = `${noteId}-${blockIndex}`;
        const blockIndexInAll = allBlocks.findIndex(b => 
            b.noteId === noteId && b.blockIndex === blockIndex
        );
        
        if (blockIndexInAll !== -1) {
            if (tagId) {
                const tags = loadTags();
                const tag = tags.find(t => t.id === tagId);
                if (tag) {
                    allBlocks[blockIndexInAll].tag = {
                        id: tag.id,
                        name: tag.name
                    };
                }
            } else {
                allBlocks[blockIndexInAll].tag = undefined;
            }
            filteredBlocks = applyFilters(allBlocks);
            lastBlocksHash = generateBlocksHash(filteredBlocks);
            
            // Actualizar currentContextBlock si el menú está abierto
            if (currentContextBlock && currentContextBlock.noteId === noteId && currentContextBlock.blockIndex === blockIndex) {
                currentContextBlock = allBlocks[blockIndexInAll];
                updateContextMenuValues(
                    currentContextBlock.status || '',
                    currentContextBlock.priority || '',
                    currentContextBlock.assignedPerson || null,
                    currentContextBlock.tag || null,
                    currentContextBlock.marked || false
                );
                populateTagDropdown(currentContextBlock.tag ? currentContextBlock.tag.id : '');
            }
            
            // Recrear la tarjeta para reflejar los cambios visuales
            const card = cardCache.get(blockKey);
            if (card) {
                const column = card.parentElement;
                const block = allBlocks[blockIndexInAll];
                const newCard = createCard(block);
                card.replaceWith(newCard);
                cardCache.set(blockKey, newCard);
            } else {
                updateKanbanIncremental();
            }
            restoreFilterValues();
        }
    }
}

// Alternar marcado de un bloque
function toggleBlockMark(noteId, blockIndex) {
    const savedNotes = localStorage.getItem('notes');
    if (!savedNotes) return;

    const notes = JSON.parse(savedNotes);
    const note = notes.find(n => n.id === noteId);
    
    if (note && note.blocks && note.blocks[blockIndex]) {
        const currentMarked = note.blocks[blockIndex].marked || false;
        note.blocks[blockIndex].marked = !currentMarked;
        note.blocks[blockIndex].blockUpdatedAt = new Date().toISOString();
        
        localStorage.setItem('notes', JSON.stringify(notes));
        ipcRenderer.send('note-updated', note);
        
        // Actualizar en memoria y UI
        const blockKey = `${noteId}-${blockIndex}`;
        const blockIndexInAll = allBlocks.findIndex(b => 
            b.noteId === noteId && b.blockIndex === blockIndex
        );
        
        if (blockIndexInAll !== -1) {
            allBlocks[blockIndexInAll].marked = !currentMarked;
            
            // Actualizar currentContextBlock si el menú está abierto
            if (currentContextBlock && currentContextBlock.noteId === noteId && currentContextBlock.blockIndex === blockIndex) {
                currentContextBlock = allBlocks[blockIndexInAll];
                updateContextMenuValues(
                    currentContextBlock.status || '',
                    currentContextBlock.priority || '',
                    currentContextBlock.assignedPerson || null,
                    currentContextBlock.tag || null,
                    currentContextBlock.marked || false
                );
                const markIcon = document.getElementById('markIcon');
                if (markIcon && typeof lucide !== 'undefined') {
                    lucide.createIcons({ container: markIcon });
                }
            }
            
            // Actualizar visualmente la tarjeta
            const card = cardCache.get(blockKey);
            if (card) {
                if (!currentMarked) {
                    card.classList.add('marked');
                } else {
                    card.classList.remove('marked');
                }
            }
            
            filteredBlocks = applyFilters(allBlocks);
            lastBlocksHash = generateBlocksHash(filteredBlocks);
        }
    }
}

function setupToggleDoneColumn() {
    const btn = document.getElementById('toggleDoneColumnBtn');
    const doneColumn = document.querySelector('.kanban-column[data-status="hecho"]');
    if (!btn || !doneColumn) return;
    
    // Cargar estado guardado
    const isHidden = localStorage.getItem('kanbanDoneColumnHidden') === 'true';
    
    // Aplicar estado inicial
    if (isHidden) {
        doneColumn.classList.add('hidden');
        updateToggleDoneColumnIcon(btn, true);
    } else {
        doneColumn.classList.remove('hidden');
        updateToggleDoneColumnIcon(btn, false);
    }
    
    // Event listener para toggle
    btn.addEventListener('click', () => {
        const willBeHidden = !doneColumn.classList.contains('hidden');
        if (willBeHidden) {
            doneColumn.classList.add('hidden');
            localStorage.setItem('kanbanDoneColumnHidden', 'true');
            updateToggleDoneColumnIcon(btn, true);
        } else {
            doneColumn.classList.remove('hidden');
            localStorage.setItem('kanbanDoneColumnHidden', 'false');
            updateToggleDoneColumnIcon(btn, false);
        }
    });
}

function updateToggleDoneColumnIcon(btn, isHidden) {
    const icon = btn.querySelector('i');
    if (!icon) return;
    
    // Cambiar el ícono según el estado
    if (isHidden) {
        icon.setAttribute('data-lucide', 'eye');
        btn.setAttribute('title', 'Mostrar columna Hecho');
    } else {
        icon.setAttribute('data-lucide', 'eye-off');
        btn.setAttribute('title', 'Ocultar columna Hecho');
    }
    
    // Recrear el ícono con lucide
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

// Cargar bloques al iniciar
loadBlocks(true, { showLoader: true });


// Configurar botones de ordenar y filtros después de cargar
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setupContextMenu();
        setupToggleDoneColumn();
        setupToggleFilters();
        setupSortButtons();
        populatePersonFilter();
        populateTagFilter();
        setupFilters();
        restoreFilterValues();
        renderPersonMetrics();
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    });
} else {
    setupContextMenu();
    setupToggleDoneColumn();
    setupToggleFilters();
    setupSortButtons();
    populatePersonFilter();
    populateTagFilter();
    setupFilters();
    restoreFilterValues();
    renderPersonMetrics();
}

// Escuchar actualizaciones de notas (unificado con repoblación de filtros)
ipcRenderer.on('notes-updated', () => {
    // Guardar valores actuales de los filtros antes de repoblar
    const currentPersonId = filters.personId;
    const currentPriority = filters.priority;
    const currentTagId = filters.tagId;
    const currentDaysFilter = filters.daysFilter;
    
    // Repoblar filtros por si se agregaron nuevas personas o etiquetas
    populatePersonFilter();
    populateTagFilter();
    
    // Restaurar valores de filtros después de repoblar
    // Esto asegura que los filtros se mantengan incluso si se repoblaron los selectores
    if (currentPersonId) filters.personId = currentPersonId;
    if (currentPriority) filters.priority = currentPriority;
    if (currentTagId) filters.tagId = currentTagId;
    if (currentDaysFilter !== null) filters.daysFilter = currentDaysFilter;
    
    restoreFilterValues();
    loadBlocks(false);
    restoreFilterValues();
    renderPersonMetrics();
});

ipcRenderer.on('data-imported', () => {
    const currentPersonId = filters.personId;
    const currentPriority = filters.priority;
    const currentTagId = filters.tagId;
    const currentDaysFilter = filters.daysFilter;
    populatePersonFilter();
    populateTagFilter();
    if (currentPersonId) filters.personId = currentPersonId;
    if (currentPriority) filters.priority = currentPriority;
    if (currentTagId) filters.tagId = currentTagId;
    if (currentDaysFilter !== null) filters.daysFilter = currentDaysFilter;
    restoreFilterValues();
    loadBlocks(false);
    restoreFilterValues();
    renderPersonMetrics();
});

// NOTA: No usar setInterval para actualizar el Kanban periódicamente.
// Esto causa parpadeo/flickering cada vez que se re-renderiza.
// El Kanban se actualiza automáticamente cuando hay cambios reales a través de:
// - Eventos IPC (notes-updated, note-updated)
// - Acciones del usuario (eliminar bloque, cambiar estado, cerrar nota)
// Esto garantiza una experiencia fluida sin re-renderizados innecesarios.

