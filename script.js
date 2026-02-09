// =====================================================
// Anything Mini — Client Script
// Keywords: simplicity, small wins
// Unified items tree: branches = projects, leaves = actions
// =====================================================

const API = 'http://localhost:3002/api';

// ─── State ───
const state = {
    items: { items: [], nextId: 1 },

    timeline: { entries: [], nextId: 1 },
    selectedItemId: null, // selected node (project/branch) for filtering
    timelineViewDate: new Date(), // which day is displayed in timeline
    hidePastEntries: false, // toggle to hide past entries in today's timeline
    showDone: false, // when true, done items are visible in actions and project tree
    projectSearchQuery: '', // current search term for the project tree
    workingOn: null, // { itemId, itemName, projectName, startTime } — active work timer
    onBreak: null, // { startTime } — active break timer
    settings: {
        dayStartHour: 8,
        dayStartMinute: 0,
        dayEndHour: 22,
        dayEndMinute: 0,
        dayOverrides: {}, // { "2026-02-09": { dayStartHour, dayStartMinute, dayEndHour, dayEndMinute } }
    },
};

// ─── API Layer ───
const api = {
    async get(path) {
        const res = await fetch(`${API}${path}`);
        return res.json();
    },
    async post(path, body) {
        const res = await fetch(`${API}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return res.json();
    },
    async patch(path, body) {
        const res = await fetch(`${API}${path}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return res.json();
    },
    async put(path, body) {
        const res = await fetch(`${API}${path}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return res.json();
    },
    async del(path) {
        await fetch(`${API}${path}`, { method: 'DELETE' });
    },
};

// ─── Load Data ───
async function loadAll() {
    const [items, timeline] = await Promise.all([
        api.get('/items'),
        api.get('/timeline'),
    ]);
    state.items = items;
    state.timeline = timeline;
    // Load settings
    try {
        const s = await api.get('/settings');
        state.settings = { ...state.settings, ...s };
    } catch { /* use defaults */ }
    ensureInbox();
    // Restore selected project context from localStorage
    const savedSelectedId = localStorage.getItem('selectedItemId');
    if (savedSelectedId) {
        const id = parseInt(savedSelectedId, 10);
        if (findItemById(id)) {
            state.selectedItemId = id;
        }
    }
    // Restore timeline view date, or default to logical today
    const savedDate = localStorage.getItem('timelineViewDate');
    if (savedDate) {
        state.timelineViewDate = new Date(savedDate);
    } else {
        state.timelineViewDate = getLogicalToday();
    }
    // Restore working-on state from localStorage
    restoreWorkingOn();
    restoreBreak();
    renderAll();
    syncSettingsUI();
    // Render streak widget with loaded settings
    renderStreak();
}

// Ensure Inbox exists as the first node in the tree
function ensureInbox() {
    const hasInbox = state.items.items.some(item => item.isInbox);
    if (!hasInbox) {
        const inboxItem = {
            id: state.items.nextId++,
            name: 'Inbox',
            children: [],
            expanded: true,
            createdAt: Date.now(),
            done: false,
            isInbox: true,
        };
        state.items.items.unshift(inboxItem);
        saveItems();
    } else {
        // Make sure Inbox is always first
        const idx = state.items.items.findIndex(item => item.isInbox);
        if (idx > 0) {
            const [inbox] = state.items.items.splice(idx, 1);
            state.items.items.unshift(inbox);
        }
    }
}

function renderAll() {
    renderProjects();
    renderActions();

    renderTimeline();
    updateContextLabels();
}

// ─── Tree Utilities ───

// Find an item node by ID anywhere in the tree
function findItemById(id, items = state.items.items) {
    for (const item of items) {
        if (item.id === id) return item;
        if (item.children && item.children.length > 0) {
            const found = findItemById(id, item.children);
            if (found) return found;
        }
    }
    return null;
}

// Find item name by ID
function findItemName(id) {
    const item = findItemById(id);
    return item ? item.name : null;
}

// Check if a node is a leaf (no children)
function isLeaf(item) {
    return !item.children || item.children.length === 0;
}

// Collect all leaf nodes from the tree (these are "actions")
// Inbox is never a leaf — it's a structural node
function collectLeaves(items = state.items.items, parentPath = []) {
    const leaves = [];
    for (const item of items) {
        if (item.isInbox) {
            // Inbox is never an action; recurse into its children only
            if (item.children && item.children.length > 0) {
                const inboxPath = [...parentPath, { id: item.id, name: item.name }];
                leaves.push(...collectLeaves(item.children, inboxPath));
            }
            continue;
        }
        const currentPath = [...parentPath, { id: item.id, name: item.name }];
        if (isLeaf(item)) {
            leaves.push({ ...item, _path: currentPath });
        } else {
            leaves.push(...collectLeaves(item.children, currentPath));
        }
    }
    return leaves;
}

// Collect ALL items from the tree (leaf and non-leaf) for scheduling
// Every item can be started and worked on, not just leaves
function collectAllItems(items = state.items.items, parentPath = []) {
    const result = [];
    for (const item of items) {
        if (item.isInbox) {
            if (item.children && item.children.length > 0) {
                const inboxPath = [...parentPath, { id: item.id, name: item.name }];
                result.push(...collectAllItems(item.children, inboxPath));
            }
            continue;
        }
        const currentPath = [...parentPath, { id: item.id, name: item.name }];
        result.push({ ...item, _path: currentPath });
        if (item.children && item.children.length > 0) {
            result.push(...collectAllItems(item.children, currentPath));
        }
    }
    return result;
}

// Collect all descendant IDs (including self)
function collectDescendantIds(item) {
    const ids = [item.id];
    if (item.children) {
        for (const child of item.children) {
            ids.push(...collectDescendantIds(child));
        }
    }
    return ids;
}

// Check if an item has any non-leaf children (is a "project branch")
function hasBranchChildren(item) {
    return item.children && item.children.some(c => c.children && c.children.length > 0);
}

// Build breadcrumb path for an item to its ancestors
function getAncestorPath(targetId, items = state.items.items, path = []) {
    for (const item of items) {
        if (item.id === targetId) return path;
        if (item.children && item.children.length > 0) {
            const found = getAncestorPath(targetId, item.children, [...path, item]);
            if (found) return found;
        }
    }
    return null;
}

// ─── Time Context Utilities ───

// Get effective time contexts for an item by merging its own contexts with all ancestors'
function getEffectiveTimeContexts(itemId) {
    const contexts = new Set();
    // Collect own contexts
    const item = findItemById(itemId);
    if (item && item.timeContexts) {
        item.timeContexts.forEach(tc => contexts.add(tc));
    }
    // Collect ancestor contexts
    const ancestors = getAncestorPath(itemId);
    if (ancestors) {
        for (const ancestor of ancestors) {
            if (ancestor.timeContexts) {
                ancestor.timeContexts.forEach(tc => contexts.add(tc));
            }
        }
    }
    return contexts;
}

// Check if an item should appear for the given date key.
// Rules:
//   1. If the item or any ancestor has timeContexts including dateKey → show
//   2. If NO item in the ancestry chain has any timeContexts at all → show ("anytime")
//   3. If some level has timeContexts but none match dateKey → hide
function itemMatchesTimeContext(action, dateKey) {
    const item = findItemById(action.id);
    // Check own contexts
    const ownContexts = (item && item.timeContexts) || [];
    if (ownContexts.includes(dateKey)) return true;
    // Walk ancestors
    const ancestors = getAncestorPath(action.id);
    let anyAncestorHasContexts = ownContexts.length > 0;
    if (ancestors) {
        for (const ancestor of ancestors) {
            if (ancestor.timeContexts && ancestor.timeContexts.length > 0) {
                anyAncestorHasContexts = true;
                if (ancestor.timeContexts.includes(dateKey)) return true;
            }
        }
    }
    // No contexts at any level = "anytime" item → always show
    return !anyAncestorHasContexts;
}

// Toggle a date in an item's timeContexts
async function toggleTimeContext(itemId, dateKey) {
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.timeContexts) item.timeContexts = [];
    const idx = item.timeContexts.indexOf(dateKey);
    if (idx >= 0) {
        item.timeContexts.splice(idx, 1);
    } else {
        item.timeContexts.push(dateKey);
    }
    await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts });
    renderAll();
}

// Add a specific date to an item's timeContexts (no toggle)
async function addTimeContext(itemId, dateKey) {
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.timeContexts) item.timeContexts = [];
    if (!item.timeContexts.includes(dateKey)) {
        item.timeContexts.push(dateKey);
        await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts });
        renderAll();
    }
}

// ─── Drag & Drop State ───
const dragState = {
    draggedId: null,
    dropTarget: null, // { id, position: 'before'|'after'|'inside' }
};

// Find the parent array and index of an item by ID
function findParentArray(targetId, items = state.items.items, parentArr = null) {
    for (let i = 0; i < items.length; i++) {
        if (items[i].id === targetId) {
            return { array: items, index: i };
        }
        if (items[i].children && items[i].children.length > 0) {
            const found = findParentArray(targetId, items[i].children, items[i].children);
            if (found) return found;
        }
    }
    return null;
}

// Move an item in the tree
function moveItem(draggedId, dropTarget) {
    if (!dropTarget || draggedId === dropTarget.id) return false;

    // Don't allow dragging the Inbox itself
    const draggedItem = findItemById(draggedId);
    if (!draggedItem || draggedItem.isInbox) return false;

    // Don't allow dropping an item onto its own descendant
    const descendantIds = collectDescendantIds(draggedItem);
    if (descendantIds.includes(dropTarget.id)) return false;

    // Don't allow dropping before/after Inbox (it must stay first)
    const targetItem = findItemById(dropTarget.id);
    if (targetItem && targetItem.isInbox && dropTarget.position === 'before') return false;

    // Remove item from current location
    const source = findParentArray(draggedId);
    if (!source) return false;
    const [removed] = source.array.splice(source.index, 1);

    if (dropTarget.id === '_root') {
        // Drop into root level (at the end)
        state.items.items.push(removed);
    } else if (dropTarget.position === 'inside') {
        // Drop inside a node = add as last child
        const target = findItemById(dropTarget.id);
        if (!target) { source.array.splice(source.index, 0, removed); return false; }
        target.children = target.children || [];
        target.children.push(removed);
        target.expanded = true;
    } else {
        // Drop before/after a sibling
        const targetLoc = findParentArray(dropTarget.id);
        if (!targetLoc) { source.array.splice(source.index, 0, removed); return false; }
        const insertIdx = dropTarget.position === 'before' ? targetLoc.index : targetLoc.index + 1;
        targetLoc.array.splice(insertIdx, 0, removed);
    }

    // Ensure Inbox stays first after any move
    const inboxIdx = state.items.items.findIndex(item => item.isInbox);
    if (inboxIdx > 0) {
        const [inbox] = state.items.items.splice(inboxIdx, 1);
        state.items.items.unshift(inbox);
    }

    return true;
}

// ─── Inline Rename (shared by dblclick + context menu) ───
function startInlineRename(nameEl, item) {
    if (nameEl.querySelector('input')) return;
    const currentName = item.name;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-inline-input';
    input.value = currentName;
    input.style.cssText = '';
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commitRename = async () => {
        const val = input.value.trim();
        if (val && val !== currentName) {
            item.name = val;
            await saveItems();
        }
        nameEl.textContent = item.name;
    };

    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            commitRename();
        }
        if (ev.key === 'Escape') {
            ev.stopPropagation();
            nameEl.textContent = currentName;
        }
    });
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (nameEl.querySelector('input')) {
                commitRename();
            }
        }, 100);
    });
}

// ─── Project Context Menu ───
function dismissProjectContextMenu() {
    const existing = document.querySelector('.project-context-menu');
    if (existing) existing.remove();
    document.removeEventListener('click', dismissProjectContextMenu);
    document.removeEventListener('contextmenu', dismissProjectContextMenu);
}

function showProjectContextMenu(e, item) {
    e.preventDefault();
    e.stopPropagation();
    dismissProjectContextMenu();

    const menu = document.createElement('div');
    menu.className = 'project-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    // Rename option
    const renameOpt = document.createElement('div');
    renameOpt.className = 'project-context-menu-item';
    renameOpt.textContent = 'Rename';
    renameOpt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        // Find the name element for this item in the DOM
        const row = document.querySelector(`.project-item[data-id="${item.id}"]`);
        if (row) {
            const nameEl = row.querySelector('.project-name');
            if (nameEl) startInlineRename(nameEl, item);
        }
    });
    menu.appendChild(renameOpt);

    // Work option (Start / Stop Working)
    if (!item.done) {
        const isWorking = state.workingOn && state.workingOn.itemId === item.id;
        const workOpt = document.createElement('div');
        workOpt.className = 'project-context-menu-item';
        workOpt.textContent = isWorking ? 'Stop Working' : 'Start Working';
        workOpt.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            if (isWorking) {
                await stopWorking();
            } else {
                const ancestorPath = getAncestorPath(item.id);
                const ancestors = ancestorPath
                    ? ancestorPath.map(a => a.name).join(' › ')
                    : '';
                await startWorking(item.id, item.name, ancestors);
            }
        });
        menu.appendChild(workOpt);
    }

    // ── Time Context options for projects ──
    const projTodayKey = getDateKey(state.timelineViewDate);
    const hasProjectToday = item.timeContexts && item.timeContexts.includes(projTodayKey);
    const projIsToday = isCurrentDay(state.timelineViewDate);
    const projDateLabel = projIsToday ? 'today' : state.timelineViewDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const projTodayOpt = document.createElement('div');
    projTodayOpt.className = 'project-context-menu-item';
    projTodayOpt.textContent = hasProjectToday ? `Remove from ${projDateLabel}` : `Add to ${projDateLabel}`;
    projTodayOpt.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        await toggleTimeContext(item.id, projTodayKey);
    });
    menu.appendChild(projTodayOpt);

    const projSchedOpt = document.createElement('div');
    projSchedOpt.className = 'project-context-menu-item';
    projSchedOpt.textContent = 'Schedule for...';
    projSchedOpt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        openScheduleModal(item.id, item.name);
    });
    menu.appendChild(projSchedOpt);

    // Delete option
    const deleteOpt = document.createElement('div');
    deleteOpt.className = 'project-context-menu-item project-context-menu-item-danger';
    deleteOpt.textContent = 'Delete';
    deleteOpt.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        await api.del(`/items/${item.id}`);
        if (state.selectedItemId === item.id) {
            state.selectedItemId = null;
            localStorage.setItem('selectedItemId', '');
        }
        await reloadItems();
    });
    menu.appendChild(deleteOpt);

    document.body.appendChild(menu);

    // Clamp to viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 6}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 6}px`;
    }

    // Dismiss on next click/contextmenu anywhere
    requestAnimationFrame(() => {
        document.addEventListener('click', dismissProjectContextMenu);
        document.addEventListener('contextmenu', dismissProjectContextMenu);
    });
}

// ─── Action Context Menu ───
function showActionContextMenu(e, action) {
    e.preventDefault();
    e.stopPropagation();
    dismissProjectContextMenu();

    const menu = document.createElement('div');
    menu.className = 'project-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    // Rename option
    const renameOpt = document.createElement('div');
    renameOpt.className = 'project-context-menu-item';
    renameOpt.textContent = 'Rename';
    renameOpt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        const actionEl = document.querySelector(`.action-item[data-id="${action.id}"] .action-name`);
        if (actionEl) {
            startActionInlineRename(actionEl, action);
        }
    });
    menu.appendChild(renameOpt);

    // Done / Undo option
    const doneOpt = document.createElement('div');
    doneOpt.className = 'project-context-menu-item';
    doneOpt.textContent = action.done ? 'Undo' : 'Done';
    doneOpt.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        const newDone = !action.done;
        await api.patch(`/items/${action.id}`, { done: newDone });
        action.done = newDone;
        const originalItem = findItemById(action.id);
        if (originalItem) originalItem.done = newDone;
        if (newDone) {
            const ancestors = action._path
                ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                : '';
            await api.post('/timeline', {
                text: `Done: ${action.name}`,
                projectName: ancestors || null,
                type: 'completion'
            });
            state.timeline = await api.get('/timeline');
        }
        renderAll();
    });
    menu.appendChild(doneOpt);

    // Work option (only for non-done)
    if (!action.done) {
        const isWorking = state.workingOn && state.workingOn.itemId === action.id;
        const workOpt = document.createElement('div');
        workOpt.className = 'project-context-menu-item';
        workOpt.textContent = isWorking ? 'Stop Working' : 'Start Working';
        workOpt.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            if (isWorking) {
                await stopWorking();
            } else {
                const ancestors = action._path
                    ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';
                await startWorking(action.id, action.name, ancestors);
            }
        });
        menu.appendChild(workOpt);

        // Followup option
        const followupOpt = document.createElement('div');
        followupOpt.className = 'project-context-menu-item';
        followupOpt.textContent = 'Followup';
        followupOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            // Simulate clicking the followup button on this action
            const actionEl = document.querySelector(`.action-item[data-id="${action.id}"]`);
            if (actionEl) {
                const btn = actionEl.querySelector('.action-btn-followup');
                if (btn && !btn.disabled) btn.click();
            }
        });
        menu.appendChild(followupOpt);

        // ── Time Context options ──
        const todayKey = getDateKey(state.timelineViewDate);
        const actionItem = findItemById(action.id);
        const hasToday = actionItem && actionItem.timeContexts && actionItem.timeContexts.includes(todayKey);
        const viewIsToday = isCurrentDay(state.timelineViewDate);
        const dateLabel = viewIsToday ? 'today' : state.timelineViewDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        const todayOpt = document.createElement('div');
        todayOpt.className = 'project-context-menu-item';
        todayOpt.textContent = hasToday ? `Remove from ${dateLabel}` : `Add to ${dateLabel}`;
        todayOpt.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            await toggleTimeContext(action.id, todayKey);
        });
        menu.appendChild(todayOpt);

        // Schedule for specific date
        const schedOpt = document.createElement('div');
        schedOpt.className = 'project-context-menu-item';
        schedOpt.textContent = 'Schedule for...';
        schedOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            openScheduleModal(action.id, action.name);
        });
        menu.appendChild(schedOpt);
    }

    // Decline option (danger)
    const declineOpt = document.createElement('div');
    declineOpt.className = 'project-context-menu-item project-context-menu-item-danger';
    declineOpt.textContent = 'Decline';
    declineOpt.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        await api.del(`/items/${action.id}`);
        await reloadItems();
    });
    menu.appendChild(declineOpt);

    document.body.appendChild(menu);

    // Clamp to viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 6}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 6}px`;
    }

    requestAnimationFrame(() => {
        document.addEventListener('click', dismissProjectContextMenu);
        document.addEventListener('contextmenu', dismissProjectContextMenu);
    });
}

