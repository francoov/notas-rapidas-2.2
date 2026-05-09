const { ipcRenderer } = require('electron');

let noteId = null;
let noteData = {
    id: null,
    title: '',
    content: '',
    blocks: [], // Array de bloques con metadatos
    createdAt: null,
    updatedAt: null
};

let currentBlockElement = null;
let enterPressed = false;
let enterDialogShown = false;
let menuActiveField = 'status'; // 'status', 'priority', 'person' o 'tag'
let pendingEnterBlock = null;
let selectedPersonIndex = -1; // Índice del resultado de persona seleccionado
let firstSelectedBlockIndex = null; // Índice del primer bloque seleccionado con Shift
let selectedBlocks = new Set(); // Set de bloques seleccionados
let saveNoteDebounceTimer = null;
const SAVE_NOTE_DEBOUNCE_MS = 400;
let lastPersistedSignature = '';

function buildPersistedSignature(data) {
    return JSON.stringify({
        title: data.title || '',
        blocks: data.blocks || []
    });
}

// Pila de deshacer (Ctrl+Z) y rehacer (Ctrl+Shift+Z): copias del estado de la nota
const UNDO_STACK_MAX = 50;
let undoStack = [];
let redoStack = [];

function syncNoteDataFromDom() {
    document.querySelectorAll('.content-block').forEach((block) => saveBlockContent(block));
    const titleEl = document.getElementById('noteTitle');
    if (titleEl) noteData.title = titleEl.value;
}

function cloneCurrentNoteSnapshot() {
    syncNoteDataFromDom();
    return {
        blocks: JSON.parse(JSON.stringify(noteData.blocks || [])),
        title: noteData.title || ''
    };
}

/** @param {{ persist?: boolean }} [options] — persist=false evita escribir a disco (p. ej. cada tecla en beforeinput). */
function pushUndoState(options = {}) {
    const persist = options.persist !== false;
    syncNoteDataFromDom();
    if (persist) {
        saveNote();
    }
    redoStack = []; // nueva edición invalida la rama de rehacer
    const snapshot = {
        blocks: JSON.parse(JSON.stringify(noteData.blocks || [])),
        title: noteData.title || ''
    };
    undoStack.push(snapshot);
    if (undoStack.length > UNDO_STACK_MAX) {
        undoStack.shift();
    }
    updateUndoRedoButtons();
}

function captureCaretForRestore() {
    let restoreBlockIndex = 0;
    let restoreCaretOffset = 0;
    const activeEl = document.activeElement;
    if (activeEl && activeEl.classList && activeEl.classList.contains('block-content')) {
        const block = activeEl.closest('.content-block');
        if (block) {
            const noteContent = document.getElementById('noteContent');
            const blocks = noteContent ? Array.from(noteContent.querySelectorAll('.content-block')) : [];
            restoreBlockIndex = blocks.indexOf(block);
            if (restoreBlockIndex < 0) restoreBlockIndex = 0;
            restoreCaretOffset = getCaretCharacterOffsetWithin(activeEl);
        }
    }
    return { restoreBlockIndex, restoreCaretOffset };
}

function applySnapshotAndRestoreCaret(snapshot, restoreBlockIndex, restoreCaretOffset) {
    noteData.blocks = snapshot.blocks;
    noteData.title = snapshot.title;
    const noteTitleEl = document.getElementById('noteTitle');
    if (noteTitleEl) noteTitleEl.value = noteData.title;
    renderContent();
    const noteContent = document.getElementById('noteContent');
    const blocks = noteContent ? noteContent.querySelectorAll('.content-block') : [];
    const targetIndex = Math.min(restoreBlockIndex, Math.max(0, blocks.length - 1));
    if (targetIndex >= 0 && blocks[targetIndex]) {
        const targetContent = blocks[targetIndex].querySelector('.block-content');
        if (targetContent) {
            targetContent.focus();
            const maxOffset = (targetContent.textContent || '').length;
            setCaretPosition(targetContent, Math.min(restoreCaretOffset, maxOffset));
        }
    } else {
        const firstBlock = document.querySelector('.content-block .block-content');
        if (firstBlock) {
            firstBlock.focus();
            setCaretPosition(firstBlock, 0);
        }
    }
    saveNote();
}

function popUndoState() {
    if (undoStack.length === 0) return false;
    const { restoreBlockIndex, restoreCaretOffset } = captureCaretForRestore();
    redoStack.push(cloneCurrentNoteSnapshot());
    if (redoStack.length > UNDO_STACK_MAX) {
        redoStack.shift();
    }
    const snapshot = undoStack.pop();
    applySnapshotAndRestoreCaret(snapshot, restoreBlockIndex, restoreCaretOffset);
    updateUndoRedoButtons();
    return true;
}

function popRedoState() {
    if (redoStack.length === 0) return false;
    const { restoreBlockIndex, restoreCaretOffset } = captureCaretForRestore();
    undoStack.push(cloneCurrentNoteSnapshot());
    if (undoStack.length > UNDO_STACK_MAX) {
        undoStack.shift();
    }
    const snapshot = redoStack.pop();
    applySnapshotAndRestoreCaret(snapshot, restoreBlockIndex, restoreCaretOffset);
    updateUndoRedoButtons();
    return true;
}

function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

// Obtener ID de la nota desde la URL
function getNoteId() {
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');
    return id || Date.now().toString();
}

// Cargar nota del localStorage
function loadNote() {
    undoStack = [];
    redoStack = [];
    noteId = getNoteId();
    const savedNotes = localStorage.getItem('notes');
    let isNewNote = false;
    
    if (savedNotes) {
        const notes = JSON.parse(savedNotes);
        const note = notes.find(n => n.id === noteId);
        if (note) {
            noteData = { ...note };
            // Asegurar que blocks existe
            if (!noteData.blocks) {
                noteData.blocks = [];
            }
            document.getElementById('noteTitle').value = noteData.title || '';
            renderContent();
        } else {
            // Nueva nota
            isNewNote = true;
            noteData.id = noteId;
            noteData.createdAt = new Date().toISOString();
            noteData.updatedAt = new Date().toISOString();
            noteData.blocks = [];
            renderContent(); // Renderizar bloque vacío inicial
        }
    } else {
        // Primera nota
        isNewNote = true;
        noteId = getNoteId();
        noteData.id = noteId;
        noteData.createdAt = new Date().toISOString();
        noteData.updatedAt = new Date().toISOString();
        noteData.blocks = [];
        renderContent(); // Renderizar bloque vacío inicial
    }
    lastPersistedSignature = buildPersistedSignature(noteData);
    
    // Si es una nota nueva, enfocar el título después de renderizar
    if (isNewNote) {
        setTimeout(() => {
            const titleInput = document.getElementById('noteTitle');
            if (titleInput) {
                titleInput.focus();
                titleInput.select(); // Seleccionar el texto para sobrescribir fácilmente
            }
        }, 100);
    }
    updateUndoRedoButtons();
}

// Renderizar contenido desde bloques
function renderContent() {
    const noteContent = document.getElementById('noteContent');
    noteContent.innerHTML = '';
    
    // Limpiar selección al renderizar
    clearBlockSelection();
    
    if (!noteData.blocks || noteData.blocks.length === 0) {
        // Si no hay bloques, crear uno vacío
        const block = createBlockElement('', null);
        noteContent.appendChild(block);
        // Inicializar blocks array
        noteData.blocks = [{
            content: '',
            status: '',
            priority: '',
            tag: null
        }];
    } else {
        noteData.blocks.forEach((blockData, index) => {
            const block = createBlockElement(blockData.content || '', blockData);
            block.dataset.blockIndex = index;
            // Si hay una persona asignada, guardar el ID en el dataset
            if (blockData.assignedPerson && blockData.assignedPerson.id) {
                block.dataset.assignedPersonId = blockData.assignedPerson.id;
            }
            // Si hay una etiqueta asignada, guardar el ID en el dataset
            if (blockData.tag && blockData.tag.id) {
                block.dataset.tagId = blockData.tag.id;
            }
            // Actualizar clase marked si el bloque está marcado
            if (blockData.marked) {
                block.classList.add('marked');
            } else {
                block.classList.remove('marked');
            }
            noteContent.appendChild(block);
        });
    }
    
    setupBlockHandles();
}

// Crear elemento de bloque
function createBlockElement(content, blockData) {
    const block = document.createElement('div');
    block.className = 'content-block';
    
    if (blockData) {
        block.dataset.status = blockData.status || '';
        block.dataset.priority = blockData.priority || '';
        if (blockData.tag && blockData.tag.id) {
            block.dataset.tagId = blockData.tag.id;
        }
        // Agregar clase "marked" si el bloque está marcado
        if (blockData.marked) {
            block.classList.add('marked');
        }
    }
    
    // Crear contenedor de contenido
    const contentDiv = document.createElement('div');
    contentDiv.className = 'block-content';
    contentDiv.contentEditable = 'true';
    contentDiv.innerHTML = content || '';
    block.appendChild(contentDiv);
    
    // Crear contenedor de chips
    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'block-chips';
    block.appendChild(chipsContainer);
    
    // Crear handle
    const handle = document.createElement('div');
    handle.className = 'block-handle';
    handle.innerHTML = '<div class="handle-dots">⋮⋮</div>';
    block.appendChild(handle);
    
    // Actualizar chips si hay metadatos
    if (blockData && (blockData.status || blockData.priority)) {
        updateBlockChips(block, blockData);
    }
    
    return block;
}

// Actualizar chips de un bloque
function updateBlockChips(block, blockData) {
    const chipsContainer = block.querySelector('.block-chips');
    chipsContainer.innerHTML = '';
    
    const statusLabels = {
        'pendiente': 'Pendiente',
        'en-progreso': 'En progreso',
        'hecho': 'Hecho'
    };
    
    const statusOrder = ['', 'pendiente', 'en-progreso', 'hecho'];
    
    const priorityLabels = {
        'p5': 'P5',
        'p4': 'P4',
        'p3': 'P3',
        'p2': 'P2',
        'p1': 'P1'
    };
    
    const priorityOrder = ['p5', 'p4', 'p3', 'p2', 'p1'];
    
    if (blockData.status) {
        const chip = document.createElement('span');
        chip.className = `chip chip-status chip-${blockData.status}`;
        chip.textContent = statusLabels[blockData.status] || blockData.status;
        chipsContainer.appendChild(chip);
    }
    
    if (blockData.priority) {
        const chip = document.createElement('span');
        chip.className = `chip chip-priority chip-${blockData.priority}`;
        chip.textContent = priorityLabels[blockData.priority] || blockData.priority;
        chipsContainer.appendChild(chip);
    }
    
    if (blockData.assignedPerson) {
        const chip = document.createElement('span');
        chip.className = 'chip chip-person';
        const initials = getInitials(blockData.assignedPerson.firstName, blockData.assignedPerson.lastName);
        chip.textContent = initials;
        chip.title = getPersonDisplayName(blockData.assignedPerson);
        chipsContainer.appendChild(chip);
    }
    
    // Mostrar etiqueta del bloque si existe (con "(Eliminado)" si la etiqueta fue soft-deleted)
    if (blockData.tag && (blockData.tag.name || blockData.tag.id)) {
        const chip = document.createElement('span');
        chip.className = 'chip chip-tag';
        chip.textContent = getTagDisplayName(blockData.tag);
        chipsContainer.appendChild(chip);
    }
}

// Obtener índice del bloque
function getBlockIndex(blockElement) {
    const noteContent = document.getElementById('noteContent');
    return Array.from(noteContent.children).indexOf(blockElement);
}

// Obtener la posición del cursor (offset en caracteres) desde el inicio del elemento contentEditable
function getCaretCharacterOffsetWithin(element) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return 0;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) return 0;
    try {
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(element);
        preCaretRange.setEnd(range.startContainer, range.startOffset);
        return preCaretRange.toString().length;
    } catch (err) {
        return 0;
    }
}

// Colocar el cursor en el elemento contentEditable en la posición dada (offset en caracteres)
function setCaretPosition(element, characterOffset) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    let currentOffset = 0;
    let placed = false;
    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const len = (node.textContent || '').length;
            if (currentOffset + len >= characterOffset) {
                range.setStart(node, Math.min(characterOffset - currentOffset, len));
                range.collapse(true);
                return true;
            }
            currentOffset += len;
            return false;
        }
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            for (let i = 0; i < node.childNodes.length; i++) {
                if (walk(node.childNodes[i])) return true;
            }
        }
        return false;
    }
    placed = walk(element);
    if (!placed) {
        range.selectNodeContents(element);
        range.collapse(true);
    }
    selection.removeAllRanges();
    selection.addRange(range);
}

// Verificar si un bloque tiene formato de lista (bullet point)
function hasListFormat(contentDiv) {
    if (!contentDiv) return false;
    
    // Verificar si hay elementos <ul> o <li> en el contenido
    const hasListElements = contentDiv.querySelector('ul, li') !== null;
    
    if (hasListElements) {
        return true;
    }
    
    // Verificar si el comando de lista está activo en la selección actual
    // Solo verificar si el elemento tiene foco
    try {
        if (document.activeElement === contentDiv) {
            const isListActive = document.queryCommandState('insertUnorderedList');
            if (isListActive) {
                return true;
            }
        }
    } catch (e) {
        // Si hay error, ignorar y continuar
    }
    
    // Verificar si el contenido HTML contiene estructura de lista
    const htmlContent = contentDiv.innerHTML || '';
    if (htmlContent.includes('<ul>') || htmlContent.includes('<li>')) {
        return true;
    }
    
    return false;
}

// Obtener o crear datos del bloque
function getBlockData(blockElement) {
    const index = getBlockIndex(blockElement);
    if (!noteData.blocks[index]) {
        noteData.blocks[index] = {
            content: '',
            status: '',
            priority: '',
            assignedPerson: null,
            tag: null
        };
    }
    // Si hay un assignedPersonId en el dataset, cargar la persona completa
    if (blockElement.dataset.assignedPersonId && !noteData.blocks[index].assignedPerson) {
        const persons = loadPersons();
        const person = persons.find(p => p.id === blockElement.dataset.assignedPersonId);
        if (person) {
            noteData.blocks[index].assignedPerson = person;
        }
    }
    // Si hay un tagId en el dataset, cargar la etiqueta completa
    if (blockElement.dataset.tagId && !noteData.blocks[index].tag) {
        const tags = getAllTags();
        const tag = tags.find(t => t.id === blockElement.dataset.tagId);
        if (tag) {
            noteData.blocks[index].tag = tag;
        }
    }
    return noteData.blocks[index];
}

// Guardar contenido del bloque
function saveBlockContent(blockElement) {
    const blockData = getBlockData(blockElement);
    const contentDiv = blockElement.querySelector('.block-content');
    const oldContent = blockData.content || '';
    const newContent = contentDiv.innerHTML;
    
    blockData.content = newContent;
    blockData.status = blockElement.dataset.status || '';
    blockData.priority = blockElement.dataset.priority || '';
    // La persona asignada ya está en blockData.assignedPerson
    // La etiqueta ya está en blockData.tag
    
    // Actualizar blockUpdatedAt si el contenido cambió
    if (oldContent !== newContent) {
        blockData.blockUpdatedAt = new Date().toISOString();
    }
}

// Seleccionar bloques con Shift
function selectBlocksRange(startIndex, endIndex) {
    const noteContent = document.getElementById('noteContent');
    const blocks = Array.from(noteContent.querySelectorAll('.content-block'));
    
    // Limpiar selección visual anterior (pero mantener firstSelectedBlockIndex)
    selectedBlocks.forEach(block => {
        block.classList.remove('block-selected');
    });
    selectedBlocks.clear();
    
    // Determinar el rango
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    
    // Seleccionar todos los bloques en el rango
    for (let i = minIndex; i <= maxIndex; i++) {
        if (blocks[i]) {
            blocks[i].classList.add('block-selected');
            selectedBlocks.add(blocks[i]);
        }
    }
}

