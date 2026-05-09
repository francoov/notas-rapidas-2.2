const { ipcRenderer } = require('electron');

let persons = [];
let tags = [];

// ========== MODAL ESTÁNDAR (confirmación / aviso) ==========
function hideAppModal() {
    const modal = document.getElementById('appModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

function showAlert(options) {
    const { title = 'Aviso', message } = typeof options === 'string' ? { message: options } : options;
    const modal = document.getElementById('appModal');
    const titleEl = document.getElementById('appModalTitle');
    const messageEl = document.getElementById('appModalMessage');
    const warningEl = document.getElementById('appModalWarning');
    const cancelBtn = document.getElementById('appModalCancelBtn');
    const confirmBtn = document.getElementById('appModalConfirmBtn');
    if (!modal || !titleEl || !messageEl || !confirmBtn) return;

    warningEl.style.display = 'none';
    titleEl.textContent = title;
    messageEl.textContent = message;
    cancelBtn.style.display = 'none';
    confirmBtn.textContent = 'Aceptar';
    confirmBtn.className = 'app-modal-btn app-modal-btn-primary';
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    const newConfirmBtn = document.getElementById('appModalConfirmBtn');

    const cleanup = () => {
        hideAppModal();
        document.removeEventListener('click', closeOnOverlay);
        document.removeEventListener('keydown', onEscape);
    };
    const closeOnOverlay = (e) => {
        if (e.target === modal) cleanup();
    };
    const onEscape = (e) => {
        if (e.key === 'Escape') cleanup();
    };

    newConfirmBtn.addEventListener('click', cleanup);
    modal.classList.add('show');
    setTimeout(() => document.addEventListener('click', closeOnOverlay), 0);
    document.addEventListener('keydown', onEscape);
}

function showConfirm(options) {
    const {
        title = 'Confirmar',
        message,
        warning = '',
        confirmText = 'Aceptar',
        cancelText = 'Cancelar',
        danger = false,
        onConfirm,
        onCancel
    } = options;

    const modal = document.getElementById('appModal');
    const titleEl = document.getElementById('appModalTitle');
    const messageEl = document.getElementById('appModalMessage');
    const warningEl = document.getElementById('appModalWarning');
    const cancelBtn = document.getElementById('appModalCancelBtn');
    const confirmBtn = document.getElementById('appModalConfirmBtn');
    if (!modal || !titleEl || !messageEl || !cancelBtn || !confirmBtn) return;

    titleEl.textContent = title;
    messageEl.textContent = message;
    if (warning) {
        warningEl.textContent = warning;
        warningEl.style.display = 'block';
    } else {
        warningEl.style.display = 'none';
    }
    cancelBtn.style.display = 'flex';
    cancelBtn.textContent = cancelText;
    confirmBtn.textContent = confirmText;
    confirmBtn.className = danger ? 'app-modal-btn app-modal-btn-danger' : 'app-modal-btn app-modal-btn-primary';

    const cleanup = () => {
        hideAppModal();
        document.removeEventListener('keydown', onEscape);
        modal.onclick = null;
    };
    const onEscape = (e) => {
        if (e.key === 'Escape') {
            cleanup();
            if (typeof onCancel === 'function') onCancel();
        }
    };

    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    const newCancelBtn = document.getElementById('appModalCancelBtn');
    const newConfirmBtn = document.getElementById('appModalConfirmBtn');

    newCancelBtn.addEventListener('click', () => {
        cleanup();
        if (typeof onCancel === 'function') onCancel();
    });
    newConfirmBtn.addEventListener('click', () => {
        cleanup();
        if (typeof onConfirm === 'function') onConfirm();
    });
    modal.classList.add('show');
    document.addEventListener('keydown', onEscape);
    modal.onclick = (e) => {
        if (e.target === modal) {
            cleanup();
            if (typeof onCancel === 'function') onCancel();
        }
    };
}

// Cargar personas del localStorage (incluye eliminadas para soft-delete)
function loadPersons() {
    const savedPersons = localStorage.getItem('persons');
    if (savedPersons) {
        persons = JSON.parse(savedPersons);
        persons.forEach(p => { if (p.deleted === undefined) p.deleted = false; });
    } else {
        persons = [];
    }
    renderPersons();
}

// Guardar personas en localStorage
function savePersons() {
    localStorage.setItem('persons', JSON.stringify(persons));
}

// Generar iniciales de una persona
function getInitials(firstName, lastName) {
    const first = firstName ? firstName.charAt(0).toUpperCase() : '';
    const last = lastName ? lastName.charAt(0).toUpperCase() : '';
    return first + last;
}

// Renderizar lista de personas (muestra eliminadas como "Nombre (Eliminado)")
function renderPersons() {
    const personsList = document.getElementById('personsList');
    if (!personsList) return;

    if (persons.length === 0) {
        personsList.innerHTML = `
            <div class="empty-state">
                <p>No hay personas registradas</p>
                <p>Agrega una persona usando el formulario de arriba</p>
            </div>
        `;
        return;
    }

    const personsHTML = persons.map((person, index) => {
        const initials = getInitials(person.firstName, person.lastName);
        const fullName = person.lastName
            ? `${person.firstName} ${person.lastName}`
            : person.firstName;
        const displayName = person.deleted ? `${fullName} (Eliminado)` : fullName;
        const isDeleted = person.deleted === true;
        const btnClass = isDeleted ? 'restore-person-btn' : 'delete-person-btn';
        const btnTitle = isDeleted ? 'Restaurar' : 'Eliminar';
        const icon = isDeleted ? 'rotate-ccw' : 'trash-2';
        const quitarBtn = isDeleted ? `
            <button type="button" class="remove-person-btn" data-index="${index}" title="Quitar definitivamente">
                <i data-lucide="trash-2"></i>
                <span class="person-btn-label">Quitar</span>
            </button>
        ` : '';
        return `
            <div class="person-item ${isDeleted ? 'person-item-deleted' : ''}">
                <div class="person-info">
                    <div class="person-avatar">${initials}</div>
                    <div class="person-name">${escapeHtml(displayName)}</div>
                </div>
                <div class="person-actions">
                    <button type="button" class="${btnClass}" data-index="${index}" title="${btnTitle}">
                        <i data-lucide="${icon}"></i>
                        <span class="person-btn-label">${isDeleted ? 'Restaurar' : 'Eliminar'}</span>
                    </button>
                    ${quitarBtn}
                </div>
            </div>
        `;
    }).join('');

    personsList.innerHTML = personsHTML;

    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons();
        });
    }

    document.querySelectorAll('.delete-person-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            deletePerson(parseInt(btn.dataset.index));
        });
    });
    document.querySelectorAll('.restore-person-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            restorePerson(parseInt(btn.dataset.index));
        });
    });
    document.querySelectorAll('.remove-person-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            removePersonPermanently(parseInt(btn.dataset.index));
        });
    });
}