// Inline rename for actions — updates both the action copy and the original tree item
function startActionInlineRename(nameEl, action) {
    if (nameEl.querySelector('input')) return;
    const currentName = action.name;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-inline-input';
    input.value = currentName;
    input.style.cssText = '';
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commitRename = async () => {
        const val = input.value.trim();
        if (val && val !== currentName) {
            const originalItem = findItemById(action.id);
            if (originalItem) {
                originalItem.name = val;
                action.name = val;
                await saveItems();
            }
        }
        nameEl.textContent = action.name;
    };

    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            commitRename();
        }
        if (ev.key === 'Escape') {
            ev.stopPropagation();
            nameEl.textContent = currentName;
        }
    });
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (nameEl.querySelector('input')) {
                commitRename();
            }
        }, 100);
    });
}

// ─── Project Search Utilities ───

// Returns true if any item at this level (or descendant) matches the query.
// Populates `matchingIds` set with all items that should be visible.
function collectSearchMatches(items, query, matchingIds) {
    let anyMatch = false;
    for (const item of items) {
        const nameMatch = item.name.toLowerCase().includes(query);
        let childMatch = false;
        if (item.children && item.children.length > 0) {
            childMatch = collectSearchMatches(item.children, query, matchingIds);
        }
        if (nameMatch || childMatch) {
            matchingIds.add(item.id);
            anyMatch = true;
        }
        // Inbox is always visible
        if (item.isInbox) {
            matchingIds.add(item.id);
        }
    }
    return anyMatch;
}

// ─── Projects Rendering (full tree hierarchy) ───
function renderProjects() {
    const container = document.getElementById('project-tree');
    const empty = document.getElementById('projects-empty');

    // Clear everything except empty state
    container.querySelectorAll('.project-node').forEach(el => el.remove());
    container.querySelectorAll('.project-root-dropzone').forEach(el => el.remove());
    container.querySelectorAll('.insert-marker').forEach(el => el.remove());
    // Remove any lingering drop indicators
    container.querySelectorAll('.drop-indicator').forEach(el => el.remove());

    // Always hide empty state — Inbox is always visible
    empty.style.display = 'none';

    // Build search match set
    const query = state.projectSearchQuery.trim().toLowerCase();
    const matchingIds = new Set();
    if (query) {
        collectSearchMatches(state.items.items, query, matchingIds);
    }

    const fragment = document.createDocumentFragment();

    // Render all root-level items (Inbox is always first via ensureInbox)
    renderProjectLevel(state.items.items, fragment, 0, query, matchingIds);

    // Root drop zone — always visible to allow dragging items to root level
    if (!query) {
        const rootDropZone = document.createElement('div');
        rootDropZone.className = 'project-root-dropzone';
        rootDropZone.textContent = 'Drop here to move to root';
        rootDropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearDropIndicators();
            rootDropZone.classList.add('drop-target-active');
            dragState.dropTarget = { id: '_root', position: 'inside' };
        });
        rootDropZone.addEventListener('dragleave', () => {
            rootDropZone.classList.remove('drop-target-active');
        });
        rootDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            rootDropZone.classList.remove('drop-target-active');
            handleDrop();
        });
        fragment.appendChild(rootDropZone);
    }

    container.appendChild(fragment);

    // Update clear button visibility
    const clearBtn = document.getElementById('project-search-clear');
    if (clearBtn) {
        clearBtn.style.display = query ? '' : 'none';
    }
}

function clearDropIndicators() {
    document.querySelectorAll('.drop-target-inside').forEach(el => el.classList.remove('drop-target-inside'));
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

function handleDrop() {
    if (!dragState.draggedId || !dragState.dropTarget) return;
    const success = moveItem(dragState.draggedId, dragState.dropTarget);
    if (success) {
        saveItems();
        renderAll();
    }
    dragState.draggedId = null;
    dragState.dropTarget = null;
    clearDropIndicators();
}

function renderProjectLevel(items, parent, depth, query = '', matchingIds = new Set()) {
    const isSearching = !!query;
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const leaf = isLeaf(item);
        const isInbox = !!item.isInbox;

        // Skip done leaves entirely when not showing done (avoids orphaned insert markers)
        if (!state.showDone && leaf && !isInbox && item.done) continue;

        // Skip items that don't match search (and have no matching descendants)
        if (isSearching && !matchingIds.has(item.id)) continue;

        // ─── Insert marker BEFORE this item (skip before Inbox, skip during search) ───
        if (!isInbox && !isSearching) {
            parent.appendChild(createInsertMarker(items, idx, depth));
        }

        const node = document.createElement('div');
        node.className = 'project-node';
        node.dataset.itemId = item.id;

        const row = document.createElement('div');
        row.className = 'project-item'
            + (isInbox ? ' project-inbox' : '')
            + (leaf && !isInbox ? ' project-leaf' : '')
            + (state.selectedItemId === item.id ? ' selected' : '');
        row.style.paddingLeft = `${10 + depth * 18}px`;
        row.dataset.id = item.id;

        // ─── Drag source (Inbox is not draggable, disable during search) ───
        if (!isInbox && !isSearching) {
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                dragState.draggedId = item.id;
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('dragging');
                document.getElementById('project-tree').classList.add('dragging-active');
                requestAnimationFrame(() => row.classList.add('dragging'));
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('dragging');
                document.getElementById('project-tree').classList.remove('dragging-active');
                dragState.draggedId = null;
                dragState.dropTarget = null;
                clearDropIndicators();
            });
        }

        // ─── Drop target ───
        if (!isSearching) {
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragState.draggedId === item.id) return;

                const rect = row.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const height = rect.height;
                const zone = y / height;

                clearDropIndicators();

                // Inbox only accepts 'inside' and 'after' drops, never 'before'
                if (zone < 0.25 && !isInbox) {
                    // Drop before
                    const indicator = document.createElement('div');
                    indicator.className = 'drop-indicator drop-indicator-before';
                    indicator.style.marginLeft = row.style.paddingLeft;
                    node.insertBefore(indicator, row);
                    dragState.dropTarget = { id: item.id, position: 'before' };
                } else if (zone > 0.75 && !isInbox) {
                    // Drop after
                    const indicator = document.createElement('div');
                    indicator.className = 'drop-indicator drop-indicator-after';
                    indicator.style.marginLeft = row.style.paddingLeft;
                    row.after(indicator);
                    dragState.dropTarget = { id: item.id, position: 'after' };
                } else {
                    // Drop inside
                    row.classList.add('drop-target-inside');
                    dragState.dropTarget = { id: item.id, position: 'inside' };
                }
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('drop-target-inside');
            });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                row.classList.remove('drop-target-inside');
                handleDrop();
            });
        }

        // Toggle arrow
        const hasChildren = item.children && item.children.length > 0;
        const toggle = document.createElement('button');
        toggle.className = 'project-toggle' + (hasChildren ? (item.expanded ? ' expanded' : '') : ' leaf');
        toggle.textContent = '▶';
        if (hasChildren) {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                item.expanded = !item.expanded;
                saveItems();
                renderProjects();
            });
        }

        // Inbox icon
        if (isInbox) {
            const icon = document.createElement('span');
            icon.className = 'project-inbox-icon';
            icon.textContent = '📥';
            row.appendChild(icon);
        }

        row.appendChild(toggle);

        // Name (with search highlighting)
        const name = document.createElement('span');
        name.className = 'project-name';
        if (leaf && !isInbox && item.done) name.classList.add('project-leaf-done');

        if (isSearching && item.name.toLowerCase().includes(query)) {
            // Highlight matching portion
            const lowerName = item.name.toLowerCase();
            const matchStart = lowerName.indexOf(query);
            const before = item.name.substring(0, matchStart);
            const match = item.name.substring(matchStart, matchStart + query.length);
            const after = item.name.substring(matchStart + query.length);
            name.innerHTML = '';
            if (before) name.appendChild(document.createTextNode(before));
            const mark = document.createElement('mark');
            mark.className = 'project-search-highlight';
            mark.textContent = match;
            name.appendChild(mark);
            if (after) name.appendChild(document.createTextNode(after));
        } else {
            name.textContent = item.name;
        }
        row.appendChild(name);

        // Double-click to rename (not on Inbox)
        if (!isInbox) {
            name.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                startInlineRename(name, item);
            });
        }

        // Right-click context menu (not on Inbox)
        if (!isInbox) {
            row.addEventListener('contextmenu', (e) => {
                showProjectContextMenu(e, item);
            });
        }

        // Count badge for branches (items with children)
        if (hasChildren || isInbox) {
            const leafCount = collectLeaves([item]).length;
            const doneCount = collectLeaves([item]).filter(l => l.done).length;
            const undone = leafCount - doneCount;
            const badge = document.createElement('span');
            badge.className = 'project-count';
            badge.textContent = `${undone}`;
            if (undone === 0) badge.classList.add('project-count-zero');
            row.appendChild(badge);
        }

        // Actions (add child, delete) — Inbox has no delete
        const actions = document.createElement('div');
        actions.className = 'project-actions';

        const addBtn = document.createElement('button');
        addBtn.className = 'project-action-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add child';
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showItemInput(item.id, depth + 1);
        });
        actions.appendChild(addBtn);

        if (!isInbox) {
            const delBtn = document.createElement('button');
            delBtn.className = 'project-action-btn';
            delBtn.textContent = '×';
            delBtn.title = 'Delete';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await api.del(`/items/${item.id}`);
                if (state.selectedItemId === item.id) {
                    state.selectedItemId = null;
                    localStorage.setItem('selectedItemId', '');
                }
                await reloadItems();
            });
            actions.appendChild(delBtn);
        }

        row.appendChild(actions);

        // Click selects item (as project filter)
        // Skip if a rename input is active to avoid toggling during editing
        row.addEventListener('click', (e) => {
            if (row.querySelector('.rename-inline-input')) return;
            state.selectedItemId = state.selectedItemId === item.id ? null : item.id;
            localStorage.setItem('selectedItemId', state.selectedItemId || '');
            renderAll();
        });

        node.appendChild(row);

        // Children — auto-expand during search if descendants match
        const shouldShowChildren = isSearching
            ? hasChildren  // always show children during search (the filter will hide non-matches)
            : item.expanded && hasChildren;

        if (shouldShowChildren) {
            const childContainer = document.createElement('div');
            childContainer.className = 'project-children';
            renderProjectLevel(item.children, childContainer, depth + 1, query, matchingIds);
            node.appendChild(childContainer);
        }

        parent.appendChild(node);
    }

    // ─── Insert marker AFTER the last item (skip during search) ───
    if (!isSearching) {
        const hasNonInbox = items.some(i => !i.isInbox);
        if (items.length > 0 && (depth > 0 || hasNonInbox)) {
            parent.appendChild(createInsertMarker(items, items.length, depth));
        }
    }
}