// Limpiar selección de bloques
function clearBlockSelection() {
    selectedBlocks.forEach(block => {
        block.classList.remove('block-selected');
    });
    selectedBlocks.clear();
    firstSelectedBlockIndex = null;
    
    // También limpiar el focus desde Kanban con fade out
    document.querySelectorAll('.content-block.block-focused-from-kanban').forEach(block => {
        if (!block.classList.contains('fade-out')) {
            block.classList.add('fade-out');
            setTimeout(() => {
                block.classList.remove('block-focused-from-kanban', 'fade-out');
            }, 300);
        }
    });
}

// Obtener índice de un bloque
function getBlockIndexFromElement(blockElement) {
    const noteContent = document.getElementById('noteContent');
    const blocks = Array.from(noteContent.querySelectorAll('.content-block'));
    return blocks.indexOf(blockElement);
}

// Configurar handles de bloques
function setupBlockHandles() {
    const blocks = document.querySelectorAll('.content-block');
    
    blocks.forEach(block => {
        const handle = block.querySelector('.block-handle');
        const contentDiv = block.querySelector('.block-content');
        
        // Mostrar handle en hover
        block.addEventListener('mouseenter', () => {
            if (handle) handle.style.display = 'flex';
        });
        
        block.addEventListener('mouseleave', (e) => {
            // No ocultar si el mouse está sobre el menú
            const menu = document.getElementById('handleMenu');
            if (handle && (!menu.classList.contains('show') || !menu.contains(e.relatedTarget))) {
                handle.style.display = 'none';
            }
        });
        
        // Click en el bloque (para selección con Shift) - usar capture para interceptar antes
        block.addEventListener('click', (e) => {
            const clickedOnHandle = e.target.closest('.block-handle');
            
            // No procesar si es click en el handle
            if (clickedOnHandle) {
                return;
            }
            
            // Si se presiona Shift, seleccionar rango (en cualquier parte del bloque)
            if (e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                
                const currentIndex = getBlockIndexFromElement(block);
                if (currentIndex === -1) return;
                
                if (firstSelectedBlockIndex !== null && firstSelectedBlockIndex !== currentIndex) {
                    // Seleccionar rango desde el primer bloque hasta este
                    selectBlocksRange(firstSelectedBlockIndex, currentIndex);
                } else if (firstSelectedBlockIndex === null) {
                    // Primer bloque seleccionado con Shift
                    firstSelectedBlockIndex = currentIndex;
                    block.classList.add('block-selected');
                    selectedBlocks.add(block);
                }
                // Quitar foco del contenido editable para poder borrar con Delete sin problemas
                const active = document.activeElement;
                if (active && active.classList && active.classList.contains('block-content')) {
                    active.blur();
                }
            } else {
                // Click normal sin Shift, limpiar selección (excepto si es en chips o handle)
                const clickedOnChips = e.target.closest('.block-chips');
                if (!clickedOnChips) {
                    clearBlockSelection();
                }
            }
        }, true); // Usar capture phase para interceptar antes
        
        // Click en handle
        if (handle) {
            handle.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                console.log('Click en handle del bloque:', block);
                // Limpiar selección al abrir menú
                clearBlockSelection();
                openHandleMenu(block, handle);
            });
        }
        
        // Hacer el contenido editable
        if (contentDiv) {
            // Limpiar selección al hacer focus en el contenido editable (solo si no hay Shift y no viene del Kanban)
            contentDiv.addEventListener('focus', (e) => {
                if (!e.shiftKey) {
                    // No limpiar si el bloque tiene focus desde Kanban
                    const blockElement = contentDiv.closest('.content-block');
                    if (blockElement && !blockElement.classList.contains('block-focused-from-kanban')) {
                        clearBlockSelection();
                    }
                }
            });
            
            // Manejar click en contenido editable con Shift
            contentDiv.addEventListener('mousedown', (e) => {
                if (e.shiftKey) {
                    // Si hay Shift, prevenir el focus y dejar que el bloque maneje la selección
                    e.preventDefault();
                    e.stopPropagation();
                    // Disparar el evento click en el bloque para que maneje la selección
                    block.dispatchEvent(new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        shiftKey: true,
                        clientX: e.clientX,
                        clientY: e.clientY
                    }));
                } else {
                    // Sin Shift, limpiar selección y permitir edición normal
                    clearBlockSelection();
                }
            }, true); // Usar capture para interceptar antes
            
            // El pegado se maneja con un único listener por delegación (ver initPasteHandler) para evitar múltiples inserciones
            
            // Detectar "/" usando el evento input (más confiable)
            contentDiv.addEventListener('input', function(e) {
                // Asegurar que el elemento mantenga el foco
                if (document.activeElement !== contentDiv) {
                    contentDiv.focus();
                }
                
                const text = contentDiv.textContent || contentDiv.innerText || '';
                const selection = window.getSelection();
                
                if (selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    const cursorPosition = range.startOffset;
                    
                    // Verificar si el último carácter insertado es "/"
                    if (text.length > 0 && text[cursorPosition - 1] === '/') {
                        // Eliminar el "/" del texto
                        const textBefore = text.substring(0, cursorPosition - 1);
                        const textAfter = text.substring(cursorPosition);
                        contentDiv.textContent = textBefore + textAfter;
                        
                        // Restaurar la posición del cursor y mantener el foco
                        setTimeout(() => {
                            contentDiv.focus(); // Asegurar foco
                            const range = document.createRange();
                            const sel = window.getSelection();
                            const textNode = contentDiv.firstChild;
                            if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                                const newPosition = Math.min(cursorPosition - 1, textBefore.length);
                                range.setStart(textNode, newPosition);
                                range.collapse(true);
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                        }, 0);
                        
                        // Abrir el menú del handle
                        const handle = block.querySelector('.block-handle');
                        if (handle) {
                            openHandleMenu(block, handle);
                        } else {
                            openHandleMenu(block, block);
                        }
                        return;
                    }
                    
                    // Detectar guión (-) al inicio de la línea para convertir a lista automáticamente
                    if (text.length > 0 && text[cursorPosition - 1] === '-') {
                        // Verificar si el guión está al inicio de la línea o del bloque
                        const textBeforeCursor = text.substring(0, cursorPosition);
                        const lines = textBeforeCursor.split('\n');
                        const currentLine = lines[lines.length - 1];
                        
                        // Si el guión está al inicio (solo espacios antes, si los hay, o está al inicio del bloque)
                        const isAtStart = currentLine.trim() === '-' || 
                                        currentLine.match(/^\s*-\s*$/) || 
                                        (cursorPosition === 1 && text[0] === '-');
                        
                        if (isAtStart) {
                            // Eliminar el guión
                            const textAfterCursor = text.substring(cursorPosition);
                            const textBeforeMinus = textBeforeCursor.substring(0, textBeforeCursor.length - 1);
                            
                            // Reemplazar el contenido sin el guión
                            contentDiv.textContent = textBeforeMinus + textAfterCursor;
                            
                            // Restaurar la posición del cursor y aplicar formato de lista
                            setTimeout(() => {
                                contentDiv.focus(); // Asegurar foco
                                const range = document.createRange();
                                const sel = window.getSelection();
                                
                                // Nueva posición del cursor (después de eliminar el guión)
                                const newCursorPosition = Math.max(0, cursorPosition - 1);
                                
                                // Seleccionar todo el contenido del bloque para aplicar la lista
                                range.selectNodeContents(contentDiv);
                                range.collapse(false);
                                sel.removeAllRanges();
                                sel.addRange(range);
                                
                                // Aplicar formato de lista
                                document.execCommand('insertUnorderedList', false, null);
                                
                                // Actualizar estado del toolbar
                                updateToolbarState();
                                
                                // Mover cursor a la posición correcta dentro del <li>
                                setTimeout(() => {
                                    contentDiv.focus(); // Asegurar foco
                                    const newSel = window.getSelection();
                                    if (newSel.rangeCount > 0) {
                                        const newRange = newSel.getRangeAt(0);
                                        
                                        // Encontrar el <li> actual
                                        let liElement = newRange.commonAncestorContainer;
                                        if (liElement.nodeType !== Node.ELEMENT_NODE) {
                                            liElement = liElement.parentElement;
                                        }
                                        while (liElement && liElement.tagName !== 'LI' && liElement !== contentDiv) {
                                            liElement = liElement.parentElement;
                                        }
                                        
                                        if (liElement && liElement.tagName === 'LI') {
                                            // Mover cursor al inicio del contenido del <li>
                                            const range2 = document.createRange();
                                            range2.selectNodeContents(liElement);
                                            range2.collapse(true);
                                            newSel.removeAllRanges();
                                            newSel.addRange(range2);
                                        } else {
                                            // Si no hay <li>, mover al inicio del bloque
                                            const range2 = document.createRange();
                                            range2.setStart(contentDiv, 0);
                                            range2.collapse(true);
                                            newSel.removeAllRanges();
                                            newSel.addRange(range2);
                                        }
                                    }
                                }, 10);
                            }, 0);
                            
                            return;
                        }
                    }
                }
                
                // Guardar el contenido en memoria de inmediato; guardar a disco/IPC con debounce para no perder foco al escribir rápido
                saveBlockContent(block);
                if (saveNoteDebounceTimer) clearTimeout(saveNoteDebounceTimer);
                saveNoteDebounceTimer = setTimeout(() => {
                    saveNoteDebounceTimer = null;
                    saveNote();
                }, SAVE_NOTE_DEBOUNCE_MS);
            });
            
            // Manejar teclas en el bloque
            contentDiv.addEventListener('keydown', function(e) {
                // Navegación entre bloques con flechas
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    const selection = window.getSelection();
                    if (selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        const isAtStart = range.startOffset === 0 && range.collapsed;
                        const isAtEnd = range.endOffset === (range.endContainer.textContent?.length || 0) && range.collapsed;
                        
                        // Verificar si el cursor está al inicio o al final
                        const contentText = contentDiv.textContent || '';
                        const cursorPosition = range.startOffset;
                        const isAtBeginning = cursorPosition === 0;
                        const isAtEnding = cursorPosition >= contentText.length;
                        
                        if ((e.key === 'ArrowUp' && isAtBeginning) || 
                            (e.key === 'ArrowDown' && isAtEnding)) {
                            e.preventDefault();
                            
                            const noteContent = document.getElementById('noteContent');
                            const blocks = Array.from(noteContent.querySelectorAll('.content-block'));
                            const currentIndex = blocks.indexOf(block);
                            
                            let targetBlock = null;
                            if (e.key === 'ArrowUp' && currentIndex > 0) {
                                // Mover al bloque anterior
                                targetBlock = blocks[currentIndex - 1];
                            } else if (e.key === 'ArrowDown' && currentIndex < blocks.length - 1) {
                                // Mover al bloque siguiente
                                targetBlock = blocks[currentIndex + 1];
                            }
                            
                            if (targetBlock) {
                                const targetContent = targetBlock.querySelector('.block-content');
                                if (targetContent) {
                                    targetContent.focus();
                                    // Posicionar al final del texto del bloque destino de forma síncrona (evita parpadeo al inicio)
                                    const newRange = document.createRange();
                                    newRange.selectNodeContents(targetContent);
                                    newRange.collapse(false);
                                    const newSelection = window.getSelection();
                                    newSelection.removeAllRanges();
                                    newSelection.addRange(newRange);
                                }
                            }
                            return;
                        }
                    }
                }
                
                // Detectar Delete cuando todo el contenido está seleccionado
                if (e.key === 'Delete' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                    const selection = window.getSelection();
                    if (selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        const contentText = contentDiv.textContent || '';
                        const selectedText = selection.toString();
                        
                        // Si todo el contenido está seleccionado
                        if (selectedText.length > 0 && selectedText.trim() === contentText.trim() && contentText.length > 0) {
                            e.preventDefault();
                            e.stopPropagation();
                            
                            const noteContent = document.getElementById('noteContent');
                            const blocks = noteContent.querySelectorAll('.content-block');
                            
                            // No eliminar si solo hay un bloque
                            if (blocks.length > 1) {
                                const currentIndex = getBlockIndex(block);
                                const nextBlock = block.nextElementSibling;
                                const prevBlock = block.previousElementSibling;
                                
                                // Eliminar el bloque
                                block.remove();
                                
                                // Eliminar de noteData.blocks
                                noteData.blocks.splice(currentIndex, 1);
                                
                                // Actualizar índices de todos los bloques
                                const remainingBlocks = noteContent.querySelectorAll('.content-block');
                                remainingBlocks.forEach((b, idx) => {
                                    b.dataset.blockIndex = idx;
                                });
                                
                                // Reconfigurar handles
                                setupBlockHandles();
                                
                                // Mover foco al bloque siguiente o anterior
                                setTimeout(() => {
                                    const targetBlock = nextBlock || prevBlock;
                                    if (targetBlock) {
                                        const targetContent = targetBlock.querySelector('.block-content');
                                        if (targetContent) {
                                            targetContent.focus();
                                            // Mover cursor al inicio del bloque
                                            const range = document.createRange();
                                            const sel = window.getSelection();
                                            range.setStart(targetContent, 0);
                                            range.collapse(true);
                                            sel.removeAllRanges();
                                            sel.addRange(range);
                                        }
                                    }
                                }, 10);
                                
                                saveNote();
                                return false;
                            }
                        }
                    }
                }
                
                // Backspace al inicio de un bullet que solo tiene espacios: quitar el bullet (no obligar a borrar espacio por espacio)
                if (e.key === 'Backspace' && !e.shiftKey && hasListFormat(contentDiv)) {
                    const rawContent = contentDiv.textContent || '';
                    const onlySpaces = rawContent.trim() === '' && rawContent.length > 0;
                    const cursorAtStart = getCaretCharacterOffsetWithin(contentDiv) === 0;
                    if (onlySpaces && cursorAtStart) {
                        e.preventDefault();
                        e.stopPropagation();
                        const selection = window.getSelection();
                        const range = document.createRange();
                        range.selectNodeContents(contentDiv);
                        selection.removeAllRanges();
                        selection.addRange(range);
                        document.execCommand('insertUnorderedList', false, null);
                        selection.removeAllRanges();
                        contentDiv.focus();
                        setCaretPosition(contentDiv, 0);
                        saveBlockContent(block);
                        saveNote();
                        return false;
                    }
                }
                
                // Detectar Delete o Backspace cuando el bloque está vacío (solo eliminar cuando no quede ningún carácter)
                if ((e.key === 'Delete' || e.key === 'Backspace') && !e.shiftKey) {
                    const rawContent = contentDiv.textContent || '';
                    const isEmpty = rawContent.length === 0;
                    
                    // Solo eliminar el bloque si está completamente vacío (ni espacios ni nada)
                    if (isEmpty) {
                        const noteContent = document.getElementById('noteContent');
                        const blocks = noteContent.querySelectorAll('.content-block');
                        
                        // No eliminar si solo hay un bloque
                        if (blocks.length > 1) {
                            pushUndoState({ persist: false });
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            
                            const currentIndex = getBlockIndex(block);
                            const nextBlock = block.nextElementSibling;
                            const prevBlock = block.previousElementSibling;
                            
                            // Eliminar el bloque completo del DOM
                            block.remove();
                            
                            // Eliminar de noteData.blocks
                            if (noteData.blocks && noteData.blocks.length > currentIndex) {
                                noteData.blocks.splice(currentIndex, 1);
                            }
                            
                            // Actualizar índices de todos los bloques
                            const remainingBlocks = noteContent.querySelectorAll('.content-block');
                            remainingBlocks.forEach((b, idx) => {
                                b.dataset.blockIndex = idx;
                            });
                            
                            // Reconfigurar handles
                            setupBlockHandles();
                            
                            // Mover foco al bloque siguiente o anterior; cursor siempre al final del texto
                            setTimeout(() => {
                                const targetBlock = nextBlock || prevBlock;
                                if (targetBlock) {
                                    const targetContent = targetBlock.querySelector('.block-content');
                                    if (targetContent) {
                                        targetContent.focus();
                                        const range = document.createRange();
                                        const sel = window.getSelection();
                                        range.selectNodeContents(targetContent);
                                        range.collapse(false); // Al final del bloque
                                        sel.removeAllRanges();
                                        sel.addRange(range);
                                    }
                                }
                            }, 10);
                            
                            saveNote();
                            return false;
                        }
                    }
                }
                
                // Manejar Enter en el bloque - usar capture para interceptar antes
                if (e.key === 'Enter') {
                    const isListBlock = hasListFormat(contentDiv);
                    
                    // Caso 1: Enter sin Shift en bloque con lista
                    if (!e.shiftKey && isListBlock) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        // keydown puede ir antes que beforeinput; capturar estado antes de dividir bloque
                        pushUndoState({ persist: false });
                        
                        // Limpiar cualquier contenido que el navegador haya intentado insertar
                        const selection = window.getSelection();
                        if (selection.rangeCount > 0) {
                            const range = selection.getRangeAt(0);
                            const container = range.commonAncestorContainer;
                            if (container.nodeType === Node.TEXT_NODE) {
                                const parent = container.parentElement;
                                if (parent && (parent.tagName === 'BR' || parent.tagName === 'P')) {
                                    parent.remove();
                                }
                            }
                        }
                        
                        // Guardar contenido del bloque actual
                        saveBlockContent(block);
                        
                        // Obtener el índice del bloque actual para insertar el nuevo después
                        const currentIndex = getBlockIndex(block);
                        const noteContent = document.getElementById('noteContent');
                        
                        // Crear nuevo bloque
                        const newBlock = createBlockElement('', null);
                        
                        // Insertar el nuevo bloque después del actual
                        const nextSibling = block.nextSibling;
                        if (nextSibling) {
                            noteContent.insertBefore(newBlock, nextSibling);
                        } else {
                            noteContent.appendChild(newBlock);
                        }
                        
                        // Agregar bloque vacío a noteData.blocks en la posición correcta
                        if (!noteData.blocks) {
                            noteData.blocks = [];
                        }
                        const blockIndex = currentIndex + 1;
                        noteData.blocks.splice(blockIndex, 0, {
                            content: '',
                            status: '',
                            priority: '',
                            assignedPerson: null,
                            tag: null,
                            blockUpdatedAt: new Date().toISOString(),
                            createdAt: new Date().toISOString()
                        });
                        
                        // Actualizar índices de todos los bloques
                        const blocks = noteContent.querySelectorAll('.content-block');
                        blocks.forEach((b, idx) => {
                            b.dataset.blockIndex = idx;
                        });
                        
                        newBlock.dataset.blockIndex = blockIndex;
                        
                        setupBlockHandles();
                        
                        // Enfocar el nuevo bloque y aplicar formato de lista
                        setTimeout(() => {
                            const newContentDiv = newBlock.querySelector('.block-content');
                            if (newContentDiv) {
                                newContentDiv.focus();
                                
                                // Aplicar formato de lista al nuevo bloque
                                document.execCommand('insertUnorderedList', false, null);
                                
                                // Actualizar estado del toolbar
                                updateToolbarState();
                                
                                // Mover cursor al inicio del nuevo bloque (después de aplicar la lista)
                                setTimeout(() => {
                                    const range = document.createRange();
                                    const sel = window.getSelection();
                                    // Intentar encontrar el primer elemento de texto o el <li>
                                    const firstLi = newContentDiv.querySelector('li');
                                    if (firstLi) {
                                        range.setStart(firstLi, 0);
                                        range.collapse(true);
                                    } else {
                                        range.setStart(newContentDiv, 0);
                                        range.collapse(true);
                                    }
                                    sel.removeAllRanges();
                                    sel.addRange(range);
                                }, 10);
                            }
                        }, 10);
                        
                        return false;
                    }
                    // Caso 2: Shift+Enter - insertar salto de línea (comportamiento normal)
                    else if (e.shiftKey) {
                        // Permitir que el navegador maneje Shift+Enter normalmente para insertar <br>
                        // Pero asegurarnos de que funcione incluso al final de la línea
                        const selection = window.getSelection();
                        if (selection.rangeCount > 0) {
                            const range = selection.getRangeAt(0);
                            
                            // Si el cursor está al final del contenido, insertar <br> manualmente
                            const contentText = contentDiv.textContent || '';
                            const isAtEnd = range.startOffset >= contentText.length && range.collapsed;
                            
                            if (isAtEnd) {
                                pushUndoState({ persist: false });
                                e.preventDefault();
                                e.stopPropagation();
                                
                                // Insertar <br> al final
                                const br = document.createElement('br');
                                
                                // Encontrar el último nodo del contenido
                                let lastNode = contentDiv.lastChild;
                                if (!lastNode || (lastNode.nodeType === Node.TEXT_NODE && lastNode.textContent === '')) {
                                    contentDiv.appendChild(br);
                                } else {
                                    contentDiv.appendChild(br);
                                }
                                
                                // Mover cursor después del <br>
                                setTimeout(() => {
                                    const newRange = document.createRange();
                                    const newSel = window.getSelection();
                                    newRange.setStartAfter(br);
                                    newRange.collapse(true);
                                    newSel.removeAllRanges();
                                    newSel.addRange(newRange);
                                }, 0);
                                
                                return false;
                            }
                            // Si no está al final, dejar que el navegador maneje normalmente
                        }
                        // No prevenir el comportamiento por defecto para Shift+Enter en otros casos
                    }
                    // Caso 3: Enter sin Shift en bloque sin lista - comportamiento normal
                    else if (!e.shiftKey && !isListBlock) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        pushUndoState({ persist: false });
                        
                        // Limpiar cualquier contenido que el navegador haya intentado insertar
                        const selection = window.getSelection();
                        if (selection.rangeCount > 0) {
                            const range = selection.getRangeAt(0);
                            // Si hay un <br> o <p> que se insertó, eliminarlo
                            const container = range.commonAncestorContainer;
                            if (container.nodeType === Node.TEXT_NODE) {
                                const parent = container.parentElement;
                                if (parent && (parent.tagName === 'BR' || parent.tagName === 'P')) {
                                    parent.remove();
                                }
                            }
                        }
                        
                        // Guardar contenido del bloque actual
                        saveBlockContent(block);
                        
                        // Obtener el índice del bloque actual para insertar el nuevo después
                        const currentIndex = getBlockIndex(block);
                        const noteContent = document.getElementById('noteContent');
                        
                        // Crear nuevo bloque
                        const newBlock = createBlockElement('', null);
                        
                        // Insertar el nuevo bloque después del actual
                        const nextSibling = block.nextSibling;
                        if (nextSibling) {
                            noteContent.insertBefore(newBlock, nextSibling);
                        } else {
                            noteContent.appendChild(newBlock);
                        }
                        
                        // Agregar bloque vacío a noteData.blocks en la posición correcta
                        if (!noteData.blocks) {
                            noteData.blocks = [];
                        }
                        const blockIndex = currentIndex + 1;
                        noteData.blocks.splice(blockIndex, 0, {
                            content: '',
                            status: '',
                            priority: '',
                            assignedPerson: null,
                            tag: null,
                            blockUpdatedAt: new Date().toISOString(),
                            createdAt: new Date().toISOString()
                        });
                        
                        // Actualizar índices de todos los bloques
                        const blocks = noteContent.querySelectorAll('.content-block');
                        blocks.forEach((b, idx) => {
                            b.dataset.blockIndex = idx;
                        });
                        
                        newBlock.dataset.blockIndex = blockIndex;
                        
                        setupBlockHandles();
                        
                        // Enfocar el nuevo bloque después de un pequeño delay
                        setTimeout(() => {
                            const newContentDiv = newBlock.querySelector('.block-content');
                            if (newContentDiv) {
                                newContentDiv.focus();
                                // Mover cursor al inicio del nuevo bloque
                                const range = document.createRange();
                                const sel = window.getSelection();
                                range.setStart(newContentDiv, 0);
                                range.collapse(true);
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                        }, 10);
                        
                        return false;
                    }
                    // Caso 4: Shift+Enter en bloque sin lista - comportamiento por defecto (permitir salto de línea)
                    // No hacer nada, dejar que el navegador maneje el salto de línea normalmente
                }
            }, true); // Usar capture phase para interceptar antes
        }
        
        // Click en chips para editar
        const chipsContainer = block.querySelector('.block-chips');
        if (chipsContainer) {
            chipsContainer.addEventListener('click', (e) => {
                if (e.target.classList.contains('chip')) {
                    openHandleMenu(block, handle);
                }
            });
        }
    });
}