// Agregar persona (o restaurar si ya existe una eliminada con el mismo nombre, sin distinguir mayúsculas)
function addPerson() {
    const firstNameInput = document.getElementById('personFirstName');
    const lastNameInput = document.getElementById('personLastName');
    if (!firstNameInput) return;

    const firstName = firstNameInput.value.trim();
    const lastName = (lastNameInput ? lastNameInput.value.trim() : '') || '';

    if (!firstName) {
        showAlert({ title: 'Aviso', message: 'El nombre es requerido.' });
        return;
    }

    const firstLower = firstName.toLowerCase();
    const lastLower = lastName.toLowerCase();
    const existing = persons.find(p =>
        (p.firstName || '').toLowerCase() === firstLower &&
        (p.lastName || '').toLowerCase() === lastLower
    );

    if (existing) {
        if (!existing.deleted) {
            showAlert({ title: 'Aviso', message: 'Ya existe una persona con ese nombre y apellido.' });
            return;
        }
        showConfirm({
            title: 'Restaurar persona',
            message: 'Ya existe una persona eliminada con ese nombre. ¿Deseas restaurarla?',
            confirmText: 'Restaurar',
            cancelText: 'Cancelar',
            danger: false,
            onConfirm: () => {
                existing.deleted = false;
                existing.firstName = firstName;
                existing.lastName = lastName;
                savePersons();
                renderPersons();
                firstNameInput.value = '';
                if (lastNameInput) lastNameInput.value = '';
                firstNameInput.focus();
            }
        });
        return;
    }

    const newPerson = {
        id: Date.now().toString(),
        firstName: firstName,
        lastName: lastName,
        deleted: false
    };

    persons.push(newPerson);
    savePersons();
    renderPersons();

    firstNameInput.value = '';
    if (lastNameInput) lastNameInput.value = '';
    firstNameInput.focus();
}

