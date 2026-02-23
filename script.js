// =====================================================
// Anything Mini — Client Script
// Keywords: simplicity, small wins
// Unified items tree: branches = projects, leaves = actions
// =====================================================

const API = '/api';

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
    viewHorizon: 'day', // 'day' | 'month' | 'week' | 'epoch' | 'session' | 'live' — horizon level for timeline navigation
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
    reflectionPanelOpen: false, // whether the capacity bar reflection panel is expanded
    reflectionExpandedIds: new Set(), // set of item IDs expanded in the reflection tree
    reflectionSortByTime: true, // true = sort by invested time, false = tree order
    reflectionHistoryIds: new Set(), // set of item IDs showing work entry history
    deepView: false, // when true, actions show items from all layers of the selected project context
    showInvestmentBadge: true, // when true, show tri-state investment bar instead of simple duration badge
    bookmarks: [], // array of item IDs for quick-access bookmarks
    focusQueue: [], // ordered array of { itemId, itemName, projectName } — live queue
    focusQueueSettings: { autoAdvance: false, breakMinutes: 0 }, // queue behavior settings
    settings: {
        dayStartHour: 8,
        dayStartMinute: 0,
        dayEndHour: 22,
        dayEndMinute: 0,
        dayOverrides: {}, // { "2026-02-09": { dayStartHour, dayStartMinute, dayEndHour, dayEndMinute } }
        weekStartDay: 0, // 0=Sun, 1=Mon, ..., 6=Sat
    },
};

// ── Shared duration formatter (h/m/s) — hoisted from hot paths ──
function _fmtHMS(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

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
    const validHorizons = ['day', 'month', 'week', 'epoch', 'session', 'live'];
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
    state.deepView = prefs.deepView === true;
    state.showInvestmentBadge = prefs.showInvestmentBadge !== false; // default true
    // Restore bookmarks (prune any IDs that no longer exist)
    if (Array.isArray(prefs.bookmarks)) {
        state.bookmarks = prefs.bookmarks.filter(id => findItemById(id));
    }
    // Restore focus queue (prune items that no longer exist)
    if (Array.isArray(prefs.focusQueue)) {
        state.focusQueue = prefs.focusQueue.filter(q => q.type === 'break' || findItemById(q.itemId));
    }
    if (prefs.focusQueueSettings) {
        state.focusQueueSettings = {
            autoAdvance: prefs.focusQueueSettings.autoAdvance === true,
            breakMinutes: typeof prefs.focusQueueSettings.breakMinutes === 'number' ? prefs.focusQueueSettings.breakMinutes : 0,
        };
    }
    // Restore queue session start time
    if (typeof prefs.queueSessionStart === 'number') {
        state.queueSessionStart = prefs.queueSessionStart;
    }
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
    const deepViewBtn = document.getElementById('deep-view-btn');
    if (deepViewBtn) {
        deepViewBtn.classList.toggle('active', state.deepView);
        deepViewBtn.title = state.deepView ? 'Showing all layers' : 'Show all layers';
    }
    syncBookmarksBtn();
}

// ─── Bookmarks ───
function toggleBookmark(itemId) {
    const idx = state.bookmarks.indexOf(itemId);
    if (idx === -1) {
        state.bookmarks.push(itemId);
    } else {
        state.bookmarks.splice(idx, 1);
    }
    savePref('bookmarks', state.bookmarks);
    syncBookmarksBtn();
}

function syncBookmarksBtn() {
    const btn = document.getElementById('bookmarks-btn');
    if (!btn) return;
    btn.title = state.bookmarks.length > 0
        ? `Bookmarks (${state.bookmarks.length})`
        : 'Bookmarks';
}

function dismissBookmarksDropdown() {
    const existing = document.querySelector('.bookmarks-dropdown');
    if (existing) existing.remove();
    document.removeEventListener('click', _bookmarksOutsideClick);
}

function _bookmarksOutsideClick(e) {
    const dropdown = document.querySelector('.bookmarks-dropdown');
    const btn = document.getElementById('bookmarks-btn');
    if (dropdown && !dropdown.contains(e.target) && e.target !== btn) {
        dismissBookmarksDropdown();
    }
}

function showBookmarksDropdown() {
    // Toggle: if already open, close it
    if (document.querySelector('.bookmarks-dropdown')) {
        dismissBookmarksDropdown();
        return;
    }

    const btn = document.getElementById('bookmarks-btn');
    const rect = btn.getBoundingClientRect();

    const dropdown = document.createElement('div');
    dropdown.className = 'bookmarks-dropdown';
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.left = `${rect.left}px`;

    // Auto-prune deleted bookmarks
    state.bookmarks = state.bookmarks.filter(id => findItemById(id));

    if (state.bookmarks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'bookmarks-empty';
        empty.textContent = 'No bookmarks yet';
        dropdown.appendChild(empty);
    } else {
        for (const id of state.bookmarks) {
            const item = findItemById(id);
            if (!item) continue;

            const row = document.createElement('div');
            row.className = 'bookmarks-dropdown-item';
            if (state.selectedItemId === id) row.classList.add('selected');

            // Build breadcrumb
            const ancestorPath = getAncestorPath(id);
            const breadcrumb = ancestorPath
                ? ancestorPath.slice(0, -1).map(a => a.name).join(' › ')
                : '';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'bookmarks-item-name';
            nameSpan.textContent = item.name;
            row.appendChild(nameSpan);

            if (breadcrumb) {
                const crumbSpan = document.createElement('span');
                crumbSpan.className = 'bookmarks-item-crumb';
                crumbSpan.textContent = breadcrumb;
                row.appendChild(crumbSpan);
            }

            // Remove button
            const removeBtn = document.createElement('button');
            removeBtn.className = 'bookmarks-item-remove';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove bookmark';
            removeBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                toggleBookmark(id);
                // Re-render dropdown
                dismissBookmarksDropdown();
                showBookmarksDropdown();
            });
            row.appendChild(removeBtn);

            row.addEventListener('click', () => {
                dismissBookmarksDropdown();
                state.selectedItemId = id;
                savePref('selectedItemId', id);
                // Expand ancestors so the item is visible in the tree
                if (ancestorPath) {
                    for (const ancestor of ancestorPath.slice(0, -1)) {
                        ancestor.expanded = true;
                    }
                }
                renderAll();
                // Scroll to the item in the project tree
                requestAnimationFrame(() => {
                    const el = document.querySelector(`.project-item[data-id="${id}"]`);
                    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                });
            });

            dropdown.appendChild(row);
        }
    }

    document.body.appendChild(dropdown);

    // Clamp to viewport
    const dRect = dropdown.getBoundingClientRect();
    if (dRect.right > window.innerWidth) {
        dropdown.style.left = `${window.innerWidth - dRect.width - 6}px`;
    }
    if (dRect.bottom > window.innerHeight) {
        dropdown.style.top = `${window.innerHeight - dRect.height - 6}px`;
    }

    requestAnimationFrame(() => {
        document.addEventListener('click', _bookmarksOutsideClick);
    });
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