// Abrir menú del handle
function openHandleMenu(blockElement, handle) {
    const menu = document.getElementById('handleMenu');
    if (!menu) {
        console.error('Menú handleMenu no encontrado');
        return;
    }
    
    const blockData = getBlockData(blockElement);
    
    // Actualizar valores del menú
    updateMenuValues(blockData.status || '', blockData.priority || '', blockData.assignedPerson || null, blockData.tag || null);
    
    // Cerrar resultados de búsqueda si están abiertos
    const personSearchResults = document.getElementById('personSearchResults');
    if (personSearchResults) {
        personSearchResults.classList.remove('show');
        personSearchResults.innerHTML = '';
    }
    
    // Cerrar dropdown de etiquetas si está abierto
    // Posicionar menú debajo del bloque
    const blockRect = blockElement.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.classList.add('show');
    menu.dataset.blockIndex = getBlockIndex(blockElement);
    closeAllHandleDropdowns();

    // Ajustar posición para que el menú no se salga del viewport (si no cabe abajo, mostrar arriba)
    requestAnimationFrame(() => {
        const margin = 8;
        const desiredLeft = blockRect.left;
        const desiredTop = blockRect.bottom + margin;

        menu.style.left = desiredLeft + 'px';
        menu.style.top = desiredTop + 'px';

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = menu.getBoundingClientRect();

        let left = desiredLeft;
        let top = desiredTop;

        if (rect.right > vw - margin) left = Math.max(margin, vw - rect.width - margin);
        if (left < margin) left = margin;

        if (rect.bottom > vh - margin) {
            top = blockRect.top - rect.height - margin;
        }
        if (top < margin) top = margin;

        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
    });
    
    currentBlockElement = blockElement;
    menuActiveField = 'status'; // Empezar en estado
    
    // Inicializar iconos de Lucide en el menú
    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons();
        });
    }
    
    // Enfocar el campo de estado para permitir navegación con teclado
    setTimeout(() => {
        const statusFocusTarget = document.getElementById('statusFocusTarget');
        if (statusFocusTarget) {
            statusFocusTarget.focus();
        }
    }, 10);
    
    console.log('Menú abierto para bloque:', blockElement, 'con datos:', blockData);
}

// Actualizar valores mostrados en el menú
function updateMenuValues(status, priority, assignedPerson = null, tag = null) {
    const statusValue = document.getElementById('statusValue');
    const statusChip = document.getElementById('statusChip');
    const priorityValue = document.getElementById('priorityValue');
    const priorityChip = document.getElementById('priorityChip');
    const personSearchInput = document.getElementById('personSearchInput');
    const personChip = document.getElementById('personChip');
    const tagValue = document.getElementById('tagValue');
    const tagChip = document.getElementById('tagChip');
    
    const statusLabels = {
        '': 'Sin estado',
        'pendiente': 'Pendiente',
        'en-progreso': 'En progreso',
        'hecho': 'Hecho'
    };
    
    const priorityLabels = {
        '': 'Sin prioridad',
        'p5': 'P5',
        'p4': 'P4',
        'p3': 'P3',
        'p2': 'P2',
        'p1': 'P1'
    };
    
    // Estado
    if (statusValue) {
        if (status) {
            statusValue.style.display = 'none';
        } else {
            statusValue.textContent = 'Sin estado';
            statusValue.style.display = '';
        }
    }
    if (statusChip) {
        if (status) {
            statusChip.className = 'menu-chip chip chip-status chip-' + status;
            statusChip.textContent = statusLabels[status] || status;
            statusChip.classList.remove('empty');
        } else {
            statusChip.className = 'menu-chip empty';
        }
    }
    
    // Prioridad
    if (priorityValue) {
        if (priority) {
            priorityValue.style.display = 'none';
        } else {
            priorityValue.textContent = 'Sin prioridad';
            priorityValue.style.display = '';
        }
    }
    if (priorityChip) {
        if (priority) {
            priorityChip.className = `menu-chip chip chip-priority chip-${priority}`;
            priorityChip.textContent = priorityLabels[priority] || priority;
            priorityChip.classList.remove('empty');
        } else {
            priorityChip.className = 'menu-chip empty';
        }
    }
    
    // Persona: sin asignar = "Sin asignación"; asignado = solo chip con iniciales
    const personLabel = document.getElementById('personLabel');
    const personSearchDropdown = document.getElementById('personSearchDropdown');
    if (personSearchInput) {
        personSearchInput.value = '';
        if (personSearchDropdown) personSearchDropdown.classList.remove('show');
        if (assignedPerson) {
            const displayName = getPersonDisplayName(assignedPerson);
            const initials = getInitials(assignedPerson.firstName, assignedPerson.lastName);
            if (personLabel) {
                personLabel.style.display = 'none';
            }
            if (personChip) {
                personChip.className = 'menu-chip chip chip-person';
                personChip.textContent = initials;
                personChip.title = displayName;
                personChip.classList.remove('empty');
            }
        } else {
            if (personLabel) {
                personLabel.textContent = 'Sin asignación';
                personLabel.style.display = '';
            }
            if (personChip) {
                personChip.className = 'menu-chip empty';
            }
        }
    }
    
    // Etiqueta
    if (tagValue) {
        if (tag && (tag.name || tag.id)) {
            tagValue.style.display = 'none';
            if (tagChip) {
                tagChip.className = 'menu-chip chip chip-tag';
                tagChip.textContent = getTagDisplayName(tag);
                tagChip.classList.remove('empty');
            }
        } else {
            tagValue.textContent = 'Sin etiqueta';
            tagValue.style.display = '';
            if (tagChip) {
                tagChip.className = 'menu-chip empty';
            }
        }
    }
}

// Navegar entre estados
function navigateStatus(direction) {
    if (!currentBlockElement) return;
    
    const statusOrder = ['', 'pendiente', 'en-progreso', 'hecho'];
    const blockData = getBlockData(currentBlockElement);
    const currentStatus = blockData.status || '';
    const currentIndex = statusOrder.indexOf(currentStatus);
    
    let newIndex;
    if (direction === 'next') {
        newIndex = (currentIndex + 1) % statusOrder.length;
    } else {
        newIndex = currentIndex - 1;
        if (newIndex < 0) newIndex = statusOrder.length - 1;
    }
    
    const newStatus = statusOrder[newIndex];
    const currentPriority = blockData.priority || '';
    const currentPerson = blockData.assignedPerson || null;
    const currentTag = blockData.tag || null;
    applyBlockMetadata(currentBlockElement, newStatus, currentPriority, currentPerson, currentTag);
    updateMenuValues(newStatus, currentPriority, currentPerson, currentTag);
    refreshHandleDropdownsSelection();
}

// Navegar entre prioridades
function navigatePriority(direction) {
    if (!currentBlockElement) return;
    
    const priorityOrder = ['', 'p5', 'p4', 'p3', 'p2', 'p1'];
    const blockData = getBlockData(currentBlockElement);
    const currentPriority = blockData.priority || '';
    const currentIndex = priorityOrder.indexOf(currentPriority);
    
    let newIndex;
    if (direction === 'next') {
        newIndex = (currentIndex + 1) % priorityOrder.length;
    } else {
        newIndex = currentIndex - 1;
        if (newIndex < 0) newIndex = priorityOrder.length - 1;
    }
    
    const newPriority = priorityOrder[newIndex];
    const currentStatus = blockData.status || '';
    const currentPerson = blockData.assignedPerson || null;
    const currentTag = blockData.tag || null;
    applyBlockMetadata(currentBlockElement, currentStatus, newPriority, currentPerson, currentTag);
    updateMenuValues(currentStatus, newPriority, currentPerson, currentTag);
    refreshHandleDropdownsSelection();
}