// Soft-delete: marcar como eliminada sin quitar de bloques
function deletePerson(index) {
    showConfirm({
        title: 'Eliminar persona',
        message: '¿Estás seguro de que quieres eliminar esta persona?',
        warning: 'Seguirá apareciendo como "(Eliminado)" en los bloques que la tengan asignada.',
        confirmText: 'Eliminar',
        cancelText: 'Cancelar',
        danger: true,
        onConfirm: () => {
            persons[index].deleted = true;
            savePersons();
            renderPersons();
        }
    });
}

// Restaurar persona eliminada
function restorePerson(index) {
    persons[index].deleted = false;
    savePersons();
    renderPersons();
}

// Quitar definitivamente una persona eliminada (ya no aparecerá en la lista ni en bloques)
function removePersonPermanently(index) {
    showConfirm({
        title: 'Quitar persona',
        message: '¿Quitar definitivamente esta persona? Los bloques que la tengan asignada quedarán sin asignar.',
        confirmText: 'Quitar',
        cancelText: 'Cancelar',
        danger: true,
        onConfirm: () => {
            persons.splice(index, 1);
            savePersons();
            renderPersons();
        }
    });
}

// Event Listeners (se asignan en DOMContentLoaded para evitar errores si el DOM no está listo)
function setupEventListeners() {
    const notesListBtn = document.getElementById('notesListBtn');
    if (notesListBtn) {
        notesListBtn.addEventListener('click', () => {
            ipcRenderer.send('focus-main-window');
        });
    }

    const addPersonBtn = document.getElementById('addPersonBtn');
    if (addPersonBtn) {
        addPersonBtn.addEventListener('click', () => addPerson());
    }

    const addTagBtn = document.getElementById('addTagBtn');
    if (addTagBtn) {
        addTagBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            addTag();
        });
    }

    const tagNameInput = document.getElementById('tagName');
    if (tagNameInput) {
        tagNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
            }
        });
    }

    const personFirstName = document.getElementById('personFirstName');
    if (personFirstName) {
        personFirstName.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addPerson();
            }
        });
    }

    const personLastName = document.getElementById('personLastName');
    if (personLastName) {
        personLastName.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addPerson();
            }
        });
    }
}

// ========== GESTIÓN DE ETIQUETAS ==========

// Cargar etiquetas del localStorage (incluye eliminadas para soft-delete)
function loadTags() {
    const savedTags = localStorage.getItem('tags');
    if (savedTags) {
        tags = JSON.parse(savedTags);
        // Migrar etiquetas antiguas sin propiedad deleted
        tags.forEach(t => {
            if (t.deleted === undefined) t.deleted = false;
        });
    } else {
        tags = [];
    }
    renderTags();
}

// Guardar etiquetas en localStorage
function saveTags() {
    localStorage.setItem('tags', JSON.stringify(tags));
}