// ─── Insert Marker Factory ───
// Creates a hover-to-reveal "+" line between project items.
// `targetArray` is the sibling array, `insertIndex` is where the new item goes.
function createInsertMarker(targetArray, insertIndex, depth) {
    const marker = document.createElement('div');
    marker.className = 'insert-marker';
    marker.style.paddingLeft = `${10 + depth * 18}px`;

    const line = document.createElement('div');
    line.className = 'insert-marker-line';

    const plus = document.createElement('span');
    plus.className = 'insert-marker-plus';
    plus.textContent = '+';
    line.appendChild(plus);

    marker.appendChild(line);

    marker.addEventListener('click', (e) => {
        e.stopPropagation();
        showInsertInput(marker, targetArray, insertIndex);
    });

    return marker;
}

// Show an inline input inside an insert marker
function showInsertInput(markerEl, targetArray, insertIndex) {
    // Remove any other open insert inputs
    document.querySelectorAll('.insert-marker.active').forEach(el => {
        if (el !== markerEl) {
            el.classList.remove('active');
            const inp = el.querySelector('.insert-marker-input');
            if (inp) inp.remove();
        }
    });

    // If already active, do nothing
    if (markerEl.classList.contains('active')) return;

    markerEl.classList.add('active');

    const input = document.createElement('input');
    input.className = 'insert-marker-input';
    input.type = 'text';
    input.placeholder = 'New item...';
    markerEl.appendChild(input);
    input.focus();

    const commit = async () => {
        const name = input.value.trim();
        if (!name) {
            cleanup();
            return;
        }
        // Create new item locally and insert at position
        const newItem = {
            id: state.items.nextId++,
            name,
            children: [],
            expanded: false,
            createdAt: Date.now(),
            done: false,
        };
        targetArray.splice(insertIndex, 0, newItem);
        await saveItems();
        renderAll();
    };

    const cleanup = () => {
        markerEl.classList.remove('active');
        input.remove();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        }
        if (e.key === 'Escape') {
            cleanup();
        }
    });

    input.addEventListener('blur', () => {
        // Small delay so click events on the input can still fire
        setTimeout(cleanup, 150);
    });
}

async function saveItems() {
    await api.put('/items', { ...state.items }); // bulk save
}

async function reloadItems() {
    state.items = await api.get('/items');
    renderAll();
}

function showItemInput(parentId = null, childDepth = 0) {
    // Check if input already exists
    const existing = document.querySelector('.project-input-row');
    if (existing) existing.remove();

    let container;

    if (parentId) {
        const parentRow = document.querySelector(`[data-id="${parentId}"]`);
        if (!parentRow) return;
        const parentNode = parentRow.parentElement; // .project-node

        // Auto-expand the parent so the children container is visible
        const parentItem = findItemById(parentId);
        if (parentItem && !parentItem.expanded) {
            parentItem.expanded = true;
            saveItems();
            renderProjects();
            // Re-run after render to find the freshly created DOM
            return showItemInput(parentId, childDepth);
        }

        // Find or create the .project-children container
        let childContainer = parentNode.querySelector(':scope > .project-children');
        if (!childContainer) {
            childContainer = document.createElement('div');
            childContainer.className = 'project-children';
            parentNode.appendChild(childContainer);
        }
        container = childContainer;
    } else {
        container = document.getElementById('project-tree');
    }

    if (!container) return;

    const row = document.createElement('div');
    row.className = 'project-input-row animate-in';
    row.style.paddingLeft = `${10 + childDepth * 18}px`;

    const input = document.createElement('input');
    input.className = 'project-input';
    input.placeholder = parentId ? 'New item...' : 'New item...';
    input.type = 'text';

    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
            await api.post('/items', {
                name: input.value.trim(),
                parentId: parentId
            });
            await reloadItems();
        }
        if (e.key === 'Escape') {
            row.remove();
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(() => row.remove(), 200);
    });

    row.appendChild(input);
    container.prepend(row);
    input.focus();
}

// ─── Actions Rendering (leaf nodes from the tree) ───
function renderActions() {
    const container = document.getElementById('actions-list');
    const empty = document.getElementById('actions-empty');

    // Remove existing items but not the empty state
    container.querySelectorAll('.action-item').forEach(el => el.remove());

    const filteredActions = getFilteredActions();

    if (filteredActions.length === 0) {
        empty.style.display = '';
        return;
    }
    empty.style.display = 'none';

    // Sort: undone first, then preserve tree-traversal order (from collectLeaves)
    const indexed = filteredActions.map((a, i) => ({ ...a, _treeIdx: i }));
    const sorted = indexed.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return a._treeIdx - b._treeIdx;
    });

    const fragment = document.createDocumentFragment();
    for (const action of sorted) {
        fragment.appendChild(createActionElement(action));
    }
    container.appendChild(fragment);
}

function getFilteredActions() {
    let allLeaves = collectLeaves();

    // Filter out done items unless showDone is on
    if (!state.showDone) {
        allLeaves = allLeaves.filter(a => !a.done);
    }

    // ── Time context filter: show items matching the current timeline date ──
    const currentDateKey = getDateKey(state.timelineViewDate);
    allLeaves = allLeaves.filter(a => itemMatchesTimeContext(a, currentDateKey));

    if (!state.selectedItemId) return allLeaves;

    // Get all descendant IDs of the selected project (works for Inbox too)
    const selectedItem = findItemById(state.selectedItemId);
    if (!selectedItem) return allLeaves;

    // A leaf node has no children — it IS an action, not a project.
    // Show empty actions when focused on a leaf.
    if (isLeaf(selectedItem)) return [];

    const descendantIds = collectDescendantIds(selectedItem);

    return allLeaves.filter(leaf => descendantIds.includes(leaf.id));
}

function createActionElement(action) {
    const item = document.createElement('div');
    item.className = 'action-item' + (action.done ? ' done' : '');
    item.dataset.id = action.id;

    // ── Drag-to-schedule: make non-done actions draggable ──
    if (!action.done) {
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-action-id', action.id);
            e.dataTransfer.effectAllowed = 'copy';
            item.classList.add('action-item-dragging');
            // Store action data for the drop handler
            window._draggedAction = action;
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('action-item-dragging');
            window._draggedAction = null;
            // Clean up any lingering drag-over states
            document.querySelectorAll('.time-block-drag-over').forEach(el => el.classList.remove('time-block-drag-over'));
        });
    }

    // Right-click context menu
    item.addEventListener('contextmenu', (e) => {
        showActionContextMenu(e, action);
    });

    const content = document.createElement('div');
    content.className = 'action-content';

    const name = document.createElement('div');
    name.className = 'action-name';
    name.textContent = action.name;
    content.appendChild(name);

    // Click to rename
    if (!action.done) {
        name.addEventListener('click', (e) => {
            e.stopPropagation();
            startActionInlineRename(name, action);
        });
    }

    // Show ancestor path as breadcrumb tag (if not filtering by a project)
    if (!state.selectedItemId && action._path && action._path.length > 1) {
        const ancestorNames = action._path.slice(0, -1).map(p => p.name).join(' › ');
        const tag = document.createElement('span');
        tag.className = 'action-project-tag';
        tag.textContent = ancestorNames;
        content.appendChild(tag);
    }

    // Show time context badges
    const originalItem = findItemById(action.id);
    if (originalItem && originalItem.timeContexts && originalItem.timeContexts.length > 0) {
        const tagsWrap = document.createElement('div');
        tagsWrap.className = 'action-time-tags';
        for (const dateStr of originalItem.timeContexts) {
            const dtag = document.createElement('span');
            dtag.className = 'action-time-tag';
            // Show short date: "Feb 9" or "Mon"
            const d = new Date(dateStr + 'T00:00:00');
            const today = getDateKey(state.timelineViewDate);
            if (dateStr === today) {
                dtag.textContent = 'Today';
                dtag.classList.add('action-time-tag-today');
            } else {
                dtag.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }
            tagsWrap.appendChild(dtag);
        }
        content.appendChild(tagsWrap);
    }

    // Action buttons container
    const buttons = document.createElement('div');
    buttons.className = 'action-buttons';

    // Done button (toggle)
    const doneBtn = document.createElement('button');
    doneBtn.className = 'action-btn action-btn-done';
    doneBtn.textContent = action.done ? 'Undo' : 'Done';
    doneBtn.title = action.done ? 'Mark as not done' : 'Mark as done';
    if (action.done) doneBtn.classList.add('action-btn-undone');
    doneBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newDone = !action.done;
        await api.patch(`/items/${action.id}`, { done: newDone });
        action.done = newDone;
        // Also update the original item in state.items (action is a spread-copy from collectLeaves)
        const originalItem = findItemById(action.id);
        if (originalItem) originalItem.done = newDone;

        if (newDone) {
            // Log to timeline when marking done
            const ancestors = action._path
                ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                : '';
            await api.post('/timeline', {
                text: `Done: ${action.name}`,
                projectName: ancestors || null,
                type: 'completion'
            });
            state.timeline = await api.get('/timeline');
        }
        renderAll();
    });

    // Decline button
    const declineBtn = document.createElement('button');
    declineBtn.className = 'action-btn action-btn-decline';
    declineBtn.textContent = 'Decline';
    declineBtn.title = 'Decline this action';
    declineBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.del(`/items/${action.id}`);
        await reloadItems();
    });

    // Add sub-child button
    const breakdownBtn = document.createElement('button');
    breakdownBtn.className = 'action-btn action-btn-breakdown';
    breakdownBtn.textContent = '+';
    breakdownBtn.title = 'Add sub-task';
    if (!action.done) {
        breakdownBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Add a child under this action, turning it into a project
            await api.post('/items', {
                name: 'New sub-task',
                parentId: action.id,
            });
            await reloadItems();
        });
    } else {
        breakdownBtn.disabled = true;
    }

    // Followup button — marks as done, then creates a new sibling right after it
    const followupBtn = document.createElement('button');
    followupBtn.className = 'action-btn action-btn-followup';
    followupBtn.textContent = 'Followup';
    followupBtn.title = 'Mark done & create follow-up';
    if (!action.done) {
        followupBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // 1. Mark as done
            await api.patch(`/items/${action.id}`, { done: true });
            action.done = true;
            const originalItem = findItemById(action.id);
            if (originalItem) originalItem.done = true;

            // 2. Log to timeline
            const ancestors = action._path
                ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                : '';
            await api.post('/timeline', {
                text: `Done: ${action.name}`,
                projectName: ancestors || null,
                type: 'completion'
            });
            state.timeline = await api.get('/timeline');

            // 3. Create a new sibling item immediately after this one in the tree
            const location = findParentArray(action.id);
            if (location) {
                const newItem = {
                    id: state.items.nextId++,
                    name: '',
                    children: [],
                    expanded: false,
                    createdAt: Date.now(),
                    done: false,
                };
                location.array.splice(location.index + 1, 0, newItem);
                await saveItems();
                renderAll();

                // Focus the new item's name for inline editing in the actions list
                // Small delay to let the DOM render
                setTimeout(() => {
                    const newActionEl = document.querySelector(`.action-item[data-id="${newItem.id}"] .action-name`);
                    if (newActionEl) {
                        // Turn the name into an editable input
                        const input = document.createElement('input');
                        input.type = 'text';
                        input.className = 'followup-inline-input';
                        input.placeholder = 'Follow-up task...';
                        input.style.cssText = 'width:100%;border:none;background:transparent;font:inherit;color:inherit;outline:none;padding:0;';
                        newActionEl.textContent = '';
                        newActionEl.appendChild(input);
                        input.focus();

                        const commitFollowup = async () => {
                            const val = input.value.trim();
                            const itemInTree = findItemById(newItem.id);
                            if (val && itemInTree) {
                                itemInTree.name = val;
                                await saveItems();
                                renderAll();
                            } else if (!val && itemInTree) {
                                // Remove the empty item if user didn't type anything
                                const loc = findParentArray(newItem.id);
                                if (loc) {
                                    loc.array.splice(loc.index, 1);
                                    await saveItems();
                                    renderAll();
                                }
                            }
                        };

                        input.addEventListener('keydown', (ev) => {
                            if (ev.key === 'Enter') {
                                ev.preventDefault();
                                commitFollowup();
                            }
                            if (ev.key === 'Escape') {
                                // Remove the empty item
                                const loc = findParentArray(newItem.id);
                                if (loc) {
                                    loc.array.splice(loc.index, 1);
                                    saveItems();
                                    renderAll();
                                }
                            }
                        });
                        input.addEventListener('blur', () => {
                            setTimeout(commitFollowup, 150);
                        });
                    }
                }, 50);
            } else {
                renderAll();
            }
        });
    } else {
        followupBtn.disabled = true;
    }

    // Work timer button
    const workBtn = document.createElement('button');
    workBtn.className = 'action-btn action-btn-work';
    const isWorking = state.workingOn && state.workingOn.itemId === action.id;
    workBtn.textContent = isWorking ? '⏹' : '▶';
    workBtn.title = isWorking ? 'Stop working' : 'Start working';
    if (isWorking) workBtn.classList.add('action-btn-working');
    if (!action.done) {
        workBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (state.workingOn && state.workingOn.itemId === action.id) {
                await stopWorking();
            } else {
                const ancestors = action._path
                    ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';
                await startWorking(action.id, action.name, ancestors);
            }
        });
    } else {
        workBtn.disabled = true;
    }

    buttons.appendChild(workBtn);
    buttons.appendChild(doneBtn);
    buttons.appendChild(followupBtn);
    buttons.appendChild(declineBtn);
    buttons.appendChild(breakdownBtn);

    item.appendChild(content);
    item.appendChild(buttons);

    return item;
}