// Navegar entre etiquetas (solo etiquetas activas, no eliminadas)
function navigateTag(direction) {
    if (!currentBlockElement) return;

    const tags = getActiveTags();
    const blockData = getBlockData(currentBlockElement);
    const currentTagId = blockData.tag ? blockData.tag.id : null;

    // Crear array con null al inicio (sin etiqueta) y luego solo etiquetas activas
    const tagOrder = [null, ...tags];
    const currentIndex = tagOrder.findIndex(t => t && t.id === currentTagId || !t && !currentTagId);
    
    let newIndex;
    if (direction === 'next') {
        newIndex = (currentIndex + 1) % tagOrder.length;
    } else {
        newIndex = currentIndex - 1;
        if (newIndex < 0) newIndex = tagOrder.length - 1;
    }
    
    const newTag = tagOrder[newIndex];
    const currentStatus = blockData.status || '';
    const currentPriority = blockData.priority || '';
    const currentPerson = blockData.assignedPerson || null;
    applyBlockMetadata(currentBlockElement, currentStatus, currentPriority, currentPerson, newTag);
    updateMenuValues(currentStatus, currentPriority, currentPerson, newTag);
    refreshHandleDropdownsSelection();
}

// ——— Desplegables del menú handle (clic), mismo contenido que Kanban; teclado sigue con flechas ———

function closeHandleFieldDropdownsExceptPerson() {
    document.querySelectorAll('.handle-menu-item.active').forEach((el) => el.classList.remove('active'));
    ['statusFocusTarget', 'priorityFocusTarget', 'tagFocusTarget'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('aria-expanded', 'false');
    });
}

function closeAllHandleDropdowns() {
    clearHandleDropdownPlacementStyles();
    closeHandleFieldDropdownsExceptPerson();
    const personWrap = document.querySelector('.person-assign-wrapper');
    if (personWrap) personWrap.classList.remove('active');
    const personDd = document.getElementById('personSearchDropdown');
    if (personDd) personDd.classList.remove('show');
    const personIn = document.getElementById('personSearchInput');
    if (personIn) personIn.value = '';
    const results = document.getElementById('personSearchResults');
    if (results) {
        results.classList.remove('show');
        results.innerHTML = '';
    }
    selectedPersonIndex = -1;
    const personTrig = document.getElementById('personAssignTrigger');
    if (personTrig) personTrig.setAttribute('aria-expanded', 'false');
}

function setHandleTriggerExpanded(triggerEl, expanded) {
    if (triggerEl) triggerEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

/** Coloca el desplegable arriba del trigger si no cabe abajo en el viewport (o limita max-height). */
function adjustHandleDropdownPlacement(containerEl) {
    if (!containerEl) return;
    const dropdown = containerEl.querySelector('.handle-menu-dropdown') ||
        containerEl.querySelector('.person-search-dropdown');
    if (!dropdown) return;
    const trigger = containerEl.querySelector('.menu-value-container') || containerEl.querySelector('#personAssignTrigger');
    if (!trigger) return;

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const margin = 8;
            dropdown.classList.remove('handle-menu-dropdown--up');
            dropdown.style.maxHeight = '';

            const tr = trigger.getBoundingClientRect();
            const h = dropdown.offsetHeight;
            const spaceBelow = window.innerHeight - tr.bottom - margin;
            const spaceAbove = tr.top - margin;

            if (h <= spaceBelow) {
                return;
            }
            if (h <= spaceAbove) {
                dropdown.classList.add('handle-menu-dropdown--up');
                return;
            }
            if (spaceAbove >= spaceBelow) {
                dropdown.classList.add('handle-menu-dropdown--up');
                dropdown.style.maxHeight = `${Math.max(100, spaceAbove - 4)}px`;
            } else {
                dropdown.style.maxHeight = `${Math.max(100, spaceBelow - 4)}px`;
            }
        });
    });
}

function clearHandleDropdownPlacementStyles() {
    document.querySelectorAll('.handle-menu-dropdown, .person-search-dropdown').forEach((el) => {
        el.classList.remove('handle-menu-dropdown--up');
        el.style.maxHeight = '';
    });
}

function populateHandleStatusDropdown(currentStatus) {
    const dropdown = document.getElementById('handleStatusDropdown');
    if (!dropdown || !currentBlockElement) return;
    const statusLabels = {
        '': 'Sin estado',
        pendiente: 'Pendiente',
        'en-progreso': 'En progreso',
        hecho: 'Hecho'
    };
    const order = ['', 'pendiente', 'en-progreso', 'hecho'];
    dropdown.innerHTML = '';
    order.forEach((val) => {
        const opt = document.createElement('div');
        opt.className = 'handle-menu-option';
        opt.setAttribute('role', 'option');
        opt.setAttribute('data-status', val);
        if ((currentStatus || '') === val) opt.classList.add('selected');
        opt.textContent = statusLabels[val] || val;
        opt.addEventListener('mousedown', (e) => e.preventDefault());
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const blockData = getBlockData(currentBlockElement);
            applyBlockMetadata(
                currentBlockElement,
                val,
                blockData.priority || '',
                blockData.assignedPerson || null,
                blockData.tag || null
            );
            updateMenuValues(val, blockData.priority || '', blockData.assignedPerson || null, blockData.tag || null);
            closeAllHandleDropdowns();
        });
        dropdown.appendChild(opt);
    });
}

function populateHandlePriorityDropdown(currentPriority) {
    const dropdown = document.getElementById('handlePriorityDropdown');
    if (!dropdown || !currentBlockElement) return;
    const priorityLabels = { p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4', p5: 'P5' };
    const priorities = [
        { value: 'p1', label: 'Muy alta' },
        { value: 'p2', label: 'Alta' },
        { value: 'p3', label: 'Media' },
        { value: 'p4', label: 'Baja' },
        { value: 'p5', label: 'Muy baja' }
    ];
    dropdown.innerHTML = '';
    priorities.forEach((prio) => {
        const opt = document.createElement('div');
        opt.className = 'handle-menu-option';
        opt.setAttribute('role', 'option');
        opt.setAttribute('data-priority', prio.value);
        if (prio.value === (currentPriority || '')) opt.classList.add('selected');
        const chip = document.createElement('span');
        chip.className = `handle-menu-option-chip chip chip-priority chip-${prio.value}`;
        chip.textContent = priorityLabels[prio.value] || prio.value;
        opt.appendChild(chip);
        const lab = document.createElement('span');
        lab.textContent = prio.label;
        opt.appendChild(lab);
        opt.addEventListener('mousedown', (e) => e.preventDefault());
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const blockData = getBlockData(currentBlockElement);
            applyBlockMetadata(
                currentBlockElement,
                blockData.status || '',
                prio.value,
                blockData.assignedPerson || null,
                blockData.tag || null
            );
            updateMenuValues(blockData.status || '', prio.value, blockData.assignedPerson || null, blockData.tag || null);
            closeAllHandleDropdowns();
        });
        dropdown.appendChild(opt);
    });
    const noP = document.createElement('div');
    noP.className = 'handle-menu-option';
    noP.setAttribute('role', 'option');
    if (!currentPriority || currentPriority === '') noP.classList.add('selected');
    noP.textContent = 'Sin prioridad';
    noP.addEventListener('mousedown', (e) => e.preventDefault());
    noP.addEventListener('click', (e) => {
        e.stopPropagation();
        const blockData = getBlockData(currentBlockElement);
        applyBlockMetadata(
            currentBlockElement,
            blockData.status || '',
            '',
            blockData.assignedPerson || null,
            blockData.tag || null
        );
        updateMenuValues(blockData.status || '', '', blockData.assignedPerson || null, blockData.tag || null);
        closeAllHandleDropdowns();
    });
    dropdown.appendChild(noP);
}

function populateHandleTagDropdown(currentTagId) {
    const dropdown = document.getElementById('handleTagDropdown');
    if (!dropdown || !currentBlockElement) return;
    const tags = getActiveTags();
    dropdown.innerHTML = '';
    if (tags.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'handle-menu-option';
        empty.style.color = '#888888';
        empty.style.cursor = 'default';
        empty.textContent = 'No hay etiquetas';
        dropdown.appendChild(empty);
        return;
    }
    tags.forEach((tag) => {
        const opt = document.createElement('div');
        opt.className = 'handle-menu-option';
        opt.setAttribute('role', 'option');
        if (tag.id === currentTagId) opt.classList.add('selected');
        opt.textContent = getTagDisplayName(tag);
        opt.addEventListener('mousedown', (e) => e.preventDefault());
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const blockData = getBlockData(currentBlockElement);
            applyBlockMetadata(
                currentBlockElement,
                blockData.status || '',
                blockData.priority || '',
                blockData.assignedPerson || null,
                tag
            );
            updateMenuValues(blockData.status || '', blockData.priority || '', blockData.assignedPerson || null, tag);
            closeAllHandleDropdowns();
        });
        dropdown.appendChild(opt);
    });
    const noTag = document.createElement('div');
    noTag.className = 'handle-menu-option';
    if (!currentTagId) noTag.classList.add('selected');
    noTag.textContent = 'Sin etiqueta';
    noTag.addEventListener('mousedown', (e) => e.preventDefault());
    noTag.addEventListener('click', (e) => {
        e.stopPropagation();
        const blockData = getBlockData(currentBlockElement);
        applyBlockMetadata(
            currentBlockElement,
            blockData.status || '',
            blockData.priority || '',
            blockData.assignedPerson || null,
            null
        );
        updateMenuValues(blockData.status || '', blockData.priority || '', blockData.assignedPerson || null, null);
        closeAllHandleDropdowns();
    });
    dropdown.appendChild(noTag);
}

function refreshHandleDropdownsSelection() {
    if (!currentBlockElement) return;
    const bd = getBlockData(currentBlockElement);
    const statusItem = document.querySelector('.handle-menu-item-status');
    const priorityItem = document.querySelector('.handle-menu-item-priority');
    const tagItem = document.querySelector('.handle-menu-item-tag');
    if (statusItem && statusItem.classList.contains('active')) {
        populateHandleStatusDropdown(bd.status || '');
        requestAnimationFrame(() => adjustHandleDropdownPlacement(statusItem));
    }
    if (priorityItem && priorityItem.classList.contains('active')) {
        populateHandlePriorityDropdown(bd.priority || '');
        requestAnimationFrame(() => adjustHandleDropdownPlacement(priorityItem));
    }
    if (tagItem && tagItem.classList.contains('active')) {
        populateHandleTagDropdown(bd.tag ? bd.tag.id : null);
        requestAnimationFrame(() => adjustHandleDropdownPlacement(tagItem));
    }
}

function setupHandleMenuDropdownTriggers() {
    const statusItem = document.querySelector('.handle-menu-item-status');
    const priorityItem = document.querySelector('.handle-menu-item-priority');
    const tagItem = document.querySelector('.handle-menu-item-tag');
    const statusEl = document.getElementById('statusFocusTarget');
    const priorityEl = document.getElementById('priorityFocusTarget');
    const tagEl = document.getElementById('tagFocusTarget');

    if (statusEl && statusItem) {
        statusEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!document.getElementById('handleMenu').classList.contains('show')) return;
            const was = statusItem.classList.contains('active');
            closeAllHandleDropdowns();
            if (!was) {
                const bd = getBlockData(currentBlockElement);
                populateHandleStatusDropdown(bd.status || '');
                statusItem.classList.add('active');
                setHandleTriggerExpanded(statusEl, true);
                adjustHandleDropdownPlacement(statusItem);
            }
        });
    }
    if (priorityEl && priorityItem) {
        priorityEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!document.getElementById('handleMenu').classList.contains('show')) return;
            const was = priorityItem.classList.contains('active');
            closeAllHandleDropdowns();
            if (!was) {
                const bd = getBlockData(currentBlockElement);
                populateHandlePriorityDropdown(bd.priority || '');
                priorityItem.classList.add('active');
                setHandleTriggerExpanded(priorityEl, true);
                adjustHandleDropdownPlacement(priorityItem);
            }
        });
    }
    if (tagEl && tagItem) {
        tagEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!document.getElementById('handleMenu').classList.contains('show')) return;
            const was = tagItem.classList.contains('active');
            closeAllHandleDropdowns();
            if (!was) {
                const bd = getBlockData(currentBlockElement);
                populateHandleTagDropdown(bd.tag ? bd.tag.id : null);
                tagItem.classList.add('active');
                setHandleTriggerExpanded(tagEl, true);
                adjustHandleDropdownPlacement(tagItem);
            }
        });
    }

    // Al moverse con Tab entre campos, cerrar desplegables del resto (sigue el teclado como antes)
    const personTrig = document.getElementById('personAssignTrigger');
    if (statusEl && statusItem) {
        statusEl.addEventListener('focus', () => {
            priorityItem?.classList.remove('active');
            tagItem?.classList.remove('active');
            setHandleTriggerExpanded(priorityEl, false);
            setHandleTriggerExpanded(tagEl, false);
            closePersonDropdown();
        });
    }
    if (priorityEl && priorityItem) {
        priorityEl.addEventListener('focus', () => {
            statusItem?.classList.remove('active');
            tagItem?.classList.remove('active');
            setHandleTriggerExpanded(statusEl, false);
            setHandleTriggerExpanded(tagEl, false);
            closePersonDropdown();
        });
    }
    if (personTrig) {
        personTrig.addEventListener('focus', () => {
            statusItem?.classList.remove('active');
            priorityItem?.classList.remove('active');
            tagItem?.classList.remove('active');
            setHandleTriggerExpanded(statusEl, false);
            setHandleTriggerExpanded(priorityEl, false);
            setHandleTriggerExpanded(tagEl, false);
        });
    }
    if (tagEl && tagItem) {
        tagEl.addEventListener('focus', () => {
            statusItem?.classList.remove('active');
            priorityItem?.classList.remove('active');
            setHandleTriggerExpanded(statusEl, false);
            setHandleTriggerExpanded(priorityEl, false);
            closePersonDropdown();
        });
    }
}