// Renderizar lista de etiquetas (muestra activas y eliminadas como "Nombre (Eliminado)")
function renderTags() {
    const tagsList = document.getElementById('tagsList');
    if (!tagsList) return;

    if (tags.length === 0) {
        tagsList.innerHTML = `
            <div class="empty-state">
                <p>No hay etiquetas creadas</p>
                <p>Agrega una etiqueta usando el formulario de arriba</p>
            </div>
        `;
        return;
    }

    const tagsHTML = tags.map((tag, index) => {
        const displayName = tag.deleted ? `${tag.name} (Eliminado)` : tag.name;
        const isDeleted = tag.deleted === true;
        const btnClass = isDeleted ? 'restore-tag-btn' : 'delete-tag-btn';
        const btnTitle = isDeleted ? 'Restaurar' : 'Eliminar';
        const icon = isDeleted ? 'rotate-ccw' : 'trash-2';
        const quitarBtn = isDeleted ? `
            <button type="button" class="remove-tag-btn" data-index="${index}" title="Quitar definitivamente">
                <i data-lucide="trash-2"></i>
                <span class="tag-btn-label">Quitar</span>
            </button>
        ` : '';
        return `
            <div class="tag-item ${isDeleted ? 'tag-item-deleted' : ''}">
                <div class="tag-info">
                    <div class="tag-name">${escapeHtml(displayName)}</div>
                </div>
                <div class="tag-actions">
                    <button type="button" class="${btnClass}" data-index="${index}" title="${btnTitle}">
                        <i data-lucide="${icon}"></i>
                        <span class="tag-btn-label">${isDeleted ? 'Restaurar' : 'Eliminar'}</span>
                    </button>
                    ${quitarBtn}
                </div>
            </div>
        `;
    }).join('');

    tagsList.innerHTML = tagsHTML;

    if (typeof lucide !== 'undefined') {
        requestAnimationFrame(() => {
            lucide.createIcons();
        });
    }

    document.querySelectorAll('.delete-tag-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const index = parseInt(btn.dataset.index);
            deleteTag(index);
        });
    });
    document.querySelectorAll('.restore-tag-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const index = parseInt(btn.dataset.index);
            restoreTag(index);
        });
    });
    document.querySelectorAll('.remove-tag-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const index = parseInt(btn.dataset.index);
            removeTagPermanently(index);
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Agregar etiqueta (o restaurar si ya existe una eliminada con el mismo nombre, sin distinguir mayúsculas)
function addTag() {
    const tagNameInput = document.getElementById('tagName');
    if (!tagNameInput) return;

    if (!Array.isArray(tags)) {
        tags = [];
    }

    const tagName = tagNameInput.value.trim();

    if (!tagName) {
        showAlert({ title: 'Aviso', message: 'El nombre de la etiqueta es requerido.' });
        return;
    }

    const tagNameLower = tagName.toLowerCase();
    const existing = tags.find(t => t.name.toLowerCase() === tagNameLower);

    if (existing) {
        if (!existing.deleted) {
            showAlert({ title: 'Aviso', message: 'Ya existe una etiqueta con ese nombre.' });
            return;
        }
        showConfirm({
            title: 'Restaurar etiqueta',
            message: 'Ya existe una etiqueta eliminada con ese nombre. ¿Deseas restaurarla?',
            confirmText: 'Restaurar',
            cancelText: 'Cancelar',
            danger: false,
            onConfirm: () => {
                existing.deleted = false;
                existing.name = tagName;
                saveTags();
                renderTags();
                tagNameInput.value = '';
                tagNameInput.focus();
            }
        });
        return;
    }

    const newTag = {
        id: Date.now().toString(),
        name: tagName,
        deleted: false
    };

    tags.push(newTag);
    saveTags();
    renderTags();

    tagNameInput.value = '';
    tagNameInput.focus();
}

// Soft-delete: marcar como eliminada sin quitar de bloques
function deleteTag(index) {
    showConfirm({
        title: 'Eliminar etiqueta',
        message: '¿Estás seguro de que quieres eliminar esta etiqueta?',
        warning: 'Seguirá apareciendo como "(Eliminado)" en los bloques que la usen.',
        confirmText: 'Eliminar',
        cancelText: 'Cancelar',
        danger: true,
        onConfirm: () => {
            tags[index].deleted = true;
            saveTags();
            renderTags();
        }
    });
}

// Restaurar etiqueta eliminada
function restoreTag(index) {
    tags[index].deleted = false;
    saveTags();
    renderTags();
}

// Quitar definitivamente una etiqueta eliminada (ya no aparecerá en la lista ni en bloques)
function removeTagPermanently(index) {
    showConfirm({
        title: 'Quitar etiqueta',
        message: '¿Quitar definitivamente esta etiqueta? Los bloques que la tengan asignada quedarán sin etiqueta.',
        confirmText: 'Quitar',
        cancelText: 'Cancelar',
        danger: true,
        onConfirm: () => {
            tags.splice(index, 1);
            saveTags();
            renderTags();
        }
    });
}

// ========== GESTIÓN DE PESTAÑAS ==========

function setupTabs() {
    const tabButtons = document.querySelectorAll('.settings-tab');
    const tabContents = document.querySelectorAll('.settings-tab-content');
    
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.dataset.tab;
            
            // Remover active de todos
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            // Agregar active al seleccionado
            button.classList.add('active');
            const targetContent = document.getElementById(`tab-${targetTab}`);
            if (targetContent) {
                targetContent.classList.add('active');
            }
            
            // Reinicializar iconos de Lucide
            if (typeof lucide !== 'undefined') {
                requestAnimationFrame(() => {
                    lucide.createIcons();
                });
            }
        });
    });
}

// Cargar personas y etiquetas al iniciar
window.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    setupTabs();
    loadPersons();
    loadTags();

    try {
        const version = await ipcRenderer.invoke('get-app-version');
        const verEl = document.getElementById('appVersionLabel');
        if (verEl) {
            verEl.textContent = `Versión ${version}`;
        }
    } catch (_) {
        const verEl = document.getElementById('appVersionLabel');
        if (verEl) verEl.textContent = '';
    }

    // Inicializar iconos de Lucide
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
});

// Función para obtener todas las personas (para uso externo)
function getAllPersons() {
    return persons;
}

// Función para obtener todas las etiquetas (para uso externo)
function getAllTags() {
    return tags;
}