function setupActionInput() {
    const input = document.getElementById('action-input');
    if (!input) return;

    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
            // Add as child of selected project, or under Inbox by default
            const inbox = state.items.items.find(i => i.isInbox);
            const parentId = state.selectedItemId || (inbox ? inbox.id : null);
            await api.post('/items', {
                name: input.value.trim(),
                parentId,
            });
            await reloadItems();
            input.value = '';
        }
    });
}



// ─── Timeline Rendering (Time Blocks Architecture) ───
// The timeline is a list of "time blocks" — conceptual time containers.
// Day Start and Day End are special sentinel blocks that frame the day.
// Supports cross-date days (e.g. day end at 02:00 means next calendar day).
// Per-day overrides take precedence over global defaults.

function getDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getEffectiveDayTimes(viewDate) {
    const key = getDateKey(viewDate);
    const override = state.settings.dayOverrides?.[key];
    if (override) return override;
    return {
        dayStartHour: state.settings.dayStartHour,
        dayStartMinute: state.settings.dayStartMinute,
        dayEndHour: state.settings.dayEndHour,
        dayEndMinute: state.settings.dayEndMinute,
    };
}

function getDayBoundaries(dateOverride) {
    const now = new Date();
    const viewDate = dateOverride || now;
    const { dayStartHour, dayStartMinute, dayEndHour, dayEndMinute } = getEffectiveDayTimes(viewDate);

    const dayStart = new Date(viewDate);
    dayStart.setHours(dayStartHour, dayStartMinute, 0, 0);

    const dayEnd = new Date(viewDate);
    dayEnd.setHours(dayEndHour, dayEndMinute, 0, 0);

    // Cross-date: if end time <= start time, end is the next calendar day
    if (dayEnd <= dayStart) {
        dayEnd.setDate(dayEnd.getDate() + 1);
    }

    return { now, dayStart, dayEnd, viewDate };
}

// Check if "now" falls within the day range for the given viewDate.
// This handles cross-date days correctly (e.g. 08:00 today → 02:00 tomorrow).
function isCurrentDay(viewDate) {
    const { dayStart, dayEnd, now } = getDayBoundaries(viewDate);
    return now >= dayStart && now < dayEnd;
}

// Determine which logical "day" the current moment belongs to.
// If the day boundary crosses midnight (e.g. 08:00→02:00) and now is
// between midnight and the end time, the logical day is yesterday.
function getLogicalToday() {
    const now = new Date();
    // First check: does "now" fall within today's day range?
    if (isCurrentDay(now)) return now;
    // Second check: does "now" fall within yesterday's day range?
    // (handles cross-midnight days, e.g. it's 01:00 and day ends at 02:00)
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (isCurrentDay(yesterday)) return yesterday;
    // Fallback: use current calendar date
    return now;
}