// Cerrar menú del handle
function closeHandleMenu() {
    closeAllHandleDropdowns();
    const menu = document.getElementById('handleMenu');
    if (menu) {
        menu.classList.remove('show');
    }
    
    // Cerrar resultados de búsqueda y resetear índice
    const resultsContainer = document.getElementById('personSearchResults');
    if (resultsContainer) {
        resultsContainer.classList.remove('show');
        resultsContainer.innerHTML = '';
    }
    selectedPersonIndex = -1;
    
    // Cerrar resultados de búsqueda de personas si están abiertos
    const personSearchResults = document.getElementById('personSearchResults');
    if (personSearchResults) {
        personSearchResults.classList.remove('show');
        personSearchResults.innerHTML = '';
    }
    
    // Enfocar el siguiente bloque después de cerrar el menú
    if (currentBlockElement) {
        const noteContent = document.getElementById('noteContent');
        const blocks = Array.from(noteContent.querySelectorAll('.content-block'));
        const currentIndex = blocks.indexOf(currentBlockElement);
        
        let nextBlock = null;
        
        // Buscar el siguiente bloque
        if (currentIndex !== -1 && currentIndex < blocks.length - 1) {
            nextBlock = blocks[currentIndex + 1];
        } else {
            // Si no hay siguiente bloque, crear uno nuevo
            const currentIndexNum = getBlockIndex(currentBlockElement);
            const newBlock = createBlockElement('', null);
            
            // Insertar después del bloque actual
            const nextSibling = currentBlockElement.nextSibling;
            if (nextSibling) {
                noteContent.insertBefore(newBlock, nextSibling);
            } else {
                noteContent.appendChild(newBlock);
            }
            
            // Agregar bloque vacío a noteData.blocks
            if (!noteData.blocks) {
                noteData.blocks = [];
            }
            const blockIndex = currentIndexNum + 1;
            noteData.blocks.splice(blockIndex, 0, {
                content: '',
                status: '',
                priority: '',
                assignedPerson: null,
                tag: null,
                blockUpdatedAt: new Date().toISOString(),
                createdAt: new Date().toISOString()
            });
            
            // Actualizar índices de todos los bloques
            const allBlocks = noteContent.querySelectorAll('.content-block');
            allBlocks.forEach((b, idx) => {
                b.dataset.blockIndex = idx;
            });
            
            setupBlockHandles();
            saveNote();
            nextBlock = newBlock;
        }
        
        // Enfocar el siguiente bloque
        if (nextBlock) {
            setTimeout(() => {
                const nextContent = nextBlock.querySelector('.block-content');
                if (nextContent) {
                    nextContent.focus();
                    // Mover cursor al inicio del bloque
                    const range = document.createRange();
                    const sel = window.getSelection();
                    range.setStart(nextContent, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }, 50);
        }
    }
    
    currentBlockElement = null;
    menuActiveField = 'status'; // Resetear al cerrar
}

// Cargar personas desde localStorage (incluye eliminadas)
function loadPersons() {
    const savedPersons = localStorage.getItem('persons');
    const list = savedPersons ? JSON.parse(savedPersons) : [];
    list.forEach(p => { if (p.deleted === undefined) p.deleted = false; });
    return list;
}

// Solo personas activas (para asignar a bloques)
function getActivePersons() {
    return loadPersons().filter(p => !p.deleted);
}

// Nombre a mostrar para una persona (con "(Eliminado)" si está soft-deleted)
function getPersonDisplayName(person) {
    if (!person || !person.id) return '';
    const all = loadPersons();
    const full = all.find(p => p.id === person.id);
    if (!full) {
        const name = person.lastName ? `${person.firstName} ${person.lastName}` : (person.firstName || '');
        return name;
    }
    const name = full.lastName ? `${full.firstName} ${full.lastName}` : (full.firstName || '');
    return full.deleted ? name + ' (Eliminado)' : name;
}

// Generar iniciales de una persona
function getInitials(firstName, lastName) {
    const first = firstName ? firstName.charAt(0).toUpperCase() : '';
    const last = lastName ? lastName.charAt(0).toUpperCase() : '';
    return first + last;
}

// Buscar personas (solo activas, para asignar)
function searchPersons(query) {
    const persons = getActivePersons();
    if (!query || query.trim() === '') {
        return persons;
    }
    const lowerQuery = query.toLowerCase().trim();
    return persons.filter(person => {
        const firstName = (person.firstName || '').toLowerCase();
        const lastName = (person.lastName || '').toLowerCase();
        const fullName = `${firstName} ${lastName}`.trim();
        return firstName.includes(lowerQuery) || 
               lastName.includes(lowerQuery) || 
               fullName.includes(lowerQuery);
    });
}

// Mostrar resultados de búsqueda de personas (primera opción = "Sin asignación", luego personas, luego crear)
function showPersonSearchResults(query) {
    const results = searchPersons(query || '');
    const resultsContainer = document.getElementById('personSearchResults');
    if (!resultsContainer) return;
    
    // Primera opción: Sin asignación
    const noAssignmentHTML = `
        <div class="person-search-result-item person-search-result-clear" 
             data-clear-assignment="true"
             data-index="0"
             tabindex="0"
             role="option"
             data-selected="true">
            <div class="person-search-result-avatar person-search-result-avatar-empty">—</div>
            <span>Sin asignación</span>
        </div>
    `;
    
    const resultsHTML = results.map((person, index) => {
        const initials = getInitials(person.firstName, person.lastName);
        const fullName = person.lastName 
            ? `${person.firstName} ${person.lastName}` 
            : person.firstName;
        return `
            <div class="person-search-result-item" 
                 data-person-id="${person.id}" 
                 data-index="${index + 1}"
                 tabindex="0"
                 role="option">
                <div class="person-search-result-avatar">${initials}</div>
                <span>${fullName}</span>
            </div>
        `;
    }).join('');
    
    const createPersonHTML = `
        <div class="person-search-result-item person-search-result-create" 
             data-index="${results.length + 1}"
             tabindex="0"
             role="option">
            <i data-lucide="plus-circle" style="width: 16px; height: 16px; color: #86d135;"></i>
            <span style="color: #86d135;">Crear nueva persona</span>
        </div>
    `;
    
    resultsContainer.innerHTML = noAssignmentHTML + resultsHTML + createPersonHTML;
    resultsContainer.classList.add('show');
    selectedPersonIndex = 0;
    updateSelectedPersonResult();
    
    // Inicializar iconos de Lucide
    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons({ container: resultsContainer });
        });
    }
    
    // Agregar event listeners
    resultsContainer.querySelectorAll('.person-search-result-item').forEach((item, index) => {
        const isCreateOption = item.classList.contains('person-search-result-create');
        const isClearOption = item.getAttribute('data-clear-assignment') === 'true';
        
        item.addEventListener('click', () => {
            if (isCreateOption) {
                openSettingsForPerson();
            } else if (isClearOption) {
                if (currentBlockElement) {
                    removePersonFromBlock(currentBlockElement);
                }
                closePersonDropdown();
            } else {
                selectPersonFromResult(item);
            }
        });
        
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (isCreateOption) {
                    openSettingsForPerson();
                } else if (isClearOption) {
                    if (currentBlockElement) {
                        removePersonFromBlock(currentBlockElement);
                    }
                    closePersonDropdown();
                } else {
                    selectPersonFromResult(item);
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const items = resultsContainer.querySelectorAll('.person-search-result-item');
                if (index === items.length - 1) {
                    selectedPersonIndex = -1;
                    updateSelectedPersonResult();
                    personSearchInput.focus();
                } else {
                    navigatePersonResults(1);
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (index === 0) {
                    selectedPersonIndex = -1;
                    updateSelectedPersonResult();
                    personSearchInput.focus();
                } else {
                    navigatePersonResults(-1);
                }
            } else if (e.key === 'Tab' && !e.shiftKey) {
                // Tab desde un resultado: ir al siguiente resultado o volver al input
                e.preventDefault();
                const items = resultsContainer.querySelectorAll('.person-search-result-item');
                if (index < items.length - 1) {
                    // Ir al siguiente resultado
                    navigatePersonResults(1);
                } else {
                    // Volver al input
                    personSearchInput.focus();
                }
            } else if (e.key === 'Tab' && e.shiftKey) {
                // Shift+Tab desde un resultado: ir al resultado anterior o volver al input
                e.preventDefault();
                if (index > 0) {
                    navigatePersonResults(-1);
                } else {
                    // Volver al input
                    personSearchInput.focus();
                }
            }
        });
        
        item.addEventListener('focus', () => {
            selectedPersonIndex = index;
            updateSelectedPersonResult();
        });
    });
}

// Navegar entre resultados de personas
function navigatePersonResults(direction) {
    const resultsContainer = document.getElementById('personSearchResults');
    if (!resultsContainer || !resultsContainer.classList.contains('show')) return;
    
    const items = resultsContainer.querySelectorAll('.person-search-result-item');
    if (items.length === 0) return;
    
    // Si direction es 0, ir al primer resultado
    if (direction === 0) {
        selectedPersonIndex = 0;
    } else {
        selectedPersonIndex += direction;
        
        if (selectedPersonIndex < 0) {
            selectedPersonIndex = items.length - 1;
        } else if (selectedPersonIndex >= items.length) {
            selectedPersonIndex = 0;
        }
    }
    
    updateSelectedPersonResult();
    items[selectedPersonIndex].focus();
}

// Actualizar el resultado seleccionado visualmente
function updateSelectedPersonResult() {
    const resultsContainer = document.getElementById('personSearchResults');
    if (!resultsContainer) return;
    
    const items = resultsContainer.querySelectorAll('.person-search-result-item');
    items.forEach((item, index) => {
        if (index === selectedPersonIndex) {
            item.setAttribute('data-selected', 'true');
            // Si es la opción de crear, usar color verde
            if (item.classList.contains('person-search-result-create')) {
                item.style.backgroundColor = 'rgba(134, 209, 53, 0.1)';
            } else {
                item.style.backgroundColor = '#3E3E3E';
            }
        } else {
            item.removeAttribute('data-selected');
            item.style.backgroundColor = '';
        }
    });
}

// Seleccionar persona desde un resultado
function selectPersonFromResult(item) {
    const personId = item.dataset.personId;
    const persons = loadPersons();
    const person = persons.find(p => p.id === personId);
    if (person && currentBlockElement) {
        assignPersonToBlock(currentBlockElement, person);
        closePersonDropdown();
    }
}

// Abrir configuración para crear nueva persona
function openSettingsForPerson() {
    // Cerrar resultados de búsqueda
    const resultsContainer = document.getElementById('personSearchResults');
    if (resultsContainer) {
        resultsContainer.classList.remove('show');
        resultsContainer.innerHTML = '';
    }
    selectedPersonIndex = -1;
    
    // Enviar mensaje IPC para abrir configuración
    ipcRenderer.send('open-settings');
    
    // Opcional: Cerrar el menú del handle también
    closeHandleMenu();
}

// Asignar persona a un bloque
function assignPersonToBlock(blockElement, person) {
    if (!blockElement || !person) return;
    
    const blockData = getBlockData(blockElement);
    const currentStatus = blockData.status || '';
    const currentPriority = blockData.priority || '';
    const currentTag = blockData.tag || null;
    
    applyBlockMetadata(blockElement, currentStatus, currentPriority, person, currentTag);
    updateMenuValues(currentStatus, currentPriority, person, currentTag);
    
    // Cerrar resultados de búsqueda
    const personSearchResults = document.getElementById('personSearchResults');
    if (personSearchResults) {
        personSearchResults.classList.remove('show');
        personSearchResults.innerHTML = '';
    }
    
    // Mantener el foco en el input pero mostrar el nombre completo
    const personSearchInput = document.getElementById('personSearchInput');
    if (personSearchInput) {
        const fullName = person.lastName 
            ? `${person.firstName} ${person.lastName}` 
            : person.firstName;
        personSearchInput.value = fullName;
        // Después de un momento, seleccionar el texto para que el usuario pueda escribir si quiere cambiar
        setTimeout(() => {
            personSearchInput.select();
        }, 50);
    }
}

// Quitar asignación de persona
function removePersonFromBlock(blockElement) {
    if (!blockElement) return;
    
    const blockData = getBlockData(blockElement);
    const currentStatus = blockData.status || '';
    const currentPriority = blockData.priority || '';
    const currentTag = blockData.tag || null;
    
    applyBlockMetadata(blockElement, currentStatus, currentPriority, null, currentTag);
    updateMenuValues(currentStatus, currentPriority, null, currentTag);
}

// Asignar etiqueta a un bloque
function assignTagToBlock(blockElement, tag) {
    if (!blockElement || !tag) return;
    
    const blockData = getBlockData(blockElement);
    const currentStatus = blockData.status || '';
    const currentPriority = blockData.priority || '';
    const currentPerson = blockData.assignedPerson || null;
    
    applyBlockMetadata(blockElement, currentStatus, currentPriority, currentPerson, tag);
    updateMenuValues(currentStatus, currentPriority, currentPerson, tag);
}

// Quitar etiqueta de un bloque
function removeTagFromBlock(blockElement) {
    if (!blockElement) return;
    
    const blockData = getBlockData(blockElement);
    const currentStatus = blockData.status || '';
    const currentPriority = blockData.priority || '';
    const currentPerson = blockData.assignedPerson || null;
    
    applyBlockMetadata(blockElement, currentStatus, currentPriority, currentPerson, null);
    updateMenuValues(currentStatus, currentPriority, currentPerson, null);
}

// Aplicar metadatos al bloque
function applyBlockMetadata(blockElement, status, priority, assignedPerson = null, tag = null) {
    // Guardar estado previo para poder deshacer (Ctrl+Z) cambios de parámetros
    pushUndoState();
    const blockData = getBlockData(blockElement);
    const oldStatus = blockData.status || '';
    const oldPriority = blockData.priority || '';
    const oldPersonId = blockData.assignedPerson ? blockData.assignedPerson.id : null;
    const oldTagId = blockData.tag ? blockData.tag.id : null;
    
    blockData.status = status || '';
    blockData.priority = priority || '';
    blockData.assignedPerson = assignedPerson || null;
    blockData.tag = tag || null;
    
    // Actualizar blockUpdatedAt si algún parámetro cambió
    const statusChanged = oldStatus !== (status || '');
    const priorityChanged = oldPriority !== (priority || '');
    const personChanged = oldPersonId !== (assignedPerson ? assignedPerson.id : null);
    const tagChanged = oldTagId !== (tag ? tag.id : null);
    
    if (statusChanged || priorityChanged || personChanged || tagChanged) {
        blockData.blockUpdatedAt = new Date().toISOString();
    }
    
    blockElement.dataset.status = status || '';
    blockElement.dataset.priority = priority || '';
    if (assignedPerson) {
        blockElement.dataset.assignedPersonId = assignedPerson.id;
    } else {
        delete blockElement.dataset.assignedPersonId;
    }
    if (tag) {
        blockElement.dataset.tagId = tag.id;
    } else {
        delete blockElement.dataset.tagId;
    }
    
    updateBlockChips(blockElement, blockData);
    saveBlockContent(blockElement);
    saveNote();
}

// Verificar si la nota tiene contenido o título
function hasNoteContent() {
    const title = (document.getElementById('noteTitle').value || '').trim();
    if (title) {
        return true;
    }
    
    // Verificar si hay bloques con contenido
    const blocks = document.querySelectorAll('.content-block');
    for (let block of blocks) {
        const contentDiv = block.querySelector('.block-content');
        if (contentDiv) {
            const text = contentDiv.textContent || contentDiv.innerText || '';
            if (text.trim()) {
                return true;
            }
        }
    }
    
    return false;
}

// Guardar nota
function saveNote() {
    // Guardar contenido de todos los bloques
    const blocks = document.querySelectorAll('.content-block');
    blocks.forEach(block => {
        saveBlockContent(block);
    });
    
    noteData.title = document.getElementById('noteTitle').value;
    const currentSignature = buildPersistedSignature(noteData);
    if (currentSignature === lastPersistedSignature) {
        return;
    }
    const prevUpdatedAt = noteData.updatedAt;
    noteData.updatedAt = new Date().toISOString();
    
    if (!noteData.createdAt) {
        noteData.createdAt = new Date().toISOString();
    }

    // Verificar si la nota tiene contenido o título
    if (!hasNoteContent()) {
        // Si la nota está vacía, eliminarla del localStorage si existe
        const savedNotes = localStorage.getItem('notes');
        let notes = savedNotes ? JSON.parse(savedNotes) : [];
        const index = notes.findIndex(n => n.id === noteId);
        
        if (index !== -1) {
            // Eliminar la nota vacía
            notes.splice(index, 1);
            localStorage.setItem('notes', JSON.stringify(notes));
            
            // Notificar a la ventana principal que se eliminó
            ipcRenderer.send('note-deleted', noteId);
        }
        // Si no existe, simplemente no guardar nada
        return;
    }

    // Guardar en localStorage solo si tiene contenido
    const savedNotes = localStorage.getItem('notes');
    let notes = savedNotes ? JSON.parse(savedNotes) : [];
    
    const index = notes.findIndex(n => n.id === noteId);
    if (index !== -1) {
        // Mantener el resumen y contentHash si el contenido no cambió
        const oldNote = notes[index];
        const oldContentHash = oldNote.contentHash;
        
        // Calcular nuevo hash del contenido
        const newContent = JSON.stringify(noteData.blocks || noteData.content || '');
        const newContentHash = newContent.substring(0, 100);
        
        // Si el contenido cambió, eliminar resumen para que se regenere
        if (oldContentHash !== newContentHash) {
            delete noteData.summary;
            delete noteData.contentHash;
        } else {
            // Mantener el resumen existente
            noteData.summary = oldNote.summary;
            noteData.contentHash = oldNote.contentHash;
        }
        
        notes[index] = { ...noteData };
    } else {
        notes.push({ ...noteData });
    }
    
    localStorage.setItem('notes', JSON.stringify(notes));
    lastPersistedSignature = currentSignature;
    
    // Notificar a la ventana principal
    ipcRenderer.send('note-updated', noteData);
}

// Funciones de formato de texto
function formatText(command, value = null) {
    document.execCommand(command, false, value);
    updateToolbarState();
}

function updateToolbarState() {
    document.getElementById('boldBtn').classList.toggle('active', document.queryCommandState('bold'));
    document.getElementById('italicBtn').classList.toggle('active', document.queryCommandState('italic'));
    document.getElementById('underlineBtn').classList.toggle('active', document.queryCommandState('underline'));
    document.getElementById('strikethroughBtn').classList.toggle('active', document.queryCommandState('strikethrough'));
    
    // Verificar si el formato de lista está activo
    const bulletBtn = document.getElementById('bulletBtn');
    if (bulletBtn) {
        try {
            const isListActive = document.queryCommandState('insertUnorderedList');
            bulletBtn.classList.toggle('active', isListActive);
        } catch (e) {
            // Si hay error, verificar manualmente si hay elementos de lista
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const container = range.commonAncestorContainer;
                const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
                if (element) {
                    const hasList = element.closest('ul, li') !== null || 
                                   element.querySelector('ul, li') !== null;
                    bulletBtn.classList.toggle('active', hasList);
                }
            }
        }
    }
}