// ── Microtask-coalesced renderAll: multiple calls within the same frame execute only once ──
let _renderAllPending = false;
function renderAll() {
    if (_renderAllPending) return;
    _renderAllPending = true;
    queueMicrotask(() => {
        _renderAllPending = false;
        _renderAllCore();
    });
}
function _renderAllCore() {
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

    renderHorizonTower();
    updateContextLabels();
    checkHeaderOverlap();
    updateDateNav();
    // Defer heavy renders so the tower updates visually first
    requestAnimationFrame(() => {
        renderProjects();
        renderActions();
        if (state._skipTimelineRender) {
            state._skipTimelineRender = false;
        } else {
            renderTimeline();
        }
    });
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

// Determine directional animation type when navigating between two project selections
function getProjectNavRelationship(oldId, newId) {
    // Returns { type: 'descendant'|'ancestor'|'sibling'|'unrelated'|'none', swipeDirection?: 'left'|'right' }
    if (!oldId || !newId || oldId === newId) return { type: 'none' };

    const oldAncestors = getAncestorPath(oldId) || [];
    const newAncestors = getAncestorPath(newId) || [];

    // Check descendant: new's ancestors contain old
    if (newAncestors.some(a => a.id === oldId)) return { type: 'descendant' };

    // Check ancestor: old's ancestors contain new
    if (oldAncestors.some(a => a.id === newId)) return { type: 'ancestor' };

    // Check sibling: same parent
    const oldParentId = oldAncestors.length > 0 ? oldAncestors[oldAncestors.length - 1].id : '_root';
    const newParentId = newAncestors.length > 0 ? newAncestors[newAncestors.length - 1].id : '_root';

    if (oldParentId === newParentId) {
        const siblings = oldParentId === '_root' ? state.items.items
            : (oldAncestors[oldAncestors.length - 1].children || []);
        const oldIdx = siblings.findIndex(s => s.id === oldId);
        const newIdx = siblings.findIndex(s => s.id === newId);
        return { type: 'sibling', swipeDirection: newIdx > oldIdx ? 'left' : 'right' };
    }

    // Unrelated: find divergence point in ancestor paths and determine direction there
    const oldFullPath = [...oldAncestors.map(a => a.id), oldId];
    const newFullPath = [...newAncestors.map(a => a.id), newId];
    let divergeIdx = 0;
    for (let i = 0; i < Math.min(oldFullPath.length, newFullPath.length); i++) {
        if (oldFullPath[i] === newFullPath[i]) { divergeIdx = i + 1; }
        else break;
    }
    // Determine swipe direction based on sibling order at divergence level
    const commonAncestor = divergeIdx > 0 ? findItemById(oldFullPath[divergeIdx - 1]) : null;
    const divergeSiblings = commonAncestor ? (commonAncestor.children || []) : state.items.items;
    const oldBranchId = oldFullPath[divergeIdx];
    const newBranchId = newFullPath[divergeIdx];
    if (oldBranchId && newBranchId) {
        const oldBranchIdx = divergeSiblings.findIndex(s => s.id === oldBranchId);
        const newBranchIdx = divergeSiblings.findIndex(s => s.id === newBranchId);
        return { type: 'unrelated', swipeDirection: newBranchIdx > oldBranchIdx ? 'left' : 'right' };
    }
    return { type: 'unrelated', swipeDirection: 'left' };
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
function isEpochContext(ctx) { return EPOCH_CONTEXTS.includes(ctx) || isMonthContext(ctx) || isWeekContext(ctx); }

// Month-level context: "month:2026-02"
function isMonthContext(ctx) { return typeof ctx === 'string' && /^month:\d{4}-\d{2}$/.test(ctx); }

// Get month key from a Date: "month:2026-02"
function getMonthKey(date) {
    return `month:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Get logical month date range — snaps to complete weeks using weekStartDay.
// A week belongs to the month where 4+ of its days fall.
function getMonthDateRange(monthKey) {
    const m = monthKey.match(/^month:(\d{4})-(\d{2})$/);
    if (!m) return null;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1; // 0-indexed
    const calStart = new Date(year, month, 1);
    const calEnd = new Date(year, month + 1, 0); // last day of month

    const wsd = state.settings.weekStartDay ?? 0; // 0=Sun default

    // Snap start: roll back calStart to the nearest weekStartDay
    const startDiff = (calStart.getDay() - wsd + 7) % 7;
    const logicalStart = new Date(calStart);
    logicalStart.setDate(calStart.getDate() - startDiff);
    // But only include this week if 4+ days fall in the calendar month
    const daysInMonth = startDiff > 0 ? 7 - startDiff : 7;
    if (daysInMonth < 4 && startDiff > 0) {
        // This partial first week belongs to prev month — start at next week
        logicalStart.setDate(logicalStart.getDate() + 7);
    }

    // Snap end: roll forward calEnd to complete the week
    const endDiff = (wsd + 6 - calEnd.getDay() + 7) % 7;
    const logicalEnd = new Date(calEnd);
    logicalEnd.setDate(calEnd.getDate() + endDiff);
    // But only include this week if 4+ days fall in the calendar month
    const daysInMonthEnd = endDiff > 0 ? 7 - endDiff : 7;
    if (daysInMonthEnd < 4 && endDiff > 0) {
        // This partial last week belongs to next month — end at prev week
        logicalEnd.setDate(logicalEnd.getDate() - 7);
    }

    return { start: logicalStart, end: logicalEnd };
}

// Check if a week key falls within a month's logical range
function isWeekInMonth(weekKey, monthKey) {
    const monthRange = getMonthDateRange(monthKey);
    const weekRange = getWeekDateRange(weekKey);
    if (!monthRange || !weekRange) return false;
    const weekStartKey = getDateKey(weekRange.start);
    const monthStartKey = getDateKey(monthRange.start);
    const monthEndKey = getDateKey(monthRange.end);
    return weekStartKey >= monthStartKey && weekStartKey <= monthEndKey;
}

// Check if an item belongs to a given month
// (has explicit month context OR a week context within that month)
function isItemInMonth(item, monthKey) {
    if (!item) return false;
    const tcs = item.timeContexts || [];
    return tcs.includes(monthKey);
}

// Send an item to a month backlog — strips other temporal contexts, adds month context.
async function sendToMonth(itemId, monthKey, sourceDuration) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item) return;
    item.timeContexts = [monthKey];
    if (!item.contextDurations) item.contextDurations = {};
    const dur = sourceDuration != null ? sourceDuration : (item.contextDurations[Object.keys(item.contextDurations)[0]] ?? undefined);
    item.contextDurations = {};
    if (dur != null) item.contextDurations[monthKey] = dur;
    await api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}

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

// ─── Context-Scoped Done Helpers ───
// contextDone is an object on each item: { "2026-02-23": timestamp, "week:2026-02-16": timestamp, ... }
// Hierarchy (bottom to top): segment/entry → date → week → month → epoch → item.done (global kill switch)

// Get the parent context keys for a given context, walking up the hierarchy.
// Returns an array from immediate parent upward, e.g. for "2026-02-23@10:00-12:00":
//   ["2026-02-23", "week:2026-02-16", "month:2026-02", "ongoing"]
function _getAncestorContexts(ctx) {
    const parsed = parseTimeContext(ctx);
    if (!parsed) return [];
    const ancestors = [];

    // segment/entry → its date
    if (parsed.segment || parsed.entryId) {
        ancestors.push(parsed.date);
    }

    // date → its week → its month → its epoch
    const dateStr = parsed.date || (parsed.segment ? parsed.date : null);
    if (dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        ancestors.push(getWeekKey(dateObj));
        ancestors.push(getMonthKey(dateObj));
        // Add all epoch contexts as top-level ancestors
        for (const ep of EPOCH_CONTEXTS) ancestors.push(ep);
    } else if (parsed.week) {
        // week → its month (use week start date) → epoch
        const weekKey = 'week:' + parsed.week;
        const range = getWeekDateRange(weekKey);
        if (range) ancestors.push(getMonthKey(range.start));
        for (const ep of EPOCH_CONTEXTS) ancestors.push(ep);
    } else if (parsed.month) {
        // month → epoch
        for (const ep of EPOCH_CONTEXTS) ancestors.push(ep);
    }
    // epoch → nothing above (item.done is checked separately)

    return ancestors;
}

// Check if an item is "done" in the given view context.
// Resolution: item.done (global) → exact contextDone match → walk up ancestors.
function isContextDone(item, viewContext) {
    if (!item) return false;
    if (item.done) return true; // global kill switch
    if (!item.contextDone) return false;
    // Exact match
    if (item.contextDone[viewContext]) return true;
    // Walk up the hierarchy
    const ancestors = _getAncestorContexts(viewContext);
    for (const ancestor of ancestors) {
        if (item.contextDone[ancestor]) return true;
    }
    return false;
}

// Set or clear a context-done entry. Stores Date.now() as timestamp when marking done.
async function setContextDone(item, contextKey, done) {
    if (!item) return;
    if (!item.contextDone) item.contextDone = {};
    if (done) {
        item.contextDone[contextKey] = Date.now();
    } else {
        delete item.contextDone[contextKey];
    }
    await api.patch(`/items/${item.id}`, { contextDone: item.contextDone });
}

// Returns info about at which level the item is done in the given context, or null if not done.
// { level: 'item'|'exact'|'ancestor', key: contextKey, timestamp: number }
function getContextDoneLevel(item, viewContext) {
    if (!item) return null;
    if (item.done) return { level: 'item', key: null, timestamp: null };
    if (!item.contextDone) return null;
    if (item.contextDone[viewContext]) {
        return { level: 'exact', key: viewContext, timestamp: item.contextDone[viewContext] };
    }
    const ancestors = _getAncestorContexts(viewContext);
    for (const ancestor of ancestors) {
        if (item.contextDone[ancestor]) {
            return { level: 'ancestor', key: ancestor, timestamp: item.contextDone[ancestor] };
        }
    }
    return null;
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
    if (isMonthContext(ctx)) return { month: ctx.substring(6) }; // strip "month:" prefix
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

// Check if an item's timeContexts overlap a given segment range.
// Returns the matching context string, or null if no overlap.
// Used by both free-time-block intentions and session-focused actions filtering.
function itemOverlapsSegment(item, segCtx, dateKey, startMs, endMs) {
    if (!item || !item.timeContexts) return null;
    for (const tc of item.timeContexts) {
        if (tc === segCtx) return tc;
        const parsed = parseTimeContext(tc);
        if (!parsed || !parsed.segment || parsed.date !== dateKey) continue;
        const [sh, sm] = parsed.segment.start.split(':').map(Number);
        const [eh, em] = parsed.segment.end.split(':').map(Number);
        // Use dateKey (logical day) for reference, NOT startMs which may be past midnight
        const [ry, rmo, rd] = dateKey.split('-').map(Number);
        let tcStart = new Date(ry, rmo - 1, rd, sh, sm).getTime();
        let tcEnd = new Date(ry, rmo - 1, rd, eh, em).getTime();
        if (tcEnd <= tcStart) {
            tcEnd += 24 * 60 * 60 * 1000;
        } else {
            // Post-midnight tail: both times are in early morning of a cross-midnight day
            // e.g. "00:37-02:30" on a day that runs 08:00→02:30 — actual times are +1 day
            const dayTimes = getEffectiveDayTimes(new Date(ry, rmo - 1, rd));
            const dayCrossesMidnight = dayTimes.dayEndHour < dayTimes.dayStartHour ||
                (dayTimes.dayEndHour === dayTimes.dayStartHour && dayTimes.dayEndMinute < dayTimes.dayStartMinute);
            if (dayCrossesMidnight && sh < dayTimes.dayStartHour) {
                tcStart += 24 * 60 * 60 * 1000;
                tcEnd += 24 * 60 * 60 * 1000;
            }
        }
        const overlapStart = Math.max(startMs, tcStart);
        const overlapEnd = Math.min(endMs, tcEnd);
        if (overlapEnd > overlapStart) return tc;
    }
    return null;
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

// ─── Buffer Entry Helpers (Prep / Wind-Down) ───

// Get all buffer entries linked to a parent entry
function getBufferEntries(parentEntryId) {
    return (state.timeline?.entries || []).filter(e => e.bufferForEntryId === parentEntryId);
}

// Delete buffer entries for a parent entry AND clean up item contexts referencing them
async function deleteBuffersForEntry(parentEntryId) {
    const buffers = getBufferEntries(parentEntryId);
    for (const buf of buffers) {
        await degradeEntryContexts(buf.id);
        await api.del(`/timeline/${buf.id}`);
    }
}

// Create buffer entries for a parent planned entry based on its prepDuration / windDownDuration
async function createBufferEntries(parentEntry) {
    const buffers = [];
    if (parentEntry.prepDuration && parentEntry.prepDuration > 0) {
        const prepEnd = parentEntry.startTime || parentEntry.timestamp;
        const prepStart = prepEnd - parentEntry.prepDuration * 1000;
        const buf = await api.post('/timeline', {
            text: `Prep: ${parentEntry.text}`,
            type: 'planned',
            startTime: prepStart,
            endTime: prepEnd,
            itemId: null,
            bufferForEntryId: parentEntry.id,
            bufferType: 'prep',
        });
        state.timeline.entries.push(buf);
        buffers.push(buf);
    }
    if (parentEntry.windDownDuration && parentEntry.windDownDuration > 0) {
        const wdStart = parentEntry.endTime;
        const wdEnd = wdStart + parentEntry.windDownDuration * 1000;
        const buf = await api.post('/timeline', {
            text: `Wind-down: ${parentEntry.text}`,
            type: 'planned',
            startTime: wdStart,
            endTime: wdEnd,
            itemId: null,
            bufferForEntryId: parentEntry.id,
            bufferType: 'winddown',
        });
        state.timeline.entries.push(buf);
        buffers.push(buf);
    }
    return buffers;
}

// Sync buffer entries when parent's times or durations change
async function syncBufferEntries(parentEntry) {
    const existing = getBufferEntries(parentEntry.id);
    const prepDur = parentEntry.prepDuration || 0;
    const wdDur = parentEntry.windDownDuration || 0;
    const parentStart = parentEntry.startTime || parentEntry.timestamp;
    const parentEnd = parentEntry.endTime;

    // Handle prep buffer
    const existingPrep = existing.find(b => b.bufferType === 'prep');
    if (prepDur > 0) {
        const prepEnd = parentStart;
        const prepStart = prepEnd - prepDur * 1000;
        if (existingPrep) {
            await api.patch(`/timeline/${existingPrep.id}`, {
                startTime: prepStart, timestamp: prepStart, endTime: prepEnd,
                text: `Prep: ${parentEntry.text}`,
            });
        } else {
            const buf = await api.post('/timeline', {
                text: `Prep: ${parentEntry.text}`,
                type: 'planned', startTime: prepStart, endTime: prepEnd,
                itemId: null, bufferForEntryId: parentEntry.id, bufferType: 'prep',
            });
            state.timeline.entries.push(buf);
        }
    } else if (existingPrep) {
        await degradeEntryContexts(existingPrep.id);
        await api.del(`/timeline/${existingPrep.id}`);
    }

    // Handle wind-down buffer
    const existingWd = existing.find(b => b.bufferType === 'winddown');
    if (wdDur > 0) {
        const wdStart = parentEnd;
        const wdEnd = wdStart + wdDur * 1000;
        if (existingWd) {
            await api.patch(`/timeline/${existingWd.id}`, {
                startTime: wdStart, timestamp: wdStart, endTime: wdEnd,
                text: `Wind-down: ${parentEntry.text}`,
            });
        } else {
            const buf = await api.post('/timeline', {
                text: `Wind-down: ${parentEntry.text}`,
                type: 'planned', startTime: wdStart, endTime: wdEnd,
                itemId: null, bufferForEntryId: parentEntry.id, bufferType: 'winddown',
            });
            state.timeline.entries.push(buf);
        }
    } else if (existingWd) {
        await degradeEntryContexts(existingWd.id);
        await api.del(`/timeline/${existingWd.id}`);
    }
}

// ─── Plan Segments: derive the ordered session list from day entries ───
// Returns an array of { type, label, startMs, endMs, icon, entryId?, itemId?, segmentKey, dynamicStart?, _dynamicExpired? }
function buildPlanSegments(viewDate) {
    const { dayStart, dayEnd } = getDayBoundaries(viewDate || state.timelineViewDate);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();
    const dateKey = getDateKey(viewDate || state.timelineViewDate);
    const viewingToday = isCurrentDay(viewDate || state.timelineViewDate);
    const nowMs = Date.now();

    // Collect planned entries within the day
    const planned = (state.timeline?.entries || [])
        .filter(e => e.type === 'planned' && e.endTime && e.timestamp < dayEndMs &&
            (e.timestamp >= dayStartMs || e.dynamicStart))
        .sort((a, b) => a.timestamp - b.timestamp);

    // For dynamic-start entries, compute effective times
    // End time is blocked by the NEXT planned entry's start or day end
    const computedPlanned = planned.map((entry, idx) => {
        // For flex entries, the effective start is pushed by both dayStart and now (if viewing today)
        const pushBoundary = Math.max(dayStartMs, viewingToday ? nowMs : 0);
        if (!entry.dynamicStart || pushBoundary <= entry.timestamp) {
            return { entry, effectiveStart: entry.timestamp, effectiveEnd: entry.endTime, expired: false };
        }
        const effectiveStart = pushBoundary;
        // Original duration
        const origDuration = entry.endTime - entry.timestamp;
        // Find the blockage: next plan start or day end
        let blockage = dayEndMs;
        for (let j = idx + 1; j < planned.length; j++) {
            if (!planned[j].dynamicStart) { // static plans are hard blockages
                blockage = Math.min(blockage, planned[j].timestamp);
                break;
            }
        }
        // The ideal end = effectiveStart + origDuration, but capped by blockage
        let effectiveEnd = Math.min(effectiveStart + origDuration, blockage);
        // If already expired (start >= end), mark as expired
        const expired = effectiveStart >= effectiveEnd;
        if (expired) effectiveEnd = effectiveStart; // zero-width
        return { entry, effectiveStart, effectiveEnd, expired };
    });

    const segments = [];
    let cursor = dayStartMs;

    const _fmtTime = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    for (const { entry, effectiveStart, effectiveEnd, expired } of computedPlanned) {
        const entryStart = effectiveStart;
        const entryEnd = effectiveEnd;

        // Skip expired dynamic-start sessions entirely
        if (expired && entry.dynamicStart) continue;

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
        const remainingMins = Math.round((entryEnd - entryStart) / 60000);
        const isExpiring = entry.dynamicStart && remainingMins <= 5 && remainingMins > 0;
        segments.push({
            type: 'planned',
            label: `${entryLabel} · ${_fmtTime(entryStart)}–${_fmtTime(entryEnd)}`,
            startMs: entryStart,
            endMs: entryEnd,
            icon: entry.dynamicStart ? 'FLEX' : '📋',
            entryId: entry.id,
            itemId: entry.itemId || null,
            segmentKey: `${dateKey}@entry:${entry.id}`,
            dynamicStart: entry.dynamicStart || false,
            _dynamicExpiring: isExpiring,
            _originalStart: entry.timestamp,
            _originalEnd: entry.endTime,
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

// Reject unplanned work — delete the log entry (nothing was planned, dismiss it)
async function resolveDivergenceRejectUnplanned(workEntryId) {
    await api.del(`/timeline/${workEntryId}`);

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
        await deleteBuffersForEntry(entry.id);
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
            await api.del(`/timeline/${entry.id}`);
        } else {
            await api.patch(`/timeline/${entry.id}`, { endTime: div.gapStart });
        }
    } else {
        // Work starts before day start — trim timestamp to gapEnd (day start)
        if (entry.endTime <= div.gapEnd) {
            // Entire entry is in the gap — delete it
            await api.del(`/timeline/${entry.id}`);
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
    planBtn.title = 'Accept plan — nothing was planned, delete this log';
    planBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resolveDivergenceRejectUnplanned(workEntry.id);
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
            planBtn.title = 'Accept plan — nothing was planned, delete this log';
            planBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                resolveDivergenceRejectUnplanned(div.workEntry.id);
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
    const slideDir = direction < 0 ? 'right' : 'left';
    animateNavTransition(slideDir, () => {
        const newIndex = state.sessionIndex + direction;
        if (newIndex < 0) {
            // Cross to previous day — select its last session
            state.timelineViewDate.setDate(state.timelineViewDate.getDate() - 1);
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            const prevSegments = buildPlanSegments();
            state.sessionIndex = prevSegments.length - 1;
        } else if (newIndex >= segments.length) {
            // Cross to next day — select its first session
            state.timelineViewDate.setDate(state.timelineViewDate.getDate() + 1);
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            state.sessionIndex = 0;
        } else {
            state.sessionIndex = newIndex;
        }
        savePref('sessionIndex', state.sessionIndex);
        const activeSegments = buildPlanSegments();
        _syncSessionToFocusStack(activeSegments[state.sessionIndex]);
        state._animateActions = true;
        renderAll();
    });
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

// ─── Focus Queue Helpers ───

function addToQueue(itemId) {
    if (state.focusQueue.some(q => q.itemId === itemId)) return; // deduplicate
    const item = findItemById(itemId);
    if (!item) return;
    const ancestors = getAncestorPath(itemId);
    const projectName = (ancestors && ancestors.length > 0) ? ancestors.map(a => a.name).join(' › ') : '';
    const durationMs = (getContextDuration(item) || 0) * 60000; // context-aware duration (stored in mins → convert to ms)
    state.focusQueue.push({ itemId, itemName: item.name, projectName, durationMs });
    savePref('focusQueue', state.focusQueue);
}

function removeFromQueue(itemId) {
    state.focusQueue = state.focusQueue.filter(q => q.itemId !== itemId);
    savePref('focusQueue', state.focusQueue);
}

function removeFromQueueByIndex(idx) {
    state.focusQueue.splice(idx, 1);
    savePref('focusQueue', state.focusQueue);
}

function addBreakToQueue(durationMs) {
    state.focusQueue.push({ type: 'break', durationMs: durationMs || 300000 });
    savePref('focusQueue', state.focusQueue);
}

function reorderQueue(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= state.focusQueue.length) return;
    if (toIndex < 0 || toIndex >= state.focusQueue.length) return;
    const [item] = state.focusQueue.splice(fromIndex, 1);
    state.focusQueue.splice(toIndex, 0, item);
    savePref('focusQueue', state.focusQueue);
}

function clearQueue() {
    state.focusQueue = [];
    savePref('focusQueue', state.focusQueue);
}

function isInQueue(itemId) {
    return state.focusQueue.some(q => q.itemId === itemId);
}

// Advance the queue: start next item or break.
async function advanceQueue() {
    if (state.focusQueue.length === 0) return;

    // Track queue session start time (first advance = session begins)
    if (!state.queueSessionStart) {
        state.queueSessionStart = Date.now();
        savePref('queueSessionStart', state.queueSessionStart);
    }

    const next = state.focusQueue.shift();
    savePref('focusQueue', state.focusQueue);

    // Handle break-type queue entries
    if (next.type === 'break') {
        const targetEnd = Date.now() + (next.durationMs || 300000);
        await startBreak(targetEnd);
        return;
    }

    // Work item — start with timed session if duration set
    const targetEndTime = next.durationMs > 0 ? Date.now() + next.durationMs : null;
    await startWorking(next.itemId, next.itemName, next.projectName, targetEndTime);
}

// Pause working: stop current item, re-insert it AFTER the next item in queue, then advance.
// This means: the next item starts immediately, and the paused item becomes "up next" after it.
async function pauseWorking() {
    if (!state.workingOn) return;
    if (state.focusQueue.length === 0) return; // need at least one item to advance to
    const cur = state.workingOn;
    // Calculate remaining duration (if timed)
    let remainingMs = 0;
    if (cur.targetEndTime) {
        remainingMs = Math.max(0, cur.targetEndTime - Date.now());
    }
    const entry = {
        itemId: cur.itemId,
        itemName: cur.itemName,
        projectName: cur.projectName,
        durationMs: remainingMs, // carry over remaining time (0 = untimed)
    };
    state._suppressQueueAdvance = true;
    await stopWorking();
    state._suppressQueueAdvance = false;
    // Insert at position 1 (after the head, which is the next item about to start)
    state.focusQueue.splice(1, 0, entry);
    savePref('focusQueue', state.focusQueue);
    // Advance: start the head item (the original next)
    await advanceQueue();
}

// Spotify-style insertion: stop current, re-queue it as next, start the new item.
async function insertAtQueueHead(itemId) {
    const item = findItemById(itemId);
    if (!item) return;

    // Build queue entry for the item being interrupted
    if (state.workingOn) {
        const curEntry = {
            itemId: state.workingOn.itemId,
            itemName: state.workingOn.itemName,
            projectName: state.workingOn.projectName,
        };
        // Stop current (logs to timeline), but suppress auto-advance
        state._suppressQueueAdvance = true;
        await stopWorking();
        state._suppressQueueAdvance = false;

        // Re-insert the interrupted item at the head of the queue
        // (only if it wasn't already the same item)
        if (curEntry.itemId !== itemId) {
            state.focusQueue.unshift(curEntry);
        }
    }

    // Start the new item
    const ancestors = getAncestorPath(itemId);
    const projectName = (ancestors && ancestors.length > 0) ? ancestors.map(a => a.name).join(' › ') : '';
    await startWorking(itemId, item.name, projectName);
    savePref('focusQueue', state.focusQueue);
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
        // Exact bare-date match (e.g. "2026-02-14" matches dateKey "2026-02-14")
        if (ownContexts.includes(dateKey)) return true;
        // Epoch contexts — items with epoch only show via deadline shadow, not day views
        if (ownContexts.some(tc => isEpochContext(tc))) {
            if (item && _deadlineShadowMatchesDate(item, dateKey)) return true;
            return false;
        }
        // Segment/entry contexts (e.g. "2026-02-14@13:08-00:30") do NOT match the bare
        // date view — they only appear when their specific segment is focused (handled
        // by the session focus filter).
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
    if (state.viewHorizon === 'live') {
        const dateKey = getDateKey(getLogicalToday());
        if (state.workingOn) return [dateKey, `${dateKey}@work`];
        if (state.onBreak) return [dateKey, `${dateKey}@break`];
        return [dateKey]; // idle — items created go to the day
    }
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
    if (state.viewHorizon === 'month') return [getMonthKey(state.timelineViewDate)];
    if (state.viewHorizon === 'week') return [getWeekKey(state.timelineViewDate)];
    return [getDateKey(state.timelineViewDate)];
}

// Return the single most-specific context string for the current view state.
// Used by the duration picker / badge to read/write context-coupled durations.
function getCurrentViewContext() {
    if (state.viewHorizon === 'live') {
        const dateKey = getDateKey(getLogicalToday());
        if (state.workingOn) return `${dateKey}@work`;
        if (state.onBreak) return `${dateKey}@break`;
        return dateKey;
    }
    const focused = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    if (focused && focused.segmentKey) return focused.segmentKey;
    if (focused && focused.liveType) return `${getDateKey(state.timelineViewDate)}@${focused.liveType}`;
    if (focused && focused.entryId) return `${getDateKey(state.timelineViewDate)}@entry:${focused.entryId}`;
    if (state.viewHorizon === 'epoch') return state.epochFilter;
    if (state.viewHorizon === 'month') return getMonthKey(state.timelineViewDate);
    if (state.viewHorizon === 'week') return getWeekKey(state.timelineViewDate);
    return getDateKey(state.timelineViewDate);
}

// ─── D&D Move vs Copy Helpers ───

// Determine if a drag-and-drop operation is a "copy" (keep source context) or "move" (remove source).
// Projects → always copy. Ctrl/Cmd held → always copy. Otherwise → move.
function _isDragCopy(e) {
    const src = e.dataTransfer.getData('application/x-drag-source');
    if (src === 'project') return true; // always copy from projects
    return e.ctrlKey || e.metaKey; // Ctrl/Cmd = force copy
}

// Remove only the source time context from an item (for "move" semantics).
// Unlike sendToEpoch/sendToWeek etc., this does NOT replace all contexts — it removes just the one.
// If the exact sourceContext isn't found (e.g. plan boundaries were resized), falls back to
// fuzzy overlap matching: finds a stored context on the same date with overlapping time ranges.
async function removeSourceContext(itemId, sourceContext) {
    itemId = Number(itemId);
    const item = findItemById(itemId);
    if (!item || !item.timeContexts) return;
    if (!sourceContext) return;
    // Try exact match first
    let contextToRemove = sourceContext;
    if (!item.timeContexts.includes(sourceContext)) {
        // Fuzzy fallback: find a stored context that overlaps the source segment
        const parsed = parseTimeContext(sourceContext);
        if (parsed && parsed.date && parsed.segment) {
            const [rsh, rsm] = parsed.segment.start.split(':').map(Number);
            const [reh, rem] = parsed.segment.end.split(':').map(Number);
            // Use the context's date as reference, not current date
            const [ry, rmo, rd] = parsed.date.split('-').map(Number);
            let refStart = new Date(ry, rmo - 1, rd, rsh, rsm).getTime();
            let refEnd = new Date(ry, rmo - 1, rd, reh, rem).getTime();
            // Detect cross-midnight day for post-midnight tail handling
            const dayTimes = getEffectiveDayTimes(new Date(ry, rmo - 1, rd));
            const xm = dayTimes.dayEndHour < dayTimes.dayStartHour ||
                (dayTimes.dayEndHour === dayTimes.dayStartHour && dayTimes.dayEndMinute < dayTimes.dayStartMinute);
            if (refEnd <= refStart) {
                refEnd += 24 * 60 * 60 * 1000;
            } else if (xm && rsh < dayTimes.dayStartHour) {
                // Post-midnight tail: both times in early AM of cross-midnight day
                refStart += 24 * 60 * 60 * 1000;
                refEnd += 24 * 60 * 60 * 1000;
            }

            for (const tc of item.timeContexts) {
                const tp = parseTimeContext(tc);
                if (!tp || !tp.segment || tp.date !== parsed.date) continue;
                const [ksh, ksm] = tp.segment.start.split(':').map(Number);
                const [keh, kem] = tp.segment.end.split(':').map(Number);
                let kStart = new Date(ry, rmo - 1, rd, ksh, ksm).getTime();
                let kEnd = new Date(ry, rmo - 1, rd, keh, kem).getTime();
                if (kEnd <= kStart) {
                    kEnd += 24 * 60 * 60 * 1000;
                } else if (xm && ksh < dayTimes.dayStartHour) {
                    kStart += 24 * 60 * 60 * 1000;
                    kEnd += 24 * 60 * 60 * 1000;
                }
                if (Math.min(refEnd, kEnd) > Math.max(refStart, kStart)) {
                    contextToRemove = tc; // found overlapping stored context
                    break;
                }
            }
        }
    }
    // Remove the resolved context
    const before = item.timeContexts.length;
    item.timeContexts = item.timeContexts.filter(tc => tc !== contextToRemove);
    // Capture duration before deleting, so callers can migrate it
    const removedDuration = item.contextDurations?.[contextToRemove];
    // Clean up duration for removed context
    if (item.contextDurations && contextToRemove in item.contextDurations) {
        delete item.contextDurations[contextToRemove];
    }
    // If no contexts remain, fall back to 'ongoing'
    if (item.timeContexts.length === 0) {
        item.timeContexts.push('ongoing');
    }
    // Only persist if something changed
    if (item.timeContexts.length !== before) {
        const patch = { timeContexts: item.timeContexts };
        if (item.contextDurations) patch.contextDurations = item.contextDurations;
        await api.patch(`/items/${itemId}`, patch);
    }
    return removedDuration;
}

// Find a key in contextDurations whose segment overlaps the given context string.
// Returns the matching key or null.
function findOverlappingContextKey(contextDurations, ctx) {
    const parsed = parseTimeContext(ctx);
    if (!parsed || !parsed.segment) return null;
    const [rsh, rsm] = parsed.segment.start.split(':').map(Number);
    const [reh, rem] = parsed.segment.end.split(':').map(Number);
    // Use the context's date as reference, not current date
    const [ry, rmo, rd] = parsed.date.split('-').map(Number);
    let refStart = new Date(ry, rmo - 1, rd, rsh, rsm).getTime();
    let refEnd = new Date(ry, rmo - 1, rd, reh, rem).getTime();
    // Detect cross-midnight day for post-midnight tail handling
    const dayTimes = getEffectiveDayTimes(new Date(ry, rmo - 1, rd));
    const xm = dayTimes.dayEndHour < dayTimes.dayStartHour ||
        (dayTimes.dayEndHour === dayTimes.dayStartHour && dayTimes.dayEndMinute < dayTimes.dayStartMinute);
    if (refEnd <= refStart) {
        refEnd += 24 * 60 * 60 * 1000;
    } else if (xm && rsh < dayTimes.dayStartHour) {
        refStart += 24 * 60 * 60 * 1000;
        refEnd += 24 * 60 * 60 * 1000;
    }

    for (const key of Object.keys(contextDurations)) {
        const kp = parseTimeContext(key);
        if (!kp || !kp.segment || kp.date !== parsed.date) continue;
        const [ksh, ksm] = kp.segment.start.split(':').map(Number);
        const [keh, kem] = kp.segment.end.split(':').map(Number);
        let kStart = new Date(ry, rmo - 1, rd, ksh, ksm).getTime();
        let kEnd = new Date(ry, rmo - 1, rd, keh, kem).getTime();
        if (kEnd <= kStart) {
            kEnd += 24 * 60 * 60 * 1000;
        } else if (xm && ksh < dayTimes.dayStartHour) {
            kStart += 24 * 60 * 60 * 1000;
            kEnd += 24 * 60 * 60 * 1000;
        }
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

// Get the REMAINING duration for an item (budget minus already-invested time).
// Used when starting work so the timer reflects how much is left, not the total planned.
function getRemainingDuration(item, ctx) {
    if (!item) return 0;
    if (!ctx) ctx = getCurrentViewContext();
    const inv = computeTimeInvestment(item, ctx);
    if (inv && inv.budget > 0) return Math.max(0, inv.remaining);
    return getContextDuration(item, ctx);
}

// ─── Time Investment Computation ───
// Tri-state badge: invested (tracked work), planned (descendant durations + planned entries), remaining.

// Cached work entry lookup: itemId → [entries]. Rebuilt each render cycle.
let _workEntryIndex = null;

function _buildWorkEntryIndex() {
    _workEntryIndex = new Map();
    for (const e of state.timeline.entries) {
        if (e.type === 'work' && e.itemId != null && e.startTime && e.endTime) {
            if (!_workEntryIndex.has(e.itemId)) _workEntryIndex.set(e.itemId, []);
            _workEntryIndex.get(e.itemId).push(e);
        }
    }
}

function _invalidateWorkEntryIndex() {
    _workEntryIndex = null;
}

// Convert a context string to a time window { startMs, endMs }.
function getTimeWindowForContext(ctx) {
    if (!ctx) return null;
    const parsed = parseTimeContext(ctx);
    if (!parsed) return null;

    // Epoch contexts → no bounded time window
    if (parsed.epoch) return null;

    // Month context
    if (parsed.month) {
        const monthKey = `month:${parsed.month}`;
        const range = getMonthDateRange(monthKey);
        if (!range) return null;
        return { startMs: range.start.getTime(), endMs: range.end.getTime() + 86400000 }; // end is inclusive day
    }

    // Week context
    if (parsed.week) {
        const weekKey = `week:${parsed.week}`;
        const range = getWeekDateRange(weekKey);
        if (!range) return null;
        return { startMs: range.start.getTime(), endMs: range.end.getTime() + 86400000 };
    }

    // Day context (possibly with segment)
    if (parsed.date) {
        if (parsed.segment) {
            // Segment: build precise ms window
            const [y, m, d] = parsed.date.split('-').map(Number);
            const [sh, sm] = parsed.segment.start.split(':').map(Number);
            const [eh, em] = parsed.segment.end.split(':').map(Number);
            const startD = new Date(y, m - 1, d, sh, sm, 0, 0);
            const endD = new Date(y, m - 1, d, eh, em, 0, 0);
            if (endD <= startD) endD.setDate(endD.getDate() + 1); // overnight
            return { startMs: startD.getTime(), endMs: endD.getTime() };
        }
        // Plain day
        const [y, m, d] = parsed.date.split('-').map(Number);
        const dayDate = new Date(y, m - 1, d);
        const { dayStart, dayEnd } = getDayBoundaries(dayDate);
        return { startMs: dayStart.getTime(), endMs: dayEnd.getTime() };
    }

    return null;
}

// Check if a context key falls within a time window.
function _contextFallsInWindow(ctxKey, window) {
    const ctxWindow = getTimeWindowForContext(ctxKey);
    if (!ctxWindow) return false;
    // Context overlaps window if they intersect
    return ctxWindow.startMs < window.endMs && ctxWindow.endMs > window.startMs;
}

// Compute time investment breakdown for an item at the current view context.
// Returns { budget, invested, planned, remaining } in minutes, or null if no data.
function computeTimeInvestment(item, viewCtx) {
    if (!item) return null;
    if (!viewCtx) viewCtx = getCurrentViewContext();

    // 1. Budget = this item's contextDuration at current context
    const budget = getContextDuration(item, viewCtx);

    // 2. Time window for filtering
    const window = getTimeWindowForContext(viewCtx);

    // 3. Collect descendant IDs (project axis)
    const descIds = collectDescendantIds(item);
    const descIdSet = new Set(descIds);

    // 4. Invested = sum of work entry durations in window
    if (!_workEntryIndex) _buildWorkEntryIndex();
    let investedMs = 0;
    for (const id of descIds) {
        const entries = _workEntryIndex.get(id);
        if (!entries) continue;
        for (const e of entries) {
            if (!window) {
                // No window (epoch) — count all
                investedMs += (e.endTime - e.startTime);
            } else {
                const s = Math.max(e.startTime, window.startMs);
                const end = Math.min(e.endTime, window.endMs);
                if (end > s) investedMs += (end - s);
            }
        }
    }
    const invested = Math.round(investedMs / 60000);

    // 5. Planned = contextDurations at FINER levels (self + descendants) + planned timeline entries
    let planned = 0;

    // Hierarchy: epoch(4) > month(3) > week(2) > day(1) > segment(0)
    function _contextLevel(ctx) {
        const p = parseTimeContext(ctx);
        if (!p) return -1;
        if (p.epoch) return 4;
        if (p.month) return 3;
        if (p.week) return 2;
        if (p.date && p.segment) return 0;
        if (p.date) return 1;
        return -1;
    }
    const viewLevel = _contextLevel(viewCtx);

    // a) contextDurations from self (skip budget key) and descendants — only LOWER levels
    for (const id of descIds) {
        const desc = id === item.id ? item : findItemById(id);
        if (!desc || desc.done) continue;
        if (!desc.contextDurations) continue;
        for (const [ctxKey, dur] of Object.entries(desc.contextDurations)) {
            if (dur <= 0) continue;
            // Skip the exact key that is the budget (self at current context)
            if (id === item.id && ctxKey === viewCtx) continue;
            // Only count contexts at a finer granularity than the view
            if (_contextLevel(ctxKey) >= viewLevel) continue;
            if (!window || _contextFallsInWindow(ctxKey, window)) {
                planned += dur;
            }
        }
    }

    // b) Planned timeline entries
    for (const e of state.timeline.entries) {
        if (e.type !== 'planned') continue;
        if (!descIdSet.has(e.itemId)) continue;
        if (!window) {
            planned += Math.round(((e.endTime || 0) - (e.startTime || 0)) / 60000);
        } else {
            const s = Math.max(e.startTime || 0, window.startMs);
            const end = Math.min(e.endTime || 0, window.endMs);
            if (end > s) planned += Math.round((end - s) / 60000);
        }
    }

    // No data at all? return null
    if (budget === 0 && invested === 0 && planned === 0) return null;

    const remaining = budget > 0 ? Math.max(0, budget - invested - planned) : 0;

    return { budget, invested, planned, remaining };
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
        // Suppression: skip if already scheduled for this exact date or dismissed
        if (item.timeContexts?.includes(dateKey)) continue;
        if (item.leadTimeDismissed?.[ctx]?.includes(dateKey)) continue;
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
        // Suppression: skip if already scheduled for this week or dismissed
        if (item.timeContexts?.includes(weekKey)) continue;
        if (item.leadTimeDismissed?.[ctx]?.includes(weekKey)) continue;
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
async function addTimeContext(itemId, dateKey, seedDuration) {
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.timeContexts) item.timeContexts = [];
    let changed = false;
    if (!item.timeContexts.includes(dateKey)) {
        item.timeContexts.push(dateKey);
        changed = true;
    }
    // Seed duration if provided
    if (seedDuration != null) {
        if (!item.contextDurations) item.contextDurations = {};
        item.contextDurations[dateKey] = seedDuration;
        changed = true;
    }
    if (changed) {
        const patch = { timeContexts: item.timeContexts };
        if (item.contextDurations) patch.contextDurations = item.contextDurations;
        await api.patch(`/items/${itemId}`, patch);
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
                    // Keep epoch and week and month contexts as-is
                    if (parsed.epoch) return true;
                    if (isWeekContext(tc)) return true;
                    if (isMonthContext(tc)) return true;
                    // Keep deadline contexts (anti-degradation) — they persist as overdue
                    if (isDeadlineContext(item, tc)) return true;
                    // Keep overnight segments that are still live
                    if (parsed.date < todayKey && parsed.segment && _isOvernightSegmentLive(parsed, today)) return true;
                    return parsed.date >= todayKey;
                });
                // If we removed date contexts and nothing date-level remains, degrade to week
                if (item.timeContexts.length !== before) {
                    dirty = true;
                    // Migrate duration from removed contexts
                    if (item.contextDurations) {
                        // Find removed context keys (were in original but not in filtered)
                        const removedKeys = Object.keys(item.contextDurations).filter(
                            k => !item.timeContexts.some(tc => tc === k || k.startsWith(tc))
                        );
                        // Capture the max duration from removed contexts for migration
                        var migratedDuration = null;
                        for (const rk of removedKeys) {
                            const dur = item.contextDurations[rk];
                            if (dur != null && (migratedDuration == null || dur > migratedDuration)) {
                                migratedDuration = dur;
                            }
                        }
                    }
                    const hasRemainingDates = item.timeContexts.some(tc => {
                        const p = parseTimeContext(tc);
                        return p && p.date;
                    });
                    const hasWeek = item.timeContexts.some(tc => isWeekContext(tc));
                    if (hadDateContexts && !hasRemainingDates && !hasWeek && !item.timeContexts.some(tc => EPOCH_CONTEXTS.includes(tc))) {
                        // Degrade to the current week context instead of epoch
                        const weekKey = getWeekKey(today);
                        item.timeContexts.push(weekKey);
                        // Seed migrated duration into week key
                        if (migratedDuration != null) {
                            if (!item.contextDurations) item.contextDurations = {};
                            if (!(weekKey in item.contextDurations)) {
                                item.contextDurations[weekKey] = migratedDuration;
                            }
                        }
                    }
                }
            }
            // Clean up stale leadTimeDismissed entries (past dates/weeks)
            if (item.leadTimeDismissed) {
                for (const [dCtx, dismissedList] of Object.entries(item.leadTimeDismissed)) {
                    item.leadTimeDismissed[dCtx] = dismissedList.filter(vc => {
                        const p = parseTimeContext(vc);
                        if (!p) return false;
                        if (p.date) return p.date >= todayKey;
                        if (p.week) {
                            const wr = getWeekDateRange('week:' + p.week);
                            return wr ? getDateKey(wr.end) >= todayKey : false;
                        }
                        return true; // keep epochs etc
                    });
                    if (item.leadTimeDismissed[dCtx].length === 0) delete item.leadTimeDismissed[dCtx];
                }
                if (Object.keys(item.leadTimeDismissed).length === 0) {
                    delete item.leadTimeDismissed;
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
                    } else {
                        // Post-midnight tail: both times are in early morning of a cross-midnight day
                        // e.g. "00:33-02:30" on a day that runs 08:00→02:30 — actual date is +1 day
                        const dayTimes = getEffectiveDayTimes(new Date(sY, sM - 1, sD));
                        const dayCrossesMidnight = dayTimes.dayEndHour < dayTimes.dayStartHour ||
                            (dayTimes.dayEndHour === dayTimes.dayStartHour && dayTimes.dayEndMinute < dayTimes.dayStartMinute);
                        if (dayCrossesMidnight && startH < dayTimes.dayStartHour) {
                            endDate.setDate(endDate.getDate() + 1);
                        }
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

        // Add to Queue / Remove from Queue
        const inQueue = isInQueue(item.id);
        const queueOpt = document.createElement('div');
        queueOpt.className = 'project-context-menu-item';
        queueOpt.textContent = inQueue ? 'Remove from Queue' : 'Add to Queue';
        queueOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            if (inQueue) {
                removeFromQueue(item.id);
            } else {
                addToQueue(item.id);
            }
            renderAll();
        });
        menu.appendChild(queueOpt);
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

    // Bookmark option
    const bookmarkOpt = document.createElement('div');
    bookmarkOpt.className = 'project-context-menu-item';
    const isBookmarked = state.bookmarks.includes(item.id);
    bookmarkOpt.textContent = isBookmarked ? '★ Remove Bookmark' : '☆ Bookmark';
    bookmarkOpt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        toggleBookmark(item.id);
    });
    menu.appendChild(bookmarkOpt);

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

    // Done / Undo option (context-scoped)
    const doneOpt = document.createElement('div');
    doneOpt.className = 'project-context-menu-item';
    const viewCtx = getCurrentViewContext();
    const actionItem = findItemById(action.id);
    const isDoneInCtx = isContextDone(actionItem, viewCtx);
    if (isBulk) {
        doneOpt.textContent = `Done${bulkSuffix}`;
        doneOpt.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            await bulkMarkDone();
        });
    } else {
        doneOpt.textContent = isDoneInCtx ? 'Undo' : 'Done';
        doneOpt.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            const item = findItemById(action.id);
            if (!item) return;
            const wasDone = isContextDone(item, viewCtx);
            await setContextDone(item, viewCtx, !wasDone);
            if (!wasDone) {
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
    if (!isBulk && !isDoneInCtx) {
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

        // Add to Queue / Remove from Queue (single)
        const inQueue = isInQueue(action.id);
        const queueOpt = document.createElement('div');
        queueOpt.className = 'project-context-menu-item';
        queueOpt.textContent = inQueue ? 'Remove from Queue' : 'Add to Queue';
        queueOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            if (inQueue) {
                removeFromQueue(action.id);
            } else {
                addToQueue(action.id);
            }
            renderAll();
        });
        menu.appendChild(queueOpt);
    }

    // Bulk: Add to Queue (multi-select)
    if (isBulk) {
        const bulkQueueOpt = document.createElement('div');
        bulkQueueOpt.className = 'project-context-menu-item';
        bulkQueueOpt.textContent = `Add to Queue${bulkSuffix}`;
        bulkQueueOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            for (const id of state.selectedActionIds) {
                addToQueue(id);
            }
            renderAll();
        });
        menu.appendChild(bulkQueueOpt);
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

        // Bookmark option (single only)
        const bookmarkOpt = document.createElement('div');
        bookmarkOpt.className = 'project-context-menu-item';
        const isBookmarked = state.bookmarks.includes(action.id);
        bookmarkOpt.textContent = isBookmarked ? '★ Remove Bookmark' : '☆ Bookmark';
        bookmarkOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            toggleBookmark(action.id);
        });
        menu.appendChild(bookmarkOpt);
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

    // Remove from context option (danger)
    const declineOpt = document.createElement('div');
    declineOpt.className = 'project-context-menu-item project-context-menu-item-danger';
    declineOpt.textContent = `Remove from context${bulkSuffix}`;
    declineOpt.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dismissProjectContextMenu();
        if (isBulk) {
            await bulkDecline();
        } else {
            await removeSourceContext(action.id, getCurrentViewContext());
            renderAll();
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
        } else if (state.viewHorizon === 'month') {
            const monthKey = getMonthKey(state.timelineViewDate);
            selfMatch = isItemInMonth(item, monthKey);
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
    let isFirstRenderedAtLevel = true;
    let prevHasVisibleChildren = false; // tracks whether prev sibling had expanded children
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const leaf = isLeaf(item);
        const isInbox = !!item.isInbox;

        // Skip done items when not showing done
        if (!state.showDone && !isInbox && item.done) {
            if (leaf) continue;
            // Branch: skip if ALL descendant leaves are done
            const leaves = collectLeaves([item]);
            if (leaves.length === 0 || leaves.every(l => l.done)) continue;
        }

        // Skip items that don't match search (and have no matching descendants)
        if (isSearching && !matchingIds.has(item.id)) continue;


        // 'before' zone is needed when this is the first item, or when the previous
        // sibling has visible children (so 'after prev' would appear inside its subtree)
        const needsBeforeZone = !isInbox && (isFirstRenderedAtLevel || prevHasVisibleChildren);
        if (!isInbox) isFirstRenderedAtLevel = false;
        const _hasKids = item.children && item.children.length > 0;
        const willShowChildren = isSearching ? _hasKids : item.expanded && _hasKids;
        prevHasVisibleChildren = willShowChildren;

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
                e.dataTransfer.setData('application/x-drag-source', 'project');
                window._draggedAction = item;
                // Multi-select: if this item is selected and part of multi-selection
                const idStr = String(item.id);
                const isMulti = state.selectedActionIds.has(idStr) && state.selectedActionIds.size >= 2;
                if (isMulti) {
                    window._draggedActionIds = [...state.selectedActionIds];
                    const ghost = document.createElement('div');
                    ghost.className = 'multi-drag-ghost';
                    ghost.textContent = `${state.selectedActionIds.size} items`;
                    document.body.appendChild(ghost);
                    e.dataTransfer.setDragImage(ghost, 0, 0);
                    setTimeout(() => ghost.remove(), 0);
                } else {
                    window._draggedActionIds = null;
                }
                row.classList.add('dragging');
                document.getElementById('project-tree').classList.add('dragging-active');
                document.body.classList.add('dragging-to-timeline');
                _showAllHorizonLayers();
                requestAnimationFrame(() => row.classList.add('dragging'));
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('dragging');
                document.getElementById('project-tree').classList.remove('dragging-active');
                document.body.classList.remove('dragging-to-timeline');
                dragState.draggedId = null;
                dragState.dropTarget = null;
                window._draggedAction = null;
                window._draggedActionIds = null;
                clearDropIndicators();
                document.querySelectorAll('.time-block-drag-over').forEach(el => el.classList.remove('time-block-drag-over'));
                document.querySelectorAll('.horizon-layer-drag-over').forEach(el => el.classList.remove('horizon-layer-drag-over'));
                document.querySelectorAll('.date-nav-btn-drag-over').forEach(el => el.classList.remove('date-nav-btn-drag-over'));
                _restoreHorizonLayers();
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

                // First item at this level gets a 'before' zone; subsequent items only get 'inside' + 'after'
                // (prevents duplicate indicators — 'after A' already covers the gap between A and B)
                const allowBefore = needsBeforeZone;
                if (allowBefore && zone < 0.25) {
                    // Drop before (first item only)
                    const indicator = document.createElement('div');
                    indicator.className = 'drop-indicator drop-indicator-before';
                    indicator.style.marginLeft = row.style.paddingLeft;
                    node.insertBefore(indicator, row);
                    dragState.dropTarget = { id: item.id, position: 'before' };
                } else if (zone > (allowBefore ? 0.75 : 0.5) && !isInbox) {
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
                if (item.expanded) {
                    // Collapse: animate children out, then re-render
                    const nodeEl = toggle.closest('.project-node');
                    const childContainer = nodeEl && nodeEl.querySelector(':scope > .project-children');
                    if (childContainer) {
                        childContainer.classList.add('action-group-collapse');
                        const onDone = () => {
                            childContainer.classList.remove('action-group-collapse');
                            item.expanded = false;
                            saveItems();
                            renderProjects();
                        };
                        childContainer.addEventListener('animationend', onDone, { once: true });
                        setTimeout(() => { if (childContainer.classList.contains('action-group-collapse')) onDone(); }, 200);
                    } else {
                        item.expanded = false;
                        saveItems();
                        renderProjects();
                    }
                } else {
                    // Expand: re-render, then animate children in
                    item.expanded = true;
                    saveItems();
                    renderProjects();
                    requestAnimationFrame(() => {
                        const nodeEl = document.querySelector(`.project-node[data-item-id="${item.id}"]`);
                        const childContainer = nodeEl && nodeEl.querySelector(':scope > .project-children');
                        if (childContainer) {
                            childContainer.classList.add('action-group-expand');
                            childContainer.addEventListener('animationend', () => {
                                childContainer.classList.remove('action-group-expand');
                            }, { once: true });
                        }
                    });
                }
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
        if (!isInbox && item.done) name.classList.add('project-leaf-done');

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

        // Actions (done, play, add child, delete) — Inbox has no delete
        const actions = document.createElement('div');
        actions.className = 'project-actions';

        // Done toggle button
        if (!isInbox) {
            const doneBtn = document.createElement('button');
            doneBtn.className = 'project-action-btn project-action-btn-done';
            doneBtn.textContent = item.done ? '↩' : '✓';
            doneBtn.title = item.done ? 'Mark undone' : 'Mark done';
            doneBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
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
                    if (!state.showDone && state.selectedItemId === item.id) {
                        state.selectedItemId = null;
                        savePref('selectedItemId', '');
                    }
                }
                renderAll();
            });
            actions.appendChild(doneBtn);
        }

        // Play button — open duration picker to start working
        if (!isInbox && !item.done) {
            const playBtn = document.createElement('button');
            playBtn.className = 'project-action-btn project-action-btn-play';
            playBtn.textContent = '▶';
            playBtn.title = 'Start working';
            playBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Build ancestors string from the item tree
                const allItems = collectAllItems(state.items.items);
                const found = allItems.find(i => i.id === item.id);
                const ancestors = found && found._path
                    ? found._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';
                showDurationPicker(playBtn, item.id, item.name, ancestors);
            });
            actions.appendChild(playBtn);
        }

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
                if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
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

        // Click selects item (as project filter) with directional animation
        // Skip if a rename input is active to avoid toggling during editing
        row.addEventListener('click', (e) => {
            if (row.querySelector('.rename-inline-input')) return;
            const oldId = state.selectedItemId;
            const newId = oldId === item.id ? null : item.id;
            const doUpdate = () => {
                state.selectedItemId = newId;
                savePref('selectedItemId', newId || '');
                state._animateActions = true;
                renderAll();
            };
            // Determine animation based on tree relationship
            if (!oldId && newId) {
                // First selection: zoom in
                animateActionsZoomIn(doUpdate);
            } else if (oldId && !newId) {
                // Deselecting: zoom out
                animateActionsZoomOut(doUpdate);
            } else if (oldId && newId) {
                const rel = getProjectNavRelationship(oldId, newId);
                if (rel.type === 'descendant') animateActionsZoomIn(doUpdate);
                else if (rel.type === 'ancestor') animateActionsZoomOut(doUpdate);
                else doUpdate();
            } else {
                doUpdate();
            }
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
function renderActions(opts) {
    const container = document.getElementById('actions-list');
    const savedScrollTop = container.scrollTop;
    const empty = document.getElementById('actions-empty');

    // ── Ground indicator (live session) — always visible at top of Actions ──
    _renderLiveSessionIndicator();

    // Invalidate work entry index for fresh investment data
    _invalidateWorkEntryIndex();

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
    container.querySelectorAll('.action-item, .action-group-header, .overflow-preview').forEach(el => el.remove());

    const filteredActions = getFilteredActions();

    if (filteredActions.length === 0) {
        empty.style.display = '';

        // ── Context-aware empty state: show reset hints when filters are narrowing ──
        const projectIsFiltered = !!state.selectedItemId;
        const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
        const viewKey = getDateKey(state.timelineViewDate);
        const todayKey = getDateKey(getLogicalToday());
        const timeIsFiltered = !!focusedSession || state.viewHorizon === 'epoch' || state.viewHorizon === 'month' || viewKey !== todayKey;

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

        // ── Overflow Preview: show items from the next horizon up ──
        renderOverflowPreview(container);

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

    // ── Context-header detection ──
    // When an item AND its ancestor both appear in the filtered actions for the same
    // time context, the ancestor is promoted to a header (like aggregate group headers).
    // Multi-level nesting is supported.
    const filteredIdSet = new Set(sorted.map(a => a.id));
    const contextHeaderIds = new Set();
    for (const action of sorted) {
        if (!action._path) continue;
        // Walk path (excluding self, which is the last element)
        for (let i = 0; i < action._path.length - 1; i++) {
            if (filteredIdSet.has(action._path[i].id)) {
                contextHeaderIds.add(action._path[i].id);
            }
        }
    }

    // Separate context headers from regular actions
    const contextHeaders = contextHeaderIds.size > 0
        ? sorted.filter(a => contextHeaderIds.has(a.id))
        : [];
    const regularActions = contextHeaderIds.size > 0
        ? sorted.filter(a => !contextHeaderIds.has(a.id))
        : sorted;

    // Build context-header tree: for each regular action, find its nearest context-header ancestor
    // contextHeaderChildren: headerId → [actions]
    // For nested headers: headerId → [sub-header actions]
    const contextHeaderChildren = new Map();
    const contextHeaderSubHeaders = new Map(); // headerId → [child header ids]
    const topLevelContextHeaders = new Set(); // headers that are not children of another header

    if (contextHeaderIds.size > 0) {
        // Determine parent-child relationships among context headers themselves
        const headerParent = new Map(); // headerId → parentHeaderId
        for (const hdr of contextHeaders) {
            if (!hdr._path) continue;
            let nearestParent = null;
            // Walk from immediate parent down to find nearest context-header ancestor
            for (let i = hdr._path.length - 2; i >= 0; i--) {
                if (contextHeaderIds.has(hdr._path[i].id)) {
                    nearestParent = hdr._path[i].id;
                    break;
                }
            }
            if (nearestParent !== null) {
                headerParent.set(hdr.id, nearestParent);
                if (!contextHeaderSubHeaders.has(nearestParent)) {
                    contextHeaderSubHeaders.set(nearestParent, []);
                }
                contextHeaderSubHeaders.get(nearestParent).push(hdr.id);
            } else {
                topLevelContextHeaders.add(hdr.id);
            }
        }

        // For headers with no parent header, mark as top-level
        for (const hdr of contextHeaders) {
            if (!headerParent.has(hdr.id) && !topLevelContextHeaders.has(hdr.id)) {
                topLevelContextHeaders.add(hdr.id);
            }
        }

        // Map regular actions to their nearest context-header ancestor
        for (const action of regularActions) {
            if (!action._path) continue;
            let nearestHeader = null;
            for (let i = action._path.length - 2; i >= 0; i--) {
                if (contextHeaderIds.has(action._path[i].id)) {
                    nearestHeader = action._path[i].id;
                    break;
                }
            }
            if (nearestHeader !== null) {
                if (!contextHeaderChildren.has(nearestHeader)) {
                    contextHeaderChildren.set(nearestHeader, []);
                }
                contextHeaderChildren.get(nearestHeader).push(action);
            }
        }
    }

    // Actions NOT under any context header (rendered normally)
    const unheaderedActions = contextHeaderIds.size > 0
        ? regularActions.filter(a => {
            if (!a._path) return true;
            for (let i = a._path.length - 2; i >= 0; i--) {
                if (contextHeaderIds.has(a._path[i].id)) return false;
            }
            return true;
        })
        : regularActions;

    // Helper: create a context-header element (reuses action-group-header styling)
    function _createContextHeader(headerId, childActions, subHeaderIds) {
        const headerItem = findItemById(headerId);
        const isCollapsed = state.collapsedGroups.has(headerId);
        const header = document.createElement('div');
        header.className = 'action-group-header' + (isCollapsed ? ' collapsed' : '');
        header.dataset.rootId = headerId;
        header.dataset.contextHeader = 'true';

        const chevron = document.createElement('span');
        chevron.className = 'action-group-chevron' + (isCollapsed ? '' : ' expanded');
        chevron.textContent = '▶';
        header.appendChild(chevron);

        const nameEl = document.createElement('span');
        nameEl.className = 'action-group-name';
        nameEl.textContent = headerItem ? headerItem.name : 'Unknown';
        header.appendChild(nameEl);

        // Count: direct children + sub-header descendant counts
        const totalCount = (childActions ? childActions.length : 0)
            + (subHeaderIds ? subHeaderIds.reduce((sum, shId) => {
                return sum + _countContextHeaderDescendants(shId);
            }, 0) : 0);
        const countEl = document.createElement('span');
        countEl.className = 'action-group-count';
        countEl.textContent = totalCount;
        header.appendChild(countEl);

        // ── Capacity bar for context headers (recursive descendants) ──
        if (headerItem && !headerItem.done) {
            const chViewCtx = getCurrentViewContext();
            const chBudget = getContextDuration(headerItem, chViewCtx);
            const chInv = computeTimeInvestment(headerItem, chViewCtx);
            const chInvested = chInv ? chInv.invested : 0;

            // Compute planned from descendants using recursive absorption
            function _chDescPlanned(node) {
                if (!node || node.done) return 0;
                let childSum = 0;
                let hasChild = false;
                if (node.children && node.children.length > 0) {
                    for (const ch of node.children) {
                        const cp = _chDescPlanned(ch);
                        if (cp > 0) hasChild = true;
                        childSum += cp;
                    }
                }
                // Skip the header item itself — its duration is the budget
                if (node.id === headerId) return childSum;
                const dur = getContextDuration(node, chViewCtx);
                if (hasChild) return Math.max(dur, childSum);
                return dur;
            }
            const chPlanned = _chDescPlanned(headerItem);

            if (state.showInvestmentBadge && (chBudget > 0 || chInvested > 0 || chPlanned > 0)) {
                const total = chBudget > 0 ? chBudget : (chInvested + chPlanned);
                const invPct = total > 0 ? Math.min(100, (chInvested / total) * 100) : 0;
                const planPct = total > 0 ? Math.min(100 - invPct, (chPlanned / total) * 100) : 0;
                const invBadge = document.createElement('div');
                invBadge.className = 'action-investment-badge';
                const parts = [];
                if (chInvested > 0) parts.push(`${_formatDuration(chInvested)} invested`);
                if (chPlanned > 0) parts.push(`${_formatDuration(chPlanned)} planned`);
                if (chBudget > 0) {
                    const rem = Math.max(0, chBudget - chInvested - chPlanned);
                    parts.push(`${_formatDuration(rem)} remaining`);
                }
                const hoverText = parts.join(' / ');
                if (chBudget > 0 && chInvested + chPlanned > chBudget) {
                    invBadge.classList.add('investment-over');
                }
                const bar = document.createElement('div');
                bar.className = 'investment-bar';
                const fillInv = document.createElement('div');
                fillInv.className = 'investment-fill-invested';
                fillInv.style.width = `${invPct}%`;
                bar.appendChild(fillInv);
                const fillPlan = document.createElement('div');
                fillPlan.className = 'investment-fill-planned';
                fillPlan.style.width = `${planPct}%`;
                bar.appendChild(fillPlan);
                invBadge.appendChild(bar);
                const lbl = document.createElement('span');
                lbl.className = 'investment-label';
                const defaultText = _formatDuration(total);
                lbl.textContent = defaultText;
                invBadge.appendChild(lbl);
                function _swapLblCh(text) {
                    lbl.classList.add('investment-label-out');
                    setTimeout(() => {
                        lbl.textContent = text;
                        lbl.classList.remove('investment-label-out');
                        lbl.classList.add('investment-label-in');
                        requestAnimationFrame(() => { requestAnimationFrame(() => { lbl.classList.remove('investment-label-in'); }); });
                    }, 120);
                }
                invBadge.addEventListener('mouseenter', () => _swapLblCh(hoverText));
                invBadge.addEventListener('mouseleave', () => _swapLblCh(defaultText));
                invBadge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showEstimatePicker(invBadge, headerId);
                });
                header.appendChild(invBadge);
            } else {
                // Fallback: simple estimate badge
                const dur = chBudget > 0 ? chBudget : chPlanned;
                const estimateBadge = document.createElement('span');
                estimateBadge.className = 'action-estimate-badge';
                if (dur > 0) {
                    estimateBadge.textContent = _formatDuration(dur);
                    estimateBadge.classList.add('has-estimate');
                } else {
                    estimateBadge.textContent = '⏱';
                    estimateBadge.classList.add('no-estimate');
                }
                estimateBadge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showEstimatePicker(estimateBadge, headerId);
                });
                header.appendChild(estimateBadge);
            }
        }

        // ── Action buttons for context headers (scheduled items) ──
        const hdrButtons = document.createElement('div');
        hdrButtons.className = 'action-group-buttons';

        if (headerItem && !headerItem.done) {
            // Play/stop button
            const workBtn = document.createElement('button');
            workBtn.className = 'action-btn action-btn-work';
            const isWorking = state.workingOn && state.workingOn.itemId === headerId;
            workBtn.textContent = isWorking ? '⏹' : '▶';
            workBtn.title = isWorking ? 'Stop working' : 'Start working';
            if (isWorking) workBtn.classList.add('action-btn-working');
            workBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (state.workingOn && state.workingOn.itemId === headerId) {
                    await stopWorking();
                } else {
                    const ancestors = getAncestorPath(headerId) || [];
                    const ancestorStr = ancestors.map(a => a.name).join(' › ');
                    showDurationPicker(workBtn, headerId, headerItem.name, ancestorStr);
                }
            });
            hdrButtons.appendChild(workBtn);

            // Done button
            const doneBtn = document.createElement('button');
            doneBtn.className = 'action-btn action-btn-done';
            doneBtn.textContent = '✓';
            doneBtn.title = 'Mark as done';
            doneBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await api.patch(`/items/${headerId}`, { done: true });
                headerItem.done = true;
                const ancestors = getAncestorPath(headerId) || [];
                const ancestorStr = ancestors.map(a => a.name).join(' › ');
                await api.post('/timeline', {
                    text: `Done: ${headerItem.name}`,
                    projectName: ancestorStr || null,
                    type: 'completion'
                });
                state.timeline = await api.get('/timeline');
                renderAll();
            });
            hdrButtons.appendChild(doneBtn);

            // Add sub-task button
            const addBtn = document.createElement('button');
            addBtn.className = 'action-btn action-btn-breakdown';
            addBtn.textContent = '+';
            addBtn.title = 'Add sub-task';
            addBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await api.post('/items', {
                    name: 'New sub-task',
                    parentId: headerId,
                    timeContexts: getCurrentTimeContexts()
                });
                await reloadItems();
            });
            hdrButtons.appendChild(addBtn);
        }
        if (hdrButtons.children.length > 0) {
            header.appendChild(hdrButtons);
        }

        // Collapse/expand click — only on chevron/name/count, not on buttons
        header.addEventListener('click', (e) => {
            if (e.target.closest('.action-btn, .action-estimate-badge, .action-investment-badge, .action-group-buttons')) return;
            const wasCollapsed = state.collapsedGroups.has(headerId);
            if (wasCollapsed) {
                state.collapsedGroups.delete(headerId);
                savePref('collapsedGroups', [...state.collapsedGroups]);
                renderActions({ expandedGroupId: headerId });
            } else {
                // Animate children out, then collapse
                _animateGroupCollapse(header, () => {
                    state.collapsedGroups.add(headerId);
                    savePref('collapsedGroups', [...state.collapsedGroups]);
                    renderActions({ collapseOnly: true });
                });
            }
        });

        return { header, isCollapsed };
    }

    // Helper: count all descendants under a context header (recursive)
    function _countContextHeaderDescendants(headerId) {
        const children = contextHeaderChildren.get(headerId) || [];
        const subHeaders = contextHeaderSubHeaders.get(headerId) || [];
        return children.length + subHeaders.reduce((sum, shId) => {
            return sum + _countContextHeaderDescendants(shId);
        }, 0);
    }

    // Helper: recursively render a context header and its children into a fragment
    function _renderContextHeaderTree(headerId, parentFragment, rootIdForDataset) {
        const childActions = contextHeaderChildren.get(headerId) || [];
        const subHeaders = contextHeaderSubHeaders.get(headerId) || [];
        const { header, isCollapsed } = _createContextHeader(headerId, childActions, subHeaders);
        if (rootIdForDataset !== undefined) header.dataset.rootId = rootIdForDataset;
        parentFragment.appendChild(header);

        if (!isCollapsed) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'action-group-children';
            // Render sub-headers first (preserving tree order)
            for (const shId of subHeaders) {
                _renderContextHeaderTree(shId, childrenContainer, rootIdForDataset);
            }
            // Render direct child actions
            for (const action of childActions) {
                const el = createActionElement(action);
                if (rootIdForDataset !== undefined) el.dataset.rootId = rootIdForDataset;
                childrenContainer.appendChild(el);
                renderedIds.push(String(action.id));
            }
            parentFragment.appendChild(childrenContainer);
        }
    }

    // ── Grouping by ancestor ──
    // When no project context: group by root ancestor (_path[0])
    // When project context is active: group by the first child below the selected project
    let rootGroups = null;
    let distinctRoots = 0;
    // Track which _path index is used for the grouping ancestor (for breadcrumb stripping)
    let groupAncestorPathIdx = 0;

    // For grouping, use unheaderedActions (actions not under context headers)
    // plus top-level context headers themselves as groupable items
    const groupableItems = [...unheaderedActions];
    // Add top-level context headers as pseudo-actions for grouping purposes
    for (const hdrId of topLevelContextHeaders) {
        const hdrAction = sorted.find(a => a.id === hdrId);
        if (hdrAction) groupableItems.push({ ...hdrAction, _isContextHeader: true });
    }

    {
        rootGroups = new Map(); // groupId → { root: {id,name}, actions: [] }
        for (const action of groupableItems) {
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

    // Helper: render a list of actions (mixing regular + context headers) into a fragment
    function _renderActionList(actions, parentFragment, rootIdForDataset) {
        for (const action of actions) {
            if (action._isContextHeader || contextHeaderIds.has(action.id)) {
                // Render as context header tree
                _renderContextHeaderTree(action.id, parentFragment, rootIdForDataset);
            } else {
                const el = createActionElement(action);
                if (rootIdForDataset !== undefined) el.dataset.rootId = rootIdForDataset;
                parentFragment.appendChild(el);
                renderedIds.push(String(action.id));
            }
        }
    }

    if (distinctRoots >= 2 || (distinctRoots >= 1 && contextHeaderIds.size > 0)) {
        // Render with group headers
        state._actionGroupingActive = true;
        for (const [rootId, group] of rootGroups) {
            // Check how many regular (non-context-header) actions are in this group
            const regularGroupActions = group.actions.filter(a => !a._isContextHeader && !contextHeaderIds.has(a.id));
            const regularCount = regularGroupActions.length;
            const contextHeaderCount = group.actions.length - regularCount;

            // Skip aggregate header only when ≤1 regular actions AND no context headers
            // (context headers need the aggregate wrapper for visual grouping)
            if (regularCount <= 1 && contextHeaderCount === 0) {
                // Mark single regular action for breadcrumb display
                if (regularCount === 1) {
                    regularGroupActions[0]._singleGroup = true;
                }
                // Render everything directly (context headers + the single regular action)
                _renderActionList(group.actions, fragment, rootId);
                continue;
            }

            // If the group's root IS a context header, skip the aggregate header —
            // the context header itself will serve as the header
            if (contextHeaderIds.has(rootId)) {
                _renderActionList(group.actions, fragment, rootId);
                continue;
            }

            const isCollapsed = state.collapsedGroups.has(rootId);
            // Create group header
            const header = document.createElement('div');
            header.className = 'action-group-header' + (isCollapsed ? ' collapsed' : '');
            header.dataset.rootId = rootId;

            const chevron = document.createElement('span');
            chevron.className = 'action-group-chevron' + (isCollapsed ? '' : ' expanded');
            chevron.textContent = '▶';
            header.appendChild(chevron);

            const nameEl = document.createElement('span');
            nameEl.className = 'action-group-name';
            nameEl.textContent = group.root ? group.root.name : 'Ungrouped';
            header.appendChild(nameEl);

            const countEl = document.createElement('span');
            countEl.className = 'action-group-count';
            countEl.textContent = group.actions.length;
            header.appendChild(countEl);

            // ── Group header capacity bar (recursive descendants) ──
            if (group.root) {
                const grpViewCtx = getCurrentViewContext();
                const grpBudget = getContextDuration(group.root, grpViewCtx);
                const grpInv = computeTimeInvestment(group.root, grpViewCtx);
                const grpInvested = grpInv ? grpInv.invested : 0;

                // Compute planned from descendants using recursive absorption
                // (same logic as the capacity bar: max(own, childrenSum) at each node)
                function _descPlanned(node) {
                    if (!node || node.done) return 0;
                    let childSum = 0;
                    let hasChild = false;
                    if (node.children && node.children.length > 0) {
                        for (const ch of node.children) {
                            const cp = _descPlanned(ch);
                            if (cp > 0) hasChild = true;
                            childSum += cp;
                        }
                    }
                    // Skip the root item itself — its duration is the budget
                    if (node.id === group.root.id) return childSum;
                    const dur = getContextDuration(node, grpViewCtx);
                    if (hasChild) return Math.max(dur, childSum);
                    return dur;
                }
                const grpPlanned = _descPlanned(group.root);

                if (state.showInvestmentBadge && (grpBudget > 0 || grpInvested > 0 || grpPlanned > 0)) {
                    const total = grpBudget > 0 ? grpBudget : (grpInvested + grpPlanned);
                    const invPct = total > 0 ? Math.min(100, (grpInvested / total) * 100) : 0;
                    const planPct = total > 0 ? Math.min(100 - invPct, (grpPlanned / total) * 100) : 0;
                    const invBadge = document.createElement('div');
                    invBadge.className = 'action-investment-badge';
                    const parts = [];
                    if (grpInvested > 0) parts.push(`${_formatDuration(grpInvested)} invested`);
                    if (grpPlanned > 0) parts.push(`${_formatDuration(grpPlanned)} planned`);
                    if (grpBudget > 0) {
                        const rem = Math.max(0, grpBudget - grpInvested - grpPlanned);
                        parts.push(`${_formatDuration(rem)} remaining`);
                    }
                    const hoverText = parts.join(' / ');
                    // Over-commitment visual cue
                    if (grpBudget > 0 && grpInvested + grpPlanned > grpBudget) {
                        invBadge.classList.add('investment-over');
                    }
                    const bar = document.createElement('div');
                    bar.className = 'investment-bar';
                    const fillInv = document.createElement('div');
                    fillInv.className = 'investment-fill-invested';
                    fillInv.style.width = `${invPct}%`;
                    bar.appendChild(fillInv);
                    const fillPlan = document.createElement('div');
                    fillPlan.className = 'investment-fill-planned';
                    fillPlan.style.width = `${planPct}%`;
                    bar.appendChild(fillPlan);
                    invBadge.appendChild(bar);
                    const lbl = document.createElement('span');
                    lbl.className = 'investment-label';
                    const defaultText = _formatDuration(total);
                    lbl.textContent = defaultText;
                    invBadge.appendChild(lbl);
                    function _swapLabel(text) {
                        lbl.classList.add('investment-label-out');
                        setTimeout(() => {
                            lbl.textContent = text;
                            lbl.classList.remove('investment-label-out');
                            lbl.classList.add('investment-label-in');
                            requestAnimationFrame(() => { requestAnimationFrame(() => { lbl.classList.remove('investment-label-in'); }); });
                        }, 120);
                    }
                    invBadge.addEventListener('mouseenter', () => _swapLabel(hoverText));
                    invBadge.addEventListener('mouseleave', () => _swapLabel(defaultText));
                    header.appendChild(invBadge);
                } else if (!state.showInvestmentBadge) {
                    // Simple duration badge — use root's envelope or fall back to children sum
                    const groupTotalMins = grpBudget > 0 ? grpBudget : grpPlanned;
                    if (groupTotalMins > 0) {
                        const durEl = document.createElement('span');
                        durEl.className = 'action-group-duration';
                        durEl.textContent = groupTotalMins >= 60
                            ? `${Math.floor(groupTotalMins / 60)}h${groupTotalMins % 60 ? groupTotalMins % 60 + 'm' : ''}`
                            : `${groupTotalMins}m`;
                        header.appendChild(durEl);
                    }
                }
            } else {
                // No root item — fall back to flat sum of group actions
                if (state.showInvestmentBadge) {
                    let gInvested = 0, gPlanned = 0;
                    for (const a of group.actions) {
                        const itm = findItemById(a.id);
                        const inv = computeTimeInvestment(itm);
                        if (inv) { gInvested += inv.invested; gPlanned += inv.planned; }
                    }
                    // (skip rendering if nothing to show)
                } else {
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
                }
            }

            // ── Schedule button for aggregate headers (not yet scheduled as an item) ──
            if (group.root) {
                const aggButtons = document.createElement('div');
                aggButtons.className = 'action-group-buttons';
                const schedBtn = document.createElement('button');
                schedBtn.className = 'action-btn action-btn-schedule';
                schedBtn.textContent = '📌';
                schedBtn.title = 'Schedule this item for the current time context';
                schedBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const ctxs = getCurrentTimeContexts();
                    for (const ctx of ctxs) {
                        await addTimeContext(group.root.id, ctx);
                    }
                    renderAll();
                });
                aggButtons.appendChild(schedBtn);
                header.appendChild(aggButtons);
            }

            header.addEventListener('click', (e) => {
                if (e.target.closest('.action-btn, .action-group-buttons')) return;
                const wasCollapsed = state.collapsedGroups.has(rootId);
                if (wasCollapsed) {
                    state.collapsedGroups.delete(rootId);
                    savePref('collapsedGroups', [...state.collapsedGroups]);
                    renderActions({ expandedGroupId: rootId });
                } else {
                    _animateGroupCollapse(header, () => {
                        state.collapsedGroups.add(rootId);
                        savePref('collapsedGroups', [...state.collapsedGroups]);
                        renderActions({ collapseOnly: true });
                    });
                }
            });

            fragment.appendChild(header);

            if (!isCollapsed) {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'action-group-children';
                _renderActionList(group.actions, childrenContainer, rootId);
                fragment.appendChild(childrenContainer);
            }
        }
    } else {
        // Flat (no grouping) — but may still have context headers
        state._actionGroupingActive = contextHeaderIds.size > 0;
        _renderActionList(groupableItems, fragment);
    }

    // Update visible IDs to only include rendered (non-collapsed) actions
    state._visibleActionIds = renderedIds;

    container.appendChild(fragment);

    // ── Staggered fade-in animation ──
    const shouldAnimate = (state._animateActions || (opts && opts.expandedGroupId)) && !(opts && opts.collapseOnly);
    state._animateActions = false;
    if (shouldAnimate) {
        const expandedGroup = opts && opts.expandedGroupId;
        if (expandedGroup) {
            // Animate the children container as a single block (fade + slide)
            const childrenContainers = container.querySelectorAll(
                `.action-group-children`
            );
            // Find the container that follows the expanded group's header
            childrenContainers.forEach(cc => {
                const prevHeader = cc.previousElementSibling;
                if (prevHeader && prevHeader.dataset && prevHeader.dataset.rootId === String(expandedGroup)) {
                    cc.classList.add('action-group-expand');
                    cc.addEventListener('animationend', () => {
                        cc.classList.remove('action-group-expand');
                    }, { once: true });
                }
            });
        } else {
            // Full list animation (zoom-in from project selection etc.)
            let animTargets = container.querySelectorAll('.action-item, .action-group-header');
            const staggerMs = Math.min(30, animTargets.length > 0 ? 500 / animTargets.length : 30);
            animTargets.forEach((el, i) => {
                el.classList.add('action-enter');
                el.style.animationDelay = `${i * staggerMs}ms`;
                const cleanup = () => {
                    el.classList.remove('action-enter');
                    el.style.animationDelay = '';
                };
                el.addEventListener('animationend', cleanup, { once: true });
            });
        }
    }

    // Restore scroll position after rebuild
    container.scrollTop = savedScrollTop;

    updateBulkActionBar();
    updateCapacitySummary(sorted);
}

function getFilteredActions() {
    const _rawAll = collectAllItems();
    let allLeaves = _rawAll;

    // Filter out done items unless showDone is on
    if (!state.showDone) {
        allLeaves = allLeaves.filter(a => !a.done);
    }

    // ── Horizon + Schedule filter ──
    const currentDateKey = getDateKey(state.timelineViewDate);
    if (state.deepView) {
        // Deep view: show ALL layers — no horizon filter applied.
        // Items are scoped by the project context filter below.
    } else if (state.viewHorizon === 'epoch') {
        // Show only items in the active epoch
        allLeaves = allLeaves.filter(a => isItemInEpoch(a, state.epochFilter));
    } else if (state.viewHorizon === 'month') {
        // Show only items with the current month context
        const monthKey = getMonthKey(state.timelineViewDate);
        allLeaves = allLeaves.filter(a => isItemInMonth(a, monthKey));
    } else if (state.viewHorizon === 'week') {
        // Show only items with the current week context (no specific day)
        const weekKey = getWeekKey(state.timelineViewDate);
        allLeaves = allLeaves.filter(a => isItemInWeek(a, weekKey));
    } else if (state.viewHorizon === 'live') {
        // Live horizon: show items assigned to the current live time context
        const todayKey = getDateKey(getLogicalToday());
        if (state.workingOn) {
            const workId = state.workingOn.itemId;
            allLeaves = allLeaves.filter(a => a.id === workId);
        } else if (state.onBreak) {
            const liveCtx = `${todayKey}@break`;
            allLeaves = allLeaves.filter(a => {
                const item = findItemById(a.id);
                return item?.timeContexts?.includes(liveCtx);
            });
        } else {
            allLeaves = []; // idle/sleep — no items in live context
        }
    } else {
        allLeaves = allLeaves.filter(a => itemMatchesTimeContext(a, currentDateKey));
    }
    // ── Session focus: when focused, show items relevant to this session ──
    // Skip session focus filtering when deep view is active — show ALL layers.
    const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    if (focusedSession && !state.deepView) {
        const fs = focusedSession;
        // Reuse already-collected items (avoid second tree traversal)
        let sessionLeaves = _rawAll.slice();
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
            // to time-overlap matching — only live-matched items
            if (fs.liveType) {
                return false;
            }

            // For planned entries with a specific entry ID, don't fall through
            // to time-range overlap matching — only entry-context matched items belong here.
            if (fs.type === 'planned' && fs.entryId) {
                return false;
            }

            // Items with segment context overlapping the session (shared helper)
            if (fs.segmentKey) {
                return itemOverlapsSegment(item, fs.segmentKey, currentDateKey, fs.startMs, fs.endMs) !== null;
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
                            _deadlineCtx: ctx,
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
    // They only appear when their specific session is focused (handled above),
    // OR when deep view is active (shows all lower layers).
    if (!state.deepView && state.viewHorizon !== 'live') {
        allLeaves = allLeaves.filter(a => {
            const item = findItemById(a.id);
            return !hasSegmentContext(item, currentDateKey);
        });
    }

    if (!state.selectedItemId) return allLeaves;

    // Get all descendant IDs of the selected project (works for Inbox too)
    const selectedItem = findItemById(state.selectedItemId);
    if (!selectedItem) return allLeaves;

    // Strict descendants only — selecting a project shows its contents, not itself
    const descendantIds = collectDescendantIds(selectedItem);

    return allLeaves.filter(leaf => descendantIds.includes(leaf.id) && leaf.id !== selectedItem.id);
}

// ─── Overflow Preview: surface items from the next horizon up when current is empty ───

const HORIZON_LADDER = ['live', 'session', 'day', 'week', 'month', 'epoch'];
const HORIZON_LABELS = { day: 'today', week: 'your week', month: 'your month', epoch: 'ongoing' };

// Transient state for overflow preview show more/less
let _overflowVisibleCount = 0; // 0 = use default
let _overflowAnimFrom = -1;    // -1 = cascade all (initial), >= 0 = animate from index, -2 = none
const OVERFLOW_PAGE_SIZE = 5;

// Get items from the next horizon level up, cascading until something is found.
// Returns { items: [...], sourceHorizon: 'week' | 'month' | ... } or null.
function getOverflowItems(projectFilterId) {
    // Effective horizon: if focused into a session from day view, treat as session-level
    const effectiveHorizon = (state.viewHorizon === 'day' && state.focusStack.length > 0)
        ? 'session' : state.viewHorizon;
    const currentIdx = HORIZON_LADDER.indexOf(effectiveHorizon);
    if (currentIdx < 0) return null;

    const _rawAll = collectAllItems();
    let allLeaves = _rawAll;
    if (!state.showDone) allLeaves = allLeaves.filter(a => !a.done);

    // Apply project context filter
    if (projectFilterId) {
        const selectedItem = findItemById(projectFilterId);
        if (selectedItem) {
            const descendantIds = collectDescendantIds(selectedItem);
            allLeaves = allLeaves.filter(leaf => descendantIds.includes(leaf.id) && leaf.id !== selectedItem.id);
        }
    }

    if (allLeaves.length === 0) return null;

    // Walk up the horizon ladder from the next level
    for (let i = currentIdx + 1; i < HORIZON_LADDER.length; i++) {
        const horizon = HORIZON_LADDER[i];
        let matches = [];

        if (horizon === 'day') {
            const dateKey = getDateKey(state.timelineViewDate);
            matches = allLeaves.filter(a => itemMatchesTimeContext(a, dateKey));
            // Exclude segment-level items
            matches = matches.filter(a => {
                const item = findItemById(a.id);
                return !hasSegmentContext(item, dateKey);
            });
        } else if (horizon === 'week') {
            const weekKey = getWeekKey(state.timelineViewDate);
            matches = allLeaves.filter(a => isItemInWeek(a, weekKey));
        } else if (horizon === 'month') {
            const monthKey = getMonthKey(state.timelineViewDate);
            matches = allLeaves.filter(a => isItemInMonth(a, monthKey));
        } else if (horizon === 'epoch') {
            matches = allLeaves.filter(a => isItemInEpoch(a, state.epochFilter || 'ongoing'));
        }

        if (matches.length > 0) {
            // Sort by capacity fit: items fitting remaining time first
            const viewCtx = getCurrentViewContext();
            matches.sort((a, b) => {
                const durA = getContextDuration(findItemById(a.id), viewCtx) || getContextDuration(findItemById(a.id));
                const durB = getContextDuration(findItemById(b.id), viewCtx) || getContextDuration(findItemById(b.id));
                // Items with known duration come first, then by duration ascending
                const hasA = durA > 0 ? 0 : 1;
                const hasB = durB > 0 ? 0 : 1;
                if (hasA !== hasB) return hasA - hasB;
                return durA - durB;
            });

            return {
                items: matches, // return all, let renderOverflowPreview handle slicing
                sourceHorizon: horizon
            };
        }
    }

    return null;
}

// Helper: create a single overflow item row element
function _createOverflowItemRow(action, overflow, sourceCtx, container) {
    const item = findItemById(action.id);
    if (!item) return null;

    const row = document.createElement('div');
    row.className = 'overflow-item';
    row.dataset.id = action.id;

    // Pull indicator (visible on hover)
    const pullIcon = document.createElement('span');
    pullIcon.className = 'overflow-pull-icon';
    pullIcon.textContent = '↓';
    row.appendChild(pullIcon);

    // Focus dot (locate in sidebar)
    const locateBtn = document.createElement('span');
    locateBtn.className = 'action-locate-btn';
    locateBtn.textContent = '◉';
    locateBtn.title = 'Locate in projects';
    locateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        animateActionsZoomIn(() => {
            state.selectedItemId = action.id;
            savePref('selectedItemId', action.id);
            state._animateActions = true;
            renderAll();
            requestAnimationFrame(() => scrollToSelectedItem());
        });
    });
    row.appendChild(locateBtn);

    // Name
    const nameEl = document.createElement('span');
    nameEl.className = 'overflow-item-name';
    nameEl.textContent = action.name;
    row.appendChild(nameEl);

    // Breadcrumb (show parent path for context)
    if (action._path && action._path.length > 1) {
        let startIdx = 0;
        if (state.selectedItemId) {
            const selIdx = action._path.findIndex(p => p.id === state.selectedItemId);
            if (selIdx >= 0) startIdx = selIdx + 1;
        }
        const ancestors = action._path.slice(startIdx, -1);
        if (ancestors.length > 0) {
            const tag = document.createElement('span');
            tag.className = 'overflow-item-breadcrumb';
            tag.textContent = ancestors.map(a => a.name).join(' › ');
            row.appendChild(tag);
        }
    }

    // Investment / capacity bar
    const inv = computeTimeInvestment(item, sourceCtx);
    if (inv) {
        const invBadge = document.createElement('div');
        invBadge.className = 'overflow-item-investment';
        const total = inv.budget > 0 ? inv.budget : (inv.invested + inv.planned);
        const invPct = total > 0 ? Math.min(100, (inv.invested / total) * 100) : 0;
        const planPct = total > 0 ? Math.min(100 - invPct, (inv.planned / total) * 100) : 0;
        if (inv.budget > 0 && inv.invested + inv.planned > inv.budget) {
            invBadge.classList.add('investment-over');
        }
        const bar = document.createElement('div');
        bar.className = 'investment-bar';
        const fillInv = document.createElement('div');
        fillInv.className = 'investment-fill-invested';
        fillInv.style.width = `${invPct}%`;
        bar.appendChild(fillInv);
        const fillPlan = document.createElement('div');
        fillPlan.className = 'investment-fill-planned';
        fillPlan.style.width = `${planPct}%`;
        bar.appendChild(fillPlan);
        invBadge.appendChild(bar);
        const lbl = document.createElement('span');
        lbl.className = 'investment-label';
        lbl.textContent = _formatDuration(total);
        invBadge.appendChild(lbl);
        const parts = [];
        if (inv.invested > 0) parts.push(`${_formatDuration(inv.invested)} invested`);
        if (inv.planned > 0) parts.push(`${_formatDuration(inv.planned)} planned`);
        if (inv.budget > 0) parts.push(`${_formatDuration(inv.remaining)} remaining`);
        invBadge.title = parts.join(' / ');
        row.appendChild(invBadge);
    } else {
        const dur = getContextDuration(item);
        if (dur > 0) {
            const durEl = document.createElement('span');
            durEl.className = 'overflow-item-duration';
            durEl.textContent = _formatDuration(dur);
            row.appendChild(durEl);
        }
    }

    // Click-to-adopt
    row.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newContexts = getCurrentTimeContexts();
        const existingCtxs = item.timeContexts || [];
        const merged = [...new Set([...existingCtxs, ...newContexts])];
        item.timeContexts = merged;
        await saveItems();
        state._animateActions = true;
        renderAll();
    });

    // Drag-and-drop
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-action-id', String(action.id));
        e.dataTransfer.setData('application/x-drag-source', 'overflow');
        let srcCtx = '';
        if (overflow.sourceHorizon === 'week') srcCtx = getWeekKey(state.timelineViewDate);
        else if (overflow.sourceHorizon === 'month') srcCtx = getMonthKey(state.timelineViewDate);
        else if (overflow.sourceHorizon === 'epoch') srcCtx = state.epochFilter || 'ongoing';
        else if (overflow.sourceHorizon === 'day') srcCtx = getDateKey(state.timelineViewDate);
        e.dataTransfer.setData('application/x-source-context', srcCtx);
        e.dataTransfer.effectAllowed = 'copyMove';
        window._draggedActionIds = null;
        window._draggedAction = action;
        dragState.draggedId = action.id;
        row.classList.add('overflow-item-dragging');
        document.getElementById('project-tree').classList.add('dragging-active');
        document.body.classList.add('dragging-to-timeline');
        _showAllHorizonLayers();
    });
    row.addEventListener('dragend', () => {
        row.classList.remove('overflow-item-dragging');
        window._draggedAction = null;
        window._draggedActionIds = null;
        dragState.draggedId = null;
        dragState.dropTarget = null;
        document.getElementById('project-tree').classList.remove('dragging-active');
        document.body.classList.remove('dragging-to-timeline');
        clearDropIndicators();
        document.querySelectorAll('.time-block-drag-over').forEach(el => el.classList.remove('time-block-drag-over'));
        document.querySelectorAll('.horizon-layer-drag-over').forEach(el => el.classList.remove('horizon-layer-drag-over'));
        document.querySelectorAll('.date-nav-btn-drag-over').forEach(el => el.classList.remove('date-nav-btn-drag-over'));
        _restoreHorizonLayers();
    });

    return row;
}

// Helper: build and append toggle row to zone
function _buildOverflowToggleRow(zone, container, overflow, currentVisible, totalCount, sourceCtx, animate, animItemCount) {
    const remainingCount = totalCount - currentVisible;
    const isExpanded = currentVisible > OVERFLOW_PAGE_SIZE;

    if (remainingCount <= 0 && !isExpanded) return;

    const toggleRow = document.createElement('div');
    toggleRow.className = 'overflow-toggle-row';

    if (isExpanded) {
        const lessBtn = document.createElement('span');
        lessBtn.className = 'overflow-toggle';
        lessBtn.textContent = 'show less';
        lessBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Phase 1: immediately fade out the toggle row
            const currentToggle = zone.querySelector('.overflow-toggle-row');
            if (currentToggle) currentToggle.classList.add('overflow-toggle-exiting');

            const toggleFadeTime = 200;
            setTimeout(() => {
                // Phase 2: start items exit cascade
                const allItems = zone.querySelectorAll('.overflow-item');
                const newTarget = Math.max(OVERFLOW_PAGE_SIZE, currentVisible - OVERFLOW_PAGE_SIZE);
                const exitItems = Array.from(allItems).slice(newTarget);
                exitItems.forEach((item, i) => {
                    item.style.animationDelay = `${(exitItems.length - 1 - i) * 40}ms`;
                    item.classList.add('overflow-item-exiting');
                });
                const itemsExitTime = 200 + exitItems.length * 40;
                setTimeout(() => {
                    // Phase 3: remove exited items + old toggle, build new toggle with fade in
                    exitItems.forEach(item => item.remove());
                    _overflowVisibleCount = newTarget <= OVERFLOW_PAGE_SIZE ? 0 : newTarget;
                    const oldToggle = zone.querySelector('.overflow-toggle-row');
                    if (oldToggle) oldToggle.remove();
                    _overflowAnimFrom = -2;
                    _buildOverflowToggleRow(zone, container, overflow, newTarget, totalCount, sourceCtx, true, 0);
                }, itemsExitTime);
            }, toggleFadeTime);
        });
        toggleRow.appendChild(lessBtn);
    }

    if (remainingCount > 0) {
        const moreBtn = document.createElement('span');
        moreBtn.className = 'overflow-toggle';
        moreBtn.textContent = `show more (${remainingCount})`;
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const newVisibleCount = Math.min(currentVisible + OVERFLOW_PAGE_SIZE, totalCount);
            const newItems = overflow.items.slice(currentVisible, newVisibleCount);
            _overflowVisibleCount = newVisibleCount <= OVERFLOW_PAGE_SIZE ? 0 : newVisibleCount;
            const oldToggle = zone.querySelector('.overflow-toggle-row');
            if (oldToggle) oldToggle.remove();
            newItems.forEach((action, i) => {
                const newRow = _createOverflowItemRow(action, overflow, sourceCtx, container);
                if (newRow) {
                    newRow.classList.add('overflow-item-entering');
                    newRow.style.animationDelay = `${i * 40}ms`;
                    zone.appendChild(newRow);
                }
            });
            _buildOverflowToggleRow(zone, container, overflow, newVisibleCount, totalCount, sourceCtx, true, newItems.length);
        });
        toggleRow.appendChild(moreBtn);
    }

    if (animate) {
        toggleRow.classList.add('overflow-toggle-entering');
        toggleRow.style.animationDelay = `${(animItemCount || 0) * 40}ms`;
    }
    zone.appendChild(toggleRow);
}

// Render the ghost zone of overflow items inside the actions container.
function renderOverflowPreview(container) {
    // Remove any existing overflow preview (keep reference for swap)
    const existing = container.querySelector('.overflow-preview');

    // Don't show overflow during deep view, live horizon, or sleep
    if (state.deepView) { if (existing) existing.remove(); return; }
    if (state.viewHorizon === 'live') { if (existing) existing.remove(); return; }
    if (isInSleepRange() && !state.workingOn && !state.onBreak) { if (existing) existing.remove(); return; }

    const overflow = getOverflowItems(state.selectedItemId);
    if (!overflow || overflow.items.length === 0) { if (existing) existing.remove(); return; }

    const totalCount = overflow.items.length;
    const visibleCount = _overflowVisibleCount > 0 ? Math.min(_overflowVisibleCount, totalCount) : Math.min(OVERFLOW_PAGE_SIZE, totalCount);
    const visibleItems = overflow.items.slice(0, visibleCount);

    // Resolve source horizon context string for investment calculation
    let sourceCtx = '';
    if (overflow.sourceHorizon === 'week') sourceCtx = getWeekKey(state.timelineViewDate);
    else if (overflow.sourceHorizon === 'month') sourceCtx = getMonthKey(state.timelineViewDate);
    else if (overflow.sourceHorizon === 'epoch') sourceCtx = state.epochFilter || 'ongoing';
    else if (overflow.sourceHorizon === 'day') sourceCtx = getDateKey(state.timelineViewDate);

    const zone = document.createElement('div');
    zone.className = 'overflow-preview';

    // Header
    const header = document.createElement('div');
    header.className = 'overflow-preview-header';
    header.textContent = `📦 From ${HORIZON_LABELS[overflow.sourceHorizon] || overflow.sourceHorizon}`;
    zone.appendChild(header);
    // Items (no animation on initial load — animation only on show more/less)
    for (let i = 0; i < visibleItems.length; i++) {
        const action = visibleItems[i];
        const row = _createOverflowItemRow(action, overflow, sourceCtx, container);
        if (!row) continue;
        zone.appendChild(row);
    }

    // Show more / show less toggles (via shared helper)
    _buildOverflowToggleRow(zone, container, overflow, visibleCount, totalCount, sourceCtx);

    // Reset animation state for next initial render (from renderActions)
    _overflowAnimFrom = -1;

    // Swap atomically to avoid flicker, or append if first render
    if (existing) {
        existing.replaceWith(zone);
    } else {
        container.appendChild(zone);
    }
}

// ─── Deep View Helpers ───

// Deep view: match items at the current horizon level AND all lower levels.
// epoch → month, week, day, session
// month → week, day, session
// week → day, session
// day → session (segments)
function itemMatchesDeepView(action, currentDateKey) {
    if (state.viewHorizon === 'epoch') {
        if (isItemInEpoch(action, state.epochFilter)) return true;
        return isItemInEpochRange(action, state.epochFilter);
    }
    if (state.viewHorizon === 'month') {
        const monthKey = getMonthKey(state.timelineViewDate);
        if (isItemInMonth(action, monthKey)) return true;
        return isItemInMonthDays(action, state.timelineViewDate);
    }
    if (state.viewHorizon === 'week') {
        const weekKey = getWeekKey(state.timelineViewDate);
        if (isItemInWeek(action, weekKey)) return true;
        return isItemInWeekDays(action, state.timelineViewDate);
    }
    // Day horizon: show day items + session-level items
    if (itemMatchesTimeContext(action, currentDateKey)) return true;
    const item = findItemById(action.id);
    return hasSegmentContext(item, currentDateKey);
}

// Check if an item has a date/week context falling within the epoch's date range
function isItemInEpochRange(action, epochName) {
    const item = findItemById(action.id);
    const tcs = (item && item.timeContexts) || [];
    for (const tc of tcs) {
        if (isWeekContext(tc)) {
            if (isWeekInEpoch(tc, epochName)) return true;
            continue;
        }
        if (isMonthContext(tc)) {
            // Check if any part of the month overlaps the epoch range
            const monthRange = getMonthDateRange(tc);
            if (monthRange) {
                const epochRange = getEpochWeekRange(epochName);
                const monthStartWeek = getWeekKey(monthRange.start);
                const monthEndWeek = getWeekKey(monthRange.end);
                if ((!epochRange.startWeek || monthEndWeek >= epochRange.startWeek) &&
                    (!epochRange.endWeek || monthStartWeek <= epochRange.endWeek)) return true;
            }
            continue;
        }
        const parsed = parseTimeContext(tc);
        if (parsed && parsed.date) {
            if (isDateInEpochRange(parsed.date, epochName)) return true;
        }
    }
    return false;
}

// Check if a date string falls within an epoch's date range
function isDateInEpochRange(dateKey, epochName) {
    const epochRange = getEpochWeekRange(epochName);
    // Convert week boundaries to date boundaries
    if (epochRange.startWeek) {
        const startRange = getWeekDateRange(epochRange.startWeek);
        if (startRange && dateKey < getDateKey(startRange.start)) return false;
    }
    if (epochRange.endWeek) {
        const endRange = getWeekDateRange(epochRange.endWeek);
        if (endRange && dateKey > getDateKey(endRange.end)) return false;
    }
    return true;
}

// Check if an item has a day-level context for any day in the given week
function isItemInWeekDays(action, viewDate) {
    const item = findItemById(action.id);
    const tcs = (item && item.timeContexts) || [];
    const weekKey = getWeekKey(viewDate);
    const range = getWeekDateRange(weekKey);
    if (!range) return false;
    const startKey = getDateKey(range.start);
    const endKey = getDateKey(range.end);
    for (const tc of tcs) {
        const parsed = parseTimeContext(tc);
        if (parsed && parsed.date && parsed.date >= startKey && parsed.date <= endKey) {
            return true;
        }
    }
    return false;
}

// Check if an item has a day-level context for any day in the given month
function isItemInMonthDays(action, viewDate) {
    const item = findItemById(action.id);
    const tcs = (item && item.timeContexts) || [];
    const monthKey = getMonthKey(viewDate);
    const range = getMonthDateRange(monthKey);
    if (!range) return false;
    const startKey = getDateKey(range.start);
    const endKey = getDateKey(range.end);
    for (const tc of tcs) {
        // Week context within the month
        if (isWeekContext(tc)) {
            if (isWeekInMonth(tc, monthKey)) return true;
            continue;
        }
        const parsed = parseTimeContext(tc);
        if (parsed && parsed.date && parsed.date >= startKey && parsed.date <= endKey) {
            return true;
        }
    }
    return false;
}

// Return human-readable labels for ALL of the item's time contexts.
// Only shown when deep view is active.
function getDeepViewContextLabels(action) {
    const item = findItemById(action.id);
    if (!item || !item.timeContexts) return [];

    const labels = [];
    for (const tc of item.timeContexts) {
        // Epoch context (past/ongoing/future)
        if (EPOCH_CONTEXTS.includes(tc)) {
            labels.push(tc.charAt(0).toUpperCase() + tc.slice(1)); // "Ongoing", "Future", "Past"
            continue;
        }

        // Month context: show "Feb" etc
        if (isMonthContext(tc)) {
            const monthStr = tc.substring(6); // "2026-02"
            const [y, m] = monthStr.split('-').map(Number);
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            labels.push(months[m - 1]);
            continue;
        }

        // Week context: show "W7" etc
        if (isWeekContext(tc)) {
            const weekDate = new Date(tc.substring(5) + 'T12:00:00');
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            labels.push(`Week`);
            continue;
        }

        const parsed = parseTimeContext(tc);

        // Segment context (session level): "10:00–12:00"
        if (parsed && parsed.segment) {
            labels.push(`${parsed.segment.start}–${parsed.segment.end}`);
            continue;
        }

        // Entry context (planned entry): look up the entry's time range
        if (parsed && parsed.entryId) {
            const entry = state.timeline?.entries?.find(e => String(e.id) === String(parsed.entryId));
            if (entry && entry.timestamp && entry.endTime) {
                const fmt = (ms) => {
                    const d = new Date(ms);
                    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                };
                labels.push(`📅 ${fmt(entry.timestamp)}–${fmt(entry.endTime)}`);
            } else if (parsed.date) {
                const d = new Date(parsed.date + 'T12:00:00');
                const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                labels.push(`📅 ${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`);
            } else {
                labels.push('📅 Planned');
            }
            continue;
        }

        // Date context: show day name ("Mon", "Tue")
        if (parsed && parsed.date && !parsed.segment) {
            const d = new Date(parsed.date + 'T12:00:00');
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            labels.push(days[d.getDay()]);
            continue;
        }
    }
    return labels;
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

// Returns array of action IDs being dragged (multi-select aware)
function getMultiDragIds(e) {
    if (window._draggedActionIds && window._draggedActionIds.length > 0) {
        return window._draggedActionIds.map(id => parseInt(id, 10));
    }
    const singleId = e.dataTransfer.getData('application/x-action-id');
    return singleId ? [parseInt(singleId, 10)] : [];
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

    // Remove from context button
    const declineBtn = document.createElement('button');
    declineBtn.className = 'bulk-bar-btn bulk-bar-btn-decline';
    declineBtn.textContent = '✕ Remove';
    declineBtn.title = `Remove ${count} item(s) from this context`;
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
    if (!confirm(`Remove ${ids.length} item(s) from this context?`)) return;

    const ctx = getCurrentViewContext();
    for (const id of ids) {
        await removeSourceContext(parseInt(id, 10), ctx);
    }
    clearActionSelection();
    renderAll();
}

// ── Ambient deselection: clicking empty space in actions list clears selection ──
document.addEventListener('DOMContentLoaded', () => {
    _setupReflectionPanelHandler();

    // Re-check header overlap when the header container resizes (window resize, column drag, etc.)
    let _resizeOverlapTimer;
    const actionsHeader = document.getElementById('section-header-actions');
    if (actionsHeader) {
        new ResizeObserver(() => {
            clearTimeout(_resizeOverlapTimer);
            _resizeOverlapTimer = setTimeout(checkHeaderOverlap, 60);
        }).observe(actionsHeader);
    }
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
                    const dragIds = getMultiDragIds(e);
                    if (dragIds.length === 0) return;
                    e.preventDefault();
                    actionsSection.classList.remove('actions-drag-over');
                    window._draggedAction = null;
                    const ctxs = getCurrentTimeContexts();
                    (async () => {
                        for (const itemId of dragIds) {
                            const item = findItemById(itemId);
                            if (!item) continue;
                            // Strip existing entry/session/segment contexts that are subsumed
                            if (item.timeContexts) {
                                const plainDates = ctxs.filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c));
                                if (plainDates.length > 0) {
                                    const before = item.timeContexts.length;
                                    item.timeContexts = item.timeContexts.filter(tc => {
                                        return !plainDates.some(d => tc.startsWith(d + '@'));
                                    });
                                    if (item.contextDurations && item.timeContexts.length < before) {
                                        for (const key of Object.keys(item.contextDurations)) {
                                            if (plainDates.some(d => key.startsWith(d + '@'))) {
                                                delete item.contextDurations[key];
                                            }
                                        }
                                    }
                                }
                            }
                            for (const ctx of ctxs) { await addTimeContext(itemId, ctx); }
                            // Reparent under selected project if applicable
                            if (state.selectedItemId && state.selectedItemId !== itemId) {
                                const selectedItem = findItemById(state.selectedItemId);
                                if (selectedItem) {
                                    const descIds = collectDescendantIds(selectedItem);
                                    if (!descIds.includes(itemId)) {
                                        moveItem(itemId, { id: state.selectedItemId, position: 'inside' });
                                        saveItems();
                                    }
                                }
                            }
                        }
                        clearActionSelection();
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
        // Ghost action buttons: Schedule + Dismiss
        const ghostBtns = document.createElement('div');
        ghostBtns.className = 'action-buttons ghost-action-buttons';
        const schedBtn = document.createElement('button');
        schedBtn.className = 'action-btn ghost-action-schedule';
        schedBtn.textContent = '📌';
        schedBtn.title = 'Schedule for this context';
        schedBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await scheduleLeadTimeGhost(action._realId, getCurrentViewContext());
        });
        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'action-btn ghost-action-dismiss';
        dismissBtn.textContent = '✕';
        dismissBtn.title = 'Dismiss from this context';
        dismissBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await dismissLeadTimeGhost(action._realId, action._deadlineCtx, getCurrentViewContext());
        });
        ghostBtns.appendChild(schedBtn);
        ghostBtns.appendChild(dismissBtn);
        item.appendChild(ghostBtns);
        return item;
    }

    const item = document.createElement('div');
    const actionIdStr = String(action.id);
    const isLiveWorking = state.workingOn && state.workingOn.itemId === action.id;
    item.className = 'action-item' + (action.done ? ' done' : '') + (state.selectedActionIds.has(actionIdStr) ? ' selected' : '') + (isLiveWorking ? ' action-item-working' : '');
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
            e.dataTransfer.setData('application/x-drag-source', 'actions');
            // In deep view there's no defined source context — always copy (don't remove any context)
            e.dataTransfer.setData('application/x-source-context', state.deepView ? '' : getCurrentViewContext());
            e.dataTransfer.effectAllowed = 'copyMove';
            // Multi-select: if this item is part of a selection ≥ 2, carry all selected IDs
            const isMulti = state.selectedActionIds.has(actionIdStr) && state.selectedActionIds.size >= 2;
            if (isMulti) {
                window._draggedActionIds = [...state.selectedActionIds];
                // Show count badge as drag image
                const ghost = document.createElement('div');
                ghost.className = 'multi-drag-ghost';
                ghost.textContent = `${state.selectedActionIds.size} items`;
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, 0, 0);
                setTimeout(() => ghost.remove(), 0);
                // Fade all selected items
                document.querySelectorAll('.action-item').forEach(el => {
                    if (state.selectedActionIds.has(String(el.dataset.id))) {
                        el.classList.add('action-item-dragging');
                    }
                });
            } else {
                window._draggedActionIds = null;
                item.classList.add('action-item-dragging');
            }
            // Store action data for the timeline drop handler
            window._draggedAction = action;
            // Also set dragState so project tree drop targets accept this drag
            dragState.draggedId = action.id;
            document.getElementById('project-tree').classList.add('dragging-active');
            document.body.classList.add('dragging-to-timeline');
            _showAllHorizonLayers();
        });
        item.addEventListener('dragend', () => {
            // Remove dragging class from all (handles both single and multi)
            document.querySelectorAll('.action-item-dragging').forEach(el => el.classList.remove('action-item-dragging'));
            window._draggedAction = null;
            window._draggedActionIds = null;
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
            _restoreHorizonLayers();
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
        animateActionsZoomIn(() => {
            state.selectedItemId = action.id;
            savePref('selectedItemId', action.id);
            state._animateActions = true;
            renderAll();
            requestAnimationFrame(() => scrollToSelectedItem());
        });
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
        if (state._actionGroupingActive && !action._singleGroup) {
            // Also skip the group header ancestor (but not for single-item groups — they have no header)
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

    // Duration / Investment badge (context-aware)
    const estimateItem = findItemById(action.id);
    if (!action.done) {
        if (state.showInvestmentBadge) {
            const inv = computeTimeInvestment(estimateItem);
            if (inv) {
                // Tri-state investment bar
                const invBadge = document.createElement('div');
                invBadge.className = 'action-investment-badge';
                const total = inv.budget > 0 ? inv.budget : (inv.invested + inv.planned);
                const invPct = total > 0 ? Math.min(100, (inv.invested / total) * 100) : 0;
                const planPct = total > 0 ? Math.min(100 - invPct, (inv.planned / total) * 100) : 0;
                // Hover tooltip
                const parts = [];
                if (inv.invested > 0) parts.push(`${_formatDuration(inv.invested)} invested`);
                if (inv.planned > 0) parts.push(`${_formatDuration(inv.planned)} planned`);
                if (inv.budget > 0) {
                    parts.push(`${_formatDuration(inv.remaining)} remaining`);
                }
                const hoverText = parts.join(' / ');
                // Over-commitment visual cue
                if (inv.budget > 0 && inv.invested + inv.planned > inv.budget) {
                    invBadge.classList.add('investment-over');
                }
                const bar = document.createElement('div');
                bar.className = 'investment-bar';
                const fillInv = document.createElement('div');
                fillInv.className = 'investment-fill-invested';
                fillInv.style.width = `${invPct}%`;
                bar.appendChild(fillInv);
                const fillPlan = document.createElement('div');
                fillPlan.className = 'investment-fill-planned';
                fillPlan.style.width = `${planPct}%`;
                bar.appendChild(fillPlan);
                invBadge.appendChild(bar);
                const lbl = document.createElement('span');
                lbl.className = 'investment-label';
                const defaultText = _formatDuration(total);
                lbl.textContent = defaultText;
                invBadge.appendChild(lbl);
                function _swapLabel2(text) {
                    lbl.classList.add('investment-label-out');
                    setTimeout(() => {
                        lbl.textContent = text;
                        lbl.classList.remove('investment-label-out');
                        lbl.classList.add('investment-label-in');
                        requestAnimationFrame(() => { requestAnimationFrame(() => { lbl.classList.remove('investment-label-in'); }); });
                    }, 120);
                }
                invBadge.addEventListener('mouseenter', () => _swapLabel2(hoverText));
                invBadge.addEventListener('mouseleave', () => _swapLabel2(defaultText));
                // Click to edit duration still works
                invBadge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showEstimatePicker(invBadge, action.id);
                });
                badgesRow.appendChild(invBadge);
            } else {
                // No investment data — show simple estimate badge
                const estimateBadge = document.createElement('span');
                estimateBadge.className = 'action-estimate-badge';
                const est = getContextDuration(estimateItem);
                if (est) {
                    estimateBadge.textContent = _formatDuration(est);
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
        } else {
            // Classic estimate badge (showInvestmentBadge off)
            const estimateBadge = document.createElement('span');
            estimateBadge.className = 'action-estimate-badge';
            const est = getContextDuration(estimateItem);
            if (est) {
                estimateBadge.textContent = _formatDuration(est);
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
    }

    // Deep view context badges — show ALL of the item's time contexts when deep view is on
    if (state.deepView) {
        const ctxLabels = getDeepViewContextLabels(action);
        for (const label of ctxLabels) {
            const ctxBadge = document.createElement('span');
            ctxBadge.className = 'action-context-badge';
            ctxBadge.textContent = label;
            badgesRow.appendChild(ctxBadge);
        }
    }

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
    let _shadowDeadlineCtx = null;
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
                _shadowDeadlineCtx = ctx;
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

    // Remove from context / Dismiss ghost button
    const declineBtn = document.createElement('button');
    declineBtn.className = 'action-btn action-btn-decline';
    declineBtn.textContent = '✕';
    if (_shadowDeadlineCtx) {
        // Shadow item: ✕ dismisses the ghost, not removes from context
        declineBtn.title = 'Dismiss from this context';
        declineBtn.classList.add('ghost-action-dismiss');
        declineBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await dismissLeadTimeGhost(action.id, _shadowDeadlineCtx, getCurrentViewContext());
        });
    } else {
        declineBtn.title = 'Remove from this context';
        declineBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await removeSourceContext(action.id, getCurrentViewContext());
            renderAll();
        });
    }

    // Schedule ghost button (only for shadow items)
    let ghostScheduleBtn = null;
    if (_shadowDeadlineCtx) {
        ghostScheduleBtn = document.createElement('button');
        ghostScheduleBtn.className = 'action-btn ghost-action-schedule';
        ghostScheduleBtn.textContent = '📌';
        ghostScheduleBtn.title = 'Schedule for this context';
        ghostScheduleBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await scheduleLeadTimeGhost(action.id, getCurrentViewContext());
        });
    }

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
                showDurationPicker(workBtn, action.id, action.name, ancestors);
            }
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
    if (ghostScheduleBtn) buttons.appendChild(ghostScheduleBtn);
    buttons.appendChild(scheduleBtn);
    buttons.appendChild(breakdownBtn);

    item.appendChild(content);
    item.appendChild(buttons);

    return item;
}

function setupActionInput() {
    const input = document.getElementById('action-input');
    const btn = document.getElementById('action-input-btn');
    const startBtn = document.getElementById('action-start-btn');
    if (!input) return;

    // ── Override State ──
    let _atOverrideId = null;
    let _atOverrideName = null;
    let _hashOverrideContexts = null;   // time context override from #shortcut
    let _hashOverrideName = null;       // display label for time chip
    let _durationMinutes = null;        // duration override from #30m / #1h / etc.
    let _durationLabel = null;          // display label for duration chip
    let _existingItemId = null;         // existing item selected from auto-suggest
    let _existingItemName = null;       // display name for existing item chip

    // ── Generic Dropdown State ──
    let _dropdown = null;
    let _highlightIdx = -1;
    let _dropdownItems = [];
    let _activeTrigger = null;  // which trigger char is active: '@', '#', '/', or 'auto'
    let _activeTriggerInfo = null; // { atIdx, query } for the active trigger

    const updateBtnVisibility = () => {
        const hasText = !!input.value.trim();
        if (btn) {
            if (hasText) {
                btn.classList.add('action-input-btn-visible');
            } else {
                btn.classList.remove('action-input-btn-visible');
            }
        }
        if (startBtn) {
            // Show start button when there's text OR when @override or existing item is selected
            if (hasText || _atOverrideId || _existingItemId) {
                startBtn.classList.add('action-input-btn-visible');
            } else {
                startBtn.classList.remove('action-input-btn-visible');
            }
        }
        if (btn) {
            // Also show add button when existing item is selected (even with no text)
            if (_existingItemId && !hasText) {
                btn.classList.add('action-input-btn-visible');
            }
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
        if (triggerChar !== '@' && query.includes(' ')) return null;
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

    // ── / Existing-item helpers ──
    const _getExistingItems = (query) => {
        const allItems = collectAllItems(state.items.items);
        // Get IDs of items already visible in the current actions context
        const visibleIds = new Set(getFilteredActions().map(a => a.id));
        // Exclude items already in the current context
        let candidates = allItems.filter(i => !visibleIds.has(i.id) && !i.done);
        if (query) candidates = candidates.filter(i => _fuzzyMatch(i.name, query));
        return candidates.slice(0, 8).map(item => ({
            id: item.id,
            name: item.name,
            description: _buildBreadcrumb(item),
            _raw: item,
            _isExisting: true
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

    // ── Duration parser ──
    // Matches patterns like: 30m, 1h, 1h30m, 1.5h, 90 (bare digits = minutes)
    const _parseDuration = (query) => {
        if (!query) return null;
        const q = query.trim().toLowerCase();
        // Pattern: 1h30m or 1h 30m
        let m = q.match(/^(\d+)h\s*(\d+)m?$/);
        if (m) {
            const mins = parseInt(m[1]) * 60 + parseInt(m[2]);
            return { minutes: mins, label: `${m[1]}h ${m[2]}m` };
        }
        // Pattern: 1.5h
        m = q.match(/^(\d+\.\d+)h$/);
        if (m) {
            const mins = Math.round(parseFloat(m[1]) * 60);
            const h = Math.floor(mins / 60);
            const rm = mins % 60;
            return { minutes: mins, label: rm ? `${h}h ${rm}m` : `${h}h` };
        }
        // Pattern: 2h
        m = q.match(/^(\d+)h$/);
        if (m) {
            const mins = parseInt(m[1]) * 60;
            return { minutes: mins, label: `${m[1]}h` };
        }
        // Pattern: 30m
        m = q.match(/^(\d+)m$/);
        if (m) {
            const mins = parseInt(m[1]);
            return { minutes: mins, label: `${mins}m` };
        }
        // Pattern: bare digits → minutes (only if it looks numeric)
        m = q.match(/^(\d+)$/);
        if (m) {
            const mins = parseInt(m[1]);
            if (mins > 0 && mins <= 480) { // reasonable range: 1–480 min
                return { minutes: mins, label: `${mins}m` };
            }
        }
        return null;
    };

    // Build duration dropdown items from a parsed duration
    const _getDurationItems = (query) => {
        const parsed = _parseDuration(query);
        if (!parsed || parsed.minutes <= 0) return [];
        // Format human label
        const h = Math.floor(parsed.minutes / 60);
        const rm = parsed.minutes % 60;
        const desc = h > 0 ? (rm > 0 ? `${h} hr ${rm} min` : `${h} hr`) : `${parsed.minutes} min`;
        return [{
            name: parsed.label,
            description: desc,
            _durationMinutes: parsed.minutes
        }];
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
            { label: 'this month', aliases: ['month', 'thismonth'], description: 'Current month', contexts: [getMonthKey(today)] },
            { label: 'next month', aliases: ['nextmonth'], description: 'Next month', contexts: [getMonthKey(new Date(today.getFullYear(), today.getMonth() + 1, 1))] },
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
            const isDurationItem = !!item._durationMinutes;
            icon.textContent = triggerChar === '#' ? (isDurationItem ? '⏱' : '📅') : ((triggerChar === '/' || triggerChar === 'auto') ? '📌' : '');
            if (triggerChar === '#' || triggerChar === '/' || triggerChar === 'auto') opt.appendChild(icon);

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

        // Strip the trigger+query from the input (chip will show externally)
        const val = input.value;
        const before = val.slice(0, triggerInfo.atIdx);
        const after = val.slice(triggerInfo.atIdx + 1 + triggerInfo.query.length);
        input.value = (before + after).replace(/\s{2,}/g, ' ').trim();

        if (triggerChar === '/' || triggerChar === 'auto') {
            // Set existing item selection (chip-based, not immediate)
            _existingItemId = item.id;
            _existingItemName = item.name;
            // Clear the input text since the item name IS the selection
            input.value = '';
        } else if (triggerChar === '@') {
            _atOverrideId = item.id;
            _atOverrideName = item.name;
        } else if (triggerChar === '#') {
            if (item._durationMinutes) {
                _durationMinutes = item._durationMinutes;
                _durationLabel = item.name;
            } else {
                _hashOverrideContexts = item._timeContexts;
                _hashOverrideName = item.name;
            }
        }

        _closeDropdown();
        updateBtnVisibility();
        _renderChips();
        input.focus();
    };

    // ── Chips (both @ and # and existing-item combined) ──
    const _renderChips = () => {
        const row = document.getElementById('action-input-row');
        row.querySelector('.action-input-at-chip')?.remove();
        row.querySelector('.action-input-hash-chip')?.remove();
        row.querySelector('.action-input-duration-chip')?.remove();
        row.querySelector('.action-input-existing-chip')?.remove();

        if (_existingItemId) {
            const chip = document.createElement('span');
            chip.className = 'action-input-existing-chip';
            chip.innerHTML = `<span class="at-chip-label">📌 ${_existingItemName}</span><button class="at-chip-remove" title="Remove">×</button>`;
            chip.querySelector('.at-chip-remove').addEventListener('mousedown', (e) => {
                e.preventDefault();
                _existingItemId = null;
                _existingItemName = null;
                chip.remove();
                updateBtnVisibility();
                input.focus();
            });
            row.appendChild(chip);
        }

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

        if (_durationMinutes) {
            const chip = document.createElement('span');
            chip.className = 'action-input-duration-chip';
            chip.innerHTML = `<span class="at-chip-label">⏱ ${_durationLabel}</span><button class="at-chip-remove" title="Remove">×</button>`;
            chip.querySelector('.at-chip-remove').addEventListener('mousedown', (e) => {
                e.preventDefault();
                _durationMinutes = null;
                _durationLabel = null;
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

        // Try # trigger first (if no time or duration override selected yet)
        if (!_hashOverrideContexts || !_durationMinutes) {
            const hashInfo = _getTriggerQuery('#');
            if (hashInfo) {
                // Check if this looks like a duration pattern first
                if (!_durationMinutes) {
                    const durItems = _getDurationItems(hashInfo.query);
                    if (durItems.length > 0) {
                        // Show duration options; also append time matches below
                        const timeItems = !_hashOverrideContexts ? _getTimeItems(hashInfo.query) : [];
                        _renderDropdown([...durItems, ...timeItems], '#', hashInfo);
                        return;
                    }
                }
                // Otherwise show time options (if no time override yet)
                if (!_hashOverrideContexts) {
                    const items = _getTimeItems(hashInfo.query);
                    _renderDropdown(items, '#', hashInfo);
                    return;
                }
            }
        }

        // Try @ trigger (allow replacing existing override) — disabled when existing item is selected
        if (!_existingItemId) {
            const atInfo = _getTriggerQuery('@');
            if (atInfo) {
                const items = _getProjectItems(atInfo.query);
                _renderDropdown(items, '@', atInfo);
                return;
            }
        }

        // Try / trigger and triggerless auto-suggest — disabled when existing item already selected
        if (!_existingItemId) {
            // Try / trigger (add existing item to current context)
            const slashInfo = _getTriggerQuery('/');
            if (slashInfo) {
                const items = _getExistingItems(slashInfo.query);
                _renderDropdown(items, '/', slashInfo);
                return;
            }

            // Triggerless auto-suggest: show existing items as user types
            const query = input.value.trim();
            if (query.length >= 1) {
                const items = _getExistingItems(query);
                if (items.length > 0) {
                    _renderDropdown(items, 'auto', { atIdx: 0, query });
                    return;
                }
            }
        }

        _closeDropdown();
    };

    // ── Helper: clear input state after submit/start ──
    const _clearInputState = () => {
        input.value = '';
        _atOverrideId = null;
        _atOverrideName = null;
        _hashOverrideContexts = null;
        _hashOverrideName = null;
        _durationMinutes = null;
        _durationLabel = null;
        _existingItemId = null;
        _existingItemName = null;
        _closeDropdown();
        const row = document.getElementById('action-input-row');
        row?.querySelector('.action-input-at-chip')?.remove();
        row?.querySelector('.action-input-hash-chip')?.remove();
        row?.querySelector('.action-input-duration-chip')?.remove();
        row?.querySelector('.action-input-existing-chip')?.remove();
        updateBtnVisibility();
    };

    // ── Submit (create item or add existing to context) ──
    const submitAction = async () => {
        // Case: existing item selected — add to current context
        if (_existingItemId) {
            const existingItem = findItemById(_existingItemId);
            if (existingItem) {
                const timeContexts = _hashOverrideContexts || getCurrentTimeContexts();
                const merged = [...new Set([...(existingItem.timeContexts || []), ...timeContexts])];
                existingItem.timeContexts = merged;

                // Build contextDurations if duration was specified
                const patch = { timeContexts: merged };
                if (_durationMinutes) {
                    const durKey = getCurrentViewContext();
                    const cd = { ...(existingItem.contextDurations || {}), [durKey]: _durationMinutes };
                    existingItem.contextDurations = cd;
                    patch.contextDurations = cd;
                }

                await api.patch(`/items/${_existingItemId}`, patch);
                await reloadItems();
            }
            _clearInputState();
            return;
        }

        let name = input.value.trim();
        if (!name) return;

        // Strip @mention and #time/#duration from name
        if (_atOverrideId && _atOverrideName) {
            name = name.replace('@' + _atOverrideName, '').replace(/\s{2,}/g, ' ').trim();
        }
        if (_hashOverrideContexts && _hashOverrideName) {
            name = name.replace('#' + _hashOverrideName, '').replace(/\s{2,}/g, ' ').trim();
        }
        if (_durationMinutes && _durationLabel) {
            name = name.replace('#' + _durationLabel, '').replace(/\s{2,}/g, ' ').trim();
        }
        if (!name) return;

        // Determine parentId: @override > selected project > inbox
        const inbox = state.items.items.find(i => i.isInbox);
        const parentId = _atOverrideId || state.selectedItemId || (inbox ? inbox.id : null);

        // Determine timeContexts: #override > current view defaults
        const timeContexts = _hashOverrideContexts || getCurrentTimeContexts();

        // Build contextDurations if duration was specified
        let contextDurations = undefined;
        if (_durationMinutes) {
            const durKey = getCurrentViewContext();
            contextDurations = { [durKey]: _durationMinutes };
        }

        const newItem = await api.post('/items', {
            name,
            parentId,
            timeContexts,
            contextDurations
        });
        await reloadItems();

        // Auto-add to queue when focused on the live horizon
        if (state.viewHorizon === 'live' && newItem?.id) {
            addToQueue(newItem.id);
        }
        _clearInputState();
    };

    // ── Start (create item + start working, or start existing @item) ──
    const startAction = async () => {
        let name = input.value.trim();

        // Strip @mention and #time/#duration from name
        if (_atOverrideId && _atOverrideName) {
            name = name.replace('@' + _atOverrideName, '').replace(/\s{2,}/g, ' ').trim();
        }
        if (_hashOverrideContexts && _hashOverrideName) {
            name = name.replace('#' + _hashOverrideName, '').replace(/\s{2,}/g, ' ').trim();
        }
        if (_durationMinutes && _durationLabel) {
            name = name.replace('#' + _durationLabel, '').replace(/\s{2,}/g, ' ').trim();
        }

        // Case 0: existing item selected → add to context + start working
        if (_existingItemId && !name) {
            const itemId = _existingItemId;
            const itemName = _existingItemName;
            const existingItem = findItemById(itemId);
            if (existingItem) {
                const timeContexts = _hashOverrideContexts || getCurrentTimeContexts();
                const merged = [...new Set([...(existingItem.timeContexts || []), ...timeContexts])];
                existingItem.timeContexts = merged;
                await api.patch(`/items/${itemId}`, { timeContexts: merged });
                await reloadItems();
            }
            const ancestors = getAncestorPath(itemId);
            const projectName = ancestors && ancestors.length > 0
                ? ancestors.map(a => a.name).join(' › ')
                : null;
            _clearInputState();
            await startWorking(itemId, itemName, projectName);
            return;
        }

        // Case 1: @override selected but no new text → start existing item directly
        if (_atOverrideId && !name) {
            const itemId = _atOverrideId;
            const itemName = _atOverrideName;
            const ancestors = getAncestorPath(itemId);
            const projectName = ancestors && ancestors.length > 0
                ? ancestors.map(a => a.name).join(' › ')
                : null;
            _clearInputState();
            await startWorking(itemId, itemName, projectName);
            return;
        }

        // Must have a name to create a new item
        if (!name) return;

        // Case 2: Create new item, then start it
        const inbox = state.items.items.find(i => i.isInbox);
        const parentId = _atOverrideId || state.selectedItemId || (inbox ? inbox.id : null);
        const timeContexts = _hashOverrideContexts || getCurrentTimeContexts();

        // Build contextDurations if duration was specified
        let contextDurations = undefined;
        if (_durationMinutes) {
            const durKey = getCurrentViewContext();
            contextDurations = { [durKey]: _durationMinutes };
        }

        const newItem = await api.post('/items', {
            name,
            parentId,
            timeContexts,
            contextDurations
        });
        await reloadItems();

        if (newItem?.id) {
            const ancestors = getAncestorPath(newItem.id);
            const projectName = ancestors && ancestors.length > 0
                ? ancestors.map(a => a.name).join(' › ')
                : null;
            _clearInputState();
            await startWorking(newItem.id, name, projectName);
        } else {
            _clearInputState();
        }
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
            if (e.key === 'Tab') {
                e.preventDefault();
                _selectItem(_highlightIdx);
                return;
            }
            if (e.key === 'Enter') {
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
    if (startBtn) {
        startBtn.addEventListener('click', startAction);
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

// Format live timer display: countdown if target set, elapsed otherwise
function _fmtLiveTimer(nowMs, startMs, targetEndTime) {
    if (targetEndTime) {
        const rem = targetEndTime - nowMs;
        if (rem > 0) return _fmtHMS(rem) + ' left';
        return '+' + _fmtHMS(Math.abs(rem)) + ' over';
    }
    return _fmtHMS(Math.max(0, nowMs - startMs));
}

// ── Cached horizon tower DOM refs (static elements, never replaced) ──
let _ht_cache = null;
function _getHTCache() {
    if (_ht_cache && _ht_cache.epochLayer.isConnected) return _ht_cache;
    _ht_cache = {
        epochLayer: document.getElementById('horizon-epoch-layer'),
        monthLayer: document.getElementById('horizon-month-layer'),
        weekLayer: document.getElementById('horizon-week-layer'),
        dayLayer: document.getElementById('horizon-day-layer'),
        sessionLayer: document.getElementById('horizon-session-layer'),
        liveLayer: document.getElementById('horizon-live-layer'),
        epochIcon: document.getElementById('epoch-nav-icon'),
        epochLabel: document.getElementById('epoch-nav-label'),
        prevBtn: document.getElementById('epoch-nav-prev'),
        nextBtn: document.getElementById('epoch-nav-next'),
        monthLabel: document.getElementById('month-nav-label'),
        monthThisBtn: document.getElementById('month-nav-this-btn'),
        weekTodayBtn: document.getElementById('week-nav-today-btn'),
        weekPicker: document.getElementById('week-nav-picker'),
        dayPrevBtn: document.getElementById('date-nav-prev'),
        dayNextBtn: document.getElementById('date-nav-next'),
        dayTodayBtn: document.getElementById('date-nav-today-btn'),
        dayPicker: document.getElementById('date-nav-picker'),
    };
    return _ht_cache;
}
function renderHorizonTower() {
    const c = _getHTCache();
    const epochLayer = c.epochLayer;
    const monthLayer = c.monthLayer;
    const weekLayer = c.weekLayer;
    const dayLayer = c.dayLayer;
    const sessionLayer = c.sessionLayer;
    const liveLayer = c.liveLayer;
    if (!epochLayer || !monthLayer || !weekLayer || !dayLayer) return;

    const currentLevel = state.viewHorizon;

    // ── Visibility: show max 3 layers around the active one ──
    // Bottom → 2 above; Top → 2 below; Middle → 1 above + 1 below
    const _layers = ['epoch', 'month', 'week', 'day', 'session', 'live'];
    const _activeIdx = Math.max(0, _layers.indexOf(currentLevel));
    const _minVis = Math.max(0, Math.min(_activeIdx - 1, _layers.length - 3));
    const _maxVis = _minVis + 2;
    // Skip hiding layers that are mid-drag-animation
    const _allLayers = [epochLayer, monthLayer, weekLayer, dayLayer, sessionLayer, liveLayer].filter(Boolean);
    _allLayers.forEach((layer, i) => {
        const isDragAnimating = layer.classList.contains('horizon-drag-reveal') || layer.classList.contains('horizon-drag-hide');
        if (!isDragAnimating) {
            layer.style.display = (i >= _minVis && i <= _maxVis) ? '' : 'none';
        }
    });

    // Auto-sync epochFilter when timelineViewDate crosses epoch boundaries
    _syncEpochForCurrentWeek();

    // Epoch layer: active when viewHorizon is epoch, dim otherwise
    epochLayer.classList.toggle('horizon-layer-active', currentLevel === 'epoch');
    epochLayer.classList.toggle('horizon-layer-dim', currentLevel !== 'epoch');
    // Update icon and label to reflect current epochFilter
    const epochIcons = { past: '📜', ongoing: '📦', future: '🔮' };
    const epochLabels = { past: 'Past', ongoing: 'Ongoing', future: 'Future' };
    const epochIcon = c.epochIcon;
    const epochLabel = c.epochLabel;
    if (epochIcon) epochIcon.textContent = epochIcons[state.epochFilter] || '📦';
    if (epochLabel) epochLabel.textContent = epochLabels[state.epochFilter] || 'Ongoing';
    // Show/hide navigation arrows based on active state + disable at boundaries
    const epochActive = currentLevel === 'epoch';
    const epochIdx = EPOCH_CONTEXTS.indexOf(state.epochFilter);
    const prevBtn = c.prevBtn;
    const nextBtn = c.nextBtn;
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

    // Month layer: active when viewHorizon is month, dim otherwise
    monthLayer.classList.toggle('horizon-layer-active', currentLevel === 'month');
    monthLayer.classList.toggle('horizon-layer-dim', currentLevel !== 'month');
    // Show/hide month nav buttons based on active state
    const monthActive = currentLevel === 'month';
    monthLayer.querySelectorAll('.month-nav-btn').forEach(btn => {
        btn.style.display = monthActive ? '' : 'none';
    });
    // Update month label
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthLabel = c.monthLabel;
    if (monthLabel) {
        const viewDate = state.timelineViewDate;
        monthLabel.textContent = `${monthNames[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
    }
    // Show "This Month" button when not viewing current month
    const monthThisBtn = c.monthThisBtn;
    if (monthThisBtn) {
        if (!monthActive) {
            monthThisBtn.style.display = 'none';
        } else {
            const now = getLogicalToday();
            const isCurrent = now.getMonth() === state.timelineViewDate.getMonth() && now.getFullYear() === state.timelineViewDate.getFullYear();
            monthThisBtn.style.display = isCurrent ? 'none' : '';
        }
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
        const weekTodayBtn = c.weekTodayBtn;
        const weekPicker = c.weekPicker;
        if (!weekActive) {
            if (weekTodayBtn) weekTodayBtn.style.display = 'none';
            if (weekPicker) weekPicker.style.display = 'none';
        }
    }
    // Set week label — always show specific date range (even when dimmed)
    _updateWeekNavLabel();

    // Day layer: active when viewHorizon is day, dim otherwise
    dayLayer.classList.toggle('horizon-layer-active', currentLevel === 'day');
    dayLayer.classList.toggle('horizon-layer-dim', currentLevel !== 'day');
    // Show/hide day nav buttons based on active state
    const dayActive = currentLevel === 'day';
    const dayPrevBtn = c.dayPrevBtn;
    const dayNextBtn = c.dayNextBtn;
    const dayTodayBtn = c.dayTodayBtn;
    const dayPicker = c.dayPicker;
    if (dayPrevBtn) dayPrevBtn.style.display = dayActive ? '' : 'none';
    if (dayNextBtn) dayNextBtn.style.display = dayActive ? '' : 'none';
    if (!dayActive) {
        if (dayTodayBtn) dayTodayBtn.style.display = 'none';
        if (dayPicker) dayPicker.style.display = 'none';
    }

    // Session layer: visibility managed by the 3-layer window above
    if (sessionLayer) {
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

        const sessionPrevBtn = document.getElementById('session-nav-prev');
        const sessionNextBtn = document.getElementById('session-nav-next');
        const sessionNowBtn = document.getElementById('session-nav-now-btn');

        if (currentLevel === 'session') {
            // Show nav buttons
            if (sessionPrevBtn) sessionPrevBtn.style.display = '';
            if (sessionNextBtn) sessionNextBtn.style.display = '';

            // Show 'Now' button if not viewing the current session on today
            if (sessionNowBtn) {
                const todayKey = getDateKey(getLogicalToday());
                const viewKey = getDateKey(state.timelineViewDate);
                const isToday = viewKey === todayKey;
                const todaySegments = isToday ? segments : buildPlanSegments(getLogicalToday());
                const currentIdx = getCurrentSessionIndex(todaySegments);
                const isOnCurrentSession = isToday && state.sessionIndex === currentIdx;
                sessionNowBtn.style.display = isOnCurrentSession ? 'none' : '';
            }
        } else {
            // Dim mode: hide nav buttons and Now button
            if (sessionPrevBtn) sessionPrevBtn.style.display = 'none';
            if (sessionNextBtn) sessionNextBtn.style.display = 'none';
            if (sessionNowBtn) sessionNowBtn.style.display = 'none';
        }
    }

    // Live layer: always reflects current reality (work/break/idle/sleep)
    if (liveLayer) {
        liveLayer.classList.toggle('horizon-layer-active', currentLevel === 'live');
        liveLayer.classList.toggle('horizon-layer-dim', currentLevel !== 'live');


        const liveIcon = document.getElementById('live-layer-icon');
        const liveLabel = document.getElementById('live-nav-label');
        const liveTimer = document.getElementById('live-layer-timer');
        const liveStopBtn = document.getElementById('live-layer-stop-btn');
        const liveNextBtn = document.getElementById('live-layer-next-btn');
        const livePauseBtn = document.getElementById('live-layer-pause-btn');

        const nowMs = Date.now();
        const hasQueue = state.focusQueue.length > 0;
        if (state.workingOn) {
            if (liveIcon) liveIcon.textContent = '🔥';
            if (liveLabel) liveLabel.textContent = state.workingOn.itemName || 'Working';
            if (liveTimer) {
                liveTimer.dataset.sessionStart = state.workingOn.startTime;
                liveTimer.dataset.targetEnd = state.workingOn.targetEndTime || '';
                liveTimer.textContent = _fmtLiveTimer(nowMs, state.workingOn.startTime, state.workingOn.targetEndTime);
            }
            if (liveStopBtn) liveStopBtn.style.display = '';
            if (liveNextBtn) liveNextBtn.style.display = hasQueue ? '' : 'none';
            if (livePauseBtn) livePauseBtn.style.display = hasQueue ? '' : 'none';
        } else if (state.onBreak) {
            if (liveIcon) liveIcon.textContent = '☕';
            if (liveLabel) liveLabel.textContent = 'Break';
            if (liveTimer) {
                liveTimer.dataset.sessionStart = state.onBreak.startTime;
                liveTimer.dataset.targetEnd = state.onBreak.targetEndTime || '';
                liveTimer.textContent = _fmtLiveTimer(nowMs, state.onBreak.startTime, state.onBreak.targetEndTime);
            }
            if (liveStopBtn) liveStopBtn.style.display = '';
            if (liveNextBtn) liveNextBtn.style.display = 'none';
            if (livePauseBtn) livePauseBtn.style.display = 'none';
        } else if (isInSleepRange()) {
            if (liveIcon) liveIcon.textContent = '🌙';
            if (liveLabel) liveLabel.textContent = 'Sleep';
            if (liveTimer) {
                liveTimer.dataset.sessionStart = '';
                liveTimer.dataset.targetEnd = '';
                liveTimer.textContent = '';
            }
            if (liveStopBtn) liveStopBtn.style.display = 'none';
            if (liveNextBtn) liveNextBtn.style.display = 'none';
            if (livePauseBtn) livePauseBtn.style.display = 'none';
        } else {
            if (liveIcon) liveIcon.textContent = '💤';
            if (liveLabel) liveLabel.textContent = 'Idle';
            if (liveTimer) {
                liveTimer.dataset.sessionStart = '';
                liveTimer.dataset.targetEnd = '';
                liveTimer.textContent = '';
            }
            if (liveStopBtn) liveStopBtn.style.display = 'none';
            if (liveNextBtn) liveNextBtn.style.display = 'none';
            if (livePauseBtn) livePauseBtn.style.display = 'none';
        }
    }
}

// ─── Drag-Reveal: show all horizon layers during drag ───

// Track which layers were revealed during drag so we can animate them back
const _horizonDragRevealedLayers = new Set();
let _horizonDragGeneration = 0;

function _showAllHorizonLayers() {
    // Bump generation to invalidate any pending animationend handlers
    _horizonDragGeneration++;

    const layers = [
        document.getElementById('horizon-epoch-layer'),
        document.getElementById('horizon-month-layer'),
        document.getElementById('horizon-week-layer'),
        document.getElementById('horizon-day-layer'),
        document.getElementById('horizon-session-layer'),
        document.getElementById('horizon-live-layer'),
    ].filter(Boolean);

    for (const layer of layers) {
        // Cancel any in-progress hide animation first
        layer.classList.remove('horizon-drag-hide');
        layer.classList.remove('horizon-drag-reveal');

        if (layer.style.display === 'none') {
            layer.style.display = '';
            // Force reflow so the animation starts fresh
            void layer.offsetHeight;
            layer.classList.add('horizon-drag-reveal');
            _horizonDragRevealedLayers.add(layer);
        }
    }
}

function _restoreHorizonLayers() {
    const gen = _horizonDragGeneration;

    const layers = [
        document.getElementById('horizon-epoch-layer'),
        document.getElementById('horizon-month-layer'),
        document.getElementById('horizon-week-layer'),
        document.getElementById('horizon-day-layer'),
        document.getElementById('horizon-session-layer'),
        document.getElementById('horizon-live-layer'),
    ].filter(Boolean);

    // Determine which layers should be hidden per normal 3-layer window
    const currentLevel = state.viewHorizon;
    const _layerKeys = ['epoch', 'month', 'week', 'day', 'session', 'live'];
    const _activeIdx = Math.max(0, _layerKeys.indexOf(currentLevel));
    const _minVis = Math.max(0, Math.min(_activeIdx - 1, _layerKeys.length - 3));
    const _maxVis = _minVis + 2;

    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const shouldBeVisible = (i >= _minVis && i <= _maxVis);

        // Clean up reveal class
        layer.classList.remove('horizon-drag-reveal');

        if (!shouldBeVisible && _horizonDragRevealedLayers.has(layer)) {
            // Animate out, then hide
            _horizonDragRevealedLayers.delete(layer);
            layer.classList.add('horizon-drag-hide');
            const onEnd = (e) => {
                // Only act if this is OUR hide animation and generation is still current
                if (e.animationName !== 'horizon-layer-hide') return;
                if (_horizonDragGeneration !== gen) return;
                layer.classList.remove('horizon-drag-hide');
                layer.style.display = 'none';
                layer.removeEventListener('animationend', onEnd);
            };
            layer.addEventListener('animationend', onEnd);
        } else {
            _horizonDragRevealedLayers.delete(layer);
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
    animateLayerTransition('up', () => {
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
        state._animateActions = true;
        renderAll();
    });
}

// Toggle focus on live horizon (enter/exit live view)
function toggleLiveFocus() {
    if (state.viewHorizon === 'live') {
        // Already on live → pop back to day
        state.viewHorizon = 'day';
        savePref('viewHorizon', 'day');
        clearFocusStack();
        renderAll();
        return;
    }
    animateLayerTransition('up', () => {
        state.viewHorizon = 'live';
        savePref('viewHorizon', 'live');
        clearFocusStack();
        state._animateActions = true;
        renderAll();
    });
}

// Wire live layer click + stop button
(function _initLiveLayerHandlers() {
    document.addEventListener('DOMContentLoaded', () => {
        const liveLayer = document.getElementById('horizon-live-layer');
        if (liveLayer) {
            liveLayer.addEventListener('click', (e) => {
                // Don't toggle if clicking control buttons
                if (e.target.closest('.live-layer-stop-btn') || e.target.closest('.live-layer-next-btn') || e.target.closest('.live-layer-pause-btn')) return;
                toggleLiveFocus();
            });

            // ── DnD: drop onto live layer → start working on the item ──
            liveLayer.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                liveLayer.classList.add('horizon-layer-drag-over');
            });
            liveLayer.addEventListener('dragleave', (e) => {
                e.stopPropagation();
                liveLayer.classList.remove('horizon-layer-drag-over');
            });
            liveLayer.addEventListener('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                liveLayer.classList.remove('horizon-layer-drag-over');

                // Resolve item ID from segment drag or action drag
                let itemId;
                if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                    itemId = Number(e.dataTransfer.getData('application/x-segment-item-id'));
                } else {
                    const dragIds = getMultiDragIds(e);
                    if (dragIds.length === 0) return;
                    itemId = dragIds[0]; // Start working on the first item
                }
                if (!itemId) return;

                const item = findItemById(itemId);
                if (!item) return;

                const ancestors = getAncestorPath(itemId);
                const projectName = (ancestors && ancestors.length > 0) ? ancestors[0].name : '';

                await startWorking(itemId, item.name, projectName);
            });
        }
        const stopBtn = document.getElementById('live-layer-stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (state.workingOn) await stopWorking();
                else if (state.onBreak) await stopBreak();
            });
        }
        const nextBtn = document.getElementById('live-layer-next-btn');
        if (nextBtn) {
            nextBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!state.workingOn || state.focusQueue.length === 0) return;
                state._suppressQueueAdvance = true;
                await stopWorking();
                state._suppressQueueAdvance = false;
                if (state.focusQueue.length > 0) {
                    await advanceQueue();
                }
            });
        }
        const pauseBtn = document.getElementById('live-layer-pause-btn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!state.workingOn || state.focusQueue.length === 0) return;
                await pauseWorking();
            });
        }
    });
})();