function renderTimeline() {
    const container = document.getElementById('timeline-list');
    const empty = document.getElementById('timeline-empty');

    // Clear all rendered blocks
    container.querySelectorAll('.time-block, .timeline-entry').forEach(el => el.remove());

    // Always hide empty — we always show at least Day Start/End
    empty.style.display = 'none';

    const { now, dayStart, dayEnd, viewDate } = getDayBoundaries(state.timelineViewDate);

    const dayEndMs = dayEnd.getTime();
    const nowMs = now.getTime();
    const viewingToday = isCurrentDay(state.timelineViewDate);

    // Collect entries within the day range (dayStart → dayEnd)
    // This correctly handles cross-date days
    const allDayEntries = state.timeline.entries
        .filter(e => e.timestamp >= dayStart.getTime() && e.timestamp < dayEnd.getTime())
        .sort((a, b) => a.timestamp - b.timestamp); // chronological

    // ── Separate block entries (anchors) from moment entries (non-anchors) ──
    // Block entries have a time span (work, break, planned) and define the timeline structure.
    // Moment entries (completion, manual logs) happen at a point in time and render
    // indented under the block during which they occurred.
    const isBlockEntry = (e) => e.endTime && (e.type === 'work' || e.type === 'break' || e.type === 'planned');
    const allBlockEntries = allDayEntries.filter(isBlockEntry);
    const allMomentEntries = allDayEntries.filter(e => !isBlockEntry(e));

    // When "hide past entries" is on and viewing today, remove entries before now
    const hidePast = state.hidePastEntries && viewingToday;
    const dayBlockEntries = hidePast
        ? allBlockEntries.filter(e => (e.endTime || e.timestamp) >= nowMs)
        : allBlockEntries;
    const dayMomentEntries = hidePast
        ? allMomentEntries.filter(e => e.timestamp >= nowMs)
        : allMomentEntries;

    const fragment = document.createDocumentFragment();

    // ── Day Start block (hidden when hiding past entries) ──
    if (!hidePast) {
        fragment.appendChild(createDayBoundaryBlock('day-start', dayStart, now));
    }

    // ── Build interleaved block entries + free time blocks ──
    // Track cursor through the day to find gaps — only block entries advance the cursor
    let cursor = hidePast ? nowMs : dayStart.getTime();

    // Find the last BLOCK entry that starts at or before "now", tracking its effective end time
    // Use allBlockEntries so we find the anchor even when past entries are hidden
    let lastBlockBeforeNow = null;
    let lastBlockEndBeforeNow = null;
    for (const entry of allBlockEntries) {
        if (entry.timestamp <= nowMs) {
            lastBlockBeforeNow = entry.timestamp;
            lastBlockEndBeforeNow = entry.endTime;
        }
    }

    // Helper: append any moment entries that fall within a time range [rangeStart, rangeEnd)
    const appendMomentsBetween = (frag, rangeStart, rangeEnd) => {
        const moments = dayMomentEntries.filter(m => m.timestamp >= rangeStart && m.timestamp < rangeEnd);
        for (const m of moments) {
            frag.appendChild(createMomentEntry(m));
        }
    };

    // ── When hiding past entries, inject idle/working block before the entry loop ──
    // The idle/working block represents the CURRENT state and should always be visible
    if (hidePast && viewingToday && nowMs > dayStart.getTime() && nowMs < dayEndMs) {
        const idleStart = lastBlockEndBeforeNow || dayStart.getTime();
        const firstFutureBlock = dayBlockEntries[0];
        const idleEnd = firstFutureBlock ? Math.min(nowMs, firstFutureBlock.timestamp) : nowMs;
        if (idleEnd > idleStart) {
            if (state.workingOn) {
                fragment.appendChild(createWorkingTimeBlock(state.workingOn.startTime, idleEnd));
            } else if (state.onBreak) {
                fragment.appendChild(createBreakTimeBlock(state.onBreak.startTime, idleEnd));
            } else {
                fragment.appendChild(createIdleTimeBlock(idleStart, idleEnd));
            }
            cursor = Math.max(cursor, idleEnd);
        }
    }

    // ── If no block entries before now and viewing today, idle/working from day start to now ──
    if (!hidePast && viewingToday && !lastBlockBeforeNow && nowMs > dayStart.getTime() && nowMs < dayEndMs) {
        const firstBlock = dayBlockEntries[0];
        const idleEnd = firstBlock ? Math.min(nowMs, firstBlock.timestamp) : Math.min(nowMs, dayEndMs);
        if (idleEnd > dayStart.getTime()) {
            if (state.workingOn) {
                fragment.appendChild(createWorkingTimeBlock(state.workingOn.startTime, idleEnd));
            } else if (state.onBreak) {
                fragment.appendChild(createBreakTimeBlock(state.onBreak.startTime, idleEnd));
            } else {
                fragment.appendChild(createIdleTimeBlock(dayStart.getTime(), idleEnd));
            }
            cursor = Math.max(cursor, idleEnd);
        }
        // Append any moment entries in the idle gap
        appendMomentsBetween(fragment, dayStart.getTime(), idleEnd);
    }

    for (let i = 0; i < dayBlockEntries.length; i++) {
        const entry = dayBlockEntries[i];
        const entryTime = entry.timestamp;
        const entryEnd = entry.endTime;

        // Insert free time block for any gap before this block entry
        if (entryTime > cursor) {
            const gapEnd = Math.min(entryTime, dayEndMs);
            const gapMs = gapEnd - cursor;
            if (gapMs >= 60000) { // Only show gaps ≥ 1 minute
                fragment.appendChild(createFreeTimeBlock(cursor, gapEnd));
            }
            // Append moment entries in the gap
            appendMomentsBetween(fragment, cursor, entryTime);
        }

        fragment.appendChild(createTimelineElement(entry));
        // Append moment entries that occurred during this block
        appendMomentsBetween(fragment, entryTime, entryEnd);
        cursor = Math.max(cursor, entryEnd);

        // ── Idle/Working block: inject right after the last block entry before "now" ──
        if (!hidePast && viewingToday && entryTime === lastBlockBeforeNow && nowMs > entryEnd) {
            // Gap from this block's END to now becomes the idle or working block
            // But only if the next block (if any) is after now, otherwise it's just free time
            const nextBlock = dayBlockEntries[i + 1];
            const idleEnd = nextBlock ? Math.min(nowMs, nextBlock.timestamp) : nowMs;
            if (idleEnd > entryEnd) {
                if (state.workingOn) {
                    fragment.appendChild(createWorkingTimeBlock(state.workingOn.startTime, idleEnd));
                } else if (state.onBreak) {
                    fragment.appendChild(createBreakTimeBlock(state.onBreak.startTime, idleEnd));
                } else {
                    fragment.appendChild(createIdleTimeBlock(entryEnd, idleEnd));
                }
                // Append moment entries in the idle gap
                appendMomentsBetween(fragment, entryEnd, idleEnd);
                cursor = Math.max(cursor, idleEnd);
            }
        }
    }

    // ── Trailing free time: from cursor to day end ──
    if (dayEndMs > cursor) {
        const gapMs = dayEndMs - cursor;
        if (gapMs >= 60000) {
            fragment.appendChild(createFreeTimeBlock(cursor, dayEndMs));
        }
        // Append any trailing moment entries
        appendMomentsBetween(fragment, cursor, dayEndMs);
    }

    // ── Day End block ──
    fragment.appendChild(createDayBoundaryBlock('day-end', dayEnd, now));

    container.appendChild(fragment);

    // Update date nav display
    updateDateNav();
}

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function createFreeTimeBlock(startMs, endMs) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-free';
    el.dataset.startTime = startMs;
    el.dataset.endTime = endMs;

    const durationMs = endMs - startMs;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '✨';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    label.textContent = 'Free Time';

    const time = document.createElement('div');
    time.className = 'time-block-time';
    time.textContent = `${formatTime(startMs)} – ${formatTime(endMs)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status';
    status.textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    content.appendChild(label);
    content.appendChild(time);
    content.appendChild(status);

    el.appendChild(icon);
    el.appendChild(content);

    // Plan Next button
    const planBtn = document.createElement('button');
    planBtn.className = 'plan-next-btn';
    planBtn.textContent = '+';
    planBtn.title = 'Plan an action here';
    planBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPlanEditor(el, startMs, endMs);
    });
    el.appendChild(planBtn);

    // ── Drop target for drag-to-schedule ──
    el.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-action-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        el.classList.add('time-block-drag-over');
    });
    el.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer.types.includes('application/x-action-id')) return;
        e.preventDefault();
        el.classList.add('time-block-drag-over');
    });
    el.addEventListener('dragleave', (e) => {
        // Only remove if we're leaving the block itself, not entering a child
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        el.classList.remove('time-block-drag-over');
    });
    el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('time-block-drag-over');
        const action = window._draggedAction;
        if (!action) return;
        window._draggedAction = null;
        openPlanEditor(el, startMs, endMs, action);
    });

    return el;
}

// ── Plan Next: inline editor ──

function openPlanEditor(freeBlock, freeStartMs, freeEndMs, preselectedAction = null) {
    // Close any existing editor
    document.querySelectorAll('.plan-editor').forEach(ed => ed.remove());

    const DEFAULT_DURATION = 30 * 60 * 1000;
    const availableMs = freeEndMs - freeStartMs;
    let planStartMs = freeStartMs;
    let planEndMs = freeStartMs + Math.min(DEFAULT_DURATION, availableMs);
    let selectedAction = preselectedAction || null;

    // Helper: ms timestamp → "HH:MM" string
    const msToTimeStr = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    // Helper: "HH:MM" string → ms timestamp (same day as planStartMs)
    const timeStrToMs = (str) => {
        const [h, m] = str.split(':').map(Number);
        const d = new Date(planStartMs);
        d.setHours(h, m, 0, 0);
        return d.getTime();
    };

    // Helper: update duration display
    const updateDuration = () => {
        const durMs = planEndMs - planStartMs;
        const totalMins = Math.round(durMs / 60000);
        durationInput.value = totalMins;
    };

    // ── Build editor DOM ──
    const editor = document.createElement('div');
    editor.className = 'time-block plan-editor';

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '📌';

    // Content area
    const content = document.createElement('div');
    content.className = 'plan-editor-content';

    // Row 1: Action autocomplete
    const actionRow = document.createElement('div');
    actionRow.className = 'plan-editor-row';

    const actionInputWrap = document.createElement('div');
    actionInputWrap.className = 'plan-editor-autocomplete';

    const actionInput = document.createElement('input');
    actionInput.type = 'text';
    actionInput.className = 'plan-editor-input';
    actionInput.placeholder = 'Search for an action…';

    const suggestions = document.createElement('div');
    suggestions.className = 'plan-editor-suggestions';

    actionInputWrap.appendChild(actionInput);
    actionInputWrap.appendChild(suggestions);
    actionRow.appendChild(actionInputWrap);

    // Row 2: Time controls
    const timeRow = document.createElement('div');
    timeRow.className = 'plan-editor-row plan-editor-time-row';

    const startInput = document.createElement('input');
    startInput.type = 'text';
    startInput.className = 'plan-editor-time';
    startInput.value = msToTimeStr(planStartMs);
    startInput.placeholder = 'HH:MM';

    const sep = document.createElement('span');
    sep.className = 'plan-editor-sep';
    sep.textContent = '–';

    const endInput = document.createElement('input');
    endInput.type = 'text';
    endInput.className = 'plan-editor-time';
    endInput.value = msToTimeStr(planEndMs);
    endInput.placeholder = 'HH:MM';

    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.className = 'plan-editor-duration-input';
    durationInput.min = '1';
    durationInput.title = 'Duration in minutes';
    updateDuration();

    const durationLabel = document.createElement('span');
    durationLabel.className = 'plan-editor-duration-label';
    durationLabel.textContent = 'min';

    timeRow.appendChild(startInput);
    timeRow.appendChild(sep);
    timeRow.appendChild(endInput);
    timeRow.appendChild(durationInput);
    timeRow.appendChild(durationLabel);

    // Row 3: Action buttons
    const actionsRow = document.createElement('div');
    actionsRow.className = 'plan-editor-row plan-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'plan-editor-save';
    saveBtn.textContent = 'Save';

    const discardBtn = document.createElement('button');
    discardBtn.className = 'plan-editor-discard';
    discardBtn.textContent = 'Discard';

    actionsRow.appendChild(discardBtn);
    actionsRow.appendChild(saveBtn);

    content.appendChild(actionRow);
    content.appendChild(timeRow);
    content.appendChild(actionsRow);

    editor.appendChild(icon);
    editor.appendChild(content);

    // ── Insert editor after the free time block ──
    freeBlock.after(editor);

    // If we have a preselected action (from drag-to-schedule), pre-fill the input
    if (preselectedAction) {
        actionInput.value = preselectedAction.name;
        actionInput.disabled = true;
        actionInput.style.opacity = '0.7';
        // Focus the duration input instead for quick adjustment
        durationInput.focus();
        durationInput.select();
    } else {
        actionInput.focus();
    }

    // ── Autocomplete logic ──
    const allActions = collectAllItems().filter(a => !a.done);

    const renderSuggestions = (query) => {
        suggestions.innerHTML = '';
        if (!query) {
            suggestions.style.display = 'none';
            return;
        }
        const q = query.toLowerCase();
        const matches = allActions.filter(a => a.name.toLowerCase().includes(q));
        if (matches.length === 0) {
            suggestions.style.display = 'none';
            return;
        }
        suggestions.style.display = 'block';
        for (const action of matches.slice(0, 8)) {
            const opt = document.createElement('div');
            opt.className = 'plan-editor-suggestion';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'plan-editor-suggestion-name';
            nameSpan.textContent = action.name;
            opt.appendChild(nameSpan);

            if (action._path && action._path.length > 1) {
                const crumb = document.createElement('span');
                crumb.className = 'plan-editor-suggestion-project';
                crumb.textContent = action._path.slice(0, -1).map(p => p.name).join(' › ');
                opt.appendChild(crumb);
            }

            opt.addEventListener('mousedown', (e) => {
                e.preventDefault(); // prevent blur
                selectedAction = action;
                actionInput.value = action.name;
                suggestions.style.display = 'none';
            });
            suggestions.appendChild(opt);
        }
    };

    actionInput.addEventListener('input', () => {
        selectedAction = null;
        renderSuggestions(actionInput.value);
    });

    actionInput.addEventListener('focus', () => {
        if (actionInput.value && !selectedAction) {
            renderSuggestions(actionInput.value);
        }
    });

    actionInput.addEventListener('blur', () => {
        // Small delay so mousedown on suggestion fires first
        setTimeout(() => { suggestions.style.display = 'none'; }, 150);
    });

    // ── Time input logic ──
    const parseTimeInput = (input, currentMs, validate) => {
        const raw = input.value.trim();
        // Accept HH:MM or H:MM
        const match = raw.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
            input.value = msToTimeStr(currentMs);
            return currentMs;
        }
        const parsed = timeStrToMs(`${match[1].padStart(2, '0')}:${match[2]}`);
        if (validate(parsed)) {
            input.value = msToTimeStr(parsed);
            return parsed;
        }
        input.value = msToTimeStr(currentMs);
        return currentMs;
    };

    startInput.addEventListener('blur', () => {
        const result = parseTimeInput(startInput, planStartMs, (t) => t >= freeStartMs && t < planEndMs);
        if (result !== planStartMs) {
            planStartMs = result;
            updateDuration();
        }
    });

    endInput.addEventListener('blur', () => {
        const result = parseTimeInput(endInput, planEndMs, (t) => t > planStartMs && t <= freeEndMs);
        if (result !== planEndMs) {
            planEndMs = result;
            updateDuration();
        }
    });

    durationInput.addEventListener('change', () => {
        const mins = parseInt(durationInput.value, 10);
        if (mins > 0) {
            const newEnd = planStartMs + mins * 60000;
            if (newEnd <= freeEndMs) {
                planEndMs = newEnd;
                endInput.value = msToTimeStr(planEndMs);
            } else {
                // Clamp to available free time
                planEndMs = freeEndMs;
                endInput.value = msToTimeStr(planEndMs);
                updateDuration();
            }
        } else {
            updateDuration(); // reset to current value
        }
    });

    // ── Save / Discard ──
    discardBtn.addEventListener('click', () => {
        editor.remove();
    });

    saveBtn.addEventListener('click', async () => {
        if (!selectedAction) {
            actionInput.focus();
            actionInput.classList.add('plan-editor-input-error');
            setTimeout(() => actionInput.classList.remove('plan-editor-input-error'), 600);
            return;
        }

        const ancestors = selectedAction._path
            ? selectedAction._path.slice(0, -1).map(p => p.name).join(' › ')
            : '';

        const entry = await api.post('/timeline', {
            text: selectedAction.name,
            projectName: ancestors || null,
            type: 'planned',
            startTime: planStartMs,
            endTime: planEndMs,
            itemId: selectedAction.id,
        });
        state.timeline.entries.push(entry);
        renderTimeline();
    });
}

function createIdleTimeBlock(startMs, endMs) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-idle';
    el.dataset.startTime = startMs;

    const durationMs = endMs - startMs;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '💤';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    label.textContent = 'Idle';

    const time = document.createElement('div');
    time.className = 'time-block-time idle-time-range';
    time.textContent = `${formatTime(startMs)} – ${formatTime(endMs)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status idle-duration';
    if (hrs > 0) {
        status.textContent = `${hrs}h ${mins}m ${secs}s`;
    } else if (mins > 0) {
        status.textContent = `${mins}m ${secs}s`;
    } else {
        status.textContent = `${secs}s`;
    }

    content.appendChild(label);
    content.appendChild(time);
    content.appendChild(status);

    el.appendChild(icon);
    el.appendChild(content);

    // Log Work button
    const logBtn = document.createElement('button');
    logBtn.className = 'idle-log-btn';
    logBtn.textContent = '+';
    logBtn.title = 'Log work done during idle time';
    logBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowMs = Date.now();
        const actualEnd = Math.min(endMs, nowMs);
        openIdleWorkEditor(el, startMs, actualEnd);
    });
    el.appendChild(logBtn);

    // Break button
    const breakBtn = document.createElement('button');
    breakBtn.className = 'idle-break-btn';
    breakBtn.textContent = '☕';
    breakBtn.title = 'Take a break';
    breakBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startBreak();
    });
    el.appendChild(breakBtn);

    return el;
}

// ── Idle Work Editor: log what you worked on during idle time ──