// Crear nuevo bloque
function createNewBlock() {
    const noteContent = document.getElementById('noteContent');
    
    // Asegurar que noteData.blocks existe
    if (!noteData.blocks) {
        noteData.blocks = [];
    }
    
    const newBlock = createBlockElement('', null);
    noteContent.appendChild(newBlock);
    
    // Agregar bloque vacío a noteData.blocks
    const blockIndex = noteData.blocks.length;
    noteData.blocks.push({
        content: '',
        status: '',
        priority: '',
        assignedPerson: null,
        tag: null
    });
    
    newBlock.dataset.blockIndex = blockIndex;
    
    setupBlockHandles();
    
    // Enfocar el nuevo bloque
    setTimeout(() => {
        const contentDiv = newBlock.querySelector('.block-content');
        if (contentDiv) {
            contentDiv.focus();
        }
    }, 10);
    
    return newBlock;
}

// Mostrar diálogo de Enter
function showEnterDialog(blockElement) {
    const dialog = document.getElementById('enterDialog');
    if (!dialog) {
        console.error('Diálogo enterDialog no encontrado');
        return;
    }
    
    dialog.classList.add('show');
    enterDialogShown = true;
    pendingEnterBlock = blockElement;
    
    // Resetear valores
    const enterStatusSelect = document.getElementById('enterStatusSelect');
    const enterPrioritySelect = document.getElementById('enterPrioritySelect');
    
    if (enterStatusSelect) enterStatusSelect.value = '';
    if (enterPrioritySelect) enterPrioritySelect.value = '';
    
    console.log('Diálogo de Enter mostrado para bloque:', blockElement);
}

// Ocultar diálogo de Enter
function hideEnterDialog() {
    const dialog = document.getElementById('enterDialog');
    dialog.classList.remove('show');
    enterDialogShown = false;
    pendingEnterBlock = null;
}

// Event Listeners
// Botón de nueva nota en el header
document.getElementById('newNoteBtn').addEventListener('click', () => {
    // Crear una nueva nota
    ipcRenderer.send('create-note');
});

const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
if (undoBtn) {
    undoBtn.addEventListener('click', () => {
        if (undoStack.length > 0) popUndoState();
    });
}
if (redoBtn) {
    redoBtn.addEventListener('click', () => {
        if (redoStack.length > 0) popRedoState();
    });
}

document.getElementById('closeBtn').addEventListener('click', () => {
    saveNote();
    ipcRenderer.send('close-note', noteId);
});

// Botón de opciones (por ahora sin funcionalidad)
// Menú de opciones de la nota
let noteOptionsMenuOpen = false;

function openNoteOptionsMenu() {
    const menu = document.getElementById('noteOptionsMenu');
    const optionsBtn = document.getElementById('optionsBtn');
    if (!menu || !optionsBtn) return;
    
    const btnRect = optionsBtn.getBoundingClientRect();
    menu.style.left = (btnRect.right - 160) + 'px';
    menu.style.top = (btnRect.bottom + 4) + 'px';
    menu.style.position = 'fixed';
    menu.classList.add('show');
    noteOptionsMenuOpen = true;
    
    // Inicializar iconos de Lucide en el menú
    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons({ container: menu });
        });
    }
}

function closeNoteOptionsMenu() {
    const menu = document.getElementById('noteOptionsMenu');
    if (menu) {
        menu.classList.remove('show');
        noteOptionsMenuOpen = false;
    }
}

const optionsBtn = document.getElementById('optionsBtn');
if (optionsBtn) {
    optionsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (noteOptionsMenuOpen) {
            closeNoteOptionsMenu();
        } else {
            openNoteOptionsMenu();
        }
    });
}

// Ir a lista de notas
document.getElementById('notesListBtn').addEventListener('click', () => {
    closeNoteOptionsMenu();
    // Enviar mensaje para enfocar la ventana principal
    ipcRenderer.send('focus-main-window');
});

// Ir a tablero Kanban
document.getElementById('kanbanBtn').addEventListener('click', () => {
    closeNoteOptionsMenu();
    // Enviar mensaje para abrir el tablero Kanban
    ipcRenderer.send('open-kanban');
});

// Cerrar nota
document.getElementById('closeNoteBtn').addEventListener('click', async () => {
    closeNoteOptionsMenu();
    
    // Guardar la nota antes de cerrar
    saveNote();
    
    // Actualizar el estado de la nota a "closed"
    noteData.status = 'closed';
    noteData.isClosed = true;
    
    // Guardar el cambio en localStorage
    const savedNotes = localStorage.getItem('notes');
    let notes = savedNotes ? JSON.parse(savedNotes) : [];
    const index = notes.findIndex(n => n.id === noteId);
    if (index !== -1) {
        notes[index] = { ...notes[index], ...noteData };
        localStorage.setItem('notes', JSON.stringify(notes));
    }
    
    // Notificar a la ventana principal
    ipcRenderer.send('note-updated', noteData);
    
    // Cerrar la ventana
    ipcRenderer.send('close-note', noteId);
});

// Variables para el modal de eliminación
let pendingDeleteNoteId = null;

// Mostrar modal de confirmación de eliminación
function showDeleteModal(noteId) {
    pendingDeleteNoteId = noteId;
    const modal = document.getElementById('deleteModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('show');
    } else {
        console.error('Modal de eliminación no encontrado.');
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

// Flag para que beforeunload no vuelva a guardar la nota cuando se está eliminando
let isDeletingCurrentNote = false;

// Eliminar nota
async function deleteNote() {
    if (!pendingDeleteNoteId) return;
    
    isDeletingCurrentNote = true;
    const noteIdToDelete = pendingDeleteNoteId;
    
    // Eliminar de localStorage (usar != para que coincida aunque id sea string o number)
    const savedNotes = localStorage.getItem('notes');
    let notes = savedNotes ? JSON.parse(savedNotes) : [];
    notes = notes.filter(note => note.id != noteIdToDelete);
    localStorage.setItem('notes', JSON.stringify(notes));
    
    // Notificar al proceso principal para que elimine la nota
    ipcRenderer.send('delete-note', noteIdToDelete);
    
    hideDeleteModal();
    
    // Cerrar la ventana después de eliminar
    setTimeout(() => {
        window.close();
    }, 100);
}

// Eliminar nota - abrir modal
document.getElementById('deleteNoteBtn').addEventListener('click', () => {
    closeNoteOptionsMenu();
    showDeleteModal(noteId);
});

// ========== GESTIÓN DE ETIQUETAS ==========

// Obtener todas las etiquetas desde localStorage (incluye eliminadas)
function getAllTags() {
    const savedTags = localStorage.getItem('tags');
    const list = savedTags ? JSON.parse(savedTags) : [];
    list.forEach(t => { if (t.deleted === undefined) t.deleted = false; });
    return list;
}

// Etiquetas activas (no eliminadas) para asignar a bloques
function getActiveTags() {
    return getAllTags().filter(t => !t.deleted);
}

// Nombre a mostrar para una etiqueta (con "(Eliminado)" si está soft-deleted)
function getTagDisplayName(tag) {
    if (!tag || !tag.id) return '';
    const all = getAllTags();
    const full = all.find(t => t.id === tag.id);
    if (!full) return tag.name || '';
    return full.deleted ? (full.name || tag.name) + ' (Eliminado)' : (full.name || tag.name);
}


// Event listeners del modal
document.getElementById('modalCancelBtn').addEventListener('click', () => {
    hideDeleteModal();
});

document.getElementById('modalConfirmBtn').addEventListener('click', () => {
    deleteNote();
});

// Cerrar modal al hacer click fuera o con Escape
const deleteModal = document.getElementById('deleteModal');
if (deleteModal) {
    deleteModal.addEventListener('click', (e) => {
        if (e.target === deleteModal) {
            hideDeleteModal();
        }
    });
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && deleteModal.classList.contains('show')) {
            hideDeleteModal();
        }
    });
}

// Cerrar menú al hacer click fuera
document.addEventListener('click', (e) => {
    const menu = document.getElementById('noteOptionsMenu');
    const optionsBtn = document.getElementById('optionsBtn');
    if (menu && menu.classList.contains('show') && 
        !menu.contains(e.target) && 
        !optionsBtn.contains(e.target)) {
        closeNoteOptionsMenu();
    }
    
});

// Toolbar buttons
document.getElementById('boldBtn').addEventListener('click', () => formatText('bold'));
document.getElementById('italicBtn').addEventListener('click', () => formatText('italic'));
document.getElementById('underlineBtn').addEventListener('click', () => formatText('underline'));
document.getElementById('strikethroughBtn').addEventListener('click', () => formatText('strikethrough'));
document.getElementById('bulletBtn').addEventListener('click', () => {
    formatText('insertUnorderedList');
    updateToolbarState();
});

// Editor de contenido
const noteContent = document.getElementById('noteContent');
const noteTitle = document.getElementById('noteTitle');

// Actualizar toolbar cuando cambia la selección
noteContent.addEventListener('mouseup', updateToolbarState);
noteContent.addEventListener('keyup', updateToolbarState);

// Permitir selección de texto a través de múltiples bloques
// El navegador ya permite esto nativamente, solo necesitamos asegurarnos de no interferir
noteContent.addEventListener('selectstart', function(e) {
    // Permitir que la selección comience en cualquier bloque
    return true;
});

// Manejar selección que cruza múltiples bloques
noteContent.addEventListener('mouseup', function(e) {
    // Pequeño delay para asegurar que la selección se complete
    setTimeout(() => {
        const selection = window.getSelection();
        if (selection.rangeCount > 0 && !selection.isCollapsed) {
            const range = selection.getRangeAt(0);
            
            // Verificar si la selección cruza múltiples bloques
            const startBlock = range.startContainer.closest ? range.startContainer.closest('.content-block') : null;
            const endBlock = range.endContainer.closest ? range.endContainer.closest('.content-block') : null;
            
            if (startBlock && endBlock && startBlock !== endBlock) {
                // La selección cruza múltiples bloques
                // Actualizar el toolbar para reflejar el estado de la selección
                updateToolbarState();
            }
        }
    }, 10);
});

noteTitle.addEventListener('input', (e) => {
    // Limitar a 30 caracteres máximo
    if (e.target.value.length > 30) {
        e.target.value = e.target.value.substring(0, 30);
    }
    saveNote();
});

// Navegación desde el título al primer bloque con Enter o Tab
noteTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        
        // Guardar el título antes de mover el foco
        saveNote();
        
        // Obtener el primer bloque
        const noteContent = document.getElementById('noteContent');
        const firstBlock = noteContent.querySelector('.content-block');
        
        if (firstBlock) {
            const firstBlockContent = firstBlock.querySelector('.block-content');
            if (firstBlockContent) {
                // Enfocar el primer bloque
                setTimeout(() => {
                    firstBlockContent.focus();
                    // Mover cursor al inicio del bloque
                    const range = document.createRange();
                    const sel = window.getSelection();
                    range.setStart(firstBlockContent, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }, 10);
            }
        } else {
            // Si no hay bloques, crear uno nuevo
            const newBlock = createNewBlock();
            if (newBlock) {
                const newBlockContent = newBlock.querySelector('.block-content');
                if (newBlockContent) {
                    setTimeout(() => {
                        newBlockContent.focus();
                        const range = document.createRange();
                        const sel = window.getSelection();
                        range.setStart(newBlockContent, 0);
                        range.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }, 10);
                }
            }
        }
    }
});

// Menú del handle - Campos focusables (estado, prioridad, etiqueta) sin flechas; navegación con teclado
const statusFocusTarget = document.getElementById('statusFocusTarget');
const priorityFocusTarget = document.getElementById('priorityFocusTarget');
const tagFocusTarget = document.getElementById('tagFocusTarget');
function confirmHandleMenuAndClose() {
    saveNote();
    closeHandleMenu();
}
if (statusFocusTarget) {
    statusFocusTarget.addEventListener('focus', () => { menuActiveField = 'status'; });
    statusFocusTarget.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmHandleMenuAndClose(); }
    });
}
if (priorityFocusTarget) {
    priorityFocusTarget.addEventListener('focus', () => { menuActiveField = 'priority'; });
    priorityFocusTarget.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmHandleMenuAndClose(); }
    });
}
if (tagFocusTarget) {
    tagFocusTarget.addEventListener('focus', () => { menuActiveField = 'tag'; });
    tagFocusTarget.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmHandleMenuAndClose(); }
    });
}

document.getElementById('removeMetadataBtn').addEventListener('click', () => {
    if (currentBlockElement) {
        applyBlockMetadata(currentBlockElement, '', '', null, null);
        updateMenuValues('', '', null, null);
        closeHandleMenu();
    }
});

// Event listeners para asignación de personas (dropdown como Kanban)
const personSearchInput = document.getElementById('personSearchInput');
const personAssignTrigger = document.getElementById('personAssignTrigger');
const personSearchDropdown = document.getElementById('personSearchDropdown');

function openPersonDropdown() {
    closeHandleFieldDropdownsExceptPerson();
    const wrap = document.querySelector('.person-assign-wrapper');
    if (wrap) wrap.classList.add('active');
    const trig = document.getElementById('personAssignTrigger');
    setHandleTriggerExpanded(trig, true);
    if (personSearchDropdown && personSearchInput) {
        personSearchDropdown.classList.add('show');
        personSearchInput.value = '';
        setTimeout(() => personSearchInput.focus(), 50);
        showPersonSearchResults('');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => adjustHandleDropdownPlacement(wrap));
        });
    }
}

function closePersonDropdown() {
    const wrap = document.querySelector('.person-assign-wrapper');
    if (wrap) wrap.classList.remove('active');
    const trig = document.getElementById('personAssignTrigger');
    setHandleTriggerExpanded(trig, false);
    if (personSearchDropdown) {
        personSearchDropdown.classList.remove('show');
        personSearchDropdown.classList.remove('handle-menu-dropdown--up');
        personSearchDropdown.style.maxHeight = '';
    }
    const resultsContainer = document.getElementById('personSearchResults');
    if (resultsContainer) {
        resultsContainer.classList.remove('show');
        resultsContainer.innerHTML = '';
    }
    selectedPersonIndex = -1;
}

if (personAssignTrigger && personSearchInput) {
    personAssignTrigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (personSearchDropdown && personSearchDropdown.classList.contains('show')) {
            closePersonDropdown();
        } else {
            openPersonDropdown();
        }
    });
    personAssignTrigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            if (personSearchDropdown && personSearchDropdown.classList.contains('show')) {
                closePersonDropdown();
            } else {
                openPersonDropdown();
            }
        }
    });
}

setupHandleMenuDropdownTriggers();

let handleMenuResizeTimer = null;
window.addEventListener('resize', () => {
    const menu = document.getElementById('handleMenu');
    if (!menu || !menu.classList.contains('show')) return;
    clearTimeout(handleMenuResizeTimer);
    handleMenuResizeTimer = setTimeout(() => {
        const s = document.querySelector('.handle-menu-item-status.active');
        const p = document.querySelector('.handle-menu-item-priority.active');
        const t = document.querySelector('.handle-menu-item-tag.active');
        const wr = document.querySelector('.person-assign-wrapper.active');
        if (s) adjustHandleDropdownPlacement(s);
        if (p) adjustHandleDropdownPlacement(p);
        if (t) adjustHandleDropdownPlacement(t);
        if (wr) adjustHandleDropdownPlacement(wr);
    }, 80);
});