// ── Live Indicator DnD Helper ──
// Attaches dragover/dragleave/drop listeners to a live-indicator element.
// liveType: 'work' | 'break' | 'idle'
function _attachLiveIndicatorDnD(indicator, liveType) {
    indicator.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
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
        const isCopy = _isDragCopy(e);

        // Resolve item ID from either drag source
        let itemId;
        let segCtx;
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            itemId = e.dataTransfer.getData('application/x-segment-item-id');
            segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            // Strip old segment context before re-assigning (move only)
            if (!isCopy && segCtx) {
                await removeSourceContext(Number(itemId), segCtx);
            }
        } else {
            // Regular action drag (multi-select aware)
            const dragIds = getMultiDragIds(e);
            if (dragIds.length === 0) return;
            const sourceCtx = e.dataTransfer.getData('application/x-source-context');
            for (const itemId of dragIds) {
                const item = findItemById(itemId);
                const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
                if (!isCopy && sourceCtx) { await removeSourceContext(itemId, sourceCtx); }

                // Queue-aware drop: if working or queue active, add to queue instead
                if ((state.workingOn || state.focusQueue.length > 0) && liveType !== 'idle') {
                    addToQueue(Number(itemId));
                } else if (liveType === 'idle') {
                    // Start working retroactively from idle start
                    const item = findItemById(itemId);
                    if (item) {
                        const ancestors = getAncestorPath(itemId);
                        const projectName = (ancestors && ancestors.length > 0) ? ancestors[0].name : '';
                        await startWorking(Number(itemId), item.name, projectName, null, _getIdleStartMs());
                    }
                } else {
                    await addSegmentContext(itemId, `${todayKey}@${liveType}`, srcDur || undefined, { move: false });
                    // Move item under the active project when dropping onto work indicator
                    if (liveType === 'work' && state.workingOn && state.workingOn.itemId) {
                        const ancestors = getAncestorPath(state.workingOn.itemId);
                        const projectId = (ancestors && ancestors.length > 0) ? ancestors[0].id : state.workingOn.itemId;
                        const itemAncestors = getAncestorPath(itemId);
                        const itemProjectId = (itemAncestors && itemAncestors.length > 0) ? itemAncestors[0].id : null;
                        if (itemProjectId !== projectId) {
                            moveItem(itemId, { id: projectId, position: 'inside' });
                            await api.put('/items', state.items);
                        }
                    }
                }
            }
            clearActionSelection();
        }
    });
}