function openIdleWorkEditor(idleBlock, idleStartMs, idleEndMs) {
    // Close any existing editor
    document.querySelectorAll('.plan-editor').forEach(ed => ed.remove());

    let planStartMs = idleStartMs;
    let planEndMs = idleEndMs;
    let selectedAction = null;

    const msToTimeStr = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const timeStrToMs = (str) => {
        const [h, m] = str.split(':').map(Number);
        const d = new Date(planStartMs);
        d.setHours(h, m, 0, 0);
        return d.getTime();
    };

    const updateDuration = () => {
        const durMs = planEndMs - planStartMs;
        const totalMins = Math.round(durMs / 60000);
        durationInput.value = totalMins;
    };

    // ── Build editor DOM ──
    const editor = document.createElement('div');
    editor.className = 'time-block plan-editor idle-work-editor';

    const editorIcon = document.createElement('div');
    editorIcon.className = 'time-block-icon';
    editorIcon.textContent = '🔥';

    const editorContent = document.createElement('div');
    editorContent.className = 'plan-editor-content';

    // Row 1: Action autocomplete
    const actionRow = document.createElement('div');
    actionRow.className = 'plan-editor-row';

    const actionInputWrap = document.createElement('div');
    actionInputWrap.className = 'plan-editor-autocomplete';

    const actionInput = document.createElement('input');
    actionInput.type = 'text';
    actionInput.className = 'plan-editor-input';
    actionInput.placeholder = 'What did you work on?';

    const suggestions = document.createElement('div');
    suggestions.className = 'plan-editor-suggestions';

    actionInputWrap.appendChild(actionInput);
    actionInputWrap.appendChild(suggestions);
    actionRow.appendChild(actionInputWrap);

    // Row 2: Time controls
    const timeRow = document.createElement('div');
    timeRow.className = 'plan-editor-row plan-editor-time-row';

    const startInput = document.createElement('input');
    startInput.type = 'text';
    startInput.className = 'plan-editor-time';
    startInput.value = msToTimeStr(planStartMs);
    startInput.placeholder = 'HH:MM';

    const sep = document.createElement('span');
    sep.className = 'plan-editor-sep';
    sep.textContent = '–';

    const endInput = document.createElement('input');
    endInput.type = 'text';
    endInput.className = 'plan-editor-time';
    endInput.value = msToTimeStr(planEndMs);
    endInput.placeholder = 'HH:MM';

    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.className = 'plan-editor-duration-input';
    durationInput.min = '1';
    durationInput.title = 'Duration in minutes';
    updateDuration();

    const durationLabel = document.createElement('span');
    durationLabel.className = 'plan-editor-duration-label';
    durationLabel.textContent = 'min';

    timeRow.appendChild(startInput);
    timeRow.appendChild(sep);
    timeRow.appendChild(endInput);
    timeRow.appendChild(durationInput);
    timeRow.appendChild(durationLabel);

    // Row 3: Action buttons
    const actionsRow = document.createElement('div');
    actionsRow.className = 'plan-editor-row plan-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'plan-editor-save';
    saveBtn.textContent = 'Save';

    const discardBtn = document.createElement('button');
    discardBtn.className = 'plan-editor-discard';
    discardBtn.textContent = 'Discard';

    actionsRow.appendChild(discardBtn);
    actionsRow.appendChild(saveBtn);

    editorContent.appendChild(actionRow);
    editorContent.appendChild(timeRow);
    editorContent.appendChild(actionsRow);

    editor.appendChild(editorIcon);
    editor.appendChild(editorContent);

    // Insert editor after the idle block
    idleBlock.after(editor);
    actionInput.focus();

    // ── Autocomplete logic ──
    const allActions = collectAllItems().filter(a => !a.done);

    const renderSuggestions = (query) => {
        suggestions.innerHTML = '';
        if (!query) {
            suggestions.style.display = 'none';
            return;
        }
        const q = query.toLowerCase();
        const matches = allActions.filter(a => a.name.toLowerCase().includes(q));
        if (matches.length === 0) {
            suggestions.style.display = 'none';
            return;
        }
        suggestions.style.display = 'block';
        for (const action of matches.slice(0, 8)) {
            const opt = document.createElement('div');
            opt.className = 'plan-editor-suggestion';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'plan-editor-suggestion-name';
            nameSpan.textContent = action.name;
            opt.appendChild(nameSpan);

            if (action._path && action._path.length > 1) {
                const crumb = document.createElement('span');
                crumb.className = 'plan-editor-suggestion-project';
                crumb.textContent = action._path.slice(0, -1).map(p => p.name).join(' › ');
                opt.appendChild(crumb);
            }

            opt.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectedAction = action;
                actionInput.value = action.name;
                suggestions.style.display = 'none';
            });
            suggestions.appendChild(opt);
        }
    };

    actionInput.addEventListener('input', () => {
        selectedAction = null;
        renderSuggestions(actionInput.value);
    });

    actionInput.addEventListener('focus', () => {
        if (actionInput.value && !selectedAction) {
            renderSuggestions(actionInput.value);
        }
    });

    actionInput.addEventListener('blur', () => {
        setTimeout(() => { suggestions.style.display = 'none'; }, 150);
    });

    // ── Time input logic ──
    const parseTimeInput = (input, currentMs, validate) => {
        const raw = input.value.trim();
        const match = raw.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
            input.value = msToTimeStr(currentMs);
            return currentMs;
        }
        const parsed = timeStrToMs(`${match[1].padStart(2, '0')}:${match[2]}`);
        if (validate(parsed)) {
            input.value = msToTimeStr(parsed);
            return parsed;
        }
        input.value = msToTimeStr(currentMs);
        return currentMs;
    };

    startInput.addEventListener('blur', () => {
        const result = parseTimeInput(startInput, planStartMs, (t) => t >= idleStartMs && t < planEndMs);
        if (result !== planStartMs) {
            planStartMs = result;
            updateDuration();
        }
    });

    endInput.addEventListener('blur', () => {
        const result = parseTimeInput(endInput, planEndMs, (t) => t > planStartMs && t <= idleEndMs);
        if (result !== planEndMs) {
            planEndMs = result;
            updateDuration();
        }
    });

    durationInput.addEventListener('change', () => {
        const mins = parseInt(durationInput.value, 10);
        if (mins > 0) {
            const newEnd = planStartMs + mins * 60000;
            if (newEnd <= idleEndMs) {
                planEndMs = newEnd;
                endInput.value = msToTimeStr(planEndMs);
            } else {
                planEndMs = idleEndMs;
                endInput.value = msToTimeStr(planEndMs);
                updateDuration();
            }
        } else {
            updateDuration();
        }
    });

    // ── Save / Discard ──
    discardBtn.addEventListener('click', () => {
        editor.remove();
    });

    saveBtn.addEventListener('click', async () => {
        if (!selectedAction) {
            actionInput.focus();
            actionInput.classList.add('plan-editor-input-error');
            setTimeout(() => actionInput.classList.remove('plan-editor-input-error'), 600);
            return;
        }

        const ancestors = selectedAction._path
            ? selectedAction._path.slice(0, -1).map(p => p.name).join(' › ')
            : '';

        const durationMs = planEndMs - planStartMs;
        const hrs = Math.floor(durationMs / 3600000);
        const mins = Math.floor((durationMs % 3600000) / 60000);
        const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

        const entry = await api.post('/timeline', {
            text: `Worked on: ${selectedAction.name} (${durStr})`,
            projectName: ancestors || null,
            type: 'work',
            startTime: planStartMs,
            endTime: planEndMs,
            itemId: selectedAction.id,
        });
        state.timeline.entries.push(entry);
        renderTimeline();
    });
}

function createWorkingTimeBlock(startMs, endMs) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-working';
    el.dataset.startTime = startMs;

    const durationMs = endMs - startMs;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '🔥';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    label.textContent = state.workingOn ? state.workingOn.itemName : 'Working';

    const time = document.createElement('div');
    time.className = 'time-block-time working-time-range';
    time.textContent = `${formatTime(startMs)} – ${formatTime(endMs)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status working-duration';
    if (hrs > 0) {
        status.textContent = `${hrs}h ${mins}m`;
    } else if (mins > 0) {
        status.textContent = `${mins}m ${secs}s`;
    } else {
        status.textContent = `${secs}s`;
    }

    content.appendChild(label);
    content.appendChild(time);
    content.appendChild(status);

    // Project name tag
    if (state.workingOn && state.workingOn.projectName) {
        const tag = document.createElement('div');
        tag.className = 'time-block-project';
        tag.textContent = state.workingOn.projectName;
        content.appendChild(tag);
    }

    // Stop button
    const stopBtn = document.createElement('button');
    stopBtn.className = 'time-block-stop-btn';
    stopBtn.textContent = '⏹';
    stopBtn.title = 'Stop working';
    stopBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await stopWorking();
    });

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(stopBtn);

    return el;
}
function createBreakTimeBlock(startMs, endMs) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-break';
    el.dataset.startTime = startMs;

    const durationMs = endMs - startMs;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '☕';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    label.textContent = 'Break';

    const time = document.createElement('div');
    time.className = 'time-block-time break-time-range';
    time.textContent = `${formatTime(startMs)} – ${formatTime(endMs)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status break-duration';
    if (hrs > 0) {
        status.textContent = `${hrs}h ${mins}m`;
    } else if (mins > 0) {
        status.textContent = `${mins}m ${secs}s`;
    } else {
        status.textContent = `${secs}s`;
    }

    content.appendChild(label);
    content.appendChild(time);
    content.appendChild(status);

    // Stop break button
    const stopBtn = document.createElement('button');
    stopBtn.className = 'time-block-stop-btn break-stop-btn';
    stopBtn.textContent = '⏹';
    stopBtn.title = 'End break';
    stopBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await stopBreak();
    });

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(stopBtn);

    return el;
}

// ── Idle/Working block real-time updater ──
let idleUpdateInterval = null;

function startIdleUpdater() {
    if (idleUpdateInterval) clearInterval(idleUpdateInterval);
    idleUpdateInterval = setInterval(() => {
        // Update working block if present
        const workingBlock = document.querySelector('.time-block-working');
        if (workingBlock) {
            const startMs = parseInt(workingBlock.dataset.startTime, 10);
            const nowMs = Date.now();
            const durationMs = Math.max(0, nowMs - startMs);

            const hrs = Math.floor(durationMs / 3600000);
            const mins = Math.floor((durationMs % 3600000) / 60000);
            const secs = Math.floor((durationMs % 60000) / 1000);

            const durationEl = workingBlock.querySelector('.working-duration');
            if (durationEl) {
                if (hrs > 0) {
                    durationEl.textContent = `${hrs}h ${mins}m`;
                } else if (mins > 0) {
                    durationEl.textContent = `${mins}m ${secs}s`;
                } else {
                    durationEl.textContent = `${secs}s`;
                }
            }

            const timeEl = workingBlock.querySelector('.working-time-range');
            if (timeEl) {
                timeEl.textContent = `${formatTime(startMs)} – ${formatTime(nowMs)}`;
            }

            // Push adjacent free time block
            updateAdjacentFreeBlock(workingBlock, nowMs);
            return; // working block takes priority over idle
        }

        // Update break block if present
        const breakBlock = document.querySelector('.time-block-break');
        if (breakBlock) {
            const startMs = parseInt(breakBlock.dataset.startTime, 10);
            const nowMs = Date.now();
            const durationMs = Math.max(0, nowMs - startMs);

            const hrs = Math.floor(durationMs / 3600000);
            const mins = Math.floor((durationMs % 3600000) / 60000);
            const secs = Math.floor((durationMs % 60000) / 1000);

            const durationEl = breakBlock.querySelector('.break-duration');
            if (durationEl) {
                if (hrs > 0) {
                    durationEl.textContent = `${hrs}h ${mins}m`;
                } else if (mins > 0) {
                    durationEl.textContent = `${mins}m ${secs}s`;
                } else {
                    durationEl.textContent = `${secs}s`;
                }
            }

            const timeEl = breakBlock.querySelector('.break-time-range');
            if (timeEl) {
                timeEl.textContent = `${formatTime(startMs)} – ${formatTime(nowMs)}`;
            }

            // Push adjacent free time block
            updateAdjacentFreeBlock(breakBlock, nowMs);
            return; // break block takes priority over idle
        }

        // Update idle block if present
        const idleBlock = document.querySelector('.time-block-idle');
        if (!idleBlock) return;

        const startMs = parseInt(idleBlock.dataset.startTime, 10);
        const nowMs = Date.now();
        const durationMs = Math.max(0, nowMs - startMs);

        const hrs = Math.floor(durationMs / 3600000);
        const mins = Math.floor((durationMs % 3600000) / 60000);
        const secs = Math.floor((durationMs % 60000) / 1000);

        // Update duration text
        const durationEl = idleBlock.querySelector('.idle-duration');
        if (durationEl) {
            if (hrs > 0) {
                durationEl.textContent = `${hrs}h ${mins}m ${secs}s`;
            } else if (mins > 0) {
                durationEl.textContent = `${mins}m ${secs}s`;
            } else {
                durationEl.textContent = `${secs}s`;
            }
        }

        // Update time range
        const timeEl = idleBlock.querySelector('.idle-time-range');
        if (timeEl) {
            timeEl.textContent = `${formatTime(startMs)} – ${formatTime(nowMs)}`;
        }

        // Push the adjacent free time block (shrink it)
        updateAdjacentFreeBlock(idleBlock, nowMs);
    }, 1000);
}

function updateAdjacentFreeBlock(block, nowMs) {
    const nextFree = block.nextElementSibling;
    if (nextFree && nextFree.classList.contains('time-block-free')) {
        const freeEndMs = parseInt(nextFree.dataset.endTime, 10);
        const freeDurationMs = Math.max(0, freeEndMs - nowMs);

        if (freeDurationMs < 60000) {
            nextFree.style.display = 'none';
        } else {
            nextFree.style.display = '';
            nextFree.dataset.startTime = nowMs;

            const freeHrs = Math.floor(freeDurationMs / 3600000);
            const freeMins = Math.floor((freeDurationMs % 3600000) / 60000);

            const freeTimeEl = nextFree.querySelector('.time-block-time');
            if (freeTimeEl) {
                freeTimeEl.textContent = `${formatTime(nowMs)} – ${formatTime(freeEndMs)}`;
            }
            const freeStatusEl = nextFree.querySelector('.time-block-status');
            if (freeStatusEl) {
                freeStatusEl.textContent = freeHrs > 0 ? `${freeHrs}h ${freeMins}m` : `${freeMins}m`;
            }
        }
    }
}

function createDayBoundaryBlock(type, boundaryTime, now) {
    const el = document.createElement('div');
    el.className = `time-block time-block-${type}`;

    const isPast = now >= boundaryTime;
    const isFuture = now < boundaryTime;
    if (isPast) el.classList.add('time-block-past');
    if (isFuture) el.classList.add('time-block-future');

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = type === 'day-start' ? '🌅' : '🌙';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    label.textContent = type === 'day-start' ? 'Day Start' : 'Day End';

    // Editable time — click to change this day's boundary
    const timeEl = document.createElement('div');
    timeEl.className = 'time-block-time time-block-time-editable';
    timeEl.textContent = formatTime(boundaryTime.getTime());
    timeEl.title = 'Click to change';

    timeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        // Don't open if already editing
        if (timeEl.querySelector('input')) return;

        const hh = String(boundaryTime.getHours()).padStart(2, '0');
        const mm = String(boundaryTime.getMinutes()).padStart(2, '0');

        const input = document.createElement('input');
        input.type = 'time';
        input.className = 'time-block-time-input';
        input.value = `${hh}:${mm}`;

        timeEl.textContent = '';
        timeEl.appendChild(input);
        input.focus();

        const commit = async () => {
            const [newH, newM] = (input.value || `${hh}:${mm}`).split(':').map(Number);
            const key = getDateKey(state.timelineViewDate);
            const current = getEffectiveDayTimes(state.timelineViewDate);

            if (!state.settings.dayOverrides) state.settings.dayOverrides = {};
            state.settings.dayOverrides[key] = {
                ...current,
                ...(type === 'day-start'
                    ? { dayStartHour: newH, dayStartMinute: newM }
                    : { dayEndHour: newH, dayEndMinute: newM }),
            };
            await api.put('/settings', state.settings);
            renderTimeline();
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                input.blur(); // will trigger commit via blur handler
            } else if (e.key === 'Escape') {
                // Remove blur listener so it doesn't commit on escape
                input.removeEventListener('blur', commit);
                timeEl.textContent = formatTime(boundaryTime.getTime());
            }
        });
    });

    const status = document.createElement('div');
    status.className = 'time-block-status';

    // Check if this day has a custom override — show reset link
    const dateKey = getDateKey(state.timelineViewDate);
    const hasOverride = !!state.settings.dayOverrides?.[dateKey];

    if (type === 'day-start') {
        if (isPast) {
            const elapsed = now - boundaryTime;
            const hrs = Math.floor(elapsed / 3600000);
            const mins = Math.floor((elapsed % 3600000) / 60000);
            status.textContent = hrs > 0 ? `${hrs}h ${mins}m ago` : `${mins}m ago`;
        } else {
            const until = boundaryTime - now;
            const hrs = Math.floor(until / 3600000);
            const mins = Math.floor((until % 3600000) / 60000);
            status.textContent = hrs > 0 ? `starts in ${hrs}h ${mins}m` : `starts in ${mins}m`;
        }
    } else {
        if (isFuture) {
            const remaining = boundaryTime - now;
            const hrs = Math.floor(remaining / 3600000);
            const mins = Math.floor((remaining % 3600000) / 60000);
            status.textContent = hrs > 0 ? `${hrs}h ${mins}m left` : `${mins}m left`;
        } else {
            status.textContent = 'day ended';
        }
    }

    content.appendChild(label);
    content.appendChild(timeEl);
    content.appendChild(status);

    // Reset button (only on day-start and only if there's an override)
    if (type === 'day-start' && hasOverride) {
        const resetBtn = document.createElement('button');
        resetBtn.className = 'time-block-reset';
        resetBtn.textContent = '↺';
        resetBtn.title = 'Reset to default times';
        resetBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            delete state.settings.dayOverrides[dateKey];
            await api.put('/settings', state.settings);
            renderTimeline();
        });
        content.appendChild(resetBtn);
    }

    el.appendChild(icon);
    el.appendChild(content);

    return el;
}

