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
    pastDisplayMode: 'show', // 'hide' | 'show' — whether past entries are visible in timeline
    pastCardStyle: 'compact', // 'compact' | 'full' — card style for past entries (configured in Settings)
    showDone: false, // when true, done items are visible in actions and project tree
    scheduleFilter: 'scheduled+unscheduled', // 'scheduled' | 'scheduled+unscheduled' | 'all'
    viewHorizon: 'day', // 'day' | 'week' | 'epoch' | 'session' — horizon level for timeline navigation
    epochFilter: 'ongoing', // 'past' | 'ongoing' | 'future' — which sub-epoch is active at epoch horizon
    ongoingPastWeeks: 1, // how many weeks back from current week Ongoing extends
    ongoingFutureWeeks: 4, // how many weeks forward from current week Ongoing extends
    sessionIndex: 0, // index into buildPlanSegments() — which session is active at session horizon
    projectSearchQuery: '', // current search term for the project tree
    workingOn: null, // { itemId, itemName, projectName, startTime } — active work timer
    onBreak: null, // { startTime } — active break timer
    focusStack: [], // array of { startMs, endMs, label, type, icon, tier } — multi-tier focus stack
    lastLogicalDayKey: null, // tracks the current logical day for rollover detection
    lastSessionCleanupMinute: null, // throttles session cleanup to once per minute
    selectedActionIds: new Set(), // multiselect for actions
    selectionAnchor: null, // last manually toggled action ID (for shift-click range)
    divergenceBannerExpanded: false, // whether the top-level banner summary is expanded
    divergencePlansExpanded: new Set(), // set of plan entry IDs whose segments are expanded
    settings: {
        dayStartHour: 8,
        dayStartMinute: 0,
        dayEndHour: 22,
        dayEndMinute: 0,
        dayOverrides: {}, // { "2026-02-09": { dayStartHour, dayStartMinute, dayEndHour, dayEndMinute } }
        weekStartDay: 0, // 0=Sun, 1=Mon, ..., 6=Sat
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

// Fire-and-forget preference save to backend
function savePref(key, value) {
    api.put('/preferences', { [key]: value });
}

// Persist focusStack to backend (fire-and-forget)
function saveFocusStack() {
    savePref('focusStack', state.focusStack);
}
function clearFocusStack() {
    state.focusStack = [];
    saveFocusStack();
}

// ─── Load Data ───
async function loadAll() {
    const [items, timeline, prefs] = await Promise.all([
        api.get('/items'),
        api.get('/timeline'),
        api.get('/preferences').catch(() => ({})),
    ]);
    state.items = items;
    state.timeline = timeline;
    // Load settings
    try {
        const s = await api.get('/settings');
        state.settings = { ...state.settings, ...s };
    } catch { /* use defaults */ }
    ensureInbox();

    // Restore preferences from backend
    if (prefs.selectedItemId) {
        const id = parseInt(prefs.selectedItemId, 10);
        if (findItemById(id)) {
            state.selectedItemId = id;
        }
    }
    if (prefs.timelineViewDate) {
        state.timelineViewDate = new Date(prefs.timelineViewDate);
    } else {
        state.timelineViewDate = getLogicalToday();
    }
    if (prefs.workingOn) {
        state.workingOn = prefs.workingOn;
    }
    if (prefs.onBreak) {
        state.onBreak = prefs.onBreak;
    }
    // Migration: old 3-state pastDisplayMode → new 2-state (hide/show)
    if (prefs.pastDisplayMode === 'hide') {
        state.pastDisplayMode = 'hide';
    } else {
        state.pastDisplayMode = 'show';
    }
    // Restore card style preference (compact or full)
    if (prefs.pastCardStyle === 'full' || prefs.pastCardStyle === 'compact') {
        state.pastCardStyle = prefs.pastCardStyle;
    } else if (prefs.pastDisplayMode === 'full') {
        // Migration: old 'full' mode → pastCardStyle = 'full'
        state.pastCardStyle = 'full';
    } else {
        state.pastCardStyle = 'compact';
    }
    state.showDone = prefs.showDone === true;
    const validFilters = ['scheduled', 'scheduled+unscheduled', 'all'];
    state.scheduleFilter = validFilters.includes(prefs.scheduleFilter) ? prefs.scheduleFilter : 'scheduled+unscheduled';
    const validHorizons = ['day', 'week', 'epoch', 'session'];
    state.viewHorizon = validHorizons.includes(prefs.viewHorizon) ? prefs.viewHorizon : 'day';
    const validEpochs = ['past', 'ongoing', 'future'];
    state.epochFilter = validEpochs.includes(prefs.epochFilter) ? prefs.epochFilter : 'ongoing';
    if (typeof prefs.ongoingPastWeeks === 'number' && prefs.ongoingPastWeeks >= 0) state.ongoingPastWeeks = prefs.ongoingPastWeeks;
    if (typeof prefs.ongoingFutureWeeks === 'number' && prefs.ongoingFutureWeeks >= 0) state.ongoingFutureWeeks = prefs.ongoingFutureWeeks;
    if (typeof prefs.sessionIndex === 'number') state.sessionIndex = prefs.sessionIndex;
    state.collapsedGroups = new Set(prefs.collapsedGroups || []);
    state.weekCollapsedDays = prefs.weekCollapsedDays || {};
    // Restore week group expand state: stored as { key: [...ids] }, convert to { key: Set }
    const rawWEG = prefs.weekExpandedGroups || {};
    state._weekExpandedGroups = {};
    for (const [k, v] of Object.entries(rawWEG)) state._weekExpandedGroups[k] = new Set(v);
    // Restore focusStack
    if (Array.isArray(prefs.focusStack) && prefs.focusStack.length > 0) {
        state.focusStack = prefs.focusStack;
    }
    // Restore divergence banner collapse state
    state.divergenceBannerExpanded = prefs.divergenceBannerExpanded || false;
    state.divergencePlansExpanded = new Set(prefs.divergencePlansExpanded || []);
    // Restore project tree scroll position
    if (typeof prefs.projectTreeScrollTop === 'number') {
        state._pendingProjectTreeScroll = prefs.projectTreeScrollTop;
    }

    // Auto-clean past schedules (fire-and-forget, don't block render)
    cleanPastSchedules();
    migrateEmptyTimeContexts();
    migrateSomedayToOngoing();
    renderAll();
    // Apply saved project tree scroll position after initial render
    if (state._pendingProjectTreeScroll != null) {
        const pt = document.getElementById('project-tree');
        if (pt) pt.scrollTop = state._pendingProjectTreeScroll;
        delete state._pendingProjectTreeScroll;
    }
    syncSettingsUI();
    syncToggleUI();
    // Render streak widget with loaded settings
    renderStreak();
}

// Sync the schedule-filter button appearance with the current state
function syncScheduleFilterBtn(btn) {
    if (state.scheduleFilter === 'scheduled') {
        btn.textContent = '📅';
        btn.classList.add('active');
        btn.title = 'Scheduled only';
    } else if (state.scheduleFilter === 'all') {
        btn.textContent = '🗓️';
        btn.classList.add('active');
        btn.title = 'All items';
    } else {
        // 'scheduled+unscheduled' — default
        btn.textContent = '📅';
        btn.classList.remove('active');
        btn.title = 'Scheduled + anytime';
    }
}

// Sync toggle button visuals with state (called after loadAll prefs are loaded)
function syncToggleUI() {
    const hideDoneBtn = document.getElementById('hide-done-btn');
    if (hideDoneBtn) {
        hideDoneBtn.classList.toggle('active', state.showDone);
        hideDoneBtn.title = state.showDone ? 'Hide done' : 'Show done';
    }
    const hidePastBtn = document.getElementById('hide-past-btn');
    if (hidePastBtn) {
        syncPastDisplayBtn(hidePastBtn);
    }
    const showUnschedBtn = document.getElementById('show-unscheduled-btn');
    if (showUnschedBtn) {
        syncScheduleFilterBtn(showUnschedBtn);
    }
}

// Sync past-display button icon/title based on 2-state pastDisplayMode
function syncPastDisplayBtn(btn) {
    const hidden = state.pastDisplayMode === 'hide';
    btn.textContent = hidden ? '👁' : '⏳';
    btn.title = hidden ? 'Show past' : 'Hide past';
    btn.classList.toggle('active', !hidden);
}

// Convenience: check if we should hide past entries entirely
function isPastHidden() { return state.pastDisplayMode === 'hide'; }
// Convenience: check if past entries should render in compact mode
function isPastCompact() { return state.pastCardStyle === 'compact'; }

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
    // ── Day rollover detection ──
    // If the logical day has changed since last render, clean past schedules
    const currentDayKey = getDateKey(getLogicalToday());
    if (state.lastLogicalDayKey && state.lastLogicalDayKey !== currentDayKey) {
        state.lastLogicalDayKey = currentDayKey;
        state.lastSessionCleanupMinute = null; // reset session throttle on new day
        cleanPastSchedules(); // async but fire-and-forget, same as on load
    }
    state.lastLogicalDayKey = currentDayKey;

    // ── Session rollover detection (throttled to once per minute) ──
    const nowForSession = new Date();
    const sessionMinuteKey = `${nowForSession.getHours()}:${nowForSession.getMinutes()}`;
    if (state.lastSessionCleanupMinute !== sessionMinuteKey) {
        state.lastSessionCleanupMinute = sessionMinuteKey;
        cleanPastSessions(nowForSession);
    }

    renderProjects();
    renderActions();
    renderTimeline();
    renderTimeContext();
    renderHorizonTower();
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

// ── Shared Autocomplete with Create ──
// Used by plan editor, idle-work editor, and past-entry editor.
// Returns { getSelected, setSelected } so callers can read/write selectedAction.
function setupAutocomplete(actionInput, suggestions, { onSelect, allowCreate = true, allowFreeText = false, scopeItemId = null } = {}) {
    let selectedAction = null;
    let allActions = collectAllItems().filter(a => !a.done);
    // Scope autocomplete to descendants of a specific item (for item-bound planned sessions)
    if (scopeItemId) {
        const scopeItem = findItemById(scopeItemId);
        if (scopeItem) {
            const descendantIds = new Set(collectDescendantIds(scopeItem));
            allActions = allActions.filter(a => descendantIds.has(a.id));
        }
    }
    let isParentMode = false;
    let createName = '';

    // ── Linked-item clear button ──
    const clearBtn = document.createElement('button');
    clearBtn.className = 'plan-editor-clear-btn';
    clearBtn.type = 'button';
    clearBtn.textContent = '×';
    clearBtn.title = 'Unlink item';
    clearBtn.style.display = 'none';
    actionInput.parentElement.appendChild(clearBtn);

    function updateLinkedState() {
        if (selectedAction) {
            actionInput.classList.add('plan-editor-input-linked');
            clearBtn.style.display = '';
        } else {
            actionInput.classList.remove('plan-editor-input-linked');
            clearBtn.style.display = 'none';
        }
    }

    clearBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedAction = null;
        actionInput.value = '';
        updateLinkedState();
        actionInput.focus();
    });

    // ── Build hierarchical tree for parent selector ──
    function buildParentTree(items, depth = 0, filter = '') {
        const result = [];
        for (const item of items) {
            if (item.isInbox) continue;
            if (item.done) continue;
            const matchesFilter = !filter || item.name.toLowerCase().includes(filter.toLowerCase());
            const childResults = item.children ? buildParentTree(item.children, depth + 1, filter) : [];
            if (matchesFilter || childResults.length > 0) {
                result.push({ item, depth, hasChildren: !!(item.children && item.children.length > 0) });
                result.push(...childResults);
            }
        }
        return result;
    }

    function renderParentSelector() {
        suggestions.innerHTML = '';
        suggestions.style.display = 'block';

        // Header with back arrow
        const header = document.createElement('div');
        header.className = 'plan-editor-parent-header';
        const backBtn = document.createElement('span');
        backBtn.className = 'plan-editor-parent-back';
        backBtn.textContent = '←';
        backBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isParentMode = false;
            renderSuggestions(actionInput.value);
        });
        const headerText = document.createElement('span');
        headerText.className = 'plan-editor-parent-title';
        headerText.textContent = `Creating: "${createName}"`;
        header.appendChild(backBtn);
        header.appendChild(headerText);
        suggestions.appendChild(header);

        // Filter input
        const filterInput = document.createElement('input');
        filterInput.className = 'plan-editor-parent-filter';
        filterInput.placeholder = 'Filter parents...';
        filterInput.type = 'text';
        filterInput.addEventListener('mousedown', (e) => e.stopPropagation());
        filterInput.addEventListener('input', () => renderTreeItems(filterInput.value));
        suggestions.appendChild(filterInput);

        // Tree container
        const treeContainer = document.createElement('div');
        treeContainer.className = 'plan-editor-parent-tree';
        suggestions.appendChild(treeContainer);

        function renderTreeItems(filter = '') {
            treeContainer.innerHTML = '';

            // Root option (no parent)
            const rootRow = document.createElement('div');
            rootRow.className = 'plan-editor-parent-item';
            rootRow.textContent = '📥 Root (no parent)';
            rootRow.addEventListener('mousedown', async (e) => {
                e.preventDefault();
                await createItem(null);
            });
            treeContainer.appendChild(rootRow);

            const tree = buildParentTree(state.items.items, 0, filter);
            for (const { item, depth } of tree) {
                const row = document.createElement('div');
                row.className = 'plan-editor-parent-item';
                row.style.paddingLeft = `${10 + depth * 16}px`;
                const prefix = (item.children && item.children.length > 0) ? '▸ ' : '';
                row.textContent = prefix + item.name;
                row.addEventListener('mousedown', async (e) => {
                    e.preventDefault();
                    await createItem(item.id);
                });
                treeContainer.appendChild(row);
            }
        }

        renderTreeItems();
        // Focus filter after a tick to avoid losing the dropdown
        setTimeout(() => filterInput.focus(), 0);
    }

    async function createItem(parentId) {
        const name = createName.trim();
        if (!name) return;

        // Create the item
        await api.post('/items', { name, parentId, timeContexts: getCurrentTimeContexts() });
        // Reload items data but DON'T re-render timeline (it would destroy this editor)
        state.items = await api.get('/items');
        renderProjects();
        renderActions();

        // Find the newly created item
        const freshActions = collectAllItems().filter(a => !a.done);
        const created = freshActions.find(a => a.name === name);
        if (created) {
            selectedAction = created;
            actionInput.value = created.name;
            updateLinkedState();
            if (onSelect) onSelect(created);
        }

        isParentMode = false;
        suggestions.style.display = 'none';
    }

    const renderSuggestions = (query) => {
        if (isParentMode) {
            renderParentSelector();
            return;
        }
        suggestions.innerHTML = '';
        if (!query) {
            suggestions.style.display = 'none';
            return;
        }
        const q = query.toLowerCase();
        const matches = allActions.filter(a => a.name.toLowerCase().includes(q));

        // Show dropdown if we have matches or if allowCreate/allowFreeText is on
        if (matches.length === 0 && !allowCreate && !allowFreeText) {
            suggestions.style.display = 'none';
            return;
        }
        suggestions.style.display = 'block';

        // Free-text row: allow using typed text as a standalone session title
        if (allowFreeText && query.trim()) {
            const freeRow = document.createElement('div');
            freeRow.className = 'plan-editor-suggestion plan-editor-suggestion-free';

            const freeText = document.createElement('span');
            freeText.className = 'plan-editor-suggestion-name';
            freeText.innerHTML = `📌 <strong>${query.trim()}</strong>`;
            freeRow.appendChild(freeText);

            const freeHint = document.createElement('span');
            freeHint.className = 'plan-editor-suggestion-project';
            freeHint.textContent = 'standalone session';
            freeRow.appendChild(freeHint);

            freeRow.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectedAction = null;
                updateLinkedState();
                suggestions.style.display = 'none';
            });
            suggestions.appendChild(freeRow);
        }

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
                updateLinkedState();
                suggestions.style.display = 'none';
                if (onSelect) onSelect(action);
            });
            suggestions.appendChild(opt);
        }

        // Create row (always at bottom when allowCreate is on and there's text)
        if (allowCreate && query.trim()) {
            const createRow = document.createElement('div');
            createRow.className = 'plan-editor-suggestion plan-editor-suggestion-create';

            const createText = document.createElement('span');
            createText.className = 'plan-editor-suggestion-name';
            createText.innerHTML = `➕ Create "<strong>${query.trim()}</strong>"`;
            createRow.appendChild(createText);

            createRow.addEventListener('mousedown', (e) => {
                e.preventDefault();
                createName = query.trim();
                isParentMode = true;
                renderParentSelector();
            });
            suggestions.appendChild(createRow);
        }
    };

    actionInput.addEventListener('input', () => {
        selectedAction = null;
        updateLinkedState();
        if (isParentMode) {
            isParentMode = false;
        }
        renderSuggestions(actionInput.value);
    });

    actionInput.addEventListener('focus', () => {
        if (actionInput.value && !selectedAction) {
            renderSuggestions(actionInput.value);
        }
    });

    actionInput.addEventListener('blur', () => {
        // Longer delay when in parent mode so clicks can register
        const delay = isParentMode ? 300 : 150;
        setTimeout(() => {
            if (!isParentMode) {
                suggestions.style.display = 'none';
            }
        }, delay);
    });

    // Ctrl/Cmd + Enter: quick-create under root
    actionInput.addEventListener('keydown', async (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && allowCreate) {
            const text = actionInput.value.trim();
            if (text && !selectedAction) {
                e.preventDefault();
                createName = text;
                await createItem(null);
            }
        }
    });

    return {
        getSelected: () => selectedAction,
        setSelected: (action) => { selectedAction = action; updateLinkedState(); },
    };
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

// ─── Goal Utilities ───

// Collect all descendant leaves from an item (for done-goal progress)
function collectDescendantLeaves(item) {
    if (isLeaf(item)) return [item];
    const leaves = [];
    if (item.children) {
        for (const child of item.children) {
            leaves.push(...collectDescendantLeaves(child));
        }
    }
    return leaves;
}

// Calculate progress for a Done goal
function calculateDoneProgress(item) {
    const leaves = collectDescendantLeaves(item);
    const total = leaves.length;
    const done = leaves.filter(l => l.done).length;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return { type: 'done', done, total, percent, label: `${done}/${total}` };
}

// Calculate progress for a Time goal
function calculateTimeProgress(item) {
    const target = item.goal.target || 0; // target in seconds
    const descendantIds = collectDescendantIds(item);
    // Sum all work entries for this item or its descendants
    let trackedMs = 0;
    for (const entry of state.timeline.entries) {
        if (entry.type === 'work' && entry.itemId && descendantIds.includes(entry.itemId)) {
            trackedMs += (entry.endTime || entry.timestamp) - entry.timestamp;
        }
    }
    const trackedSec = Math.floor(trackedMs / 1000);
    const percent = target > 0 ? Math.min(100, Math.round((trackedSec / target) * 100)) : 0;
    // Format label
    const formatTime = (s) => {
        if (s >= 3600) return `${(s / 3600).toFixed(1)}h`;
        if (s >= 60) return `${Math.floor(s / 60)}m`;
        return `${s}s`;
    };
    return { type: 'time', tracked: trackedSec, target, percent, label: `${formatTime(trackedSec)} / ${formatTime(target)}` };
}

// Get goal progress for an item (dispatcher)
function getGoalProgress(item) {
    if (!item || !item.goal) return null;
    if (item.goal.type === 'done') return calculateDoneProgress(item);
    if (item.goal.type === 'time') return calculateTimeProgress(item);
    return null;
}

// Find the nearest ancestor (or self) with a goal, given an action's _path
function findNearestGoal(action) {
    if (!action._path) return null;
    // Walk from leaf to root (reverse path) to find nearest goal
    for (let i = action._path.length - 1; i >= 0; i--) {
        const ancestor = findItemById(action._path[i].id);
        if (ancestor && ancestor.goal) return ancestor;
    }
    return null;
}

// Check if an action has an active goal (itself or via ancestor)
function hasActiveGoal(action) {
    return findNearestGoal(action) !== null;
}

// ─── Time Context Utilities ───

// Epoch-level contexts — coarser-than-day temporal horizons
const EPOCH_CONTEXTS = ['past', 'ongoing', 'future'];
function isEpochContext(ctx) { return EPOCH_CONTEXTS.includes(ctx) || isWeekContext(ctx); }

// Week-level context: "week:2026-W07"
function isWeekContext(ctx) { return typeof ctx === 'string' && /^week:\d{4}-(?:W\d{2}|\d{2}-\d{2})$/.test(ctx); }

// Get ISO week key from a Date: "week:2026-W07"
function getWeekKey(date) {
    const wsd = state.settings.weekStartDay ?? 0; // 0=Sun default
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    // Roll back to the start of the week
    const diff = (d.getDay() - wsd + 7) % 7;
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - diff);
    // Use the week-start date as the key: week:YYYY-MM-DD
    return `week:${getDateKey(weekStart)}`;
}

// Get date range for a week key
function getWeekDateRange(weekKey) {
    const m = weekKey.match(/^week:(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
        // Legacy ISO format fallback: week:YYYY-WNN
        const mIso = weekKey.match(/^week:(\d{4})-W(\d{2})$/);
        if (!mIso) return null;
        const year = parseInt(mIso[1], 10);
        const week = parseInt(mIso[2], 10);
        const jan4 = new Date(year, 0, 4);
        const dayOfWeek = jan4.getDay() || 7;
        const mon = new Date(jan4);
        mon.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
        const sun = new Date(mon);
        sun.setDate(mon.getDate() + 6);
        return { start: mon, end: sun };
    }
    const start = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
}

// Check if a date falls within a given week key
function dateInWeek(dateKey, weekKey) {
    const range = getWeekDateRange(weekKey);
    if (!range) return false;
    const startKey = getDateKey(range.start);
    const endKey = getDateKey(range.end);
    return dateKey >= startKey && dateKey <= endKey;
}

// Offset a week key by N weeks: offsetWeekKey('week:2026-02-10', 2) → key 2 weeks later
function offsetWeekKey(weekKey, weeks) {
    const range = getWeekDateRange(weekKey);
    if (!range) return weekKey;
    const d = new Date(range.start);
    d.setDate(d.getDate() + weeks * 7);
    return getWeekKey(d);
}

// Get the week range for an epoch based on Ongoing relative offsets.
// Returns { startWeek, endWeek } — null means unbounded in that direction.
function getEpochWeekRange(epochName) {
    const currentWeek = getWeekKey(getLogicalToday());
    const startWeek = offsetWeekKey(currentWeek, -state.ongoingPastWeeks);
    const endWeek = offsetWeekKey(currentWeek, state.ongoingFutureWeeks);
    if (epochName === 'ongoing') return { startWeek, endWeek };
    if (epochName === 'past') return { startWeek: null, endWeek: offsetWeekKey(startWeek, -1) };
    if (epochName === 'future') return { startWeek: offsetWeekKey(endWeek, 1), endWeek: null };
    return { startWeek: null, endWeek: null };
}

// Check if a week key falls within an epoch's range
function isWeekInEpoch(weekKey, epochName) {
    const { startWeek, endWeek } = getEpochWeekRange(epochName);
    if (startWeek && weekKey < startWeek) return false;
    if (endWeek && weekKey > endWeek) return false;
    return true;
}

// When navigating weeks, auto-switch epochFilter if we cross a boundary
function _syncEpochForCurrentWeek() {
    const wk = getWeekKey(state.timelineViewDate);
    for (const ep of EPOCH_CONTEXTS) {
        if (isWeekInEpoch(wk, ep)) {
            if (state.epochFilter !== ep) {
                state.epochFilter = ep;
                savePref('epochFilter', ep);
            }
            return;
        }
    }
}

// Check if an item belongs to a given week (has week context OR a date within the week)
function isItemInWeek(item, weekKey) {
    if (!item) return false;
    const tcs = item.timeContexts || [];
    if (tcs.includes(weekKey)) return true;
    // Backward projection: check if a deadline shadow covers this week
    if (_deadlineShadowMatchesWeek(item, weekKey)) return true;
    // Don't show items that have a specific day assigned — they show in day rows
    return false;
}

// Parse a context string into components
// "ongoing" → { epoch: "ongoing" }
// "week:2026-W07" → { week: "2026-W07" }
// "2026-02-10" → { date: "2026-02-10" }
// "2026-02-10@10:00-12:00" → { date: "2026-02-10", segment: { start: "10:00", end: "12:00" } }
// "2026-02-10@entry:abc123" → { date: "2026-02-10", entryId: "abc123" }
function parseTimeContext(ctx) {
    if (!ctx || typeof ctx !== 'string') return null;
    if (EPOCH_CONTEXTS.includes(ctx)) return { epoch: ctx };
    if (isWeekContext(ctx)) return { week: ctx.substring(5) }; // strip "week:" prefix
    const atIdx = ctx.indexOf('@');
    if (atIdx === -1) return { date: ctx };
    const date = ctx.substring(0, atIdx);
    const suffix = ctx.substring(atIdx + 1);
    if (suffix.startsWith('entry:')) {
        return { date, entryId: suffix.substring(6) };
    }
    // Segment range: "HH:MM-HH:MM"
    const match = suffix.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (match) {
        return { date, segment: { start: match[1], end: match[2] } };
    }
    return { date };
}

// Check if a context string matches a date (exact or as prefix via @)
function contextMatchesDate(ctx, dateKey) {
    return ctx === dateKey || ctx.startsWith(dateKey + '@');
}

// Check if an overnight segment is still live (end time hasn't passed yet).
// Returns true if the segment crosses midnight and its real end time is in the future.
function _isOvernightSegmentLive(parsed, now) {
    if (!parsed || !parsed.segment) return false;
    const { start, end } = parsed.segment;
    // Not an overnight segment if end >= start
    if (end >= start) return false;
    // Build actual end timestamp: date + 1 day at end time
    const [sY, sM, sD] = parsed.date.split('-').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const endDate = new Date(sY, sM - 1, sD, endH, endM, 0, 0);
    endDate.setDate(endDate.getDate() + 1); // overnight → next calendar day
    return now < endDate;
}

// Check if an item has any segment-level context (with @) for a given date
function hasSegmentContext(item, dateKey) {
    if (!item || !item.timeContexts) return false;
    return item.timeContexts.some(tc => tc.startsWith(dateKey + '@'));
}

// Build a segment context string from a date and ms timestamps
function buildSegmentContext(dateKey, startMs, endMs) {
    const fmt = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    return `${dateKey}@${fmt(startMs)}-${fmt(endMs)}`;
}

// Build the live context string for a running work or break session
function getLiveContext(type) {
    const dateKey = getDateKey(state.timelineViewDate);
    return `${dateKey}@${type}`;
}

// Add a segment context to an item.
// move (default true): clear all existing timeContexts/contextDurations first (D&D = move).
// seedDuration: if provided, always use this value for the new context's duration.
async function addSegmentContext(itemId, segmentContextStr, seedDuration, { move = true } = {}) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.timeContexts) item.timeContexts = [];
    const parsed = parseTimeContext(segmentContextStr);
    if (!parsed) return;
    if (move) {
        // Move mode: strip all existing contexts and durations
        item.timeContexts = [];
        item.contextDurations = {};
    } else {
        // Additive mode: only remove plain date context (segment subsumes it)
        item.timeContexts = item.timeContexts.filter(tc => tc !== parsed.date);
    }
    // Add segment context if not already present
    if (!item.timeContexts.includes(segmentContextStr)) {
        item.timeContexts.push(segmentContextStr);
    }
    // Seed segment duration — use explicit seed if provided, else fall back
    if (!item.contextDurations) item.contextDurations = {};
    if (seedDuration != null) {
        item.contextDurations[segmentContextStr] = seedDuration;
    } else if (!(segmentContextStr in item.contextDurations)) {
        item.contextDurations[segmentContextStr] = item.estimatedDuration || 0;
    }
    await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}

// Degrade a segment context back to its parent date context.
// Returns the removed context's duration (if any) so callers can migrate it.
async function degradeSegmentContext(itemId, segmentContextStr) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item || !item.timeContexts) return;
    const parsed = parseTimeContext(segmentContextStr);
    if (!parsed) return;
    // Capture the duration before removing so callers can migrate it
    const removedDuration = item.contextDurations?.[segmentContextStr];
    // Remove the segment context
    item.timeContexts = item.timeContexts.filter(tc => tc !== segmentContextStr);
    // Clean up segment duration
    if (item.contextDurations) delete item.contextDurations[segmentContextStr];
    // Seed the removed duration into the parent date context key
    if (removedDuration != null && item.contextDurations) {
        if (!(parsed.date in item.contextDurations)) {
            item.contextDurations[parsed.date] = removedDuration;
        }
    }
    // Add the parent date back if no other context for this date exists
    const hasOtherForDate = item.timeContexts.some(tc => contextMatchesDate(tc, parsed.date));
    if (!hasOtherForDate) {
        item.timeContexts.push(parsed.date);
    }
    const patch = { timeContexts: item.timeContexts };
    if (item.contextDurations) patch.contextDurations = item.contextDurations;
    await api.patch(`/items/${itemId}`, patch);
    renderAll();
    return removedDuration;
}

// Degrade all segment/entry contexts referencing a specific entry ID
async function degradeEntryContexts(entryId) {
    const items = collectAllItems(state.items.items);
    for (const item of items) {
        if (!item.timeContexts) continue;
        const matching = item.timeContexts.filter(tc => {
            const p = parseTimeContext(tc);
            return p && p.entryId === entryId;
        });
        if (matching.length > 0) {
            for (const ctx of matching) {
                await degradeSegmentContext(item.id, ctx);
            }
        }
    }
}

// ─── Plan Segments: derive the ordered session list from day entries ───
// Returns an array of { type, label, startMs, endMs, icon, entryId?, itemId?, segmentKey }
function buildPlanSegments(viewDate) {
    const { dayStart, dayEnd } = getDayBoundaries(viewDate || state.timelineViewDate);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();
    const dateKey = getDateKey(viewDate || state.timelineViewDate);

    // Collect planned entries within the day
    const planned = (state.timeline?.entries || [])
        .filter(e => e.type === 'planned' && e.endTime && e.timestamp >= dayStartMs && e.timestamp < dayEndMs)
        .sort((a, b) => a.timestamp - b.timestamp);

    const segments = [];
    let cursor = dayStartMs;

    const _fmtTime = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    for (const entry of planned) {
        const entryStart = entry.timestamp;
        const entryEnd = entry.endTime;

        // Free gap before this planned entry
        if (entryStart > cursor) {
            segments.push({
                type: 'free',
                label: `Free Time · ${_fmtTime(cursor)}–${_fmtTime(entryStart)}`,
                startMs: cursor,
                endMs: entryStart,
                icon: '✨',
                segmentKey: buildSegmentContext(dateKey, cursor, entryStart),
            });
        }

        // The planned entry itself
        const entryLabel = entry.text || (entry.itemId ? (findItemById(entry.itemId)?.name || 'Planned') : 'Planned');
        segments.push({
            type: 'planned',
            label: `${entryLabel} · ${_fmtTime(entryStart)}–${_fmtTime(entryEnd)}`,
            startMs: entryStart,
            endMs: entryEnd,
            icon: '📋',
            entryId: entry.id,
            itemId: entry.itemId || null,
            segmentKey: `${dateKey}@entry:${entry.id}`,
        });

        cursor = Math.max(cursor, entryEnd);
    }

    // Trailing free gap after last planned entry
    if (cursor < dayEndMs) {
        segments.push({
            type: 'free',
            label: `Free Time · ${_fmtTime(cursor)}–${_fmtTime(dayEndMs)}`,
            startMs: cursor,
            endMs: dayEndMs,
            icon: '✨',
            segmentKey: buildSegmentContext(dateKey, cursor, dayEndMs),
        });
    }

    // Fallback: if no planned entries, the entire day is one free session
    if (segments.length === 0) {
        segments.push({
            type: 'free',
            label: `Free Time · ${_fmtTime(dayStartMs)}–${_fmtTime(dayEndMs)}`,
            startMs: dayStartMs,
            endMs: dayEndMs,
            icon: '✨',
            segmentKey: buildSegmentContext(dateKey, dayStartMs, dayEndMs),
        });
    }

    return segments;
}

// ── Divergence Detection & Resolution ──

// Check if childId is a descendant of ancestorId in the item tree
function _isDescendantOf(childId, ancestorId) {
    if (!childId || !ancestorId) return false;
    const ancestor = findItemById(ancestorId);
    if (!ancestor || !ancestor.children) return false;
    // BFS through ancestor's subtree
    const queue = [...ancestor.children];
    while (queue.length > 0) {
        const node = queue.shift();
        if (node.id === childId) return true;
        if (node.children) queue.push(...node.children);
    }
    return false;
}

// Detects granular divergences between planned timeline and actual reality.
// Returns an array of divergences; plan divergences include per-segment
// breakdown. Manual log entries (manual: true) are treated as authoritative
// and never trigger divergences — resolution works by creating manual logs.
function detectDivergences(allDayEntries, nowMs) {
    const divergences = [];

    const plans = allDayEntries.filter(e =>
        e.type === 'planned' && e.endTime && !e._phantom && e.endTime <= nowMs
    );
    // Include both work and idle entries as coverage (manual idle = confirmed idle)
    const coverageEntries = allDayEntries.filter(e =>
        (e.type === 'work' || e.type === 'idle') && e.endTime
    );

    // ── Plan divergences: decompose each past plan into segments ──
    for (const entry of plans) {
        if (entry._absorbed) continue;

        const planStart = entry.timestamp;
        const planEnd = entry.endTime;
        if (planEnd <= planStart) continue;

        // Find coverage overlapping this plan's window, clipped to plan bounds
        const overlappingCoverage = coverageEntries
            .filter(w => Math.max(w.timestamp, planStart) < Math.min(w.endTime, planEnd))
            .map(w => ({
                entry: w,
                start: Math.max(w.timestamp, planStart),
                end: Math.min(w.endTime, planEnd),
            }))
            .sort((a, b) => a.start - b.start);

        // Build segment breakdown
        const segments = [];
        let cursor = planStart;

        for (const cov of overlappingCoverage) {
            if (cov.start > cursor) {
                segments.push({ type: 'idle', startMs: cursor, endMs: cov.start });
            }
            // Manual entries are always treated as authoritative coverage
            if (cov.entry.manual) {
                segments.push({
                    type: 'covered',
                    startMs: cov.start,
                    endMs: cov.end,
                    workEntry: cov.entry,
                });
            } else {
                const workItemId = cov.entry.itemId;
                const planItemId = entry.itemId;
                const sameProject = planItemId && workItemId &&
                    (String(planItemId) === String(workItemId) || _isDescendantOf(workItemId, planItemId));
                segments.push({
                    type: sameProject ? 'covered' : 'different',
                    startMs: cov.start,
                    endMs: cov.end,
                    workEntry: cov.entry,
                });
            }
            cursor = Math.max(cursor, cov.end);
        }
        if (cursor < planEnd) {
            segments.push({ type: 'idle', startMs: cursor, endMs: planEnd });
        }

        // Filter to only unresolved segments (idle or different)
        const unresolvedSegs = segments.filter(seg => seg.type !== 'covered');

        if (unresolvedSegs.length === 0) continue; // All segments covered

        const divType = overlappingCoverage.length > 0 ? 'partial' : 'skipped';
        divergences.push({ entry, type: divType, segments: unresolvedSegs, allSegments: segments });
    }

    // ── Unplanned work: automatic work entries not covered by any plan ──
    const workEntries = coverageEntries.filter(e => e.type === 'work');
    for (const work of workEntries) {
        if (work.endTime > nowMs) continue;
        if (work.manual) continue; // Manual work is intentional, never "unplanned"

        const hasOverlappingPlan = plans.some(p =>
            Math.max(p.timestamp, work.timestamp) < Math.min(p.endTime, work.endTime)
        );
        if (!hasOverlappingPlan) {
            divergences.push({
                type: 'unplanned',
                workEntry: work,
                startMs: work.timestamp,
                endMs: work.endTime,
            });
        }
    }

    return divergences;
}

// Detects work in the gap between day end and next day's start.
// viewDate = the day currently being displayed.
// Returns divergences with perspective: 'prev-day' (extend end) or 'next-day' (start earlier).
function detectOutOfHoursWork(viewDate, nowMs) {
    const entries = (state.timeline && state.timeline.entries) || [];
    const { dayEnd } = getDayBoundaries(viewDate);
    const dayEndMs = dayEnd.getTime();

    // Find the next day's start
    const nextDay = new Date(viewDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const { dayStart: nextDayStart } = getDayBoundaries(nextDay);
    const nextDayStartMs = nextDayStart.getTime();

    // Also check the previous day's gap (for when viewing the "next day" perspective)
    const prevDay = new Date(viewDate);
    prevDay.setDate(prevDay.getDate() - 1);
    const { dayEnd: prevDayEnd } = getDayBoundaries(prevDay);
    const prevDayEndMs = prevDayEnd.getTime();
    const { dayStart: thisDayStart } = getDayBoundaries(viewDate);
    const thisDayStartMs = thisDayStart.getTime();

    const divergences = [];

    // Work that OVERLAPS with the gap AFTER this day's end (perspective: prev-day → extend end)
    if (nextDayStartMs > dayEndMs) {
        const overlapping = entries.filter(e =>
            e.type === 'work' && e.endTime &&
            e.endTime > dayEndMs && e.timestamp < nextDayStartMs &&
            e.endTime <= nowMs
        );
        for (const work of overlapping) {
            // Clip to the gap — only the out-of-hours portion matters
            const oohStart = Math.max(work.timestamp, dayEndMs);
            const oohEnd = Math.min(work.endTime, nextDayStartMs);
            divergences.push({
                type: 'out-of-hours',
                perspective: 'prev-day',
                workEntry: work,
                startMs: oohStart,
                endMs: oohEnd,
                gapStart: dayEndMs,
                gapEnd: nextDayStartMs,
                dayDate: viewDate,
            });
        }
    }

    // Work that OVERLAPS with the gap BEFORE this day's start (perspective: next-day → start earlier)
    if (thisDayStartMs > prevDayEndMs) {
        const overlapping = entries.filter(e =>
            e.type === 'work' && e.endTime &&
            e.endTime > prevDayEndMs && e.timestamp < thisDayStartMs &&
            e.endTime <= nowMs
        );
        for (const work of overlapping) {
            const oohStart = Math.max(work.timestamp, prevDayEndMs);
            const oohEnd = Math.min(work.endTime, thisDayStartMs);
            divergences.push({
                type: 'out-of-hours',
                perspective: 'next-day',
                workEntry: work,
                startMs: oohStart,
                endMs: oohEnd,
                gapStart: prevDayEndMs,
                gapEnd: thisDayStartMs,
                dayDate: viewDate,
            });
        }
    }

    return divergences;
}
// ── Resolution functions ──
// Resolution works by creating/marking manual log entries so that
// detectDivergences naturally finds them as authoritative coverage.
// Plans are NEVER modified or deleted.

// Accept Log for a single idle segment — create a manual idle entry
async function _resolveSegmentAcceptLog_Idle(planEntry, seg) {
    const planName = planEntry.text || 'Planned session';
    const durationMs = seg.endMs - seg.startMs;
    const durStr = _fmtDuration(durationMs);

    await api.post('/timeline', {
        text: 'Idle',
        type: 'idle',
        manual: true,
        startTime: seg.startMs,
        endTime: seg.endMs,
    });

    state.timeline = await api.get('/timeline');
    renderAll();
}

// Accept Log for a single different-work segment — mark the work entry as manual
async function _resolveSegmentAcceptLog_Different(seg) {
    const workEntry = seg.workEntry;
    if (!workEntry) return;

    await api.patch(`/timeline/${workEntry.id}`, { manual: true });

    state.timeline = await api.get('/timeline');
    renderAll();
}

// Accept Log for ALL segments of a plan at once
async function _resolveAllSegmentsAsLog(divergence) {
    for (const seg of (divergence.allSegments || divergence.segments || [])) {
        if (seg.type === 'covered') continue;
        if (seg.type === 'idle') {
            await _resolveSegmentAcceptLog_Idle(divergence.entry, seg);
        } else if (seg.type === 'different') {
            await _resolveSegmentAcceptLog_Different(seg);
        }
    }
    // Reload once at the end (individual functions already reload, but ensure consistency)
    state.timeline = await api.get('/timeline');
    renderAll();
}

// Accept unplanned work — mark it as manual (intentional)
async function resolveDivergenceAcceptUnplanned(workEntryId) {
    await api.patch(`/timeline/${workEntryId}`, { manual: true });

    state.timeline = await api.get('/timeline');
    renderAll();
}

// Accept Plan for idle segment — create retroactive manual work entry for the gap
async function _resolveSegmentAcceptPlan_Idle(planEntry, seg) {
    const planName = planEntry.text || 'Planned session';
    const itemId = planEntry.itemId || null;
    const projectName = planEntry.projectName || null;
    const durationMs = seg.endMs - seg.startMs;
    const durStr = _fmtDuration(durationMs);

    await api.post('/timeline', {
        text: `Worked on: ${planName} (${durStr})`,
        projectName,
        type: 'work',
        manual: true,
        startTime: seg.startMs,
        endTime: seg.endMs,
        itemId,
    });

    state.timeline = await api.get('/timeline');
    renderAll();
}

// Accept Plan for different-work segment — re-attribute the work entry to the planned project
async function _resolveSegmentAcceptPlan_Different(planEntry, seg) {
    const planName = planEntry.text || 'Planned session';
    const workEntry = seg.workEntry;
    if (!workEntry) return;

    const durationMs = workEntry.endTime - workEntry.timestamp;
    const durStr = _fmtDuration(durationMs);

    await api.patch(`/timeline/${workEntry.id}`, {
        text: `Worked on: ${planName} (${durStr})`,
        itemId: planEntry.itemId || null,
        projectName: planEntry.projectName || null,
        manual: true,
    });

    state.timeline = await api.get('/timeline');
    renderAll();
}

// Accept Plan for ALL idle segments of a plan at once
async function resolveDivergenceDidIt(entry) {
    const planName = entry.text || 'Planned session';
    const itemId = entry.itemId || null;
    const projectName = entry.projectName || null;
    const planStart = entry.timestamp;
    const planEnd = entry.endTime;

    // Find coverage overlapping this plan to compute uncovered gaps
    const coverageEntries = ((state.timeline && state.timeline.entries) || [])
        .filter(e => (e.type === 'work' || e.type === 'idle') && e.endTime &&
            Math.max(e.timestamp, planStart) < Math.min(e.endTime, planEnd));

    // Build covered intervals (merge overlapping coverage)
    const covered = coverageEntries
        .map(e => [Math.max(e.timestamp, planStart), Math.min(e.endTime, planEnd)])
        .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of covered) {
        if (merged.length && s <= merged[merged.length - 1][1]) {
            merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
        } else {
            merged.push([s, e]);
        }
    }

    const gaps = [];
    let cursor = planStart;
    for (const [s, e] of merged) {
        if (s > cursor) gaps.push([cursor, s]);
        cursor = Math.max(cursor, e);
    }
    if (cursor < planEnd) gaps.push([cursor, planEnd]);

    for (const [gapStart, gapEnd] of gaps) {
        const durationMs = gapEnd - gapStart;
        const durStr = _fmtDuration(durationMs);
        await api.post('/timeline', {
            text: `Worked on: ${planName} (${durStr})`,
            projectName,
            type: 'work',
            manual: true,
            startTime: gapStart,
            endTime: gapEnd,
            itemId,
        });
    }

    // Also mark any non-manual different-work entries as manual (user confirmed the plan)
    for (const ce of coverageEntries) {
        if (ce.type === 'work' && !ce.manual) {
            await api.patch(`/timeline/${ce.id}`, {
                text: `Worked on: ${planName} (${_fmtDuration(ce.endTime - ce.timestamp)})`,
                itemId: itemId,
                projectName: projectName,
                manual: true,
            });
        }
    }

    state.timeline = await api.get('/timeline');
    renderAll();
}

async function resolveDivergenceReschedule(entry, target) {
    // Rescheduling creates a NEW plan and covers the old time with a manual idle log.
    // The original plan entry is never deleted.
    const planStart = entry.timestamp;
    const planEnd = entry.endTime;
    const duration = planEnd - planStart;
    const planName = entry.text || 'Planned session';

    // Create manual idle log for the original time slot
    await api.post('/timeline', {
        text: 'Idle',
        type: 'idle',
        manual: true,
        startTime: planStart,
        endTime: planEnd,
    });

    // Create the new plan entry at the target time
    if (target === 'drop') {
        // Drop = just cover original with idle, no new plan
        await degradeEntryContexts(entry.id);
    } else if (target === 'tomorrow') {
        const tomorrow = new Date(planStart);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const newStart = tomorrow.getTime();
        const newEnd = newStart + duration;
        await api.post('/timeline', {
            text: entry.text,
            type: 'planned',
            startTime: newStart,
            endTime: newEnd,
            itemId: entry.itemId || null,
            projectName: entry.projectName || null,
        });
    } else if (target === 'later') {
        const segments = buildPlanSegments();
        const nowMs = Date.now();
        let slotFound = false;
        for (const seg of segments) {
            if (seg.type !== 'free') continue;
            if (seg.endMs <= nowMs) continue;
            const slotStart = Math.max(seg.startMs, nowMs);
            if (seg.endMs - slotStart >= duration) {
                const newEnd = slotStart + duration;
                await api.post('/timeline', {
                    text: entry.text,
                    type: 'planned',
                    startTime: slotStart,
                    endTime: newEnd,
                    itemId: entry.itemId || null,
                    projectName: entry.projectName || null,
                });
                slotFound = true;
                break;
            }
        }
        if (!slotFound) return resolveDivergenceReschedule(entry, 'tomorrow');
    }

    state.timeline = await api.get('/timeline');
    renderAll();
}

// ── Out-of-hours resolution ──

// Extend this day's end to include out-of-hours work (viewed from "previous day")
async function resolveOutOfHoursExtendDay(div) {
    const workEnd = new Date(div.endMs);
    const dateKey = getDateKey(div.dayDate);
    const current = getEffectiveDayTimes(div.dayDate);

    if (!state.settings.dayOverrides) state.settings.dayOverrides = {};
    state.settings.dayOverrides[dateKey] = {
        ...current,
        dayEndHour: workEnd.getHours(),
        dayEndMinute: workEnd.getMinutes() + (workEnd.getSeconds() > 0 ? 1 : 0), // round up
    };
    await api.put('/settings', state.settings);
    renderAll();
}

// Pull this day's start earlier to include out-of-hours work (viewed from "next day")
async function resolveOutOfHoursEarlierStart(div) {
    const workStart = new Date(div.startMs);
    const dateKey = getDateKey(div.dayDate);
    const current = getEffectiveDayTimes(div.dayDate);

    if (!state.settings.dayOverrides) state.settings.dayOverrides = {};
    state.settings.dayOverrides[dateKey] = {
        ...current,
        dayStartHour: workStart.getHours(),
        dayStartMinute: workStart.getMinutes(),
    };
    await api.put('/settings', state.settings);
    renderAll();
}

// Trim the log entry to exclude the out-of-hours portion
async function resolveOutOfHoursTrimLog(div) {
    const entry = div.workEntry;
    if (!entry) return;

    if (div.perspective === 'prev-day') {
        // Work extends past day end — trim endTime to gapStart (day end)
        if (entry.timestamp >= div.gapStart) {
            // Entire entry is in the gap — delete it
            await api.delete(`/timeline/${entry.id}`);
        } else {
            await api.patch(`/timeline/${entry.id}`, { endTime: div.gapStart });
        }
    } else {
        // Work starts before day start — trim timestamp to gapEnd (day start)
        if (entry.endTime <= div.gapEnd) {
            // Entire entry is in the gap — delete it
            await api.delete(`/timeline/${entry.id}`);
        } else {
            await api.patch(`/timeline/${entry.id}`, { timestamp: div.gapEnd });
        }
    }

    state.timeline = await api.get('/timeline');
    renderAll();
}

// ── Shared helpers ──
function _fmtDivTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function _fmtDuration(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function _cleanWorkName(text) {
    return (text || 'Work').replace(/^Worked on:\s*/i, '').replace(/\s*\(\d+h?\s*\d*m?\)$/, '');
}

// Helper: create Plan/Log action buttons for a segment
function _createSegmentActions(planEntry, seg) {
    const segActions = document.createElement('span');
    segActions.className = 'divergence-seg-actions';
    const planName = _cleanWorkName(planEntry.text);

    if (seg.type === 'idle') {
        const planBtn = document.createElement('button');
        planBtn.className = 'divergence-btn divergence-btn-plan';
        planBtn.textContent = 'Plan';
        planBtn.title = `Accept plan — log "${planName}" for this time`;
        planBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _resolveSegmentAcceptPlan_Idle(planEntry, seg);
        });

        const logBtn = document.createElement('button');
        logBtn.className = 'divergence-btn divergence-btn-log';
        logBtn.textContent = 'Log';
        logBtn.title = 'Accept log — I was idle during this time';
        logBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _resolveSegmentAcceptLog_Idle(planEntry, seg);
        });

        segActions.appendChild(planBtn);
        segActions.appendChild(logBtn);
    } else if (seg.type === 'different') {
        const workName = _cleanWorkName(seg.workEntry.text);

        const planBtn = document.createElement('button');
        planBtn.className = 'divergence-btn divergence-btn-plan';
        planBtn.textContent = 'Plan';
        planBtn.title = `Accept plan — change log from "${workName}" to "${planName}"`;
        planBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _resolveSegmentAcceptPlan_Different(planEntry, seg);
        });

        const logBtn = document.createElement('button');
        logBtn.className = 'divergence-btn divergence-btn-log';
        logBtn.textContent = 'Log';
        logBtn.title = `Accept log — I worked on "${workName}", not "${planName}"`;
        logBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _resolveSegmentAcceptLog_Different(seg);
        });

        segActions.appendChild(planBtn);
        segActions.appendChild(logBtn);
    }

    return segActions;
}

// ── Create inline divergence prompt with per-segment Plan/Log actions ──
function createDivergencePrompt(divergence) {
    if (divergence.type === 'unplanned') {
        return _createUnplannedWorkPrompt(divergence);
    }

    const { entry, segments } = divergence;
    const el = document.createElement('div');
    el.className = 'divergence-prompt';
    el.dataset.startTime = entry.timestamp;
    el.dataset.endTime = entry.endTime;

    // Header
    const header = document.createElement('div');
    header.className = 'divergence-prompt-header';
    const planName = entry.text || 'Planned session';
    header.textContent = `⚡ "${planName}" · ${_fmtDivTime(entry.timestamp)}–${_fmtDivTime(entry.endTime)}`;
    el.appendChild(header);

    // Per-segment rows with Plan/Log actions
    if (segments && segments.length > 0) {
        const segList = document.createElement('div');
        segList.className = 'divergence-segments';

        // Column header row
        const colHeader = document.createElement('div');
        colHeader.className = 'divergence-segment divergence-seg-header';
        const colInfo = document.createElement('span');
        colInfo.className = 'divergence-seg-info';
        const colActions = document.createElement('span');
        colActions.className = 'divergence-seg-actions divergence-seg-actions-label';
        colActions.textContent = 'Accept:';
        colHeader.appendChild(colInfo);
        colHeader.appendChild(colActions);
        segList.appendChild(colHeader);

        for (const seg of segments) {
            const segRow = document.createElement('div');
            segRow.className = `divergence-segment divergence-seg-${seg.type}`;

            // Info column
            const info = document.createElement('span');
            info.className = 'divergence-seg-info';
            const dur = _fmtDuration(seg.endMs - seg.startMs);
            const timeRange = `${_fmtDivTime(seg.startMs)}–${_fmtDivTime(seg.endMs)}`;

            if (seg.type === 'idle') {
                info.textContent = `○ ${timeRange}  idle · ${dur}`;
            } else if (seg.type === 'different') {
                const display = _cleanWorkName(seg.workEntry.text);
                info.textContent = `● ${timeRange}  ${display} · ${dur}`;
            }

            segRow.appendChild(info);
            segRow.appendChild(_createSegmentActions(entry, seg));
            segList.appendChild(segRow);
        }

        el.appendChild(segList);
    }

    // Plan-level actions
    const planActions = document.createElement('div');
    planActions.className = 'divergence-prompt-actions';

    const allLogBtn = document.createElement('button');
    allLogBtn.className = 'divergence-btn divergence-btn-log';
    allLogBtn.textContent = 'All logs';
    allLogBtn.title = 'Accept all logs — keep what actually happened';
    allLogBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _resolveAllSegmentsAsLog(divergence);
    });

    const rescheduleBtn = document.createElement('button');
    rescheduleBtn.className = 'divergence-btn divergence-btn-reschedule';
    rescheduleBtn.textContent = '↻ Reschedule';
    rescheduleBtn.title = 'Reschedule this plan to later today, tomorrow, or drop it';
    rescheduleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const existing = el.querySelector('.divergence-reschedule-options');
        if (existing) { existing.remove(); return; }
        const opts = _createRescheduleOptions(entry);
        planActions.after(opts);
    });

    const acceptAllPlanBtn = document.createElement('button');
    acceptAllPlanBtn.className = 'divergence-btn divergence-btn-ok';
    acceptAllPlanBtn.textContent = 'Accept all plans';
    acceptAllPlanBtn.title = 'Accept plan for all segments — log all idle time as work';
    acceptAllPlanBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resolveDivergenceDidIt(entry);
    });

    planActions.appendChild(rescheduleBtn);
    planActions.appendChild(acceptAllPlanBtn);
    planActions.appendChild(allLogBtn);
    el.appendChild(planActions);

    return el;
}

// Unplanned work prompt
function _createUnplannedWorkPrompt(divergence) {
    const { workEntry } = divergence;
    const el = document.createElement('div');
    el.className = 'divergence-prompt divergence-prompt-unplanned';
    el.dataset.startTime = divergence.startMs;
    el.dataset.endTime = divergence.endMs;

    const header = document.createElement('div');
    header.className = 'divergence-prompt-header';
    const workName = _cleanWorkName(workEntry.text);
    const dur = _fmtDuration(divergence.endMs - divergence.startMs);
    header.textContent = `⚡ Unplanned: "${workName}" · ${_fmtDivTime(divergence.startMs)}–${_fmtDivTime(divergence.endMs)} (${dur})`;

    const actions = document.createElement('div');
    actions.className = 'divergence-prompt-actions';

    // Plan = accept plan (nothing was planned) — dismiss the unplanned work
    const planBtn = document.createElement('button');
    planBtn.className = 'divergence-btn divergence-btn-plan';
    planBtn.textContent = 'Plan';
    planBtn.title = 'Accept plan — nothing was planned, dismiss this';
    planBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resolveDivergenceAcceptUnplanned(workEntry.id);
    });

    // Log = accept log (acknowledge the unplanned work)
    const logBtn = document.createElement('button');
    logBtn.className = 'divergence-btn divergence-btn-log';
    logBtn.textContent = 'Log';
    logBtn.title = `Accept log — acknowledge "${workName}" as work done`;
    logBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resolveDivergenceAcceptUnplanned(workEntry.id);
    });

    actions.appendChild(planBtn);
    actions.appendChild(logBtn);

    el.appendChild(header);
    el.appendChild(actions);
    return el;
}

// Shared helper: create reschedule sub-option buttons
function _createRescheduleOptions(entry) {
    const opts = document.createElement('div');
    opts.className = 'divergence-reschedule-options';

    const laterBtn = document.createElement('button');
    laterBtn.className = 'divergence-btn divergence-btn-sub';
    laterBtn.textContent = 'Later Today';
    laterBtn.addEventListener('click', (ev) => { ev.stopPropagation(); resolveDivergenceReschedule(entry, 'later'); });

    const tomorrowBtn = document.createElement('button');
    tomorrowBtn.className = 'divergence-btn divergence-btn-sub';
    tomorrowBtn.textContent = 'Tomorrow';
    tomorrowBtn.addEventListener('click', (ev) => { ev.stopPropagation(); resolveDivergenceReschedule(entry, 'tomorrow'); });

    const dropBtn = document.createElement('button');
    dropBtn.className = 'divergence-btn divergence-btn-sub divergence-btn-drop';
    dropBtn.textContent = 'Drop';
    dropBtn.addEventListener('click', (ev) => { ev.stopPropagation(); resolveDivergenceReschedule(entry, 'drop'); });

    opts.appendChild(laterBtn);
    opts.appendChild(tomorrowBtn);
    opts.appendChild(dropBtn);
    return opts;
}

// ── Compact divergence banner (hide-past mode) — collapsible ──
function createDivergenceBanner(divergences) {
    const banner = document.createElement('div');
    banner.className = 'divergence-banner';

    // Calculate summary stats
    let totalSegments = 0;
    let totalTimeMs = 0;
    for (const div of divergences) {
        if (div.type === 'unplanned' || div.type === 'out-of-hours') {
            totalSegments++;
            totalTimeMs += (div.endMs - div.startMs);
        } else {
            const segs = div.segments || [];
            totalSegments += segs.length;
            for (const s of segs) totalTimeMs += (s.endMs - s.startMs);
        }
    }

    // Summary header — click to expand/collapse all
    const summaryRow = document.createElement('div');
    summaryRow.className = 'divergence-banner-summary';
    const summaryChevron = document.createElement('span');
    summaryChevron.className = 'divergence-chevron';
    summaryChevron.textContent = '▸';
    const summaryText = document.createElement('span');
    summaryText.className = 'divergence-banner-summary-text';
    const durStr = _fmtDuration(totalTimeMs);
    summaryText.textContent = `⚡ ${totalSegments} divergence${totalSegments !== 1 ? 's' : ''} · ${durStr} to resolve`;
    summaryRow.appendChild(summaryChevron);
    summaryRow.appendChild(summaryText);
    banner.appendChild(summaryRow);

    // Container for all divergence items (collapsible)
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'divergence-banner-items';
    if (!state.divergenceBannerExpanded) itemsContainer.classList.add('divergence-collapsed');
    if (state.divergenceBannerExpanded) summaryChevron.textContent = '▾';

    summaryRow.addEventListener('click', () => {
        const collapsed = itemsContainer.classList.toggle('divergence-collapsed');
        summaryChevron.textContent = collapsed ? '▸' : '▾';
        state.divergenceBannerExpanded = !collapsed;
        savePref('divergenceBannerExpanded', state.divergenceBannerExpanded);
    });

    for (const div of divergences) {
        if (div.type === 'unplanned') {
            const row = document.createElement('div');
            row.className = 'divergence-banner-item';
            const label = document.createElement('span');
            label.className = 'divergence-banner-label';
            const workName = _cleanWorkName(div.workEntry.text);
            label.textContent = `⚡ Unplanned: "${workName}" · ${_fmtDivTime(div.startMs)}–${_fmtDivTime(div.endMs)}`;
            const actions = document.createElement('span');
            actions.className = 'divergence-banner-actions';

            const planBtn = document.createElement('button');
            planBtn.className = 'divergence-btn divergence-btn-plan divergence-btn-compact';
            planBtn.textContent = 'Plan';
            planBtn.title = 'Accept plan — nothing was planned, dismiss';
            planBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                resolveDivergenceAcceptUnplanned(div.workEntry.id);
            });

            const logBtn = document.createElement('button');
            logBtn.className = 'divergence-btn divergence-btn-log divergence-btn-compact';
            logBtn.textContent = 'Log';
            logBtn.title = `Accept log — acknowledge "${workName}"`;
            logBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                resolveDivergenceAcceptUnplanned(div.workEntry.id);
            });

            actions.appendChild(planBtn);
            actions.appendChild(logBtn);
            row.appendChild(label);
            row.appendChild(actions);
            itemsContainer.appendChild(row);
            continue;
        }

        if (div.type === 'out-of-hours') {
            const row = document.createElement('div');
            row.className = 'divergence-banner-item';
            const label = document.createElement('span');
            label.className = 'divergence-banner-label';
            const workName = _cleanWorkName(div.workEntry.text);
            label.textContent = `🌙 Out-of-hours: "${workName}" · ${_fmtDivTime(div.startMs)}–${_fmtDivTime(div.endMs)}`;
            const actions = document.createElement('span');
            actions.className = 'divergence-banner-actions';

            if (div.perspective === 'prev-day') {
                const extendBtn = document.createElement('button');
                extendBtn.className = 'divergence-btn divergence-btn-plan divergence-btn-compact';
                extendBtn.textContent = 'Extend day';
                extendBtn.title = 'Extend this day\'s end to include this work';
                extendBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    resolveOutOfHoursExtendDay(div);
                });
                actions.appendChild(extendBtn);
            } else {
                const earlierBtn = document.createElement('button');
                earlierBtn.className = 'divergence-btn divergence-btn-plan divergence-btn-compact';
                earlierBtn.textContent = 'Start earlier';
                earlierBtn.title = 'Start this day earlier to include this work';
                earlierBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    resolveOutOfHoursEarlierStart(div);
                });
                actions.appendChild(earlierBtn);
            }

            const trimBtn = document.createElement('button');
            trimBtn.className = 'divergence-btn divergence-btn-log divergence-btn-compact';
            trimBtn.textContent = 'Trim log';
            trimBtn.title = 'Trim the log entry to exclude the out-of-hours portion';
            trimBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                resolveOutOfHoursTrimLog(div);
            });
            actions.appendChild(trimBtn);


            row.appendChild(label);
            row.appendChild(actions);
            itemsContainer.appendChild(row);
            continue;
        }

        // Plan divergence: collapsible header + per-segment rows
        const planName = div.entry.text || 'Planned session';
        const timeStr = `${_fmtDivTime(div.entry.timestamp)}–${_fmtDivTime(div.entry.endTime)}`;
        const segCount = (div.segments || []).length;

        // Header row — clickable to toggle segments
        const headerRow = document.createElement('div');
        headerRow.className = 'divergence-banner-item divergence-banner-header';
        const headerLeft = document.createElement('span');
        headerLeft.className = 'divergence-banner-label divergence-banner-label-toggle';
        const planChevron = document.createElement('span');
        planChevron.className = 'divergence-chevron';
        planChevron.textContent = '▸';
        headerLeft.appendChild(planChevron);
        headerLeft.appendChild(document.createTextNode(` ⚡ "${planName}" · ${timeStr} (${segCount})`));

        const headerActions = document.createElement('span');
        headerActions.className = 'divergence-banner-actions';

        // Reschedule
        const rescheduleBtn = document.createElement('button');
        rescheduleBtn.className = 'divergence-btn divergence-btn-reschedule divergence-btn-compact';
        rescheduleBtn.textContent = '↻';
        rescheduleBtn.title = 'Reschedule plan';
        rescheduleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const existing = headerRow.querySelector('.divergence-reschedule-options');
            if (existing) { existing.remove(); return; }
            const opts = _createRescheduleOptions(div.entry);
            headerRow.appendChild(opts);
        });

        // Accept all plans
        const acceptAllPlanBtn = document.createElement('button');
        acceptAllPlanBtn.className = 'divergence-btn divergence-btn-plan divergence-btn-compact';
        acceptAllPlanBtn.textContent = 'All plans';
        acceptAllPlanBtn.title = 'Accept all plans — log all idle time as work';
        acceptAllPlanBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            resolveDivergenceDidIt(div.entry);
        });

        // All logs
        const allLogBtn = document.createElement('button');
        allLogBtn.className = 'divergence-btn divergence-btn-log divergence-btn-compact';
        allLogBtn.textContent = 'All logs';
        allLogBtn.title = 'Accept all logs — keep what actually happened';
        allLogBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _resolveAllSegmentsAsLog(div);
        });

        headerActions.appendChild(rescheduleBtn);
        headerActions.appendChild(acceptAllPlanBtn);
        headerActions.appendChild(allLogBtn);
        headerRow.appendChild(headerLeft);
        headerRow.appendChild(headerActions);
        itemsContainer.appendChild(headerRow);

        // Segment rows container (collapsible per-plan)
        const segContainer = document.createElement('div');
        segContainer.className = 'divergence-banner-segs';
        const planId = div.entry.id;
        if (!state.divergencePlansExpanded.has(planId)) segContainer.classList.add('divergence-collapsed');
        if (state.divergencePlansExpanded.has(planId)) planChevron.textContent = '▾';

        headerLeft.addEventListener('click', (e) => {
            e.stopPropagation();
            const collapsed = segContainer.classList.toggle('divergence-collapsed');
            planChevron.textContent = collapsed ? '▸' : '▾';
            if (collapsed) state.divergencePlansExpanded.delete(planId);
            else state.divergencePlansExpanded.add(planId);
            savePref('divergencePlansExpanded', [...state.divergencePlansExpanded]);
        });

        for (const seg of (div.segments || [])) {
            const segRow = document.createElement('div');
            segRow.className = `divergence-banner-item divergence-banner-seg divergence-seg-${seg.type}`;
            const segLabel = document.createElement('span');
            segLabel.className = 'divergence-banner-label';
            const dur = _fmtDuration(seg.endMs - seg.startMs);
            const segTime = `${_fmtDivTime(seg.startMs)}–${_fmtDivTime(seg.endMs)}`;
            if (seg.type === 'idle') {
                segLabel.textContent = `  ○ ${segTime}  idle · ${dur}`;
            } else if (seg.type === 'different') {
                const display = _cleanWorkName(seg.workEntry.text);
                segLabel.textContent = `  ● ${segTime}  ${display} · ${dur}`;
            }

            segRow.appendChild(segLabel);
            segRow.appendChild(_createSegmentActions(div.entry, seg));
            segContainer.appendChild(segRow);
        }
        itemsContainer.appendChild(segContainer);
    }

    banner.appendChild(itemsContainer);
    return banner;
}

// Find the index of the segment containing now (or nearest future segment)
function getCurrentSessionIndex(segments) {
    const nowMs = Date.now();
    for (let i = 0; i < segments.length; i++) {
        if (nowMs >= segments[i].startMs && nowMs < segments[i].endMs) return i;
    }
    // If now is past all segments, return last; if before all, return first
    for (let i = 0; i < segments.length; i++) {
        if (segments[i].startMs > nowMs) return i;
    }
    return segments.length - 1;
}

// Navigate between sessions (+1 = next, -1 = prev)
function navigateSession(direction) {
    const segments = buildPlanSegments();
    if (segments.length === 0) return;
    state.sessionIndex = Math.max(0, Math.min(segments.length - 1, state.sessionIndex + direction));
    savePref('sessionIndex', state.sessionIndex);
    // Auto-populate focusStack with the selected segment
    _syncSessionToFocusStack(segments[state.sessionIndex]);
    renderAll();
}

// Get the currently-active session segment object (or null)
function getActiveSession() {
    if (state.viewHorizon !== 'session') return null;
    const segments = buildPlanSegments();
    if (segments.length === 0) return null;
    const idx = Math.max(0, Math.min(segments.length - 1, state.sessionIndex));
    return segments[idx];
}

// Sync the session horizon selection into the focusStack so existing filtering/rendering works
function _syncSessionToFocusStack(segment) {
    if (!segment) {
        state.focusStack = [];
        saveFocusStack();
        return;
    }
    state.focusStack = [{
        startMs: segment.startMs,
        endMs: segment.endMs,
        label: segment.label.split(' · ')[0], // strip time range for the focus label
        type: segment.type,
        icon: segment.icon,
        tier: 'session',
        segmentKey: segment.segmentKey,
        entryId: segment.entryId || null,
        itemId: segment.itemId || null,
    }];
    saveFocusStack();
}

// Degrade all @work or @break live contexts back to the parent day context
async function _degradeLiveContexts(type) {
    const dateKey = getDateKey(state.timelineViewDate);
    const liveCtx = `${dateKey}@${type}`;
    const allItems = collectAllItems(state.items.items);
    for (const a of allItems) {
        const item = findItemById(a.id);
        if (!item || !item.timeContexts) continue;
        if (item.timeContexts.includes(liveCtx)) {
            // Remove the live context, migrate duration to day
            item.timeContexts = item.timeContexts.filter(tc => tc !== liveCtx);
            if (item.contextDurations && liveCtx in item.contextDurations) {
                const dur = item.contextDurations[liveCtx];
                delete item.contextDurations[liveCtx];
                if (dur != null && !(dateKey in item.contextDurations)) {
                    item.contextDurations[dateKey] = dur;
                }
            }
            // Ensure the day context exists
            if (!item.timeContexts.some(tc => contextMatchesDate(tc, dateKey))) {
                item.timeContexts.push(dateKey);
            }
            const patch = { timeContexts: item.timeContexts };
            if (item.contextDurations) patch.contextDurations = item.contextDurations;
            await api.patch(`/items/${item.id}`, patch);
        }
    }
}

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
//   1. If the item or any ancestor has epoch contexts (e.g. "ongoing") → hide from day views
//   2. If the item or any ancestor has timeContexts including dateKey → show
//   3. If NO item in the ancestry chain has any timeContexts at all → show ("anytime")
//   4. If some level has timeContexts but none match dateKey → hide
function itemMatchesTimeContext(action, dateKey) {
    const item = findItemById(action.id);
    const ownContexts = (item && item.timeContexts) || [];
    // Item has its own contexts — only check those, don't inherit from ancestors
    if (ownContexts.length > 0) {
        // Check date matches first — items can have BOTH epoch ("ongoing") and day contexts
        if (ownContexts.some(tc => contextMatchesDate(tc, dateKey))) return true;
        if (ownContexts.some(tc => isEpochContext(tc))) {
            // Even epoch items can appear via deadline shadow
            if (item && _deadlineShadowMatchesDate(item, dateKey)) return true;
            return false;
        }
        if (ownContexts.some(tc => contextMatchesDate(tc, dateKey))) return true;
        // Overnight segments: check if any segment from a prior date is still live
        const now = new Date();
        if (ownContexts.some(tc => {
            const p = parseTimeContext(tc);
            return p && p.segment && p.date < dateKey && _isOvernightSegmentLive(p, now);
        })) return true;
        // Backward projection: check if a deadline shadow covers this date
        if (item && _deadlineShadowMatchesDate(item, dateKey)) return true;
        return false;
    }
    // No own contexts — fall back to ancestor chain
    const ancestors = getAncestorPath(action.id);
    if (ancestors) {
        for (const ancestor of ancestors) {
            if (ancestor.timeContexts && ancestor.timeContexts.length > 0) {
                // Ancestor epoch context hides descendants from day views
                if (ancestor.timeContexts.some(tc => isEpochContext(tc))) return false;
                return ancestor.timeContexts.some(tc => contextMatchesDate(tc, dateKey));
            }
        }
    }
    // No contexts at any level — should not happen after migration (data anomaly)
    return false;
}

// Check if an item is truly "unscheduled" (anytime) — no timeContexts on itself or any ancestor.
// After migration, this should not return true for valid items (safety net for data anomalies).
function isItemUnscheduled(itemOrAction) {
    const item = findItemById(itemOrAction.id);
    const ownContexts = (item && item.timeContexts) || [];
    if (ownContexts.length > 0) return false;
    const ancestors = getAncestorPath(itemOrAction.id);
    if (ancestors) {
        for (const ancestor of ancestors) {
            if (ancestor.timeContexts && ancestor.timeContexts.length > 0) return false;
        }
    }
    return true;
}

// Return the default timeContexts array for newly-created items,
// based on the current view horizon / focused session.
function getCurrentTimeContexts() {
    if (state.viewHorizon === 'session') {
        // At session horizon, return the segment context for the active session
        const seg = getActiveSession();
        if (seg) {
            const dateKey = getDateKey(state.timelineViewDate);
            return [dateKey, seg.segmentKey];
        }
    }
    const focused = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    if (focused) {
        // In a focused session, inherit the session's segment context + the date
        const dateKey = getDateKey(state.timelineViewDate);
        const ctx = [dateKey];
        if (focused.segmentKey) ctx.push(focused.segmentKey);
        else if (focused.liveType) ctx.push(`${dateKey}@${focused.liveType}`);
        else if (focused.entryId) ctx.push(`${dateKey}@entry:${focused.entryId}`);
        return ctx;
    }
    if (state.viewHorizon === 'epoch') return [state.epochFilter];
    if (state.viewHorizon === 'week') return [getWeekKey(state.timelineViewDate)];
    return [getDateKey(state.timelineViewDate)];
}

// Return the single most-specific context string for the current view state.
// Used by the duration picker / badge to read/write context-coupled durations.
function getCurrentViewContext() {
    const focused = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    if (focused && focused.segmentKey) return focused.segmentKey;
    if (focused && focused.liveType) return `${getDateKey(state.timelineViewDate)}@${focused.liveType}`;
    if (focused && focused.entryId) return `${getDateKey(state.timelineViewDate)}@entry:${focused.entryId}`;
    if (state.viewHorizon === 'epoch') return state.epochFilter;
    if (state.viewHorizon === 'week') return getWeekKey(state.timelineViewDate);
    return getDateKey(state.timelineViewDate);
}

// Find a key in contextDurations whose segment overlaps the given context string.
// Returns the matching key or null.
function findOverlappingContextKey(contextDurations, ctx) {
    const parsed = parseTimeContext(ctx);
    if (!parsed || !parsed.segment) return null;
    const [rsh, rsm] = parsed.segment.start.split(':').map(Number);
    const [reh, rem] = parsed.segment.end.split(':').map(Number);
    // Use a reference date for ms conversion
    const ref = new Date();
    const refY = ref.getFullYear(), refM = ref.getMonth(), refD = ref.getDate();
    const refStart = new Date(refY, refM, refD, rsh, rsm).getTime();
    let refEnd = new Date(refY, refM, refD, reh, rem).getTime();
    if (refEnd <= refStart) refEnd += 24 * 60 * 60 * 1000;

    for (const key of Object.keys(contextDurations)) {
        const kp = parseTimeContext(key);
        if (!kp || !kp.segment || kp.date !== parsed.date) continue;
        const [ksh, ksm] = kp.segment.start.split(':').map(Number);
        const [keh, kem] = kp.segment.end.split(':').map(Number);
        const kStart = new Date(refY, refM, refD, ksh, ksm).getTime();
        let kEnd = new Date(refY, refM, refD, keh, kem).getTime();
        if (kEnd <= kStart) kEnd += 24 * 60 * 60 * 1000;
        if (Math.min(refEnd, kEnd) > Math.max(refStart, kStart)) return key;
    }
    return null;
}

// Resolve the effective duration for an item in the current view context.
// Fallback chain: contextDurations[ctx] → overlapping segment key → estimatedDuration → 0
function getContextDuration(item, ctx) {
    if (!item) return 0;
    if (!ctx) ctx = getCurrentViewContext();
    const ctxDur = item.contextDurations?.[ctx];
    if (ctxDur != null) return ctxDur;
    // Fuzzy: find an overlapping segment context in contextDurations
    if (item.contextDurations) {
        const overlapping = findOverlappingContextKey(item.contextDurations, ctx);
        if (overlapping != null) return item.contextDurations[overlapping];
    }
    return item.estimatedDuration || 0;
}

// ─── Backward Projection: contextLeadTimes ───

// Get lead time (in seconds) for an item in a specific context.
function getContextLeadTime(item, ctx) {
    if (!item || !item.contextLeadTimes) return null;
    if (ctx && item.contextLeadTimes[ctx] != null) return item.contextLeadTimes[ctx];
    return null;
}

// Check if a context is a deadline (has a contextLeadTimes entry).
function isDeadlineContext(item, ctx) {
    return item?.contextLeadTimes?.[ctx] != null;
}

// Parse a date from a context string (returns Date or null).
// Handles: "2026-02-15", "2026-02-15@18:00-20:00", "2026-02-15@entry:206", "week:2026-02-15"
function parseDateFromContext(ctx) {
    const parsed = parseTimeContext(ctx);
    if (!parsed) return null;
    if (parsed.date) {
        const d = new Date(parsed.date + 'T00:00:00');
        if (parsed.entryId) {
            // Look up entry's actual start time from timeline
            const entry = state.timeline?.entries?.find(e => String(e.id) === String(parsed.entryId));
            if (entry?.startTime) return new Date(entry.startTime);
        } else if (parsed.segment) {
            const [h, m] = parsed.segment.start.split(':').map(Number);
            d.setHours(h, m, 0, 0);
        }
        return d;
    }
    if (parsed.week) {
        const range = getWeekDateRange('week:' + parsed.week);
        return range ? range.end : null; // use end of week as deadline
    }
    return null;
}

// Get urgency level based on how close a deadline is.
function getDeadlineUrgency(deadlineDate) {
    const now = new Date();
    const msLeft = deadlineDate.getTime() - now.getTime();
    const daysLeft = msLeft / (1000 * 60 * 60 * 24);
    if (daysLeft < 0) return 'overdue';
    if (daysLeft < 1) return 'urgent';
    if (daysLeft < 3) return 'soon';
    return 'safe';
}

// Format a human-readable countdown to a deadline.
function formatDeadlineCountdown(deadlineDate) {
    const now = new Date();
    const msLeft = deadlineDate.getTime() - now.getTime();
    if (msLeft < 0) return 'overdue';
    const mins = Math.floor(msLeft / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'tomorrow';
    if (days < 7) return `in ${days} days`;
    const weeks = Math.floor(days / 7);
    if (weeks === 1) return 'next week';
    return `in ${weeks} weeks`;
}

// Check if a deadline context's lead time window covers the given dateKey.
// Returns the urgency level if matched, or null if not in window.
function _deadlineShadowMatchesDate(item, dateKey) {
    if (!item || !item.contextLeadTimes) return null;
    const today = new Date(dateKey + 'T00:00:00');
    for (const [ctx, leadSec] of Object.entries(item.contextLeadTimes)) {
        // Short lead times (< 24h) for entry/segment contexts: handled as phantom blocks in the timeline
        const ctxParsed = parseTimeContext(ctx);
        if (leadSec < 86400 && (ctxParsed?.entryId || ctxParsed?.segment)) continue;
        const deadlineDate = parseDateFromContext(ctx);
        if (!deadlineDate) continue;
        const startDate = new Date(deadlineDate.getTime() - leadSec * 1000);
        const startKey = getDateKey(startDate);
        const deadlineKey = getDateKey(deadlineDate);
        // Only match day-level shadows: ≤ 7 days lead time, or within last 7 days of a longer lead time
        const daysBeforeDeadline = (deadlineDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
        if (dateKey >= startKey && dateKey <= deadlineKey && daysBeforeDeadline <= 7) {
            return getDeadlineUrgency(deadlineDate);
        }
    }
    return null;
}

// Check if a deadline context's lead time window covers the given weekKey.
// Only matches when the shadow is > 7 days away (week-level horizon).
function _deadlineShadowMatchesWeek(item, weekKey) {
    if (!item || !item.contextLeadTimes) return null;
    const range = getWeekDateRange(weekKey);
    if (!range) return null;
    const weekStartKey = getDateKey(range.start);
    const weekEndKey = getDateKey(range.end);
    for (const [ctx, leadSec] of Object.entries(item.contextLeadTimes)) {
        const deadlineDate = parseDateFromContext(ctx);
        if (!deadlineDate) continue;
        const startDate = new Date(deadlineDate.getTime() - leadSec * 1000);
        const startKey = getDateKey(startDate);
        const deadlineKey = getDateKey(deadlineDate);
        // Check if the shadow window overlaps this week
        if (startKey <= weekEndKey && deadlineKey >= weekStartKey) {
            return getDeadlineUrgency(deadlineDate);
        }
    }
    return null;
}

// Check if an item has an epoch context (e.g. "ongoing") on itself or any ancestor.
// If the item has its own explicit timeContexts, those take priority — ancestor
// epochs don't bleed through (e.g. a child with a date should NOT show in ongoing
// just because its parent is ongoing).
// Every item should have explicit timeContexts (ongoing is the default).
// Items with NO timeContexts at any level are a data anomaly — return false.
function isItemInEpoch(itemOrAction, epochName) {
    const item = findItemById(itemOrAction.id);
    const ownContexts = (item && item.timeContexts) || [];
    // Item has its own contexts — only check those, don't inherit from ancestors
    if (ownContexts.length > 0) return ownContexts.includes(epochName);
    // No own contexts — check ancestors
    const ancestors = getAncestorPath(itemOrAction.id);
    if (ancestors) {
        for (const ancestor of ancestors) {
            if (ancestor.timeContexts && ancestor.timeContexts.length > 0) {
                return ancestor.timeContexts.includes(epochName);
            }
        }
    }
    // No contexts at any level — should not happen after migration
    return false;
}

// Toggle a date in an item's timeContexts
async function toggleTimeContext(itemId, dateKey) {
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.timeContexts) item.timeContexts = [];
    const idx = item.timeContexts.indexOf(dateKey);
    if (idx >= 0) {
        item.timeContexts.splice(idx, 1);
        // Never leave an item with no time context — fall back to ongoing
        if (item.timeContexts.length === 0) item.timeContexts.push('ongoing');
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

// Send an item to an epoch (ongoing/future/past) — strips all date/segment contexts and adds the epoch.
// sourceDuration: if provided, seed it as the epoch-level duration.
async function sendToEpoch(itemId, epochName, sourceDuration) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item) return;
    // Strip all date/segment/entry/week contexts, keep only the target epoch
    item.timeContexts = [epochName];
    // Clean segment durations since we removed segment contexts,
    // but seed the epoch duration from the source if provided
    if (!item.contextDurations) item.contextDurations = {};
    const dur = sourceDuration != null ? sourceDuration : (item.contextDurations[Object.keys(item.contextDurations)[0]] ?? undefined);
    item.contextDurations = {};
    if (dur != null) item.contextDurations[epochName] = dur;
    await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}
// Convenience wrapper
async function sendToOngoing(itemId, sourceDuration) { return sendToEpoch(itemId, 'ongoing', sourceDuration); }

// Send an item to the week backlog — strips day/segment contexts, adds week context.
async function sendToWeek(itemId, weekKey, sourceDuration) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item) return;
    // Strip all date/segment/entry/epoch contexts, add week
    item.timeContexts = [weekKey];
    if (!item.contextDurations) item.contextDurations = {};
    const dur = sourceDuration != null ? sourceDuration : (item.contextDurations[Object.keys(item.contextDurations)[0]] ?? undefined);
    item.contextDurations = {};
    if (dur != null) item.contextDurations[weekKey] = dur;
    await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}

// Promote an item from week context to a specific day.
async function promoteFromWeek(itemId, dateKey, sourceDuration) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.timeContexts) item.timeContexts = [];
    // Capture week duration before removing
    const weekCtx = item.timeContexts.find(tc => isWeekContext(tc));
    const weekDur = sourceDuration != null ? sourceDuration : (weekCtx ? item.contextDurations?.[weekCtx] : undefined);
    // Strip week contexts
    item.timeContexts = item.timeContexts.filter(tc => !isWeekContext(tc));
    // Also strip epoch contexts if present
    item.timeContexts = item.timeContexts.filter(tc => !EPOCH_CONTEXTS.includes(tc));
    if (!item.timeContexts.includes(dateKey)) {
        item.timeContexts.push(dateKey);
    }
    // Migrate duration to the new date
    if (!item.contextDurations) item.contextDurations = {};
    if (weekCtx) delete item.contextDurations[weekCtx];
    for (const ep of EPOCH_CONTEXTS) delete item.contextDurations[ep];
    if (weekDur != null) item.contextDurations[dateKey] = weekDur;
    await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}

// Promote an item from any epoch — removes all epoch contexts, adds the target date.
// Migrates the source epoch's duration to the new date context.
async function promoteFromEpoch(itemId, dateKey, sourceDuration) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.timeContexts) item.timeContexts = [];
    // Find and capture the epoch duration before removing
    const epochCtx = item.timeContexts.find(tc => EPOCH_CONTEXTS.includes(tc));
    const epochDur = sourceDuration != null ? sourceDuration : (epochCtx ? item.contextDurations?.[epochCtx] : undefined);
    item.timeContexts = item.timeContexts.filter(tc => {
        if (EPOCH_CONTEXTS.includes(tc)) return false;
        // Also strip entry/session/segment sub-contexts for the target date
        // (e.g. "2026-02-13@entry:297") so we degrade cleanly to day scope
        if (tc.startsWith(dateKey + '@')) return false;
        return true;
    });
    if (!item.timeContexts.includes(dateKey)) {
        item.timeContexts.push(dateKey);
    }
    // Migrate duration to the new date key
    if (!item.contextDurations) item.contextDurations = {};
    for (const ep of EPOCH_CONTEXTS) delete item.contextDurations[ep];
    // Also clean up durations for removed sub-contexts
    for (const key of Object.keys(item.contextDurations)) {
        if (key.startsWith(dateKey + '@')) delete item.contextDurations[key];
    }
    if (epochDur != null) item.contextDurations[dateKey] = epochDur;
    await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}
// Convenience alias
async function promoteFromOngoing(itemId, dateKey, sourceDuration) { return promoteFromEpoch(itemId, dateKey, sourceDuration); }

// Reschedule an item to a specific date (used by DnD on day arrows).
// Preserves the source context's duration into the new date context.
async function rescheduleToDate(itemId, dateKey) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.timeContexts) item.timeContexts = [];
    // Capture best available duration from current contexts before clearing
    const srcCtx = getCurrentViewContext();
    const srcDur = item.contextDurations?.[srcCtx] ?? getContextDuration(item, srcCtx);
    // Remove all date/segment/week/epoch contexts, add the target date
    item.timeContexts = item.timeContexts.filter(tc => {
        if (EPOCH_CONTEXTS.includes(tc)) return false;
        if (isWeekContext(tc)) return false;
        if (/^\d{4}-\d{2}-\d{2}/.test(tc)) return false;
        return true;
    });
    if (!item.timeContexts.includes(dateKey)) {
        item.timeContexts.push(dateKey);
    }
    // Migrate duration to the new date
    if (!item.contextDurations) item.contextDurations = {};
    item.contextDurations = {};
    if (srcDur) item.contextDurations[dateKey] = srcDur;
    await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}

// ─── Auto-clean past schedules ───
// Silently remove any timeContexts entries before today.
// Items that had only past-date contexts are degraded to their week context.
async function cleanPastSchedules() {
    const today = getLogicalToday();
    const todayKey = getDateKey(today);
    let dirty = false;

    function walkItems(items) {
        for (const item of items) {
            if (item.timeContexts && item.timeContexts.length > 0) {
                const before = item.timeContexts.length;
                const hadDateContexts = item.timeContexts.some(tc => {
                    const p = parseTimeContext(tc);
                    return p && p.date; // had at least one date-level context
                });
                item.timeContexts = item.timeContexts.filter(tc => {
                    const parsed = parseTimeContext(tc);
                    if (!parsed) return false;
                    // Keep epoch and week contexts as-is
                    if (parsed.epoch) return true;
                    if (isWeekContext(tc)) return true;
                    // Keep deadline contexts (anti-degradation) — they persist as overdue
                    if (isDeadlineContext(item, tc)) return true;
                    // Keep overnight segments that are still live
                    if (parsed.date < todayKey && parsed.segment && _isOvernightSegmentLive(parsed, today)) return true;
                    return parsed.date >= todayKey;
                });
                // If we removed date contexts and nothing date-level remains, degrade to week
                if (item.timeContexts.length !== before) {
                    dirty = true;
                    const hasRemainingDates = item.timeContexts.some(tc => {
                        const p = parseTimeContext(tc);
                        return p && p.date;
                    });
                    const hasWeek = item.timeContexts.some(tc => isWeekContext(tc));
                    if (hadDateContexts && !hasRemainingDates && !hasWeek && !item.timeContexts.some(tc => EPOCH_CONTEXTS.includes(tc))) {
                        // Degrade to the current week context instead of epoch
                        const weekKey = getWeekKey(today);
                        item.timeContexts.push(weekKey);
                    }
                }
            }
            if (item.children && item.children.length > 0) {
                walkItems(item.children);
            }
        }
    }

    walkItems(state.items.items);
    if (dirty) {
        await saveItems();
    }
}

// ─── Auto-clean past sessions (intra-day) ───
// Silently degrade segment/entry contexts whose end time has already passed
// back to their parent date context.
// Also handles segments/entries from past dates — those are automatically expired.
async function cleanPastSessions(now) {
    now = now || new Date();
    const todayKey = getDateKey(getLogicalToday());
    let dirty = false;

    function walkItems(items) {
        for (const item of items) {
            if (item.timeContexts && item.timeContexts.length > 0) {
                const contextsToRemove = [];
                for (const tc of item.timeContexts) {
                    const parsed = parseTimeContext(tc);
                    if (!parsed || (!parsed.segment && !parsed.entryId)) continue;

                    // ── Entry contexts (e.g. "2026-02-13@entry:297") ──
                    if (parsed.entryId) {
                        // Past-date entries are automatically expired
                        if (parsed.date < todayKey) {
                            contextsToRemove.push(tc);
                            continue;
                        }
                        // Only check end-time for today's entries
                        if (parsed.date !== todayKey) continue;
                        // Look up the entry to find its end time
                        const entry = state.timeline?.entries?.find(
                            e => String(e.id) === String(parsed.entryId)
                        );
                        if (entry) {
                            const entryStart = new Date(entry.startTime).getTime();
                            const entryEnd = entryStart + (entry.duration || 0) * 60000;
                            if (now.getTime() >= entryEnd) {
                                contextsToRemove.push(tc);
                            }
                        }
                        continue;
                    }

                    // ── Segment contexts (e.g. "2026-02-13@10:00-12:00") ──
                    // Past-date segments are automatically expired —
                    // UNLESS they cross midnight and their real end is still in the future
                    if (parsed.date < todayKey) {
                        if (!_isOvernightSegmentLive(parsed, now)) {
                            contextsToRemove.push(tc);
                        }
                        continue;
                    }

                    // Only check end-time for today's segments
                    if (parsed.date !== todayKey) continue;

                    // Build actual end timestamp from the segment's date (not from `now`,
                    // since the logical day may differ from the calendar date)
                    const [endH, endM] = parsed.segment.end.split(':').map(Number);
                    const [startH, startM] = parsed.segment.start.split(':').map(Number);
                    const [sY, sM, sD] = parsed.date.split('-').map(Number);
                    const endDate = new Date(sY, sM - 1, sD, endH, endM, 0, 0);
                    // Cross-midnight: if end time is before start time, end is next calendar day
                    if (endH < startH || (endH === startH && endM < startM)) {
                        endDate.setDate(endDate.getDate() + 1);
                    }
                    if (now >= endDate) {
                        contextsToRemove.push(tc);
                    }
                }
                if (contextsToRemove.length > 0) {
                    item.timeContexts = item.timeContexts.filter(tc => !contextsToRemove.includes(tc));
                    // Clean up segment durations
                    if (item.contextDurations) {
                        for (const ctx of contextsToRemove) {
                            delete item.contextDurations[ctx];
                        }
                    }
                    // For each removed context, ensure the parent date is present
                    const affectedDates = new Set(contextsToRemove.map(tc => parseTimeContext(tc)?.date).filter(Boolean));
                    for (const dateKey of affectedDates) {
                        const hasOtherForDate = item.timeContexts.some(tc => contextMatchesDate(tc, dateKey));
                        if (!hasOtherForDate) {
                            item.timeContexts.push(dateKey);
                        }
                    }
                    dirty = true;
                }
            }
            if (item.children && item.children.length > 0) {
                walkItems(item.children);
            }
        }
    }

    walkItems(state.items.items);
    if (dirty) {
        await saveItems();
    }
}

// ─── One-time migration: assign 'ongoing' to items with no timeContexts ───
async function migrateEmptyTimeContexts() {
    let dirty = false;
    function walkItems(items) {
        for (const item of items) {
            if (!item.timeContexts || item.timeContexts.length === 0) {
                item.timeContexts = ['ongoing'];
                dirty = true;
            }
            if (item.children && item.children.length > 0) walkItems(item.children);
        }
    }
    walkItems(state.items.items);
    if (dirty) await saveItems();
}

// ─── One-time migration: rename 'someday' → 'ongoing' in existing items ───
async function migrateSomedayToOngoing() {
    let dirty = false;
    function walkItems(items) {
        for (const item of items) {
            if (item.timeContexts) {
                const idx = item.timeContexts.indexOf('someday');
                if (idx !== -1) {
                    item.timeContexts[idx] = 'ongoing';
                    dirty = true;
                }
            }
            if (item.contextDurations && item.contextDurations['someday'] != null) {
                item.contextDurations['ongoing'] = item.contextDurations['someday'];
                delete item.contextDurations['someday'];
                dirty = true;
            }
            if (item.children && item.children.length > 0) walkItems(item.children);
        }
    }
    walkItems(state.items.items);
    if (dirty) await saveItems();
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

    // Done / Undo option
    const doneOpt = document.createElement('div');
    doneOpt.className = 'project-context-menu-item';
    doneOpt.textContent = item.done ? 'Undo' : 'Done';
    doneOpt.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        const newDone = !item.done;
        await api.patch(`/items/${item.id}`, { done: newDone });
        item.done = newDone;
        if (newDone) {
            const ancestorPath = getAncestorPath(item.id);
            const ancestors = ancestorPath
                ? ancestorPath.map(a => a.name).join(' › ')
                : '';
            await api.post('/timeline', {
                text: `Done: ${item.name}`,
                projectName: ancestors || null,
                type: 'completion'
            });
            state.timeline = await api.get('/timeline');
            // Deselect if hiding done items
            if (!state.showDone && state.selectedItemId === item.id) {
                state.selectedItemId = null;
                savePref('selectedItemId', '');
            }
        }
        renderAll();
    });
    menu.appendChild(doneOpt);

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

    // → Ongoing / Future options for projects
    for (const epoch of ['ongoing', 'future']) {
        const epochIcons = { ongoing: '📦', future: '🔮' };
        const epochLabels = { ongoing: 'Ongoing', future: 'Future' };
        const projEpochOpt = document.createElement('div');
        projEpochOpt.className = 'project-context-menu-item';
        projEpochOpt.textContent = `→ ${epochIcons[epoch]} ${epochLabels[epoch]}`;
        projEpochOpt.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            await sendToEpoch(item.id, epoch);
        });
        menu.appendChild(projEpochOpt);
    }

    // Goal option
    const goalOpt = document.createElement('div');
    goalOpt.className = 'project-context-menu-item';
    goalOpt.textContent = item.goal ? 'Edit Goal...' : 'Set Goal...';
    goalOpt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        openGoalModal(item.id, item.name);
    });
    menu.appendChild(goalOpt);

    // Move to... option
    const moveToOpt = document.createElement('div');
    moveToOpt.className = 'project-context-menu-item';
    moveToOpt.textContent = 'Move to...';
    moveToOpt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        openMoveToModal(item.id, item.name);
    });
    menu.appendChild(moveToOpt);

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
            savePref('selectedItemId', '');
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

    const selCount = state.selectedActionIds.size;
    const isBulk = selCount > 1;
    const bulkSuffix = isBulk ? ` (${selCount})` : '';

    const menu = document.createElement('div');
    menu.className = 'project-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    // ── Single-item only options ──
    if (!isBulk) {
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
    }

    // Done / Undo option
    const doneOpt = document.createElement('div');
    doneOpt.className = 'project-context-menu-item';
    if (isBulk) {
        doneOpt.textContent = `Done${bulkSuffix}`;
        doneOpt.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            await bulkMarkDone();
        });
    } else {
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
    }
    menu.appendChild(doneOpt);

    // Work option (only for non-done, single item)
    if (!isBulk && !action.done) {
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

        // Followup option (single only)
        const followupOpt = document.createElement('div');
        followupOpt.className = 'project-context-menu-item';
        followupOpt.textContent = 'Followup';
        followupOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            const actionEl = document.querySelector(`.action-item[data-id="${action.id}"]`);
            if (actionEl) {
                const btn = actionEl.querySelector('.action-btn-followup');
                if (btn && !btn.disabled) btn.click();
            }
        });
        menu.appendChild(followupOpt);
    }

    // ── Time Context / Schedule options ──
    if (!action.done || isBulk) {
        const todayKey = getDateKey(state.timelineViewDate);
        const viewIsToday = isCurrentDay(state.timelineViewDate);
        const dateLabel = viewIsToday ? 'today' : state.timelineViewDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        if (isBulk) {
            // Bulk: Add all to today
            const addTodayOpt = document.createElement('div');
            addTodayOpt.className = 'project-context-menu-item';
            addTodayOpt.textContent = `Add to ${dateLabel}${bulkSuffix}`;
            addTodayOpt.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                dismissProjectContextMenu();
                for (const id of state.selectedActionIds) {
                    await addTimeContext(parseInt(id, 10), todayKey);
                }
            });
            menu.appendChild(addTodayOpt);
        } else if (!action.done) {
            const actionItem = findItemById(action.id);
            const hasToday = actionItem && actionItem.timeContexts && actionItem.timeContexts.includes(todayKey);
            const todayOpt = document.createElement('div');
            todayOpt.className = 'project-context-menu-item';
            todayOpt.textContent = hasToday ? `Remove from ${dateLabel}` : `Add to ${dateLabel}`;
            todayOpt.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                dismissProjectContextMenu();
                await toggleTimeContext(action.id, todayKey);
            });
            menu.appendChild(todayOpt);
        }

        // Schedule for specific date
        const schedOpt = document.createElement('div');
        schedOpt.className = 'project-context-menu-item';
        schedOpt.textContent = `Schedule for...${bulkSuffix}`;
        schedOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            if (isBulk) {
                bulkSchedule();
            } else {
                openScheduleModal(action.id, action.name);
            }
        });
        menu.appendChild(schedOpt);

        // → Ongoing / Future options
        for (const epoch of ['ongoing', 'future']) {
            const epochIcons = { ongoing: '📦', future: '🔮' };
            const epochLabels = { ongoing: 'Ongoing', future: 'Future' };
            const epochOpt = document.createElement('div');
            epochOpt.className = 'project-context-menu-item';
            epochOpt.textContent = `→ ${epochIcons[epoch]} ${epochLabels[epoch]}${bulkSuffix}`;
            epochOpt.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                dismissProjectContextMenu();
                if (isBulk) {
                    for (const id of state.selectedActionIds) {
                        await sendToEpoch(parseInt(id, 10), epoch);
                    }
                } else {
                    await sendToEpoch(action.id, epoch);
                }
            });
            menu.appendChild(epochOpt);
        }
    }

    // Goal option (single only)
    if (!isBulk) {
        const goalOpt = document.createElement('div');
        goalOpt.className = 'project-context-menu-item';
        const actionItemForGoal = findItemById(action.id);
        goalOpt.textContent = (actionItemForGoal && actionItemForGoal.goal) ? 'Edit Goal...' : 'Set Goal...';
        goalOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            openGoalModal(action.id, action.name);
        });
        menu.appendChild(goalOpt);
    }

    // Move to... option (single only)
    if (!isBulk) {
        const moveToOpt = document.createElement('div');
        moveToOpt.className = 'project-context-menu-item';
        moveToOpt.textContent = 'Move to...';
        moveToOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            openMoveToModal(action.id, action.name);
        });
        menu.appendChild(moveToOpt);
    }

    // Decline option (danger)
    const declineOpt = document.createElement('div');
    declineOpt.className = 'project-context-menu-item project-context-menu-item-danger';
    declineOpt.textContent = `Decline${bulkSuffix}`;
    declineOpt.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        if (isBulk) {
            await bulkDecline();
        } else {
            await api.del(`/items/${action.id}`);
            await reloadItems();
        }
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
        // Skip done leaves when showDone is off — they shouldn't appear in search results
        const leaf = isLeaf(item);
        if (!state.showDone && leaf && !item.isInbox && item.done) continue;

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

// Collect items visible under the current time context.
// An item is visible if it matches the time context (or is "anytime"),
// OR if any descendant is visible (so branch structure stays navigable).
function collectTimeContextMatches(items, dateKey, visibleIds) {
    let anyVisible = false;
    for (const item of items) {
        let selfMatch;
        if (state.viewHorizon === 'epoch') {
            // In epoch horizon, show items with the active epoch context (self or ancestor)
            selfMatch = isItemInEpoch(item, state.epochFilter);
        } else if (state.viewHorizon === 'week') {
            const weekKey = getWeekKey(state.timelineViewDate);
            selfMatch = isItemInWeek(item, weekKey);
        } else {
            selfMatch = itemMatchesTimeContext(item, dateKey);
        }
        // Done leaves hidden by the done filter should not propagate schedule visibility
        const doneHidden = !state.showDone && isLeaf(item) && !item.isInbox && item.done;
        let childVisible = false;
        if (item.children && item.children.length > 0) {
            childVisible = collectTimeContextMatches(item.children, dateKey, visibleIds);
        }
        if ((selfMatch && !doneHidden) || childVisible) {
            visibleIds.add(item.id);
            anyVisible = true;
        }
        // Inbox is always visible
        if (item.isInbox) {
            visibleIds.add(item.id);
        }
    }
    return anyVisible;
}

// ─── Projects Rendering (full tree hierarchy) ───
function renderProjects() {
    const container = document.getElementById('project-tree');
    const savedScrollTop = container.scrollTop;
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
    {
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

    // Restore scroll position after rebuild
    container.scrollTop = savedScrollTop;

    // Update clear button visibility
    const clearBtn = document.getElementById('project-search-clear');
    if (clearBtn) {
        clearBtn.style.display = query ? '' : 'none';
    }

    // Update scroll-to-selected banner after DOM settles
    requestAnimationFrame(() => updateScrollToSelectedBanner());
}

// ─── Scroll-to-Selected Banner ───
let _scrollBannerDebounce = null;

function updateScrollToSelectedBanner() {
    const banner = document.getElementById('scroll-to-selected-banner');
    if (!banner) return;

    const arrowEl = document.getElementById('scroll-to-selected-arrow');
    const textEl = document.getElementById('scroll-to-selected-text');
    const container = document.getElementById('project-tree');

    // No selection → hide
    if (!state.selectedItemId) {
        banner.style.display = 'none';
        return;
    }

    const selectedName = findItemName(state.selectedItemId);
    if (!selectedName) {
        banner.style.display = 'none';
        return;
    }

    // Check if the selected item's row is in the DOM
    const selectedRow = container.querySelector(`.project-item.selected`);

    if (!selectedRow) {
        // Case B: item is not in the DOM (collapsed ancestor)
        banner.style.display = '';
        banner.className = 'scroll-to-selected-banner scroll-to-selected-collapsed';
        arrowEl.textContent = '⋯';
        textEl.textContent = selectedName;
        return;
    }

    // Case A: item is in the DOM — check if it's visible in the scroll container
    const containerRect = container.getBoundingClientRect();
    const rowRect = selectedRow.getBoundingClientRect();

    const isAbove = rowRect.bottom < containerRect.top;
    const isBelow = rowRect.top > containerRect.bottom;

    if (!isAbove && !isBelow) {
        // Visible — hide the banner
        banner.style.display = 'none';
        return;
    }

    banner.style.display = '';
    if (isAbove) {
        banner.className = 'scroll-to-selected-banner scroll-to-selected-above';
        arrowEl.textContent = '↑';
    } else {
        banner.className = 'scroll-to-selected-banner scroll-to-selected-below';
        arrowEl.textContent = '↓';
    }
    textEl.textContent = selectedName;
}

function scrollToSelectedItem() {
    if (!state.selectedItemId) return;

    const container = document.getElementById('project-tree');
    let selectedRow = container.querySelector(`.project-item.selected`);

    if (!selectedRow) {
        // Item not in the DOM — expand all ancestors
        const ancestors = getAncestorPath(state.selectedItemId);
        if (ancestors) {
            let changed = false;
            for (const ancestor of ancestors) {
                if (!ancestor.expanded) {
                    ancestor.expanded = true;
                    changed = true;
                }
            }
            if (changed) {
                saveItems();
                renderProjects();
            }
        }
        // Try to find it again after re-render
        selectedRow = container.querySelector(`.project-item.selected`);
    }

    if (selectedRow) {
        selectedRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
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



        // ─── Insert marker BEFORE this item (skip before Inbox) ───
        if (!isInbox) {
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

        // ─── Drag source (Inbox is not draggable) ───
        if (!isInbox) {
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                dragState.draggedId = item.id;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-action-id', String(item.id));
                window._draggedAction = item;
                row.classList.add('dragging');
                document.getElementById('project-tree').classList.add('dragging-active');
                document.body.classList.add('dragging-to-timeline');
                requestAnimationFrame(() => row.classList.add('dragging'));
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('dragging');
                document.getElementById('project-tree').classList.remove('dragging-active');
                document.body.classList.remove('dragging-to-timeline');
                dragState.draggedId = null;
                dragState.dropTarget = null;
                window._draggedAction = null;
                clearDropIndicators();
                document.querySelectorAll('.time-block-drag-over').forEach(el => el.classList.remove('time-block-drag-over'));
                document.querySelectorAll('.horizon-layer-drag-over').forEach(el => el.classList.remove('horizon-layer-drag-over'));
                document.querySelectorAll('.date-nav-btn-drag-over').forEach(el => el.classList.remove('date-nav-btn-drag-over'));
            });
        }

        // ─── Drop target ───
        {
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

        // Goal badge on project items
        if (item.goal) {
            const progress = getGoalProgress(item);
            if (progress) {
                const gBadge = document.createElement('span');
                gBadge.className = `project-goal-badge project-goal-badge-${progress.type}`;
                gBadge.textContent = progress.label;
                if (progress.percent >= 100) gBadge.classList.add('project-goal-complete');
                row.appendChild(gBadge);
            }
        }

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
            let leaves = collectLeaves([item]);
            // Show total non-done leaves — no time context filter since sidebar is
            // the context provider, not the consumer.
            if (!state.showDone) {
                leaves = leaves.filter(l => !l.done);
            }
            const badge = document.createElement('span');
            badge.className = 'project-count';
            badge.textContent = `${leaves.length}`;
            if (leaves.length === 0) badge.classList.add('project-count-zero');
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
                    savePref('selectedItemId', '');
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
            savePref('selectedItemId', state.selectedItemId || '');
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

    // ─── Insert marker AFTER the last item ───
    {
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
                parentId: parentId,
                timeContexts: getCurrentTimeContexts()
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
    const savedScrollTop = container.scrollTop;
    const empty = document.getElementById('actions-empty');

    // ── Ground indicator (live session) — always visible at top of Actions ──
    _renderLiveSessionIndicator();

    // ── Sleep mode: show "Good Night" instead of actions ──
    if (isInSleepRange() && !state.workingOn && !state.onBreak) {
        container.querySelectorAll('.action-item, .action-group-header').forEach(el => el.remove());
        empty.style.display = '';
        empty.innerHTML = '';
        const icon = document.createElement('span');
        icon.className = 'empty-icon';
        icon.textContent = '🌙';
        empty.appendChild(icon);
        const msg = document.createElement('span');
        msg.textContent = 'Good Night';
        empty.appendChild(msg);
        const hint = document.createElement('span');
        hint.className = 'empty-hint';
        hint.textContent = 'time to rest — you earned it';
        empty.appendChild(hint);
        return;
    }

    // Remove existing items but not the empty state and bulk bar
    container.querySelectorAll('.action-item, .action-group-header').forEach(el => el.remove());

    const filteredActions = getFilteredActions();

    if (filteredActions.length === 0) {
        empty.style.display = '';

        // ── Context-aware empty state: show reset hints when filters are narrowing ──
        const projectIsFiltered = !!state.selectedItemId;
        const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
        const viewKey = getDateKey(state.timelineViewDate);
        const todayKey = getDateKey(getLogicalToday());
        const timeIsFiltered = !!focusedSession || state.viewHorizon === 'epoch' || viewKey !== todayKey;

        if (projectIsFiltered || timeIsFiltered) {
            // Replace default empty state content with filter-aware message
            empty.innerHTML = '';

            const icon = document.createElement('span');
            icon.className = 'empty-icon';
            icon.textContent = '✨';
            empty.appendChild(icon);

            const msg = document.createElement('span');
            msg.textContent = 'Quiet here, isn\u0027t it?';
            empty.appendChild(msg);

            const btnRow = document.createElement('div');
            btnRow.className = 'empty-reset-row';

            if (projectIsFiltered) {
                const selectedItem = findItemById(state.selectedItemId);
                const resetProject = document.createElement('button');
                resetProject.className = 'empty-reset-btn';
                resetProject.textContent = '📁 All';
                resetProject.title = 'Show all projects';
                resetProject.addEventListener('click', (e) => {
                    e.stopPropagation();
                    state.selectedItemId = null;
                    savePref('selectedItemId', '');
                    renderAll();
                });
                btnRow.appendChild(resetProject);
            }

            if (timeIsFiltered) {
                const resetTime = document.createElement('button');
                resetTime.className = 'empty-reset-btn';
                // Build a label showing current time filter
                let timeLabel = '📅';
                if (focusedSession) {
                    timeLabel += ` ${formatTime(focusedSession.startMs)}–${formatTime(focusedSession.endMs)}`;
                } else if (state.viewHorizon === 'epoch') {
                    const epochLabels = { past: 'Past', ongoing: 'Ongoing', future: 'Future' };
                    timeLabel += ` ${epochLabels[state.epochFilter] || 'Ongoing'}`;
                } else {
                    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    const d = state.timelineViewDate;
                    timeLabel += ` ${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
                }
                resetTime.textContent = '📅 Today';
                resetTime.title = 'Back to today';
                resetTime.addEventListener('click', (e) => {
                    e.stopPropagation();
                    clearFocusStack();
                    state.viewHorizon = 'day';
                    savePref('viewHorizon', 'day');
                    state.timelineViewDate = new Date();
                    renderAll();
                });
                btnRow.appendChild(resetTime);
            }

            empty.appendChild(btnRow);
        } else {
            // Default empty state
            empty.innerHTML = `
                <span class="empty-icon">✨</span>
                <span>What's on your mind?</span>
                <span class="empty-hint">one small win at a time</span>
            `;
        }

        // Prune selection — nothing visible
        state.selectedActionIds.clear();
        state.selectionAnchor = null;
        updateBulkActionBar();
        updateCapacitySummary([]);
        return;
    }
    empty.style.display = 'none';

    // Sort: 3-tier — undone+goal first, undone second, done last. Tree order within each tier.
    const indexed = filteredActions.map((a, i) => ({ ...a, _treeIdx: i }));
    const sorted = indexed.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        const aHasGoal = hasActiveGoal(a);
        const bHasGoal = hasActiveGoal(b);
        if (aHasGoal !== bHasGoal) return aHasGoal ? -1 : 1;
        return a._treeIdx - b._treeIdx;
    });

    // Store visible sorted IDs for shift-click range selection
    state._visibleActionIds = sorted.map(a => String(a.id));

    // Prune stale selections (items no longer visible)
    const visibleSet = new Set(state._visibleActionIds);
    for (const id of state.selectedActionIds) {
        if (!visibleSet.has(id)) state.selectedActionIds.delete(id);
    }

    // ── Grouping by ancestor ──
    // When no project context: group by root ancestor (_path[0])
    // When project context is active: group by the first child below the selected project
    let rootGroups = null;
    let distinctRoots = 0;
    // Track which _path index is used for the grouping ancestor (for breadcrumb stripping)
    let groupAncestorPathIdx = 0;

    {
        rootGroups = new Map(); // groupId → { root: {id,name}, actions: [] }
        for (const action of sorted) {
            let groupAncestor = null;
            if (state.selectedItemId && action._path) {
                // Find the selected project's position in the path
                const selIdx = action._path.findIndex(p => p.id === state.selectedItemId);
                if (selIdx >= 0 && selIdx + 1 < action._path.length - 1) {
                    // Group by the first child below the selected project
                    groupAncestor = action._path[selIdx + 1];
                    groupAncestorPathIdx = selIdx + 1;
                }
                // else: item is a direct child of selected → no sub-group
            } else if (action._path && action._path.length > 0) {
                groupAncestor = action._path[0];
                groupAncestorPathIdx = 0;
            }
            const groupId = groupAncestor ? groupAncestor.id : 0;
            if (!rootGroups.has(groupId)) {
                rootGroups.set(groupId, { root: groupAncestor, actions: [] });
            }
            rootGroups.get(groupId).actions.push(action);
        }
        distinctRoots = rootGroups.size;
    }

    const fragment = document.createDocumentFragment();
    // Track actually-rendered action IDs (excluding collapsed)
    const renderedIds = [];

    if (distinctRoots >= 2) {
        // Render with group headers
        state._actionGroupingActive = true;
        for (const [rootId, group] of rootGroups) {
            const isCollapsed = state.collapsedGroups.has(rootId);
            // Create group header
            const header = document.createElement('div');
            header.className = 'action-group-header' + (isCollapsed ? ' collapsed' : '');
            header.dataset.rootId = rootId;

            const chevron = document.createElement('span');
            chevron.className = 'action-group-chevron';
            chevron.textContent = isCollapsed ? '▸' : '▾';
            header.appendChild(chevron);

            const nameEl = document.createElement('span');
            nameEl.className = 'action-group-name';
            nameEl.textContent = group.root ? group.root.name : 'Ungrouped';
            header.appendChild(nameEl);

            const countEl = document.createElement('span');
            countEl.className = 'action-group-count';
            countEl.textContent = group.actions.length;
            header.appendChild(countEl);

            const groupTotalMins = group.actions.reduce((sum, a) => {
                const item = findItemById(a.id);
                return sum + getContextDuration(item);
            }, 0);
            if (groupTotalMins > 0) {
                const durEl = document.createElement('span');
                durEl.className = 'action-group-duration';
                durEl.textContent = groupTotalMins >= 60
                    ? `${Math.floor(groupTotalMins / 60)}h${groupTotalMins % 60 ? groupTotalMins % 60 + 'm' : ''}`
                    : `${groupTotalMins}m`;
                header.appendChild(durEl);
            }

            header.addEventListener('click', () => {
                if (state.collapsedGroups.has(rootId)) {
                    state.collapsedGroups.delete(rootId);
                } else {
                    state.collapsedGroups.add(rootId);
                }
                savePref('collapsedGroups', [...state.collapsedGroups]);
                renderActions();
            });

            fragment.appendChild(header);

            if (!isCollapsed) {
                for (const action of group.actions) {
                    fragment.appendChild(createActionElement(action));
                    renderedIds.push(String(action.id));
                }
            }
        }
    } else {
        // Flat (no grouping)
        state._actionGroupingActive = false;
        for (const action of sorted) {
            fragment.appendChild(createActionElement(action));
            renderedIds.push(String(action.id));
        }
    }

    // Update visible IDs to only include rendered (non-collapsed) actions
    state._visibleActionIds = renderedIds;

    container.appendChild(fragment);

    // Restore scroll position after rebuild
    container.scrollTop = savedScrollTop;

    updateBulkActionBar();
    updateCapacitySummary(sorted);
}

function getFilteredActions() {
    let allLeaves = collectAllItems();

    // Filter out done items unless showDone is on
    if (!state.showDone) {
        allLeaves = allLeaves.filter(a => !a.done);
    }

    // ── Horizon + Schedule filter ──
    const currentDateKey = getDateKey(state.timelineViewDate);
    if (state.viewHorizon === 'epoch') {
        // Show only items in the active epoch
        allLeaves = allLeaves.filter(a => isItemInEpoch(a, state.epochFilter));
    } else if (state.viewHorizon === 'week') {
        // Show only items with the current week context (no specific day)
        const weekKey = getWeekKey(state.timelineViewDate);
        allLeaves = allLeaves.filter(a => isItemInWeek(a, weekKey));
    } else {
        allLeaves = allLeaves.filter(a => itemMatchesTimeContext(a, currentDateKey));
    }
    // ── Session focus: when focused, show items relevant to this session ──
    const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    if (focusedSession) {
        const fs = focusedSession;
        // Re-collect ALL leaves (including segment-context items) for this filter
        let sessionLeaves = collectAllItems();
        if (!state.showDone) sessionLeaves = sessionLeaves.filter(a => !a.done);

        // For item-bound planned sessions, pre-compute descendant IDs for scope constraint
        let planDescendantIds = null;
        if (fs.type === 'planned' && fs.itemId) {
            const planItem = findItemById(fs.itemId);
            if (planItem) planDescendantIds = new Set(collectDescendantIds(planItem));
        }

        // Filter to items with segment contexts overlapping the focused session
        sessionLeaves = sessionLeaves.filter(a => {
            const item = findItemById(a.id);
            if (!item) return false;

            // For item-bound planned sessions, enforce descendant constraint
            if (planDescendantIds && !planDescendantIds.has(a.id)) return false;

            // Items with live context matching the focused work/break session
            if (fs.liveType && item.timeContexts) {
                const liveCtx = `${currentDateKey}@${fs.liveType}`;
                if (item.timeContexts.includes(liveCtx)) return true;
            }

            // Items with entry-ID context matching a focused planned/past session
            if (fs.entryId && item.timeContexts) {
                const entryCtx = `${currentDateKey}@entry:${fs.entryId}`;
                if (item.timeContexts.includes(entryCtx)) return true;
            }

            // For live sessions (working, break), don't fall through
            // to time-overlap matching — only live-matched or unscheduled items
            if (fs.liveType) {
                if ((fs.type === 'working' || fs.type === 'break') && isItemUnscheduled(a)) {
                    return itemMatchesTimeContext(a, currentDateKey);
                }
                return false;
            }

            // Items with segment context overlapping the session
            if (item.timeContexts) {
                for (const tc of item.timeContexts) {
                    const parsed = parseTimeContext(tc);
                    if (!parsed || parsed.date !== currentDateKey) continue;
                    if (parsed.segment) {
                        const [sh, sm] = parsed.segment.start.split(':').map(Number);
                        const [eh, em] = parsed.segment.end.split(':').map(Number);
                        const refDate = new Date(fs.startMs);
                        const tcStart = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), sh, sm).getTime();
                        let tcEnd = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), eh, em).getTime();
                        // Cross-midnight: if end time is before start time, end is next calendar day
                        if (tcEnd <= tcStart) tcEnd += 24 * 60 * 60 * 1000;
                        const overlapStart = Math.max(fs.startMs, tcStart);
                        const overlapEnd = Math.min(fs.endMs, tcEnd);
                        if (overlapEnd > overlapStart) return true;
                    }
                }
            }
            // Unscheduled items show in free time and planned sessions
            if ((fs.type === 'free' || fs.type === 'planned') && isItemUnscheduled(a)) {
                return itemMatchesTimeContext(a, currentDateKey);
            }
            return false;
        });
        // Apply project filter if active (strict descendants only)
        if (state.selectedItemId) {
            const selectedItem = findItemById(state.selectedItemId);
            if (selectedItem) {
                const descendantIds = collectDescendantIds(selectedItem);
                sessionLeaves = sessionLeaves.filter(leaf => descendantIds.includes(leaf.id) && leaf.id !== selectedItem.id);
            }
        }

        // ── Phantom lead-time clones: add ghost duplicate for items with sub-24h segment lead times ──
        if (fs.type === 'free') {
            const phantomClones = [];
            for (const a of sessionLeaves) {
                const item = findItemById(a.id);
                if (!item?.contextLeadTimes) continue;
                for (const [ctx, leadSec] of Object.entries(item.contextLeadTimes)) {
                    if (leadSec >= 86400) continue;
                    const parsed = parseTimeContext(ctx);
                    if (!parsed?.segment || parsed.date !== currentDateKey) continue;
                    const [sh, sm] = parsed.segment.start.split(':').map(Number);
                    const [eh, em] = parsed.segment.end.split(':').map(Number);
                    const refDate = new Date(fs.startMs);
                    const tcStart = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), sh, sm).getTime();
                    let tcEnd = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), eh, em).getTime();
                    if (tcEnd <= tcStart) tcEnd += 24 * 60 * 60 * 1000;
                    if (Math.min(fs.endMs, tcEnd) > Math.max(fs.startMs, tcStart)) {
                        phantomClones.push({
                            ...a,
                            id: `phantom-${a.id}`,
                            _realId: a.id,
                            _isPhantom: true,
                            _phantomDurMins: Math.round(leadSec / 60),
                        });
                        break;
                    }
                }
            }
            // Insert each phantom right before its corresponding real item
            for (const clone of phantomClones) {
                const idx = sessionLeaves.findIndex(l => String(l.id) === String(clone._realId));
                if (idx >= 0) {
                    sessionLeaves.splice(idx, 0, clone);
                } else {
                    sessionLeaves.unshift(clone);
                }
            }
        }

        return sessionLeaves;
    }

    // Exclude items with segment-level contexts — they belong to the timeline, not Actions.
    // Exception: overnight segments that are still live (their start is "past" but end
    // hasn't arrived yet) — keep them visible in Actions so they don't vanish entirely.
    const nowForSegCheck = new Date();
    allLeaves = allLeaves.filter(a => {
        const item = findItemById(a.id);
        if (!hasSegmentContext(item, currentDateKey)) return true;
        // Check if ALL segment contexts for this date are overnight-and-still-live
        // If so, keep the item in Actions
        const segContexts = (item.timeContexts || []).filter(tc => tc.startsWith(currentDateKey + '@'));
        return segContexts.every(tc => {
            const p = parseTimeContext(tc);
            return p && p.segment && _isOvernightSegmentLive(p, nowForSegCheck);
        });
    });

    if (!state.selectedItemId) return allLeaves;

    // Get all descendant IDs of the selected project (works for Inbox too)
    const selectedItem = findItemById(state.selectedItemId);
    if (!selectedItem) return allLeaves;

    // Strict descendants only — selecting a project shows its contents, not itself
    const descendantIds = collectDescendantIds(selectedItem);

    return allLeaves.filter(leaf => descendantIds.includes(leaf.id) && leaf.id !== selectedItem.id);
}

// ─── Multiselect Helpers ───

// Light refresh: update .selected classes + bulk bar without a full re-render
function refreshActionSelectionUI() {
    document.querySelectorAll('.action-item').forEach(el => {
        const id = String(el.dataset.id);
        el.classList.toggle('selected', state.selectedActionIds.has(id));
    });
    updateBulkActionBar();
}

function clearActionSelection() {
    state.selectedActionIds.clear();
    state.selectionAnchor = null;
    refreshActionSelectionUI();
}

// ── Bulk Action Bar ──
function updateBulkActionBar() {
    const container = document.getElementById('actions-list');
    if (!container) return;

    let bar = document.getElementById('bulk-action-bar');
    const count = state.selectedActionIds.size;

    if (count <= 1) {
        if (bar) bar.style.display = 'none';
        return;
    }

    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'bulk-action-bar';
        bar.className = 'bulk-action-bar';
        container.parentElement.appendChild(bar);
    }

    bar.innerHTML = '';
    bar.style.display = '';

    // Selection count
    const label = document.createElement('span');
    label.className = 'bulk-bar-label';
    label.textContent = `${count} selected`;
    bar.appendChild(label);

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    bar.appendChild(spacer);

    // Done button
    const doneBtn = document.createElement('button');
    doneBtn.className = 'bulk-bar-btn bulk-bar-btn-done';
    doneBtn.textContent = '✓ Done';
    doneBtn.title = `Mark ${count} item(s) as done`;
    doneBtn.addEventListener('click', bulkMarkDone);
    bar.appendChild(doneBtn);

    // Schedule button
    const schedBtn = document.createElement('button');
    schedBtn.className = 'bulk-bar-btn bulk-bar-btn-schedule';
    schedBtn.textContent = '📅 Schedule';
    schedBtn.title = `Schedule ${count} item(s)`;
    schedBtn.addEventListener('click', bulkSchedule);
    bar.appendChild(schedBtn);

    // Decline button
    const declineBtn = document.createElement('button');
    declineBtn.className = 'bulk-bar-btn bulk-bar-btn-decline';
    declineBtn.textContent = '✕ Decline';
    declineBtn.title = `Decline ${count} item(s)`;
    declineBtn.addEventListener('click', bulkDecline);
    bar.appendChild(declineBtn);

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'bulk-bar-btn bulk-bar-btn-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Deselect all';
    clearBtn.addEventListener('click', clearActionSelection);
    bar.appendChild(clearBtn);
}

// ── Bulk Operations ──

async function bulkMarkDone() {
    const ids = [...state.selectedActionIds];
    if (ids.length === 0) return;

    for (const id of ids) {
        const numId = parseInt(id, 10);
        await api.patch(`/items/${numId}`, { done: true });
        const item = findItemById(numId);
        if (item) item.done = true;
    }
    // Log a single combined completion entry
    const names = ids.map(id => findItemName(parseInt(id, 10)) || id);
    await api.post('/timeline', {
        text: `Done ${ids.length} items: ${names.join(', ')}`,
        projectName: null,
        type: 'completion'
    });
    state.timeline = await api.get('/timeline');
    clearActionSelection();
    renderAll();
}

function bulkSchedule() {
    const ids = [...state.selectedActionIds].map(id => parseInt(id, 10));
    if (ids.length === 0) return;
    openScheduleModal(ids, `${ids.length} items`);
}

async function bulkDecline() {
    const ids = [...state.selectedActionIds];
    if (ids.length === 0) return;
    if (!confirm(`Decline ${ids.length} action(s)? This cannot be undone.`)) return;

    for (const id of ids) {
        await api.del(`/items/${parseInt(id, 10)}`);
    }
    clearActionSelection();
    await reloadItems();
}

// ── Ambient deselection: clicking empty space in actions list clears selection ──
document.addEventListener('DOMContentLoaded', () => {
    const actionsList = document.getElementById('actions-list');
    if (actionsList) {
        actionsList.addEventListener('click', (e) => {
            // Only if clicking directly on the container (empty space), not a child
            if (e.target === actionsList || e.target.classList.contains('empty-state')) {
                clearActionSelection();
            }
        });

        // ── Drop handler for drag-out from segment queue ──
        const actionsSection = document.getElementById('section-actions');
        if (actionsSection) {
            actionsSection.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('application/x-segment-item-id') &&
                    !e.dataTransfer.types.includes('application/x-action-id')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                actionsSection.classList.add('actions-drag-over');
            });
            actionsSection.addEventListener('dragleave', (e) => {
                if (e.relatedTarget && actionsSection.contains(e.relatedTarget)) return;
                actionsSection.classList.remove('actions-drag-over');
            });
            actionsSection.addEventListener('drop', (e) => {
                console.log('[ACTIONS] drop event, types:', [...e.dataTransfer.types]);
                // Segment drag-out path (drag from segment queue back to actions)
                if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                    e.preventDefault();
                    actionsSection.classList.remove('actions-drag-over');
                    const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                    const segCtx = e.dataTransfer.getData('application/x-segment-context');
                    if (itemId && segCtx) {
                        degradeSegmentContext(itemId, segCtx);
                    }
                    return;
                }
                // Project-to-Actions: assign current time context + select as project filter
                if (e.dataTransfer.types.includes('application/x-action-id')) {
                    const itemId = parseInt(e.dataTransfer.getData('application/x-action-id'), 10);
                    const item = findItemById(itemId);
                    if (!item) return;
                    e.preventDefault();
                    actionsSection.classList.remove('actions-drag-over');
                    window._draggedAction = null;
                    const ctxs = getCurrentTimeContexts();
                    (async () => {
                        // Strip existing entry/session/segment contexts that are subsumed
                        // by the plain-date contexts being assigned (fixes dragging an item
                        // with an entry context to day — the entry context must be removed).
                        if (item.timeContexts) {
                            const plainDates = ctxs.filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c));
                            if (plainDates.length > 0) {
                                const before = item.timeContexts.length;
                                item.timeContexts = item.timeContexts.filter(tc => {
                                    // Keep if it's not a sub-context of any plain date being added
                                    return !plainDates.some(d => tc.startsWith(d + '@'));
                                });
                                // Clean up contextDurations for removed contexts
                                if (item.contextDurations && item.timeContexts.length < before) {
                                    for (const key of Object.keys(item.contextDurations)) {
                                        if (plainDates.some(d => key.startsWith(d + '@'))) {
                                            delete item.contextDurations[key];
                                        }
                                    }
                                }
                            }
                        }
                        // Assign current time context
                        for (const ctx of ctxs) { await addTimeContext(itemId, ctx); }
                        // Reparent under selected project if applicable
                        if (state.selectedItemId && state.selectedItemId !== itemId) {
                            const selectedItem = findItemById(state.selectedItemId);
                            if (selectedItem) {
                                // Only reparent if the item isn't already a descendant of the selected project
                                const descIds = collectDescendantIds(selectedItem);
                                if (!descIds.includes(itemId)) {
                                    moveItem(itemId, { id: state.selectedItemId, position: 'inside' });
                                    saveItems();
                                }
                            }
                        }
                        renderAll();
                    })();
                }
            });
        }
    }
});

function createActionElement(action) {
    // ── Phantom lead-time clone: simplified ghost rendering ──
    if (action._isPhantom) {
        const item = document.createElement('div');
        item.className = 'action-item action-item-shadow';
        item.style.cursor = 'default';
        const content = document.createElement('div');
        content.className = 'action-content';
        const nameEl = document.createElement('span');
        nameEl.className = 'action-name';
        nameEl.textContent = `⏳ ${action.name}`;
        content.appendChild(nameEl);
        if (action._phantomDurMins) {
            const dur = document.createElement('span');
            dur.className = 'action-deadline-badge';
            dur.textContent = `~${action._phantomDurMins}m`;
            dur.style.marginLeft = '6px';
            content.appendChild(dur);
        }
        item.appendChild(content);
        return item;
    }

    const item = document.createElement('div');
    const actionIdStr = String(action.id);
    item.className = 'action-item' + (action.done ? ' done' : '') + (state.selectedActionIds.has(actionIdStr) ? ' selected' : '');
    item.dataset.id = action.id;

    // ── Multiselect click handler ──
    item.addEventListener('click', (e) => {
        // Don't trigger selection from buttons / inputs / interactive zones
        if (e.target.closest('button, input, .action-btn, .action-name')) return;
        e.preventDefault();

        const id = actionIdStr;
        if (e.shiftKey && state.selectionAnchor !== null) {
            // Range select
            const ids = state._visibleActionIds || [];
            const anchorIdx = ids.indexOf(state.selectionAnchor);
            const clickIdx = ids.indexOf(id);
            if (anchorIdx >= 0 && clickIdx >= 0) {
                const start = Math.min(anchorIdx, clickIdx);
                const end = Math.max(anchorIdx, clickIdx);
                for (let i = start; i <= end; i++) {
                    state.selectedActionIds.add(ids[i]);
                }
            }
            // Don't update anchor on shift-click
        } else if (e.metaKey || e.ctrlKey) {
            // Toggle select
            if (state.selectedActionIds.has(id)) {
                state.selectedActionIds.delete(id);
            } else {
                state.selectedActionIds.add(id);
            }
            state.selectionAnchor = id;
        } else {
            // Exclusive select / toggle off if already sole selection
            if (state.selectedActionIds.size === 1 && state.selectedActionIds.has(id)) {
                state.selectedActionIds.clear();
                state.selectionAnchor = null;
            } else {
                state.selectedActionIds.clear();
                state.selectedActionIds.add(id);
                state.selectionAnchor = id;
            }
        }
        refreshActionSelectionUI();
    });

    // ── Drag-to-schedule / drag-to-project: make non-done actions draggable ──
    if (!action.done) {
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-action-id', String(action.id));
            e.dataTransfer.effectAllowed = 'copyMove';
            item.classList.add('action-item-dragging');
            // Store action data for the timeline drop handler
            window._draggedAction = action;
            // Also set dragState so project tree drop targets accept this drag
            dragState.draggedId = action.id;
            document.getElementById('project-tree').classList.add('dragging-active');
            document.body.classList.add('dragging-to-timeline');
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('action-item-dragging');
            window._draggedAction = null;
            // Clean up project tree drag state
            dragState.draggedId = null;
            dragState.dropTarget = null;
            document.getElementById('project-tree').classList.remove('dragging-active');
            document.body.classList.remove('dragging-to-timeline');
            clearDropIndicators();
            // Clean up any lingering drag-over states
            document.querySelectorAll('.time-block-drag-over').forEach(el => el.classList.remove('time-block-drag-over'));
            document.querySelectorAll('.horizon-layer-drag-over').forEach(el => el.classList.remove('horizon-layer-drag-over'));
            document.querySelectorAll('.date-nav-btn-drag-over').forEach(el => el.classList.remove('date-nav-btn-drag-over'));
        });
    }

    // Right-click context menu (selection-aware)
    item.addEventListener('contextmenu', (e) => {
        // If right-clicking an unselected item, select it exclusively
        if (!state.selectedActionIds.has(actionIdStr)) {
            state.selectedActionIds.clear();
            state.selectedActionIds.add(actionIdStr);
            state.selectionAnchor = actionIdStr;
            refreshActionSelectionUI();
        }
        showActionContextMenu(e, action);
    });

    const content = document.createElement('div');
    content.className = 'action-content';

    const nameRow = document.createElement('div');
    nameRow.className = 'action-name-row';

    const name = document.createElement('div');
    name.className = 'action-name';
    name.textContent = action.name;
    nameRow.appendChild(name);

    // Locate-in-sidebar icon (hover-reveal, before name)
    const locateBtn = document.createElement('span');
    locateBtn.className = 'action-locate-btn';
    locateBtn.textContent = '◉';
    locateBtn.title = 'Locate in projects';
    locateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.selectedItemId = action.id;
        savePref('selectedItemId', action.id);
        renderAll();
        requestAnimationFrame(() => scrollToSelectedItem());
    });
    nameRow.insertBefore(locateBtn, name);

    content.appendChild(nameRow);

    // Click to rename
    if (!action.done) {
        name.addEventListener('click', (e) => {
            e.stopPropagation();
            startActionInlineRename(name, action);
        });
    }

    // ── Badges row: all metadata badges in a single compact flex row ──
    const badgesRow = document.createElement('div');
    badgesRow.className = 'action-badges';

    // Show ancestor path as breadcrumb tag
    // When grouping is active, strip the group ancestor from the breadcrumb (already shown in header)
    // When a project context is active, strip the selected project and its ancestors too
    if (action._path && action._path.length > 1) {
        let startIdx = 0;
        if (state.selectedItemId) {
            // Find selected project in path, start breadcrumb AFTER it
            const selIdx = action._path.findIndex(p => p.id === state.selectedItemId);
            if (selIdx >= 0) startIdx = selIdx + 1;
        }
        if (state._actionGroupingActive) {
            // Also skip the group header ancestor
            startIdx = Math.max(startIdx, (state.selectedItemId ? startIdx : 0) + 1);
        }
        const ancestors = action._path.slice(startIdx, -1); // -1 to exclude the item itself
        if (ancestors.length === 0) { /* no breadcrumb needed, root is already the header */ }
        else {
            const tag = document.createElement('span');
            tag.className = 'action-project-tag';
            ancestors.forEach((ancestor, idx) => {
                if (idx > 0) {
                    const sep = document.createTextNode(' › ');
                    tag.appendChild(sep);
                }
                const link = document.createElement('span');
                link.className = 'action-project-tag-link';
                link.textContent = ancestor.name;
                link.title = `Select "${ancestor.name}" in projects`;
                link.addEventListener('click', (e) => {
                    e.stopPropagation();
                    state.selectedItemId = ancestor.id;
                    savePref('selectedItemId', ancestor.id);
                    renderAll();
                    // Scroll to the selected project after render
                    requestAnimationFrame(() => scrollToSelectedItem());
                });
                tag.appendChild(link);
            });
            badgesRow.appendChild(tag);
        }
    }

    // Duration estimate badge (context-aware)
    const estimateItem = findItemById(action.id);
    if (!action.done) {
        const estimateBadge = document.createElement('span');
        estimateBadge.className = 'action-estimate-badge';
        const est = getContextDuration(estimateItem);
        if (est) {
            estimateBadge.textContent = est >= 60 ? `${Math.floor(est / 60)}h${est % 60 ? ` ${est % 60}m` : ''}` : `${est}m`;
            estimateBadge.classList.add('has-estimate');
        } else {
            estimateBadge.textContent = '⏱';
            estimateBadge.classList.add('no-estimate');
        }
        estimateBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            showEstimatePicker(estimateBadge, action.id);
        });
        badgesRow.appendChild(estimateBadge);
    }

    // Time context badges removed — the header layers now indicate the active
    // time context, making per-item badges redundant.

    // Show goal progress badge (if this action or an ancestor has a goal)
    const goaledAncestor = findNearestGoal(action);
    if (goaledAncestor) {
        const progress = getGoalProgress(goaledAncestor);
        if (progress) {
            const badge = document.createElement('div');
            badge.className = 'action-goal-badge';

            const bar = document.createElement('div');
            bar.className = 'action-goal-bar';
            const fill = document.createElement('div');
            fill.className = `action-goal-fill action-goal-fill-${progress.type}`;
            fill.style.width = `${progress.percent}%`;
            bar.appendChild(fill);
            badge.appendChild(bar);

            const label = document.createElement('span');
            label.className = 'action-goal-label';
            label.textContent = progress.label;
            badge.appendChild(label);

            if (progress.percent >= 100) badge.classList.add('action-goal-complete');
            badgesRow.appendChild(badge);
        }
    }

    // Deadline/lead time badge
    const actionItemForDeadline = findItemById(action.id);
    if (actionItemForDeadline?.contextLeadTimes) {
        const dateKey = getDateKey(state.timelineViewDate);
        for (const [ctx, leadSec] of Object.entries(actionItemForDeadline.contextLeadTimes)) {
            // Skip sub-24h segment/entry lead times — they're handled as phantom blocks
            const ctxParsedBadge = parseTimeContext(ctx);
            if (leadSec < 86400 && (ctxParsedBadge?.entryId || ctxParsedBadge?.segment)) continue;
            const deadlineDate = parseDateFromContext(ctx);
            if (!deadlineDate) continue;
            const urgency = getDeadlineUrgency(deadlineDate);
            const countdown = formatDeadlineCountdown(deadlineDate);
            const badge = document.createElement('div');
            badge.className = `action-deadline-badge deadline-${urgency}`;
            // If this is a shadow appearance (not directly scheduled for today)
            const directlyScheduled = (actionItemForDeadline.timeContexts || []).some(tc => contextMatchesDate(tc, dateKey));
            if (!directlyScheduled) {
                item.classList.add('action-item-shadow');
            }
            badge.textContent = `📅 ${countdown}`;
            badgesRow.appendChild(badge);
            break; // show only the nearest deadline
        }
    }

    // Only append badges row if it has children
    if (badgesRow.children.length > 0) {
        content.appendChild(badgesRow);
    }

    // Action buttons container
    const buttons = document.createElement('div');
    buttons.className = 'action-buttons';

    // Done button (toggle)
    const doneBtn = document.createElement('button');
    doneBtn.className = 'action-btn action-btn-done';
    doneBtn.textContent = action.done ? '↩' : '✓';
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
    declineBtn.textContent = '✕';
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
                timeContexts: getCurrentTimeContexts()
            });
            await reloadItems();
        });
    } else {
        breakdownBtn.disabled = true;
    }

    // Followup button — marks as done, then creates a new sibling right after it
    const followupBtn = document.createElement('button');
    followupBtn.className = 'action-btn action-btn-followup';
    followupBtn.textContent = '↪';
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
        // Right-click: open duration picker for timed work
        workBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.workingOn && state.workingOn.itemId === action.id) return;
            const ancestors = action._path
                ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                : '';
            showDurationPicker(workBtn, action.id, action.name, ancestors);
        });
    } else {
        workBtn.disabled = true;
    }

    // Schedule button
    const scheduleBtn = document.createElement('button');
    scheduleBtn.className = 'action-btn action-btn-schedule';
    scheduleBtn.textContent = '📅';
    scheduleBtn.title = 'Schedule this action';
    if (!action.done) {
        scheduleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openScheduleModal(action.id, action.name);
        });
    } else {
        scheduleBtn.disabled = true;
    }

    buttons.appendChild(workBtn);
    buttons.appendChild(doneBtn);
    buttons.appendChild(declineBtn);
    buttons.appendChild(scheduleBtn);
    buttons.appendChild(breakdownBtn);

    item.appendChild(content);
    item.appendChild(buttons);

    return item;
}

function setupActionInput() {
    const input = document.getElementById('action-input');
    const btn = document.getElementById('action-input-btn');
    if (!input) return;

    // ── Override State ──
    let _atOverrideId = null;
    let _atOverrideName = null;
    let _hashOverrideContexts = null;   // time context override from #shortcut
    let _hashOverrideName = null;       // display label for time chip

    // ── Generic Dropdown State ──
    let _dropdown = null;
    let _highlightIdx = -1;
    let _dropdownItems = [];
    let _activeTrigger = null;  // which trigger char is active: '@' or '#'
    let _activeTriggerInfo = null; // { atIdx, query } for the active trigger

    const updateBtnVisibility = () => {
        if (!btn) return;
        if (input.value.trim()) {
            btn.classList.add('action-input-btn-visible');
        } else {
            btn.classList.remove('action-input-btn-visible');
        }
    };

    // ── Dropdown helpers (generic) ──
    const _closeDropdown = () => {
        if (_dropdown) { _dropdown.remove(); _dropdown = null; }
        _highlightIdx = -1;
        _dropdownItems = [];
        _activeTrigger = null;
        _activeTriggerInfo = null;
    };

    const _getTriggerQuery = (triggerChar) => {
        const val = input.value;
        const cursor = input.selectionStart;
        const textBeforeCursor = val.slice(0, cursor);
        const idx = textBeforeCursor.lastIndexOf(triggerChar);
        if (idx === -1) return null;
        if (idx > 0 && val[idx - 1] !== ' ') return null;
        const query = textBeforeCursor.slice(idx + 1);
        if (query.includes(' ')) return null;
        return { atIdx: idx, query };
    };

    const _fuzzyMatch = (name, query) => {
        return name.toLowerCase().includes(query.toLowerCase());
    };

    // ── @ Project helpers ──
    const _buildBreadcrumb = (item) => {
        if (!item._path || item._path.length <= 1) return '';
        return item._path.slice(0, -1).map(p => p.name).join(' › ');
    };

    const _getProjectItems = (query) => {
        const allItems = collectAllItems(state.items.items);
        const filtered = query ? allItems.filter(i => _fuzzyMatch(i.name, query)) : allItems;
        return filtered.slice(0, 8).map(item => ({
            id: item.id,
            name: item.name,
            description: _buildBreadcrumb(item),
            _raw: item
        }));
    };

    // ── # Time helpers ──
    const _DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const _DAY_ABBREV = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    const _getNextDayDate = (targetDow) => {
        const today = getLogicalToday();
        const todayDow = today.getDay();
        let diff = (targetDow - todayDow + 7) % 7;
        if (diff === 0) diff = 7; // next occurrence, not today
        const d = new Date(today);
        d.setDate(d.getDate() + diff);
        return d;
    };

    const _addDays = (n) => {
        const d = new Date(getLogicalToday());
        d.setDate(d.getDate() + n);
        return d;
    };

    const _buildTimeOptions = () => {
        const today = getLogicalToday();
        const tomorrow = _addDays(1);

        const _fmtDay = (d) => {
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
        };

        const options = [
            { label: 'today', aliases: ['today'], description: _fmtDay(today), contexts: [getDateKey(today)] },
            { label: 'tomorrow', aliases: ['tomorrow', 'tmr'], description: _fmtDay(tomorrow), contexts: [getDateKey(tomorrow)] },
            { label: 'ongoing', aliases: ['ongoing', 'someday'], description: 'Backlog', contexts: ['ongoing'] },
            { label: 'future', aliases: ['future', 'someday2'], description: 'Aspirations', contexts: ['future'] },
            { label: 'this week', aliases: ['week', 'thisweek'], description: 'Current week', contexts: [getWeekKey(today)] },
            { label: 'next week', aliases: ['nextweek'], description: 'Next week', contexts: [getWeekKey(_addDays(7))] },
        ];

        // Day names
        for (let dow = 0; dow < 7; dow++) {
            const d = _getNextDayDate(dow);
            options.push({
                label: _DAY_NAMES[dow],
                aliases: [_DAY_NAMES[dow], _DAY_ABBREV[dow]],
                description: _fmtDay(d),
                contexts: [getDateKey(d)]
            });
        }

        // +N days (up to +7)
        for (let n = 2; n <= 7; n++) {
            const d = _addDays(n);
            options.push({
                label: `+${n} days`,
                aliases: [`+${n}`],
                description: _fmtDay(d),
                contexts: [getDateKey(d)]
            });
        }

        return options;
    };

    const _getTimeItems = (query) => {
        const options = _buildTimeOptions();
        if (!query) return options.slice(0, 8).map(o => ({ name: o.label, description: o.description, _timeContexts: o.contexts }));
        const q = query.toLowerCase();
        // Match against all aliases
        const filtered = options.filter(o => o.aliases.some(a => a.includes(q)) || o.label.includes(q));
        return filtered.slice(0, 8).map(o => ({ name: o.label, description: o.description, _timeContexts: o.contexts }));
    };

    // ── Generic dropdown rendering ──
    const _renderDropdown = (items, triggerChar, triggerInfo) => {
        _closeDropdown();
        if (items.length === 0) return;

        _dropdownItems = items;
        _highlightIdx = 0;
        _activeTrigger = triggerChar;
        _activeTriggerInfo = triggerInfo;

        const row = document.getElementById('action-input-row');
        _dropdown = document.createElement('div');
        _dropdown.className = 'action-input-dropdown';

        items.forEach((item, idx) => {
            const opt = document.createElement('div');
            opt.className = 'action-input-dropdown-item' + (idx === 0 ? ' highlighted' : '');
            opt.dataset.idx = idx;

            const icon = document.createElement('span');
            icon.className = 'action-input-dropdown-icon';
            icon.textContent = triggerChar === '#' ? '📅' : '';
            if (triggerChar === '#') opt.appendChild(icon);

            const nameEl = document.createElement('span');
            nameEl.className = 'action-input-dropdown-name';
            nameEl.textContent = item.name;
            opt.appendChild(nameEl);

            if (item.description) {
                const descEl = document.createElement('span');
                descEl.className = 'action-input-dropdown-path';
                descEl.textContent = item.description;
                opt.appendChild(descEl);
            }

            opt.addEventListener('mousedown', (e) => {
                e.preventDefault();
                _selectItem(idx);
            });
            opt.addEventListener('mouseenter', () => {
                _highlightIdx = idx;
                _updateHighlight();
            });

            _dropdown.appendChild(opt);
        });

        row.appendChild(_dropdown);
    };

    const _updateHighlight = () => {
        if (!_dropdown) return;
        const items = _dropdown.querySelectorAll('.action-input-dropdown-item');
        items.forEach((el, i) => {
            el.classList.toggle('highlighted', i === _highlightIdx);
            if (i === _highlightIdx) el.scrollIntoView({ block: 'nearest' });
        });
    };

    const _selectItem = (idx) => {
        const item = _dropdownItems[idx];
        if (!item || !_activeTrigger || !_activeTriggerInfo) return;

        const triggerChar = _activeTrigger;
        const triggerInfo = _activeTriggerInfo;

        // Replace trigger+query with trigger+selectedName in the input
        const val = input.value;
        const before = val.slice(0, triggerInfo.atIdx);
        const after = val.slice(triggerInfo.atIdx + 1 + triggerInfo.query.length);
        input.value = before + triggerChar + item.name + after;

        if (triggerChar === '@') {
            _atOverrideId = item.id;
            _atOverrideName = item.name;
        } else if (triggerChar === '#') {
            _hashOverrideContexts = item._timeContexts;
            _hashOverrideName = item.name;
        }

        _closeDropdown();
        updateBtnVisibility();
        _renderChips();
        input.focus();
    };

    // ── Chips (both @ and # combined) ──
    const _renderChips = () => {
        const row = document.getElementById('action-input-row');
        row.querySelector('.action-input-at-chip')?.remove();
        row.querySelector('.action-input-hash-chip')?.remove();

        if (_atOverrideId) {
            const chip = document.createElement('span');
            chip.className = 'action-input-at-chip';
            chip.innerHTML = `<span class="at-chip-label">→ ${_atOverrideName}</span><button class="at-chip-remove" title="Remove">×</button>`;
            chip.querySelector('.at-chip-remove').addEventListener('mousedown', (e) => {
                e.preventDefault();
                const atMatch = input.value.match(/@\S+/);
                if (atMatch) {
                    input.value = input.value.replace(atMatch[0], '').replace(/\s{2,}/g, ' ').trim();
                }
                _atOverrideId = null;
                _atOverrideName = null;
                chip.remove();
                updateBtnVisibility();
                input.focus();
            });
            row.appendChild(chip);
        }

        if (_hashOverrideContexts) {
            const chip = document.createElement('span');
            chip.className = 'action-input-hash-chip';
            chip.innerHTML = `<span class="at-chip-label">📅 ${_hashOverrideName}</span><button class="at-chip-remove" title="Remove">×</button>`;
            chip.querySelector('.at-chip-remove').addEventListener('mousedown', (e) => {
                e.preventDefault();
                const hashMatch = input.value.match(/#\S+/);
                if (hashMatch) {
                    input.value = input.value.replace(hashMatch[0], '').replace(/\s{2,}/g, ' ').trim();
                }
                _hashOverrideContexts = null;
                _hashOverrideName = null;
                chip.remove();
                updateBtnVisibility();
                input.focus();
            });
            row.appendChild(chip);
        }
    };

    // ── Input handler ──
    const _onInput = () => {
        updateBtnVisibility();

        // Validate existing overrides still match input text
        if (_atOverrideId && _atOverrideName) {
            if (!input.value.includes('@' + _atOverrideName)) {
                _atOverrideId = null;
                _atOverrideName = null;
                document.getElementById('action-input-row')?.querySelector('.action-input-at-chip')?.remove();
            }
        }
        if (_hashOverrideContexts && _hashOverrideName) {
            if (!input.value.includes('#' + _hashOverrideName)) {
                _hashOverrideContexts = null;
                _hashOverrideName = null;
                document.getElementById('action-input-row')?.querySelector('.action-input-hash-chip')?.remove();
            }
        }

        // Try # trigger first (if no override selected yet)
        if (!_hashOverrideContexts) {
            const hashInfo = _getTriggerQuery('#');
            if (hashInfo) {
                const items = _getTimeItems(hashInfo.query);
                _renderDropdown(items, '#', hashInfo);
                return;
            }
        }

        // Try @ trigger (if no override selected yet)
        if (!_atOverrideId) {
            const atInfo = _getTriggerQuery('@');
            if (atInfo) {
                const items = _getProjectItems(atInfo.query);
                _renderDropdown(items, '@', atInfo);
                return;
            }
        }

        _closeDropdown();
    };

    // ── Submit ──
    const submitAction = async () => {
        let name = input.value.trim();
        if (!name) return;

        // Strip @mention and #time from name
        if (_atOverrideId && _atOverrideName) {
            name = name.replace('@' + _atOverrideName, '').replace(/\s{2,}/g, ' ').trim();
        }
        if (_hashOverrideContexts && _hashOverrideName) {
            name = name.replace('#' + _hashOverrideName, '').replace(/\s{2,}/g, ' ').trim();
        }
        if (!name) return;

        // Determine parentId: @override > selected project > inbox
        const inbox = state.items.items.find(i => i.isInbox);
        const parentId = _atOverrideId || state.selectedItemId || (inbox ? inbox.id : null);

        // Determine timeContexts: #override > current view defaults
        const timeContexts = _hashOverrideContexts || getCurrentTimeContexts();

        await api.post('/items', {
            name,
            parentId,
            timeContexts
        });
        await reloadItems();
        input.value = '';
        _atOverrideId = null;
        _atOverrideName = null;
        _hashOverrideContexts = null;
        _hashOverrideName = null;
        _closeDropdown();
        const row = document.getElementById('action-input-row');
        row?.querySelector('.action-input-at-chip')?.remove();
        row?.querySelector('.action-input-hash-chip')?.remove();
        updateBtnVisibility();
    };

    input.addEventListener('input', _onInput);

    input.addEventListener('keydown', async (e) => {
        // Dropdown navigation
        if (_dropdown && _dropdownItems.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _highlightIdx = (_highlightIdx + 1) % _dropdownItems.length;
                _updateHighlight();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                _highlightIdx = (_highlightIdx - 1 + _dropdownItems.length) % _dropdownItems.length;
                _updateHighlight();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                _selectItem(_highlightIdx);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                _closeDropdown();
                return;
            }
        }

        if (e.key === 'Enter') await submitAction();
    });

    input.addEventListener('blur', () => {
        setTimeout(_closeDropdown, 150);
    });

    if (btn) {
        btn.addEventListener('click', submitAction);
    }
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

// Check if the current moment is in the "tonight" range (outside day boundaries).
// Returns true when now is after today's day-end or before today's day-start.
function isInSleepRange() {
    const logicalToday = getLogicalToday();
    const { dayStart, dayEnd } = getDayBoundaries(logicalToday);
    const now = new Date();
    return now < dayStart || now >= dayEnd;
}

// ─── Horizon Layer Stack ───
// Syncs active/dim state on the inline ongoing + day header layers

function _updateWeekNavLabel() {
    const weekNavLabel = document.getElementById('week-nav-label');
    if (!weekNavLabel) return;
    const wk = getWeekKey(state.timelineViewDate);
    const rng = getWeekDateRange(wk);
    if (rng) {
        const ms = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const sm = ms[rng.start.getMonth()];
        const em = ms[rng.end.getMonth()];
        const s = `${sm} ${rng.start.getDate()}`;
        const e = sm === em ? `${rng.end.getDate()}` : `${em} ${rng.end.getDate()}`;
        weekNavLabel.textContent = `${s}\u2013${e}`;
    }
    // Also update This Week button visibility immediately
    const weekTodayBtn = document.getElementById('week-nav-today-btn');
    if (weekTodayBtn) {
        const currentWeek = getWeekKey(getLogicalToday());
        weekTodayBtn.style.display = wk === currentWeek ? 'none' : '';
    }
}

function renderHorizonTower() {
    const epochLayer = document.getElementById('horizon-epoch-layer');
    const weekLayer = document.getElementById('horizon-week-layer');
    const dayLayer = document.getElementById('horizon-day-layer');
    const sessionLayer = document.getElementById('horizon-session-layer');
    if (!epochLayer || !weekLayer || !dayLayer) return;

    const currentLevel = state.viewHorizon;

    // Auto-sync epochFilter when timelineViewDate crosses epoch boundaries
    _syncEpochForCurrentWeek();

    // Epoch layer: active when viewHorizon is epoch, dim otherwise
    epochLayer.classList.toggle('horizon-layer-active', currentLevel === 'epoch');
    epochLayer.classList.toggle('horizon-layer-dim', currentLevel !== 'epoch');
    // Update icon and label to reflect current epochFilter
    const epochIcons = { past: '📜', ongoing: '📦', future: '🔮' };
    const epochLabels = { past: 'Past', ongoing: 'Ongoing', future: 'Future' };
    const epochIcon = document.getElementById('epoch-nav-icon');
    const epochLabel = document.getElementById('epoch-nav-label');
    if (epochIcon) epochIcon.textContent = epochIcons[state.epochFilter] || '📦';
    if (epochLabel) epochLabel.textContent = epochLabels[state.epochFilter] || 'Ongoing';
    // Show/hide navigation arrows based on active state + disable at boundaries
    const epochActive = currentLevel === 'epoch';
    const epochIdx = EPOCH_CONTEXTS.indexOf(state.epochFilter);
    const prevBtn = document.getElementById('epoch-nav-prev');
    const nextBtn = document.getElementById('epoch-nav-next');
    if (prevBtn) {
        prevBtn.style.display = epochActive ? '' : 'none';
        prevBtn.disabled = epochIdx <= 0;
        prevBtn.style.opacity = epochIdx <= 0 ? '0.25' : '';
    }
    if (nextBtn) {
        nextBtn.style.display = epochActive ? '' : 'none';
        nextBtn.disabled = epochIdx >= EPOCH_CONTEXTS.length - 1;
        nextBtn.style.opacity = epochIdx >= EPOCH_CONTEXTS.length - 1 ? '0.25' : '';
    }

    // Week layer: active when viewHorizon is week, dim otherwise
    weekLayer.classList.toggle('horizon-layer-active', currentLevel === 'week');
    weekLayer.classList.toggle('horizon-layer-dim', currentLevel !== 'week');
    // Show/hide week nav buttons and extra elements based on active state
    const weekActive = currentLevel === 'week';
    weekLayer.querySelectorAll('.week-nav-btn').forEach(btn => {
        btn.style.display = weekActive ? '' : 'none';
    });
    const weekNavDisplay = weekLayer.querySelector('.week-nav-display');
    if (weekNavDisplay) {
        // Show This Week button & picker only when active
        const weekTodayBtn = document.getElementById('week-nav-today-btn');
        const weekPicker = document.getElementById('week-nav-picker');
        if (!weekActive) {
            if (weekTodayBtn) weekTodayBtn.style.display = 'none';
            if (weekPicker) weekPicker.style.display = 'none';
        }
    }
    // Set week label — always show specific date range (even when dimmed)
    _updateWeekNavLabel();

    // Day layer: always visible, active when viewHorizon is day, dim otherwise
    dayLayer.classList.toggle('horizon-layer-active', currentLevel === 'day');
    dayLayer.classList.toggle('horizon-layer-dim', currentLevel !== 'day');

    // Session layer: always visible
    if (sessionLayer) {
        sessionLayer.style.display = '';
        sessionLayer.classList.toggle('horizon-layer-active', currentLevel === 'session');
        sessionLayer.classList.toggle('horizon-layer-dim', currentLevel !== 'session');

        // Always show the specific session icon/label (last-viewed segment)
        const segments = buildPlanSegments();
        const idx = Math.max(0, Math.min(segments.length - 1, state.sessionIndex));
        const seg = segments[idx];
        const sessionIcon = document.getElementById('session-layer-icon');
        const sessionLabel = document.getElementById('session-nav-label');
        if (seg) {
            if (sessionIcon) sessionIcon.textContent = seg.icon;
            if (sessionLabel) sessionLabel.textContent = seg.label;
        }

        if (currentLevel === 'session') {
            // Show nav buttons
            const prevBtn = document.getElementById('session-nav-prev');
            const nextBtn = document.getElementById('session-nav-next');
            if (prevBtn) prevBtn.style.display = '';
            if (nextBtn) nextBtn.style.display = '';
        } else {
            // Dim mode: hide nav buttons
            const prevBtn = document.getElementById('session-nav-prev');
            const nextBtn = document.getElementById('session-nav-next');
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
        }
    }
}

// ─── Session Focus ───

// Toggle focus on a session (enter/exit session horizon)
function toggleSessionFocus(session) {
    if (state.viewHorizon === 'session') {
        // Check if clicking the same session → pop back to day
        const top = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
        if (top && top.startMs === session.startMs && top.endMs === session.endMs) {
            state.viewHorizon = 'day';
            savePref('viewHorizon', 'day');
            clearFocusStack();
            renderAll();
            return;
        }
    }
    // Enter session horizon — find matching plan segment
    const segments = buildPlanSegments();
    let matchIdx = -1;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        // Match by time range overlap
        if (session.startMs >= seg.startMs && session.startMs < seg.endMs) {
            matchIdx = i;
            break;
        }
    }
    if (matchIdx === -1) matchIdx = getCurrentSessionIndex(segments);
    state.sessionIndex = matchIdx;
    state.viewHorizon = 'session';
    savePref('viewHorizon', 'session');
    savePref('sessionIndex', state.sessionIndex);
    _syncSessionToFocusStack(segments[state.sessionIndex]);
    renderAll();
}

// Render the time-context bar: date nav (unfocused) or session info (focused)
function renderTimeContext() {
    const container = document.getElementById('time-context');
    if (!container) return;

    const top = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;

    if (!top) {
        // Unfocused: show normal date nav
        container.classList.remove('time-context-focused');
        container.className = container.className.replace(/\btime-context-type-\S+/g, '').trim();
        const dateNav = container.querySelector('.date-nav');
        if (dateNav) dateNav.style.display = '';
        container.querySelectorAll('.time-context-session').forEach(el => el.remove());

        // Sync date nav for current horizon
        const prevBtn = document.getElementById('date-nav-prev');
        const nextBtn = document.getElementById('date-nav-next');
        const todayBtn = document.getElementById('date-nav-today-btn');

        if (state.viewHorizon === 'epoch') {
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
            if (todayBtn) todayBtn.style.display = 'none';
        } else if (state.viewHorizon === 'week') {
            if (prevBtn) prevBtn.style.display = '';
            if (nextBtn) nextBtn.style.display = '';
            // "This Week" button visibility handled by updateDateNav()
        } else {
            if (prevBtn) prevBtn.style.display = '';
            if (nextBtn) nextBtn.style.display = '';
            // Today button visibility is handled by updateDateNav()
        }
    } else {

        // Focused: transform the bar — keep horizon layers visible (dimmed by renderHorizonTower)
        container.classList.add('time-context-focused');
        // Set type class for skin-specific styling
        container.className = container.className.replace(/\btime-context-type-\S+/g, '').trim();
        container.classList.add(`time-context-type-${top.type}`);

        // Keep date-nav visible — renderHorizonTower already dims it
        const dateNav = container.querySelector('.date-nav');
        if (dateNav) dateNav.style.display = '';
        container.querySelectorAll('.time-context-session').forEach(el => el.remove());

        const sessionEl = document.createElement('div');
        sessionEl.className = `time-context-session time-context-session-${top.type} horizon-layer horizon-layer-active`;

        // ── Duration helpers ──
        const nowMs = Date.now();
        const durationMs = top.endMs - top.startMs;
        const _fmtDur = (ms) => {
            const h = Math.floor(ms / 3600000);
            const m = Math.floor((ms % 3600000) / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            if (h > 0) return `${h}h ${m}m ${s}s`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        };

        // ── Render per-type content ──
        if (top.type === 'working' || top.type === 'work') {
            _renderWorkSession(sessionEl, top, nowMs, durationMs, _fmtDur);
        } else if (top.type === 'planned') {
            _renderPlannedSession(sessionEl, top, nowMs, durationMs, _fmtDur);
        } else if (top.type === 'free') {
            _renderFreeSession(sessionEl, top, nowMs, durationMs, _fmtDur);
        } else if (top.type === 'break') {
            _renderBreakSession(sessionEl, top, nowMs, durationMs, _fmtDur);
        }

        // ── Action count (shared) ──
        const visibleActions = state._visibleActionIds || [];
        const countRow = document.createElement('div');
        countRow.className = 'time-context-row time-context-action-count';
        countRow.textContent = `📋 ${visibleActions.length} related action${visibleActions.length !== 1 ? 's' : ''}`;
        sessionEl.appendChild(countRow);

        container.appendChild(sessionEl);
    }

}

// ── Live Indicator DnD Helper ──
// Attaches dragover/dragleave/drop listeners to a live-indicator element.
// liveType: 'work' | 'break' | 'idle'
function _attachLiveIndicatorDnD(indicator, liveType) {
    indicator.addEventListener('dragover', (e) => {
        if (!window._draggedAction && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        indicator.classList.add('live-session-indicator-drag-over');
    });
    indicator.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        indicator.classList.remove('live-session-indicator-drag-over');
    });
    indicator.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        indicator.classList.remove('live-session-indicator-drag-over');

        // Clean up parent actions-section drag highlight (stopPropagation prevents its own drop handler)
        const actionsSection = document.getElementById('section-actions');
        if (actionsSection) actionsSection.classList.remove('actions-drag-over');

        const todayKey = getDateKey(getLogicalToday());

        // Resolve item ID from either drag source
        let itemId;
        let segCtx;
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            itemId = e.dataTransfer.getData('application/x-segment-item-id');
            segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            // Strip old segment context before re-assigning
            if (segCtx) {
                const item = findItemById(Number(itemId));
                if (item) {
                    if (item.timeContexts) item.timeContexts = item.timeContexts.filter(tc => tc !== segCtx);
                    if (item.contextDurations) delete item.contextDurations[segCtx];
                }
            }
        } else {
            itemId = e.dataTransfer.getData('application/x-action-id');
        }
        if (!itemId) return;
        itemId = parseInt(itemId, 10);

        if (liveType === 'idle') {
            await rescheduleToDate(itemId, todayKey);
        } else {
            // work or break — add to the session's segment context
            await addSegmentContext(itemId, `${todayKey}@${liveType}`);

            // Move item under the active project when dropping onto work indicator
            if (liveType === 'work' && state.workingOn && state.workingOn.itemId) {
                const ancestors = getAncestorPath(state.workingOn.itemId);
                const projectId = (ancestors && ancestors.length > 0) ? ancestors[0].id : state.workingOn.itemId;
                // Only move if the item isn't already under this project
                const itemAncestors = getAncestorPath(itemId);
                const itemProjectId = (itemAncestors && itemAncestors.length > 0) ? itemAncestors[0].id : null;
                if (itemProjectId !== projectId) {
                    moveItem(itemId, { id: projectId, position: 'inside' });
                    await api.put('/items', state.items);
                }
            }
        }
    });
}

// ── Live Session Indicator ("Ground") ──
// Shows a compact clickable bar at the top of the Actions area when a
// work/break session is running. Clicking it navigates to the session
// AND focuses the related project.
function _renderLiveSessionIndicator() {
    const liveSlot = document.getElementById('header-live-slot');
    if (!liveSlot) return;

    // Clear the live slot
    liveSlot.innerHTML = '';

    const liveSession = state.workingOn || state.onBreak;

    // ── Idle indicator: show when no work/break is active and currently within today's day ──
    if (!liveSession) {
        const logicalToday = getLogicalToday();
        const { dayStart, dayEnd } = getDayBoundaries(logicalToday);
        const nowMs = Date.now();
        if (nowMs < dayStart.getTime() || nowMs >= dayEnd.getTime()) {
            // Tonight range — show sleep indicator instead of idle
            _renderSleepIndicator(liveSlot, dayEnd);
            return;
        }

        // Find idle start: last block end before now, or day start
        let idleStartMs = dayStart.getTime();
        const entries = (state.timeline && state.timeline.entries) || [];
        for (const entry of entries) {
            if (entry.endTime && entry.timestamp <= nowMs && (entry.type === 'work' || entry.type === 'break')) {
                if (entry.endTime > idleStartMs && entry.endTime <= nowMs) {
                    idleStartMs = entry.endTime;
                }
            }
        }

        const top = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
        // Hide when already focused on an idle/free block
        if (top && (top.type === 'free')) return;

        const elapsed = Math.max(0, nowMs - idleStartMs);
        const _fmtDur = (ms) => {
            const h = Math.floor(ms / 3600000);
            const m = Math.floor((ms % 3600000) / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            if (h > 0) return `${h}h ${m}m ${s}s`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        };

        const indicator = document.createElement('div');
        indicator.className = 'live-session-indicator live-session-indicator-idle';
        indicator.style.cursor = 'pointer';
        indicator.title = 'Click to view current idle time';

        const icon = document.createElement('span');
        icon.className = 'live-session-indicator-icon';
        icon.textContent = '💤';

        const label = document.createElement('span');
        label.className = 'live-session-indicator-label';
        label.textContent = 'Idle';

        const timer = document.createElement('span');
        timer.className = 'live-session-indicator-timer';
        timer.dataset.sessionStart = idleStartMs;
        timer.textContent = _fmtDur(elapsed);

        indicator.appendChild(icon);
        indicator.appendChild(label);
        indicator.appendChild(timer);

        // Click: navigate to today + focus the free/idle block in the timeline
        indicator.addEventListener('click', () => {
            state.timelineViewDate = getLogicalToday();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            state.viewHorizon = 'day';
            savePref('viewHorizon', 'day');
            state.focusStack = [{
                startMs: idleStartMs,
                endMs: nowMs,
                label: 'Free Time',
                type: 'free',
                icon: '✨',
                tier: 'session',
            }];
            saveFocusStack();
            renderAll();
        });

        // DnD: drop onto idle → schedule to today
        _attachLiveIndicatorDnD(indicator, 'idle');

        // Divergence badge: show ⚡ if unresolved divergences exist
        _appendDivergenceBadge(indicator);

        liveSlot.appendChild(indicator);
        return;
    }

    const isWork = !!state.workingOn;
    const top = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;

    // Hide when already grounded: session is focused AND related project is selected
    const sessionFocused = top && (top.type === 'working' || (top.type === 'break' && state.onBreak));
    const projectFocused = (() => {
        if (!isWork || !state.workingOn.itemId) return !state.selectedItemId;
        const ancestors = getAncestorPath(state.workingOn.itemId);
        const projectId = (ancestors && ancestors.length > 0) ? ancestors[0].id : state.workingOn.itemId;
        return state.selectedItemId === projectId;
    })();
    if (sessionFocused && projectFocused) return;

    const nowMs = Date.now();
    const startMs = liveSession.startTime;
    const elapsed = Math.max(0, nowMs - startMs);

    const _fmtDur = (ms) => {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    };

    const indicator = document.createElement('div');
    indicator.className = `live-session-indicator live-session-indicator-${isWork ? 'work' : 'break'}`;
    indicator.style.cursor = 'pointer';
    indicator.title = 'Click to return to running session';

    // Icon
    const icon = document.createElement('span');
    icon.className = 'live-session-indicator-icon';
    icon.textContent = isWork ? '🔥' : '☕';

    // Label
    const label = document.createElement('span');
    label.className = 'live-session-indicator-label';
    label.textContent = isWork ? (state.workingOn.itemName || 'Working') : 'Break';

    // Timer
    const timer = document.createElement('span');
    timer.className = 'live-session-indicator-timer';
    timer.dataset.sessionStart = startMs;
    if (liveSession.targetEndTime) {
        timer.dataset.targetEnd = liveSession.targetEndTime;
        const rem = liveSession.targetEndTime - nowMs;
        if (rem > 0) {
            timer.textContent = _fmtDur(rem) + ' left';
        } else {
            timer.textContent = '+' + _fmtDur(Math.abs(rem)) + ' over';
            timer.classList.add('live-session-indicator-overtime');
        }
    } else {
        timer.textContent = _fmtDur(elapsed);
    }

    indicator.appendChild(icon);
    indicator.appendChild(label);
    indicator.appendChild(timer);
    if (liveSession.targetEndTime) indicator.appendChild(_createAdjustBtns());

    // Stop button — visible on hover
    const stopBtn = document.createElement('button');
    stopBtn.className = 'live-session-stop-btn';
    stopBtn.textContent = '⏹';
    stopBtn.title = isWork ? 'Stop working' : 'Stop break';
    stopBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        clearFocusStack();
        if (isWork) await stopWorking();
        else await stopBreak();
    });
    indicator.appendChild(stopBtn);

    // Click: navigate back to today + focus the running session + select project
    indicator.addEventListener('click', () => {
        // 1. Navigate to today
        state.timelineViewDate = getLogicalToday();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        // 2. Switch to day horizon
        state.viewHorizon = 'day';
        savePref('viewHorizon', 'day');
        // 3. Focus the running session
        const endMs = isWork
            ? Math.max(nowMs, state.workingOn.targetEndTime || nowMs)
            : Math.max(nowMs, state.onBreak.targetEndTime || nowMs);
        const sessionLabel = isWork ? (state.workingOn.itemName || 'Working') : 'Break';
        state.focusStack = [{
            startMs: liveSession.startTime,
            endMs,
            label: sessionLabel,
            type: isWork ? 'working' : 'break',
            icon: isWork ? '🔥' : '☕',
            projectName: isWork ? state.workingOn.projectName : null,
            itemId: isWork ? state.workingOn.itemId : null,
            targetEndTime: liveSession.targetEndTime || null,
            liveType: isWork ? 'work' : 'break',
            tier: 'session',
        }];
        saveFocusStack();
        // 4. Focus the related project in the sidebar
        if (isWork && state.workingOn.itemId) {
            const ancestors = getAncestorPath(state.workingOn.itemId);
            // Top-level item has no ancestors — use itemId itself
            const projectId = (ancestors && ancestors.length > 0) ? ancestors[0].id : state.workingOn.itemId;
            state.selectedItemId = projectId;
            savePref('selectedItemId', projectId);
        }
        renderAll();
        // 5. Scroll to & highlight the project in the sidebar tree
        scrollToSelectedItem();
    });

    // DnD: drop onto work/break indicator → add to session context
    _attachLiveIndicatorDnD(indicator, isWork ? 'work' : 'break');

    // Divergence badge: show ⚡ if unresolved divergences exist
    _appendDivergenceBadge(indicator);

    // Insert into the header live slot
    liveSlot.appendChild(indicator);
}

// ── Divergence Badge Helper ──
// Appends a small ⚡ badge to a live indicator when unresolved post-hoc divergences exist
function _appendDivergenceBadge(indicator) {
    const entries = (state.timeline && state.timeline.entries) || [];
    const nowMs = Date.now();
    const logicalToday = getLogicalToday();
    const { dayStart, dayEnd } = getDayBoundaries(logicalToday);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();

    // Quick check: any planned entries today that ended before now and aren't absorbed?
    // Use detectDivergences for accurate check (respects manual log flags)
    const allDayEntries = entries.filter(e =>
        e.timestamp >= dayStartMs && e.timestamp < dayEndMs
    );
    let unresolvedCount = detectDivergences(allDayEntries, nowMs).length;
    unresolvedCount += detectOutOfHoursWork(logicalToday, nowMs).length;

    if (unresolvedCount === 0) return;

    const badge = document.createElement('span');
    badge.className = 'live-divergence-badge';
    badge.textContent = '⚡';
    badge.title = `${unresolvedCount} unresolved plan${unresolvedCount > 1 ? 's' : ''}`;
    indicator.appendChild(badge);
}

// ── Sleep Indicator ──
// Renders a calming sleep indicator during the "tonight" range (outside day boundaries).
// Shows time since day-end and a "Close Day" button for streak integration.
function _renderSleepIndicator(liveSlot, dayEnd) {
    const nowMs = Date.now();

    // Find the nearest upcoming day-start
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let { dayStart: nextDayStart } = getDayBoundaries(today);
    if (nextDayStart.getTime() <= nowMs) {
        // Today's start already passed — use tomorrow's
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        ({ dayStart: nextDayStart } = getDayBoundaries(tomorrow));
    }
    const targetMs = nextDayStart.getTime();

    const remaining = Math.max(0, targetMs - nowMs);
    const _fmtDur = (ms) => {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    };

    const indicator = document.createElement('div');
    indicator.className = 'live-session-indicator live-session-indicator-sleep';
    indicator.title = 'Sleep mode — time to rest';

    const icon = document.createElement('span');
    icon.className = 'live-session-indicator-icon';
    icon.textContent = '🌙';

    const label = document.createElement('span');
    label.className = 'live-session-indicator-label';
    label.textContent = 'Good Night';

    const timer = document.createElement('span');
    timer.className = 'live-session-indicator-timer';
    timer.dataset.sessionStart = String(nowMs);
    timer.dataset.targetEnd = String(targetMs);
    timer.textContent = _fmtDur(remaining) + ' left';

    indicator.appendChild(icon);
    indicator.appendChild(label);
    indicator.appendChild(timer);

    // "Close Day" button — only if not already closed today
    const streak = getStreakData();
    if (!hasCheckedInToday(streak)) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'sleep-close-day-btn';
        closeBtn.textContent = '🌙 Close Day';
        closeBtn.title = 'Close your day and keep the streak going';
        closeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await performCheckIn();
        });
        indicator.appendChild(closeBtn);
    }

    // DnD: drop onto sleep → schedule to today
    _attachLiveIndicatorDnD(indicator, 'idle');

    liveSlot.appendChild(indicator);
}

// ── Timer Adjustment Helper ──
// Adjusts the targetEndTime for the running work/break session by deltaMs.
// Also syncs the focusStack entry so the meta row updates.
function _adjustSessionTarget(deltaMs) {
    const session = state.workingOn || state.onBreak;
    if (!session || !session.targetEndTime) return;
    // Don't allow target to go before session start
    const newTarget = Math.max(session.startTime + 60000, session.targetEndTime + deltaMs);
    session.targetEndTime = newTarget;
    // Persist
    if (state.workingOn) savePref('workingOn', state.workingOn);
    else savePref('onBreak', state.onBreak);
    // Sync focusStack if focused on this live session
    const top = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    if (top && (top.type === 'working' || top.type === 'break')) {
        top.targetEndTime = newTarget;
    }
    renderAll();
}

function _createAdjustBtns() {
    const wrap = document.createElement('span');
    wrap.className = 'session-timer-adjust';
    const minus = document.createElement('button');
    minus.className = 'session-timer-adjust-btn';
    minus.textContent = '−';
    minus.title = '−1 min';
    minus.addEventListener('click', (e) => { e.stopPropagation(); _adjustSessionTarget(-60000); });
    const plus = document.createElement('button');
    plus.className = 'session-timer-adjust-btn';
    plus.textContent = '+';
    plus.title = '+1 min';
    plus.addEventListener('click', (e) => { e.stopPropagation(); _adjustSessionTarget(60000); });
    wrap.appendChild(minus);
    wrap.appendChild(plus);
    return wrap;
}

// ── Work Session Header ──
function _renderWorkSession(sessionEl, top, nowMs, durationMs, _fmtDur) {
    const isLive = top.type === 'working';

    // Icon + label
    const headerRow = document.createElement('div');
    headerRow.className = 'time-context-row time-context-session-header';
    const icon = document.createElement('span');
    icon.className = 'time-context-session-icon';
    icon.textContent = isLive ? '🔥' : '🔥';
    const label = document.createElement('span');
    label.className = 'time-context-session-label';
    label.textContent = top.label;
    headerRow.appendChild(icon);
    headerRow.appendChild(label);
    sessionEl.appendChild(headerRow);

    // Project breadcrumb
    if (top.projectName) {
        const breadcrumb = document.createElement('div');
        breadcrumb.className = 'time-context-row session-breadcrumb';
        breadcrumb.textContent = top.projectName;
        sessionEl.appendChild(breadcrumb);
    }

    // Time range
    const metaRow = document.createElement('div');
    metaRow.className = 'time-context-row time-context-meta';
    const targetEnd = top.targetEndTime || (isLive && state.workingOn ? state.workingOn.targetEndTime : null);
    if (isLive && targetEnd) {
        metaRow.textContent = `${formatTime(top.startMs)} → ${formatTime(targetEnd)}`;
    } else {
        metaRow.textContent = `${formatTime(top.startMs)} – ${formatTime(top.endMs)}`;
    }
    sessionEl.appendChild(metaRow);

    // Live timer display
    if (isLive) {
        const timerRow = document.createElement('div');
        timerRow.className = 'time-context-row session-timer-row';

        const elapsed = Math.max(0, nowMs - top.startMs);
        const timerEl = document.createElement('span');
        timerEl.className = 'session-timer';
        timerEl.dataset.sessionStart = top.startMs;

        if (targetEnd) {
            const remainMs = targetEnd - nowMs;
            timerEl.dataset.targetEnd = targetEnd;
            if (remainMs > 0) {
                timerEl.textContent = _fmtDur(remainMs) + ' left';
                timerEl.classList.add('session-timer-remaining');
            } else {
                timerEl.textContent = '+' + _fmtDur(Math.abs(remainMs)) + ' over';
                timerEl.classList.add('session-timer-overtime');
            }
        } else {
            timerEl.textContent = _fmtDur(elapsed);
            timerEl.classList.add('session-timer-elapsed');
        }
        timerRow.appendChild(timerEl);
        if (targetEnd) timerRow.appendChild(_createAdjustBtns());
        sessionEl.appendChild(timerRow);

        // Progress bar
        if (targetEnd) {
            const total = targetEnd - top.startMs;
            const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
            const progressRow = document.createElement('div');
            progressRow.className = 'time-context-row time-context-progress-row';
            const progressWrap = document.createElement('div');
            progressWrap.className = 'time-context-progress';
            const progressFill = document.createElement('div');
            progressFill.className = 'time-context-progress-fill';
            if (pct >= 100) progressFill.classList.add('over');
            progressFill.style.width = `${Math.min(pct, 100)}%`;
            progressWrap.appendChild(progressFill);
            const progressLabel = document.createElement('span');
            progressLabel.className = 'time-context-progress-label';
            progressLabel.textContent = `${Math.round(pct)}%`;
            progressRow.appendChild(progressWrap);
            progressRow.appendChild(progressLabel);
            sessionEl.appendChild(progressRow);
        }

        // Stop button
        const ctaRow = document.createElement('div');
        ctaRow.className = 'time-context-row session-cta-row';
        const stopBtn = document.createElement('button');
        stopBtn.className = 'session-cta session-cta-stop';
        stopBtn.textContent = '⏹ Stop';
        stopBtn.addEventListener('click', async () => {
            clearFocusStack();
            await stopWorking();
        });
        ctaRow.appendChild(stopBtn);
        sessionEl.appendChild(ctaRow);
    } else {
        // Past work: just show duration
        const durRow = document.createElement('div');
        durRow.className = 'time-context-row session-timer-row';
        const durEl = document.createElement('span');
        durEl.className = 'session-timer session-timer-elapsed';
        durEl.textContent = _fmtDur(durationMs);
        durRow.appendChild(durEl);
        sessionEl.appendChild(durRow);
    }

    // Intention count — items linked via @work/@break or @entry:ID context
    const _workCtxStr = top.liveType
        ? `${getDateKey(state.timelineViewDate)}@${top.liveType}`
        : top.entryId ? `${getDateKey(state.timelineViewDate)}@entry:${top.entryId}` : null;
    if (_workCtxStr) {
        const allItems = collectAllItems(state.items.items);
        const intentionCount = allItems.filter(item =>
            item.timeContexts && item.timeContexts.includes(_workCtxStr)
        ).length;
        if (intentionCount > 0) {
            const intentRow = document.createElement('div');
            intentRow.className = 'time-context-row session-unsched-count';
            intentRow.textContent = `📋 ${intentionCount} intention${intentionCount !== 1 ? 's' : ''} planned`;
            sessionEl.appendChild(intentRow);
        }
    }
}

// ── Planned Session Header ──
function _renderPlannedSession(sessionEl, top, nowMs, durationMs, _fmtDur) {
    // Icon + label
    const headerRow = document.createElement('div');
    headerRow.className = 'time-context-row time-context-session-header';
    const icon = document.createElement('span');
    icon.className = 'time-context-session-icon';
    icon.textContent = '📌';
    const label = document.createElement('span');
    label.className = 'time-context-session-label';
    label.textContent = top.label;
    headerRow.appendChild(icon);
    headerRow.appendChild(label);
    sessionEl.appendChild(headerRow);

    // Project breadcrumb
    if (top.projectName) {
        const breadcrumb = document.createElement('div');
        breadcrumb.className = 'time-context-row session-breadcrumb';
        breadcrumb.textContent = top.projectName;
        sessionEl.appendChild(breadcrumb);
    }

    // Time range + duration
    const metaRow = document.createElement('div');
    metaRow.className = 'time-context-row time-context-meta';
    metaRow.textContent = `${formatTime(top.startMs)} – ${formatTime(top.endMs)}  ·  ${_fmtDur(durationMs)}`;
    sessionEl.appendChild(metaRow);

    // Relative time: "Starts in X" / "Started X ago" / "Ended X ago"
    const relRow = document.createElement('div');
    relRow.className = 'time-context-row session-relative-time';
    if (nowMs < top.startMs) {
        relRow.textContent = `⏳ Starts in ${_fmtDur(top.startMs - nowMs)}`;
    } else if (nowMs >= top.startMs && nowMs < top.endMs) {
        relRow.textContent = `▶ Started ${_fmtDur(nowMs - top.startMs)} ago`;
    } else {
        relRow.textContent = `✓ Ended ${_fmtDur(nowMs - top.endMs)} ago`;
    }
    sessionEl.appendChild(relRow);

    // Intention count — items linked via @work/@break or @entry:ID context
    const _breakCtxStr = top.liveType
        ? `${getDateKey(state.timelineViewDate)}@${top.liveType}`
        : top.entryId ? `${getDateKey(state.timelineViewDate)}@entry:${top.entryId}` : null;
    if (_breakCtxStr) {
        const allItems = collectAllItems(state.items.items);
        const intentionCount = allItems.filter(item =>
            item.timeContexts && item.timeContexts.includes(_breakCtxStr)
        ).length;
        if (intentionCount > 0) {
            const intentRow = document.createElement('div');
            intentRow.className = 'time-context-row session-unsched-count';
            intentRow.textContent = `📋 ${intentionCount} intention${intentionCount !== 1 ? 's' : ''} planned`;
            sessionEl.appendChild(intentRow);
        }
    }

    // CTA row
    const ctaRow = document.createElement('div');
    ctaRow.className = 'time-context-row session-cta-row';

    // Start Working CTA (if plan hasn't passed yet and has an item)
    if (top.itemId && nowMs < top.endMs) {
        const startBtn = document.createElement('button');
        startBtn.className = 'session-cta session-cta-start';
        startBtn.textContent = '▶ Start Working';
        startBtn.addEventListener('click', async () => {
            await startWorking(top.itemId, top.label, top.projectName, top.endMs);
        });
        ctaRow.appendChild(startBtn);
    }

    // Plan an action CTA
    const planBtn = document.createElement('button');
    planBtn.className = 'session-cta session-cta-plan';
    planBtn.textContent = '+ Plan an action';
    planBtn.addEventListener('click', () => {
        // Find the planned block in the timeline to anchor the plan editor
        const plannedBlock = top.entryId
            ? document.querySelector(`.time-block-planned[data-id="${top.entryId}"]`)
            : null;
        openPlanEditor(plannedBlock || document.querySelector('.time-context-view'), top.startMs, top.endMs, null, top.entryId, top.itemId);
    });
    ctaRow.appendChild(planBtn);
    sessionEl.appendChild(ctaRow);
}

// ── Free Time Session Header ──
function _renderFreeSession(sessionEl, top, nowMs, durationMs, _fmtDur) {
    // Icon + label
    const headerRow = document.createElement('div');
    headerRow.className = 'time-context-row time-context-session-header';
    const icon = document.createElement('span');
    icon.className = 'time-context-session-icon';
    icon.textContent = '✨';
    const label = document.createElement('span');
    label.className = 'time-context-session-label';
    label.textContent = 'Free Time';
    headerRow.appendChild(icon);
    headerRow.appendChild(label);
    sessionEl.appendChild(headerRow);

    // Time range
    const metaRow = document.createElement('div');
    metaRow.className = 'time-context-row time-context-meta';
    metaRow.textContent = `${formatTime(top.startMs)} – ${formatTime(top.endMs)}`;
    sessionEl.appendChild(metaRow);

    // Available duration (counts down from now if inside the block)
    const availMs = Math.max(0, top.endMs - Math.max(nowMs, top.startMs));
    const availRow = document.createElement('div');
    availRow.className = 'time-context-row session-avail-duration';
    availRow.dataset.endMs = top.endMs;
    availRow.textContent = `⏱ ${_fmtDur(availMs)} available`;
    sessionEl.appendChild(availRow);

    // Next up: find the next block after this free time
    const { dayEnd } = getDayBoundaries(state.timelineViewDate);
    const allEntries = state.timeline.entries
        .filter(e => e.endTime && (e.type === 'work' || e.type === 'break' || e.type === 'planned'))
        .sort((a, b) => a.timestamp - b.timestamp);
    const nextBlock = allEntries.find(e => e.timestamp >= top.endMs);
    if (nextBlock) {
        const nextRow = document.createElement('div');
        nextRow.className = 'time-context-row session-next-up';
        const nextLabel = nextBlock.text || (nextBlock.type === 'break' ? 'Break' : 'Block');
        nextRow.textContent = `Next: ${nextLabel} at ${formatTime(nextBlock.timestamp)}`;
        sessionEl.appendChild(nextRow);
    } else {
        // Day end is next
        const nextRow = document.createElement('div');
        nextRow.className = 'time-context-row session-next-up';
        nextRow.textContent = `Next: Day End at ${formatTime(dayEnd.getTime())}`;
        sessionEl.appendChild(nextRow);
    }

    // Unscheduled action count — use the same logic as the day timeline
    const currentDateKey = getDateKey(state.timelineViewDate);
    let allLeaves = collectLeaves();
    if (!state.showDone) allLeaves = allLeaves.filter(a => !a.done);
    // Filter to items matching this day's time context (same as getFilteredActions)
    allLeaves = allLeaves.filter(a => itemMatchesTimeContext(a, currentDateKey));
    // Only unscheduled items
    const unscheduledCount = allLeaves.filter(a => isItemUnscheduled(a)).length;

    if (unscheduledCount > 0) {
        const unschedRow = document.createElement('div');
        unschedRow.className = 'time-context-row session-unsched-count';
        unschedRow.textContent = `📋 ${unscheduledCount} unscheduled action${unscheduledCount !== 1 ? 's' : ''} available`;
        sessionEl.appendChild(unschedRow);
    }

    // Plan button
    const ctaRow = document.createElement('div');
    ctaRow.className = 'time-context-row session-cta-row';
    const planBtn = document.createElement('button');
    planBtn.className = 'session-cta session-cta-plan';
    planBtn.textContent = '+ Plan an action';
    planBtn.addEventListener('click', () => {
        // Find the free time block in the timeline to anchor the plan editor
        const freeBlock = document.querySelector(`.time-block-free[data-start-time="${top.startMs}"]`);
        openPlanEditor(freeBlock || null, top.startMs, top.endMs);
    });
    ctaRow.appendChild(planBtn);
    sessionEl.appendChild(ctaRow);
}

// ── Break Session Header ──
function _renderBreakSession(sessionEl, top, nowMs, durationMs, _fmtDur) {
    const isLive = !!state.onBreak;

    // Icon + label
    const headerRow = document.createElement('div');
    headerRow.className = 'time-context-row time-context-session-header';
    const icon = document.createElement('span');
    icon.className = 'time-context-session-icon';
    icon.textContent = '☕';
    const label = document.createElement('span');
    label.className = 'time-context-session-label';
    label.textContent = top.label || 'Break';
    headerRow.appendChild(icon);
    headerRow.appendChild(label);
    sessionEl.appendChild(headerRow);

    // Time range
    const metaRow = document.createElement('div');
    metaRow.className = 'time-context-row time-context-meta';
    const targetEnd = top.targetEndTime || (isLive && state.onBreak ? state.onBreak.targetEndTime : null);
    if (isLive && targetEnd) {
        metaRow.textContent = `${formatTime(top.startMs)} → ${formatTime(targetEnd)}`;
    } else {
        metaRow.textContent = `${formatTime(top.startMs)} – ${formatTime(top.endMs)}`;
    }
    sessionEl.appendChild(metaRow);

    // Live timer
    if (isLive) {
        const timerRow = document.createElement('div');
        timerRow.className = 'time-context-row session-timer-row';

        const elapsed = Math.max(0, nowMs - top.startMs);
        const timerEl = document.createElement('span');
        timerEl.className = 'session-timer session-timer-break';
        timerEl.dataset.sessionStart = top.startMs;

        if (targetEnd) {
            const remainMs = targetEnd - nowMs;
            timerEl.dataset.targetEnd = targetEnd;
            if (remainMs > 0) {
                timerEl.textContent = _fmtDur(remainMs) + ' left';
                timerEl.classList.add('session-timer-remaining');
            } else {
                timerEl.textContent = '+' + _fmtDur(Math.abs(remainMs)) + ' over';
                timerEl.classList.add('session-timer-overtime');
            }
        } else {
            timerEl.textContent = _fmtDur(elapsed);
            timerEl.classList.add('session-timer-elapsed');
        }
        timerRow.appendChild(timerEl);
        if (targetEnd) timerRow.appendChild(_createAdjustBtns());
        sessionEl.appendChild(timerRow);

        // Progress bar (if timed)
        if (targetEnd) {
            const total = targetEnd - top.startMs;
            const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
            const progressRow = document.createElement('div');
            progressRow.className = 'time-context-row time-context-progress-row';
            const progressWrap = document.createElement('div');
            progressWrap.className = 'time-context-progress';
            const progressFill = document.createElement('div');
            progressFill.className = 'time-context-progress-fill session-progress-break';
            if (pct >= 100) progressFill.classList.add('over');
            progressFill.style.width = `${Math.min(pct, 100)}%`;
            progressWrap.appendChild(progressFill);
            const progressLabel = document.createElement('span');
            progressLabel.className = 'time-context-progress-label';
            progressLabel.textContent = `${Math.round(pct)}%`;
            progressRow.appendChild(progressWrap);
            progressRow.appendChild(progressLabel);
            sessionEl.appendChild(progressRow);
        }

        // End Break button
        const ctaRow = document.createElement('div');
        ctaRow.className = 'time-context-row session-cta-row';
        const stopBtn = document.createElement('button');
        stopBtn.className = 'session-cta session-cta-endbreak';
        stopBtn.textContent = '⏹ End Break';
        stopBtn.addEventListener('click', async () => {
            clearFocusStack();
            await stopBreak();
        });
        ctaRow.appendChild(stopBtn);
        sessionEl.appendChild(ctaRow);
    } else {
        // Past break: just show duration
        const durRow = document.createElement('div');
        durRow.className = 'time-context-row session-timer-row';
        const durEl = document.createElement('span');
        durEl.className = 'session-timer session-timer-break session-timer-elapsed';
        durEl.textContent = _fmtDur(durationMs);
        durRow.appendChild(durEl);
        sessionEl.appendChild(durRow);
    }

    // Intention count — items linked via @entry:ID context
    if (top.entryId) {
        const currentDateKey = getDateKey(state.timelineViewDate);
        const entryCtx = `${currentDateKey}@entry:${top.entryId}`;
        const allItems = collectAllItems(state.items.items);
        const intentionCount = allItems.filter(item =>
            item.timeContexts && item.timeContexts.includes(entryCtx)
        ).length;
        if (intentionCount > 0) {
            const intentRow = document.createElement('div');
            intentRow.className = 'time-context-row session-unsched-count';
            intentRow.textContent = `📋 ${intentionCount} intention${intentionCount !== 1 ? 's' : ''} planned`;
            sessionEl.appendChild(intentRow);
        }
    }
}

// ─── Week View Rendering ───
function renderWeekView(container) {
    const weekKey = getWeekKey(state.timelineViewDate);
    const range = getWeekDateRange(weekKey);
    if (!range) return;

    const logicalToday = getLogicalToday();
    const todayKey = getDateKey(logicalToday);
    const allItems = collectAllItems(state.items.items);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Detect night state: current time is before logical-today's day-start
    // (we're in the sleep gap — getLogicalToday fell back to calendar date
    //  because neither yesterday's nor today's day range contains now)
    const { dayStart: logicalDayStart } = getDayBoundaries(logicalToday);
    const isNightTime = new Date() < logicalDayStart;
    // The calendar date before logical today (the day whose row we want to keep visible)
    const prevCalDay = new Date(logicalToday);
    prevCalDay.setDate(prevCalDay.getDate() - 1);
    const prevCalDayKey = getDateKey(prevCalDay);

    const weekEl = document.createElement('div');
    weekEl.className = 'week-view';

    // Build 7 day rows (Mon → Sun)
    let prevDayEndMins = null; // track previous day's end (minutes from midnight)
    for (let d = 0; d < 7; d++) {
        const dayDate = new Date(range.start);
        dayDate.setDate(range.start.getDate() + d);
        const dateKey = getDateKey(dayDate);
        const isToday = dateKey === todayKey && !isNightTime;

        // Get day boundaries
        const dayTimes = getEffectiveDayTimes(dayDate);
        const startStr = `${String(dayTimes.dayStartHour).padStart(2, '0')}:${String(dayTimes.dayStartMinute).padStart(2, '0')}`;
        const endStr = `${String(dayTimes.dayEndHour).padStart(2, '0')}:${String(dayTimes.dayEndMinute).padStart(2, '0')}`;
        const dayStartMins = dayTimes.dayStartHour * 60 + dayTimes.dayStartMinute;
        let dayCapacityMins = ((dayTimes.dayEndHour * 60 + dayTimes.dayEndMinute) - dayStartMins);
        if (dayCapacityMins <= 0) dayCapacityMins += 24 * 60; // cross-midnight

        const isPast = dateKey < todayKey;
        const shouldHidePast = isPast && isPastHidden() && !(isNightTime && dateKey === prevCalDayKey);

        // ── Sleep divider between days ──
        let sleepDivEl = null;
        if (prevDayEndMins !== null) {
            let sleepMins = dayStartMins - prevDayEndMins;
            if (sleepMins < 0) sleepMins += 24 * 60; // cross-midnight gap
            if (sleepMins > 0) {
                sleepDivEl = document.createElement('div');
                sleepDivEl.className = 'week-sleep-divider';
                const sleepH = Math.floor(sleepMins / 60);
                const sleepM = sleepMins % 60;
                const sleepLabel = sleepH > 0 ? (sleepM > 0 ? `${sleepH}h${sleepM}m` : `${sleepH}h`) : `${sleepM}m`;
                // Highlight sleep divider as "you are here" during night time
                if (isNightTime && dateKey === todayKey) {
                    sleepDivEl.classList.add('week-sleep-current');
                    const remainMs = logicalDayStart.getTime() - Date.now();
                    const remainMins = Math.ceil(remainMs / 60000);
                    const rH = Math.floor(remainMins / 60);
                    const rM = remainMins % 60;
                    const remainLabel = rH > 0 ? (rM > 0 ? `${rH}h${rM}m` : `${rH}h`) : `${rM}m`;
                    sleepDivEl.textContent = `🌙 ${remainLabel} left`;
                } else {
                    sleepDivEl.textContent = `🌙 ${sleepLabel}`;
                }
                if (!shouldHidePast) weekEl.appendChild(sleepDivEl);
            }
        }

        // When hiding past: skip rendering but track prevDayEndMins
        if (shouldHidePast) {
            prevDayEndMins = null;
            continue;
        }
        const row = document.createElement('div');
        row.className = 'week-day-row' + (isToday ? ' week-day-today' : '') + (isPast ? ' week-day-past' : '');
        row.dataset.dateKey = dateKey;

        // ── Header ──
        const header = document.createElement('div');
        header.className = 'week-day-header';

        const toggle = document.createElement('span');
        toggle.className = 'week-day-toggle';
        toggle.textContent = '▾';

        const dayLabel = document.createElement('span');
        dayLabel.className = 'week-day-label';
        dayLabel.textContent = `${dayNames[dayDate.getDay()]} ${monthNames[dayDate.getMonth()]} ${dayDate.getDate()}`;
        if (isToday) dayLabel.textContent = `⬤ ${dayLabel.textContent}`;
        dayLabel.title = 'Click to view this day';
        dayLabel.addEventListener('click', (e) => {
            e.stopPropagation();
            state.timelineViewDate = new Date(dayDate);
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            state.viewHorizon = 'day';
            savePref('viewHorizon', 'day');
            clearFocusStack();
            renderAll();
        });

        const timesLabel = document.createElement('span');
        timesLabel.className = 'week-day-times';
        timesLabel.textContent = `${startStr}–${endStr}`;
        timesLabel.title = 'Click to edit day boundaries';

        // Inline time editing on click
        timesLabel.addEventListener('click', (e) => {
            e.stopPropagation();
            if (timesLabel.querySelector('input')) return; // already editing

            timesLabel.textContent = '';
            timesLabel.classList.add('week-day-times-editing');

            const startInput = document.createElement('input');
            startInput.type = 'time';
            startInput.className = 'week-day-time-input';
            startInput.value = startStr;

            const sep = document.createElement('span');
            sep.className = 'week-day-time-sep';
            sep.textContent = '–';

            const endInput = document.createElement('input');
            endInput.type = 'time';
            endInput.className = 'week-day-time-input';
            endInput.value = endStr;

            timesLabel.appendChild(startInput);
            timesLabel.appendChild(sep);
            timesLabel.appendChild(endInput);
            startInput.focus();

            let committed = false;
            const commit = async () => {
                if (committed) return;
                committed = true;
                const [newSH, newSM] = (startInput.value || startStr).split(':').map(Number);
                const [newEH, newEM] = (endInput.value || endStr).split(':').map(Number);
                const key = getDateKey(dayDate);
                if (!state.settings.dayOverrides) state.settings.dayOverrides = {};
                state.settings.dayOverrides[key] = {
                    dayStartHour: newSH, dayStartMinute: newSM,
                    dayEndHour: newEH, dayEndMinute: newEM,
                };
                await api.put('/settings', state.settings);
                renderTimeline(); // re-renders week view
            };
            const cancel = () => {
                if (committed) return;
                committed = true;
                timesLabel.classList.remove('week-day-times-editing');
                timesLabel.textContent = `${startStr}–${endStr}`;
            };

            // Commit on blur (delayed to allow focus to shift between inputs)
            const blurHandler = () => {
                setTimeout(() => {
                    if (!timesLabel.contains(document.activeElement)) commit();
                }, 100);
            };
            startInput.addEventListener('blur', blurHandler);
            endInput.addEventListener('blur', blurHandler);

            // Enter commits, Escape cancels
            const keyHandler = (e2) => {
                if (e2.key === 'Enter') { e2.preventDefault(); commit(); }
                else if (e2.key === 'Escape') { e2.preventDefault(); cancel(); }
            };
            startInput.addEventListener('keydown', keyHandler);
            endInput.addEventListener('keydown', keyHandler);
        });

        // Quick-add button (revealed on hover)
        const addBtn = document.createElement('button');
        addBtn.className = 'week-day-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Plan an action for this day';
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Expand the day if collapsed
            if (content.style.display === 'none') {
                header.click();
            }
            // Show inline input inside the content area
            if (row.querySelector('.week-inline-add')) return; // already open
            const inlineRow = document.createElement('div');
            inlineRow.className = 'week-inline-add';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'week-inline-add-input';
            input.placeholder = "What's on your mind?";
            inlineRow.appendChild(input);
            content.insertBefore(inlineRow, content.firstChild);
            input.focus();

            let _removed = false;
            const _remove = () => { if (!_removed) { _removed = true; inlineRow.remove(); } };
            const commit = async () => {
                const name = input.value.trim();
                _remove();
                if (!name) return;
                await api.post('/items', { name, parentId: null, timeContexts: [dateKey] });
                state.items = await api.get('/items');
                renderAll();
            };
            input.addEventListener('keydown', (ke) => {
                if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
                if (ke.key === 'Escape') { ke.preventDefault(); _remove(); }
            });
            input.addEventListener('blur', () => _remove());
        });

        header.appendChild(toggle);
        header.appendChild(dayLabel);
        header.appendChild(addBtn);
        header.appendChild(timesLabel);
        row.appendChild(header);

        // ── Content area: two-column layout ──
        const content = document.createElement('div');
        content.className = 'week-day-content';

        const colScheduled = document.createElement('div');
        colScheduled.className = 'week-col-scheduled';
        const colFloating = document.createElement('div');
        colFloating.className = 'week-col-floating';

        // Gather data for this day
        let totalEstMins = 0;

        // 1. Scheduled plans (timeline entries for this date) → left column
        const { dayStart: ds, dayEnd: de } = getDayBoundaries(dayDate);
        const dayEntries = state.timeline.entries
            .filter(e => e.timestamp >= ds.getTime() && e.timestamp < de.getTime() && e.endTime)
            .sort((a, b) => a.timestamp - b.timestamp);

        for (const entry of dayEntries) {
            if (entry.type === 'work' || entry.type === 'break') continue; // skip live blocks
            const entryMins = Math.round((entry.endTime - entry.timestamp) / 60000);
            totalEstMins += entryMins;

            const isPastAppt = isToday && entry.endTime < Date.now();
            const pin = document.createElement('div');
            pin.className = 'week-appointment' + (isPastAppt ? ' week-appt-past' : '');
            pin.draggable = true;
            pin.dataset.entryId = String(entry.id);
            pin.dataset.sourceDate = dateKey;

            const timeStr = `${formatTime(entry.timestamp)}–${formatTime(entry.endTime)}`;
            pin.innerHTML = `<span class="week-appt-icon">📌</span><span class="week-appt-name">${entry.text || entry.type}</span><span class="week-appt-time">${timeStr}</span>`;

            pin.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-week-entry-id', String(entry.id));
                e.dataTransfer.setData('application/x-week-source-date', dateKey);
                e.dataTransfer.effectAllowed = 'move';
                pin.classList.add('week-item-dragging');
            });
            pin.addEventListener('dragend', () => pin.classList.remove('week-item-dragging'));

            colScheduled.appendChild(pin);
        }

        // 2. Floating items → right column (day-level + session-level merged)
        // Day-level action items (have date context but NOT segment/entry context)
        const dayItems = allItems.filter(item => {
            if (item.done && !state.showDone) return false;
            const tcs = item.timeContexts || [];
            return tcs.includes(dateKey) && !tcs.some(tc => tc.startsWith(dateKey + '@'));
        });

        // Session-level items (have segment/entry/live context for this day)
        const sessionItems = allItems.filter(item => {
            if (item.done && !state.showDone) return false;
            const tcs = item.timeContexts || [];
            return tcs.some(tc => tc.startsWith(dateKey + '@'));
        });

        // Merge all floating items and compute estimated mins
        const allFloating = [];
        for (const item of dayItems) {
            const estMins = item.contextDurations?.[dateKey] ?? item.estimatedDuration ?? 0;
            if (!item.done) totalEstMins += estMins;
            allFloating.push({ item, estMins, ctx: dateKey });
        }
        for (const sItem of sessionItems) {
            const segCtx = sItem.timeContexts.find(tc => tc.startsWith(dateKey + '@'));
            const estMins = sItem.contextDurations?.[segCtx] ?? sItem.contextDurations?.[dateKey] ?? sItem.estimatedDuration ?? 0;
            if (!sItem.done) totalEstMins += estMins;
            allFloating.push({ item: sItem, estMins, ctx: segCtx || dateKey });
        }

        // Helper: create a draggable chip for a floating item
        const _createWeekChip = ({ item, estMins, ctx }) => {
            const chip = document.createElement('div');
            chip.className = 'week-action-chip' + (item.done ? ' week-item-done' : '');
            chip.draggable = true;
            chip.dataset.itemId = String(item.id);

            const bullet = document.createElement('span');
            bullet.className = 'week-chip-bullet';
            bullet.textContent = item.done ? '✓' : '○';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'week-chip-name';
            nameSpan.textContent = item.name;

            const est = document.createElement('span');
            est.className = 'week-chip-est';
            est.textContent = estMins ? `~${estMins}m` : '⏱';
            est.title = 'Click to set duration';
            est.addEventListener('click', (ev) => {
                ev.stopPropagation();
                document.querySelectorAll('.segment-duration-popover').forEach(p => p.remove());
                const pop = document.createElement('div');
                pop.className = 'segment-duration-popover';
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'segment-duration-input';
                input.min = '0';
                input.max = '480';
                input.value = estMins || '';
                input.placeholder = 'min';
                const saveBtn = document.createElement('button');
                saveBtn.className = 'segment-duration-save';
                saveBtn.textContent = '✓';
                saveBtn.addEventListener('click', async (se) => {
                    se.stopPropagation();
                    const mins = parseInt(input.value, 10) || 0;
                    if (!item.contextDurations) item.contextDurations = {};
                    item.contextDurations[ctx] = mins;
                    await api.patch(`/items/${item.id}`, { contextDurations: item.contextDurations });
                    pop.remove();
                    renderAll();
                });
                pop.appendChild(input);
                pop.appendChild(saveBtn);
                chip.appendChild(pop);
                input.focus();
                input.select();
                const closeHandler = (ce) => {
                    if (!pop.contains(ce.target)) {
                        pop.remove();
                        document.removeEventListener('click', closeHandler, true);
                    }
                };
                setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
                input.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') saveBtn.click();
                    if (ke.key === 'Escape') pop.remove();
                });
            });

            chip.appendChild(bullet);
            chip.appendChild(nameSpan);
            chip.appendChild(est);

            chip.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-action-id', String(item.id));
                e.dataTransfer.setData('application/x-week-source-date', dateKey);
                e.dataTransfer.effectAllowed = 'move';
                chip.classList.add('week-item-dragging');
                window._draggedAction = true;
            });
            chip.addEventListener('dragend', () => {
                chip.classList.remove('week-item-dragging');
                window._draggedAction = false;
            });
            return chip;
        };

        // Group by root ancestor (same pattern as action area)
        const rootGroups = new Map(); // rootId → { root, entries[] }
        for (const entry of allFloating) {
            const ancestors = getAncestorPath(entry.item.id);
            const root = ancestors && ancestors.length > 0 ? ancestors[0] : null;
            const rootId = root ? root.id : 0;
            if (!rootGroups.has(rootId)) rootGroups.set(rootId, { root, entries: [] });
            rootGroups.get(rootId).entries.push(entry);
        }

        const shouldGroupWeek = rootGroups.size >= 2;

        if (shouldGroupWeek) {
            // Grouped rendering with collapsible headers (default: collapsed)
            const expandedKey = `weekGroups_${dateKey}`;
            if (!state._weekExpandedGroups) state._weekExpandedGroups = {};
            const expanded = state._weekExpandedGroups[expandedKey] || new Set();

            for (const [rootId, group] of rootGroups) {
                const isCollapsed = !expanded.has(rootId);
                const ghdr = document.createElement('div');
                ghdr.className = 'week-group-header' + (isCollapsed ? ' collapsed' : '');
                ghdr.dataset.rootId = rootId;

                const chevron = document.createElement('span');
                chevron.className = 'week-group-chevron';
                chevron.textContent = isCollapsed ? '▸' : '▾';
                ghdr.appendChild(chevron);

                const nameEl = document.createElement('span');
                nameEl.className = 'week-group-name';
                nameEl.textContent = group.root ? group.root.name : 'Ungrouped';
                ghdr.appendChild(nameEl);

                const countEl = document.createElement('span');
                countEl.className = 'week-group-count';
                countEl.textContent = group.entries.length;
                ghdr.appendChild(countEl);

                const wgTotalMins = group.entries.reduce((sum, e) => sum + (e.estMins || 0), 0);
                if (wgTotalMins > 0) {
                    const durEl = document.createElement('span');
                    durEl.className = 'week-group-duration';
                    durEl.textContent = wgTotalMins >= 60
                        ? `${Math.floor(wgTotalMins / 60)}h${wgTotalMins % 60 ? wgTotalMins % 60 + 'm' : ''}`
                        : `${wgTotalMins}m`;
                    ghdr.appendChild(durEl);
                }

                ghdr.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!state._weekExpandedGroups) state._weekExpandedGroups = {};
                    if (!state._weekExpandedGroups[expandedKey]) state._weekExpandedGroups[expandedKey] = new Set();
                    const eset = state._weekExpandedGroups[expandedKey];
                    if (eset.has(rootId)) eset.delete(rootId); else eset.add(rootId);
                    // Persist: convert Sets to arrays
                    const toSave = {};
                    for (const [k, s] of Object.entries(state._weekExpandedGroups)) toSave[k] = [...s];
                    savePref('weekExpandedGroups', toSave);
                    renderTimeline(); // re-renders week view
                });

                colFloating.appendChild(ghdr);

                if (!isCollapsed) {
                    for (const entry of group.entries) {
                        colFloating.appendChild(_createWeekChip(entry));
                    }
                }
            }
        } else {
            // Flat — no grouping needed
            for (const entry of allFloating) {
                colFloating.appendChild(_createWeekChip(entry));
            }
        }

        // Assemble columns into content
        const hasScheduled = colScheduled.children.length > 0;
        const hasFloating = colFloating.children.length > 0;

        if (hasScheduled || hasFloating) {
            if (hasScheduled) content.appendChild(colScheduled);
            if (hasFloating) content.appendChild(colFloating);
        }

        // Capacity bar (spans full width, below columns)
        if (totalEstMins > 0 || hasScheduled || hasFloating) {
            const capBar = document.createElement('div');
            capBar.className = 'segment-capacity-bar';
            const availMins = Math.max(1, dayCapacityMins);
            const fillPct = Math.min(100, (totalEstMins / availMins) * 100);
            const isOver = totalEstMins > availMins;
            const hrsLabel = totalEstMins >= 60
                ? `${Math.floor(totalEstMins / 60)}h${totalEstMins % 60 ? totalEstMins % 60 + 'm' : ''}`
                : `${totalEstMins}m`;
            const availLabel = dayCapacityMins >= 60
                ? `${Math.floor(dayCapacityMins / 60)}h`
                : `${dayCapacityMins}m`;
            capBar.innerHTML = `
                <span class="segment-capacity-label">${hrsLabel} / ${availLabel}</span>
                <div class="segment-capacity-track"><div class="segment-capacity-fill${isOver ? ' over-capacity' : ''}" style="width:${fillPct}%"></div></div>
            `;
            content.appendChild(capBar);
        }

        // Empty day indicator
        if (content.children.length === 0) {
            const emptyLabel = document.createElement('span');
            emptyLabel.className = 'week-day-empty';
            emptyLabel.textContent = '—';
            content.appendChild(emptyLabel);
        }

        row.appendChild(content);

        // ── Collapsed capacity bar (visible only when day is collapsed) ──
        let collapsedBar = null;
        if (totalEstMins > 0 || colScheduled.children.length > 0 || colFloating.children.length > 0) {
            collapsedBar = document.createElement('div');
            collapsedBar.className = 'segment-capacity-bar week-day-collapsed-bar';
            const availMins = Math.max(1, dayCapacityMins);
            const fillPct = Math.min(100, (totalEstMins / availMins) * 100);
            const isOver = totalEstMins > availMins;
            const hrsLabel = totalEstMins >= 60
                ? `${Math.floor(totalEstMins / 60)}h${totalEstMins % 60 ? totalEstMins % 60 + 'm' : ''}`
                : `${totalEstMins}m`;
            const availLabel = dayCapacityMins >= 60
                ? `${Math.floor(dayCapacityMins / 60)}h`
                : `${dayCapacityMins}m`;
            collapsedBar.innerHTML = `
                <span class="segment-capacity-label">${hrsLabel} / ${availLabel}</span>
                <div class="segment-capacity-track"><div class="segment-capacity-fill${isOver ? ' over-capacity' : ''}" style="width:${fillPct}%"></div></div>
            `;
            row.appendChild(collapsedBar);
        }

        // ── Collapse toggle (persisted) ──
        const collapsedDays = state.weekCollapsedDays || {};
        // Default: past days collapsed, others expanded
        const isCollapsed = dateKey in collapsedDays ? collapsedDays[dateKey] : isPast;
        if (isCollapsed) {
            content.style.display = 'none';
            if (collapsedBar) collapsedBar.style.display = '';
            toggle.textContent = '▸';
            row.classList.add('week-day-collapsed');
        } else {
            if (collapsedBar) collapsedBar.style.display = 'none';
        }
        header.addEventListener('click', () => {
            const wasCollapsed = content.style.display === 'none';
            content.style.display = wasCollapsed ? '' : 'none';
            if (collapsedBar) collapsedBar.style.display = wasCollapsed ? 'none' : '';
            toggle.textContent = wasCollapsed ? '▾' : '▸';
            row.classList.toggle('week-day-collapsed', !wasCollapsed);
            // Persist
            if (!state.weekCollapsedDays) state.weekCollapsedDays = {};
            state.weekCollapsedDays[dateKey] = !wasCollapsed;
            savePref('weekCollapsedDays', state.weekCollapsedDays);
        });

        // ── Drop target: accept items dragged to this day row ──
        row.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.some(t =>
                t === 'application/x-action-id' ||
                t === 'application/x-segment-item-id' ||
                t === 'application/x-week-entry-id'
            )) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            row.classList.add('week-day-drag-over');
        });
        row.addEventListener('dragleave', (e) => {
            // Only remove highlight if actually leaving the row
            if (!row.contains(e.relatedTarget)) {
                row.classList.remove('week-day-drag-over');
            }
        });
        row.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove('week-day-drag-over');

            // Appointment reschedule
            const entryId = e.dataTransfer.getData('application/x-week-entry-id');
            if (entryId) {
                const sourceDate = e.dataTransfer.getData('application/x-week-source-date');
                if (sourceDate === dateKey) return; // same day, no-op
                const entry = state.timeline.entries.find(en => String(en.id) === entryId);
                if (entry) {
                    // Calculate offset days and shift the entry
                    const srcDate = new Date(sourceDate + 'T00:00:00');
                    const tgtDate = new Date(dateKey + 'T00:00:00');
                    const offsetMs = tgtDate.getTime() - srcDate.getTime();
                    entry.timestamp += offsetMs;
                    entry.endTime += offsetMs;
                    await api.patch(`/timeline/${entry.id}`, { timestamp: entry.timestamp, endTime: entry.endTime });
                    renderAll();
                }
                return;
            }

            // Segment item (drag out of session → degrade to day-level)
            const segItemId = e.dataTransfer.getData('application/x-segment-item-id');
            if (segItemId) {
                const segCtx = e.dataTransfer.getData('application/x-segment-context');
                const item = findItemById(Number(segItemId));
                if (item && segCtx) {
                    // Remove segment context
                    const segDur = item.contextDurations?.[segCtx];
                    if (item.timeContexts) {
                        item.timeContexts = item.timeContexts.filter(tc => tc !== segCtx);
                    }
                    if (item.contextDurations) delete item.contextDurations[segCtx];
                    // Reschedule to target date
                    await rescheduleToDate(Number(segItemId), dateKey);
                }
                return;
            }

            // Regular action item
            const actionId = e.dataTransfer.getData('application/x-action-id');
            if (actionId) {
                await rescheduleToDate(parseInt(actionId, 10), dateKey);
            }
        });

        weekEl.appendChild(row);

        // Track this day's end for sleep gap calculation
        const dayEndMins = dayTimes.dayEndHour * 60 + dayTimes.dayEndMinute;
        prevDayEndMins = dayEndMins;
    }

    container.appendChild(weekEl);

    // Auto-scroll to target day only on initial week entry (one-shot)
    if (state._weekScrollTarget) {
        const scrollTarget = state._weekScrollTarget;
        delete state._weekScrollTarget;
        requestAnimationFrame(() => {
            const targetRow = weekEl.querySelector(`.week-day-row[data-date-key="${scrollTarget}"]`);
            if (targetRow) {
                const scrollParent = container.closest('.timeline-list') || container;
                const rowTop = targetRow.offsetTop - scrollParent.offsetTop;
                scrollParent.scrollTo({ top: rowTop - scrollParent.clientHeight / 3, behavior: 'smooth' });
            }
        });
    }
}

function renderTimeline() {
    const container = document.getElementById('timeline-list');
    const savedScrollTop = container.scrollTop;
    const empty = document.getElementById('timeline-empty');
    const quickLog = document.querySelector('.quick-log');

    // Clear all rendered blocks (including breadcrumb)
    container.querySelectorAll('.time-block, .timeline-entry, .epoch-placeholder, .epoch-week-overview, .week-view, .session-panel, .week-sleep-divider, .divergence-prompt, .divergence-banner, .compact-past-entry, .compact-project-wrapper').forEach(el => el.remove());

    // ── Epoch horizon: show week overview for the epoch's range ──
    if (state.viewHorizon === 'epoch') {
        empty.style.display = 'none';
        if (quickLog) quickLog.style.display = 'none';

        const { startWeek, endWeek } = getEpochWeekRange(state.epochFilter);
        const epochIcons = { past: '📜', ongoing: '📦', future: '🔮' };
        const epochLabels = { past: 'Past', ongoing: 'Ongoing', future: 'Future' };
        const ms = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        // Build list of week keys for this epoch
        const weekKeys = [];
        const currentWeek = getWeekKey(getLogicalToday());

        if (startWeek && endWeek) {
            // Bounded (ongoing): enumerate from startWeek to endWeek
            let wk = startWeek;
            for (let i = 0; i < 200; i++) { // safety cap
                weekKeys.push(wk);
                if (wk >= endWeek) break;
                wk = offsetWeekKey(wk, 1);
            }
        } else if (!startWeek && endWeek) {
            // Past: show last 8 weeks before ongoing
            for (let i = 7; i >= 0; i--) {
                const wk = offsetWeekKey(endWeek, -i);
                weekKeys.push(wk);
            }
        } else if (startWeek && !endWeek) {
            // Future: show next 8 weeks after ongoing
            for (let i = 0; i < 8; i++) {
                weekKeys.push(offsetWeekKey(startWeek, i));
            }
        }

        // Format a week range as "Feb 10–16" or "Feb 10–Mar 2"
        function fmtWeekRange(weekKey) {
            const rng = getWeekDateRange(weekKey);
            if (!rng) return weekKey;
            const sm = ms[rng.start.getMonth()];
            const em = ms[rng.end.getMonth()];
            const s = `${sm} ${rng.start.getDate()}`;
            const e = sm === em ? `${rng.end.getDate()}` : `${em} ${rng.end.getDate()}`;
            return `${s}–${e}`;
        }

        // Count items explicitly assigned to this epoch
        const allItems = (window.items || []);
        const epochItemCount = allItems.filter(it =>
            !it.deleted && (it.timeContexts || []).includes(state.epochFilter)
        ).length;

        const panel = document.createElement('div');
        panel.className = 'epoch-week-overview';

        // Header
        const header = document.createElement('div');
        header.className = 'epoch-overview-header';
        header.innerHTML = `
            <span class="epoch-overview-icon">${epochIcons[state.epochFilter] || '📦'}</span>
            <span class="epoch-overview-title">${epochLabels[state.epochFilter] || 'Epoch'}</span>
            <span class="epoch-overview-count">${epochItemCount} item${epochItemCount !== 1 ? 's' : ''}</span>
        `;
        panel.appendChild(header);

        // Boundary adjust for ongoing — top (past direction)
        if (state.epochFilter === 'ongoing') {
            const topAdjust = document.createElement('div');
            topAdjust.className = 'epoch-boundary-adjust';
            topAdjust.innerHTML = `
                <button class="epoch-boundary-btn" data-dir="past" data-action="expand" title="Show 1 more past week">+ Earlier</button>
                ${state.ongoingPastWeeks > 0 ? `<button class="epoch-boundary-btn epoch-boundary-btn-shrink" data-dir="past" data-action="shrink" title="Show 1 less past week">− Shrink</button>` : ''}
            `;
            panel.appendChild(topAdjust);
        }

        // Week rows
        weekKeys.forEach(wk => {
            const row = document.createElement('div');
            row.className = 'epoch-week-row';
            if (wk === currentWeek) row.classList.add('epoch-week-current');

            const label = fmtWeekRange(wk);
            const isCurrentStr = wk === currentWeek ? ' <span class="epoch-week-now">This Week</span>' : '';

            row.innerHTML = `
                <span class="epoch-week-label">${label}${isCurrentStr}</span>
            `;

            row.addEventListener('click', () => {
                // Drill down to week view for this week
                const range = getWeekDateRange(wk);
                if (range) state.timelineViewDate = range.start;
                clearFocusStack();
                state.viewHorizon = 'week';
                savePref('viewHorizon', 'week');
                renderAll();
            });

            panel.appendChild(row);
        });

        // Boundary adjust for ongoing — bottom (future direction)
        if (state.epochFilter === 'ongoing') {
            const bottomAdjust = document.createElement('div');
            bottomAdjust.className = 'epoch-boundary-adjust';
            bottomAdjust.innerHTML = `
                <button class="epoch-boundary-btn" data-dir="future" data-action="expand" title="Show 1 more future week">+ Later</button>
                ${state.ongoingFutureWeeks > 0 ? `<button class="epoch-boundary-btn epoch-boundary-btn-shrink" data-dir="future" data-action="shrink" title="Show 1 less future week">− Shrink</button>` : ''}
            `;
            panel.appendChild(bottomAdjust);
        }

        // Wire boundary buttons
        panel.querySelectorAll('.epoch-boundary-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dir = btn.dataset.dir; // 'past' or 'future'
                const action = btn.dataset.action; // 'expand' or 'shrink'
                if (dir === 'past') {
                    state.ongoingPastWeeks = Math.max(0, state.ongoingPastWeeks + (action === 'expand' ? 1 : -1));
                    savePref('ongoingPastWeeks', state.ongoingPastWeeks);
                } else {
                    state.ongoingFutureWeeks = Math.max(0, state.ongoingFutureWeeks + (action === 'expand' ? 1 : -1));
                    savePref('ongoingFutureWeeks', state.ongoingFutureWeeks);
                }
                renderAll();
            });
        });

        container.appendChild(panel);
        updateDateNav();
        return;
    }

    // ── Week horizon: replace timeline with week view ──
    if (state.viewHorizon === 'week') {
        empty.style.display = 'none';
        if (quickLog) quickLog.style.display = 'none';
        // Also clear any week-view leftovers
        container.querySelectorAll('.week-view').forEach(el => el.remove());
        renderWeekView(container);
        return;
    }

    // ── Session horizon: replace timeline with session panel ──
    if (state.viewHorizon === 'session') {
        empty.style.display = 'none';
        if (quickLog) quickLog.style.display = 'none';
        container.querySelectorAll('.session-panel').forEach(el => el.remove());

        const segments = buildPlanSegments();
        const idx = Math.max(0, Math.min(segments.length - 1, state.sessionIndex));
        const seg = segments[idx];
        if (!seg) return;

        const panel = document.createElement('div');
        panel.className = 'session-panel';

        const nowMs = Date.now();
        const elapsed = Math.max(0, Math.min(nowMs - seg.startMs, seg.endMs - seg.startMs));
        const total = seg.endMs - seg.startMs;
        const remaining = Math.max(0, seg.endMs - nowMs);
        const progress = total > 0 ? (elapsed / total) * 100 : 0;
        const isCurrent = nowMs >= seg.startMs && nowMs < seg.endMs;
        const isPast = nowMs >= seg.endMs;

        const _fmtDur = (ms) => {
            const mins = Math.round(ms / 60000);
            if (mins < 60) return `${mins}m`;
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            return m > 0 ? `${h}h ${m}m` : `${h}h`;
        };

        // ── Progress section ──
        const progressSection = document.createElement('div');
        progressSection.className = 'session-panel-progress';
        const progressBar = document.createElement('div');
        progressBar.className = 'session-panel-progress-bar';
        const fill = document.createElement('div');
        fill.className = 'session-panel-progress-fill';
        fill.style.width = `${Math.min(100, progress)}%`;
        if (isPast) fill.classList.add('session-panel-progress-complete');
        progressBar.appendChild(fill);
        progressSection.appendChild(progressBar);

        const timeLabel = document.createElement('div');
        timeLabel.className = 'session-panel-time-label';
        if (isCurrent) {
            timeLabel.textContent = `${_fmtDur(remaining)} remaining`;
        } else if (isPast) {
            timeLabel.textContent = 'Completed';
        } else {
            timeLabel.textContent = `Starts in ${_fmtDur(seg.startMs - nowMs)}`;
        }
        progressSection.appendChild(timeLabel);
        panel.appendChild(progressSection);

        // ── Reality overlay ──
        const dateKey = getDateKey(state.timelineViewDate);
        const dayEntries = (state.timeline?.entries || [])
            .filter(e => e.timestamp >= seg.startMs && e.timestamp < seg.endMs && e.endTime);
        let workedMs = 0, breakMs = 0;
        for (const e of dayEntries) {
            const eStart = Math.max(e.timestamp, seg.startMs);
            const eEnd = Math.min(e.endTime, seg.endMs);
            const dur = Math.max(0, eEnd - eStart);
            if (e.type === 'work') workedMs += dur;
            else if (e.type === 'break') breakMs += dur;
        }
        // Include live state if within this session
        if (state.workingOn && state.workingOn.startTime < seg.endMs && nowMs >= seg.startMs && nowMs < seg.endMs) {
            workedMs += Math.max(0, nowMs - Math.max(state.workingOn.startTime, seg.startMs));
        }
        if (state.onBreak && state.onBreak.startTime < seg.endMs && nowMs >= seg.startMs && nowMs < seg.endMs) {
            breakMs += Math.max(0, nowMs - Math.max(state.onBreak.startTime, seg.startMs));
        }
        const idleMs = Math.max(0, elapsed - workedMs - breakMs);

        const realitySection = document.createElement('div');
        realitySection.className = 'session-panel-reality';
        realitySection.innerHTML = `
            <div class="session-panel-reality-title">Reality</div>
            <div class="session-panel-reality-stats">
                <span class="session-reality-stat">🔥 ${_fmtDur(workedMs)} worked</span>
                <span class="session-reality-stat">☕ ${_fmtDur(breakMs)} break</span>
                <span class="session-reality-stat">💤 ${_fmtDur(idleMs)} idle</span>
            </div>
        `;
        panel.appendChild(realitySection);

        // ── Live state ──
        if (isCurrent) {
            const liveSection = document.createElement('div');
            liveSection.className = 'session-panel-live';
            if (state.workingOn) {
                const workDur = nowMs - state.workingOn.startTime;
                liveSection.innerHTML = `<span class="session-live-indicator live-working">🔥 Working on ${state.workingOn.itemName || 'something'} · ${_fmtDur(workDur)}</span>`;
            } else if (state.onBreak) {
                const breakDur = nowMs - state.onBreak.startTime;
                liveSection.innerHTML = `<span class="session-live-indicator live-break">☕ On break · ${_fmtDur(breakDur)}</span>`;
            } else {
                liveSection.innerHTML = `<span class="session-live-indicator live-idle">💤 Idle</span>`;
            }
            panel.appendChild(liveSection);
        }

        // ── Capacity ──
        const allItems = collectAllItems(state.items.items);
        const sessionItems = allItems.filter(item => {
            if (!item.timeContexts) return false;
            return item.timeContexts.some(tc => {
                if (seg.segmentKey && tc === seg.segmentKey) return true;
                if (seg.entryId && tc === `${dateKey}@entry:${seg.entryId}`) return true;
                // Check time overlap for segment contexts
                const p = parseTimeContext(tc);
                if (!p || !p.segment || p.date !== dateKey) return false;
                const [sh, sm] = p.segment.start.split(':').map(Number);
                const [eh, em] = p.segment.end.split(':').map(Number);
                const ref = new Date(state.timelineViewDate);
                const tcStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), sh, sm).getTime();
                const tcEnd = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), eh, em).getTime();
                return tcStart < seg.endMs && tcEnd > seg.startMs;
            });
        });
        const totalEstimated = sessionItems.reduce((sum, item) => {
            const dur = item.contextDurations?.[seg.segmentKey] || item.estimatedDuration || 0;
            return sum + dur;
        }, 0);
        const capacitySection = document.createElement('div');
        capacitySection.className = 'session-panel-capacity';
        capacitySection.innerHTML = `
            <div class="session-panel-capacity-title">Capacity</div>
            <div class="session-panel-capacity-info">
                <span>${sessionItems.length} item${sessionItems.length !== 1 ? 's' : ''} · ${_fmtDur(totalEstimated * 1000)} estimated</span>
                <span class="session-capacity-session-dur">${_fmtDur(total)} session</span>
            </div>
        `;
        panel.appendChild(capacitySection);

        // ── What's next (for context) ──
        if (idx < segments.length - 1) {
            const nextSeg = segments[idx + 1];
            const whatsNext = document.createElement('div');
            whatsNext.className = 'session-panel-next';
            whatsNext.innerHTML = `<span class="session-next-label">Next:</span> <span class="session-next-value">${nextSeg.icon} ${nextSeg.label}</span>`;
            panel.appendChild(whatsNext);
        }

        container.appendChild(panel);
        return;
    }

    // Restore quick-log visibility when not in ongoing
    if (quickLog) quickLog.style.display = '';

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

    // ── Phantom lead-time blocks: inject prep blocks before planned entries with short lead times ──
    const phantomEntries = [];
    for (const entry of allDayEntries) {
        if (entry.type !== 'planned' || !entry.itemId) continue;
        const item = findItemById(entry.itemId);
        if (!item?.contextLeadTimes) continue;
        for (const [ctx, leadSec] of Object.entries(item.contextLeadTimes)) {
            const ctxParsed = parseTimeContext(ctx);
            if (!ctxParsed?.entryId || String(ctxParsed.entryId) !== String(entry.id)) continue;
            if (leadSec >= 86400) continue; // Only sub-24h lead times become phantom blocks
            const phantomEnd = entry.timestamp;
            const phantomStart = phantomEnd - leadSec * 1000;
            if (phantomStart >= phantomEnd) continue;
            phantomEntries.push({
                text: item.name,
                type: 'planned',
                timestamp: phantomStart,
                startTime: phantomStart,
                endTime: phantomEnd,
                itemId: item.id,
                id: `phantom-${entry.id}`,
                _phantom: true,
            });
        }
    }
    if (phantomEntries.length > 0) {
        allDayEntries.push(...phantomEntries);
        allDayEntries.sort((a, b) => a.timestamp - b.timestamp);
    }

    // ── Separate block entries (anchors) from moment entries (non-anchors) ──
    // Block entries have a time span (work, break, planned) and define the timeline structure.
    // Moment entries (completion, manual logs) happen at a point in time and render
    // indented under the block during which they occurred.
    const isBlockEntry = (e) => e.endTime && (e.type === 'work' || e.type === 'break' || e.type === 'planned' || e.type === 'idle');

    // ── Plan Absorption: hide planned entries fully covered by matching work entries ──
    // A planned entry is "absorbed" if a work entry with the same itemId covers ≥80% of its time.
    const workEntries = allDayEntries.filter(e => e.type === 'work' && e.endTime);
    if (state.workingOn) {
        workEntries.push({
            type: 'work',
            timestamp: state.workingOn.startTime,
            endTime: nowMs,
            itemId: state.workingOn.itemId,
        });
    }
    for (const entry of allDayEntries) {
        if (entry.type !== 'planned' || !entry.endTime || entry._phantom) continue;
        const planStart = entry.timestamp;
        const planEnd = entry.endTime;
        const planDuration = planEnd - planStart;
        if (planDuration <= 0) continue;

        // Check for absorption: same itemId + ≥80% time overlap
        let absorbed = false;
        for (const work of workEntries) {
            const overlapStart = Math.max(planStart, work.timestamp);
            const overlapEnd = Math.min(planEnd, work.endTime);
            const overlap = Math.max(0, overlapEnd - overlapStart);
            if (entry.itemId && work.itemId === entry.itemId && overlap >= planDuration * 0.8) {
                absorbed = true;
                break;
            }
        }
        entry._absorbed = absorbed;
    }

    const allBlockEntries = allDayEntries.filter(e => isBlockEntry(e) && !e._absorbed);
    const allMomentEntries = allDayEntries.filter(e => !isBlockEntry(e));

    // ── Divergence Detection: find planned sessions that ended without being absorbed ──
    const divergences = detectDivergences(allDayEntries, nowMs);
    // Also detect out-of-hours work (gap between day end and next day start)
    divergences.push(...detectOutOfHoursWork(state.timelineViewDate, nowMs));
    const divergenceByEntryId = new Map();
    const divergenceByWorkId = new Map();
    for (const div of divergences) {
        if (div.type === 'unplanned' || div.type === 'out-of-hours') {
            divergenceByWorkId.set(div.workEntry.id, div);
        } else {
            divergenceByEntryId.set(div.entry.id, div);
        }
    }

    // When "hide past entries" is on and viewing today, remove entries before now
    const hidePast = isPastHidden();
    const dayBlockEntries = hidePast
        ? allBlockEntries.filter(e => (e.endTime || e.timestamp) >= nowMs)
        : allBlockEntries;
    const dayMomentEntries = hidePast
        ? allMomentEntries.filter(e => e.timestamp >= nowMs)
        : allMomentEntries;

    const fragment = document.createDocumentFragment();

    // ── Divergence banner: show unresolved divergences as compact queue ──
    if (divergences.length > 0) {
        fragment.appendChild(createDivergenceBanner(divergences));
    }

    // ── Night indicator BEFORE Day Start (previous day's end → this day's start) ──
    if (!hidePast || !viewingToday) {
        const prevDay = new Date(viewDate);
        prevDay.setDate(prevDay.getDate() - 1);
        const prevTimes = getEffectiveDayTimes(prevDay);
        const prevEndMins = prevTimes.dayEndHour * 60 + prevTimes.dayEndMinute;
        const curStartMins = dayStart.getHours() * 60 + dayStart.getMinutes();
        let nightBeforeMins = curStartMins - prevEndMins;
        if (nightBeforeMins <= 0) nightBeforeMins += 24 * 60;
        if (nightBeforeMins > 0 && nightBeforeMins < 24 * 60) {
            const sleepDiv = document.createElement('div');
            sleepDiv.className = 'week-sleep-divider';
            const h = Math.floor(nightBeforeMins / 60);
            const m = nightBeforeMins % 60;
            sleepDiv.textContent = `🌙 ${h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`}`;
            fragment.appendChild(sleepDiv);
        }
        fragment.appendChild(createDayBoundaryBlock('day-start', dayStart, now));
    }

    // ── Build interleaved block entries + free time blocks ──
    // Track cursor through the day to find gaps — only block entries advance the cursor
    let cursor = hidePast ? Math.max(nowMs, dayStart.getTime()) : dayStart.getTime();

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
        if (state.workingOn) {
            const workProjectedEnd = Math.max(nowMs, state.workingOn.targetEndTime || 0);
            fragment.appendChild(createWorkingTimeBlock(state.workingOn.startTime, nowMs));
            cursor = Math.max(cursor, workProjectedEnd);
        } else if (state.onBreak) {
            fragment.appendChild(createBreakTimeBlock(state.onBreak.startTime, nowMs));
            const breakProjectedEnd = Math.max(nowMs, state.onBreak.targetEndTime || nowMs);
            cursor = Math.max(cursor, breakProjectedEnd);
        } else {
            // Show idle from the end of the last block (or day start) to now, cap start at now
            const idleStart = Math.min(lastBlockEndBeforeNow || dayStart.getTime(), nowMs);
            fragment.appendChild(createIdleTimeBlock(idleStart, nowMs));
            cursor = Math.max(cursor, nowMs);
        }
    }

    // ── If no block entries before now and viewing today, idle/working from day start to now ──
    // Skip when hidePast already injected the idle/working block above
    if (!hidePast && viewingToday && !lastBlockBeforeNow && nowMs > dayStart.getTime() && nowMs < dayEndMs) {
        const firstBlock = dayBlockEntries[0];
        const idleEnd = firstBlock ? Math.min(nowMs, firstBlock.timestamp) : Math.min(nowMs, dayEndMs);
        if (idleEnd > dayStart.getTime()) {
            if (state.workingOn) {
                const workProjectedEnd = Math.max(nowMs, state.workingOn.targetEndTime || 0);
                fragment.appendChild(createWorkingTimeBlock(state.workingOn.startTime, idleEnd));
                cursor = Math.max(cursor, workProjectedEnd);
            } else if (state.onBreak) {
                fragment.appendChild(createBreakTimeBlock(state.onBreak.startTime, idleEnd));
                const breakProjectedEnd = Math.max(nowMs, state.onBreak.targetEndTime || nowMs);
                cursor = Math.max(cursor, breakProjectedEnd);
            } else {
                fragment.appendChild(createIdleTimeBlock(dayStart.getTime(), idleEnd));
                cursor = Math.max(cursor, idleEnd);
            }
        }
        // Append any moment entries in the idle gap
        appendMomentsBetween(fragment, dayStart.getTime(), idleEnd);
    }



    // ── Compact mode: split past vs present/future entries ──
    const compactMode = isPastCompact();

    for (let i = 0; i < dayBlockEntries.length; i++) {
        const entry = dayBlockEntries[i];
        const entryTime = entry.timestamp;
        const entryEnd = entry.endTime;
        const entryIsPast = entryEnd < nowMs;

        // In compact mode, collect contiguous past entries and render as batch
        if (compactMode && entryIsPast) {
            // Collect all contiguous past block entries starting from i
            const pastRun = [];
            let j = i;
            while (j < dayBlockEntries.length && dayBlockEntries[j].endTime < nowMs) {
                pastRun.push(dayBlockEntries[j]);
                j++;
            }
            // Collect moment entries in the past range to absorb completions
            const pastStart = pastRun[0].timestamp;
            const pastEnd = pastRun[pastRun.length - 1].endTime;
            const pastMoments = dayMomentEntries.filter(m => m.timestamp >= pastStart && m.timestamp < pastEnd + 60000);

            // Smart-merge with project grouping and completion absorption
            const { items: merged, absorbedMomentIds } = mergePastEntries(pastRun, pastMoments);
            for (const m of merged) {
                if (m._isProjectGroup) {
                    fragment.appendChild(createCompactProjectGroup(m));
                } else {
                    fragment.appendChild(createCompactPastEntry(m));
                }
            }
            // Render non-absorbed moment entries
            const remainingMoments = dayMomentEntries.filter(
                m => m.timestamp >= pastStart && m.timestamp < pastEnd && !absorbedMomentIds.has(m.id)
            );
            for (const m of remainingMoments) {
                fragment.appendChild(createMomentEntry(m));
            }
            cursor = Math.max(cursor, pastEnd);
            i = j - 1; // skip processed entries (loop will increment)
            continue;
        }

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

        // Render entry normally
        fragment.appendChild(createTimelineElement(entry));
        appendMomentsBetween(fragment, entryTime, entryEnd);
        cursor = Math.max(cursor, entryEnd);

        // ── Divergence prompt: if this planned entry is an unresolved divergence, show resolve prompt ──
        if (!hidePast && entry.type === 'planned' && divergenceByEntryId.has(entry.id)) {
            fragment.appendChild(createDivergencePrompt(divergenceByEntryId.get(entry.id)));
        }
        // ── Unplanned work prompt: if this work entry has no covering plan ──
        if (!hidePast && entry.type === 'work' && divergenceByWorkId.has(entry.id)) {
            fragment.appendChild(createDivergencePrompt(divergenceByWorkId.get(entry.id)));
        }

        // ── Idle/Working block: inject after the last block before "now" ──
        const isLastBeforeNow = entryTime === lastBlockBeforeNow;

        if (viewingToday && isLastBeforeNow && nowMs > entryEnd) {
            const nextBlock = dayBlockEntries[i + 1];
            const idleEnd = nextBlock ? Math.min(nowMs, nextBlock.timestamp) : nowMs;
            if (idleEnd > entryEnd) {
                if (state.workingOn) {
                    const workProjectedEnd = Math.max(nowMs, state.workingOn.targetEndTime || 0);
                    fragment.appendChild(createWorkingTimeBlock(state.workingOn.startTime, idleEnd));
                    cursor = Math.max(cursor, workProjectedEnd);
                } else if (state.onBreak) {
                    fragment.appendChild(createBreakTimeBlock(state.onBreak.startTime, idleEnd));
                    const breakProjectedEnd = Math.max(nowMs, state.onBreak.targetEndTime || nowMs);
                    cursor = Math.max(cursor, breakProjectedEnd);
                } else {
                    fragment.appendChild(createIdleTimeBlock(entryEnd, idleEnd));
                    cursor = Math.max(cursor, idleEnd);
                }
                appendMomentsBetween(fragment, entryEnd, idleEnd);
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

    // ── Night indicator AFTER Day End (this day's end → next day's start) ──
    const nextDay = new Date(viewDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextTimes = getEffectiveDayTimes(nextDay);
    const curEndMins = dayEnd.getHours() * 60 + dayEnd.getMinutes();
    const nextStartMins = nextTimes.dayStartHour * 60 + nextTimes.dayStartMinute;
    let nightAfterMins = nextStartMins - curEndMins;
    if (nightAfterMins <= 0) nightAfterMins += 24 * 60;
    if (nightAfterMins > 0 && nightAfterMins < 24 * 60) {
        const sleepDiv = document.createElement('div');
        sleepDiv.className = 'week-sleep-divider';
        const h = Math.floor(nightAfterMins / 60);
        const m = nightAfterMins % 60;
        sleepDiv.textContent = `🌙 ${h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`}`;
        fragment.appendChild(sleepDiv);
    }

    // ── Session focus: if focused, filter timeline to session time range ──
    const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    if (focusedSession) {
        const fs = focusedSession;

        // Filter fragment children to only those within session boundaries
        const filtered = document.createDocumentFragment();
        const children = Array.from(fragment.children);
        for (const child of children) {
            const childStart = parseInt(child.dataset?.startTime, 10);
            const childEnd = parseInt(child.dataset?.endTime, 10);
            // Keep items that overlap with the session, or have no timing data (moment entries etc.)
            if (isNaN(childStart) || isNaN(childEnd)) {
                // Non-timed elements: keep moment entries that fall in range
                const ts = parseInt(child.dataset?.timestamp, 10);
                if (isNaN(ts) || (ts >= fs.startMs && ts < fs.endMs)) {
                    filtered.appendChild(child);
                }
            } else if (childEnd > fs.startMs && childStart < fs.endMs) {
                filtered.appendChild(child);
            }
        }
        container.appendChild(filtered);
    } else {
        container.appendChild(fragment);
    }

    // Restore scroll position after rebuild (skip if week view is handling its own scroll)
    if (!state._weekScrollPending) container.scrollTop = savedScrollTop;

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
    el.className = 'time-block time-block-free focusable-block';
    el.dataset.startTime = startMs;
    el.dataset.endTime = endMs;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => toggleSessionFocus({
        startMs, endMs, label: 'Free Time', type: 'free', icon: '✨',
        segmentKey: buildSegmentContext(getDateKey(state.timelineViewDate), startMs, endMs),
    }));

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
    const _acceptsDrag = (e) =>
        e.dataTransfer.types.includes('application/x-action-id') ||
        e.dataTransfer.types.includes('application/x-segment-item-id');

    el.addEventListener('dragover', (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('time-block-drag-over');
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            console.log('[FREE-BLOCK] dragover from segment item');
        }
    });
    el.addEventListener('dragenter', (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        el.classList.add('time-block-drag-over');
    });
    el.addEventListener('dragleave', (e) => {
        // Only remove if we're leaving the block itself, not entering a child
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        el.classList.remove('time-block-drag-over');
    });
    el.addEventListener('drop', (e) => {
        console.log('[FREE-BLOCK] drop event, types:', [...e.dataTransfer.types]);
        if (!_acceptsDrag(e)) { console.log('[FREE-BLOCK] drop rejected by _acceptsDrag'); return; }
        e.preventDefault();
        el.classList.remove('time-block-drag-over');

        const dateKey = getDateKey(state.timelineViewDate);
        const newSegCtx = buildSegmentContext(dateKey, startMs, endMs);

        // Cross-block drag: segment item moving between free blocks
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const oldCtx = e.dataTransfer.getData('application/x-segment-context');
            console.log('[FREE-BLOCK] cross-block drop, itemId:', itemId, 'oldCtx:', oldCtx, 'newCtx:', newSegCtx);
            if (itemId && oldCtx && oldCtx !== newSegCtx) {
                (async () => {
                    const dur = await degradeSegmentContext(itemId, oldCtx);
                    await addSegmentContext(itemId, newSegCtx, dur);
                })();
            } else {
                console.log('[FREE-BLOCK] cross-block drop skipped (same block or missing data)');
            }
            return;
        }

        // Normal drag from Actions panel
        const action = window._draggedAction;
        console.log('[FREE-BLOCK] normal drop, action:', action?.id);
        if (!action) return;
        window._draggedAction = null;
        // Carry duration from the current view context (Actions panel)
        const srcDur = getContextDuration(findItemById(action.id));
        addSegmentContext(action.id, newSegCtx, srcDur || undefined);
    });

    // ── Nested segment-assigned items ──
    const dateKey = getDateKey(state.timelineViewDate);
    const segCtx = buildSegmentContext(dateKey, startMs, endMs);
    const allItems = collectAllItems();
    const assignedItems = allItems.filter(a => {
        const item = findItemById(a.id);
        if (!item || !item.timeContexts) return false;
        if (item.done && !state.showDone) return false;
        // Match: exact segment context OR overlapping segment context
        return item.timeContexts.some(tc => {
            if (tc === segCtx) return true;
            const parsed = parseTimeContext(tc);
            if (!parsed || !parsed.segment || parsed.date !== dateKey) return false;
            // Parse stored segment times to ms for overlap check
            const [sh, sm] = parsed.segment.start.split(':').map(Number);
            const [eh, em] = parsed.segment.end.split(':').map(Number);
            const refDate = new Date(startMs);
            const tcStart = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), sh, sm).getTime();
            let tcEnd = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), eh, em).getTime();
            // Cross-midnight: if end time is before start time, end is next calendar day
            if (tcEnd <= tcStart) tcEnd += 24 * 60 * 60 * 1000;
            const overlapStart = Math.max(startMs, tcStart);
            const overlapEnd = Math.min(endMs, tcEnd);
            if (overlapEnd <= overlapStart) return false;
            // Duration-aware: block must be able to contain the item's estimated duration
            const estMs = getContextDuration(item) * 60000;
            return estMs === 0 || (endMs - startMs) >= estMs;
        });
    });

    // ── Phantom items from segment-based lead times (< 24h) ──
    // Items assigned to this block that also have a sub-24h lead time get a phantom
    // prep item alongside them, adding the lead time duration to the block's capacity.
    const phantomSegmentItems = [];
    for (const a of assignedItems) {
        const item = findItemById(a.id);
        if (!item?.contextLeadTimes) continue;
        for (const [ctx, leadSec] of Object.entries(item.contextLeadTimes)) {
            if (leadSec >= 86400) continue; // Only sub-24h lead times
            const parsed = parseTimeContext(ctx);
            if (!parsed?.segment || parsed.date !== dateKey) continue;
            // Verify this lead time context matches the segment this block covers
            const [sh, sm] = parsed.segment.start.split(':').map(Number);
            const [eh, em] = parsed.segment.end.split(':').map(Number);
            const refDate = new Date(startMs);
            const ctxStart = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), sh, sm).getTime();
            let ctxEnd = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), eh, em).getTime();
            if (ctxEnd <= ctxStart) ctxEnd += 24 * 60 * 60 * 1000;
            // Only add if this block overlaps with the lead time's segment
            if (Math.min(endMs, ctxEnd) > Math.max(startMs, ctxStart)) {
                const prepDurMins = Math.round(leadSec / 60);
                phantomSegmentItems.push({ id: a.id, name: a.name, _path: a._path, _phantomDur: prepDurMins });
            }
        }
    }

    if (assignedItems.length > 0 || phantomSegmentItems.length > 0) {
        const queue = document.createElement('div');
        queue.className = 'segment-queue';

        let totalEstMins = 0;

        // ── Phantom segment-based lead time items (rendered first) ──
        for (const phantom of phantomSegmentItems) {
            totalEstMins += phantom._phantomDur;
            const row = document.createElement('div');
            row.className = 'segment-queue-item segment-queue-phantom';
            row.dataset.itemId = phantom.id;

            const bullet = document.createElement('span');
            bullet.className = 'segment-queue-bullet';
            bullet.textContent = '⏳';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'segment-queue-name';
            nameSpan.textContent = phantom.name;

            const est = document.createElement('span');
            est.className = 'segment-queue-est';
            est.textContent = `~${phantom._phantomDur}m`;

            row.appendChild(bullet);
            row.appendChild(nameSpan);
            row.appendChild(est);
            queue.appendChild(row);
        }

        // ── Regular assigned items ──
        for (const action of assignedItems) {
            const item = findItemById(action.id);
            // Find the item's actual stored segment context matching this block
            const itemSegCtx = item?.timeContexts?.find(tc => {
                if (tc === segCtx) return true;
                const p = parseTimeContext(tc);
                if (!p || !p.segment || p.date !== dateKey) return false;
                const [sh, sm] = p.segment.start.split(':').map(Number);
                const [eh, em] = p.segment.end.split(':').map(Number);
                const refDate = new Date(startMs);
                const tcS = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), sh, sm).getTime();
                let tcE = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), eh, em).getTime();
                // Cross-midnight: if end time is before start time, end is next calendar day
                if (tcE <= tcS) tcE += 24 * 60 * 60 * 1000;
                return Math.min(endMs, tcE) > Math.max(startMs, tcS);
            }) || segCtx;
            // Read segment-specific duration using the item's stored key
            const segDur = item?.contextDurations?.[itemSegCtx];
            const estMins = segDur != null ? segDur : (item?.estimatedDuration || 0);
            if (!item?.done) totalEstMins += estMins;

            const row = document.createElement('div');
            row.className = 'segment-queue-item' + (item?.done ? ' segment-item-done' : '');
            row.draggable = true;
            row.dataset.itemId = action.id;

            // Drag-out: allow dragging back to Actions
            row.addEventListener('dragstart', (e) => {
                console.log('[SEG-DRAG] dragstart fired for item:', action.id, action.name);
                e.stopPropagation();
                e.dataTransfer.setData('application/x-segment-item-id', String(action.id));
                console.log('[SEG-DRAG] context set:', itemSegCtx);
                e.dataTransfer.setData('application/x-segment-context', itemSegCtx);
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('segment-item-dragging');
                document.body.classList.add('dragging-to-timeline');
            });
            row.addEventListener('dragend', () => {
                console.log('[SEG-DRAG] dragend fired');
                row.classList.remove('segment-item-dragging');
                document.body.classList.remove('dragging-to-timeline');
            });

            const bullet = document.createElement('span');
            bullet.className = 'segment-queue-bullet';
            bullet.textContent = item?.done ? '✓' : '○';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'segment-queue-name';
            nameSpan.textContent = action.name;

            // Clickable est badge with inline edit
            const est = document.createElement('span');
            est.className = 'segment-queue-est';
            est.textContent = estMins ? `~${estMins}m` : '⏱';
            est.title = 'Click to set duration for this assignment';
            est.addEventListener('click', (ev) => {
                ev.stopPropagation();
                // Remove any existing popover
                document.querySelectorAll('.segment-duration-popover').forEach(p => p.remove());
                const pop = document.createElement('div');
                pop.className = 'segment-duration-popover';
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'segment-duration-input';
                input.min = '0';
                input.max = '480';
                input.value = estMins || '';
                input.placeholder = 'min';
                const saveBtn = document.createElement('button');
                saveBtn.className = 'segment-duration-save';
                saveBtn.textContent = '✓';
                saveBtn.addEventListener('click', async (se) => {
                    se.stopPropagation();
                    const mins = parseInt(input.value, 10) || 0;
                    if (!item.contextDurations) item.contextDurations = {};
                    item.contextDurations[itemSegCtx] = mins;
                    await api.patch(`/items/${action.id}`, { contextDurations: item.contextDurations });
                    pop.remove();
                    renderAll();
                });
                pop.appendChild(input);
                pop.appendChild(saveBtn);
                row.appendChild(pop);
                input.focus();
                input.select();
                // Close on outside click
                const closeHandler = (ce) => {
                    if (!pop.contains(ce.target)) {
                        pop.remove();
                        document.removeEventListener('click', closeHandler, true);
                    }
                };
                setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
                // Submit on Enter
                input.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') saveBtn.click();
                    if (ke.key === 'Escape') pop.remove();
                });
            });

            // Start button (promotion)
            const startBtn = document.createElement('button');
            startBtn.className = 'segment-queue-start';
            startBtn.textContent = '▶';
            startBtn.title = 'Start working on this';
            startBtn.draggable = false;
            startBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const now = Date.now();
                const durMins = estMins || 30;
                const targetEnd = now + durMins * 60000;

                // Build project name from ancestors
                const ancestors = action._path
                    ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';

                // Remove segment context before starting
                if (item && item.timeContexts) {
                    const matchingCtx = item.timeContexts.find(tc => {
                        const p = parseTimeContext(tc);
                        return p && p.segment;
                    });
                    if (matchingCtx) {
                        item.timeContexts = item.timeContexts.filter(tc => tc !== matchingCtx);
                        const patch = { timeContexts: item.timeContexts };
                        if (item.contextDurations) {
                            delete item.contextDurations[matchingCtx];
                            patch.contextDurations = item.contextDurations;
                        }
                        await api.patch(`/items/${action.id}`, patch);
                    }
                }

                // Use the proper startWorking flow
                await startWorking(action.id, action.name, ancestors || null, targetEnd);
            });

            // Locate-in-sidebar icon
            const locateBtn = document.createElement('span');
            locateBtn.className = 'action-locate-btn';
            locateBtn.textContent = '◉';
            locateBtn.title = 'Locate in projects';
            locateBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                state.selectedItemId = action.id;
                savePref('selectedItemId', action.id);
                renderAll();
                requestAnimationFrame(() => scrollToSelectedItem());
            });

            row.appendChild(bullet);
            row.appendChild(locateBtn);
            row.appendChild(nameSpan);
            row.appendChild(est);
            row.appendChild(startBtn);
            queue.appendChild(row);
        }

        el.appendChild(queue);

        // Capacity bar
        const availMins = Math.floor(durationMs / 60000);
        if (totalEstMins > 0) {
            const capBar = document.createElement('div');
            capBar.className = 'segment-capacity-bar';
            const fillPct = Math.min(100, (totalEstMins / availMins) * 100);
            const isOver = totalEstMins > availMins;
            capBar.innerHTML = `
                <span class="segment-capacity-label">${totalEstMins}m / ${availMins}m</span>
                <div class="segment-capacity-track"><div class="segment-capacity-fill${isOver ? ' over-capacity' : ''}" style="width:${fillPct}%"></div></div>
            `;
            el.appendChild(capBar);
        }
    }

    return el;
}

// ── Plan Next: inline editor ──

function openPlanEditor(freeBlock, freeStartMs, freeEndMs, preselectedAction = null, parentEntryId = null, scopeItemId = null, initialMode = 'plan') {
    // Close any existing editor
    document.querySelectorAll('.plan-editor').forEach(ed => ed.remove());

    const DEFAULT_DURATION = 30 * 60 * 1000;
    const itemData = preselectedAction ? findItemById(preselectedAction.id) : null;
    const ctxDur = getContextDuration(itemData);
    const estimatedMs = ctxDur ? ctxDur * 60000 : DEFAULT_DURATION;
    const availableMs = freeEndMs - freeStartMs;
    let planStartMs = freeStartMs;
    let planEndMs = freeStartMs + Math.min(estimatedMs, availableMs);


    // Helper: ms timestamp → "HH:MM" string
    const msToTimeStr = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    // Helper: "HH:MM" string → ms timestamp (same day as planStartMs)
    // Cross-date: if parsed time < start time, treat as next day
    const timeStrToMs = (str, referenceMs) => {
        const ref = referenceMs || planStartMs;
        const [h, m] = str.split(':').map(Number);
        const d = new Date(ref);
        d.setHours(h, m, 0, 0);
        // If the result is before the reference, wrap to next day
        if (d.getTime() < ref) d.setDate(d.getDate() + 1);
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

    // ── Mode toggle: Plan (📌) vs Intend (📋) ──
    let editorMode = initialMode; // 'plan' | 'intend'

    // Single-icon toggle with tooltip
    const toggleWrap = document.createElement('div');
    toggleWrap.className = 'plan-editor-mode-toggle';
    toggleWrap.title = 'Switch to Intend mode';

    const activeIcon = document.createElement('span');
    activeIcon.className = 'plan-editor-toggle-icon';
    activeIcon.textContent = initialMode === 'intend' ? '📋' : '📌';

    toggleWrap.appendChild(activeIcon);

    const icon = toggleWrap; // alias for editor.appendChild later

    const setEditorMode = (mode) => {
        editorMode = mode;
        // Morph animation
        activeIcon.classList.add('plan-editor-toggle-morphing');
        setTimeout(() => {
            activeIcon.textContent = mode === 'plan' ? '📌' : '📋';
            toggleWrap.title = mode === 'plan' ? 'Switch to Intend mode' : 'Switch to Plan mode';
            activeIcon.classList.remove('plan-editor-toggle-morphing');
        }, 120);

        if (mode === 'intend') {
            editor.classList.add('plan-editor-intend-mode');
            timeRow.style.display = 'none';
            intentDurationRow.style.display = '';
            saveBtn.textContent = '📋 Intend';
            actionInput.placeholder = 'Search for an action…';
        } else {
            editor.classList.remove('plan-editor-intend-mode');
            timeRow.style.display = '';
            intentDurationRow.style.display = 'none';
            saveBtn.textContent = '📌 Plan';
            actionInput.placeholder = 'Action or session title…';
        }
    };

    toggleWrap.addEventListener('click', () => {
        setEditorMode(editorMode === 'plan' ? 'intend' : 'plan');
    });

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
    actionInput.placeholder = initialMode === 'intend' ? 'Search for an item…' : 'Action or session title…';

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

    // Intend mode: optional duration row (shown only in intend mode)
    const intentDurationRow = document.createElement('div');
    intentDurationRow.className = 'plan-editor-row plan-editor-intent-duration-row';
    intentDurationRow.style.display = 'none'; // hidden by default (plan mode)

    const intentDurLabel = document.createElement('span');
    intentDurLabel.className = 'plan-editor-duration-label';
    intentDurLabel.textContent = 'Est. duration';
    intentDurLabel.style.marginRight = 'auto';

    const intentDurInput = document.createElement('input');
    intentDurInput.type = 'number';
    intentDurInput.className = 'plan-editor-duration-input';
    intentDurInput.min = '0';
    intentDurInput.placeholder = '—';
    intentDurInput.title = 'Estimated duration (minutes, optional)';

    const intentDurUnit = document.createElement('span');
    intentDurUnit.className = 'plan-editor-duration-label';
    intentDurUnit.textContent = 'min';

    intentDurationRow.appendChild(intentDurLabel);
    intentDurationRow.appendChild(intentDurInput);
    intentDurationRow.appendChild(intentDurUnit);

    // Row 3: Action buttons
    const actionsRow = document.createElement('div');
    actionsRow.className = 'plan-editor-row plan-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'plan-editor-save';
    saveBtn.textContent = '📌 Plan';

    const discardBtn = document.createElement('button');
    discardBtn.className = 'plan-editor-discard';
    discardBtn.textContent = 'Discard';

    actionsRow.appendChild(discardBtn);
    actionsRow.appendChild(saveBtn);

    content.appendChild(actionRow);
    content.appendChild(timeRow);
    content.appendChild(intentDurationRow);
    content.appendChild(actionsRow);

    editor.appendChild(icon);
    editor.appendChild(content);

    // ── Insert editor after the free time block ──
    freeBlock.after(editor);

    // Apply initial mode visuals (needed when initialMode !== 'plan')
    if (initialMode !== 'plan') {
        setEditorMode(initialMode);
    }

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
    const autocomplete = setupAutocomplete(actionInput, suggestions, { scopeItemId, allowFreeText: true });
    if (preselectedAction) {
        autocomplete.setSelected(preselectedAction);
    }

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
        const currentDuration = planEndMs - planStartMs;
        const result = parseTimeInput(startInput, planStartMs, (t) => t >= freeStartMs);
        if (result !== planStartMs) {
            planStartMs = result;
            // Preserve duration: shift end time to match
            const newEnd = planStartMs + currentDuration;
            planEndMs = Math.min(newEnd, freeEndMs);
            endInput.value = msToTimeStr(planEndMs);
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
        const selectedAction = autocomplete.getSelected();
        const customTitle = actionInput.value.trim();

        // ── Intend mode: link item to time context ──
        if (editorMode === 'intend') {
            if (!selectedAction) {
                actionInput.focus();
                actionInput.classList.add('plan-editor-input-error');
                setTimeout(() => actionInput.classList.remove('plan-editor-input-error'), 600);
                return;
            }
            const dateKey = getDateKey(state.timelineViewDate);
            // Build the context string: segment context for free time, or @entry: for planned sessions
            let ctxStr;
            if (parentEntryId) {
                ctxStr = `${dateKey}@entry:${parentEntryId}`;
            } else {
                ctxStr = buildSegmentContext(dateKey, freeStartMs, freeEndMs);
            }
            // Get optional duration from intend-mode duration input
            const intentDurMins = parseInt(intentDurInput.value, 10);
            const seedDur = intentDurMins > 0 ? intentDurMins : undefined;
            await addSegmentContext(selectedAction.id, ctxStr, seedDur);
            editor.remove();
            return;
        }

        // ── Plan mode: create timeline entry (existing behavior) ──
        if (!selectedAction) {
            if (!customTitle) {
                actionInput.focus();
                actionInput.classList.add('plan-editor-input-error');
                setTimeout(() => actionInput.classList.remove('plan-editor-input-error'), 600);
                return;
            }
            // Container session: planned entry with no itemId
            const entry = await api.post('/timeline', {
                text: customTitle,
                projectName: null,
                type: 'planned',
                startTime: planStartMs,
                endTime: planEndMs,
                itemId: null,
            });
            state.timeline.entries.push(entry);

            renderTimeline();
            renderActions();
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

        // Write back duration to item context estimate (learn from scheduling)
        const durationMins = Math.round((planEndMs - planStartMs) / 60000);
        const existingItem = findItemById(selectedAction.id);
        if (existingItem) {
            const ctx = getCurrentViewContext();
            if (!existingItem.contextDurations) existingItem.contextDurations = {};
            if (!(ctx in existingItem.contextDurations)) {
                existingItem.contextDurations[ctx] = durationMins;
                await api.patch(`/items/${selectedAction.id}`, { contextDurations: existingItem.contextDurations });
            }
        }

        // Link to parent session if creating inside one, otherwise link to own entry
        const linkEntryId = parentEntryId || entry.id;
        const dateKey = getDateKey(state.timelineViewDate);
        await addSegmentContext(selectedAction.id, `${dateKey}@entry:${linkEntryId}`);

        renderTimeline();
        renderActions();
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
    breakBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await startBreak();
    });
    // Right-click: open duration picker for timed break
    breakBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showBreakDurationPicker(breakBtn);
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


    const msToTimeStr = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const timeStrToMs = (str, referenceMs) => {
        const ref = referenceMs || planStartMs;
        const [h, m] = str.split(':').map(Number);
        const d = new Date(ref);
        d.setHours(h, m, 0, 0);
        if (d.getTime() < ref) d.setDate(d.getDate() + 1);
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
    const autocomplete = setupAutocomplete(actionInput, suggestions);

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
        const currentDuration = planEndMs - planStartMs;
        const result = parseTimeInput(startInput, planStartMs, (t) => t >= idleStartMs);
        if (result !== planStartMs) {
            planStartMs = result;
            // Preserve duration: shift end time to match
            const newEnd = planStartMs + currentDuration;
            planEndMs = Math.min(newEnd, idleEndMs);
            endInput.value = msToTimeStr(planEndMs);
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
        const selectedAction = autocomplete.getSelected();
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

// ── Shared helper: find deadline for stopwatch-style sessions (no target end) ──
// Returns the earliest of: next scheduled plan start or day end
function _getStopwatchDeadline() {
    const { dayEnd } = getDayBoundaries(state.timelineViewDate);
    const nowMs = Date.now();
    const dayEndMs = dayEnd.getTime();
    // Find the next planned entry that starts after now
    let nextPlanStart = dayEndMs;
    for (const entry of state.timeline.entries) {
        if (entry.type === 'planned' && entry.endTime && entry.timestamp > nowMs) {
            if (entry.timestamp < nextPlanStart) {
                nextPlanStart = entry.timestamp;
            }
        }
    }
    return Math.min(nextPlanStart, dayEndMs);
}

// ── Shared helper: attach drag-and-drop target + nested items queue to a block ──
function _attachEntryDropAndQueue(el, contextStr, deadlineMs) {
    if (!contextStr) return;

    // ── Drop target ──
    const _acceptsDrag = (e) =>
        e.dataTransfer.types.includes('application/x-action-id') ||
        e.dataTransfer.types.includes('application/x-segment-item-id');

    el.addEventListener('dragover', (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('time-block-drag-over');
    });
    el.addEventListener('dragenter', (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        el.classList.add('time-block-drag-over');
    });
    el.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        el.classList.remove('time-block-drag-over');
    });
    el.addEventListener('drop', (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        el.classList.remove('time-block-drag-over');

        // Cross-block drag: segment/entry item moving between blocks
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const oldCtx = e.dataTransfer.getData('application/x-segment-context');
            if (itemId && oldCtx && oldCtx !== contextStr) {
                (async () => {
                    await degradeSegmentContext(itemId, oldCtx);
                    await addSegmentContext(Number(itemId), contextStr);
                })();
            }
            return;
        }

        // Normal drag from Actions panel
        const action = window._draggedAction;
        if (!action) return;
        window._draggedAction = null;
        addSegmentContext(action.id, contextStr);
    });

    // ── Nested entry-assigned items ──
    const allItems = collectAllItems();
    const assignedItems = allItems.filter(a => {
        const item = findItemById(a.id);
        if (!item || !item.timeContexts) return false;
        if (item.done && !state.showDone) return false;
        return item.timeContexts.includes(contextStr);
    });

    if (assignedItems.length > 0) {
        const queue = document.createElement('div');
        queue.className = 'segment-queue';

        let totalEstMins = 0;
        for (const action of assignedItems) {
            const item = findItemById(action.id);
            const segDur = item?.contextDurations?.[contextStr];
            const estMins = segDur != null ? segDur : (item?.estimatedDuration || 0);
            if (!item?.done) totalEstMins += estMins;

            const row = document.createElement('div');
            row.className = 'segment-queue-item' + (item?.done ? ' segment-item-done' : '');
            row.draggable = true;
            row.dataset.itemId = action.id;

            row.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-segment-item-id', String(action.id));
                e.dataTransfer.setData('application/x-segment-context', contextStr);
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('segment-item-dragging');
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('segment-item-dragging');
            });

            const bullet = document.createElement('span');
            bullet.className = 'segment-queue-bullet';
            bullet.textContent = item?.done ? '✓' : '○';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'segment-queue-name';
            nameSpan.textContent = action.name;

            const est = document.createElement('span');
            est.className = 'segment-queue-est';
            est.textContent = estMins ? `~${estMins}m` : '⏱';
            est.title = 'Click to set duration for this assignment';
            est.addEventListener('click', (ev) => {
                ev.stopPropagation();
                document.querySelectorAll('.segment-duration-popover').forEach(p => p.remove());
                const pop = document.createElement('div');
                pop.className = 'segment-duration-popover';
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'segment-duration-input';
                input.min = '0';
                input.max = '480';
                input.value = estMins || '';
                input.placeholder = 'min';
                const saveBtn = document.createElement('button');
                saveBtn.className = 'segment-duration-save';
                saveBtn.textContent = '✓';
                saveBtn.addEventListener('click', async (se) => {
                    se.stopPropagation();
                    const mins = parseInt(input.value, 10) || 0;
                    if (!item.contextDurations) item.contextDurations = {};
                    item.contextDurations[contextStr] = mins;
                    await api.patch(`/items/${action.id}`, { contextDurations: item.contextDurations });
                    pop.remove();
                    renderAll();
                });
                pop.appendChild(input);
                pop.appendChild(saveBtn);
                row.appendChild(pop);
                input.focus();
                input.select();
                const closeHandler = (ce) => {
                    if (!pop.contains(ce.target)) {
                        pop.remove();
                        document.removeEventListener('click', closeHandler, true);
                    }
                };
                setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
                input.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') saveBtn.click();
                    if (ke.key === 'Escape') pop.remove();
                });
            });

            const startBtn2 = document.createElement('button');
            startBtn2.className = 'segment-queue-start';
            startBtn2.textContent = '▶';
            startBtn2.title = 'Start working on this';
            startBtn2.draggable = false;
            startBtn2.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const now = Date.now();
                const durMins = estMins || 30;
                const targetEnd = now + durMins * 60000;
                const ancestors = action._path
                    ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';
                await startWorking(action.id, action.name, ancestors || null, targetEnd);
            });

            // Locate-in-sidebar icon
            const locateBtn2 = document.createElement('span');
            locateBtn2.className = 'action-locate-btn';
            locateBtn2.textContent = '◉';
            locateBtn2.title = 'Locate in projects';
            locateBtn2.addEventListener('click', (e) => {
                e.stopPropagation();
                state.selectedItemId = action.id;
                savePref('selectedItemId', action.id);
                renderAll();
                requestAnimationFrame(() => scrollToSelectedItem());
            });

            row.appendChild(bullet);
            row.appendChild(locateBtn2);
            row.appendChild(nameSpan);
            row.appendChild(est);
            row.appendChild(startBtn2);
            queue.appendChild(row);
        }

        el.appendChild(queue);

        // Capacity bar — uses remaining time (deadline - now) as available capacity
        const nowCap = Date.now();
        const remainingMs = Math.max(0, deadlineMs - nowCap);
        const availMins = Math.max(1, Math.floor(remainingMs / 60000));
        if (totalEstMins > 0) {
            const capBar = document.createElement('div');
            capBar.className = 'segment-capacity-bar';
            capBar.dataset.capDeadline = deadlineMs;
            capBar.dataset.capTotalEst = totalEstMins;
            const fillPct = Math.min(100, (totalEstMins / availMins) * 100);
            const isOver = totalEstMins > availMins;
            capBar.innerHTML = `
                <span class="segment-capacity-label">${totalEstMins}m / ${availMins}m</span>
                <div class="segment-capacity-track"><div class="segment-capacity-fill${isOver ? ' over-capacity' : ''}" style="width:${fillPct}%"></div></div>
            `;
            el.appendChild(capBar);
        }
    }
}

function createWorkingTimeBlock(startMs, endMs) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-working focusable-block';
    el.dataset.startTime = startMs;
    el.dataset.endTime = endMs;
    el.style.cursor = 'pointer';
    const itemName = state.workingOn ? state.workingOn.itemName : 'Working';
    el.addEventListener('click', () => toggleSessionFocus({
        startMs, endMs, label: itemName, type: 'working', icon: '⚡',
        projectName: state.workingOn ? state.workingOn.projectName : null,
        itemId: state.workingOn ? state.workingOn.itemId : null,
        targetEndTime: targetEnd,
        liveType: 'work',
    }));

    const targetEnd = state.workingOn ? state.workingOn.targetEndTime : null;
    if (targetEnd) el.dataset.targetEndTime = targetEnd;

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
    const workItemName = state.workingOn ? state.workingOn.itemName : 'Working';
    label.textContent = workItemName;

    // Locate-in-sidebar icon for item-linked work sessions
    if (state.workingOn && state.workingOn.itemId) {
        label.classList.add('action-name-row');
        const labelText = document.createElement('span');
        labelText.textContent = workItemName;
        label.textContent = '';
        const locateBtn = document.createElement('span');
        locateBtn.className = 'action-locate-btn';
        locateBtn.textContent = '◉';
        locateBtn.title = 'Locate in projects';
        locateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.selectedItemId = state.workingOn.itemId;
            savePref('selectedItemId', state.workingOn.itemId);
            renderAll();
            requestAnimationFrame(() => scrollToSelectedItem());
        });
        label.appendChild(locateBtn);
        label.appendChild(labelText);
    }

    const time = document.createElement('div');
    time.className = 'time-block-time working-time-range';
    if (targetEnd) {
        time.textContent = `${formatTime(startMs)} – ${formatTime(targetEnd)}`;
    } else {
        time.textContent = `${formatTime(startMs)} – ${formatTime(endMs)}`;
    }

    // Duration / countdown display
    const status = document.createElement('div');
    status.className = 'time-block-status working-duration';
    if (targetEnd) {
        const remainMs = targetEnd - endMs;
        if (remainMs > 0) {
            // Counting down
            const rMins = Math.floor(remainMs / 60000);
            const rSecs = Math.floor((remainMs % 60000) / 1000);
            status.textContent = rMins > 0 ? `${rMins}m ${rSecs}s left` : `${rSecs}s left`;
        } else {
            // Overtime
            const overMs = Math.abs(remainMs);
            const oMins = Math.floor(overMs / 60000);
            const oSecs = Math.floor((overMs % 60000) / 1000);
            status.textContent = oMins > 0 ? `+${oMins}m ${oSecs}s over` : `+${oSecs}s over`;
            status.classList.add('working-overtime');
            el.classList.add('time-block-overtime');
        }
    } else {
        if (hrs > 0) {
            status.textContent = `${hrs}h ${mins}m`;
        } else if (mins > 0) {
            status.textContent = `${mins}m ${secs}s`;
        } else {
            status.textContent = `${secs}s`;
        }
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

    // Drag-and-drop + nested items — use remaining time as capacity
    const workDeadline = targetEnd || _getStopwatchDeadline();
    _attachEntryDropAndQueue(el, getLiveContext('work'), workDeadline);

    return el;
}
function createBreakTimeBlock(startMs, endMs) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-break focusable-block';
    el.dataset.startTime = startMs;
    el.dataset.endTime = endMs;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => toggleSessionFocus({
        startMs, endMs, label: 'Break', type: 'break', icon: '☕',
        targetEndTime: targetEnd,
        liveType: 'break',
    }));

    const targetEnd = state.onBreak ? state.onBreak.targetEndTime : null;
    if (targetEnd) el.dataset.targetEndTime = targetEnd;

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
    if (targetEnd) {
        time.textContent = `${formatTime(startMs)} – ${formatTime(targetEnd)}`;
    } else {
        time.textContent = `${formatTime(startMs)} – ${formatTime(endMs)}`;
    }

    // Duration / countdown display
    const status = document.createElement('div');
    status.className = 'time-block-status break-duration';
    if (targetEnd) {
        const remainMs = targetEnd - endMs;
        if (remainMs > 0) {
            const rMins = Math.floor(remainMs / 60000);
            const rSecs = Math.floor((remainMs % 60000) / 1000);
            status.textContent = rMins > 0 ? `${rMins}m ${rSecs}s left` : `${rSecs}s left`;
        } else {
            const overMs = Math.abs(remainMs);
            const oMins = Math.floor(overMs / 60000);
            const oSecs = Math.floor((overMs % 60000) / 1000);
            status.textContent = oMins > 0 ? `+${oMins}m ${oSecs}s over` : `+${oSecs}s over`;
            status.classList.add('break-overtime');
            el.classList.add('time-block-break-overtime');
        }
    } else {
        if (hrs > 0) {
            status.textContent = `${hrs}h ${mins}m`;
        } else if (mins > 0) {
            status.textContent = `${mins}m ${secs}s`;
        } else {
            status.textContent = `${secs}s`;
        }
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

    // Drag-and-drop + nested items — use remaining time as capacity
    const breakDeadline = targetEnd || _getStopwatchDeadline();
    _attachEntryDropAndQueue(el, getLiveContext('break'), breakDeadline);

    return el;
}

// ── Idle/Working block real-time updater ──
let idleUpdateInterval = null;

function startIdleUpdater() {
    if (idleUpdateInterval) clearInterval(idleUpdateInterval);
    idleUpdateInterval = setInterval(() => {
        // ── Update session header timer (if focused) ──
        const sessionTimer = document.querySelector('.session-timer');
        if (sessionTimer) {
            const sStart = parseInt(sessionTimer.dataset.sessionStart, 10);
            const sTarget = sessionTimer.dataset.targetEnd ? parseInt(sessionTimer.dataset.targetEnd, 10) : null;
            const sNow = Date.now();
            const _fmt = (ms) => {
                const h = Math.floor(ms / 3600000);
                const m = Math.floor((ms % 3600000) / 60000);
                const s = Math.floor((ms % 60000) / 1000);
                if (h > 0) return `${h}h ${m}m ${s}s`;
                if (m > 0) return `${m}m ${s}s`;
                return `${s}s`;
            };
            if (sTarget) {
                const rem = sTarget - sNow;
                if (rem > 0) {
                    sessionTimer.textContent = _fmt(rem) + ' left';
                    sessionTimer.classList.remove('session-timer-overtime');
                    sessionTimer.classList.add('session-timer-remaining');
                } else {
                    sessionTimer.textContent = '+' + _fmt(Math.abs(rem)) + ' over';
                    sessionTimer.classList.remove('session-timer-remaining');
                    sessionTimer.classList.add('session-timer-overtime');
                }
                // Also update progress bar
                const progressFill = document.querySelector('.time-context-progress-fill');
                const progressLabel = document.querySelector('.time-context-progress-label');
                if (progressFill && progressLabel) {
                    const total = sTarget - sStart;
                    const elapsed = sNow - sStart;
                    const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
                    progressFill.style.width = `${Math.min(pct, 100)}%`;
                    if (pct >= 100) progressFill.classList.add('over');
                    progressLabel.textContent = `${Math.round(pct)}%`;
                }
            } else {
                sessionTimer.textContent = _fmt(sNow - sStart);
            }
        }

        // ── Update live session indicator timer ──
        const indicatorTimer = document.querySelector('.live-session-indicator-timer');
        if (indicatorTimer) {
            const iStart = parseInt(indicatorTimer.dataset.sessionStart, 10);
            const iTarget = indicatorTimer.dataset.targetEnd ? parseInt(indicatorTimer.dataset.targetEnd, 10) : null;
            const iNow = Date.now();
            const _fmtI = (ms) => {
                const h = Math.floor(ms / 3600000);
                const m = Math.floor((ms % 3600000) / 60000);
                const s = Math.floor((ms % 60000) / 1000);
                if (h > 0) return `${h}h ${m}m ${s}s`;
                if (m > 0) return `${m}m ${s}s`;
                return `${s}s`;
            };
            if (iTarget) {
                const rem = iTarget - iNow;
                if (rem > 0) {
                    indicatorTimer.textContent = _fmtI(rem) + ' left';
                    indicatorTimer.classList.remove('live-session-indicator-overtime');
                } else {
                    indicatorTimer.textContent = '+' + _fmtI(Math.abs(rem)) + ' over';
                    indicatorTimer.classList.add('live-session-indicator-overtime');
                }
            } else {
                indicatorTimer.textContent = _fmtI(iNow - iStart);
            }
        }

        // ── Update free time available duration (if focused) ──
        const freeAvail = document.querySelector('.session-avail-duration[data-end-ms]');
        if (freeAvail) {
            const endMs = parseInt(freeAvail.dataset.endMs, 10);
            const fNow = Date.now();
            const remaining = Math.max(0, endMs - fNow);
            const _fmtFree = (ms) => {
                const h = Math.floor(ms / 3600000);
                const m = Math.floor((ms % 3600000) / 60000);
                const s = Math.floor((ms % 60000) / 1000);
                if (h > 0) return `${h}h ${m}m`;
                if (m > 0) return `${m}m ${s}s`;
                return `${s}s`;
            };
            freeAvail.textContent = `⏱ ${_fmtFree(remaining)} available`;
        }

        // Update working block if present
        const workingBlock = document.querySelector('.time-block-working');
        if (workingBlock) {
            const startMs = parseInt(workingBlock.dataset.startTime, 10);
            const nowMs = Date.now();
            const durationMs = Math.max(0, nowMs - startMs);
            const targetEnd = workingBlock.dataset.targetEndTime ? parseInt(workingBlock.dataset.targetEndTime, 10) : null;

            const durationEl = workingBlock.querySelector('.working-duration');
            if (durationEl) {
                if (targetEnd) {
                    const remainMs = targetEnd - nowMs;
                    if (remainMs > 0) {
                        // Counting down
                        const rMins = Math.floor(remainMs / 60000);
                        const rSecs = Math.floor((remainMs % 60000) / 1000);
                        durationEl.textContent = rMins > 0 ? `${rMins}m ${rSecs}s left` : `${rSecs}s left`;
                        durationEl.classList.remove('working-overtime');
                        workingBlock.classList.remove('time-block-overtime');
                    } else {
                        // Overtime
                        const overMs = Math.abs(remainMs);
                        const oMins = Math.floor(overMs / 60000);
                        const oSecs = Math.floor((overMs % 60000) / 1000);
                        durationEl.textContent = oMins > 0 ? `+${oMins}m ${oSecs}s over` : `+${oSecs}s over`;
                        durationEl.classList.add('working-overtime');
                        workingBlock.classList.add('time-block-overtime');
                    }
                } else {
                    const hrs = Math.floor(durationMs / 3600000);
                    const mins = Math.floor((durationMs % 3600000) / 60000);
                    const secs = Math.floor((durationMs % 60000) / 1000);
                    if (hrs > 0) {
                        durationEl.textContent = `${hrs}h ${mins}m`;
                    } else if (mins > 0) {
                        durationEl.textContent = `${mins}m ${secs}s`;
                    } else {
                        durationEl.textContent = `${secs}s`;
                    }
                }
            }

            const timeEl = workingBlock.querySelector('.working-time-range');
            if (timeEl && !targetEnd) {
                timeEl.textContent = `${formatTime(startMs)} – ${formatTime(nowMs)}`;
            }

            // Push adjacent free time block (use projected end so free time starts after work)
            const workEffectiveEnd = targetEnd ? Math.max(nowMs, targetEnd) : nowMs;
            updateAdjacentFreeBlock(workingBlock, workEffectiveEnd);

            // Update capacity bar remaining time
            _updateLiveCapacityBar(workingBlock, targetEnd);
            return; // working block takes priority over idle
        }

        // Update break block if present
        const breakBlock = document.querySelector('.time-block-break');
        if (breakBlock) {
            const startMs = parseInt(breakBlock.dataset.startTime, 10);
            const nowMs = Date.now();
            const durationMs = Math.max(0, nowMs - startMs);
            const targetEnd = breakBlock.dataset.targetEndTime ? parseInt(breakBlock.dataset.targetEndTime, 10) : null;

            const durationEl = breakBlock.querySelector('.break-duration');
            if (durationEl) {
                if (targetEnd) {
                    const remainMs = targetEnd - nowMs;
                    if (remainMs > 0) {
                        const rMins = Math.floor(remainMs / 60000);
                        const rSecs = Math.floor((remainMs % 60000) / 1000);
                        durationEl.textContent = rMins > 0 ? `${rMins}m ${rSecs}s left` : `${rSecs}s left`;
                        durationEl.classList.remove('break-overtime');
                        breakBlock.classList.remove('time-block-break-overtime');
                    } else {
                        const overMs = Math.abs(remainMs);
                        const oMins = Math.floor(overMs / 60000);
                        const oSecs = Math.floor((overMs % 60000) / 1000);
                        durationEl.textContent = oMins > 0 ? `+${oMins}m ${oSecs}s over` : `+${oSecs}s over`;
                        durationEl.classList.add('break-overtime');
                        breakBlock.classList.add('time-block-break-overtime');
                    }
                } else {
                    const hrs = Math.floor(durationMs / 3600000);
                    const mins = Math.floor((durationMs % 3600000) / 60000);
                    const secs = Math.floor((durationMs % 60000) / 1000);
                    if (hrs > 0) {
                        durationEl.textContent = `${hrs}h ${mins}m`;
                    } else if (mins > 0) {
                        durationEl.textContent = `${mins}m ${secs}s`;
                    } else {
                        durationEl.textContent = `${secs}s`;
                    }
                }
            }

            const timeEl = breakBlock.querySelector('.break-time-range');
            if (timeEl && !targetEnd) {
                timeEl.textContent = `${formatTime(startMs)} – ${formatTime(nowMs)}`;
            }

            // Push adjacent free time block (use projected end so free time starts after break)
            const breakEffectiveEnd = targetEnd ? Math.max(nowMs, targetEnd) : nowMs;
            updateAdjacentFreeBlock(breakBlock, breakEffectiveEnd);

            // Update capacity bar remaining time
            _updateLiveCapacityBar(breakBlock, targetEnd);
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

// ── Helper: dynamically update capacity bar in a live block ──
function _updateLiveCapacityBar(blockEl, targetEnd) {
    const capBar = blockEl.querySelector('.segment-capacity-bar[data-cap-deadline]');
    if (!capBar) return;
    const totalEst = parseInt(capBar.dataset.capTotalEst, 10);
    if (!totalEst) return;
    // Recompute deadline for stopwatch sessions (it can shift as time passes)
    const deadline = targetEnd || _getStopwatchDeadline();
    capBar.dataset.capDeadline = deadline;
    const nowMs = Date.now();
    const remainingMs = Math.max(0, deadline - nowMs);
    const availMins = Math.max(1, Math.floor(remainingMs / 60000));
    const fillPct = Math.min(100, (totalEst / availMins) * 100);
    const isOver = totalEst > availMins;
    const fill = capBar.querySelector('.segment-capacity-fill');
    const label = capBar.querySelector('.segment-capacity-label');
    if (fill) {
        fill.style.width = `${fillPct}%`;
        fill.classList.toggle('over-capacity', isOver);
    }
    if (label) {
        label.textContent = `${totalEst}m / ${availMins}m`;
    }
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

// ── Smart Merge Phase 2: group past blocks by project tree, absorb completions ──
function mergePastEntries(entries, moments) {
    if (entries.length === 0) return { items: [], absorbedMomentIds: new Set() };

    // Helper: extract root project from projectName like "anything › core" → "anything"
    // When projectName is empty, the item IS the root project — derive from its label text
    const getRootProject = (e) => {
        const pn = e.projectName || '';
        if (pn) return pn.split(' › ')[0].trim().toUpperCase();
        // No projectName → the item is a root project; use its label as root
        let label = (e.text || '').trim();
        if (label.startsWith('Worked on: ')) label = label.slice(11);
        label = label.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');
        return label.toUpperCase();
    };

    // Helper: normalize label for same-entry merging
    const normalizeLabel = (e) => {
        let t = (e.text || e.type || '').trim();
        if (t.startsWith('Worked on: ')) t = t.slice(11);
        if (t.startsWith('Done: ')) t = t.slice(6);
        t = t.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');
        return t.toUpperCase();
    };

    // Step 1: Absorb completion moments into work blocks (only if same root project)
    const completionMoments = (moments || []).filter(m => m.type === 'completion');
    const entryCompletions = new Map(); // blockIndex → [...completions]
    for (const cm of completionMoments) {
        const cmRoot = getRootProject(cm);
        // Find the enclosing or nearest-preceding work block with matching root project
        let bestIdx = -1;
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e.type !== 'work') continue;
            // Must share the same root project
            if (cmRoot && getRootProject(e) !== cmRoot) continue;
            // Completion falls within or at the end of this work block
            if (cm.timestamp >= e.timestamp && cm.timestamp <= (e.endTime || e.timestamp) + 60000) {
                bestIdx = i;
                break;
            }
            // Completion after this block — keep as candidate (nearest preceding)
            if (cm.timestamp > (e.endTime || e.timestamp)) {
                bestIdx = i;
            }
        }
        if (bestIdx >= 0) {
            if (!entryCompletions.has(bestIdx)) entryCompletions.set(bestIdx, []);
            entryCompletions.get(bestIdx).push(cm);
        }
    }

    // Step 2: Attach completions and mark absorbed moment IDs
    const absorbedMomentIds = new Set();
    for (let i = 0; i < entries.length; i++) {
        if (entryCompletions.has(i)) {
            entries[i] = { ...entries[i], _completions: entryCompletions.get(i) };
            for (const c of entryCompletions.get(i)) absorbedMomentIds.add(c.id);
        }
    }

    // Step 3: Group entries into project groups and standalone blocks
    const result = [];
    let currentGroup = null;

    const flushGroup = () => {
        if (!currentGroup) return;
        // Count unique task labels (same logic as renderer dedup)
        const seen = new Set();
        for (const e of currentGroup.entries) {
            seen.add(normalizeLabel(e));
            if (e._completions) {
                for (const c of e._completions) seen.add(normalizeLabel(c));
            }
        }
        if (seen.size < 2) {
            // Only 1 unique task → render as standalone compact row, not a group
            result.push(currentGroup.entries[0]);
        } else {
            result.push(currentGroup);
        }
        currentGroup = null;
    };

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        // Non-work entries (break, idle) → flush current group, merge with previous if same type
        if (entry.type !== 'work' && entry.type !== 'planned') {
            flushGroup();
            // Merge consecutive same-type entries (e.g. two adjacent breaks)
            const prev = result.length > 0 ? result[result.length - 1] : null;
            if (prev && !prev._isProjectGroup && prev.type === entry.type) {
                const gap = entry.timestamp - (prev.endTime || prev.timestamp);
                if (gap <= 2 * 60 * 1000) {
                    result[result.length - 1] = {
                        ...prev,
                        endTime: Math.max(prev.endTime || prev.timestamp, entry.endTime || entry.timestamp),
                        _mergedCount: (prev._mergedCount || 1) + 1,
                    };
                    continue;
                }
            }
            result.push(entry);
            continue;
        }

        const root = getRootProject(entry);
        const gap = currentGroup
            ? entry.timestamp - currentGroup.endTime
            : 0;

        // Same root project and gap ≤ 15 min → extend group
        if (currentGroup && root === currentGroup.rootProject && gap <= 15 * 60 * 1000) {
            currentGroup.entries.push(entry);
            currentGroup.endTime = Math.max(currentGroup.endTime, entry.endTime || entry.timestamp);
        } else {
            // Flush previous group, start new one
            flushGroup();
            currentGroup = {
                _isProjectGroup: true,
                rootProject: root,
                rootProjectDisplay: (entry.projectName || '').split(' › ')[0].trim()
                    || ((entry.text || '').startsWith('Worked on: ')
                        ? (entry.text || '').slice(11).replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '')
                        : (entry.text || '')),
                entries: [entry],
                timestamp: entry.timestamp,
                endTime: entry.endTime || entry.timestamp,
            };
        }
    }
    flushGroup();

    return { items: result, absorbedMomentIds };
}

// ── Compact Project Group: collapsible project header with sub-rows ──
function createCompactProjectGroup(group) {
    const el = document.createElement('div');
    el.className = 'compact-past-entry compact-past-work compact-project-group';
    el.dataset.startTime = group.timestamp;
    el.dataset.endTime = group.endTime;

    // Collect all unique task labels (from work entries + completions)
    const tasks = [];
    const seenLabels = new Set();
    for (const entry of group.entries) {
        // Add the work entry itself as a task
        let workLabel = entry.text || '';
        if (workLabel.startsWith('Worked on: ')) workLabel = workLabel.slice(11);
        workLabel = workLabel.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');

        const subProject = (entry.projectName || '').includes(' › ')
            ? entry.projectName.split(' › ').slice(1).join(' › ')
            : '';

        if (workLabel && !seenLabels.has(workLabel.toUpperCase())) {
            seenLabels.add(workLabel.toUpperCase());
            tasks.push({
                label: workLabel,
                time: entry.timestamp,
                subProject,
                isCompletion: false,
            });
        }

        // Add completions
        if (entry._completions) {
            for (const c of entry._completions) {
                let cLabel = c.text || '';
                if (cLabel.startsWith('Done: ')) cLabel = cLabel.slice(6);
                if (!seenLabels.has(cLabel.toUpperCase())) {
                    seenLabels.add(cLabel.toUpperCase());
                    const cSub = (c.projectName || '').includes(' › ')
                        ? c.projectName.split(' › ').slice(1).join(' › ')
                        : '';
                    tasks.push({
                        label: cLabel,
                        time: c.timestamp,
                        subProject: cSub,
                        isCompletion: true,
                    });
                }
            }
        }
    }
    tasks.sort((a, b) => a.time - b.time);

    const totalTasks = tasks.length;
    const durationMs = group.endTime - group.timestamp;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    // Chevron
    const chevron = document.createElement('span');
    chevron.className = 'compact-project-chevron compact-past-icon';
    chevron.textContent = '▸';

    // Label: project name + task count
    const label = document.createElement('span');
    label.className = 'compact-past-label';
    label.textContent = group.rootProjectDisplay || 'Work';

    const badge = document.createElement('span');
    badge.className = 'compact-past-merge-badge';
    badge.textContent = `${totalTasks} task${totalTasks !== 1 ? 's' : ''}`;
    label.appendChild(badge);

    // Time range
    const time = document.createElement('span');
    time.className = 'compact-past-time';
    time.textContent = `${formatTime(group.timestamp)} – ${formatTime(group.endTime)}`;

    // Duration
    const dur = document.createElement('span');
    dur.className = 'compact-past-duration';
    dur.textContent = durStr;

    el.appendChild(chevron);
    el.appendChild(label);
    el.appendChild(time);
    el.appendChild(dur);

    // Sub-rows container (initially hidden)
    const subContainer = document.createElement('div');
    subContainer.className = 'compact-project-subs';
    subContainer.style.display = 'none';

    for (const task of tasks) {
        const sub = document.createElement('div');
        sub.className = 'compact-project-sub';

        const dot = document.createElement('span');
        dot.className = 'compact-project-sub-dot';
        dot.textContent = task.isCompletion ? '✓' : '•';

        const subLabel = document.createElement('span');
        subLabel.className = 'compact-project-sub-label';
        subLabel.textContent = task.label;

        const subTime = document.createElement('span');
        subTime.className = 'compact-project-sub-time';
        subTime.textContent = formatTime(task.time);

        sub.appendChild(dot);
        sub.appendChild(subLabel);
        sub.appendChild(subTime);

        if (task.subProject) {
            const subTag = document.createElement('span');
            subTag.className = 'compact-project-sub-tag';
            subTag.textContent = task.subProject;
            sub.appendChild(subTag);
        }

        subContainer.appendChild(sub);
    }

    // Insert sub-container after the main row (as sibling, via wrapper)
    const wrapper = document.createElement('div');
    wrapper.className = 'compact-project-wrapper';
    wrapper.appendChild(el);
    wrapper.appendChild(subContainer);

    // Click to expand/collapse
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = subContainer.style.display !== 'none';
        subContainer.style.display = isOpen ? 'none' : '';
        chevron.textContent = isOpen ? '▸' : '▾';
        el.classList.toggle('compact-project-expanded', !isOpen);
    });

    return wrapper;
}

// ── Compact Past Entry: slim single-line row for standalone break/idle/work in compact mode ──
function createCompactPastEntry(entry) {
    const el = document.createElement('div');
    el.className = 'compact-past-entry';
    el.dataset.id = entry.id || '';
    el.dataset.startTime = entry.timestamp;
    el.dataset.endTime = entry.endTime || entry.timestamp;

    // Color-code by type via modifier class
    const typeClass = {
        work: 'compact-past-work',
        break: 'compact-past-break',
        idle: 'compact-past-idle',
        planned: 'compact-past-planned',
    }[entry.type] || '';
    if (typeClass) el.classList.add(typeClass);

    // Icon
    const icon = document.createElement('span');
    icon.className = 'compact-past-icon';
    const icons = { work: '🔥', break: '☕', idle: '○', planned: '📌' };
    icon.textContent = icons[entry.type] || '•';

    // Label
    const label = document.createElement('span');
    label.className = 'compact-past-label';
    let labelText = entry.text || entry.type || '';
    if (labelText.startsWith('Worked on: ')) labelText = labelText.slice(11);
    labelText = labelText.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');
    label.textContent = labelText;

    // Merged count badge
    if (entry._mergedCount && entry._mergedCount > 1) {
        const badge = document.createElement('span');
        badge.className = 'compact-past-merge-badge';
        badge.textContent = `×${entry._mergedCount}`;
        badge.title = `${entry._mergedCount} entries merged`;
        label.appendChild(badge);
    }

    // Time range
    const time = document.createElement('span');
    time.className = 'compact-past-time';
    time.textContent = `${formatTime(entry.timestamp)} – ${formatTime(entry.endTime || entry.timestamp)}`;

    // Duration
    const durationMs = (entry.endTime || entry.timestamp) - entry.timestamp;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const dur = document.createElement('span');
    dur.className = 'compact-past-duration';
    dur.textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    el.appendChild(icon);
    el.appendChild(label);
    el.appendChild(time);
    el.appendChild(dur);

    // Project tag
    if (entry.projectName) {
        const proj = document.createElement('span');
        proj.className = 'compact-past-project';
        proj.textContent = entry.projectName;
        el.appendChild(proj);
    }

    // Click to expand: replace compact row with full card (toggle)
    el.addEventListener('click', () => {
        if (el._expanded) {
            const compactNew = createCompactPastEntry(entry);
            el.replaceWith(compactNew);
        } else {
            el._expanded = true;
            const full = createTimelineElement(entry);
            full._compactEntry = entry;
            full.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                e.stopPropagation();
                const compactNew = createCompactPastEntry(entry);
                full.replaceWith(compactNew);
            }, { once: true });
            el.replaceWith(full);
        }
    });

    return el;
}

function createTimelineElement(entry) {
    // Block entries (work, break, planned) render as time blocks
    if (entry.type === 'planned') {
        return createPlannedTimeBlock(entry, entry._phantom);
    }
    if (entry.type === 'work') {
        return createWorkEntryBlock(entry);
    }
    if (entry.type === 'break') {
        return createBreakEntryBlock(entry);
    }
    if (entry.type === 'idle') {
        return createIdleEntryBlock(entry);
    }

    // Fallback: any other entry type renders as a moment entry
    return createMomentEntry(entry);
}

// ── Idle Entry: renders as a muted time block for confirmed idle periods ──
function createIdleEntryBlock(entry) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-idle time-block-past focusable-block';
    el.dataset.id = entry.id;
    el.dataset.startTime = entry.timestamp;
    el.dataset.endTime = entry.endTime;

    const durationMs = (entry.endTime || entry.timestamp) - entry.timestamp;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);

    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = '○';

    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    let labelText = entry.text || 'Idle';
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

    el.appendChild(icon);
    el.appendChild(content);

    return el;
}

// ── Past Work Entry: renders as a time block (like the live "working" block) ──
function createWorkEntryBlock(entry) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-work-entry time-block-past focusable-block';
    el.dataset.id = entry.id;
    el.dataset.startTime = entry.timestamp;
    el.dataset.endTime = entry.endTime;
    el.style.cursor = 'pointer';
    let labelText = entry.text || '';
    if (labelText.startsWith('Worked on: ')) labelText = labelText.slice(11);
    labelText = labelText.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');
    el.addEventListener('click', () => toggleSessionFocus({
        startMs: entry.timestamp, endMs: entry.endTime,
        label: labelText || 'Work', type: 'work', icon: '🔥',
        projectName: entry.projectName || null,
        itemId: entry.itemId || null,
        entryId: entry.id,
    }));

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

    // Edit button (replaces click-to-edit)
    const editBtn = document.createElement('button');
    editBtn.className = 'time-block-edit-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit entry';
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEntryEditor(entry, el);
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'plan-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Remove entry';
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await degradeEntryContexts(entry.id);
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(editBtn);
    el.appendChild(delBtn);


    return el;
}

// ── Past Break Entry: renders as a time block (like the live "break" block) ──
function createBreakEntryBlock(entry) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-break-entry time-block-past focusable-block';
    el.dataset.id = entry.id;
    el.dataset.startTime = entry.timestamp;
    el.dataset.endTime = entry.endTime;
    el.style.cursor = 'pointer';
    let breakLabelText = entry.text;
    breakLabelText = breakLabelText.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');
    el.addEventListener('click', () => toggleSessionFocus({
        startMs: entry.timestamp, endMs: entry.endTime,
        label: breakLabelText || 'Break', type: 'break', icon: '☕',
        entryId: entry.id,
    }));

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
    label.textContent = breakLabelText;

    const time = document.createElement('div');
    time.className = 'time-block-time';
    time.textContent = `${formatTime(entry.timestamp)} – ${formatTime(entry.endTime)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status';
    status.textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    content.appendChild(label);
    content.appendChild(time);
    content.appendChild(status);

    // Edit button (replaces click-to-edit)
    const editBtn = document.createElement('button');
    editBtn.className = 'time-block-edit-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit entry';
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEntryEditor(entry, el);
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'plan-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Remove entry';
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await degradeEntryContexts(entry.id);
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(editBtn);
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
        await degradeEntryContexts(entry.id);
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    el.appendChild(dot);
    el.appendChild(content);
    el.appendChild(del);

    return el;
}

function createPlannedTimeBlock(entry, isPhantom = false) {
    const el = document.createElement('div');
    el.className = 'time-block time-block-planned focusable-block' + (isPhantom ? ' time-block-phantom' : '');
    el.dataset.id = entry.id;
    el.dataset.startTime = entry.timestamp;
    el.dataset.endTime = entry.endTime;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => toggleSessionFocus({
        startMs: entry.timestamp, endMs: entry.endTime,
        label: entry.text || 'Planned', type: 'planned', icon: '📌',
        projectName: entry.projectName || null,
        itemId: entry.itemId || null,
        entryId: entry.id,
        segmentKey: buildSegmentContext(getDateKey(new Date(entry.timestamp)), entry.timestamp, entry.endTime),
    }));

    const durationMs = (entry.endTime || entry.timestamp) - entry.timestamp;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = isPhantom ? '⏳' : '📌';

    // Content
    const content = document.createElement('div');
    content.className = 'time-block-content';

    const label = document.createElement('div');
    label.className = 'time-block-label';
    label.textContent = entry.text;

    // Locate-in-sidebar icon for item-linked sessions
    if (entry.itemId) {
        label.classList.add('action-name-row');
        const labelText = document.createElement('span');
        labelText.textContent = entry.text;
        label.textContent = '';
        const locateBtn = document.createElement('span');
        locateBtn.className = 'action-locate-btn';
        locateBtn.textContent = '◉';
        locateBtn.title = 'Locate in projects';
        locateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.selectedItemId = entry.itemId;
            savePref('selectedItemId', entry.itemId);
            renderAll();
            requestAnimationFrame(() => scrollToSelectedItem());
        });
        label.appendChild(locateBtn);
        label.appendChild(labelText);
    }

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

    // Phantom blocks: render only icon + content (no edit/delete/drag interactions)
    if (isPhantom) {
        el.appendChild(icon);
        el.appendChild(content);
        return el;
    }

    // Start working button — click to begin working on this planned item
    const startBtn = document.createElement('button');
    startBtn.className = 'plan-start-btn';
    startBtn.textContent = '▶';
    startBtn.title = 'Start working on this';
    startBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Keep the plan — the absorption system will hide it once work covers ≥80%,
        // or show it as a ghost if there's partial overlap
        await startWorking(entry.itemId, entry.text, entry.projectName, entry.endTime);
    });

    // Edit button (replaces click-to-edit)
    const editBtn = document.createElement('button');
    editBtn.className = 'time-block-edit-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit entry';
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEntryEditor(entry, el);
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'plan-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Remove plan';
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await degradeEntryContexts(entry.id);
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    // ── Drop target for drag-to-schedule (same as free time blocks) ──
    const dateKey = getDateKey(state.timelineViewDate);
    const entryCtx = `${dateKey}@entry:${entry.id}`;

    // Pre-compute descendant IDs for item-bound sessions
    let planDescendantIds = null;
    if (entry.itemId) {
        const planItem = findItemById(entry.itemId);
        if (planItem) planDescendantIds = new Set(collectDescendantIds(planItem));
    }

    const _acceptsDrag = (e) =>
        e.dataTransfer.types.includes('application/x-action-id') ||
        e.dataTransfer.types.includes('application/x-segment-item-id');

    el.addEventListener('dragover', (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('time-block-drag-over');
    });
    el.addEventListener('dragenter', (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        el.classList.add('time-block-drag-over');
    });
    el.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        el.classList.remove('time-block-drag-over');
    });
    el.addEventListener('drop', (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        el.classList.remove('time-block-drag-over');

        // Cross-block drag: segment/entry item moving between blocks
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const oldCtx = e.dataTransfer.getData('application/x-segment-context');
            if (itemId && oldCtx && oldCtx !== entryCtx) {
                // Validate descendant constraint for item-bound sessions
                if (planDescendantIds && !planDescendantIds.has(Number(itemId))) return;
                (async () => {
                    const dur = await degradeSegmentContext(itemId, oldCtx);
                    await addSegmentContext(Number(itemId), entryCtx, dur);
                })();
            }
            return;
        }

        // Normal drag from Actions panel
        const action = window._draggedAction;
        if (!action) return;
        // Validate descendant constraint for item-bound sessions
        if (planDescendantIds && !planDescendantIds.has(action.id)) return;
        window._draggedAction = null;
        // Carry duration from the current view context (Actions panel)
        const srcDur = getContextDuration(findItemById(action.id));
        addSegmentContext(action.id, entryCtx, srcDur || undefined);
    });

    // Add intention button (+)
    const addIntentBtn = document.createElement('button');
    addIntentBtn.className = 'plan-next-btn';
    addIntentBtn.textContent = '+';
    addIntentBtn.title = 'Add intention to this session';
    addIntentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPlanEditor(el, entry.timestamp, entry.endTime, null, entry.id, entry.itemId || null, 'intend');
    });

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(editBtn);
    el.appendChild(startBtn);
    el.appendChild(addIntentBtn);
    el.appendChild(delBtn);

    // ── Nested entry-assigned items (appended after main content) ──
    const allItems = collectAllItems();
    const assignedItems = allItems.filter(a => {
        const item = findItemById(a.id);
        if (!item || !item.timeContexts) return false;
        if (item.done && !state.showDone) return false;
        return item.timeContexts.includes(entryCtx);
    });

    if (assignedItems.length > 0) {
        const queue = document.createElement('div');
        queue.className = 'segment-queue';

        let totalEstMins = 0;
        for (const action of assignedItems) {
            const item = findItemById(action.id);
            const segDur = item?.contextDurations?.[entryCtx];
            const estMins = segDur != null ? segDur : (item?.estimatedDuration || 0);
            if (!item?.done) totalEstMins += estMins;

            const row = document.createElement('div');
            row.className = 'segment-queue-item' + (item?.done ? ' segment-item-done' : '');
            row.draggable = true;
            row.dataset.itemId = action.id;

            // Drag-out: allow dragging to other blocks
            row.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-segment-item-id', String(action.id));
                e.dataTransfer.setData('application/x-segment-context', entryCtx);
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('segment-item-dragging');
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('segment-item-dragging');
            });

            const bullet = document.createElement('span');
            bullet.className = 'segment-queue-bullet';
            bullet.textContent = item?.done ? '✓' : '○';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'segment-queue-name';
            nameSpan.textContent = action.name;

            // Clickable est badge with inline edit
            const est = document.createElement('span');
            est.className = 'segment-queue-est';
            est.textContent = estMins ? `~${estMins}m` : '⏱';
            est.title = 'Click to set duration for this assignment';
            est.addEventListener('click', (ev) => {
                ev.stopPropagation();
                document.querySelectorAll('.segment-duration-popover').forEach(p => p.remove());
                const pop = document.createElement('div');
                pop.className = 'segment-duration-popover';
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'segment-duration-input';
                input.min = '0';
                input.max = '480';
                input.value = estMins || '';
                input.placeholder = 'min';
                const saveBtn = document.createElement('button');
                saveBtn.className = 'segment-duration-save';
                saveBtn.textContent = '✓';
                saveBtn.addEventListener('click', async (se) => {
                    se.stopPropagation();
                    const mins = parseInt(input.value, 10) || 0;
                    if (!item.contextDurations) item.contextDurations = {};
                    item.contextDurations[entryCtx] = mins;
                    await api.patch(`/items/${action.id}`, { contextDurations: item.contextDurations });
                    pop.remove();
                    renderAll();
                });
                pop.appendChild(input);
                pop.appendChild(saveBtn);
                row.appendChild(pop);
                input.focus();
                input.select();
                const closeHandler = (ce) => {
                    if (!pop.contains(ce.target)) {
                        pop.remove();
                        document.removeEventListener('click', closeHandler, true);
                    }
                };
                setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
                input.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') saveBtn.click();
                    if (ke.key === 'Escape') pop.remove();
                });
            });

            // Start button
            const startBtn2 = document.createElement('button');
            startBtn2.className = 'segment-queue-start';
            startBtn2.textContent = '▶';
            startBtn2.title = 'Start working on this';
            startBtn2.draggable = false;
            startBtn2.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const now = Date.now();
                const durMins = estMins || 30;
                const targetEnd = now + durMins * 60000;
                const ancestors = action._path
                    ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';
                await startWorking(action.id, action.name, ancestors || null, targetEnd);
            });

            // Locate-in-sidebar icon
            const locateBtn3 = document.createElement('span');
            locateBtn3.className = 'action-locate-btn';
            locateBtn3.textContent = '◉';
            locateBtn3.title = 'Locate in projects';
            locateBtn3.addEventListener('click', (e) => {
                e.stopPropagation();
                state.selectedItemId = action.id;
                savePref('selectedItemId', action.id);
                renderAll();
                requestAnimationFrame(() => scrollToSelectedItem());
            });

            row.appendChild(bullet);
            row.appendChild(locateBtn3);
            row.appendChild(nameSpan);
            row.appendChild(est);
            row.appendChild(startBtn2);
            queue.appendChild(row);
        }

        el.appendChild(queue);

        // Capacity bar
        const availMins = Math.floor(durationMs / 60000);
        if (totalEstMins > 0) {
            const capBar = document.createElement('div');
            capBar.className = 'segment-capacity-bar';
            const fillPct = Math.min(100, (totalEstMins / availMins) * 100);
            const isOver = totalEstMins > availMins;
            capBar.innerHTML = `
                <span class="segment-capacity-label">${totalEstMins}m / ${availMins}m</span>
                <div class="segment-capacity-track"><div class="segment-capacity-fill${isOver ? ' over-capacity' : ''}" style="width:${fillPct}%"></div></div>
            `;
            el.appendChild(capBar);
        }
    }

    return el;
}

// ── Edit Entry: inline editor for past time blocks (work, break, planned) ──

function openEntryEditor(entry, blockEl) {
    // Close any existing editor
    document.querySelectorAll('.plan-editor').forEach(ed => ed.remove());

    let planStartMs = entry.timestamp;
    let planEndMs = entry.endTime || entry.timestamp;
    const originalDateKey = getDateKey(new Date(entry.timestamp));
    // For work/planned entries, try to find the matching item for preselection
    let preselectedAction = null;
    if (entry.itemId) {
        const allActions = collectAllItems();
        preselectedAction = allActions.find(a => a.id === entry.itemId) || null;
    }

    const msToTimeStr = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const timeStrToMs = (str, referenceMs) => {
        const ref = referenceMs || planStartMs;
        const [h, m] = str.split(':').map(Number);
        const d = new Date(ref);
        d.setHours(h, m, 0, 0);
        if (d.getTime() < ref) d.setDate(d.getDate() + 1);
        return d.getTime();
    };

    const updateDuration = () => {
        const durMs = planEndMs - planStartMs;
        const totalMins = Math.round(durMs / 60000);
        durationInput.value = totalMins;
    };

    // ── Build editor DOM ──
    const editor = document.createElement('div');
    editor.className = 'time-block plan-editor';

    const editorIcon = document.createElement('div');
    editorIcon.className = 'time-block-icon';
    editorIcon.textContent = entry.type === 'break' ? '☕' : entry.type === 'planned' ? '📌' : '🔥';

    const editorContent = document.createElement('div');
    editorContent.className = 'plan-editor-content';

    // Row 1: Action autocomplete (skip for break entries)
    const actionRow = document.createElement('div');
    actionRow.className = 'plan-editor-row';

    const actionInputWrap = document.createElement('div');
    actionInputWrap.className = 'plan-editor-autocomplete';

    const actionInput = document.createElement('input');
    actionInput.type = 'text';
    actionInput.className = 'plan-editor-input';

    const suggestions = document.createElement('div');
    suggestions.className = 'plan-editor-suggestions';

    if (entry.type === 'break') {
        actionInput.value = 'Break';
        actionInput.disabled = true;
        actionInput.style.opacity = '0.7';
    } else {
        actionInput.placeholder = 'Session title or item…';
        // Pre-fill with current item name
        if (preselectedAction) {
            actionInput.value = preselectedAction.name;
        } else {
            // Fallback: use entry text, cleaning "Worked on:" prefix
            let cleanText = entry.text;
            if (cleanText.startsWith('Worked on: ')) cleanText = cleanText.slice(11);
            cleanText = cleanText.replace(/\s*\(\d+[hm]\s*\d*[m]?\)\s*$/, '');
            actionInput.value = cleanText;
        }
    }

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

    // Row 2b: Date input for rescheduling to another day
    const dateRow = document.createElement('div');
    dateRow.className = 'plan-editor-row plan-editor-date-row';

    const dateLabel = document.createElement('span');
    dateLabel.className = 'plan-editor-date-label';
    dateLabel.textContent = 'Date:';

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'plan-editor-date-input';
    dateInput.value = originalDateKey;

    dateRow.appendChild(dateLabel);
    dateRow.appendChild(dateInput);

    // Row 3: Action buttons
    const actionsRow = document.createElement('div');
    actionsRow.className = 'plan-editor-row plan-editor-actions';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'plan-editor-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
        await degradeEntryContexts(entry.id);
        await api.del(`/timeline/${entry.id}`);
        state.timeline = await api.get('/timeline');
        renderTimeline();
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'plan-editor-save';
    saveBtn.textContent = 'Save';

    const discardBtn = document.createElement('button');
    discardBtn.className = 'plan-editor-discard';
    discardBtn.textContent = 'Discard';

    actionsRow.appendChild(removeBtn);
    actionsRow.appendChild(discardBtn);
    actionsRow.appendChild(saveBtn);

    editorContent.appendChild(actionRow);
    editorContent.appendChild(timeRow);
    editorContent.appendChild(dateRow);
    editorContent.appendChild(actionsRow);

    editor.appendChild(editorIcon);
    editor.appendChild(editorContent);

    // Hide the original block and insert editor in its place
    blockEl.style.display = 'none';
    blockEl.after(editor);

    // Focus appropriate field
    if (entry.type !== 'break') {
        actionInput.focus();
        actionInput.select();
    } else {
        startInput.focus();
        startInput.select();
    }

    // ── Autocomplete logic (only for non-break entries) ──
    let autocomplete = null;
    if (entry.type !== 'break') {
        autocomplete = setupAutocomplete(actionInput, suggestions, { allowFreeText: true });
        if (preselectedAction) {
            autocomplete.setSelected(preselectedAction);
        }
    }

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
        const currentDuration = planEndMs - planStartMs;
        // Validate: just needs to be a valid time (end will shift to preserve duration)
        const result = parseTimeInput(startInput, planStartMs, () => true);
        if (result !== planStartMs) {
            planStartMs = result;
            // Preserve duration: shift end time to match
            planEndMs = planStartMs + currentDuration;
            endInput.value = msToTimeStr(planEndMs);
            updateDuration();
        }
    });

    endInput.addEventListener('blur', () => {
        const result = parseTimeInput(endInput, planEndMs, (t) => t > planStartMs);
        if (result !== planEndMs) {
            planEndMs = result;
            updateDuration();
        }
    });

    durationInput.addEventListener('change', () => {
        const mins = parseInt(durationInput.value, 10);
        if (mins > 0) {
            planEndMs = planStartMs + mins * 60000;
            endInput.value = msToTimeStr(planEndMs);
        } else {
            updateDuration();
        }
    });

    // ── Save / Discard ──
    discardBtn.addEventListener('click', () => {
        editor.remove();
        blockEl.style.display = '';
    });

    saveBtn.addEventListener('click', async () => {
        const selectedAction = autocomplete ? autocomplete.getSelected() : null;
        // For non-break entries, require a selected action or typed name
        if (entry.type !== 'break' && !selectedAction && !actionInput.value.trim()) {
            actionInput.focus();
            actionInput.classList.add('plan-editor-input-error');
            setTimeout(() => actionInput.classList.remove('plan-editor-input-error'), 600);
            return;
        }

        // ── Handle date change: shift timestamps to the new date ──
        const newDateKey = dateInput.value;
        const dateChanged = newDateKey && newDateKey !== originalDateKey;
        if (dateChanged) {
            // Compute day delta from the date keys
            const [oy, om, od] = originalDateKey.split('-').map(Number);
            const [ny, nm, nd] = newDateKey.split('-').map(Number);
            const oldDateMidnight = new Date(oy, om - 1, od).getTime();
            const newDateMidnight = new Date(ny, nm - 1, nd).getTime();
            const dayDeltaMs = newDateMidnight - oldDateMidnight;
            planStartMs += dayDeltaMs;
            planEndMs += dayDeltaMs;
        }

        // Build the update payload
        const updates = {
            startTime: planStartMs,
            timestamp: planStartMs,
            endTime: planEndMs,
        };

        if (entry.type !== 'break') {
            if (selectedAction) {
                const ancestors = selectedAction._path
                    ? selectedAction._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';
                const durationMs = planEndMs - planStartMs;
                const hrs = Math.floor(durationMs / 3600000);
                const mins = Math.floor((durationMs % 3600000) / 60000);
                const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

                updates.itemId = selectedAction.id;
                updates.projectName = ancestors || null;
                if (entry.type === 'work') {
                    updates.text = `Worked on: ${selectedAction.name} (${durStr})`;
                } else {
                    updates.text = selectedAction.name;
                }
            } else {
                // Free text (no item selected from autocomplete)
                const name = actionInput.value.trim();
                const durationMs = planEndMs - planStartMs;
                const hrs = Math.floor(durationMs / 3600000);
                const mins = Math.floor((durationMs % 3600000) / 60000);
                const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

                updates.itemId = null;
                if (entry.type === 'work') {
                    updates.text = `Worked on: ${name} (${durStr})`;
                } else {
                    updates.text = name;
                }
            }
        } else {
            // Break: update duration text
            const durationMs = planEndMs - planStartMs;
            const hrs = Math.floor(durationMs / 3600000);
            const mins = Math.floor((durationMs % 3600000) / 60000);
            const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
            updates.text = `Break (${durStr})`;
        }

        await api.patch(`/timeline/${entry.id}`, updates);

        // Re-fetch timeline from server so new timestamps are reflected
        state.timeline = await api.get('/timeline');

        // ── Update linked item's timeContexts when date changed ──
        if (dateChanged) {
            const itemId = updates.itemId || entry.itemId;
            if (itemId) {
                const item = findItemById(itemId);
                if (item) {
                    if (!item.timeContexts) item.timeContexts = [];
                    // Remove old date and any segment/entry contexts for the old date
                    item.timeContexts = item.timeContexts.filter(tc =>
                        tc !== originalDateKey && !tc.startsWith(originalDateKey + '@'));
                    // Add the new entry-specific context (date@entry:ID)
                    const newEntryCtx = `${newDateKey}@entry:${entry.id}`;
                    if (!item.timeContexts.includes(newEntryCtx)) {
                        item.timeContexts.push(newEntryCtx);
                    }
                    // Remove epoch contexts if present — we're scheduling to a specific date
                    item.timeContexts = item.timeContexts.filter(tc => !EPOCH_CONTEXTS.includes(tc));
                    // Migrate contextDurations keys from old date to new date
                    if (item.contextDurations) {
                        const newDurations = {};
                        for (const [key, val] of Object.entries(item.contextDurations)) {
                            if (key.startsWith(originalDateKey + '@')) {
                                const suffix = key.substring(originalDateKey.length);
                                newDurations[newDateKey + suffix] = val;
                            } else {
                                newDurations[key] = val;
                            }
                        }
                        item.contextDurations = newDurations;
                    }
                    const patch = { timeContexts: item.timeContexts };
                    if (item.contextDurations) patch.contextDurations = item.contextDurations;
                    await api.patch(`/items/${itemId}`, patch);
                }
            }
        }

        renderAll();
    });
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
    const dateEl = document.getElementById('date-nav-date');
    const todayBtn = document.getElementById('date-nav-today-btn');
    const pickerEl = document.getElementById('date-nav-picker');

    if (state.viewHorizon === 'week') {
        // Week mode: show week range
        const weekKey = getWeekKey(viewDate);
        const range = getWeekDateRange(weekKey);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        let weekRangeStr = 'Week';
        if (range) {
            const startMonth = months[range.start.getMonth()];
            const endMonth = months[range.end.getMonth()];
            const startStr = `${startMonth} ${range.start.getDate()}`;
            const endStr = startMonth === endMonth
                ? `${range.end.getDate()}`
                : `${endMonth} ${range.end.getDate()}`;
            weekRangeStr = `${startStr}–${endStr}`;
            if (dateEl) dateEl.textContent = weekRangeStr;
        }
        // Also update the week layer label
        const weekNavLabel = document.getElementById('week-nav-label');
        if (weekNavLabel) weekNavLabel.textContent = weekRangeStr;
        // Update week nav picker value
        const weekPicker = document.getElementById('week-nav-picker');
        if (weekPicker) {
            const y = viewDate.getFullYear();
            const m = String(viewDate.getMonth() + 1).padStart(2, '0');
            const d = String(viewDate.getDate()).padStart(2, '0');
            weekPicker.value = `${y}-${m}-${d}`;
        }
        // Update This Week button visibility
        const currentWeek = getWeekKey(getLogicalToday());
        const weekTodayBtn = document.getElementById('week-nav-today-btn');
        if (weekTodayBtn) {
            weekTodayBtn.style.display = weekKey === currentWeek ? 'none' : '';
        }
        if (todayBtn) {
            todayBtn.style.display = weekKey === currentWeek ? 'none' : '';
            todayBtn.textContent = 'This Week';
        }
        if (pickerEl) {
            const y = viewDate.getFullYear();
            const m = String(viewDate.getMonth() + 1).padStart(2, '0');
            const d = String(viewDate.getDate()).padStart(2, '0');
            pickerEl.value = `${y}-${m}-${d}`;
        }
        return;
    }

    // Day mode
    const isToday = isCurrentDay(viewDate);
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    let dateText = viewDate.toLocaleDateString('en-US', options);
    if (viewDate.getFullYear() !== now.getFullYear()) {
        dateText += `, ${viewDate.getFullYear()}`;
    }
    if (dateEl) dateEl.textContent = dateText;
    if (todayBtn) {
        todayBtn.style.display = isToday ? 'none' : '';
        todayBtn.textContent = 'Today';
    }
    if (pickerEl) {
        const y = viewDate.getFullYear();
        const m = String(viewDate.getMonth() + 1).padStart(2, '0');
        const d = String(viewDate.getDate()).padStart(2, '0');
        pickerEl.value = `${y}-${m}-${d}`;
    }
}

// ─── Context Labels ───
function updateContextLabels() {
    const whatContainer = document.getElementById('header-breadcrumb-what');
    const whenContainer = document.getElementById('header-breadcrumb-when');
    if (!whatContainer || !whenContainer) return;
    whatContainer.innerHTML = '';
    whenContainer.innerHTML = '';

    // ── What axis (left): project tree position ──
    if (state.selectedItemId) {
        const ancestors = getAncestorPath(state.selectedItemId);
        const selectedItem = findItemById(state.selectedItemId);
        if (selectedItem) {
            // "All" root link
            const allSeg = document.createElement('span');
            allSeg.className = 'breadcrumb-segment breadcrumb-link';
            allSeg.textContent = '📁 All';
            allSeg.title = 'Clear project filter';
            allSeg.addEventListener('click', () => {
                state.selectedItemId = null;
                savePref('selectedItemId', '');
                renderAll();
            });
            whatContainer.appendChild(allSeg);

            // Ancestor segments
            if (ancestors) {
                for (const ancestor of ancestors) {
                    if (ancestor.isInbox) continue;
                    const sep = document.createElement('span');
                    sep.className = 'breadcrumb-sep';
                    sep.textContent = '›';
                    whatContainer.appendChild(sep);

                    const seg = document.createElement('span');
                    seg.className = 'breadcrumb-segment breadcrumb-link';
                    seg.textContent = ancestor.name;
                    seg.title = ancestor.name;
                    seg.addEventListener('click', () => {
                        state.selectedItemId = ancestor.id;
                        savePref('selectedItemId', ancestor.id);
                        renderAll();
                        requestAnimationFrame(() => scrollToSelectedItem());
                    });
                    whatContainer.appendChild(seg);
                }
            }

            // Current (selected) item — bold, not clickable
            const sep = document.createElement('span');
            sep.className = 'breadcrumb-sep';
            sep.textContent = '›';
            whatContainer.appendChild(sep);

            const current = document.createElement('span');
            current.className = 'breadcrumb-segment breadcrumb-current';
            current.textContent = selectedItem.name;
            current.title = selectedItem.name;
            whatContainer.appendChild(current);
        }
    } else {
        // Root level — show "All"
        const allSeg = document.createElement('span');
        allSeg.className = 'breadcrumb-segment breadcrumb-current';
        allSeg.textContent = '📁 All';
        whatContainer.appendChild(allSeg);
    }

    // ── When axis (right): time context focus ──
    const viewDate = state.timelineViewDate;
    const todayKey = getDateKey(getLogicalToday());
    const viewKey = getDateKey(viewDate);
    const isToday = viewKey === todayKey;

    const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;

    if (focusedSession) {
        // Date segment — clickable to clear focus
        const dateSeg = document.createElement('span');
        dateSeg.className = 'breadcrumb-segment breadcrumb-link';
        if (isToday) {
            dateSeg.textContent = '📅 Today';
        } else {
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            dateSeg.textContent = `📅 ${days[viewDate.getDay()]}, ${months[viewDate.getMonth()]} ${viewDate.getDate()}`;
        }
        dateSeg.title = 'Back to full day';
        dateSeg.addEventListener('click', () => {
            clearFocusStack();
            renderAll();
        });
        whenContainer.appendChild(dateSeg);

        // Session segment
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        whenContainer.appendChild(sep);

        const sessionSeg = document.createElement('span');
        sessionSeg.className = 'breadcrumb-segment breadcrumb-current';
        const timeRange = `${formatTime(focusedSession.startMs)}–${formatTime(focusedSession.endMs)}`;
        const typeLabel = focusedSession.label || focusedSession.type || '';
        sessionSeg.textContent = `${timeRange} ${typeLabel}`.trim();
        whenContainer.appendChild(sessionSeg);
    } else if (state.viewHorizon === 'epoch') {
        // Epoch view
        const epochIcons = { past: '📜', ongoing: '📦', future: '🔮' };
        const epochLabels = { past: 'Past', ongoing: 'Ongoing', future: 'Future' };
        const epochSeg = document.createElement('span');
        epochSeg.className = 'breadcrumb-segment breadcrumb-current';
        epochSeg.textContent = `${epochIcons[state.epochFilter] || '📦'} ${epochLabels[state.epochFilter] || 'Ongoing'}`;
        whenContainer.appendChild(epochSeg);
    } else if (state.viewHorizon === 'week') {
        // Week view
        const weekKey = getWeekKey(state.timelineViewDate);
        const range = getWeekDateRange(weekKey);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const label = range ? `📆 Week of ${months[range.start.getMonth()]} ${range.start.getDate()}` : '📆 Week';
        const weekSeg = document.createElement('span');
        weekSeg.className = 'breadcrumb-segment breadcrumb-current';
        weekSeg.textContent = label;
        whenContainer.appendChild(weekSeg);
    } else {
        // No session focused — just show the date
        const dateSeg = document.createElement('span');
        dateSeg.className = 'breadcrumb-segment breadcrumb-current';
        if (isToday) {
            dateSeg.textContent = '📅 Today';
        } else {
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            dateSeg.textContent = `📅 ${days[viewDate.getDay()]}, ${months[viewDate.getMonth()]} ${viewDate.getDate()}`;
        }
        whenContainer.appendChild(dateSeg);
    }
}

// ─── Duration Picker Popover ───
function showDurationPicker(anchorEl, itemId, itemName, projectName) {
    // Dismiss any existing picker
    dismissDurationPicker();

    const overlay = document.createElement('div');
    overlay.className = 'duration-picker-overlay';
    overlay.addEventListener('click', dismissDurationPicker);

    const picker = document.createElement('div');
    picker.className = 'duration-picker';
    picker.addEventListener('click', (e) => e.stopPropagation());

    // Position relative to anchor, clamped to viewport
    const rect = anchorEl.getBoundingClientRect();
    const pickerWidth = 200;
    const pickerHeight = 120;
    let top = rect.bottom + 4;
    let left = rect.left;
    // Clamp right edge
    if (left + pickerWidth > window.innerWidth - 8) {
        left = window.innerWidth - pickerWidth - 8;
    }
    // Clamp left edge
    if (left < 8) left = 8;
    // If overflows bottom, open above
    if (top + pickerHeight > window.innerHeight - 8) {
        top = rect.top - pickerHeight - 4;
    }
    picker.style.position = 'fixed';
    picker.style.top = `${top}px`;
    picker.style.left = `${left}px`;
    picker.style.zIndex = '10001';

    // Title
    const title = document.createElement('div');
    title.className = 'duration-picker-title';
    title.textContent = 'Start with timer';
    picker.appendChild(title);

    // Overlap warning area
    const warning = document.createElement('div');
    warning.className = 'duration-picker-warning';
    warning.style.display = 'none';
    picker.appendChild(warning);

    // Preset buttons
    const presets = document.createElement('div');
    presets.className = 'duration-picker-presets';
    const presetValues = [
        { label: '15m', mins: 15 },
        { label: '25m', mins: 25 },
        { label: '45m', mins: 45 },
        { label: '1h', mins: 60 },
    ];
    for (const preset of presetValues) {
        const btn = document.createElement('button');
        btn.className = 'duration-picker-preset';
        btn.textContent = preset.label;
        btn.addEventListener('mouseenter', () => checkOverlap(preset.mins, warning));
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const targetEnd = Date.now() + preset.mins * 60000;
            dismissDurationPicker();
            await startWorking(itemId, itemName, projectName, targetEnd);
        });
        presets.appendChild(btn);
    }
    picker.appendChild(presets);

    // Eagerly check overlap for the shortest preset
    checkOverlap(presetValues[0].mins, warning);

    // Custom input row
    const customRow = document.createElement('div');
    customRow.className = 'duration-picker-custom';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'duration-picker-input';
    input.placeholder = 'min';
    input.min = '1';
    input.max = '480';
    input.addEventListener('input', () => {
        const mins = parseInt(input.value, 10);
        if (mins > 0) {
            checkOverlap(mins, warning);
        } else {
            warning.style.display = 'none';
        }
    });

    const minLabel = document.createElement('span');
    minLabel.className = 'duration-picker-min-label';
    minLabel.textContent = 'min';

    const startBtn = document.createElement('button');
    startBtn.className = 'duration-picker-start';
    startBtn.textContent = 'Start';
    startBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mins = parseInt(input.value, 10);
        if (!mins || mins <= 0) return;
        const targetEnd = Date.now() + mins * 60000;
        dismissDurationPicker();
        await startWorking(itemId, itemName, projectName, targetEnd);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') startBtn.click();
        if (e.key === 'Escape') dismissDurationPicker();
    });

    customRow.appendChild(input);
    customRow.appendChild(minLabel);
    customRow.appendChild(startBtn);
    picker.appendChild(customRow);

    overlay.appendChild(picker);
    document.body.appendChild(overlay);

    // Focus the custom input
    setTimeout(() => input.focus(), 50);
}

function checkOverlap(durationMins, warningEl) {
    const now = Date.now();
    const targetEnd = now + durationMins * 60000;
    const entries = (state.timeline && state.timeline.entries) || [];

    // Check overlap with planned entries
    const overlapping = entries.filter(e =>
        e.type === 'planned' && e.endTime &&
        e.timestamp < targetEnd && e.endTime > now
    );

    if (overlapping.length > 0) {
        const first = overlapping[0];
        const name = first.text || 'planned block';
        warningEl.textContent = `⚠ Overlaps with "${name}" at ${formatTime(first.timestamp)}`;
        warningEl.style.display = 'block';
        return;
    }

    // Check if extends past day end boundary
    const { dayEnd } = getDayBoundaries(state.timelineViewDate);
    const dayEndMs = dayEnd.getTime();
    if (dayEndMs > now && targetEnd > dayEndMs) {
        warningEl.textContent = `⚠ Extends past day end (${formatTime(dayEndMs)})`;
        warningEl.style.display = 'block';
        return;
    }

    warningEl.style.display = 'none';
}

function dismissDurationPicker() {
    const existing = document.querySelector('.duration-picker-overlay');
    if (existing) existing.remove();
}

// ─── Estimate Picker Popover ───
function showEstimatePicker(anchorEl, itemId) {
    // Dismiss any existing picker
    dismissDurationPicker();

    const overlay = document.createElement('div');
    overlay.className = 'duration-picker-overlay';
    overlay.addEventListener('click', dismissDurationPicker);

    const picker = document.createElement('div');
    picker.className = 'duration-picker';
    picker.addEventListener('click', (e) => e.stopPropagation());

    // Position relative to anchor, clamped to viewport
    const rect = anchorEl.getBoundingClientRect();
    const pickerWidth = 200;
    const pickerHeight = 120;
    let top = rect.bottom + 4;
    let left = rect.left;
    if (left + pickerWidth > window.innerWidth - 8) {
        left = window.innerWidth - pickerWidth - 8;
    }
    if (left < 8) left = 8;
    if (top + pickerHeight > window.innerHeight - 8) {
        top = rect.top - pickerHeight - 4;
    }
    picker.style.position = 'fixed';
    picker.style.top = `${top}px`;
    picker.style.left = `${left}px`;
    picker.style.zIndex = '10001';

    // Title — show current context
    const currentCtx = getCurrentViewContext();
    const title = document.createElement('div');
    title.className = 'duration-picker-title';
    const parsed = parseTimeContext(currentCtx);
    let ctxLabel = 'this context';
    if (parsed?.epoch) ctxLabel = parsed.epoch;
    else if (parsed?.segment) ctxLabel = `${parsed.segment.start}–${parsed.segment.end}`;
    else if (parsed?.date) ctxLabel = parsed.date === getDateKey(new Date()) ? 'Today' : parsed.date;
    title.textContent = `Duration for ${ctxLabel}`;
    picker.appendChild(title);

    // Preset buttons
    const presets = document.createElement('div');
    presets.className = 'duration-picker-presets';
    const presetValues = [
        { label: '15m', mins: 15 },
        { label: '30m', mins: 30 },
        { label: '1h', mins: 60 },
        { label: '2h', mins: 120 },
    ];
    for (const preset of presetValues) {
        const btn = document.createElement('button');
        btn.className = 'duration-picker-preset';
        btn.textContent = preset.label;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            dismissDurationPicker();
            await setEstimate(itemId, preset.mins);
        });
        presets.appendChild(btn);
    }
    picker.appendChild(presets);

    // Custom input row
    const customRow = document.createElement('div');
    customRow.className = 'duration-picker-custom';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'duration-picker-input';
    input.placeholder = 'min';
    input.min = '1';
    input.max = '480';

    // Pre-fill with existing context-aware estimate
    const existingItem = findItemById(itemId);
    const existingEst = getContextDuration(existingItem, currentCtx);
    if (existingEst) {
        input.value = existingEst;
    }

    const minLabel = document.createElement('span');
    minLabel.className = 'duration-picker-min-label';
    minLabel.textContent = 'min';

    const setBtn = document.createElement('button');
    setBtn.className = 'duration-picker-start';
    setBtn.textContent = 'Set';
    setBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mins = parseInt(input.value, 10);
        if (!mins || mins <= 0) return;
        dismissDurationPicker();
        await setEstimate(itemId, mins);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') setBtn.click();
        if (e.key === 'Escape') dismissDurationPicker();
    });

    customRow.appendChild(input);
    customRow.appendChild(minLabel);
    customRow.appendChild(setBtn);
    picker.appendChild(customRow);

    // Clear button (if any effective duration is showing)
    if (existingEst) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'duration-picker-preset';
        clearBtn.style.width = '100%';
        clearBtn.style.marginTop = '4px';
        clearBtn.style.opacity = '0.7';
        clearBtn.textContent = 'Clear estimate';
        clearBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            dismissDurationPicker();
            await setEstimate(itemId, null);
        });
        picker.appendChild(clearBtn);
    }

    overlay.appendChild(picker);
    document.body.appendChild(overlay);

    setTimeout(() => input.focus(), 50);
}

async function setEstimate(itemId, mins) {
    const item = findItemById(itemId);
    if (!item) return;
    const ctx = getCurrentViewContext();
    if (!item.contextDurations) item.contextDurations = {};
    if (mins === null) {
        item.contextDurations[ctx] = 0;
        await api.patch(`/items/${itemId}`, { contextDurations: item.contextDurations });
    } else {
        item.contextDurations[ctx] = mins;
        await api.patch(`/items/${itemId}`, { contextDurations: item.contextDurations });
    }
    renderActions();
}

// ─── Lead Time Helpers ───

function _formatLeadTimeBrief(sec) {
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h`;
    if (sec < 604800) return `${Math.round(sec / 86400)}d`;
    return `${Math.round(sec / 604800)}w`;
}

// Build an inline lead-time row for the schedule modal.
// horizon: 'session' | 'day' | 'week'
function _buildLeadTimeRow(itemIds, ctx, horizon, onUpdate) {
    const row = document.createElement('div');
    row.className = 'schedule-leadtime-row';

    // Check existing lead time
    const sampleItem = findItemById(itemIds[0]);
    const existingLT = getContextLeadTime(sampleItem, ctx);

    // Horizon-aware presets
    const presetMap = {
        session: [
            { text: '15m', sec: 900 }, { text: '30m', sec: 1800 },
            { text: '1h', sec: 3600 }, { text: '2h', sec: 7200 }, { text: '3h', sec: 10800 },
        ],
        day: [
            { text: '1d', sec: 86400 }, { text: '2d', sec: 172800 },
            { text: '3d', sec: 259200 }, { text: '5d', sec: 432000 },
            { text: '1w', sec: 604800 }, { text: '2w', sec: 1209600 },
        ],
        week: [
            { text: '1w', sec: 604800 }, { text: '2w', sec: 1209600 },
            { text: '3w', sec: 1814400 }, { text: '4w', sec: 2419200 },
        ],
    };
    const presets = presetMap[horizon] || presetMap.day;

    // Preset buttons
    const presetsDiv = document.createElement('div');
    presetsDiv.className = 'schedule-leadtime-presets';
    for (const preset of presets) {
        const btn = document.createElement('button');
        btn.className = 'schedule-leadtime-preset';
        if (existingLT === preset.sec) btn.classList.add('schedule-leadtime-preset-active');
        btn.textContent = preset.text;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            for (const id of itemIds) await setLeadTime(id, ctx, preset.sec);
            onUpdate();
        });
        presetsDiv.appendChild(btn);
    }
    row.appendChild(presetsDiv);

    // Custom input row
    const customDiv = document.createElement('div');
    customDiv.className = 'schedule-leadtime-custom';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'schedule-leadtime-input';
    input.placeholder = '#';
    input.min = '1';
    input.max = '999';

    const unitSelect = document.createElement('select');
    unitSelect.className = 'schedule-leadtime-input';
    const unitMap = {
        session: [{ label: 'min', mult: 60 }, { label: 'hours', mult: 3600 }],
        day: [{ label: 'days', mult: 86400 }, { label: 'weeks', mult: 604800 }],
        week: [{ label: 'weeks', mult: 604800 }],
    };
    for (const u of (unitMap[horizon] || unitMap.day)) {
        const opt = document.createElement('option');
        opt.value = u.mult;
        opt.textContent = u.label;
        unitSelect.appendChild(opt);
    }

    const setBtn = document.createElement('button');
    setBtn.className = 'schedule-leadtime-set';
    setBtn.textContent = 'Set';
    setBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const val = parseInt(input.value, 10);
        if (!val || val <= 0) return;
        const sec = val * parseInt(unitSelect.value, 10);
        for (const id of itemIds) await setLeadTime(id, ctx, sec);
        onUpdate();
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') setBtn.click();
    });

    customDiv.appendChild(input);
    customDiv.appendChild(unitSelect);
    customDiv.appendChild(setBtn);

    // Remove button (if existing lead time)
    if (existingLT != null) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'schedule-leadtime-remove';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove lead time';
        removeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            for (const id of itemIds) await setLeadTime(id, ctx, null);
            onUpdate();
        });
        customDiv.appendChild(removeBtn);
    }

    row.appendChild(customDiv);
    return row;
}

async function setLeadTime(itemId, ctx, seconds) {
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.contextLeadTimes) item.contextLeadTimes = {};
    if (seconds === null) {
        delete item.contextLeadTimes[ctx];
        if (Object.keys(item.contextLeadTimes).length === 0) delete item.contextLeadTimes;
    } else {
        item.contextLeadTimes[ctx] = seconds;
    }
    await api.patch(`/items/${itemId}`, { contextLeadTimes: item.contextLeadTimes || {} });
    renderAll();
}

// ─── Pressure Bar ───
function _formatDuration(mins) {
    if (mins >= 60) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m ? `${h}h${m}m` : `${h}h`;
    }
    return `${mins}m`;
}

function updateCapacitySummary(sortedActions) {
    const bar = document.getElementById('pressure-bar');
    const fill = document.getElementById('pressure-bar-fill');
    const label = document.getElementById('pressure-bar-label');
    if (!bar || !fill || !label) return;

    const undone = sortedActions.filter(a => !a.done);

    // Sum estimated durations (demand) — all undone items compete for available time
    const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;

    let demandMins = 0;
    const missingDurItems = [];
    for (const action of undone) {
        const item = findItemById(action.id);
        const ctxDur = getContextDuration(item);
        if (ctxDur) {
            demandMins += ctxDur;
        } else {
            missingDurItems.push({ id: action.id, name: action.name || item?.name || '?' });
        }
    }

    // ── Missing-duration indicator ──
    const missingEl = document.getElementById('pressure-bar-missing');
    if (missingEl) {
        if (missingDurItems.length > 0) {
            missingEl.textContent = `⏱ ${missingDurItems.length}`;
            missingEl.title = `${missingDurItems.length} item${missingDurItems.length !== 1 ? 's' : ''} without durations`;
            missingEl.classList.add('visible');
            missingEl._missingItems = missingDurItems;
            missingEl.onclick = () => showMissingDurationPopover(missingEl);
        } else {
            missingEl.classList.remove('visible');
            missingEl.onclick = null;
        }
    }

    // ── Epoch horizons: text-only, no bar ──
    if (state.viewHorizon === 'epoch') {
        bar.classList.add('pressure-bar-text-only');
        fill.style.width = '0%';
        fill.classList.remove('over-capacity');
        const epochLabels = { past: 'past', ongoing: 'backlog', future: 'aspirations' };
        label.textContent = demandMins > 0 ? `~${_formatDuration(demandMins)} ${epochLabels[state.epochFilter] || 'backlog'}` : `${undone.length} item${undone.length !== 1 ? 's' : ''}`;

        return;
    }
    bar.classList.remove('pressure-bar-text-only');

    // ── Determine available time ──
    let availMins = 0;

    if (focusedSession) {
        // Session focus: remaining time in the session
        const nowMs = Date.now();
        const remainMs = Math.max(0, focusedSession.endMs - nowMs);
        availMins = Math.round(remainMs / 60000);
    } else if (state.viewHorizon === 'week') {
        // Week: total waking hours × 7 (approximate)
        const { dayStart, dayEnd } = getDayBoundaries(state.timelineViewDate);
        const dayLenMins = Math.round((dayEnd.getTime() - dayStart.getTime()) / 60000);
        availMins = dayLenMins * 7;
    } else {
        // Day: free time gaps minus day-scoped intention durations
        availMins = calculateTotalFreeTime();

        // Subtract durations of fuzzy session items — items whose timeContexts
        // include a segment for today (or an overnight segment from yesterday
        // that's still live). Their contextDurations[segmentKey] tells us how
        // much free time they'll consume.
        const currentDateKey = getDateKey(state.timelineViewDate);
        const viewingToday = isCurrentDay(state.timelineViewDate);
        const nowMs = Date.now();
        const nowDate = new Date(nowMs);
        const allItems = collectAllItems(state.items.items);
        let fuzzySubtracted = 0;
        for (const item of allItems) {
            if (!item || item.done) continue;
            const contexts = item.timeContexts || [];
            const durations = item.contextDurations;
            if (!durations) continue;
            // Find segment contexts for today (including overnight from yesterday)
            for (const tc of contexts) {
                const parsed = parseTimeContext(tc);
                if (!parsed || !parsed.segment) continue;
                // Match segments whose date is today, OR overnight segments
                // from yesterday that are still live
                const isToday = parsed.date === currentDateKey;
                const isLiveOvernight = !isToday && _isOvernightSegmentLive(parsed, nowDate);
                if (!isToday && !isLiveOvernight) continue;
                // Skip past segments when past is hidden
                if (isPastHidden() && viewingToday && parsed.segment) {
                    const [, endStr] = [parsed.segment.start, parsed.segment.end];
                    const [eh, em] = endStr.split(':').map(Number);
                    const endDate = new Date(state.timelineViewDate);
                    endDate.setHours(eh, em, 0, 0);
                    // Handle overnight segments (end < start means next day)
                    if (endStr < parsed.segment.start) endDate.setDate(endDate.getDate() + 1);
                    if (endDate.getTime() < nowMs) continue;
                }
                // This item is in a fuzzy session for today — subtract its duration
                const dur = durations[tc];
                if (dur > 0) {
                    console.log('[pressure-bar] counting fuzzy:', item.id, item.name, tc, dur, 'mins');
                    fuzzySubtracted += dur;
                    availMins -= dur;
                }
            }
        }
        console.log('[pressure-bar] pastMode:', state.pastDisplayMode, 'viewingToday:', viewingToday, 'total fuzzy:', fuzzySubtracted);
        availMins = Math.max(0, availMins);
    }

    // ── Render bar ──
    if (availMins <= 0) {
        // No available time — show full bar as over-capacity if there's demand
        fill.style.width = demandMins > 0 ? '100%' : '0%';
        fill.classList.toggle('over-capacity', demandMins > 0);
        label.textContent = demandMins > 0 ? `${_formatDuration(demandMins)} / 0m` : '0m / 0m';
    } else {
        const fillPct = Math.min(100, (demandMins / availMins) * 100);
        fill.style.width = `${fillPct}%`;
        fill.classList.toggle('over-capacity', demandMins > availMins);
        label.textContent = `${_formatDuration(demandMins)} / ${_formatDuration(availMins)}`;
    }

}

function showMissingDurationPopover(anchorEl) {
    dismissDurationPicker();
    const items = anchorEl._missingItems;
    if (!items || items.length === 0) return;

    const overlay = document.createElement('div');
    overlay.className = 'duration-picker-overlay';
    overlay.addEventListener('click', dismissDurationPicker);

    const popover = document.createElement('div');
    popover.className = 'duration-picker missing-dur-popover';
    popover.addEventListener('click', (e) => e.stopPropagation());

    // Position relative to anchor
    const rect = anchorEl.getBoundingClientRect();
    const popW = 260;
    const popH = Math.min(items.length * 36 + 32, 320);
    let top = rect.bottom + 6;
    let left = rect.right - popW;
    if (left < 8) left = 8;
    if (top + popH > window.innerHeight - 8) top = rect.top - popH - 6;
    popover.style.position = 'fixed';
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.style.zIndex = '10001';
    popover.style.maxHeight = '320px';
    popover.style.overflowY = 'auto';
    popover.style.width = `${popW}px`;

    const title = document.createElement('div');
    title.className = 'duration-picker-title';
    title.textContent = 'Set durations';
    popover.appendChild(title);

    const presetValues = [5, 10, 15, 30, 60, 120];
    const presetLabels = ['5m', '10m', '15m', '30m', '1h', '2h'];

    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'missing-dur-row';

        // Remove-from-scope button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'missing-dur-remove';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove from current time scope';
        removeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const dateKey = getDateKey(state.timelineViewDate);
            if (state.viewHorizon === 'epoch') {
                // Epoch → just remove the epoch context
                const itm = findItemById(item.id);
                if (!itm) return;
                if (!itm.timeContexts) itm.timeContexts = [];
                itm.timeContexts = itm.timeContexts.filter(tc => tc !== state.epochFilter);
                await api.patch(`/items/${item.id}`, { timeContexts: itm.timeContexts });
            } else if (state.viewHorizon === 'week') {
                // Week → degrade to ongoing
                await sendToOngoing(item.id);
            } else {
                // Day view → degrade to week (remove date key, add week context)
                const weekKey = getWeekKey(state.timelineViewDate);
                await sendToWeek(item.id, weekKey);
            }
            row.remove();
            if (popover.querySelectorAll('.missing-dur-row').length === 0) {
                dismissDurationPicker();
            }
        });
        row.appendChild(removeBtn);

        const nameEl = document.createElement('span');
        nameEl.className = 'missing-dur-name';
        nameEl.textContent = item.name;

        const nameRow = document.createElement('div');
        nameRow.className = 'missing-dur-name-row';
        nameRow.appendChild(removeBtn);
        nameRow.appendChild(nameEl);
        row.appendChild(nameRow);

        const btns = document.createElement('div');
        btns.className = 'missing-dur-presets';
        for (let i = 0; i < presetValues.length; i++) {
            const btn = document.createElement('button');
            btn.className = 'missing-dur-preset';
            btn.textContent = presetLabels[i];
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await setEstimate(item.id, presetValues[i]);
                row.remove();
                // Auto-close when all done
                if (popover.querySelectorAll('.missing-dur-row').length === 0) {
                    dismissDurationPicker();
                }
            });
            btns.appendChild(btn);
        }
        row.appendChild(btns);
        popover.appendChild(row);
    }

    overlay.appendChild(popover);
    document.body.appendChild(overlay);
}

function calculateTotalFreeTime() {
    const { now, dayStart, dayEnd } = getDayBoundaries(state.timelineViewDate);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();
    const nowMs = now.getTime();
    const viewingToday = isCurrentDay(state.timelineViewDate);

    // Use nowMs as effective start when viewing today (only future free time matters)
    // Or if hiding past entries, ensure we don't count past time as free
    const effectiveStart = (viewingToday || isPastHidden()) ? Math.max(nowMs, dayStartMs) : dayStartMs;

    if (effectiveStart >= dayEndMs) return 0;

    // Collect all block entries in the day
    const blockEntries = (state.timeline?.entries || [])
        .filter(e => e.endTime && (e.type === 'work' || e.type === 'break' || e.type === 'planned') && !e._absorbed)
        .filter(e => e.timestamp < dayEndMs && e.endTime > effectiveStart)
        .sort((a, b) => a.timestamp - b.timestamp);

    // Add live work as a virtual block
    if (viewingToday && state.workingOn) {
        blockEntries.push({
            timestamp: state.workingOn.startTime,
            endTime: Math.max(nowMs, state.workingOn.targetEndTime || nowMs),
        });
        blockEntries.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Add live break as a virtual block
    if (viewingToday && state.onBreak) {
        blockEntries.push({
            timestamp: state.onBreak.startTime,
            endTime: Math.max(nowMs, state.onBreak.targetEndTime || nowMs),
        });
        blockEntries.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Sum gaps between blocks
    let totalFreeMs = 0;
    let cursor = effectiveStart;
    for (const entry of blockEntries) {
        const blockStart = Math.max(entry.timestamp, effectiveStart);
        const blockEnd = Math.min(entry.endTime, dayEndMs);
        if (blockStart > cursor) {
            totalFreeMs += blockStart - cursor;
        }
        cursor = Math.max(cursor, blockEnd);
    }
    // Trailing free time
    if (dayEndMs > cursor) {
        totalFreeMs += dayEndMs - cursor;
    }

    return Math.round(totalFreeMs / 60000);
}

function showBreakDurationPicker(anchorEl) {
    dismissDurationPicker();

    const overlay = document.createElement('div');
    overlay.className = 'duration-picker-overlay';
    overlay.addEventListener('click', dismissDurationPicker);

    const picker = document.createElement('div');
    picker.className = 'duration-picker';
    picker.addEventListener('click', (e) => e.stopPropagation());

    const rect = anchorEl.getBoundingClientRect();
    const pickerWidth = 200;
    const pickerHeight = 120;
    let top = rect.bottom + 4;
    let left = rect.left;
    if (left + pickerWidth > window.innerWidth - 8) {
        left = window.innerWidth - pickerWidth - 8;
    }
    if (left < 8) left = 8;
    if (top + pickerHeight > window.innerHeight - 8) {
        top = rect.top - pickerHeight - 4;
    }
    picker.style.position = 'fixed';
    picker.style.top = `${top}px`;
    picker.style.left = `${left}px`;
    picker.style.zIndex = '10001';

    const title = document.createElement('div');
    title.className = 'duration-picker-title';
    title.textContent = 'Timed break';
    picker.appendChild(title);

    // Overlap warning area
    const warning = document.createElement('div');
    warning.className = 'duration-picker-warning';
    warning.style.display = 'none';
    picker.appendChild(warning);

    // Preset buttons — shorter durations for breaks
    const presets = document.createElement('div');
    presets.className = 'duration-picker-presets';
    const presetValues = [
        { label: '5m', mins: 5 },
        { label: '10m', mins: 10 },
        { label: '15m', mins: 15 },
        { label: '30m', mins: 30 },
    ];
    for (const preset of presetValues) {
        const btn = document.createElement('button');
        btn.className = 'duration-picker-preset';
        btn.textContent = preset.label;
        btn.addEventListener('mouseenter', () => checkOverlap(preset.mins, warning));
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const targetEnd = Date.now() + preset.mins * 60000;
            dismissDurationPicker();
            await startBreak(targetEnd);
        });
        presets.appendChild(btn);
    }
    picker.appendChild(presets);

    // Eagerly check overlap for the shortest preset
    checkOverlap(presetValues[0].mins, warning);

    // Custom input row
    const customRow = document.createElement('div');
    customRow.className = 'duration-picker-custom';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'duration-picker-input';
    input.placeholder = 'min';
    input.min = '1';
    input.max = '120';
    input.addEventListener('input', () => {
        const mins = parseInt(input.value, 10);
        if (mins > 0) {
            checkOverlap(mins, warning);
        } else {
            warning.style.display = 'none';
        }
    });

    const minLabel = document.createElement('span');
    minLabel.className = 'duration-picker-min-label';
    minLabel.textContent = 'min';

    const startBtn = document.createElement('button');
    startBtn.className = 'duration-picker-start';
    startBtn.textContent = 'Start';
    startBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mins = parseInt(input.value, 10);
        if (!mins || mins <= 0) return;
        const targetEnd = Date.now() + mins * 60000;
        dismissDurationPicker();
        await startBreak(targetEnd);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') startBtn.click();
        if (e.key === 'Escape') dismissDurationPicker();
    });

    customRow.appendChild(input);
    customRow.appendChild(minLabel);
    customRow.appendChild(startBtn);
    picker.appendChild(customRow);

    overlay.appendChild(picker);
    document.body.appendChild(overlay);

    setTimeout(() => input.focus(), 50);
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

async function startWorking(itemId, itemName, projectName, targetEndTime) {
    // Sleep guard: confirm before starting work during sleep
    if (isInSleepRange() && state.settings.sleepGuard !== false) {
        if (!confirm('You\'re in sleep mode. Start working anyway?')) return;
    }
    // If already working on something else, stop it first
    if (state.workingOn) {
        await stopWorking();
    }
    // If on a break, stop it first
    if (state.onBreak) {
        await stopBreak();
    }
    const now = Date.now();
    state.workingOn = {
        itemId,
        itemName,
        projectName: projectName || null,
        startTime: now,
        targetEndTime: targetEndTime || null,
    };
    savePref('workingOn', state.workingOn);
    renderAll();
}

async function stopWorking() {
    if (!state.workingOn) return;

    const endTime = Date.now();
    const durationMs = endTime - state.workingOn.startTime;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    // Create timeline entry on stop
    const entry = await api.post('/timeline', {
        text: `Worked on: ${state.workingOn.itemName} (${durStr})`,
        projectName: state.workingOn.projectName,
        type: 'work',
        startTime: state.workingOn.startTime,
        endTime: endTime,
        targetEndTime: state.workingOn.targetEndTime || undefined,
        itemId: state.workingOn.itemId,
    });
    state.timeline.entries.push(entry);

    // Degrade all @work contexts back to the day context
    await _degradeLiveContexts('work');

    // Clear working state
    state.workingOn = null;
    savePref('workingOn', null);
    renderAll();
}

// restoreWorkingOn — now handled in loadAll() from backend preferences

// ─── Break Timer ───

async function startBreak(targetEndTime) {
    // If working on something, stop it first
    if (state.workingOn) {
        await stopWorking();
    }
    const now = Date.now();
    state.onBreak = {
        startTime: now,
        targetEndTime: targetEndTime || null,
    };
    savePref('onBreak', state.onBreak);
    renderAll();
}

async function stopBreak() {
    if (!state.onBreak) return;

    const endTime = Date.now();
    const durationMs = endTime - state.onBreak.startTime;
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);
    const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    // Create timeline entry on stop
    const entry = await api.post('/timeline', {
        text: `Break (${durStr})`,
        type: 'break',
        startTime: state.onBreak.startTime,
        endTime: endTime,
        targetEndTime: state.onBreak.targetEndTime || undefined,
    });
    state.timeline.entries.push(entry);

    // Degrade all @break contexts back to the day context
    await _degradeLiveContexts('break');

    // Clear break state
    state.onBreak = null;
    savePref('onBreak', null);
    renderAll();
}

// restoreBreak — now handled in loadAll() from backend preferences

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
        widget.title = `Close your day to continue your ${streak.count}-day streak!`;
    } else {
        widget.title = 'Close your day to start a streak!';
    }

    // Celebration animation for milestones
    if (checkedInToday && [3, 5, 7, 10, 14, 21, 30, 50, 100].includes(streak.count)) {
        widget.classList.add('streak-milestone');
        setTimeout(() => widget.classList.remove('streak-milestone'), 1500);
    }
}

// ─── Skin Switching ───
const SKIN_FAMILIES = {
    duolingo: { light: 'skins/duolingo.css', dark: 'skins/duolingo-dark.css' },
    modern: { light: 'skins/modern.css', dark: 'skins/modern.css' },
    win95: { light: 'skins/win95.css', dark: 'skins/win95.css' },
    pencil: { light: 'skins/pencil.css', dark: 'skins/pencil.css' },
};

// Current skin state (populated in initSkin)
let _skinFamily = 'duolingo';
let _darkMode = 'auto'; // 'auto' | 'light' | 'dark'

function _getEffectiveMode() {
    if (_darkMode === 'auto') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return _darkMode;
}

function _resolveSkin() {
    const link = document.getElementById('skin-stylesheet');
    if (!link) return;
    const family = SKIN_FAMILIES[_skinFamily] || SKIN_FAMILIES.duolingo;
    const mode = _getEffectiveMode();
    link.href = family[mode] || family.light;
    _updateDarkModeToggleIcon();
}

function _updateDarkModeToggleIcon() {
    const btn = document.getElementById('dark-mode-toggle');
    if (!btn) return;
    const mode = _getEffectiveMode();
    btn.textContent = mode === 'dark' ? '☀️' : '🌙';
    btn.title = _darkMode === 'auto'
        ? `Auto (${mode}) — click to override`
        : `${mode === 'dark' ? 'Dark' : 'Light'} mode — click to toggle`;
}

function applySkinFamily(familyId) {
    if (!SKIN_FAMILIES[familyId]) return;
    _skinFamily = familyId;
    savePref('skinFamily', _skinFamily);
    _resolveSkin();
}

function toggleDarkMode() {
    // Simple flip: always toggle the visible appearance
    const current = _getEffectiveMode();
    _darkMode = current === 'dark' ? 'light' : 'dark';
    savePref('darkMode', _darkMode);
    _resolveSkin();
}

async function initSkin() {
    // Load preferences from backend
    let savedFamily = 'duolingo';
    let savedDarkMode = 'auto';
    try {
        const prefs = await api.get('/preferences');
        // Migration: old 'skin' pref → new family system
        if (prefs.skinFamily) {
            savedFamily = prefs.skinFamily;
        } else if (prefs.skin) {
            // Map old skin ids to families
            if (prefs.skin === 'duolingo-dark') {
                savedFamily = 'duolingo';
                savedDarkMode = 'dark';
            } else if (SKIN_FAMILIES[prefs.skin]) {
                savedFamily = prefs.skin;
            }
        }
        if (prefs.darkMode) savedDarkMode = prefs.darkMode;
    } catch { /* use defaults */ }

    _skinFamily = savedFamily;
    _darkMode = savedDarkMode;
    _resolveSkin();

    // Dark mode toggle button
    const toggleBtn = document.getElementById('dark-mode-toggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => toggleDarkMode());
    }

    // OS-level preference listener
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (_darkMode === 'auto') _resolveSkin();
    });
}

// ─── Panel Resize (Draggable Dividers) ───
const panelResize = {
    MIN_SIDEBAR: 120,
    MAX_SIDEBAR: 500,
    leftWidth: null,
    rightWidth: null,

    async init() {
        // Load panel widths from backend preferences
        try {
            const prefs = await api.get('/preferences');
            if (prefs.panels) {
                this.leftWidth = prefs.panels.left;
                this.rightWidth = prefs.panels.right;
            }
        } catch { /* ignore */ }

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
        savePref('panels', {
            left: this.leftWidth,
            right: this.rightWidth,
        });
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
function openScheduleModal(itemIdOrIds, itemName) {
    // Close if already open
    const existing = document.getElementById('schedule-modal-overlay');
    if (existing) existing.remove();

    // Normalize to array
    const itemIds = Array.isArray(itemIdOrIds) ? itemIdOrIds : [itemIdOrIds];

    // Track assigned contexts for visual feedback
    function getAssignedContexts() {
        const sets = itemIds.map(id => {
            const itm = findItemById(id);
            return new Set((itm && itm.timeContexts) || []);
        });
        if (sets.length === 1) return sets[0];
        const result = new Set();
        for (const d of sets[0]) {
            if (sets.every(s => s.has(d))) result.add(d);
        }
        return result;
    }

    let assignedContexts = getAssignedContexts();

    // Schedule mode: 'one-time' (replace) vs 'multi' (additive)
    let scheduleMode = 'one-time';

    // Calendar state
    const calNow = new Date(state.timelineViewDate);
    let viewYear = calNow.getFullYear();
    let viewMonth = calNow.getMonth();

    // Session date nav state (independent)
    let sessionViewDate = new Date(state.timelineViewDate);

    // Week nav state (independent)
    let weekViewDate = new Date(state.timelineViewDate);

    const overlay = document.createElement('div');
    overlay.id = 'schedule-modal-overlay';
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-box schedule-modal-box';

    // ── Helpers ──

    function isEpochAssigned(ep) {
        return assignedContexts.has(ep);
    }
    function isOngoingAssigned() {
        return isEpochAssigned('ongoing');
    }

    function getSessionDateKey() {
        return getDateKey(sessionViewDate);
    }

    function formatSessionDate(d) {
        const dk = getDateKey(d);
        const todayKey = getDateKey(getLogicalToday());
        if (dk === todayKey) return 'Today';
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    function getPlannedBlocksForDate(d) {
        const { dayStart, dayEnd } = getDayBoundaries(d);
        return (state.timeline?.entries || [])
            .filter(e => e.type === 'planned' && e.endTime &&
                e.timestamp >= dayStart.getTime() && e.timestamp < dayEnd.getTime())
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    function formatTime(ms) {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function segmentKeyForBlock(block) {
        return `${getDateKey(new Date(block.timestamp))}@${formatTime(block.timestamp)}-${formatTime(block.endTime)}`;
    }

    // ── Mutate helpers ──

    async function setContexts(newContexts) {
        for (const id of itemIds) {
            const itm = findItemById(id);
            if (itm) {
                itm.timeContexts = [...newContexts];
                await api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
            }
        }
        assignedContexts = getAssignedContexts();
        buildContent();
    }

    async function toggleEpoch(epochName) {
        if (isEpochAssigned(epochName)) {
            // Remove this epoch
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => tc !== epochName);
                    await api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        } else {
            // Set to this epoch — remove all date/segment contexts
            await setContexts([epochName]);
            return;
        }
        assignedContexts = getAssignedContexts();
        buildContent();
    }

    async function toggleOngoing() { return toggleEpoch('ongoing'); }

    function getScheduleWeekKey() {
        return getWeekKey(weekViewDate);
    }

    function formatWeekRange(d) {
        const wk = getWeekKey(d);
        const range = getWeekDateRange(wk);
        if (!range) return '';
        const fmt = (dt) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `${fmt(range.start)} – ${fmt(range.end)}`;
    }

    async function toggleWeek() {
        const wk = getScheduleWeekKey();
        if (assignedContexts.has(wk)) {
            // Remove this week context
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => tc !== wk);
                    await api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        } else if (scheduleMode === 'one-time') {
            // One-time: replace all contexts with just this week
            await setContexts([wk]);
            return;
        } else {
            // Multi: add week context, remove ongoing
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => !EPOCH_CONTEXTS.includes(tc));
                    if (!itm.timeContexts.includes(wk)) itm.timeContexts.push(wk);
                    await api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        }
        assignedContexts = getAssignedContexts();
        buildContent();
    }

    async function toggleDate(dateKey) {
        if (assignedContexts.has(dateKey)) {
            // Remove this date and any segments for it
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => tc !== dateKey && !tc.startsWith(dateKey + '@'));
                    await api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        } else if (scheduleMode === 'one-time') {
            // One-time: replace all contexts with just this date
            await setContexts([dateKey]);
            return;
        } else {
            // Multi: add date, remove ongoing
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => !EPOCH_CONTEXTS.includes(tc));
                    if (!itm.timeContexts.includes(dateKey)) itm.timeContexts.push(dateKey);
                    await api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        }
        assignedContexts = getAssignedContexts();
        buildContent();
    }

    async function toggleDeadline(dateKey) {
        const sampleItem = findItemById(itemIds[0]);
        const isDeadline = sampleItem?.contextLeadTimes?.[dateKey] != null;
        if (isDeadline) {
            // Animate deadline bar out before removing
            const dlWrapper = modal.querySelector('.schedule-deadline-bar-wrapper');
            if (dlWrapper) {
                dlWrapper.classList.remove('has-deadline');
                await new Promise(r => { dlWrapper.addEventListener('transitionend', r, { once: true }); setTimeout(r, 300); });
            }
            for (const id of itemIds) await setLeadTime(id, dateKey, null);
        } else {
            // Enforce single deadline: remove any existing deadline first
            if (sampleItem?.contextLeadTimes) {
                // Animate out existing bar before switching deadlines
                const dlWrapper = modal.querySelector('.schedule-deadline-bar-wrapper');
                if (dlWrapper) dlWrapper.classList.remove('has-deadline');
                await new Promise(r => setTimeout(r, 260));
                for (const existingCtx of Object.keys(sampleItem.contextLeadTimes)) {
                    for (const id of itemIds) await setLeadTime(id, existingCtx, null);
                }
            }
            for (const id of itemIds) await setLeadTime(id, dateKey, 0);
        }
        buildContent();
    }

    async function toggleSession(block) {
        const segKey = segmentKeyForBlock(block);
        const dateKey = getDateKey(new Date(block.timestamp));
        if (assignedContexts.has(segKey)) {
            // Remove this segment
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => tc !== segKey);
                    await api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        } else if (scheduleMode === 'one-time') {
            // One-time: replace all contexts with just this session + its date
            await setContexts([dateKey, segKey]);
            return;
        } else {
            // Multi: add segment + date, remove ongoing
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => !EPOCH_CONTEXTS.includes(tc));
                    if (!itm.timeContexts.includes(dateKey)) itm.timeContexts.push(dateKey);
                    if (!itm.timeContexts.includes(segKey)) itm.timeContexts.push(segKey);
                    await api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        }
        assignedContexts = getAssignedContexts();
        buildContent();
    }

    // ── Build UI ──

    function buildContent() {
        const todayKey = getDateKey(getLogicalToday());
        const todayDate = getLogicalToday();
        const currentMonth = todayDate.getMonth();
        const currentYear = todayDate.getFullYear();
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

        const canGoPrev = viewYear > currentYear || (viewYear === currentYear && viewMonth > currentMonth);
        const firstDay = new Date(viewYear, viewMonth, 1).getDay();
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

        // Session section data
        const sessionDateStr = formatSessionDate(sessionViewDate);
        const sessionBlocks = getPlannedBlocksForDate(sessionViewDate);
        const sessionDateKey = getSessionDateKey();
        const canSessionPrev = sessionDateKey > todayKey;

        // Snapshot current open/closed state of <details> sections before rebuild
        const detailsSections = modal.querySelectorAll('details.schedule-section');
        const prevOpenState = {};
        let hasSnapshot = detailsSections.length > 0;
        detailsSections.forEach(det => {
            const key = det.dataset.tier || '';
            prevOpenState[key] = det.open;
        });

        // Determine which tiers already have assignments (used for first render only)
        const hasOngoing = isEpochAssigned('ongoing');
        const hasFuture = isEpochAssigned('future');
        const hasPast = isEpochAssigned('past');
        const hasAnyEpoch = hasOngoing || hasFuture || hasPast;
        const hasWeek = [...assignedContexts].some(tc => isWeekContext(tc));
        const hasDate = [...assignedContexts].some(tc => /^\d{4}-\d{2}-\d{2}$/.test(tc));
        const hasSession = [...assignedContexts].some(tc => tc.includes('@'));

        // Count assigned contexts per tier (for badges on collapsed headers)
        const countEpoch = (hasOngoing ? 1 : 0) + (hasFuture ? 1 : 0) + (hasPast ? 1 : 0);
        const countWeek = [...assignedContexts].filter(tc => isWeekContext(tc)).length;
        const countDay = [...assignedContexts].filter(tc => /^\d{4}-\d{2}-\d{2}$/.test(tc)).length;
        const countSession = [...assignedContexts].filter(tc => tc.includes('@')).length;
        function badgeHtml(count) {
            return count > 0 ? `<span class="schedule-section-badge">${count}</span>` : '';
        }

        // Week section data
        const scheduleWk = getScheduleWeekKey();
        const weekRangeLabel = formatWeekRange(weekViewDate);
        const isWeekAssigned = assignedContexts.has(scheduleWk);
        const currentWeekKey = getWeekKey(getLogicalToday());
        const canWeekPrev = scheduleWk > currentWeekKey;

        // Compute lead-time prep windows for calendar highlighting
        const sampleItem = findItemById(itemIds[0]);
        const leadTimeWindows = new Map(); // dateKey -> true (prep day)
        const deadlineContexts = new Set(); // dateKeys that are deadlines
        if (sampleItem?.contextLeadTimes) {
            for (const [ctx, leadSec] of Object.entries(sampleItem.contextLeadTimes)) {
                const deadlineDate = parseDateFromContext(ctx);
                if (!deadlineDate) continue;
                deadlineContexts.add(ctx);
                if (leadSec <= 0) continue;
                const startDate = new Date(deadlineDate.getTime() - leadSec * 1000);
                const iter = new Date(startDate);
                iter.setHours(0, 0, 0, 0);
                const deadlineKey = getDateKey(deadlineDate);
                while (getDateKey(iter) < deadlineKey) {
                    leadTimeWindows.set(getDateKey(iter), true);
                    iter.setDate(iter.getDate() + 1);
                }
            }
        }

        // Week lead time chip label
        const weekLeadTimeSec = sampleItem ? getContextLeadTime(sampleItem, scheduleWk) : null;
        const weekLTLabel = weekLeadTimeSec != null ? `⏱ ${_formatLeadTimeBrief(weekLeadTimeSec)}` : null;

        function sectionOpen(tier, fallback) {
            return hasSnapshot ? (prevOpenState[tier] ?? fallback) : fallback;
        }

        // ── Ongoing section ──
        let html = `
            <div class="modal-header">Schedule: ${itemName}</div>
            <div class="modal-body schedule-modal-body">
                <div class="schedule-mode-toggle">
                    <button class="schedule-mode-btn${scheduleMode === 'one-time' ? ' schedule-mode-btn-active' : ''}" data-mode="one-time">One-time</button>
                    <button class="schedule-mode-btn${scheduleMode === 'multi' ? ' schedule-mode-btn-active' : ''}" data-mode="multi">Multi</button>
                </div>
                <details class="schedule-section" data-tier="epoch"${sectionOpen('epoch', hasAnyEpoch) ? ' open' : ''}>
                    <summary class="schedule-section-header">🌐 Epoch${badgeHtml(countEpoch)}</summary>
                    <div class="schedule-section-content-wrapper"><div class="schedule-section-content">
                        ${hasPast ? `<div class="schedule-epoch-toggle schedule-epoch-past schedule-epoch-active" data-epoch="past">
                            📜 Past (auto-assigned)
                        </div>` : ''}
                        <div class="schedule-epoch-toggle ${hasOngoing ? 'schedule-epoch-active' : ''}" data-epoch="ongoing" id="schedule-epoch-ongoing-btn">
                            📦 ${hasOngoing ? '✓ Ongoing' : 'Move to Ongoing'}
                        </div>
                        <div class="schedule-epoch-toggle ${hasFuture ? 'schedule-epoch-active' : ''}" data-epoch="future" id="schedule-epoch-future-btn">
                            🔮 ${hasFuture ? '✓ Future' : 'Move to Future'}
                        </div>
                    </div></div>
                </details>
        `;

        // ── Week section ──
        html += `
                <details class="schedule-section" data-tier="week"${sectionOpen('week', hasWeek) ? ' open' : ''}>
                    <summary class="schedule-section-header">📆 Week${badgeHtml(countWeek)}</summary>
                    <div class="schedule-section-content-wrapper"><div class="schedule-section-content">
                        <div class="schedule-week-nav">
                            <button class="schedule-cal-nav-btn${canWeekPrev ? '' : ' schedule-cal-nav-btn-disabled'}" id="schedule-week-prev"${canWeekPrev ? '' : ' disabled'}>‹</button>
                            <span class="schedule-week-label">${weekRangeLabel}</span>
                            <button class="schedule-cal-nav-btn" id="schedule-week-next">›</button>
                        </div>
                        <div class="schedule-week-toggle ${isWeekAssigned ? 'schedule-week-active' : ''}" id="schedule-week-btn">
                            ${isWeekAssigned ? '✓ Assigned to this Week' : 'Assign to this Week'}
                        </div>
                    </div></div>
                </details>
        `;

        // ── Day section ──
        html += `
                <details class="schedule-section" data-tier="day"${sectionOpen('day', hasDate) ? ' open' : ''}>
                    <summary class="schedule-section-header">📅 Day${badgeHtml(countDay)}</summary>
                    <div class="schedule-section-content-wrapper"><div class="schedule-section-content">
                        <div class="schedule-cal-nav">
                            <button class="schedule-cal-nav-btn${canGoPrev ? '' : ' schedule-cal-nav-btn-disabled'}" id="schedule-prev-month"${canGoPrev ? '' : ' disabled'}>‹</button>
                            <span class="schedule-cal-month">${monthNames[viewMonth]} ${viewYear}</span>
                            <button class="schedule-cal-nav-btn" id="schedule-next-month">›</button>
                        </div>
                        <div class="schedule-cal-grid">
        `;

        for (const dn of dayNames) {
            html += `<div class="schedule-cal-header">${dn}</div>`;
        }
        for (let i = 0; i < firstDay; i++) {
            html += `<div class="schedule-cal-empty"></div>`;
        }
        for (let d = 1; d <= daysInMonth; d++) {
            const dateKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const isAssigned = assignedContexts.has(dateKey);
            const isDeadline = deadlineContexts.has(dateKey);
            const isToday = dateKey === todayKey;
            const isPast = dateKey < todayKey;
            const isLeadTimePrep = !isAssigned && !isDeadline && leadTimeWindows.has(dateKey);
            let cls = 'schedule-cal-day';
            if (isPast) cls += ' schedule-cal-day-disabled';
            if (isAssigned) cls += ' schedule-cal-day-assigned';
            if (isDeadline) cls += ' schedule-cal-day-deadline';
            if (isLeadTimePrep) cls += ' schedule-cal-day-leadtime';
            if (isToday) cls += ' schedule-cal-day-today';
            // 🎯 button appears on hover for non-past days
            const deadlineBtn = !isPast ? `<button class="schedule-cal-deadline-btn" data-deadline-date="${dateKey}" title="${isDeadline ? 'Remove deadline' : 'Set as deadline'}">🎯</button>` : '';
            html += `<div class="${cls}" data-date="${dateKey}">${d}${deadlineBtn}</div>`;
        }
        // Pad only to complete the last row (no fixed 6-row height)
        const totalCells = firstDay + daysInMonth;
        const padCells = (7 - (totalCells % 7)) % 7;
        for (let i = 0; i < padCells; i++) {
            html += `<div class="schedule-cal-empty"></div>`;
        }

        html += `
                        </div>
                    </div></div>
                </details>
        `;

        // ── Inline deadline bar (single deadline) ──
        const deadlineCtx = [...deadlineContexts].find(dk => /^\d{4}-\d{2}-\d{2}$/.test(dk));
        let dlBarInner = '';
        if (deadlineCtx) {
            const dlDate = new Date(deadlineCtx + 'T00:00:00');
            const monthNames2 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const dlLabel = `${monthNames2[dlDate.getMonth()]} ${dlDate.getDate()}`;
            const existingLT = getContextLeadTime(sampleItem, deadlineCtx);
            let ltDisplayVal = '';
            let ltUnitSec = 86400;
            if (existingLT && existingLT > 0) {
                if (existingLT % 604800 === 0) {
                    ltDisplayVal = existingLT / 604800;
                    ltUnitSec = 604800;
                } else {
                    ltDisplayVal = Math.round(existingLT / 86400);
                    ltUnitSec = 86400;
                }
            }
            dlBarInner = `
                <div class="schedule-deadline-bar">
                    <div class="schedule-deadline-bar-row1">
                        <span class="schedule-deadline-bar-label">🎯 ${dlLabel}</span>
                    </div>
                    <div class="schedule-deadline-bar-row2">
                        <span class="schedule-deadline-bar-text">start preparing</span>
                        <input type="number" class="schedule-deadline-custom-input" id="schedule-dl-custom-val" value="${ltDisplayVal}" placeholder="0" min="0" max="999">
                        <select class="schedule-deadline-custom-unit" id="schedule-dl-custom-unit">
                            <option value="86400"${ltUnitSec === 86400 ? ' selected' : ''}>days</option>
                            <option value="604800"${ltUnitSec === 604800 ? ' selected' : ''}>weeks</option>
                        </select>
                        <span class="schedule-deadline-bar-text">before</span>
                    </div>
                    <div class="schedule-deadline-bar-row3">
                        <button class="schedule-deadline-custom-set" id="schedule-dl-custom-set">✓</button>
                        <button class="schedule-deadline-remove" data-deadline-rm="${deadlineCtx}" title="Remove deadline">×</button>
                    </div>
                </div>`;
        }
        html += `<div class="schedule-deadline-bar-wrapper">${dlBarInner}</div>`;

        // ── Session section ──
        html += `
                <details class="schedule-section" data-tier="session"${sectionOpen('session', hasSession) ? ' open' : ''}>
                    <summary class="schedule-section-header">⏱️ Session${badgeHtml(countSession)}</summary>
                    <div class="schedule-section-content-wrapper"><div class="schedule-section-content">
                        <div class="schedule-session-nav">
                            <button class="schedule-cal-nav-btn${canSessionPrev ? '' : ' schedule-cal-nav-btn-disabled'}" id="schedule-session-prev"${canSessionPrev ? '' : ' disabled'}>‹</button>
                            <span class="schedule-session-date">${sessionDateStr}</span>
                            <button class="schedule-cal-nav-btn" id="schedule-session-next">›</button>
                        </div>
                        <div class="schedule-session-list">
        `;

        if (sessionBlocks.length === 0) {
            html += `<div class="schedule-session-empty">No planned sessions</div>`;
        } else {
            for (const block of sessionBlocks) {
                const segKey = segmentKeyForBlock(block);
                const isAssigned = assignedContexts.has(segKey);
                const label = block.text || 'Planned';
                const timeRange = `${formatTime(block.timestamp)} – ${formatTime(block.endTime)}`;
                html += `<div class="schedule-session-item${isAssigned ? ' schedule-session-item-assigned' : ''}" data-seg-key="${segKey}" data-block-ts="${block.timestamp}">
                    <span class="schedule-session-icon">📌</span>
                    <span class="schedule-session-label">${label}</span>
                    <span class="schedule-session-time">${timeRange}</span>
                </div>`;
            }
        }

        html += `
                        </div>
                    </div></div>
                </details>
            </div>
            <div class="modal-actions">
                <button class="modal-btn modal-btn-cancel" id="schedule-close">Close</button>
            </div>
        `;

        modal.innerHTML = html;

        // Animate deadline bar entrance via rAF
        requestAnimationFrame(() => {
            const dlWrapper = modal.querySelector('.schedule-deadline-bar-wrapper');
            if (dlWrapper && dlWrapper.children.length > 0) dlWrapper.classList.add('has-deadline');
        });

        // ── Wire up events ──

        // Mode toggle
        modal.querySelectorAll('.schedule-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                scheduleMode = btn.dataset.mode;
                buildContent();
            });
        });

        // Epoch toggles (ongoing + future only — past is auto)
        modal.querySelector('#schedule-epoch-ongoing-btn')?.addEventListener('click', () => toggleEpoch('ongoing'));
        modal.querySelector('#schedule-epoch-future-btn')?.addEventListener('click', () => toggleEpoch('future'));

        // Week toggle
        modal.querySelector('#schedule-week-btn')?.addEventListener('click', toggleWeek);

        // Week nav
        if (canWeekPrev) {
            modal.querySelector('#schedule-week-prev').addEventListener('click', () => {
                weekViewDate = new Date(weekViewDate);
                weekViewDate.setDate(weekViewDate.getDate() - 7);
                buildContent();
            });
        }
        modal.querySelector('#schedule-week-next')?.addEventListener('click', () => {
            weekViewDate = new Date(weekViewDate);
            weekViewDate.setDate(weekViewDate.getDate() + 7);
            buildContent();
        });

        // Calendar month nav
        function buildContentAnimateCal() {
            const oldGrid = modal.querySelector('.schedule-cal-grid');
            const oldH = oldGrid ? oldGrid.offsetHeight : null;
            buildContent();
            if (oldH != null) {
                const newGrid = modal.querySelector('.schedule-cal-grid');
                if (newGrid) {
                    const newH = newGrid.offsetHeight;
                    if (oldH !== newH) {
                        newGrid.style.height = oldH + 'px';
                        newGrid.style.overflow = 'hidden';
                        newGrid.style.transition = 'height 200ms ease';
                        requestAnimationFrame(() => requestAnimationFrame(() => {
                            newGrid.style.height = newH + 'px';
                            newGrid.addEventListener('transitionend', () => {
                                newGrid.style.height = '';
                                newGrid.style.overflow = '';
                                newGrid.style.transition = '';
                            }, { once: true });
                        }));
                    }
                }
            }
        }
        if (canGoPrev) {
            modal.querySelector('#schedule-prev-month').addEventListener('click', () => {
                viewMonth--;
                if (viewMonth < 0) { viewMonth = 11; viewYear--; }
                buildContentAnimateCal();
            });
        }
        modal.querySelector('#schedule-next-month').addEventListener('click', () => {
            viewMonth++;
            if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            buildContentAnimateCal();
        });

        // Day clicks — click the day number to toggle work assignment
        modal.querySelectorAll('.schedule-cal-day:not(.schedule-cal-day-disabled)').forEach(cell => {
            cell.addEventListener('click', (e) => {
                // Don't toggle work day if the deadline button was clicked
                if (e.target.classList.contains('schedule-cal-deadline-btn')) return;
                toggleDate(cell.dataset.date);
            });
        });

        // 🎯 Deadline buttons on calendar days
        modal.querySelectorAll('.schedule-cal-deadline-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDeadline(btn.dataset.deadlineDate);
            });
        });

        // Deadline section — preset buttons
        modal.querySelectorAll('.schedule-deadline-preset').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ctx = btn.dataset.dlCtx;
                const sec = parseInt(btn.dataset.dlSec, 10);
                const currentLT = getContextLeadTime(sampleItem, ctx);
                // Toggle: if already set to this value, remove it
                const newSec = currentLT === sec ? 0 : sec;
                for (const id of itemIds) await setLeadTime(id, ctx, newSec || 0);
                buildContent();
            });
        });

        // Deadline section — remove buttons
        modal.querySelectorAll('.schedule-deadline-remove').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ctx = btn.dataset.deadlineRm;
                // Animate out, then remove and rebuild
                const dlWrapper = modal.querySelector('.schedule-deadline-bar-wrapper');
                if (dlWrapper) {
                    dlWrapper.classList.remove('has-deadline');
                    await new Promise(r => { dlWrapper.addEventListener('transitionend', r, { once: true }); setTimeout(r, 300); });
                }
                for (const id of itemIds) await setLeadTime(id, ctx, null);
                buildContent();
            });
        });

        // Deadline bar — custom input
        const dlCustomSet = modal.querySelector('#schedule-dl-custom-set');
        if (dlCustomSet) {
            const apply = async () => {
                const val = parseInt(modal.querySelector('#schedule-dl-custom-val')?.value, 10);
                if (!val || val <= 0) return;
                const unit = parseInt(modal.querySelector('#schedule-dl-custom-unit')?.value, 10);
                const sec = val * unit;
                const ctx = [...deadlineContexts].find(dk => /^\d{4}-\d{2}-\d{2}$/.test(dk));
                if (!ctx) return;
                for (const id of itemIds) await setLeadTime(id, ctx, sec);
                buildContent();
            };
            dlCustomSet.addEventListener('click', (e) => { e.stopPropagation(); apply(); });
            modal.querySelector('#schedule-dl-custom-val')?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.stopPropagation(); apply(); }
            });
        }

        // Session date nav
        if (canSessionPrev) {
            modal.querySelector('#schedule-session-prev').addEventListener('click', () => {
                sessionViewDate = new Date(sessionViewDate);
                sessionViewDate.setDate(sessionViewDate.getDate() - 1);
                buildContent();
            });
        }
        modal.querySelector('#schedule-session-next').addEventListener('click', () => {
            sessionViewDate = new Date(sessionViewDate);
            sessionViewDate.setDate(sessionViewDate.getDate() + 1);
            buildContent();
        });

        // Session block clicks
        modal.querySelectorAll('.schedule-session-item').forEach(row => {
            row.addEventListener('click', () => {
                const ts = Number(row.dataset.blockTs);
                const block = sessionBlocks.find(b => b.timestamp === ts);
                if (block) toggleSession(block);
            });
        });

        // Animated accordion — click summary to toggle with smooth animation
        modal.querySelectorAll('details.schedule-section').forEach(det => {
            const summary = det.querySelector('summary');
            summary.addEventListener('click', (e) => {
                e.preventDefault();
                const wrapper = det.querySelector('.schedule-section-content-wrapper');
                if (det.open) {
                    // Collapse: animate grid-template-rows 1fr → 0fr, then remove open
                    det.classList.add('schedule-section-closing');
                    let done = false;
                    const finish = () => {
                        if (done) return;
                        done = true;
                        det.open = false;
                        det.classList.remove('schedule-section-closing');
                    };
                    wrapper.addEventListener('transitionend', finish, { once: true });
                    setTimeout(finish, 300);
                } else {
                    // Close others first (accordion)
                    modal.querySelectorAll('details.schedule-section').forEach(other => {
                        if (other !== det && other.open) {
                            other.classList.add('schedule-section-closing');
                            const ow = other.querySelector('.schedule-section-content-wrapper');
                            let oDone = false;
                            const oFinish = () => {
                                if (oDone) return;
                                oDone = true;
                                other.open = false;
                                other.classList.remove('schedule-section-closing');
                            };
                            ow.addEventListener('transitionend', oFinish, { once: true });
                            setTimeout(oFinish, 300);
                        }
                    });
                    // Open this one — force wrapper to 0fr first, then let CSS transition to 1fr
                    wrapper.style.gridTemplateRows = '0fr';
                    det.open = true;
                    // Force reflow so browser registers the 0fr starting point
                    wrapper.offsetHeight;
                    // Remove inline style to let the CSS [open] rule (1fr) take over and animate
                    wrapper.style.gridTemplateRows = '';
                }
            });
        });

        // (Old inline lead-time rows removed — replaced by Deadlines section above)

        // Close
        modal.querySelector('#schedule-close').addEventListener('click', () => {
            overlay.remove();
            renderAll();
        });
    }

    buildContent();
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

// ─── Move To Modal ───
function openMoveToModal(itemId, itemName) {
    const existing = document.getElementById('move-to-modal-overlay');
    if (existing) existing.remove();

    const movingItem = findItemById(itemId);
    if (!movingItem) return;

    // Collect IDs of the item and all descendants (can't move into yourself)
    const excludedIds = new Set(collectDescendantIds(movingItem));

    // Local expand state — never touches item objects, so nothing leaks to JSON
    const expandedMap = new Map();
    function initExpandState(items) {
        for (const it of items) {
            expandedMap.set(it.id, !!it.expanded);
            if (it.children && it.children.length > 0) initExpandState(it.children);
        }
    }
    initExpandState(state.items.items);

    // Search state
    let searchQuery = '';

    // Check if an item or any descendant matches the search query
    function itemMatchesSearch(item, query) {
        if (!query) return true;
        const q = query.toLowerCase();
        if (item.name && item.name.toLowerCase().includes(q)) return true;
        if (item.children) {
            for (const child of item.children) {
                if (!excludedIds.has(child.id) && itemMatchesSearch(child, query)) return true;
            }
        }
        return false;
    }

    const overlay = document.createElement('div');
    overlay.id = 'move-to-modal-overlay';
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-box move-to-modal-box';

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.textContent = `Move: ${itemName}`;
    modal.appendChild(header);

    // ── Search Input ──
    const searchWrap = document.createElement('div');
    searchWrap.className = 'move-to-search';
    const searchInput = document.createElement('input');
    searchInput.className = 'move-to-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search...';
    searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value.trim();
        rebuildTree();
    });
    searchWrap.appendChild(searchInput);
    modal.appendChild(searchWrap);

    // ── Body — scrollable tree ──
    const body = document.createElement('div');
    body.className = 'modal-body move-to-body';

    const tree = document.createElement('div');
    tree.className = 'move-to-tree';

    function performMove(targetId, position) {
        const success = moveItem(itemId, { id: targetId, position });
        if (success) {
            saveItems();
            renderAll();
            // Optionally select + scroll to the moved item
            if (scrollCheckbox && scrollCheckbox.checked) {
                state.selectedItemId = itemId;
                savePref('selectedItemId', itemId);
                scrollToSelectedItem();
            }
        }
        overlay.remove();
    }

    // ── Create a marker line ──
    function createMoveMarker(siblingArray, insertIdx, depth) {
        const marker = document.createElement('div');
        marker.className = 'move-to-marker';
        marker.style.paddingLeft = `${10 + depth * 18}px`;

        const line = document.createElement('div');
        line.className = 'move-to-marker-line';
        marker.appendChild(line);

        marker.addEventListener('click', (e) => {
            e.stopPropagation();
            // Determine the drop target based on the insert index
            if (insertIdx < siblingArray.length) {
                // Insert before the item at insertIdx
                performMove(siblingArray[insertIdx].id, 'before');
            } else if (siblingArray.length > 0) {
                // Insert after the last item
                performMove(siblingArray[siblingArray.length - 1].id, 'after');
            }
        });

        return marker;
    }

    // ── Render a level of the tree ──
    function renderMoveLevel(items, container, depth) {
        const isSearching = !!searchQuery;

        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const isExcluded = excludedIds.has(it.id);
            const isInbox = !!it.isInbox;

            // Skip items that don't match search
            if (isSearching && !isExcluded && !itemMatchesSearch(it, searchQuery)) continue;

            // Insert marker before each non-Inbox item (hide during search)
            if (!isSearching && !isInbox && !isExcluded) {
                // Only show marker if the previous item isn't excluded
                // (avoid dangling markers between excluded blocks)
                const prevItem = i > 0 ? items[i - 1] : null;
                if (!prevItem || !excludedIds.has(prevItem.id)) {
                    container.appendChild(createMoveMarker(items, i, depth));
                }
            }

            // Skip excluded items entirely
            if (isExcluded) continue;

            const row = document.createElement('div');
            row.className = 'move-to-row';
            row.style.paddingLeft = `${10 + depth * 18}px`;
            row.dataset.itemId = it.id;

            const hasChildren = it.children && it.children.length > 0;
            // Check if it has non-excluded children
            const hasVisibleChildren = hasChildren && it.children.some(c => !excludedIds.has(c.id));

            // Toggle — auto-expand when searching
            const isExp = isSearching ? true : expandedMap.get(it.id);
            const toggle = document.createElement('span');
            toggle.className = 'move-to-toggle' + (hasVisibleChildren ? '' : ' leaf');
            toggle.textContent = hasVisibleChildren ? (isExp ? '▾' : '▸') : '·';
            if (hasVisibleChildren && !isSearching) {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    expandedMap.set(it.id, !expandedMap.get(it.id));
                    rebuildTree();
                });
            }
            row.appendChild(toggle);

            // Icon for inbox
            if (isInbox) {
                const icon = document.createElement('span');
                icon.className = 'move-to-inbox-icon';
                icon.textContent = '📥';
                row.appendChild(icon);
            }

            // Name — highlight matching text during search
            const nameEl = document.createElement('span');
            nameEl.className = 'move-to-name';
            if (isSearching && it.name) {
                const lowerName = it.name.toLowerCase();
                const lowerQ = searchQuery.toLowerCase();
                const matchIdx = lowerName.indexOf(lowerQ);
                if (matchIdx >= 0) {
                    const before = it.name.slice(0, matchIdx);
                    const match = it.name.slice(matchIdx, matchIdx + searchQuery.length);
                    const after = it.name.slice(matchIdx + searchQuery.length);
                    nameEl.textContent = before;
                    const mark = document.createElement('mark');
                    mark.className = 'move-to-search-highlight';
                    mark.textContent = match;
                    nameEl.appendChild(mark);
                    nameEl.appendChild(document.createTextNode(after));
                } else {
                    nameEl.textContent = it.name;
                }
            } else {
                nameEl.textContent = it.name;
            }
            row.appendChild(nameEl);

            // Click row = move inside this item (as last child)
            row.addEventListener('click', () => {
                performMove(it.id, 'inside');
            });

            container.appendChild(row);

            // Expanded children
            if (hasVisibleChildren && isExp) {
                renderMoveLevel(it.children, container, depth + 1);
            }
        }

        // Insert marker after the last visible item (hide during search)
        if (!isSearching) {
            const visibleItems = items.filter(it => !excludedIds.has(it.id));
            if (visibleItems.length > 0) {
                const lastVisible = visibleItems[visibleItems.length - 1];
                const lastIdx = items.indexOf(lastVisible);
                // Only add trailing marker if we have visible items and it's not just Inbox
                const nonInboxVisible = visibleItems.filter(it => !it.isInbox);
                if (nonInboxVisible.length > 0 || depth > 0) {
                    container.appendChild(createMoveMarker(items, lastIdx + 1, depth));
                }
            }
        }
    }

    function rebuildTree() {
        tree.innerHTML = '';
        renderMoveLevel(state.items.items, tree, 0);

        // Root-level option (hide during search)
        if (!searchQuery) {
            const rootBtn = document.createElement('div');
            rootBtn.className = 'move-to-root-btn';
            rootBtn.textContent = '⬆ Move to root level';
            rootBtn.addEventListener('click', () => {
                performMove('_root', 'inside');
            });
            tree.appendChild(rootBtn);
        }
    }

    rebuildTree();
    body.appendChild(tree);

    // ── Footer ──
    const actions = document.createElement('div');
    actions.className = 'modal-actions move-to-actions';

    // Scroll-to checkbox (left side)
    const scrollLabel = document.createElement('label');
    scrollLabel.className = 'move-to-scroll-option';
    const scrollCheckbox = document.createElement('input');
    scrollCheckbox.type = 'checkbox';
    scrollCheckbox.className = 'move-to-scroll-checkbox';
    scrollLabel.appendChild(scrollCheckbox);
    scrollLabel.appendChild(document.createTextNode(' Scroll to'));
    actions.appendChild(scrollLabel);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn modal-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    actions.appendChild(cancelBtn);

    modal.appendChild(body);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Auto-focus search
    requestAnimationFrame(() => searchInput.focus());

    // Click overlay backdrop to close
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// ─── Goal Modal ───
function openGoalModal(itemId, itemName) {
    const existing = document.getElementById('goal-modal-overlay');
    if (existing) existing.remove();

    const item = findItemById(itemId);
    const currentGoal = item && item.goal;
    let selectedType = currentGoal ? currentGoal.type : 'done';

    const overlay = document.createElement('div');
    overlay.id = 'goal-modal-overlay';
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-box goal-modal-box';

    function buildModal() {
        const existingProgress = currentGoal ? getGoalProgress(item) : null;

        // Pre-fill time values from existing goal
        let existingHours = 0, existingMinutes = 0;
        if (currentGoal && currentGoal.type === 'time' && currentGoal.target) {
            existingHours = Math.floor(currentGoal.target / 3600);
            existingMinutes = Math.floor((currentGoal.target % 3600) / 60);
        }

        let html = `
            <div class="modal-header">${currentGoal ? 'Edit' : 'Set'} Goal: ${itemName}</div>
            <div class="modal-body">
                <div class="goal-type-selector">
                    <button class="goal-type-btn ${selectedType === 'done' ? 'goal-type-btn-active' : ''}" data-type="done">✓ Done</button>
                    <button class="goal-type-btn ${selectedType === 'time' ? 'goal-type-btn-active' : ''}" data-type="time">⏱ Time</button>
                </div>
                <div class="goal-info" id="goal-info-done" style="display: ${selectedType === 'done' ? '' : 'none'}">
                    <div class="goal-info-text">Track completion of all sub-tasks.</div>
                    ${existingProgress && selectedType === 'done' ? `<div class="goal-info-progress">Current: ${existingProgress.label} (${existingProgress.percent}%)</div>` : ''}
                </div>
                <div class="goal-info" id="goal-info-time" style="display: ${selectedType === 'time' ? '' : 'none'}">
                    <div class="goal-info-text">Set a target amount of tracked time.</div>
                    <div class="goal-time-inputs">
                        <input type="number" id="goal-hours" class="modal-input goal-time-input" value="${existingHours}" min="0" placeholder="0">
                        <span class="goal-time-unit">h</span>
                        <input type="number" id="goal-minutes" class="modal-input goal-time-input" value="${existingMinutes}" min="0" max="59" placeholder="0">
                        <span class="goal-time-unit">m</span>
                    </div>
                    ${existingProgress && selectedType === 'time' ? `<div class="goal-info-progress">Current: ${existingProgress.label} (${existingProgress.percent}%)</div>` : ''}
                </div>
            </div>
            <div class="modal-actions">
                ${currentGoal ? '<button class="modal-btn goal-remove-btn" id="goal-remove-btn">Remove Goal</button>' : ''}
                <button class="modal-btn modal-btn-cancel" id="goal-cancel-btn">Cancel</button>
                <button class="modal-btn modal-btn-save" id="goal-save-btn">Save</button>
            </div>
        `;

        modal.innerHTML = html;

        // Wire type selector
        modal.querySelectorAll('.goal-type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedType = btn.dataset.type;
                buildModal();
            });
        });

        // Wire save
        modal.querySelector('#goal-save-btn').addEventListener('click', async () => {
            let goal;
            if (selectedType === 'done') {
                goal = { type: 'done' };
            } else {
                const h = parseInt(modal.querySelector('#goal-hours').value) || 0;
                const m = parseInt(modal.querySelector('#goal-minutes').value) || 0;
                const target = h * 3600 + m * 60;
                if (target <= 0) return; // Don't save 0 target
                goal = { type: 'time', target };
            }
            await api.patch(`/items/${itemId}`, { goal });
            if (item) item.goal = goal;
            overlay.remove();
            renderAll();
        });

        // Wire cancel
        modal.querySelector('#goal-cancel-btn').addEventListener('click', () => {
            overlay.remove();
        });

        // Wire remove
        const removeBtn = modal.querySelector('#goal-remove-btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', async () => {
                await api.patch(`/items/${itemId}`, { goal: null });
                if (item) delete item.goal;
                overlay.remove();
                renderAll();
            });
        }
    }

    buildModal();
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.remove();
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
                <label class="modal-label" for="defaults-week-start">📅 Week starts on</label>
                <select id="defaults-week-start" class="modal-input">
                    <option value="0">Sunday</option>
                    <option value="1">Monday</option>
                    <option value="2">Tuesday</option>
                    <option value="3">Wednesday</option>
                    <option value="4">Thursday</option>
                    <option value="5">Friday</option>
                    <option value="6">Saturday</option>
                </select>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-field modal-field-toggle">
                <label class="modal-label" for="defaults-sleep-guard">🛡️ Sleep guard</label>
                <input type="checkbox" id="defaults-sleep-guard" class="modal-toggle" />
                <span class="modal-hint">Confirm before starting work during sleep</span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-field">
                <label class="modal-label" for="defaults-past-card-style">📋 Past entries card style</label>
                <select id="defaults-past-card-style" class="modal-input">
                    <option value="compact">Compact</option>
                    <option value="full">Full cards</option>
                </select>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-field">
                <label class="modal-label" for="defaults-skin">🎨 Skin</label>
                <select id="defaults-skin" class="modal-input">
                    <option value="duolingo">Duolingo</option>
                    <option value="modern">Modern</option>
                    <option value="win95">Windows 95</option>
                    <option value="pencil">Pencil & Paper</option>
                </select>
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
    document.getElementById('defaults-week-start').value = String(state.settings.weekStartDay ?? 0);
    document.getElementById('defaults-sleep-guard').checked = state.settings.sleepGuard !== false;
    document.getElementById('defaults-past-card-style').value = state.pastCardStyle;
    document.getElementById('defaults-skin').value = _skinFamily;


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
        state.settings.weekStartDay = parseInt(document.getElementById('defaults-week-start').value, 10);
        state.settings.sleepGuard = document.getElementById('defaults-sleep-guard').checked;
        // Save past card style preference
        const newCardStyle = document.getElementById('defaults-past-card-style').value;
        if (newCardStyle !== state.pastCardStyle) {
            state.pastCardStyle = newCardStyle;
            savePref('pastCardStyle', state.pastCardStyle);
        }
        const selectedSkin = document.getElementById('defaults-skin').value;
        if (selectedSkin !== _skinFamily) applySkinFamily(selectedSkin);
        await api.put('/settings', state.settings);
        overlay.remove();
        renderTimeline();
    });
}

// ─── Hide-Past Accordion Animation ───
function animateHidePastToggle(isHiding, renderFn) {
    const timeline = document.getElementById('timeline-list');

    if (state.viewHorizon === 'week') {
        // Week view: animate individual past day rows
        // 1) Collect existing past-day-row elements + their preceding sleep dividers
        const oldRows = [];
        if (!isHiding) {
            // We're about to SHOW past days — snapshot what's there now (nothing)
        } else {
            // We're about to HIDE past days — snapshot the current rows
            timeline.querySelectorAll('.week-day-row.week-day-past').forEach(row => {
                const items = [row];
                // Also grab the preceding sleep divider if any
                const prev = row.previousElementSibling;
                if (prev && prev.classList.contains('week-sleep-divider')) items.unshift(prev);
                oldRows.push(items);
            });
        }

        // Render with the new state — but we need the past rows in the DOM for animation
        // Temporarily force pastDisplayMode to 'full' so they render, then animate away
        if (isHiding) {
            state.pastDisplayMode = 'show';
            renderFn();
            state.pastDisplayMode = 'hide';

            // Now animate each past day row to collapse
            const pastRows = timeline.querySelectorAll('.week-day-row.week-day-past');
            const toAnimate = [];
            pastRows.forEach(row => {
                const items = [row];
                const prev = row.previousElementSibling;
                if (prev && prev.classList.contains('week-sleep-divider')) items.unshift(prev);
                toAnimate.push(items);
            });

            toAnimate.forEach(group => {
                group.forEach(el => {
                    const h = el.offsetHeight;
                    el.style.overflow = 'hidden';
                    el.style.transition = 'none';
                    el.style.maxHeight = h + 'px';
                    el.style.opacity = '1';
                    requestAnimationFrame(() => {
                        el.style.transition = 'max-height 250ms ease-out, opacity 200ms ease-out';
                        el.style.maxHeight = '0px';
                        el.style.opacity = '0';
                        const cleanup = () => el.remove();
                        el.addEventListener('transitionend', cleanup, { once: true });
                        setTimeout(cleanup, 300);
                    });
                });
            });
        } else {
            // Showing past: render with past included, then animate them in
            renderFn();

            const pastRows = timeline.querySelectorAll('.week-day-row.week-day-past');
            const toAnimate = [];
            pastRows.forEach(row => {
                const items = [row];
                const prev = row.previousElementSibling;
                if (prev && prev.classList.contains('week-sleep-divider')) items.unshift(prev);
                toAnimate.push(items);
            });

            toAnimate.forEach(group => {
                group.forEach(el => {
                    const h = el.offsetHeight;
                    el.style.overflow = 'hidden';
                    el.style.transition = 'none';
                    el.style.maxHeight = '0px';
                    el.style.opacity = '0';
                    // Force layout
                    el.offsetHeight;
                    requestAnimationFrame(() => {
                        el.style.transition = 'max-height 250ms ease-out, opacity 200ms ease-out';
                        el.style.maxHeight = h + 'px';
                        el.style.opacity = '1';
                        const cleanup = () => {
                            el.style.overflow = '';
                            el.style.transition = '';
                            el.style.maxHeight = '';
                            el.style.opacity = '';
                        };
                        el.addEventListener('transitionend', cleanup, { once: true });
                        setTimeout(cleanup, 300);
                    });
                });
            });
        }
        return;
    }

    // Day view: accordion wrapper approach
    const oldH = timeline.scrollHeight;
    renderFn();
    const newH = timeline.scrollHeight;
    const diff = newH - oldH;
    if (Math.abs(diff) < 2) return;

    const wrapper = document.createElement('div');
    while (timeline.firstChild) wrapper.appendChild(timeline.firstChild);
    timeline.appendChild(wrapper);

    wrapper.style.transition = 'none';
    wrapper.style.marginTop = `${-diff}px`;

    requestAnimationFrame(() => {
        wrapper.style.transition = 'margin-top 250ms ease-out';
        wrapper.style.marginTop = '0px';

        const cleanup = () => {
            while (wrapper.firstChild) timeline.appendChild(wrapper.firstChild);
            wrapper.remove();
        };
        wrapper.addEventListener('transitionend', cleanup, { once: true });
        setTimeout(cleanup, 300);
    });
}

// ─── Nav Slide Animation ───
let _navAnimating = false;
function animateNavTransition(direction, updateFn) {
    // direction: 'left' = forward (next), 'right' = backward (prev)
    const timeline = document.getElementById('timeline-list');
    const actions = document.getElementById('actions-list');
    // Don't animate actions when in sleep mode — "Good Night" is static
    const sleepMode = isInSleepRange() && !state.workingOn && !state.onBreak;
    const targets = [timeline, !sleepMode && actions].filter(Boolean);

    // Cancel any in-flight animation
    for (const el of targets) {
        el.classList.remove('nav-slide-out-left', 'nav-slide-out-right', 'nav-slide-in-left', 'nav-slide-in-right');
        el.getAnimations().forEach(a => a.cancel());
    }

    // Phase 1: slide old content out
    const outClass = direction === 'left' ? 'nav-slide-out-left' : 'nav-slide-out-right';
    for (const el of targets) el.classList.add(outClass);

    const onSlideOutDone = () => {
        for (const el of targets) el.classList.remove(outClass);

        // Phase 2: update state + re-render
        updateFn();

        // Phase 3: slide new content in
        const inClass = direction === 'left' ? 'nav-slide-in-left' : 'nav-slide-in-right';
        for (const el of targets) el.classList.add(inClass);

        const cleanup = () => {
            for (const el of targets) el.classList.remove(inClass);
            _navAnimating = false;
        };
        timeline.addEventListener('animationend', cleanup, { once: true });
        // Safety fallback
        setTimeout(cleanup, 200);
    };

    _navAnimating = true;
    timeline.addEventListener('animationend', onSlideOutDone, { once: true });
    // Safety fallback in case animationend doesn't fire
    setTimeout(() => {
        if (_navAnimating) onSlideOutDone();
    }, 200);
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
    // showDone state is restored in loadAll() from backend preferences
    const hideDoneBtn = document.getElementById('hide-done-btn');
    hideDoneBtn.classList.toggle('active', state.showDone);
    hideDoneBtn.title = state.showDone ? 'Hide done' : 'Show done';
    hideDoneBtn.addEventListener('click', () => {
        state.showDone = !state.showDone;
        savePref('showDone', state.showDone);
        hideDoneBtn.classList.toggle('active', state.showDone);
        hideDoneBtn.title = state.showDone ? 'Hide done' : 'Show done';
        renderAll();
    });

    // Schedule filter 3-way toggle: scheduled → scheduled+unscheduled → all
    // State is restored in loadAll() from backend preferences
    const showUnschedBtn = document.getElementById('show-unscheduled-btn');
    syncScheduleFilterBtn(showUnschedBtn);
    showUnschedBtn.addEventListener('click', () => {
        const cycle = ['scheduled', 'scheduled+unscheduled', 'all'];
        const idx = cycle.indexOf(state.scheduleFilter);
        state.scheduleFilter = cycle[(idx + 1) % cycle.length];
        savePref('scheduleFilter', state.scheduleFilter);
        syncScheduleFilterBtn(showUnschedBtn);
        renderAll();
    });

    // Date nav buttons — renderAll() so actions list updates with time context
    document.getElementById('date-nav-prev').addEventListener('click', () => {
        const d = new Date(state.timelineViewDate);
        const step = state.viewHorizon === 'week' ? 7 : 1;
        d.setDate(d.getDate() - step);
        state.timelineViewDate = d;
        clearFocusStack();
        savePref('timelineViewDate', d.toISOString());
        animateNavTransition('right', () => renderAll());
    });
    document.getElementById('date-nav-next').addEventListener('click', () => {
        const d = new Date(state.timelineViewDate);
        const step = state.viewHorizon === 'week' ? 7 : 1;
        d.setDate(d.getDate() + step);
        state.timelineViewDate = d;
        clearFocusStack();
        savePref('timelineViewDate', d.toISOString());
        animateNavTransition('left', () => renderAll());
    });
    // Click on date text to open native date picker
    const dateNavPicker = document.getElementById('date-nav-picker');
    document.getElementById('date-nav-date').addEventListener('click', () => {
        if (state.viewHorizon !== 'day' || state.focusStack.length > 0) return; // don't open picker when not in day view or session focused
        dateNavPicker.showPicker();
    });
    dateNavPicker.addEventListener('change', () => {
        const parts = dateNavPicker.value.split('-').map(Number);
        if (parts.length === 3) {
            state.timelineViewDate = new Date(parts[0], parts[1] - 1, parts[2]);
            clearFocusStack();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            renderAll();
        }
    });
    // Back to today button
    document.getElementById('date-nav-today-btn').addEventListener('click', () => {
        state.timelineViewDate = getLogicalToday();
        clearFocusStack();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        renderAll();
    });

    // Day arrow DnD targets — drop to reschedule to prev/next day
    function setupDayArrowDnD(btnId, dayOffset) {
        const btn = document.getElementById(btnId);
        btn.addEventListener('dragover', (e) => {
            if (!window._draggedAction && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            btn.classList.add('date-nav-btn-drag-over');
        });
        btn.addEventListener('dragleave', (e) => {
            e.stopPropagation();
            btn.classList.remove('date-nav-btn-drag-over');
        });
        btn.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            btn.classList.remove('date-nav-btn-drag-over');
            const d = new Date(state.timelineViewDate);
            d.setDate(d.getDate() + dayOffset);
            const targetDateKey = getDateKey(d);
            // Segment queue item (intention) drag
            if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                const segCtx = e.dataTransfer.getData('application/x-segment-context');
                if (!itemId) return;
                let segDur;
                if (segCtx) {
                    const item = findItemById(Number(itemId));
                    if (item) {
                        segDur = item.contextDurations?.[segCtx];
                        if (item.timeContexts) item.timeContexts = item.timeContexts.filter(tc => tc !== segCtx);
                        if (item.contextDurations) delete item.contextDurations[segCtx];
                    }
                }
                await rescheduleToDate(parseInt(itemId, 10), targetDateKey);
                return;
            }
            // Regular action/project drag
            const actionId = e.dataTransfer.getData('application/x-action-id');
            if (!actionId) return;
            await rescheduleToDate(parseInt(actionId, 10), targetDateKey);
        });
    }
    setupDayArrowDnD('date-nav-prev', -1);
    setupDayArrowDnD('date-nav-next', 1);

    // Week arrow DnD targets — drop to reschedule to prev/next week
    function setupWeekArrowDnD(btnId, weekOffset) {
        const btn = document.getElementById(btnId);
        btn.addEventListener('dragover', (e) => {
            if (!window._draggedAction && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            btn.classList.add('date-nav-btn-drag-over');
        });
        btn.addEventListener('dragleave', (e) => {
            e.stopPropagation();
            btn.classList.remove('date-nav-btn-drag-over');
        });
        btn.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            btn.classList.remove('date-nav-btn-drag-over');
            const d = new Date(state.timelineViewDate);
            d.setDate(d.getDate() + weekOffset * 7);
            const targetWeekKey = getWeekKey(d);
            // Segment queue item (intention) drag
            if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                const segCtx = e.dataTransfer.getData('application/x-segment-context');
                if (!itemId) return;
                let segDur;
                if (segCtx) {
                    const item = findItemById(Number(itemId));
                    if (item) {
                        segDur = item.contextDurations?.[segCtx];
                        if (item.timeContexts) item.timeContexts = item.timeContexts.filter(tc => tc !== segCtx);
                        if (item.contextDurations) delete item.contextDurations[segCtx];
                    }
                }
                await sendToWeek(parseInt(itemId, 10), targetWeekKey, segDur);
                return;
            }
            // Regular action/project drag
            const actionId = e.dataTransfer.getData('application/x-action-id');
            if (!actionId) return;
            await sendToWeek(parseInt(actionId, 10), targetWeekKey);
        });
    }
    setupWeekArrowDnD('week-nav-prev', -1);
    setupWeekArrowDnD('week-nav-next', 1);

    // ── Horizon layer click + DnD handlers ──
    // Epoch layer: arrow-based navigation between Past/Ongoing/Future
    const epochLayer = document.getElementById('horizon-epoch-layer');
    const epochOrder = EPOCH_CONTEXTS; // ['past', 'ongoing', 'future']

    function cycleEpoch(dir) {
        const idx = epochOrder.indexOf(state.epochFilter);
        const next = idx + dir;
        if (next < 0 || next >= epochOrder.length) return;
        state.epochFilter = epochOrder[next];
        savePref('epochFilter', state.epochFilter);
        // Sync timelineViewDate into the new epoch's range
        const { startWeek, endWeek } = getEpochWeekRange(state.epochFilter);
        const currentWk = getWeekKey(state.timelineViewDate);
        const needsSync = (startWeek && currentWk < startWeek) || (endWeek && currentWk > endWeek);
        if (needsSync) {
            // Snap to the boundary closest to where we came from
            const targetWk = dir > 0 ? (startWeek || endWeek) : (endWeek || startWeek);
            if (targetWk) {
                const range = getWeekDateRange(targetWk);
                if (range) state.timelineViewDate = range.start;
            }
        }
        // If not already at epoch level, switch to it
        if (state.viewHorizon !== 'epoch') {
            clearFocusStack();
            state.viewHorizon = 'epoch';
            savePref('viewHorizon', 'epoch');
        }
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        renderAll();
    }

    document.getElementById('epoch-nav-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        cycleEpoch(-1);
    });
    document.getElementById('epoch-nav-next').addEventListener('click', (e) => {
        e.stopPropagation();
        cycleEpoch(1);
    });

    // Click the epoch display to navigate to epoch view (when dim)
    epochLayer.addEventListener('click', (e) => {
        if (e.target.closest('.epoch-nav-btn')) return;
        if (state.viewHorizon === 'epoch') return;
        clearFocusStack();
        state.viewHorizon = 'epoch';
        savePref('viewHorizon', 'epoch');
        renderAll();
    });

    // DnD on the epoch layer — sends to whatever epoch is currently displayed
    // (blocked when showing Past since you can't schedule to Past)
    epochLayer.addEventListener('dragover', (e) => {
        if (state.epochFilter === 'past') return; // can't drop on past
        if (!window._draggedAction && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        epochLayer.classList.add('horizon-layer-drag-over');
    });
    epochLayer.addEventListener('dragleave', () => {
        epochLayer.classList.remove('horizon-layer-drag-over');
    });
    epochLayer.addEventListener('drop', async (e) => {
        e.preventDefault();
        epochLayer.classList.remove('horizon-layer-drag-over');
        const targetEpoch = state.epochFilter;
        if (targetEpoch === 'past') return;
        // Segment queue item (intention) drag
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            let segDur;
            if (segCtx) {
                const item = findItemById(Number(itemId));
                if (item) {
                    segDur = item.contextDurations?.[segCtx];
                    if (item.timeContexts) item.timeContexts = item.timeContexts.filter(tc => tc !== segCtx);
                    if (item.contextDurations) delete item.contextDurations[segCtx];
                }
            }
            await sendToEpoch(parseInt(itemId, 10), targetEpoch, segDur);
            return;
        }
        // Regular action/project drag
        const actionId = e.dataTransfer.getData('application/x-action-id');
        if (!actionId) return;
        await sendToEpoch(parseInt(actionId, 10), targetEpoch);
    });

    // Week layer: click to navigate to week view, drag to degrade to week scope
    const weekLayer = document.getElementById('horizon-week-layer');
    weekLayer.addEventListener('click', (e) => {
        // Don't trigger horizon switch when clicking nav buttons, picker, or today btn
        if (e.target.closest('.week-nav-btn, .date-nav-picker, .date-nav-today-btn')) return;
        if (state.viewHorizon === 'week') return; // already active — don't re-trigger
        state._weekScrollTarget = getDateKey(state.timelineViewDate); // remember source day
        clearFocusStack();
        state.viewHorizon = 'week';
        savePref('viewHorizon', 'week');
        renderAll();
    });
    // Week nav arrow buttons
    document.getElementById('week-nav-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        state.timelineViewDate.setDate(state.timelineViewDate.getDate() - 7);
        clearFocusStack();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        _updateWeekNavLabel();
        animateNavTransition('right', () => renderAll());
    });
    document.getElementById('week-nav-next').addEventListener('click', (e) => {
        e.stopPropagation();
        state.timelineViewDate.setDate(state.timelineViewDate.getDate() + 7);
        clearFocusStack();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        _updateWeekNavLabel();
        animateNavTransition('left', () => renderAll());
    });
    // Week label click -> open date picker
    const weekNavPicker = document.getElementById('week-nav-picker');
    document.getElementById('week-nav-label').addEventListener('click', (e) => {
        if (state.viewHorizon !== 'week') return; // let click bubble to switch horizon
        e.stopPropagation();
        weekNavPicker.showPicker();
    });
    weekNavPicker.addEventListener('click', (e) => e.stopPropagation());
    weekNavPicker.addEventListener('change', () => {
        const parts = weekNavPicker.value.split('-').map(Number);
        if (parts.length === 3) {
            state.timelineViewDate = new Date(parts[0], parts[1] - 1, parts[2]);
            clearFocusStack();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            _updateWeekNavLabel();
            renderAll();
        }
    });
    // This Week button
    document.getElementById('week-nav-today-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        state.timelineViewDate = getLogicalToday();
        clearFocusStack();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        _updateWeekNavLabel();
        renderAll();
    });
    weekLayer.addEventListener('dragover', (e) => {
        if (!window._draggedAction && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        weekLayer.classList.add('horizon-layer-drag-over');
    });
    weekLayer.addEventListener('dragleave', () => {
        weekLayer.classList.remove('horizon-layer-drag-over');
    });
    weekLayer.addEventListener('drop', async (e) => {
        e.preventDefault();
        weekLayer.classList.remove('horizon-layer-drag-over');
        const weekKey = getWeekKey(state.timelineViewDate);
        // Segment queue item drag
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            let segDur;
            if (segCtx) {
                const item = findItemById(Number(itemId));
                if (item) {
                    segDur = item.contextDurations?.[segCtx];
                    if (item.timeContexts) item.timeContexts = item.timeContexts.filter(tc => tc !== segCtx);
                    if (item.contextDurations) delete item.contextDurations[segCtx];
                }
            }
            await sendToWeek(parseInt(itemId, 10), weekKey, segDur);
            return;
        }
        // Regular action/project drag
        const actionId = e.dataTransfer.getData('application/x-action-id');
        if (!actionId) return;
        await sendToWeek(parseInt(actionId, 10), weekKey);
    });

    // Day layer: click to navigate back to day, drag to promote from ongoing
    const dayLayer = document.getElementById('horizon-day-layer');
    dayLayer.addEventListener('click', (e) => {
        // Navigate: from session → back to day, or from ongoing/week → day
        if (e.target.closest('.date-nav-btn')) return;
        // Only ignore date-display clicks when already in day view
        if (state.viewHorizon === 'day' && e.target.closest('.date-nav-display')) return;
        if (state.viewHorizon === 'session') {
            // Pop out of session horizon → back to day
            state.viewHorizon = 'day';
            savePref('viewHorizon', 'day');
            clearFocusStack();
            renderAll();
            return;
        }
        if (state.viewHorizon === 'day') return;
        clearFocusStack();
        state.viewHorizon = 'day';
        savePref('viewHorizon', 'day');
        renderAll();
    });
    dayLayer.addEventListener('dragover', (e) => {
        if (!window._draggedAction && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dayLayer.classList.add('horizon-layer-drag-over');
    });
    dayLayer.addEventListener('dragleave', () => {
        dayLayer.classList.remove('horizon-layer-drag-over');
    });
    dayLayer.addEventListener('drop', async (e) => {
        e.preventDefault();
        dayLayer.classList.remove('horizon-layer-drag-over');
        // Segment queue item (intention) drag
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            // Capture segment duration before removing, then migrate to day
            let segDur;
            if (segCtx) {
                const item = findItemById(Number(itemId));
                if (item) {
                    segDur = item.contextDurations?.[segCtx];
                    if (item.timeContexts) {
                        item.timeContexts = item.timeContexts.filter(tc => tc !== segCtx);
                    }
                    if (item.contextDurations) delete item.contextDurations[segCtx];
                }
            }
            const dateKey = getDateKey(state.timelineViewDate);
            await promoteFromOngoing(parseInt(itemId, 10), dateKey, segDur);
            return;
        }
        // Regular action/project drag
        const actionId = e.dataTransfer.getData('application/x-action-id');
        if (!actionId) return;
        const dateKey = getDateKey(state.timelineViewDate);
        await promoteFromOngoing(parseInt(actionId, 10), dateKey);
    });

    // ── Session layer: click to enter session horizon, prev/next to navigate, DnD to schedule ──
    const sessionLayer = document.getElementById('horizon-session-layer');
    if (sessionLayer) {
        sessionLayer.addEventListener('click', (e) => {
            if (e.target.closest('.session-nav-btn')) return;
            if (state.viewHorizon === 'session') return; // already active
            // Enter session horizon — auto-select current segment
            const segments = buildPlanSegments();
            state.sessionIndex = getCurrentSessionIndex(segments);
            state.viewHorizon = 'session';
            savePref('viewHorizon', 'session');
            savePref('sessionIndex', state.sessionIndex);
            _syncSessionToFocusStack(segments[state.sessionIndex]);
            renderAll();
        });
        document.getElementById('session-nav-prev').addEventListener('click', (e) => {
            e.stopPropagation();
            navigateSession(-1);
        });
        document.getElementById('session-nav-next').addEventListener('click', (e) => {
            e.stopPropagation();
            navigateSession(+1);
        });
        sessionLayer.addEventListener('dragover', (e) => {
            if (!window._draggedAction && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            sessionLayer.classList.add('horizon-layer-drag-over');
        });
        sessionLayer.addEventListener('dragleave', () => {
            sessionLayer.classList.remove('horizon-layer-drag-over');
        });
        sessionLayer.addEventListener('drop', async (e) => {
            e.preventDefault();
            sessionLayer.classList.remove('horizon-layer-drag-over');
            // Get active session segment for context
            const seg = getActiveSession();
            if (!seg) return;
            // Segment queue item drag
            if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                const segCtx = e.dataTransfer.getData('application/x-segment-context');
                if (!itemId) return;
                // Remove old segment context
                if (segCtx) {
                    const item = findItemById(Number(itemId));
                    if (item) {
                        if (item.timeContexts) item.timeContexts = item.timeContexts.filter(tc => tc !== segCtx);
                        if (item.contextDurations) delete item.contextDurations[segCtx];
                    }
                }
                // Add to the active session's segment
                await addSegmentContext(parseInt(itemId, 10), seg.segmentKey);
                return;
            }
            // Regular action drag
            const actionId = e.dataTransfer.getData('application/x-action-id');
            if (!actionId) return;
            await addSegmentContext(parseInt(actionId, 10), seg.segmentKey);
        });
    }

    // Hide-past toggle (default: OFF = past entries visible)
    // pastDisplayMode state is restored in loadAll() from backend preferences
    const hidePastBtn = document.getElementById('hide-past-btn');
    syncPastDisplayBtn(hidePastBtn);
    hidePastBtn.addEventListener('click', () => {
        // 2-way toggle: show ↔ hide
        const wasHidden = state.pastDisplayMode === 'hide';
        state.pastDisplayMode = wasHidden ? 'show' : 'hide';
        savePref('pastDisplayMode', state.pastDisplayMode);
        syncPastDisplayBtn(hidePastBtn);
        // Animate the transition
        animateHidePastToggle(!wasHidden, () => renderAll());
    });

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
    // ─── Scroll-to-selected banner + persist scroll position ───
    const projectTree = document.getElementById('project-tree');
    const scrollBanner = document.getElementById('scroll-to-selected-banner');
    let _projectTreeScrollSaveTimer = null;
    if (projectTree) {
        projectTree.addEventListener('scroll', () => {
            clearTimeout(_scrollBannerDebounce);
            _scrollBannerDebounce = setTimeout(() => updateScrollToSelectedBanner(), 80);
            // Persist scroll position (debounced)
            clearTimeout(_projectTreeScrollSaveTimer);
            _projectTreeScrollSaveTimer = setTimeout(() => {
                savePref('projectTreeScrollTop', projectTree.scrollTop);
            }, 300);
        });
    }
    if (scrollBanner) {
        scrollBanner.addEventListener('click', () => scrollToSelectedItem());
    }

    // ─── Week View Keyboard Shortcuts ───
    document.addEventListener('keydown', (e) => {
        // Only active in week horizon
        if (state.viewHorizon !== 'week') return;
        // Don't intercept when typing in inputs/textareas or modals
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (document.querySelector('.plan-editor, .modal-overlay')) return;

        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const offset = e.key === 'ArrowLeft' ? -7 : 7;
            state.timelineViewDate.setDate(state.timelineViewDate.getDate() + offset);
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            renderAll();
        } else if (e.key === 'e' || e.key === 'E') {
            // Expand all days
            state.weekCollapsedDays = {};
            savePref('weekCollapsedDays', state.weekCollapsedDays);
            renderAll();
        } else if (e.key === 'c' || e.key === 'C') {
            // Collapse all days
            const weekKey = getWeekKey(state.timelineViewDate);
            const range = getWeekDateRange(weekKey);
            if (range) {
                const collapsed = {};
                for (let d = 0; d < 7; d++) {
                    const dayDate = new Date(range.start);
                    dayDate.setDate(range.start.getDate() + d);
                    collapsed[getDateKey(dayDate)] = true;
                }
                state.weekCollapsedDays = collapsed;
                savePref('weekCollapsedDays', state.weekCollapsedDays);
                renderAll();
            }
        }
    });
});