if (personSearchInput) {
    personSearchInput.addEventListener('input', (e) => {
        const query = e.target.value;
        if (personChip) {
            personChip.className = 'menu-chip empty';
        }
        if (query && currentBlockElement) {
            const blockData = getBlockData(currentBlockElement);
            if (blockData.assignedPerson) {
                blockData.assignedPerson = null;
            }
        }
        showPersonSearchResults(query);
    });

    personSearchInput.addEventListener('focus', () => {
        menuActiveField = 'person';
        const query = personSearchInput.value;
        showPersonSearchResults(query);
    });

    personSearchInput.addEventListener('blur', () => {
        setTimeout(() => {
            const dropdown = document.getElementById('personSearchDropdown');
            const trigger = document.getElementById('personAssignTrigger');
            const resultsContainer = document.getElementById('personSearchResults');
            if (!dropdown || !trigger) return;
            if (document.activeElement === personSearchInput) return;
            if (resultsContainer && resultsContainer.contains(document.activeElement)) return;
            if (trigger.contains(document.activeElement)) return;
            closePersonDropdown();
        }, 150);
    });

    personSearchInput.addEventListener('keydown', (e) => {
        const resultsContainer = document.getElementById('personSearchResults');
        const hasResults = resultsContainer && resultsContainer.classList.contains('show') && 
                          resultsContainer.querySelectorAll('.person-search-result-item').length > 0;
        
        // Si presiona Escape, quitar asignación o cerrar resultados
        if (e.key === 'Escape') {
            e.preventDefault();
            if (hasResults) {
                // Cerrar resultados
                resultsContainer.classList.remove('show');
                resultsContainer.innerHTML = '';
                selectedPersonIndex = -1;
            } else if (currentBlockElement) {
                // Quitar asignación
                removePersonFromBlock(currentBlockElement);
            }
        }
        // Si presiona Enter: confirmar y cerrar menú (con lo definido hasta el momento)
        else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (hasResults && selectedPersonIndex >= 0) {
                const items = resultsContainer.querySelectorAll('.person-search-result-item');
                if (items[selectedPersonIndex]) {
                    selectPersonFromResult(items[selectedPersonIndex]);
                }
            }
            confirmHandleMenuAndClose();
        }
        // Si presiona ArrowDown, navegar al primer resultado
        else if (e.key === 'ArrowDown' && hasResults) {
            e.preventDefault();
            navigatePersonResults(0); // Ir al primer resultado
            const items = resultsContainer.querySelectorAll('.person-search-result-item');
            if (items[0]) {
                items[0].focus();
            }
        }
        // Si presiona Tab y hay resultados, navegar al primer resultado
        else if (e.key === 'Tab' && !e.shiftKey && hasResults) {
            e.preventDefault();
            navigatePersonResults(0);
            const items = resultsContainer.querySelectorAll('.person-search-result-item');
            if (items[0]) {
                items[0].focus();
            }
        }
    });
}

// Cerrar dropdown de persona al hacer click fuera
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('personSearchDropdown');
    const trigger = document.getElementById('personAssignTrigger');
    if (dropdown && trigger &&
        !dropdown.contains(e.target) && 
        !trigger.contains(e.target)) {
        closePersonDropdown();
    }
});

// Función para copiar bloques seleccionados al portapapeles
// Retorna un objeto con { text: string, html: string }
function copySelectedBlocks() {
    if (selectedBlocks.size === 0) {
        return null;
    }
    
    // Guardar el contenido de todos los bloques seleccionados antes de copiar
    selectedBlocks.forEach(block => {
        saveBlockContent(block);
    });
    
    // Obtener los índices de los bloques seleccionados y ordenarlos según el orden visual
    const noteContent = document.getElementById('noteContent');
    const allBlocks = Array.from(noteContent.querySelectorAll('.content-block'));
    
    const selectedIndices = Array.from(selectedBlocks).map(block => {
        return getBlockIndexFromElement(block);
    }).sort((a, b) => a - b); // Ordenar de menor a mayor para mantener el orden visual
    
    // Etiquetas para estado y prioridad
    const statusLabels = {
        'pendiente': 'Pendiente',
        'en-progreso': 'En progreso',
        'hecho': 'Hecho'
    };
    
    const priorityLabels = {
        'p5': 'P5',
        'p4': 'P4',
        'p3': 'P3',
        'p2': 'P2',
        'p1': 'P1'
    };
    
    // Función auxiliar para escapar HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Serializar los bloques seleccionados
    const blocks = selectedIndices.map(index => {
        const blockData = noteData.blocks[index];
        if (!blockData) return null;
        
        // Obtener el texto plano del contenido (sin HTML)
        const blockElement = allBlocks[index];
        const contentDiv = blockElement ? blockElement.querySelector('.block-content') : null;
        let blockText = '';
        
        if (contentDiv) {
            // Obtener texto plano del contenido directamente del DOM (más actualizado)
            blockText = contentDiv.textContent || contentDiv.innerText || '';
        } else if (blockData.content) {
            // Fallback: convertir HTML a texto plano
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = blockData.content;
            blockText = tempDiv.textContent || tempDiv.innerText || '';
        }
        
        // Construir los metadatos
        const metadataParts = [];
        
        // Agregar estado si existe
        if (blockData.status) {
            const statusLabel = statusLabels[blockData.status] || blockData.status;
            metadataParts.push(`Estado: ${statusLabel}`);
        }
        
        // Agregar prioridad si existe
        if (blockData.priority) {
            const priorityLabel = priorityLabels[blockData.priority] || blockData.priority;
            metadataParts.push(`Prioridad: ${priorityLabel}`);
        }
        
        // Agregar persona asignada si existe
        if (blockData.assignedPerson) {
            const fullName = blockData.assignedPerson.lastName 
                ? `${blockData.assignedPerson.firstName} ${blockData.assignedPerson.lastName}` 
                : blockData.assignedPerson.firstName;
            metadataParts.push(`Asignado a: ${fullName}`);
        }
        
        // Construir la línea final
        let finalText = '';
        if (metadataParts.length > 0) {
            const metadata = `(${metadataParts.join(' | ')})`;
            finalText = blockText ? `${blockText} ${metadata}` : metadata;
        } else {
            finalText = blockText;
        }
        
        return {
            text: finalText,
            html: finalText // Se escapará en el HTML
        };
    }).filter(block => block !== null);
    
    // Construir text/plain con doble salto de línea para separar párrafos
    const plainText = blocks.map(block => block.text).join('\n\n');
    
    // Construir text/html con cada bloque en un <div>
    // Usar fragmento HTML (sin html/body) para mejor compatibilidad con Teams y Slack
    const htmlBlocks = blocks.map(block => {
        const escapedText = escapeHtml(block.text);
        // Cada <div> será tratado como un párrafo independiente
        return `<div>${escapedText}</div>`;
    }).join('');
    
    return {
        text: plainText,
        html: htmlBlocks
    };
}

// Función para eliminar los bloques seleccionados
function deleteSelectedBlocks() {
    if (selectedBlocks.size === 0) {
        return false;
    }
    pushUndoState();
    const noteContent = document.getElementById('noteContent');
    const allBlocks = noteContent.querySelectorAll('.content-block');
    
    // No eliminar si solo hay un bloque o si todos están seleccionados
    if (allBlocks.length <= 1 || selectedBlocks.size >= allBlocks.length) {
        return false;
    }
    
    // Obtener los índices de los bloques seleccionados y ordenarlos de mayor a menor
    const selectedIndices = Array.from(selectedBlocks).map(block => {
        return getBlockIndexFromElement(block);
    }).sort((a, b) => b - a); // Ordenar de mayor a menor para eliminar desde el final
    
    // Encontrar el bloque que quedará después de eliminar (el primero no seleccionado antes del último eliminado)
    let targetBlock = null;
    for (let i = selectedIndices[0] - 1; i >= 0; i--) {
        if (!selectedIndices.includes(i)) {
            targetBlock = allBlocks[i];
            break;
        }
    }
    // Si no hay bloque antes, buscar después
    if (!targetBlock) {
        for (let i = selectedIndices[0] + 1; i < allBlocks.length; i++) {
            if (!selectedIndices.includes(i)) {
                targetBlock = allBlocks[i];
                break;
            }
        }
    }
    
    // Eliminar bloques del DOM y de noteData.blocks (de mayor a menor índice para no afectar los índices)
    selectedIndices.forEach(index => {
        const block = allBlocks[index];
        if (block) {
            block.remove();
        }
        // Eliminar de noteData.blocks
        if (noteData.blocks && noteData.blocks.length > index) {
            noteData.blocks.splice(index, 1);
        }
    });
    
    // Limpiar selección
    clearBlockSelection();
    
    // Actualizar índices de todos los bloques restantes
    const remainingBlocks = noteContent.querySelectorAll('.content-block');
    remainingBlocks.forEach((b, idx) => {
        b.dataset.blockIndex = idx;
    });
    
    // Reconfigurar handles
    setupBlockHandles();
    
    // Mover foco al bloque objetivo
    if (targetBlock) {
        setTimeout(() => {
            const targetContent = targetBlock.querySelector('.block-content');
            if (targetContent) {
                targetContent.focus();
                // Mover cursor al inicio del bloque
                const range = document.createRange();
                const sel = window.getSelection();
                range.setStart(targetContent, 0);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }, 10);
    }
    
    saveNote();
    return true;
}

// Función para eliminar el bloque actual
function deleteCurrentBlock() {
    if (!currentBlockElement) return false;
    
    const noteContent = document.getElementById('noteContent');
    const blocks = noteContent.querySelectorAll('.content-block');
    
    // No eliminar si solo hay un bloque
    if (blocks.length <= 1) {
        return false;
    }
    
    const currentIndex = getBlockIndex(currentBlockElement);
    const nextBlock = currentBlockElement.nextElementSibling;
    const prevBlock = currentBlockElement.previousElementSibling;
    
    // Eliminar el bloque completo del DOM
    currentBlockElement.remove();
    
    // Eliminar de noteData.blocks
    if (noteData.blocks && noteData.blocks.length > currentIndex) {
        noteData.blocks.splice(currentIndex, 1);
    }
    
    // Limpiar referencia al bloque eliminado
    currentBlockElement = null;
    
    // Actualizar índices de todos los bloques
    const remainingBlocks = noteContent.querySelectorAll('.content-block');
    remainingBlocks.forEach((b, idx) => {
        b.dataset.blockIndex = idx;
    });
    
    // Reconfigurar handles
    setupBlockHandles();
    
    // Mover foco al bloque siguiente o anterior
    setTimeout(() => {
        const targetBlock = nextBlock || prevBlock;
        if (targetBlock) {
            const targetContent = targetBlock.querySelector('.block-content');
            if (targetContent) {
                targetContent.focus();
                // Mover cursor al final si es el siguiente, al inicio si es el anterior
                const range = document.createRange();
                const sel = window.getSelection();
                if (nextBlock) {
                    range.selectNodeContents(targetContent);
                    range.collapse(false); // Al final
                } else {
                    range.setStart(targetContent, 0);
                    range.collapse(true); // Al inicio
                }
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
    }, 10);
    
    saveNote();
    closeHandleMenu();
    return true;
}

// Eliminar bloque
document.getElementById('deleteBlockBtn').addEventListener('click', () => {
    deleteCurrentBlock();
});

// Diálogo de Enter
document.getElementById('enterConfirmBtn').addEventListener('click', () => {
    if (pendingEnterBlock) {
        const status = document.getElementById('enterStatusSelect').value;
        const priority = document.getElementById('enterPrioritySelect').value;
        applyBlockMetadata(pendingEnterBlock, status, priority, null, null);
    }
    hideEnterDialog();
    enterPressed = false;
});

document.getElementById('enterCancelBtn').addEventListener('click', () => {
    hideEnterDialog();
    enterPressed = false;
});

// Cerrar menú al hacer click fuera
document.addEventListener('click', (e) => {
    const menu = document.getElementById('handleMenu');
    if (menu.classList.contains('show') && !menu.contains(e.target) && 
        !e.target.closest('.block-handle')) {
        closeHandleMenu();
    }
    
    const noteOptionsMenu = document.getElementById('noteOptionsMenu');
    const optionsBtn = document.getElementById('optionsBtn');
    if (noteOptionsMenu && noteOptionsMenu.classList.contains('show') && 
        !noteOptionsMenu.contains(e.target) && 
        !optionsBtn.contains(e.target)) {
        closeNoteOptionsMenu();
    }
    
    const dialog = document.getElementById('enterDialog');
    if (dialog.classList.contains('show') && !dialog.contains(e.target)) {
        hideEnterDialog();
        enterPressed = false;
    }
    
    // Limpiar selección de bloques si se hace click fuera de los bloques
    const noteContent = document.getElementById('noteContent');
    if (noteContent && !noteContent.contains(e.target) && !e.target.closest('.content-block')) {
        clearBlockSelection();
    }
});

// Interceptar evento de copia cuando hay bloques seleccionados
document.addEventListener('copy', (e) => {
    // Solo interceptar si hay bloques seleccionados
    if (selectedBlocks.size === 0) {
        return; // Dejar que el comportamiento por defecto maneje la copia normal
    }
    
    // Verificar que no estemos en un input o textarea
    const activeElement = document.activeElement;
    const isInput = activeElement && (
        activeElement.tagName === 'INPUT' || 
        activeElement.tagName === 'TEXTAREA'
    );
    
    // Verificar si hay texto seleccionado dentro de un bloque editable
    const selection = window.getSelection();
    const hasTextSelection = selection && selection.rangeCount > 0 && !selection.isCollapsed;
    
    // Si hay texto seleccionado dentro de un bloque editable, usar comportamiento por defecto
    if (hasTextSelection && activeElement && activeElement.classList.contains('block-content')) {
        return; // Dejar que el comportamiento por defecto maneje la copia de texto
    }
    
    // Si hay bloques seleccionados y no estamos en un input, copiar los bloques con metadatos
    if (!isInput) {
        e.preventDefault();
        e.stopPropagation();
        
        const blocksData = copySelectedBlocks();
        
        if (blocksData) {
            // Usar la Clipboard API moderna con múltiples formatos si está disponible
            if (navigator.clipboard && navigator.clipboard.write) {
                try {
                    const clipboardItem = new ClipboardItem({
                        'text/plain': Promise.resolve(new Blob([blocksData.text], { type: 'text/plain' })),
                        'text/html': Promise.resolve(new Blob([blocksData.html], { type: 'text/html' }))
                    });
                    
                    navigator.clipboard.write([clipboardItem]).catch(err => {
                        console.error('Error al copiar al portapapeles:', err);
                        // Fallback: usar el método tradicional
                        if (e.clipboardData) {
                            e.clipboardData.setData('text/plain', blocksData.text);
                            e.clipboardData.setData('text/html', blocksData.html);
                        }
                    });
                } catch (clipboardError) {
                    // Si ClipboardItem no está disponible, usar fallback
                    if (e.clipboardData) {
                        e.clipboardData.setData('text/plain', blocksData.text);
                        e.clipboardData.setData('text/html', blocksData.html);
                    }
                }
            } else if (e.clipboardData) {
                // Fallback para navegadores que no soportan Clipboard API
                e.clipboardData.setData('text/plain', blocksData.text);
                e.clipboardData.setData('text/html', blocksData.html);
            }
        }
    }
}, true); // Usar capture phase para interceptar antes

// Manejar Ctrl+C con keydown como respaldo
document.addEventListener('keydown', (e) => {
    // Interceptar Ctrl+C o Cmd+C cuando hay bloques seleccionados
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedBlocks.size > 0) {
        // Verificar que no estemos en un input o textarea
        const activeElement = document.activeElement;
        const isInput = activeElement && (
            activeElement.tagName === 'INPUT' || 
            activeElement.tagName === 'TEXTAREA'
        );
        
        // Verificar si hay texto seleccionado dentro de un bloque editable
        const selection = window.getSelection();
        const hasTextSelection = selection && selection.rangeCount > 0 && !selection.isCollapsed;
        
        // Si hay texto seleccionado dentro de un bloque editable, usar comportamiento por defecto
        if (hasTextSelection && activeElement && activeElement.classList.contains('block-content')) {
            return; // Dejar que el comportamiento por defecto maneje la copia de texto
        }
        
        // Si hay bloques seleccionados y no estamos en un input, copiar los bloques
        if (!isInput) {
            const blocksData = copySelectedBlocks();
            if (blocksData) {
                // Usar la Clipboard API moderna con múltiples formatos
                if (navigator.clipboard && navigator.clipboard.write) {
                    try {
                        const clipboardItem = new ClipboardItem({
                            'text/plain': Promise.resolve(new Blob([blocksData.text], { type: 'text/plain' })),
                            'text/html': Promise.resolve(new Blob([blocksData.html], { type: 'text/html' }))
                        });
                        
                        navigator.clipboard.write([clipboardItem]).catch(err => {
                            console.error('Error al copiar al portapapeles:', err);
                            // Fallback: solo texto plano
                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(blocksData.text).catch(() => {});
                            }
                        });
                    } catch (clipboardError) {
                        // Si ClipboardItem no está disponible, usar fallback
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(blocksData.text).catch(err => {
                                console.error('Error al copiar al portapapeles:', err);
                            });
                        }
                    }
                } else if (navigator.clipboard && navigator.clipboard.writeText) {
                    // Fallback: solo texto plano si no hay soporte para múltiples formatos
                    navigator.clipboard.writeText(blocksData.text).catch(err => {
                        console.error('Error al copiar al portapapeles:', err);
                    });
                }
            }
        }
    }
    
    // Ctrl+Shift+Z / Cmd+Shift+Z: rehacer
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        if (redoStack.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            popRedoState();
        }
        return;
    }

    // Ctrl+Z / Cmd+Z: deshacer (texto y parámetros de bloques: estado, prioridad, persona, etiqueta)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        if (undoStack.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            popUndoState();
        }
        return;
    }
    
    // Si hay bloques seleccionados y se presiona Delete, eliminar los seleccionados
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Verificar que no estemos en un input o textarea con contenido seleccionado
        const activeElement = document.activeElement;
        const isInput = activeElement && (
            (activeElement.tagName === 'INPUT' && activeElement.type !== 'text') || 
            activeElement.tagName === 'TEXTAREA'
        );
        
        // Verificar si hay texto seleccionado en un contentEditable
        const selection = window.getSelection();
        const hasTextSelection = selection && selection.rangeCount > 0 && !selection.isCollapsed;
        
        // Si hay bloques seleccionados, no estamos en un input, y no hay texto seleccionado, eliminar bloques
        if (selectedBlocks.size > 0 && !isInput && !hasTextSelection) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            deleteSelectedBlocks();
            return;
        }
    }
}, true); // Usar capture phase para interceptar antes