function createTimelineElement(entry) {
    // Block entries (work, break, planned) render as time blocks
    if (entry.type === 'planned') {
        return createPlannedTimeBlock(entry);
    }
    if (entry.type === 'work') {
        return createWorkEntryBlock(entry);
    }
    if (entry.type === 'break') {
        return createBreakEntryBlock(entry);
    }

    // Fallback: any other entry type renders as a moment entry
    return createMomentEntry(entry);
}

// ── Past Work Entry: renders as a time block (like the live "working" block) ──
function createWorkEntryBlock(entry) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-work-entry time-block-past';
    el.dataset.id = entry.id;

    const durationMs = (entry.endTime || entry.timestamp) - entry.timestamp;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '🔥';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    // Strip "Worked on: " prefix and duration suffix for cleaner display
    let labelText = entry.text;
    if (labelText.startsWith('Worked on: ')) labelText = labelText.slice(11);
    labelText = labelText.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');
    label.textContent = labelText;

    const time = document.createElement('div');
    time.className = 'time-block-time';
    time.textContent = `${formatTime(entry.timestamp)} – ${formatTime(entry.endTime)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status';
    status.textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    content.appendChild(label);
    content.appendChild(time);
    content.appendChild(status);

    // Project tag
    if (entry.projectName) {
        const tag = document.createElement('div');
        tag.className = 'time-block-project';
        tag.textContent = entry.projectName;
        content.appendChild(tag);
    }

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'plan-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Remove entry';
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(delBtn);

    return el;
}

// ── Past Break Entry: renders as a time block (like the live "break" block) ──
function createBreakEntryBlock(entry) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-break-entry time-block-past';
    el.dataset.id = entry.id;

    const durationMs = (entry.endTime || entry.timestamp) - entry.timestamp;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '☕';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    // Strip duration suffix for cleaner display
    let labelText = entry.text;
    labelText = labelText.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');
    label.textContent = labelText;

    const time = document.createElement('div');
    time.className = 'time-block-time';
    time.textContent = `${formatTime(entry.timestamp)} – ${formatTime(entry.endTime)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status';
    status.textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    content.appendChild(label);
    content.appendChild(time);
    content.appendChild(status);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'plan-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Remove entry';
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(delBtn);

    return el;
}