// ── Live Session Indicator ("Ground") ──
// Shows a compact clickable bar at the top of the Actions area when a
// work/break session is running. Clicking it navigates to the session
// AND focuses the related project.
let _liveIndicatorFingerprint = null;
function _renderLiveSessionIndicator() {
    // Skip full rebuild if live state hasn't changed
    const fp = `${!!state.workingOn}|${!!state.onBreak}|${state.workingOn?.itemId || ''}|${state.focusQueue.length}|${state.workingOn?.startTime || state.onBreak?.startTime || ''}|${state.workingOn?.targetEndTime || state.onBreak?.targetEndTime || ''}`;
    const liveSlot = document.getElementById('header-live-slot');
    if (!liveSlot) return;
    if (fp === _liveIndicatorFingerprint && liveSlot.children.length > 0) return;
    _liveIndicatorFingerprint = fp;

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



        const elapsed = Math.max(0, nowMs - idleStartMs);

        const indicator = document.createElement('div');
        indicator.className = 'live-session-indicator live-session-indicator-idle';
        indicator.style.cursor = 'pointer';
        indicator.title = 'Click to view current idle time';

        const hasQueue = state.focusQueue.length > 0;

        const icon = document.createElement('span');
        icon.className = 'live-session-indicator-icon';
        icon.textContent = hasQueue ? '📋' : '💤';

        const label = document.createElement('span');
        label.className = 'live-session-indicator-label';
        label.textContent = hasQueue ? `Queue (${state.focusQueue.length})` : 'Idle';

        const timer = document.createElement('span');
        timer.className = 'live-session-indicator-timer';
        timer.dataset.sessionStart = idleStartMs;
        timer.textContent = _fmtHMS(elapsed);

        indicator.appendChild(icon);
        indicator.appendChild(label);
        indicator.appendChild(timer);

        // Click: focus the live horizon layer
        indicator.addEventListener('click', () => {
            state.timelineViewDate = getLogicalToday();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            toggleLiveFocus();
        });

        // DnD: drop onto idle → schedule to today
        _attachLiveIndicatorDnD(indicator, 'idle');

        // Divergence badge: show ⚡ if unresolved divergences exist
        _appendDivergenceBadge(indicator);

        // Start button — start working retroactively from idle start
        const _startBtn = document.createElement('button');
        _startBtn.className = 'live-queue-all-btn live-start-btn';
        _startBtn.textContent = '▶ Start';
        _startBtn.title = 'Start working — retroactive from idle start';
        _startBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Open the picker in-place — use the indicator as anchor
            openIdleStartPicker(indicator, idleStartMs);
        });
        indicator.appendChild(_startBtn);

        // Queue All button — visible on hover (moved from input row)
        const _queueAllBtn = document.createElement('button');
        _queueAllBtn.className = 'live-queue-all-btn';
        _queueAllBtn.textContent = '▶ Queue All';
        _queueAllBtn.title = 'Add all visible actions to queue';
        _queueAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const actions = getFilteredActions().filter(a => !a.done);
            if (actions.length >= 2) {
                actions.forEach(a => addToQueue(a.id));
                renderAll();
            }
        });
        indicator.appendChild(_queueAllBtn);

        liveSlot.appendChild(indicator);
        return;
    }

    const isWork = !!state.workingOn;


    const nowMs = Date.now();
    const startMs = liveSession.startTime;
    const elapsed = Math.max(0, nowMs - startMs);

    const _fmtDur = _fmtHMS;

    const indicator = document.createElement('div');
    indicator.className = `live-session-indicator live-session-indicator-${isWork ? 'work' : 'break'}`;
    indicator.style.cursor = 'pointer';
    indicator.title = 'Click to return to running session';

    // Icon
    const icon = document.createElement('span');
    icon.className = 'live-session-indicator-icon';
    icon.textContent = isWork ? '🔥' : '☕';

    // Label (with queue badge if active)
    const label = document.createElement('span');
    label.className = 'live-session-indicator-label';
    let labelText = isWork ? (state.workingOn.itemName || 'Working') : 'Break';
    if (state.focusQueue.length > 0) {
        labelText += ` · +${state.focusQueue.length}`;
    }
    label.textContent = labelText;

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

    // Next button — visible on hover when queue has items (work only)
    if (isWork && state.focusQueue.length > 0) {
        const nextBtn = document.createElement('button');
        nextBtn.className = 'live-session-stop-btn live-session-next-btn';
        nextBtn.textContent = '⏭';
        nextBtn.title = `Next: ${state.focusQueue[0].type === 'break' ? 'Break' : state.focusQueue[0].itemName}`;
        nextBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            state._suppressQueueAdvance = true;
            await stopWorking();
            state._suppressQueueAdvance = false;
            if (state.focusQueue.length > 0) {
                await advanceQueue();
            }
        });
        indicator.appendChild(nextBtn);
    }

    // Pause button — visible on hover when queue has items (work only)
    if (isWork && state.focusQueue.length > 0) {
        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'live-session-stop-btn live-session-pause-btn';
        pauseBtn.textContent = '⏸';
        pauseBtn.title = 'Pause this item & start the next one';
        pauseBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await pauseWorking();
        });
        indicator.appendChild(pauseBtn);
    }

    // Queue All button — visible on hover (same as idle indicator)
    const _queueAllBtn2 = document.createElement('button');
    _queueAllBtn2.className = 'live-queue-all-btn';
    _queueAllBtn2.textContent = '▶ Queue All';
    _queueAllBtn2.title = 'Add all visible actions to queue';
    _queueAllBtn2.addEventListener('click', (e) => {
        e.stopPropagation();
        const actions = getFilteredActions().filter(a => !a.done);
        if (actions.length >= 2) {
            actions.forEach(a => addToQueue(a.id));
            renderAll();
        }
    });
    indicator.appendChild(_queueAllBtn2);



    // Click: navigate to today + focus the live horizon + select project
    indicator.addEventListener('click', () => {
        // 1. Navigate to today
        state.timelineViewDate = getLogicalToday();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        // 2. Focus the related project in the sidebar
        if (isWork && state.workingOn.itemId) {
            const ancestors = getAncestorPath(state.workingOn.itemId);
            const projectId = (ancestors && ancestors.length > 0) ? ancestors[0].id : state.workingOn.itemId;
            state.selectedItemId = projectId;
            savePref('selectedItemId', projectId);
        }
        // 3. Focus the live horizon layer
        toggleLiveFocus();
        // 4. Scroll to & highlight the project in the sidebar tree
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
    const _fmtDur = _fmtHMS;

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
            animateLayerTransition('up', () => {
                state.timelineViewDate = new Date(dayDate);
                savePref('timelineViewDate', state.timelineViewDate.toISOString());
                state.viewHorizon = 'day';
                savePref('viewHorizon', 'day');
                clearFocusStack();
                state._animateActions = true;
                renderAll();
            });
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
                _showAllHorizonLayers();
            });
            pin.addEventListener('dragend', () => { pin.classList.remove('week-item-dragging'); _restoreHorizonLayers(); });

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
                e.dataTransfer.setData('application/x-drag-source', 'timeline');
                e.dataTransfer.setData('application/x-source-context', getWeekKey(new Date(dateKey + 'T00:00:00')));
                e.dataTransfer.effectAllowed = 'move';
                chip.classList.add('week-item-dragging');
                window._draggedAction = true;
                _showAllHorizonLayers();
            });
            chip.addEventListener('dragend', () => {
                chip.classList.remove('week-item-dragging');
                window._draggedAction = false;
                _restoreHorizonLayers();
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
                const isCopy = _isDragCopy(e);
                if (!isCopy) {
                    const segItem = findItemById(Number(segItemId));
                    const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
                    if (segCtx) {
                        await removeSourceContext(Number(segItemId), segCtx);
                    }
                    await addTimeContext(Number(segItemId), dateKey, segSrcDur || undefined);
                } else {
                    await addTimeContext(Number(segItemId), dateKey);
                }
                return;
            }

            // Regular action item (multi-select aware)
            const isCopy2 = _isDragCopy(e);
            const dragIds = getMultiDragIds(e);
            const sourceCtx = e.dataTransfer.getData('application/x-source-context');
            for (const id of dragIds) {
                const item = findItemById(id);
                const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
                if (!isCopy2 && sourceCtx) { await removeSourceContext(id, sourceCtx); }
                await addTimeContext(id, dateKey, srcDur || undefined);
            }
            if (dragIds.length > 0) clearActionSelection();
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

// ── Month View: week cards with day pips ──
function renderMonthView(container) {
    const monthKey = getMonthKey(state.timelineViewDate);
    const monthRange = getMonthDateRange(monthKey);
    if (!monthRange) return;

    const el = document.createElement('div');
    el.className = 'month-view';

    const ms = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayAbbrev = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const wsd = state.settings.weekStartDay ?? 0;
    const today = getLogicalToday();
    const todayKey = getDateKey(today);
    const currentWeekKey = getWeekKey(today);
    const hidePast = isPastHidden();
    const allItems = collectAllItems(state.items.items).filter(it => !it.deleted && (!state.showDone ? !it.done : true));

    // Helper: collect all items touching a week (week-level context, any day-level context within range, or session/entry-level context)
    function getWeekAllItems(weekKey, weekStartDate, weekEndDate) {
        const wkItems = [];
        const seen = new Set();
        for (const it of allItems) {
            if (seen.has(it.id)) continue;
            const tcs = it.timeContexts || [];
            for (const tc of tcs) {
                if (tc === weekKey) { seen.add(it.id); wkItems.push(it); break; }
                // Day-level: "YYYY-MM-DD" or "YYYY-MM-DD@..."
                const dayMatch = tc.match(/^(\d{4}-\d{2}-\d{2})/);
                if (dayMatch) {
                    const d = new Date(dayMatch[1] + 'T12:00:00');
                    if (d >= weekStartDate && d <= weekEndDate) { seen.add(it.id); wkItems.push(it); break; }
                }
            }
        }
        return wkItems;
    }

    // Helper: aggregate total estimated minutes from contextDurations for contexts within a week range
    function aggregateWeekDuration(items, weekStartDate, weekEndDate, weekKey) {
        let totalMins = 0;
        for (const it of items) {
            const cd = it.contextDurations || {};
            for (const [ctx, dur] of Object.entries(cd)) {
                // Match if context is the week key itself
                if (ctx === weekKey) { totalMins += dur; continue; }
                // Match if context is a day within this week
                const dayMatch = ctx.match(/^(\d{4}-\d{2}-\d{2})/);
                if (dayMatch) {
                    const d = new Date(dayMatch[1] + 'T12:00:00');
                    if (d >= weekStartDate && d <= weekEndDate) { totalMins += dur; }
                }
            }
        }
        return totalMins;
    }

    // Compute available capacity per week: sum of each day's capacity
    function weekCapacityMins(weekStartDate) {
        let total = 0;
        for (let d = 0; d < 7; d++) {
            const dayDate = new Date(weekStartDate);
            dayDate.setDate(weekStartDate.getDate() + d);
            const times = getEffectiveDayTimes(dayDate);
            let dayMins = (times.dayEndHour * 60 + times.dayEndMinute) - (times.dayStartHour * 60 + times.dayStartMinute);
            if (dayMins <= 0) dayMins += 24 * 60; // cross-midnight
            total += dayMins;
        }
        return total;
    }

    // Enumerate weeks in this logical month
    let weekStart = new Date(monthRange.start);
    let weekNumber = 1;
    while (weekStart <= monthRange.end) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        const weekKey = getWeekKey(weekStart);

        const isPast = weekEnd < today && weekKey !== currentWeekKey;
        const isCurrent = weekKey === currentWeekKey;

        // Past-filter: skip past weeks entirely when past is hidden
        if (isPast && hidePast) {
            weekStart = new Date(weekStart);
            weekStart.setDate(weekStart.getDate() + 7);
            weekNumber++;
            continue;
        }

        // Collect all items touching this week (week-level + day-level)
        const weekItems = getWeekAllItems(weekKey, weekStart, weekEnd);
        const itemCount = weekItems.length;

        // Aggregate durations for capacity bar
        const totalEstMins = aggregateWeekDuration(weekItems, weekStart, weekEnd, weekKey);
        const capMins = weekCapacityMins(weekStart);

        // Group items by root ancestor for project summary
        const projectGroups = {};
        for (const item of weekItems) {
            let root = item;
            while (root.parent) {
                const p = findItemById(root.parent);
                if (!p) break;
                root = p;
            }
            const rootName = root.name || 'Uncategorized';
            if (!projectGroups[rootName]) projectGroups[rootName] = 0;
            projectGroups[rootName]++;
        }

        // Format week header with week number
        const startMonth = ms[weekStart.getMonth()];
        const endMonth = ms[weekEnd.getMonth()];
        const rangeLabel = startMonth === endMonth
            ? `${startMonth} ${weekStart.getDate()}–${weekEnd.getDate()}`
            : `${startMonth} ${weekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}`;

        const card = document.createElement('div');
        card.className = 'month-week-card';
        card.dataset.weekKey = weekKey;
        if (isCurrent) card.classList.add('month-week-card-current');
        if (isPast) card.classList.add('month-week-card-past');

        // Determine default expand state: current week expanded, others collapsed
        const isExpanded = isCurrent;

        // Header with toggle arrow and week number
        const header = document.createElement('div');
        header.className = 'month-week-header';

        const toggle = document.createElement('span');
        toggle.className = 'month-week-toggle';
        toggle.textContent = isExpanded ? '▾' : '▸';

        const rangeSpan = document.createElement('span');
        rangeSpan.className = 'month-week-range';
        rangeSpan.textContent = `Week ${weekNumber} · ${rangeLabel}`;
        rangeSpan.title = 'Click to drill into this week';

        header.appendChild(toggle);
        header.appendChild(rangeSpan);
        if (isCurrent) {
            const nowBadge = document.createElement('span');
            nowBadge.className = 'month-week-now';
            nowBadge.textContent = 'This Week';
            header.appendChild(nowBadge);
        }
        const countSpan = document.createElement('span');
        countSpan.className = 'month-week-count';
        countSpan.textContent = `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
        header.appendChild(countSpan);

        card.appendChild(header);

        // Collapsible content wrapper (day pips + project summary)
        const content = document.createElement('div');
        content.className = 'month-week-content';
        if (!isExpanded) content.style.display = 'none';

        // Day pip strip
        const strip = document.createElement('div');
        strip.className = 'month-day-strip';
        for (let d = 0; d < 7; d++) {
            const dayDate = new Date(weekStart);
            dayDate.setDate(weekStart.getDate() + d);
            const dayKey = getDateKey(dayDate);
            const dow = dayDate.getDay();

            // Count items on this specific day
            const dayItems = allItems.filter(it => {
                const tcs = it.timeContexts || [];
                return tcs.some(tc => tc === dayKey || tc.startsWith(dayKey + '@'));
            });

            const pip = document.createElement('div');
            pip.className = 'month-day-pip';
            pip.title = `${dayAbbrev[dow]} ${ms[dayDate.getMonth()]} ${dayDate.getDate()} — ${dayItems.length} item${dayItems.length !== 1 ? 's' : ''}`;

            if (dayKey === todayKey) pip.classList.add('month-day-pip-today');
            if (dayDate < today && dayKey !== todayKey) pip.classList.add('month-day-pip-past');
            if (dayItems.length > 0) {
                pip.classList.add('month-day-pip-filled');
                if (dayItems.length >= 7) pip.classList.add('month-day-pip-high');
                else if (dayItems.length >= 4) pip.classList.add('month-day-pip-mid');
            }

            // Day abbreviation label
            const label = document.createElement('span');
            label.className = 'month-day-pip-label';
            label.textContent = dayAbbrev[dow];
            pip.appendChild(label);

            // Click pip → day view (zoom in)
            pip.addEventListener('click', (e) => {
                e.stopPropagation();
                animateLayerTransition('up', () => {
                    state.timelineViewDate = new Date(dayDate);
                    clearFocusStack();
                    state.viewHorizon = 'day';
                    savePref('viewHorizon', 'day');
                    savePref('timelineViewDate', state.timelineViewDate.toISOString());
                    state._animateActions = true;
                    renderAll();
                });
            });

            strip.appendChild(pip);
        }
        content.appendChild(strip);

        // Project summary (inline, truncated to top 3 + "+N more")
        if (Object.keys(projectGroups).length > 0) {
            const projSummary = document.createElement('div');
            projSummary.className = 'month-week-projects';
            const sortedProjects = Object.entries(projectGroups).sort((a, b) => b[1] - a[1]);
            const MAX_PROJECTS = 4;
            const shown = sortedProjects.slice(0, MAX_PROJECTS);
            const remaining = sortedProjects.length - shown.length;
            let text = shown.map(([name, count]) => `${name} (${count})`).join(' · ');
            if (remaining > 0) text += ` · +${remaining} more`;
            projSummary.textContent = text;
            content.appendChild(projSummary);
        }

        card.appendChild(content);

        // Capacity / progress bar — always visible (below content when expanded, below header when collapsed)
        if (totalEstMins > 0 || itemCount > 0) {
            const capBar = document.createElement('div');
            capBar.className = 'segment-capacity-bar month-week-progress';
            const availMins = Math.max(1, capMins);
            const fillPct = Math.min(100, (totalEstMins / availMins) * 100);
            const isOver = totalEstMins > availMins;
            const hrsLabel = totalEstMins >= 60
                ? `${Math.floor(totalEstMins / 60)}h${totalEstMins % 60 ? totalEstMins % 60 + 'm' : ''}`
                : `${totalEstMins}m`;
            const availLabel = capMins >= 60
                ? `${Math.floor(capMins / 60)}h`
                : `${capMins}m`;
            capBar.innerHTML = `
                <span class="segment-capacity-label">${hrsLabel} / ${availLabel}</span>
                <div class="segment-capacity-track"><div class="segment-capacity-fill${isOver ? ' over-capacity' : ''}" style="width:${fillPct}%"></div></div>
            `;
            card.appendChild(capBar);
        }

        // Toggle collapse/expand on header click (but drill-down on range label click)
        header.addEventListener('click', (e) => {
            e.stopPropagation();
            const isCurrentlyVisible = content.style.display !== 'none';
            content.style.display = isCurrentlyVisible ? 'none' : '';
            toggle.textContent = isCurrentlyVisible ? '▸' : '▾';
        });

        // Drill-down on range label click → go to week view (zoom in)
        rangeSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            animateLayerTransition('up', () => {
                const range = getWeekDateRange(weekKey);
                if (range) state.timelineViewDate = range.start;
                clearFocusStack();
                state.viewHorizon = 'week';
                savePref('viewHorizon', 'week');
                state._animateActions = true;
                renderAll();
            });
        });

        // DnD: week card as drop target
        card.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            card.classList.add('month-week-drag-over');
        });
        card.addEventListener('dragleave', () => {
            card.classList.remove('month-week-drag-over');
        });
        card.addEventListener('drop', async (e) => {
            e.preventDefault();
            card.classList.remove('month-week-drag-over');
            const targetWeekKey = weekKey;
            // Segment queue item drag
            if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                const segCtx = e.dataTransfer.getData('application/x-segment-context');
                if (!itemId) return;
                const isCopy = _isDragCopy(e);
                const segItem = findItemById(Number(itemId));
                const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
                if (!isCopy && segCtx) {
                    await removeSourceContext(Number(itemId), segCtx);
                }
                await addTimeContext(parseInt(itemId, 10), targetWeekKey, segSrcDur || undefined);
                return;
            }
            // Regular action/project drag (multi-select aware)
            const dragIds = getMultiDragIds(e);
            const sourceCtx = e.dataTransfer.getData('application/x-source-context');
            for (const id of dragIds) {
                const item = findItemById(id);
                const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
                if (!_isDragCopy(e) && sourceCtx) { await removeSourceContext(id, sourceCtx); }
                await addTimeContext(id, targetWeekKey, srcDur || undefined);
            }
            if (dragIds.length > 0) clearActionSelection();
        });

        el.appendChild(card);

        // Advance to next week
        weekStart = new Date(weekStart);
        weekStart.setDate(weekStart.getDate() + 7);
        weekNumber++;
    }

    container.appendChild(el);
    updateDateNav();
}

function renderTimeline() {
    const container = document.getElementById('timeline-list');
    const savedScrollTop = container.scrollTop;
    const empty = document.getElementById('timeline-empty');
    const quickLog = document.querySelector('.quick-log');

    // Clear all rendered blocks (including breadcrumb)
    container.querySelectorAll('.time-block, .timeline-entry, .epoch-placeholder, .epoch-week-overview, .month-view, .week-view, .session-panel, .live-panel, .week-sleep-divider, .divergence-prompt, .divergence-banner, .compact-past-entry, .compact-project-wrapper').forEach(el => el.remove());

    // ── Month horizon: show month view with week cards + day pips ──
    if (state.viewHorizon === 'month') {
        empty.style.display = 'none';
        if (quickLog) quickLog.style.display = 'none';
        container.querySelectorAll('.month-view').forEach(el => el.remove());
        renderMonthView(container);
        return;
    }

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

    // ── Live horizon: replace timeline with live activity panel ──
    if (state.viewHorizon === 'live') {
        empty.style.display = 'none';
        if (quickLog) quickLog.style.display = 'none';
        container.querySelectorAll('.live-panel').forEach(el => el.remove());

        const panel = document.createElement('div');
        panel.className = 'live-panel';

        const nowMs = Date.now();
        const _fmtDur = _fmtHMS;

        if (state.workingOn) {
            // ── Working state ──
            const icon = '🔥';
            const itemName = state.workingOn.itemName || 'Working';
            const elapsed = nowMs - state.workingOn.startTime;

            // Header
            const header = document.createElement('div');
            header.className = 'live-panel-header live-panel-work';
            header.innerHTML = `<span class="live-panel-icon">${icon}</span> <span class="live-panel-title">${itemName}</span>`;
            panel.appendChild(header);

            // Timer row
            const timerRow = document.createElement('div');
            timerRow.className = 'live-panel-timer-row';
            timerRow.id = 'live-panel-timer';
            timerRow.dataset.sessionStart = String(state.workingOn.startTime);
            if (state.workingOn.targetEndTime) timerRow.dataset.targetEnd = String(state.workingOn.targetEndTime);
            if (state.workingOn.targetEndTime) {
                const rem = state.workingOn.targetEndTime - nowMs;
                if (rem > 0) {
                    timerRow.textContent = `⏱️ ${_fmtDur(rem)} remaining`;
                } else {
                    timerRow.textContent = `⏱️ +${_fmtDur(Math.abs(rem))} overtime`;
                    timerRow.classList.add('live-panel-overtime');
                }
            } else {
                timerRow.textContent = `⏱️ ${_fmtDur(elapsed)} elapsed`;
            }
            panel.appendChild(timerRow);

            // Ancestor path
            const item = findItemById(state.workingOn.itemId);
            if (item) {
                const path = getAncestorPath(item.id);
                if (path && path.length > 0) {
                    const pathRow = document.createElement('div');
                    pathRow.className = 'live-panel-path';
                    pathRow.textContent = '📂 ' + path.map(a => a.name).join(' › ');
                    panel.appendChild(pathRow);
                }
            }

            // Action buttons row
            const stopRow = document.createElement('div');
            stopRow.className = 'live-panel-actions';

            // Stop Session — ends the session entirely, no queue advance (with confirmation)
            const stopBtn = document.createElement('button');
            stopBtn.className = 'live-panel-stop-btn';
            stopBtn.textContent = '⏹ Stop Session';
            stopBtn.title = 'End session completely';
            stopBtn.addEventListener('click', async () => {
                if (!confirm('Stop the entire queue session?')) return;
                state._suppressQueueAdvance = true;
                await stopWorking();
                state._suppressQueueAdvance = false;
                renderAll();
            });
            stopRow.appendChild(stopBtn);

            // Next — finish current item, advance to next (only when queue has items)
            if (state.focusQueue.length > 0) {
                const nextBtn = document.createElement('button');
                nextBtn.className = 'live-panel-next-btn';
                nextBtn.textContent = '⏭ Next';
                nextBtn.title = `Start: ${state.focusQueue[0].itemName}`;
                nextBtn.addEventListener('click', async () => {
                    state._suppressQueueAdvance = true;
                    await stopWorking();
                    state._suppressQueueAdvance = false;
                    if (state.focusQueue.length > 0) {
                        await advanceQueue();
                    }
                });
                stopRow.appendChild(nextBtn);
            }

            // Pause — re-insert current after next, then advance (only when queue has items)
            if (state.focusQueue.length > 0) {
                const pauseBtn = document.createElement('button');
                pauseBtn.className = 'live-panel-stop-btn';
                pauseBtn.textContent = '⏸ Pause';
                pauseBtn.title = 'Pause this item & start the next one';
                pauseBtn.addEventListener('click', () => pauseWorking());
                stopRow.appendChild(pauseBtn);
            }
            panel.appendChild(stopRow);

            // Queue section
            _renderQueueSection(panel);

        } else if (state.onBreak) {
            // ── Break state ──
            const elapsed = nowMs - state.onBreak.startTime;

            const header = document.createElement('div');
            header.className = 'live-panel-header live-panel-break';
            header.innerHTML = `<span class="live-panel-icon">☕</span> <span class="live-panel-title">Break</span>`;
            panel.appendChild(header);

            const timerRow = document.createElement('div');
            timerRow.className = 'live-panel-timer-row';
            timerRow.id = 'live-panel-timer';
            timerRow.dataset.sessionStart = String(state.onBreak.startTime);
            if (state.onBreak.targetEndTime) timerRow.dataset.targetEnd = String(state.onBreak.targetEndTime);
            if (state.onBreak.targetEndTime) {
                const rem = state.onBreak.targetEndTime - nowMs;
                if (rem > 0) {
                    timerRow.textContent = `⏱️ ${_fmtDur(rem)} remaining`;
                } else {
                    timerRow.textContent = `⏱️ +${_fmtDur(Math.abs(rem))} overtime`;
                    timerRow.classList.add('live-panel-overtime');
                }
            } else {
                timerRow.textContent = `⏱️ ${_fmtDur(elapsed)} elapsed`;
            }
            panel.appendChild(timerRow);

            // Show pending next item info if this break was triggered by queue
            if (state._queuePendingAfterBreak) {
                const nextInfo = document.createElement('div');
                nextInfo.className = 'live-panel-path';
                nextInfo.textContent = `⏭ Up next: ${state._queuePendingAfterBreak.itemName}`;
                panel.appendChild(nextInfo);
            }

            const stopRow = document.createElement('div');
            stopRow.className = 'live-panel-actions';
            const stopBtn = document.createElement('button');
            stopBtn.className = 'live-panel-stop-btn';
            stopBtn.textContent = '⏹ End Break';
            stopBtn.addEventListener('click', () => stopBreak());
            stopRow.appendChild(stopBtn);
            panel.appendChild(stopRow);

            // Queue section
            _renderQueueSection(panel);

        } else if (isInSleepRange()) {
            // ── Sleep state ──
            const header = document.createElement('div');
            header.className = 'live-panel-header live-panel-sleep';
            header.innerHTML = `<span class="live-panel-icon">🌙</span> <span class="live-panel-title">Sleep</span>`;
            panel.appendChild(header);

            const msg = document.createElement('div');
            msg.className = 'live-panel-message';
            msg.textContent = 'Outside work hours.';
            panel.appendChild(msg);

        } else {
            // ── Idle state ──
            const header = document.createElement('div');
            header.className = 'live-panel-header live-panel-idle';
            header.innerHTML = `<span class="live-panel-icon">💤</span> <span class="live-panel-title">Idle</span>`;
            panel.appendChild(header);

            // "What have you been doing?" quick-pick — retroactive start
            const idleStartMs = _getIdleStartMs();
            const startPickerSection = document.createElement('div');
            startPickerSection.className = 'live-panel-start-picker-section';

            const pickerLabel = document.createElement('div');
            pickerLabel.className = 'live-panel-picker-label';
            pickerLabel.textContent = 'What have you been doing?';
            startPickerSection.appendChild(pickerLabel);

            const pickerInputWrap = document.createElement('div');
            pickerInputWrap.className = 'plan-editor-autocomplete live-panel-autocomplete';

            const pickerInput = document.createElement('input');
            pickerInput.type = 'text';
            pickerInput.className = 'plan-editor-input';
            pickerInput.placeholder = 'Search items...';

            const pickerSuggestions = document.createElement('div');
            pickerSuggestions.className = 'plan-editor-suggestions';

            pickerInputWrap.appendChild(pickerInput);
            pickerInputWrap.appendChild(pickerSuggestions);
            startPickerSection.appendChild(pickerInputWrap);
            panel.appendChild(startPickerSection);

            // Wire autocomplete after DOM insertion
            setTimeout(() => {
                const autocomplete = setupAutocomplete(pickerInput, pickerSuggestions, {
                    onSelect: async (item) => {
                        const ancestors = getAncestorPath(item.id);
                        const projectName = (ancestors && ancestors.length > 0) ? ancestors[0].name : '';
                        await startWorking(item.id, item.name, projectName, null, idleStartMs);
                    },
                });
                pickerInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        const selected = autocomplete.getSelected();
                        if (selected) {
                            const ancestors = getAncestorPath(selected.id);
                            const projectName = (ancestors && ancestors.length > 0) ? ancestors[0].name : '';
                            startWorking(selected.id, selected.name, projectName, null, idleStartMs);
                        }
                    }
                });
            }, 0);

            if (state.focusQueue.length > 0) {
                // Queue is loaded but not started — show Start Session button
                const startRow = document.createElement('div');
                startRow.className = 'live-panel-actions';
                const startBtn = document.createElement('button');
                startBtn.className = 'live-panel-start-btn';
                startBtn.textContent = `▶ Start Session (${state.focusQueue.length} items)`;
                startBtn.addEventListener('click', async () => {
                    await advanceQueue();
                });
                startRow.appendChild(startBtn);
                panel.appendChild(startRow);

                // Queue section (shows items but no Next button since not working)
                _renderQueueSection(panel);
            } else {
                const msg = document.createElement('div');
                msg.className = 'live-panel-message';
                msg.textContent = 'No active work or break session.';
                panel.appendChild(msg);
            }
        }

        container.appendChild(panel);
        return;
    }

    // Render the queue list section inside the live panel
    function _renderQueueSection(panel) {
        if (state.focusQueue.length === 0) return;

        // ── Queue Header ──
        const qHeader = document.createElement('div');
        qHeader.className = 'live-queue-header';
        const qTitle = document.createElement('span');
        qTitle.className = 'live-queue-title';
        // Show progress if currently working
        if (state.workingOn) {
            // Find how many items total (completed = items that were before current in original queue)
            qTitle.textContent = `Up Next (${state.focusQueue.length})`;
        } else {
            qTitle.textContent = `Queue (${state.focusQueue.length})`;
        }
        qHeader.appendChild(qTitle);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'live-queue-clear-btn';
        clearBtn.textContent = '✕ Clear';
        clearBtn.addEventListener('click', () => {
            clearQueue();
            renderAll();
        });
        qHeader.appendChild(clearBtn);
        panel.appendChild(qHeader);

        // ── Queue List ──
        const qList = document.createElement('div');
        qList.className = 'live-queue-list';

        state.focusQueue.forEach((qItem, idx) => {
            const isBreak = qItem.type === 'break';
            const row = document.createElement('div');
            row.className = 'live-queue-item' + (isBreak ? ' queue-break-item' : '');
            row.draggable = true;
            row.dataset.queueIndex = idx;

            // Drag handle
            const handle = document.createElement('span');
            handle.className = 'queue-drag-handle';
            handle.textContent = '☰';
            row.appendChild(handle);

            // Index number
            const num = document.createElement('span');
            num.className = 'queue-item-number';
            num.textContent = `${idx + 1}.`;
            row.appendChild(num);

            if (isBreak) {
                // ── Break item ──
                const name = document.createElement('span');
                name.className = 'queue-item-name';
                name.textContent = '☕ Break';
                row.appendChild(name);

                // Editable duration badge for break
                const durationMs = qItem.durationMs || 0;
                const badge = document.createElement('span');
                badge.className = 'queue-item-duration';
                badge.style.cursor = 'pointer';
                badge.title = 'Click to set break duration';
                const _fmtBDur = (ms) => {
                    if (!ms) return '5m';
                    const m = Math.round(ms / 60000);
                    return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`;
                };
                badge.textContent = _fmtBDur(durationMs);
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (badge.querySelector('input')) return;
                    const curMins = durationMs ? Math.round(durationMs / 60000) : '';
                    badge.textContent = '';
                    const inp = document.createElement('input');
                    inp.type = 'number';
                    inp.className = 'queue-duration-input';
                    inp.value = curMins;
                    inp.placeholder = 'min';
                    inp.min = '1';
                    inp.style.cssText = 'width:40px;font-size:10px;text-align:center;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;padding:1px 2px;font-family:inherit';
                    badge.appendChild(inp);
                    inp.focus();
                    inp.select();
                    const _commit = () => {
                        const mins = parseInt(inp.value, 10);
                        qItem.durationMs = (isNaN(mins) || mins <= 0) ? 300000 : mins * 60000;
                        savePref('focusQueue', state.focusQueue);
                        badge.textContent = _fmtBDur(qItem.durationMs);
                    };
                    inp.addEventListener('blur', _commit);
                    inp.addEventListener('keydown', (ke) => {
                        if (ke.key === 'Enter') { ke.preventDefault(); inp.blur(); }
                        if (ke.key === 'Escape') { ke.preventDefault(); badge.textContent = _fmtBDur(durationMs); }
                    });
                });
                row.appendChild(badge);
            } else {
                // ── Work item ──
                const name = document.createElement('span');
                name.className = 'queue-item-name';
                name.textContent = qItem.itemName;
                name.title = qItem.projectName ? `${qItem.projectName} › ${qItem.itemName}` : qItem.itemName;
                row.appendChild(name);

                // Duration badge (⏱ icon, click for inline input)
                const durationMs = qItem.durationMs || 0;
                const badge = document.createElement('span');
                badge.className = 'queue-item-duration';
                badge.style.cursor = 'pointer';
                badge.title = 'Click to set duration';
                const _fmtQDur = (ms) => {
                    if (!ms) return '⏱';
                    const s = Math.round(ms / 1000);
                    const m = Math.floor(s / 60);
                    const remainS = s % 60;
                    if (m >= 60) return `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}`;
                    if (remainS > 0 && m < 10) return `${m}m ${remainS}s`;
                    return `${m}m`;
                };
                badge.textContent = _fmtQDur(durationMs);
                if (!durationMs) badge.classList.add('no-estimate');
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (badge.querySelector('input')) return;
                    const curMins = durationMs ? Math.round(durationMs / 60000) : '';
                    badge.textContent = '';
                    const inp = document.createElement('input');
                    inp.type = 'number';
                    inp.className = 'queue-duration-input';
                    inp.value = curMins;
                    inp.placeholder = 'min';
                    inp.min = '0';
                    inp.style.cssText = 'width:40px;font-size:10px;text-align:center;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;padding:1px 2px;font-family:inherit';
                    badge.appendChild(inp);
                    inp.focus();
                    inp.select();
                    const _commit = () => {
                        const mins = parseInt(inp.value, 10);
                        qItem.durationMs = (isNaN(mins) || mins <= 0) ? 0 : mins * 60000;
                        savePref('focusQueue', state.focusQueue);
                        badge.textContent = _fmtQDur(qItem.durationMs);
                        if (!qItem.durationMs) badge.classList.add('no-estimate');
                        else badge.classList.remove('no-estimate');
                    };
                    inp.addEventListener('blur', _commit);
                    inp.addEventListener('keydown', (ke) => {
                        if (ke.key === 'Enter') { ke.preventDefault(); inp.blur(); }
                        if (ke.key === 'Escape') { ke.preventDefault(); badge.textContent = _fmtQDur(durationMs); }
                    });
                });
                row.appendChild(badge);

                // Skip-to button (only when working or on break) — pauses current item
                if (state.workingOn || state.onBreak) {
                    const skipBtn = document.createElement('button');
                    skipBtn.className = 'queue-skip-btn';
                    skipBtn.textContent = '▶';
                    skipBtn.title = 'Pause current & start this item';
                    skipBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        // Remove the target item from its current position first
                        const [promoted] = state.focusQueue.splice(idx, 1);
                        if (state.workingOn) {
                            // Pause current: calculate remaining, re-insert after promoted item
                            const cur = state.workingOn;
                            let remainingMs = 0;
                            if (cur.targetEndTime) {
                                remainingMs = Math.max(0, cur.targetEndTime - Date.now());
                            }
                            const entry = {
                                itemId: cur.itemId,
                                itemName: cur.itemName,
                                projectName: cur.projectName,
                                durationMs: remainingMs,
                            };
                            state._suppressQueueAdvance = true;
                            await stopWorking();
                            state._suppressQueueAdvance = false;
                            // Put promoted item at front, paused item right after it
                            state.focusQueue.unshift(entry);
                            state.focusQueue.unshift(promoted);
                        } else if (state.onBreak) {
                            state._queuePendingAfterBreak = null;
                            await stopBreak();
                            // Put promoted item at front of existing queue
                            state.focusQueue.unshift(promoted);
                        }
                        savePref('focusQueue', state.focusQueue);
                        if (state.focusQueue.length > 0) {
                            await advanceQueue();
                        }
                    });
                    row.appendChild(skipBtn);
                }
            }

            // Remove button (index-based, works for both work items and breaks)
            const rmBtn = document.createElement('button');
            rmBtn.className = 'queue-remove-btn';
            rmBtn.textContent = '✕';
            rmBtn.title = 'Remove from queue';
            rmBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeFromQueueByIndex(idx);
                renderAll();
            });
            row.appendChild(rmBtn);

            // ── Drag-and-drop reorder ──
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', String(idx));
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('queue-item-dragging');
                // For non-break items, also set action-id so horizon layers accept the drop
                if (!isBreak && qItem.itemId) {
                    e.dataTransfer.setData('application/x-action-id', String(qItem.itemId));
                    e.dataTransfer.setData('application/x-drag-source', 'queue');
                    e.dataTransfer.setData('application/x-source-context', ''); // no source context to remove
                    window._draggedAction = findItemById(qItem.itemId);
                    window._draggedActionIds = null;
                    document.body.classList.add('dragging-to-timeline');
                    _showAllHorizonLayers();
                }
            });
            row.addEventListener('dragend', (e) => {
                row.classList.remove('queue-item-dragging');
                // If dropped on a horizon layer (not queue reorder), remove from queue
                if (!isBreak && qItem.itemId && e.dataTransfer.dropEffect !== 'none' && !state._queueReorderDrop) {
                    const curIdx = state.focusQueue.indexOf(qItem);
                    if (curIdx !== -1) {
                        removeFromQueueByIndex(curIdx);
                        renderAll();
                    }
                }
                state._queueReorderDrop = false;
                // Restore horizon layers
                if (!isBreak && qItem.itemId) {
                    window._draggedAction = null;
                    document.body.classList.remove('dragging-to-timeline');
                    document.querySelectorAll('.horizon-layer-drag-over').forEach(el => el.classList.remove('horizon-layer-drag-over'));
                    _restoreHorizonLayers();
                }
            });
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                row.classList.add('queue-item-dragover');
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('queue-item-dragover');
            });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('queue-item-dragover');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                const toIdx = idx;
                if (fromIdx !== toIdx) {
                    state._queueReorderDrop = true; // flag so dragend doesn't remove item
                    reorderQueue(fromIdx, toIdx);
                    renderAll();
                }
            });

            qList.appendChild(row);
        });

        panel.appendChild(qList);

        // ── Add Break Button ──
        const addBreakRow = document.createElement('div');
        addBreakRow.className = 'live-queue-settings';
        const addBreakBtn = document.createElement('button');
        addBreakBtn.className = 'live-panel-stop-btn';
        addBreakBtn.textContent = '☕ Add Break';
        addBreakBtn.title = 'Add a break to the queue';
        addBreakBtn.addEventListener('click', () => {
            addBreakToQueue(5 * 60000); // default 5 min
            renderAll();
        });
        addBreakRow.appendChild(addBreakBtn);
        panel.appendChild(addBreakRow);
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
    const pushBoundary = Math.max(dayStart.getTime(), viewingToday ? nowMs : 0);
    const allDayEntries = state.timeline.entries
        .filter(e => (e.timestamp >= dayStart.getTime() || e.dynamicStart) && e.timestamp < dayEnd.getTime())
        .sort((a, b) => a.timestamp - b.timestamp) // chronological
        .map(e => {
            // Push flex (dynamic-start) entries forward past hard boundaries (dayStart, now)
            // Clone to avoid mutating the persisted state objects
            if (e.dynamicStart && pushBoundary > e.timestamp) {
                const origDuration = e.endTime - e.timestamp;
                return {
                    ...e, _origTimestamp: e.timestamp, _origEndTime: e.endTime,
                    timestamp: pushBoundary, endTime: pushBoundary + origDuration
                };
            }
            return e;
        })
        .sort((a, b) => a.timestamp - b.timestamp); // re-sort after push

    // (Phantom lead-time blocks removed — replaced by persistent buffer entries)

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
            fragment.appendChild(createIdleTimeBlock(idleStart, nowMs, true));
            cursor = Math.max(cursor, nowMs);
        }
    }

    // ── If no block entries before now and viewing today, idle/working from day start to now ──
    // Skip when hidePast already injected the idle/working block above
    if (!hidePast && viewingToday && !lastBlockBeforeNow && nowMs > dayStart.getTime() && nowMs < dayEndMs) {
        const firstBlock = dayBlockEntries[0];
        const idleEnd = firstBlock ? Math.min(nowMs, firstBlock.timestamp) : Math.min(nowMs, dayEndMs);

        // ── Insert marker: gap from day start to first block ──
        const dayStartMarker = createPastInsertMarker(dayStart.getTime(), idleEnd);
        if (dayStartMarker) fragment.appendChild(dayStartMarker);

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
                fragment.appendChild(createIdleTimeBlock(dayStart.getTime(), idleEnd, idleEnd >= nowMs));
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

            // ── Insert marker BEFORE first past entry (gap from cursor/dayStart to first entry) ──
            const firstMergedTs = merged.length > 0 ? (merged[0].timestamp || pastStart) : pastStart;
            const preMarker = createPastInsertMarker(cursor, firstMergedTs);
            if (preMarker) fragment.appendChild(preMarker);

            for (let mi = 0; mi < merged.length; mi++) {
                const m = merged[mi];
                if (m._isProjectGroup) {
                    fragment.appendChild(createCompactProjectGroup(m));
                } else {
                    fragment.appendChild(createCompactPastEntry(m));
                }

                // ── Insert marker BETWEEN entries (gap from this entry's end to next entry's start) ──
                const thisEnd = m.endTime || m.timestamp;
                const nextTs = (mi < merged.length - 1)
                    ? (merged[mi + 1].timestamp || merged[mi + 1].entries?.[0]?.timestamp || thisEnd)
                    : nowMs; // after last entry → gap to now
                const betweenMarker = createPastInsertMarker(thisEnd, nextTs);
                if (betweenMarker) fragment.appendChild(betweenMarker);
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

            // ── Insert marker for past gaps ──
            if (gapMs >= 60000 && gapEnd <= nowMs) {
                const gapMarker = createPastInsertMarker(cursor, gapEnd);
                if (gapMarker) fragment.appendChild(gapMarker);
            }

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
                    fragment.appendChild(createIdleTimeBlock(entryEnd, idleEnd, idleEnd >= nowMs));
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

    // ── Current session marker: highlight the block containing "now" ──
    if (viewingToday) {
        for (const block of fragment.querySelectorAll('.time-block')) {
            const s = parseInt(block.dataset.startTime, 10);
            const e = parseInt(block.dataset.endTime, 10);
            if (!isNaN(s) && !isNaN(e) && nowMs >= s && nowMs < e) {
                block.classList.add('time-block-current');
                break; // only one block can be current
            }
        }
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
    el.addEventListener('drop', async (e) => {
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

        // Normal drag from Actions panel (multi-select aware)
        const isCopy = _isDragCopy(e);
        const dragIds = getMultiDragIds(e);
        if (dragIds.length === 0) return;
        window._draggedAction = null;
        const sourceCtx = e.dataTransfer.getData('application/x-source-context');
        for (const id of dragIds) {
            const item = findItemById(id);
            const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
            if (!isCopy && sourceCtx) { await removeSourceContext(id, sourceCtx); }
            await addSegmentContext(id, newSegCtx, srcDur || undefined, { move: false });
        }
        clearActionSelection();
    });

    // ── Nested segment-assigned items ──
    const dateKey = getDateKey(state.timelineViewDate);
    const segCtx = buildSegmentContext(dateKey, startMs, endMs);
    const allItems = collectAllItems();
    const assignedItems = allItems.filter(a => {
        const item = findItemById(a.id);
        if (!item || !item.timeContexts) return false;
        if (item.done && !state.showDone) return false;
        return itemOverlapsSegment(item, segCtx, dateKey, startMs, endMs) !== null;
    });

    // (Phantom segment items removed — replaced by persistent buffer entries)

    if (assignedItems.length > 0) {
        const queue = document.createElement('div');
        queue.className = 'segment-queue';

        let totalEstMins = 0;

        // ── Regular assigned items ──
        for (const action of assignedItems) {
            const item = findItemById(action.id);
            // Find the item's actual stored segment context matching this block
            const itemSegCtx = itemOverlapsSegment(item, segCtx, dateKey, startMs, endMs) || segCtx;
            const estMins = getContextDuration(item, itemSegCtx);
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
                e.dataTransfer.setData('application/x-drag-source', 'timeline');
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('segment-item-dragging');
                document.body.classList.add('dragging-to-timeline');
                _showAllHorizonLayers();
            });
            row.addEventListener('dragend', () => {
                console.log('[SEG-DRAG] dragend fired');
                row.classList.remove('segment-item-dragging');
                document.body.classList.remove('dragging-to-timeline');
                _restoreHorizonLayers();
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
                const inv = computeTimeInvestment(item, itemSegCtx);
                const durMins = (inv && inv.budget > 0) ? Math.max(1, inv.remaining) : (estMins || 30);
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
                animateActionsZoomIn(() => {
                    state.selectedItemId = action.id;
                    savePref('selectedItemId', action.id);
                    state._animateActions = true;
                    renderAll();
                    requestAnimationFrame(() => scrollToSelectedItem());
                });
            });

            // Done button (toggle)
            const doneBtn = document.createElement('button');
            doneBtn.className = 'segment-queue-done';
            doneBtn.textContent = item?.done ? '↩' : '✓';
            doneBtn.title = item?.done ? 'Mark not done' : 'Mark done';
            doneBtn.draggable = false;
            doneBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const newDone = !item?.done;
                await api.patch(`/items/${action.id}`, { done: newDone });
                if (item) item.done = newDone;
                if (newDone) {
                    const anc = action._path
                        ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                        : '';
                    await api.post('/timeline', {
                        text: `Done: ${action.name}`,
                        projectName: anc || null,
                        type: 'completion'
                    });
                    state.timeline = await api.get('/timeline');
                }
                renderAll();
            });

            row.appendChild(bullet);
            row.appendChild(locateBtn);
            row.appendChild(nameSpan);
            row.appendChild(est);
            row.appendChild(doneBtn);
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
                <span class="segment-capacity-label">${_formatDuration(totalEstMins)} / ${_formatDuration(availMins)}</span>
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
    endInput.v