// Navegación con teclado en el menú
document.addEventListener('keydown', (e) => {
    // No interferir con la detección de "/" en los bloques
    if (e.key === '/' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Verificar si el evento viene de un bloque de contenido
        const target = e.target;
        if (target && target.classList && target.classList.contains('block-content')) {
            // Dejar que el listener del bloque maneje esto
            return;
        }
    }
    
    const menu = document.getElementById('handleMenu');
    if (!menu || !menu.classList.contains('show')) {
        // Si el menú no está abierto, manejar Escape normalmente
        if (e.key === 'Escape') {
            if (enterDialogShown) {
                hideEnterDialog();
                enterPressed = false;
            }
        }
        return;
    }
    
    // Si el menú está abierto, manejar navegación
    if (e.key === 'Escape') {
        closeHandleMenu();
        e.preventDefault();
        return;
    }
    
    // Navegación con flechas (para estado, prioridad y etiquetas)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Si el foco está en el input de persona, no hacer nada con las flechas
        if (document.activeElement === personSearchInput) {
            return;
        }
        e.preventDefault();
        if (menuActiveField === 'status') {
            navigateStatus(e.key === 'ArrowRight' ? 'next' : 'prev');
        } else if (menuActiveField === 'priority') {
            navigatePriority(e.key === 'ArrowRight' ? 'next' : 'prev');
        } else if (menuActiveField === 'tag') {
            navigateTag(e.key === 'ArrowRight' ? 'next' : 'prev');
        }
        return;
    }
    
    // Tab o Enter para cambiar entre estado, prioridad y persona
    if (e.key === 'Tab' || e.key === 'Enter') {
        // Si el foco está en el input de persona
        if (document.activeElement === personSearchInput) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const resultsContainer = document.getElementById('personSearchResults');
                const hasResults = resultsContainer && resultsContainer.classList.contains('show') && 
                                  resultsContainer.querySelectorAll('.person-search-result-item').length > 0;
                
                // Si hay resultados abiertos, seleccionar el resultado actual
                if (hasResults && selectedPersonIndex >= 0) {
                    const items = resultsContainer.querySelectorAll('.person-search-result-item');
                    if (items[selectedPersonIndex]) {
                        selectPersonFromResult(items[selectedPersonIndex]);
                    }
                } else {
                    // Si no hay resultados pero hay una persona asignada, guardar y cerrar
                    if (currentBlockElement) {
                        const blockData = getBlockData(currentBlockElement);
                        if (blockData.assignedPerson) {
                            saveNote();
                            closeHandleMenu();
                        }
                    }
                }
            } else if (e.key === 'Tab' && !e.shiftKey) {
                // Tab desde persona: ir a acciones o cerrar
                e.preventDefault();
                menuActiveField = 'status'; // Resetear para el próximo ciclo
                closeHandleMenu();
            } else if (e.key === 'Tab' && e.shiftKey) {
                // Shift+Tab desde persona: volver a etiqueta
                e.preventDefault();
                menuActiveField = 'tag';
                const tagFocusTargetEl = document.getElementById('tagFocusTarget');
                if (tagFocusTargetEl) tagFocusTargetEl.focus();
            }
            return;
        }
        
        e.preventDefault();
        
        if (e.shiftKey) {
            // Shift+Tab: ir al campo anterior
            if (menuActiveField === 'priority') {
                menuActiveField = 'status';
                const statusFocusTargetEl = document.getElementById('statusFocusTarget');
                if (statusFocusTargetEl) statusFocusTargetEl.focus();
            } else if (menuActiveField === 'person') {
                menuActiveField = 'priority';
                const priorityFocusTargetEl = document.getElementById('priorityFocusTarget');
                if (priorityFocusTargetEl) priorityFocusTargetEl.focus();
            } else if (menuActiveField === 'tag') {
                menuActiveField = 'person';
                const personAssignTriggerEl = document.getElementById('personAssignTrigger');
                if (personAssignTriggerEl) personAssignTriggerEl.focus();
            } else if (menuActiveField === 'status') {
                menuActiveField = 'tag';
                const tagFocusTargetEl = document.getElementById('tagFocusTarget');
                if (tagFocusTargetEl) tagFocusTargetEl.focus();
            }
        } else {
            // Tab: ir al campo siguiente
            if (menuActiveField === 'status') {
                menuActiveField = 'priority';
                const priorityFocusTargetEl = document.getElementById('priorityFocusTarget');
                if (priorityFocusTargetEl) priorityFocusTargetEl.focus();
            } else if (menuActiveField === 'priority') {
                menuActiveField = 'person';
                const personAssignTriggerEl = document.getElementById('personAssignTrigger');
                if (personAssignTriggerEl) personAssignTriggerEl.focus();
            } else if (menuActiveField === 'person') {
                menuActiveField = 'tag';
                const tagFocusTargetEl = document.getElementById('tagFocusTarget');
                if (tagFocusTargetEl) tagFocusTargetEl.focus();
            } else if (menuActiveField === 'tag') {
                if (e.key === 'Enter') {
                    closeHandleMenu();
                } else {
                    // Tab desde etiqueta: cerrar menú
                    menuActiveField = 'status';
                    closeHandleMenu();
                }
            }
        }
        return;
    }
    
    // Delete para eliminar el bloque cuando el menú está abierto
    if (e.key === 'Delete' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (deleteCurrentBlock()) {
            return;
        }
    }
});

// Cargar nota al iniciar
// Detectar cuando se presiona/suelta Shift para cambiar el cursor
document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !document.body.classList.contains('shift-pressed')) {
        document.body.classList.add('shift-pressed');
    }
});

document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
        document.body.classList.remove('shift-pressed');
    }
});

// También detectar cuando se pierde el foco de la ventana
window.addEventListener('blur', () => {
    document.body.classList.remove('shift-pressed');
});

window.addEventListener('DOMContentLoaded', () => {
    loadNote();
    console.log('Nota cargada, noteId:', noteId);
});

// Guardar automáticamente cada 2 segundos
setInterval(() => {
    saveNote();
}, 2000);

// Escuchar mensaje para enfocar un bloque específico (desde Kanban)
ipcRenderer.on('focus-block', (event, blockIndex) => {
    // Asegurar que blockIndex sea un número
    const targetIndex = parseInt(blockIndex, 10);
    
    if (isNaN(targetIndex)) {
        console.error('focus-block: blockIndex inválido', blockIndex);
        return;
    }
    
    // Intentar múltiples veces para asegurar que el contenido esté cargado
    let attempts = 0;
    const maxAttempts = 25;
    
    const tryFocusBlock = () => {
        const noteContent = document.getElementById('noteContent');
        if (!noteContent) {
            attempts++;
            if (attempts < maxAttempts) {
                setTimeout(tryFocusBlock, 200);
            }
            return;
        }
        
        const blocks = Array.from(noteContent.querySelectorAll('.content-block'));
        
        if (blocks.length === 0) {
            attempts++;
            if (attempts < maxAttempts) {
                setTimeout(tryFocusBlock, 200);
            }
            return;
        }
        
        if (blocks[targetIndex]) {
            const targetBlock = blocks[targetIndex];
            const contentDiv = targetBlock.querySelector('.block-content');
            
            if (contentDiv) {
                // Limpiar cualquier focus previo desde Kanban con fade out (solo si es diferente)
                const currentFocused = document.querySelector('.content-block.block-focused-from-kanban');
                if (currentFocused && currentFocused !== targetBlock) {
                    currentFocused.classList.add('fade-out');
                    setTimeout(() => {
                        currentFocused.classList.remove('block-focused-from-kanban', 'fade-out');
                    }, 150);
                }
                
                // Aplicar el estilo de focus desde Kanban inmediatamente (mismo color verde, sin borde, con border-radius)
                targetBlock.classList.add('block-focused-from-kanban');
                
                // Scroll al bloque
                setTimeout(() => {
                    targetBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 50);
                
                // Enfocar el contenido
                setTimeout(() => {
                    contentDiv.focus();
                }, 100);
            } else {
                attempts++;
                if (attempts < maxAttempts) {
                    setTimeout(tryFocusBlock, 200);
                }
            }
        } else {
            attempts++;
            if (attempts < maxAttempts) {
                setTimeout(tryFocusBlock, 200);
            }
        }
    };
    
    // Iniciar después de un pequeño delay inicial
    setTimeout(tryFocusBlock, 500);
});

// Escuchar actualizaciones de datos de la nota (desde Kanban u otras fuentes)
ipcRenderer.on('note-data-updated', (event, updatedNoteData) => {
    // Actualizar noteData con los nuevos datos
    if (updatedNoteData.id === noteId) {
        // Verificar si el contenido realmente cambió comparando los bloques
        const currentBlocksContent = JSON.stringify(noteData.blocks || []);
        const updatedBlocksContent = JSON.stringify(updatedNoteData.blocks || []);
        const contentChanged = currentBlocksContent !== updatedBlocksContent || noteData.title !== updatedNoteData.title;

        // No re-renderizar si los datos entrantes son más viejos que los nuestros (evita pérdida de foco al escribir rápido)
        const ourTime = new Date(noteData.updatedAt || 0).getTime();
        const theirTime = new Date(updatedNoteData.updatedAt || 0).getTime();
        const incomingIsStale = theirTime < ourTime;

        if (contentChanged && !incomingIsStale) {
            noteData = { ...updatedNoteData };
            // Asegurar que blocks existe
            if (!noteData.blocks) {
                noteData.blocks = [];
            }
            // Re-renderizar el contenido para reflejar los cambios
            renderContent();
        } else if (!contentChanged || incomingIsStale) {
            // Solo actualizar el objeto noteData sin re-renderizar (evita reemplazar DOM y perder foco)
            noteData = { ...updatedNoteData };
            if (!noteData.blocks) {
                noteData.blocks = [];
            }
        }
    }
});

// Captura estado antes de cada edición de texto/título para que la pila coincida con Ctrl+Z (el deshacer nativo del navegador no llena undoStack).
function initBeforeInputUndo() {
    document.addEventListener('beforeinput', (e) => {
        const inputType = e.inputType || '';
        if (inputType === 'historyUndo' || inputType === 'historyRedo') return;
        // Enter en bloques lo maneja keydown con pushUndoState; evitar doble entrada
        if (inputType === 'insertParagraph') return;
        const target = e.target;
        if (!target) return;
        const noteContent = document.getElementById('noteContent');
        if (target.id === 'noteTitle') {
            pushUndoState({ persist: false });
            return;
        }
        if (target.classList && target.classList.contains('block-content') && noteContent && noteContent.contains(target)) {
            pushUndoState({ persist: false });
        }
    }, true);
}

// Un único listener de paste por delegación (evita que se ejecute N veces por tener N bloques con listener)
function initPasteHandler() {
    document.addEventListener('paste', (e) => {
        const contentDiv = document.activeElement;
        if (!contentDiv || !contentDiv.classList || !contentDiv.classList.contains('block-content')) return;
        const noteContentEl = document.getElementById('noteContent');
        const block = contentDiv.closest('.content-block');
        if (!block || !noteContentEl || !noteContentEl.contains(block)) return;
        e.preventDefault();
        e.stopPropagation();
        const pastedText = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (!pastedText) return;
        const lines = pastedText.split(/\r?\n/);
        if (lines.length === 0) return;
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        const cursorPosition = getCaretCharacterOffsetWithin(contentDiv);
        const contentText = contentDiv.textContent || '';
        const textBeforeCursor = contentText.substring(0, cursorPosition);
        const textAfterCursor = contentText.substring(cursorPosition);
        pushUndoState({ persist: false });
        saveBlockContent(block);
        if (lines.length > 1) {
            const firstLine = lines[0];
            contentDiv.textContent = textBeforeCursor + firstLine;
            saveBlockContent(block);
            const currentIndex = getBlockIndex(block);
            const newBlocks = [];
            const blocksToInsert = [];
            for (let i = 1; i < lines.length; i++) {
                const newBlock = createBlockElement(lines[i], null);
                newBlocks.push(newBlock);
                blocksToInsert.push({
                    content: lines[i],
                    status: '',
                    priority: '',
                    assignedPerson: null,
                    tag: null,
                    blockUpdatedAt: new Date().toISOString(),
                    createdAt: new Date().toISOString()
                });
            }
            noteData.blocks.splice(currentIndex + 1, 0, ...blocksToInsert);
            const nextSibling = block.nextSibling;
            if (nextSibling) {
                newBlocks.forEach((newBlock) => noteContentEl.insertBefore(newBlock, nextSibling));
            } else {
                newBlocks.forEach((newBlock) => noteContentEl.appendChild(newBlock));
            }
            noteContentEl.querySelectorAll('.content-block').forEach((b, idx) => { b.dataset.blockIndex = idx; });
            if (textAfterCursor.trim()) {
                const lastBlockContent = newBlocks[newBlocks.length - 1].querySelector('.block-content');
                if (lastBlockContent) lastBlockContent.textContent = lastBlockContent.textContent + textAfterCursor;
            }
            setupBlockHandles();
            setTimeout(() => {
                const lastBlockContent = newBlocks[newBlocks.length - 1].querySelector('.block-content');
                if (lastBlockContent) {
                    lastBlockContent.focus();
                    setCaretPosition(lastBlockContent, (lastBlockContent.textContent || '').length);
                }
            }, 0);
            saveNote();
        } else {
            contentDiv.textContent = textBeforeCursor + lines[0] + textAfterCursor;
            const caretAfterPaste = textBeforeCursor.length + lines[0].length;
            contentDiv.focus();
            setCaretPosition(contentDiv, caretAfterPaste);
            saveBlockContent(block);
            saveNote();
        }
    }, true);
}
initBeforeInputUndo();
initPasteHandler();

// Guardar al cerrar la ventana (no guardar si estamos eliminando la nota: saveNote() la volvería a insertar)
window.addEventListener('beforeunload', () => {
    if (!isDeletingCurrentNote) {
        saveNote();
    }
});