// ── Moment Entry: renders as an indented inline entry (for completions, manual logs etc.) ──
function createMomentEntry(entry) {
    const el = document.createElement('div');
    el.className = 'timeline-entry timeline-entry-moment';
    el.dataset.id = entry.id;

    // Small dot indicator
    const dot = document.createElement('div');
    dot.className = 'moment-dot';

    // Content
    const content = document.createElement('div');
    content.className = 'timeline-entry-content';

    const text = document.createElement('div');
    text.className = 'timeline-entry-text';
    text.textContent = entry.text;

    const time = document.createElement('div');
    time.className = 'timeline-entry-time';
    time.textContent = formatTime(entry.timestamp);

    content.appendChild(text);
    content.appendChild(time);

    if (entry.projectName) {
        const tag = document.createElement('div');
        tag.className = 'timeline-entry-project';
        tag.textContent = entry.projectName;
        content.appendChild(tag);
    }

    // Delete
    const del = document.createElement('button');
    del.className = 'timeline-delete';
    del.textContent = '×';
    del.addEventListener('click', async () => {
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    el.appendChild(dot);
    el.appendChild(content);
    el.appendChild(del);

    return el;
}

function createPlannedTimeBlock(entry) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-planned';
    el.dataset.id = entry.id;

    const durationMs = (entry.endTime || entry.timestamp) - entry.timestamp;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '📌';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    label.textContent = entry.text;

    const time = document.createElement('div');
    time.className = 'time-block-time';
    time.textContent = `${formatTime(entry.timestamp)} – ${formatTime(entry.endTime)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status';
    status.textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    content.appendChild(label);
    content.appendChild(time);
    content.appendChild(status);

    // Project tag
    if (entry.projectName) {
        const tag = document.createElement('div');
        tag.className = 'time-block-project';
        tag.textContent = entry.projectName;
        content.appendChild(tag);
    }

    // Start working button — click to begin working on this planned item
    const startBtn = document.createElement('button');
    startBtn.className = 'plan-start-btn';
    startBtn.textContent = '▶';
    startBtn.title = 'Start working on this';
    startBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await startWorking(entry.itemId, entry.text, entry.projectName);
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'plan-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Remove plan';
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(startBtn);
    el.appendChild(delBtn);

    return el;
}

function updateClock() {
    const now = new Date();

    // Clock time string
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const timeStr = `${hours}:${minutes}`;

    // Taskbar clock
    const taskbarClock = document.getElementById('taskbar-clock');
    if (taskbarClock) taskbarClock.textContent = timeStr;

    // Status bar time
    document.getElementById('greeting-time').textContent = timeStr;

    // Update date nav display
    updateDateNav();
}

function updateDateNav() {
    const viewDate = state.timelineViewDate;
    const now = new Date();
    const isToday = isCurrentDay(viewDate);

    // Date display is determined by the day start date (viewDate)
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    let dateText = viewDate.toLocaleDateString('en-US', options);

    // If it's a different year, add the year
    if (viewDate.getFullYear() !== now.getFullYear()) {
        dateText += `, ${viewDate.getFullYear()}`;
    }

    const dateEl = document.getElementById('date-nav-date');
    const badgeEl = document.getElementById('date-nav-today-badge');

    if (dateEl) dateEl.textContent = dateText;
    if (badgeEl) badgeEl.style.display = isToday ? '' : 'none';
}

// ─── Context Labels ───
function updateContextLabels() {
    // No-op: context label removed from UI
}

// ─── Formatters ───
function formatTime(ts) {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
}

// ─── Quick Log ───
function handleQuickLog() {
    const input = document.getElementById('quick-log-input');
    const text = input.value.trim();
    if (!text) return;

    const projectName = state.selectedItemId
        ? findItemName(state.selectedItemId)
        : null;

    api.post('/timeline', {
        text,
        projectName: projectName,
        type: 'log'
    }).then(async (entry) => {
        state.timeline.entries.push(entry);
        renderTimeline();
        input.value = '';
    });
}

// ─── Working On Timer ───

function startWorking(itemId, itemName, projectName) {
    // If already working on something else, stop it first
    if (state.workingOn) {
        stopWorking();
    }
    // If on a break, stop it first
    if (state.onBreak) {
        stopBreak();
    }
    state.workingOn = {
        itemId,
        itemName,
        projectName: projectName || null,
        startTime: Date.now(),
    };
    localStorage.setItem('workingOn', JSON.stringify(state.workingOn));
    renderAll();
}

async function stopWorking() {
    if (!state.workingOn) return;

    const endTime = Date.now();
    const durationMs = endTime - state.workingOn.startTime;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    // Log work entry to timeline
    const entry = await api.post('/timeline', {
        text: `Worked on: ${state.workingOn.itemName} (${durStr})`,
        projectName: state.workingOn.projectName,
        type: 'work',
        startTime: state.workingOn.startTime,
        endTime: endTime,
        itemId: state.workingOn.itemId,
    });
    state.timeline.entries.push(entry);

    // Clear working state
    state.workingOn = null;
    localStorage.removeItem('workingOn');
    renderAll();
}

function restoreWorkingOn() {
    try {
        const saved = localStorage.getItem('workingOn');
        if (saved) {
            state.workingOn = JSON.parse(saved);
        }
    } catch { /* ignore */ }
}

// ─── Break Timer ───

function startBreak() {
    // If working on something, stop it first
    if (state.workingOn) {
        stopWorking();
    }
    state.onBreak = {
        startTime: Date.now(),
    };
    localStorage.setItem('onBreak', JSON.stringify(state.onBreak));
    renderAll();
}

async function stopBreak() {
    if (!state.onBreak) return;

    const endTime = Date.now();
    const durationMs = endTime - state.onBreak.startTime;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    // Log break entry to timeline
    const entry = await api.post('/timeline', {
        text: `Break (${durStr})`,
        type: 'break',
        startTime: state.onBreak.startTime,
        endTime: endTime,
    });
    state.timeline.entries.push(entry);

    // Clear break state
    state.onBreak = null;
    localStorage.removeItem('onBreak');
    renderAll();
}

function restoreBreak() {
    try {
        const saved = localStorage.getItem('onBreak');
        if (saved) {
            state.onBreak = JSON.parse(saved);
        }
    } catch { /* ignore */ }
}

// ─── Streak System ───
// The user must check in before the next day's start time to keep the streak alive.
// "Day" is defined by the app's day start time from settings (supports cross-midnight).

function getStreakData() {
    return state.settings.streak || { count: 0, lastCheckInDate: null, longestStreak: 0 };
}

function getLogicalDateKey(date) {
    // Use the same logic as getLogicalToday to figure out which "day" a datetime belongs to
    const d = date || new Date();
    // Check if d falls within today's boundaries
    const todayKey = getDateKey(d);
    const { dayStart, dayEnd } = getDayBoundaries(d);

    if (d >= dayStart && d < dayEnd) {
        return todayKey;
    }

    // If it's before today's start, it might belong to yesterday's day
    const yesterday = new Date(d);
    yesterday.setDate(yesterday.getDate() - 1);
    const { dayStart: yStart, dayEnd: yEnd } = getDayBoundaries(yesterday);
    if (d >= yStart && d < yEnd) {
        return getDateKey(yesterday);
    }

    return todayKey;
}

function getTodayLogicalDateKey() {
    const logicalToday = getLogicalToday();
    return getDateKey(logicalToday);
}

function isStreakAlive(streak) {
    if (!streak.lastCheckInDate) return false;
    const todayKey = getTodayLogicalDateKey();

    // Already checked in today — streak is alive
    if (streak.lastCheckInDate === todayKey) return true;

    // Check if lastCheckInDate was yesterday (logical day)
    const logicalToday = getLogicalToday();
    const yesterday = new Date(logicalToday);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = getDateKey(yesterday);

    return streak.lastCheckInDate === yesterdayKey;
}

function hasCheckedInToday(streak) {
    if (!streak.lastCheckInDate) return false;
    return streak.lastCheckInDate === getTodayLogicalDateKey();
}

async function performCheckIn() {
    const streak = getStreakData();
    const todayKey = getTodayLogicalDateKey();

    if (hasCheckedInToday(streak)) return; // Already checked in

    if (isStreakAlive(streak)) {
        // Continue the streak
        streak.count += 1;
    } else {
        // Streak broken — start fresh
        streak.count = 1;
    }

    streak.lastCheckInDate = todayKey;
    if (streak.count > (streak.longestStreak || 0)) {
        streak.longestStreak = streak.count;
    }

    state.settings.streak = streak;
    await api.put('/settings', state.settings);
    renderStreak();
}

function renderStreak() {
    const streak = getStreakData();
    const alive = isStreakAlive(streak);
    const checkedInToday = hasCheckedInToday(streak);

    const widget = document.getElementById('streak-widget');
    const fire = document.getElementById('streak-fire');
    const count = document.getElementById('streak-count');
    const btn = document.getElementById('streak-checkin-btn');

    if (!widget) return;

    // Update count
    count.textContent = alive ? streak.count : 0;

    // Update visual states
    widget.classList.toggle('streak-active', alive && streak.count > 0);
    widget.classList.toggle('streak-checked-in', checkedInToday);
    widget.classList.toggle('streak-needs-checkin', !checkedInToday);

    // Fire emoji state
    if (checkedInToday) {
        fire.textContent = '🔥';
    } else if (alive) {
        fire.textContent = '🔥';
    } else {
        fire.textContent = '💤';
    }

    // Check-in button visibility
    btn.style.display = checkedInToday ? 'none' : '';

    // Update tooltip with more info
    if (checkedInToday) {
        widget.title = `🔥 ${streak.count}-day streak! (Best: ${streak.longestStreak || streak.count})`;
    } else if (alive) {
        widget.title = `Check in to continue your ${streak.count}-day streak!`;
    } else {
        widget.title = 'Start a streak by checking in!';
    }

    // Celebration animation for milestones
    if (checkedInToday && [3, 5, 7, 10, 14, 21, 30, 50, 100].includes(streak.count)) {
        widget.classList.add('streak-milestone');
        setTimeout(() => widget.classList.remove('streak-milestone'), 1500);
    }
}

// ─── Skin Switching ───
const SKINS = {
    modern: 'skins/modern.css',
    win95: 'skins/win95.css',
    duolingo: 'skins/duolingo.css',
    pencil: 'skins/pencil.css',
};

function applySkin(skinId) {
    const link = document.getElementById('skin-stylesheet');
    if (link && SKINS[skinId]) {
        link.href = SKINS[skinId];
        localStorage.setItem('anything-mini-skin', skinId);

        // Update the select dropdown
        const select = document.getElementById('skin-select');
        if (select) select.value = skinId;
    }
}

function initSkin() {
    const saved = localStorage.getItem('anything-mini-skin') || 'modern';
    applySkin(saved);

    const select = document.getElementById('skin-select');
    if (select) {
        select.value = saved;
        select.addEventListener('change', (e) => {
            applySkin(e.target.value);
        });
    }
}

// ─── Panel Resize (Draggable Dividers) ───
const panelResize = {
    MIN_SIDEBAR: 120,
    MAX_SIDEBAR: 500,
    leftWidth: null,
    rightWidth: null,

    init() {
        const saved = localStorage.getItem('anything-mini-panels');
        if (saved) {
            try {
                const { left, right } = JSON.parse(saved);
                this.leftWidth = left;
                this.rightWidth = right;
            } catch { /* ignore */ }
        }

        // Read default widths from the computed grid if not saved
        if (!this.leftWidth || !this.rightWidth) {
            const layout = document.querySelector('.app-layout');
            const cols = getComputedStyle(layout).gridTemplateColumns.split(/\s+/);
            // grid: leftSidebar divider center divider rightSidebar
            this.leftWidth = this.leftWidth || parseFloat(cols[0]);
            this.rightWidth = this.rightWidth || parseFloat(cols[cols.length - 1]);
        }

        this.applyWidths();

        document.getElementById('divider-left')?.addEventListener('mousedown', (e) => this.startDrag(e, 'left'));
        document.getElementById('divider-right')?.addEventListener('mousedown', (e) => this.startDrag(e, 'right'));
    },

    applyWidths() {
        const layout = document.querySelector('.app-layout');
        if (!layout) return;
        layout.style.gridTemplateColumns = `${this.leftWidth}px 6px 1fr 6px ${this.rightWidth}px`;
    },

    save() {
        localStorage.setItem('anything-mini-panels', JSON.stringify({
            left: this.leftWidth,
            right: this.rightWidth,
        }));
    },

    startDrag(e, side) {
        e.preventDefault();
        const startX = e.clientX;
        const startLeft = this.leftWidth;
        const startRight = this.rightWidth;

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const divider = e.currentTarget;
        divider.classList.add('dragging');

        const onMove = (moveEvent) => {
            const dx = moveEvent.clientX - startX;
            if (side === 'left') {
                this.leftWidth = Math.max(this.MIN_SIDEBAR, Math.min(this.MAX_SIDEBAR, startLeft + dx));
            } else {
                this.rightWidth = Math.max(this.MIN_SIDEBAR, Math.min(this.MAX_SIDEBAR, startRight - dx));
            }
            this.applyWidths();
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            divider.classList.remove('dragging');
            this.save();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    },
};

// ─── Day Settings (Defaults Modal only — per-day editing is on time blocks) ───

function syncSettingsUI() {
    // No-op — per-day times are shown directly on time blocks
}

// ─── Schedule Modal (custom in-theme calendar) ───
function openScheduleModal(itemId, itemName) {
    // Close if already open
    const existing = document.getElementById('schedule-modal-overlay');
    if (existing) existing.remove();

    const item = findItemById(itemId);
    const assignedDates = new Set((item && item.timeContexts) || []);

    let viewYear, viewMonth;
    // Start on the current timeline view date
    const now = new Date(state.timelineViewDate);
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();

    const overlay = document.createElement('div');
    overlay.id = 'schedule-modal-overlay';
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-box schedule-modal-box';

    function buildCalendar() {
        const todayKey = getDateKey(getLogicalToday());
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

        // First day of the month and number of days
        const firstDay = new Date(viewYear, viewMonth, 1).getDay();
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

        let html = `
            <div class="modal-header">Schedule: ${itemName}</div>
            <div class="modal-body">
                <div class="schedule-cal-nav">
                    <button class="schedule-cal-nav-btn" id="schedule-prev-month">‹</button>
                    <span class="schedule-cal-month">${monthNames[viewMonth]} ${viewYear}</span>
                    <button class="schedule-cal-nav-btn" id="schedule-next-month">›</button>
                </div>
                <div class="schedule-cal-grid">
        `;

        // Day-of-week headers
        for (const dn of dayNames) {
            html += `<div class="schedule-cal-header">${dn}</div>`;
        }

        // Empty cells before the 1st
        for (let i = 0; i < firstDay; i++) {
            html += `<div class="schedule-cal-empty"></div>`;
        }

        // Day cells
        for (let d = 1; d <= daysInMonth; d++) {
            const dateKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const isAssigned = assignedDates.has(dateKey);
            const isToday = dateKey === todayKey;
            let cls = 'schedule-cal-day';
            if (isAssigned) cls += ' schedule-cal-day-assigned';
            if (isToday) cls += ' schedule-cal-day-today';
            html += `<div class="${cls}" data-date="${dateKey}">${d}</div>`;
        }

        html += `
                </div>
            </div>
            <div class="modal-actions">
                <button class="modal-btn modal-btn-cancel" id="schedule-close">Close</button>
            </div>
        `;

        modal.innerHTML = html;

        // Wire up month nav
        modal.querySelector('#schedule-prev-month').addEventListener('click', () => {
            viewMonth--;
            if (viewMonth < 0) { viewMonth = 11; viewYear--; }
            buildCalendar();
        });
        modal.querySelector('#schedule-next-month').addEventListener('click', () => {
            viewMonth++;
            if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            buildCalendar();
        });

        // Wire up day clicks
        modal.querySelectorAll('.schedule-cal-day').forEach(cell => {
            cell.addEventListener('click', async () => {
                const dateKey = cell.dataset.date;
                if (assignedDates.has(dateKey)) {
                    // Remove
                    assignedDates.delete(dateKey);
                    const itm = findItemById(itemId);
                    if (itm) {
                        itm.timeContexts = (itm.timeContexts || []).filter(tc => tc !== dateKey);
                        await api.patch(`/items/${itemId}`, { timeContexts: itm.timeContexts });
                    }
                } else {
                    // Add
                    assignedDates.add(dateKey);
                    await addTimeContext(itemId, dateKey);
                }
                buildCalendar();
            });
        });

        // Close button
        modal.querySelector('#schedule-close').addEventListener('click', () => {
            overlay.remove();
            renderAll();
        });
    }

    buildCalendar();
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.remove();
            renderAll();
        }
    });
}

// ─── Default Day Times Modal ───
function openDefaultsModal() {
    // Close if already open
    const existing = document.getElementById('defaults-modal-overlay');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.id = 'defaults-modal-overlay';
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-box';
    modal.innerHTML = `
        <div class="modal-header">Settings</div>
        <div class="modal-body">
            <div class="modal-field">
                <label class="modal-label">🌅 Day starts at</label>
                <input type="time" id="defaults-start-time" class="modal-input" />
            </div>
            <div class="modal-field">
                <label class="modal-label">🌙 Day ends at</label>
                <input type="time" id="defaults-end-time" class="modal-input" />
            </div>
            <div class="modal-hint">If end is before start, the day crosses midnight.</div>
            <div class="modal-divider"></div>
            <div class="modal-field">
                <label class="modal-label" for="modal-hide-past">Hide past entries in today</label>
                <input type="checkbox" id="modal-hide-past" class="modal-checkbox" />
            </div>
        </div>
        <div class="modal-actions">
            <button class="modal-btn modal-btn-cancel" id="defaults-cancel">Cancel</button>
            <button class="modal-btn modal-btn-save" id="defaults-save">Save</button>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Populate with current defaults
    document.getElementById('defaults-start-time').value =
        `${String(state.settings.dayStartHour).padStart(2, '0')}:${String(state.settings.dayStartMinute).padStart(2, '0')}`;
    document.getElementById('defaults-end-time').value =
        `${String(state.settings.dayEndHour).padStart(2, '0')}:${String(state.settings.dayEndMinute).padStart(2, '0')}`;

    // Populate hide-past-entries checkbox
    const hidePastCheckbox = document.getElementById('modal-hide-past');
    hidePastCheckbox.checked = state.hidePastEntries;
    hidePastCheckbox.addEventListener('change', () => {
        state.hidePastEntries = hidePastCheckbox.checked;
        localStorage.setItem('hidePastEntries', state.hidePastEntries);
        renderTimeline();
    });

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    // Cancel
    document.getElementById('defaults-cancel').addEventListener('click', () => overlay.remove());

    // Save
    document.getElementById('defaults-save').addEventListener('click', async () => {
        const [sh, sm] = (document.getElementById('defaults-start-time').value || '08:00').split(':').map(Number);
        const [eh, em] = (document.getElementById('defaults-end-time').value || '22:00').split(':').map(Number);
        state.settings.dayStartHour = sh;
        state.settings.dayStartMinute = sm;
        state.settings.dayEndHour = eh;
        state.settings.dayEndMinute = em;
        await api.put('/settings', state.settings);
        overlay.remove();
        renderTimeline();
    });
}

// ─── Event Bindings ───
document.addEventListener('DOMContentLoaded', () => {
    // Skin system
    initSkin();

    // Panel resize (draggable dividers)
    panelResize.init();

    // Load data
    loadAll();

    // Clock
    updateClock();
    setInterval(updateClock, 10000); // Update every 10s

    // Start the idle block real-time updater
    startIdleUpdater();

    // Set up the always-visible action input
    setupActionInput();

    // Settings button in top bar
    document.getElementById('settings-btn').addEventListener('click', () => openDefaultsModal());

    // Show-done toggle (default: OFF = done items hidden)
    state.showDone = localStorage.getItem('showDone') === 'true';
    const hideDoneBtn = document.getElementById('hide-done-btn');
    hideDoneBtn.classList.toggle('active', state.showDone);
    hideDoneBtn.title = state.showDone ? 'Hide done' : 'Show done';
    hideDoneBtn.addEventListener('click', () => {
        state.showDone = !state.showDone;
        localStorage.setItem('showDone', state.showDone);
        hideDoneBtn.classList.toggle('active', state.showDone);
        hideDoneBtn.title = state.showDone ? 'Hide done' : 'Show done';
        renderAll();
    });

    // Date nav buttons — renderAll() so actions list updates with time context
    document.getElementById('date-nav-prev').addEventListener('click', () => {
        const d = new Date(state.timelineViewDate);
        d.setDate(d.getDate() - 1);
        state.timelineViewDate = d;
        localStorage.setItem('timelineViewDate', d.toISOString());
        renderAll();
    });
    document.getElementById('date-nav-next').addEventListener('click', () => {
        const d = new Date(state.timelineViewDate);
        d.setDate(d.getDate() + 1);
        state.timelineViewDate = d;
        renderAll();
    });
    // Click on date text to jump back to today
    document.getElementById('date-nav-date').addEventListener('click', () => {
        state.timelineViewDate = getLogicalToday();
        localStorage.setItem('timelineViewDate', state.timelineViewDate.toISOString());
        renderAll();
    });

    // Restore hide-past-entries preference from localStorage
    state.hidePastEntries = localStorage.getItem('hidePastEntries') === 'true';

    // Streak check-in button
    document.getElementById('streak-checkin-btn').addEventListener('click', () => performCheckIn());

    // Quick log
    document.getElementById('quick-log-btn').addEventListener('click', handleQuickLog);
    document.getElementById('quick-log-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleQuickLog();
    });

    // ─── Project Search ───
    const projectSearchInput = document.getElementById('project-search-input');
    const projectSearchClear = document.getElementById('project-search-clear');
    const projectSearchBar = document.getElementById('project-search');
    const projectSearchToggle = document.getElementById('project-search-toggle');
    let projectSearchTimer = null;

    projectSearchClear.style.display = 'none'; // hidden by default

    function openProjectSearch() {
        projectSearchBar.classList.remove('project-search-hidden');
        projectSearchToggle.classList.add('active');
        // Focus after the CSS transition starts
        requestAnimationFrame(() => projectSearchInput.focus());
    }

    function closeProjectSearch() {
        projectSearchBar.classList.add('project-search-hidden');
        projectSearchToggle.classList.remove('active');
        projectSearchInput.value = '';
        state.projectSearchQuery = '';
        renderProjects();
    }

    projectSearchToggle.addEventListener('click', () => {
        const isHidden = projectSearchBar.classList.contains('project-search-hidden');
        if (isHidden) {
            openProjectSearch();
        } else {
            closeProjectSearch();
        }
    });

    projectSearchInput.addEventListener('input', () => {
        clearTimeout(projectSearchTimer);
        projectSearchTimer = setTimeout(() => {
            state.projectSearchQuery = projectSearchInput.value;
            renderProjects();
        }, 150); // 150ms debounce for responsive feel
    });

    projectSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeProjectSearch();
        }
    });

    projectSearchClear.addEventListener('click', () => {
        if (projectSearchInput.value) {
            // Clear text but keep bar open
            projectSearchInput.value = '';
            state.projectSearchQuery = '';
            renderProjects();
            projectSearchInput.focus();
        } else {
            // Already empty — close the bar
            closeProjectSearch();
        }
    });
});
