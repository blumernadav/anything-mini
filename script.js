// =====================================================
// Anything Mini — Client Script
// Keywords: simplicity, small wins
// Unified items tree: branches = projects, leaves = actions
// =====================================================

const API = '/api';
const CLIENT_ID = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
        const res = await fetch(`${API}${path}`, {
            headers: { 'X-Client-ID': CLIENT_ID },
        });
        return res.json();
    },
    async post(path, body) {
        const res = await fetch(`${API}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Client-ID': CLIENT_ID },
            body: JSON.stringify(body),
        });
        return res.json();
    },
    async patch(path, body) {
        const res = await fetch(`${API}${path}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Client-ID': CLIENT_ID },
            body: JSON.stringify(body),
        });
        return res.json();
    },
    async put(path, body) {
        const res = await fetch(`${API}${path}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Client-ID': CLIENT_ID },
            body: JSON.stringify(body),
        });
        if (res.status === 409) {
            const err = await res.json();
            const e = new Error(err.message || 'Stale write rejected');
            e.status = 409;
            e.details = err;
            throw e;
        }
        return res.json();
    },
    async del(path) {
        await fetch(`${API}${path}`, { method: 'DELETE', headers: { 'X-Client-ID': CLIENT_ID } });
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

// ─── Optimistic Update Infrastructure ───

// Temporary ID counter for optimistic timeline entries (negative to avoid server ID collisions)
let _nextTempId = -1;

// Optimistic timeline POST — returns the temp entry immediately (synchronous)
function postTimelineOptimistic(payload) {
    const tempId = _nextTempId--;
    const entry = {
        ...payload,
        id: tempId,
        timestamp: payload.startTime || Date.now(),
    };
    state.timeline.entries.push(entry);

    // Background: POST to server, reconcile ID
    api.post('/timeline', payload).then(serverEntry => {
        const idx = state.timeline.entries.findIndex(e => e.id === tempId);
        if (idx !== -1) {
            state.timeline.entries[idx] = serverEntry;
        }
    }).catch(err => {
        console.error('[optimistic] Timeline POST failed:', err);
        // Remove the optimistic entry on failure
        const idx = state.timeline.entries.findIndex(e => e.id === tempId);
        if (idx !== -1) state.timeline.entries.splice(idx, 1);
        _showSaveError('timeline entry');
        renderAll();
    });

    return entry;
}

// Fire-and-forget timeline PATCH — applies locally first
function patchTimelineOptimistic(entryId, updates) {
    // Apply to local state immediately
    const entry = state.timeline.entries.find(e => e.id === entryId);
    if (entry) {
        Object.assign(entry, updates);
        if (updates.startTime !== undefined && !('timestamp' in updates)) {
            entry.timestamp = updates.startTime;
        }
    }
    // Fire-and-forget to server
    api.patch(`/timeline/${entryId}`, updates).catch(err => {
        console.error('[optimistic] Timeline PATCH failed:', err);
        _showSaveError('timeline update');
    });
}

// Fire-and-forget timeline DELETE — removes from local state immediately
function delTimelineOptimistic(entryId) {
    const idx = state.timeline.entries.findIndex(e => e.id === entryId);
    const removed = idx !== -1 ? state.timeline.entries.splice(idx, 1)[0] : null;
    // Fire-and-forget to server
    api.del(`/timeline/${entryId}`).catch(err => {
        console.error('[optimistic] Timeline DELETE failed:', err);
        // Re-insert the entry on failure
        if (removed) state.timeline.entries.push(removed);
        _showSaveError('timeline delete');
        renderAll();
    });
}

// Non-blocking error toast
function _showSaveError(domain) {
    const toast = document.createElement('div');
    toast.className = 'save-error-toast';
    toast.textContent = `⚠️ Failed to save ${domain}. Will retry on reconnect.`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
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
    if ('workingOn' in prefs) {
        state.workingOn = prefs.workingOn;
    }
    if ('onBreak' in prefs) {
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
    // Connect SSE sync after initial load
    connectSync();
}

// ─── Real-Time Sync (SSE) ───
let _syncSource = null;
let _lastSseActivity = Date.now();
let _syncReconnectTimer = null;

function connectSync() {
    // Clean up previous connection
    if (_syncSource) {
        _syncSource.close();
        _syncSource = null;
    }
    if (_syncReconnectTimer) {
        clearTimeout(_syncReconnectTimer);
        _syncReconnectTimer = null;
    }

    try {
        _syncSource = new EventSource(`${API}/sync?clientId=${encodeURIComponent(CLIENT_ID)}`);
    } catch { return; /* SSE not supported */ }

    _syncSource.onmessage = async (event) => {
        _lastSseActivity = Date.now();
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'connected') return; // handshake
            await _applySyncEvent(msg.type);
        } catch { /* ignore parse errors */ }
    };

    _syncSource.onerror = () => {
        // EventSource auto-reconnects, but if it fully closes, retry manually
        if (_syncSource && _syncSource.readyState === EventSource.CLOSED) {
            _syncSource = null;
            _syncReconnectTimer = setTimeout(connectSync, 3000);
        }
    };
}

// Apply a remote sync event by re-fetching the specific domain
async function _applySyncEvent(type) {
    try {
        if (type === 'items') {
            state.items = await api.get('/items');
            ensureInbox();
            renderProjects();
            renderActions();
        } else if (type === 'timeline') {
            state.timeline = await api.get('/timeline');
            renderTimeline();
        } else if (type === 'preferences') {
            const prefs = await api.get('/preferences');
            // Apply critical live-state fields from remote
            if ('workingOn' in prefs) state.workingOn = prefs.workingOn;
            if ('onBreak' in prefs) state.onBreak = prefs.onBreak;
            if (Array.isArray(prefs.focusQueue)) {
                state.focusQueue = prefs.focusQueue.filter(q => q.type === 'break' || findItemById(q.itemId));
            }
            if (prefs.focusQueueSettings) {
                state.focusQueueSettings = {
                    autoAdvance: prefs.focusQueueSettings.autoAdvance === true,
                    breakMinutes: typeof prefs.focusQueueSettings.breakMinutes === 'number' ? prefs.focusQueueSettings.breakMinutes : 0,
                };
            }
            if (typeof prefs.queueSessionStart === 'number' || prefs.queueSessionStart === null) {
                state.queueSessionStart = prefs.queueSessionStart;
            }
            if (Array.isArray(prefs.bookmarks)) {
                state.bookmarks = prefs.bookmarks.filter(id => findItemById(id));
                syncBookmarksBtn();
            }
            if (Array.isArray(prefs.focusStack) && prefs.focusStack.length > 0) {
                state.focusStack = prefs.focusStack;
            }
            renderAll();
        } else if (type === 'settings') {
            const s = await api.get('/settings');
            state.settings = { ...state.settings, ...s };
            syncSettingsUI();
            renderAll();
        }
    } catch (err) {
        console.warn('[sync] Failed to apply remote event:', type, err);
    }
}

// ─── Stale Tab Recovery (visibilitychange) ───
let _lastHiddenTime = 0;

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        _lastHiddenTime = Date.now();
    } else {
        const hiddenDuration = Date.now() - _lastHiddenTime;
        const sseStale = (Date.now() - _lastSseActivity) > 30000;
        // If tab was hidden for >30s AND we haven't received SSE activity recently, full reload
        if (hiddenDuration > 30000 && sseStale) {
            console.log('[sync] Stale tab detected, reloading state...');
            loadAll();
        }
        // Re-establish SSE if connection was lost
        if (!_syncSource || _syncSource.readyState === EventSource.CLOSED) {
            connectSync();
        }
    }
});

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

        // Create the item optimistically
        api.post('/items', { name, parentId, timeContexts: getCurrentTimeContexts() }).then(newItem => {
            reloadItems(); // background sync
        }).catch(err => {
            console.error('[optimistic] Item creation failed:', err);
            _showSaveError('item creation');
        });
        // Optimistic local add — add to state.items tree immediately
        const tempId = state.items.nextId++;
        const newLocalItem = { id: tempId, name, children: [], expanded: false, createdAt: Date.now(), done: false, timeContexts: getCurrentTimeContexts() };
        const parentArr = parentId ? findItemById(parentId)?.children : state.items.items;
        if (parentArr) parentArr.push(newLocalItem);
        saveItems(); // debounced bulk save
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
    api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
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
function setContextDone(item, contextKey, done) {
    if (!item) return;
    if (!item.contextDone) item.contextDone = {};
    if (done) {
        item.contextDone[contextKey] = Date.now();
    } else {
        delete item.contextDone[contextKey];
    }
    api.patch(`/items/${item.id}`, { contextDone: item.contextDone }).catch(err => {
        console.error('[optimistic] Item PATCH failed:', err);
        _showSaveError('item update');
    });
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
    api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}

// Degrade a segment context back to its parent date context.
// Returns the removed context's duration (if any) so callers can migrate it.
function degradeSegmentContext(itemId, segmentContextStr) {
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
    api.patch(`/items/${itemId}`, patch).catch(err => {
        console.error('[optimistic] Item PATCH failed:', err);
        _showSaveError('item context');
    });
    renderAll();
    return removedDuration;
}

// Degrade all segment/entry contexts referencing a specific entry ID
function degradeEntryContexts(entryId) {
    const items = collectAllItems(state.items.items);
    for (const item of items) {
        if (!item.timeContexts) continue;
        const matching = item.timeContexts.filter(tc => {
            const p = parseTimeContext(tc);
            return p && p.entryId === entryId;
        });
        if (matching.length > 0) {
            for (const ctx of matching) {
                degradeSegmentContext(item.id, ctx);
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
function deleteBuffersForEntry(parentEntryId) {
    const buffers = getBufferEntries(parentEntryId);
    for (const buf of buffers) {
        degradeEntryContexts(buf.id);
        delTimelineOptimistic(buf.id);
    }
}

// Create buffer entries for a parent planned entry based on its prepDuration / windDownDuration
function createBufferEntries(parentEntry) {
    const buffers = [];
    if (parentEntry.prepDuration && parentEntry.prepDuration > 0) {
        const prepEnd = parentEntry.startTime || parentEntry.timestamp;
        const prepStart = prepEnd - parentEntry.prepDuration * 1000;
        const buf = postTimelineOptimistic({
            text: `Prep: ${parentEntry.text}`,
            type: 'planned',
            startTime: prepStart,
            endTime: prepEnd,
            itemId: null,
            bufferForEntryId: parentEntry.id,
            bufferType: 'prep',
        });
        buffers.push(buf);
    }
    if (parentEntry.windDownDuration && parentEntry.windDownDuration > 0) {
        const wdStart = parentEntry.endTime;
        const wdEnd = wdStart + parentEntry.windDownDuration * 1000;
        const buf = postTimelineOptimistic({
            text: `Wind-down: ${parentEntry.text}`,
            type: 'planned',
            startTime: wdStart,
            endTime: wdEnd,
            itemId: null,
            bufferForEntryId: parentEntry.id,
            bufferType: 'winddown',
        });
        buffers.push(buf);
    }
    return buffers;
}

// Sync buffer entries when parent's times or durations change
function syncBufferEntries(parentEntry) {
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
            patchTimelineOptimistic(existingPrep.id, {
                startTime: prepStart, timestamp: prepStart, endTime: prepEnd,
                text: `Prep: ${parentEntry.text}`,
            });
        } else {
            postTimelineOptimistic({
                text: `Prep: ${parentEntry.text}`,
                type: 'planned', startTime: prepStart, endTime: prepEnd,
                itemId: null, bufferForEntryId: parentEntry.id, bufferType: 'prep',
            });
        }
    } else if (existingPrep) {
        degradeEntryContexts(existingPrep.id);
        delTimelineOptimistic(existingPrep.id);
    }

    // Handle wind-down buffer
    const existingWd = existing.find(b => b.bufferType === 'winddown');
    if (wdDur > 0) {
        const wdStart = parentEnd;
        const wdEnd = wdStart + wdDur * 1000;
        if (existingWd) {
            patchTimelineOptimistic(existingWd.id, {
                startTime: wdStart, timestamp: wdStart, endTime: wdEnd,
                text: `Wind-down: ${parentEntry.text}`,
            });
        } else {
            postTimelineOptimistic({
                text: `Wind-down: ${parentEntry.text}`,
                type: 'planned', startTime: wdStart, endTime: wdEnd,
                itemId: null, bufferForEntryId: parentEntry.id, bufferType: 'winddown',
            });
        }
    } else if (existingWd) {
        degradeEntryContexts(existingWd.id);
        delTimelineOptimistic(existingWd.id);
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
function _resolveSegmentAcceptLog_Idle(planEntry, seg) {
    postTimelineOptimistic({
        text: 'Idle',
        type: 'idle',
        manual: true,
        startTime: seg.startMs,
        endTime: seg.endMs,
    });
}

// Accept Log for a single different-work segment — mark the work entry as manual
function _resolveSegmentAcceptLog_Different(seg) {
    const workEntry = seg.workEntry;
    if (!workEntry) return;
    patchTimelineOptimistic(workEntry.id, { manual: true });
}

// Accept Log for ALL segments of a plan at once
function _resolveAllSegmentsAsLog(divergence) {
    for (const seg of (divergence.allSegments || divergence.segments || [])) {
        if (seg.type === 'covered') continue;
        if (seg.type === 'idle') {
            _resolveSegmentAcceptLog_Idle(divergence.entry, seg);
        } else if (seg.type === 'different') {
            _resolveSegmentAcceptLog_Different(seg);
        }
    }
    renderAll();
}

// Accept unplanned work — mark it as manual (intentional)
function resolveDivergenceAcceptUnplanned(workEntryId) {
    patchTimelineOptimistic(workEntryId, { manual: true });
    renderAll();
}

// Reject unplanned work — delete the log entry (nothing was planned, dismiss it)
function resolveDivergenceRejectUnplanned(workEntryId) {
    delTimelineOptimistic(workEntryId);
    renderAll();
}

// Accept Plan for idle segment — create retroactive manual work entry for the gap
function _resolveSegmentAcceptPlan_Idle(planEntry, seg) {
    const planName = planEntry.text || 'Planned session';
    const itemId = planEntry.itemId || null;
    const projectName = planEntry.projectName || null;
    const durationMs = seg.endMs - seg.startMs;
    const durStr = _fmtDuration(durationMs);

    postTimelineOptimistic({
        text: `Worked on: ${planName} (${durStr})`,
        projectName,
        type: 'work',
        manual: true,
        startTime: seg.startMs,
        endTime: seg.endMs,
        itemId,
    });
}

// Accept Plan for different-work segment — re-attribute the work entry to the planned project
function _resolveSegmentAcceptPlan_Different(planEntry, seg) {
    const planName = planEntry.text || 'Planned session';
    const workEntry = seg.workEntry;
    if (!workEntry) return;

    const durationMs = workEntry.endTime - workEntry.timestamp;
    const durStr = _fmtDuration(durationMs);

    patchTimelineOptimistic(workEntry.id, {
        text: `Worked on: ${planName} (${durStr})`,
        itemId: planEntry.itemId || null,
        projectName: planEntry.projectName || null,
        manual: true,
    });
}

// Accept Plan for ALL idle segments of a plan at once
function resolveDivergenceDidIt(entry) {
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
        postTimelineOptimistic({
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
            patchTimelineOptimistic(ce.id, {
                text: `Worked on: ${planName} (${_fmtDuration(ce.endTime - ce.timestamp)})`,
                itemId: itemId,
                projectName: projectName,
                manual: true,
            });
        }
    }

    renderAll();
}

function resolveDivergenceReschedule(entry, target) {
    // Rescheduling creates a NEW plan and covers the old time with a manual idle log.
    // The original plan entry is never deleted.
    const planStart = entry.timestamp;
    const planEnd = entry.endTime;
    const duration = planEnd - planStart;
    const planName = entry.text || 'Planned session';

    // Create manual idle log for the original time slot
    postTimelineOptimistic({
        text: 'Idle',
        type: 'idle',
        manual: true,
        startTime: planStart,
        endTime: planEnd,
    });

    // Create the new plan entry at the target time
    if (target === 'drop') {
        // Drop = just cover original with idle, no new plan
        deleteBuffersForEntry(entry.id);
        degradeEntryContexts(entry.id);
    } else if (target === 'tomorrow') {
        const tomorrow = new Date(planStart);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const newStart = tomorrow.getTime();
        const newEnd = newStart + duration;
        postTimelineOptimistic({
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
                postTimelineOptimistic({
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
    api.put('/settings', state.settings);
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
    api.put('/settings', state.settings);
    renderAll();
}

// Trim the log entry to exclude the out-of-hours portion
function resolveOutOfHoursTrimLog(div) {
    const entry = div.workEntry;
    if (!entry) return;

    if (div.perspective === 'prev-day') {
        // Work extends past day end — trim endTime to gapStart (day end)
        if (entry.timestamp >= div.gapStart) {
            // Entire entry is in the gap — delete it
            delTimelineOptimistic(entry.id);
        } else {
            patchTimelineOptimistic(entry.id, { endTime: div.gapStart });
        }
    } else {
        // Work starts before day start — trim timestamp to gapEnd (day start)
        if (entry.endTime <= div.gapEnd) {
            // Entire entry is in the gap — delete it
            delTimelineOptimistic(entry.id);
        } else {
            patchTimelineOptimistic(entry.id, { timestamp: div.gapEnd });
        }
    }

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
function _degradeLiveContexts(type) {
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
            api.patch(`/items/${item.id}`, patch).catch(err => {
                console.error('[optimistic] Item PATCH failed:', err);
                _showSaveError('item context');
            });
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
function removeSourceContext(itemId, sourceContext) {
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
    const didRemove = item.timeContexts.length < before;
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
    // Only persist if something was actually removed
    if (didRemove) {
        const patch = { timeContexts: item.timeContexts };
        if (item.contextDurations) patch.contextDurations = item.contextDurations;
        api.patch(`/items/${itemId}`, patch).catch(err => {
            console.error('[optimistic] Item PATCH failed:', err);
            _showSaveError('item context');
        });
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
        if (!desc || desc.done) continue; // global done only for capacity calc
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

    const remaining = budget > 0 ? budget - invested - planned : 0;

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
    api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts });
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
        api.patch(`/items/${itemId}`, patch);
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
    api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
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
    api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
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
    api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
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
    api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
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
    api.patch(`/items/${itemId}`, { timeContexts: item.timeContexts, contextDurations: item.contextDurations });
    renderAll();
}

// ─── Auto-clean past schedules ───
// Silently remove any timeContexts entries before today.
// Degradation cascade: date → week → month → ongoing.
// Past weeks degrade to their month, past months degrade to ongoing.
async function cleanPastSchedules() {
    // Use a conservative "logical today" for degradation:
    // During the sleep gap (after day-end but before next-day-start),
    // getLogicalToday() falls back to the calendar date (= next day).
    // For degradation, we wait until the new day actually STARTS,
    // so we treat the sleep gap as still "yesterday."
    const now = new Date();
    let today;
    if (isCurrentDay(now)) {
        today = now;
    } else {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (isCurrentDay(yesterday)) {
            today = yesterday; // cross-midnight: still in yesterday's active hours
        } else {
            // Sleep gap: neither today nor yesterday is active.
            // Stay on yesterday so items don't degrade until the new day starts.
            today = yesterday;
        }
    }
    const todayKey = getDateKey(today);
    const currentWeekKey = getWeekKey(today);
    const currentMonthKey = getMonthKey(today);
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
                    // Keep epoch and week and month contexts as-is (week/month cleaned below)
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
                    var migratedDuration = null;
                    if (item.contextDurations) {
                        // Find removed context keys (were in original but not in filtered)
                        const removedKeys = Object.keys(item.contextDurations).filter(
                            k => !item.timeContexts.some(tc => tc === k || k.startsWith(tc))
                        );
                        // Capture the max duration from removed contexts for migration
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
                    if (hadDateContexts && !hasRemainingDates && !hasWeek) {
                        // Strip any pre-existing epoch contexts so we degrade properly
                        item.timeContexts = item.timeContexts.filter(tc => !EPOCH_CONTEXTS.includes(tc));
                        // Degrade to the current week context
                        const weekKey = currentWeekKey;
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

                // ── Cascade past weeks → month ──
                const pastWeeks = item.timeContexts.filter(tc => {
                    if (!isWeekContext(tc)) return false;
                    const range = getWeekDateRange(tc);
                    return range && getDateKey(range.end) < todayKey;
                });
                if (pastWeeks.length > 0) {
                    // Collect best duration from past week contexts
                    let weekDur = null;
                    for (const wk of pastWeeks) {
                        const d = item.contextDurations?.[wk];
                        if (d != null && (weekDur == null || d > weekDur)) weekDur = d;
                        if (item.contextDurations) delete item.contextDurations[wk];
                    }
                    item.timeContexts = item.timeContexts.filter(tc => !pastWeeks.includes(tc));
                    // Only degrade if no other week/date/month contexts remain
                    const hasCurrentWeek = item.timeContexts.some(tc => isWeekContext(tc));
                    const hasDate = item.timeContexts.some(tc => { const p = parseTimeContext(tc); return p && p.date; });
                    const hasMonth = item.timeContexts.some(tc => isMonthContext(tc));
                    if (!hasCurrentWeek && !hasDate && !hasMonth) {
                        // Strip pre-existing epoch contexts
                        item.timeContexts = item.timeContexts.filter(tc => !EPOCH_CONTEXTS.includes(tc));
                        // Degrade to current month
                        item.timeContexts.push(currentMonthKey);
                        if (weekDur != null) {
                            if (!item.contextDurations) item.contextDurations = {};
                            if (!(currentMonthKey in item.contextDurations)) {
                                item.contextDurations[currentMonthKey] = weekDur;
                            }
                        }
                    }
                    dirty = true;
                }

                // ── Cascade past months → ongoing ──
                const pastMonths = item.timeContexts.filter(tc => {
                    if (!isMonthContext(tc)) return false;
                    const range = getMonthDateRange(tc);
                    return range && getDateKey(range.end) < todayKey;
                });
                if (pastMonths.length > 0) {
                    let monthDur = null;
                    for (const mk of pastMonths) {
                        const d = item.contextDurations?.[mk];
                        if (d != null && (monthDur == null || d > monthDur)) monthDur = d;
                        if (item.contextDurations) delete item.contextDurations[mk];
                    }
                    item.timeContexts = item.timeContexts.filter(tc => !pastMonths.includes(tc));
                    // Only degrade if no other temporal contexts remain
                    const hasWeekOrDate = item.timeContexts.some(tc => {
                        if (isWeekContext(tc)) return true;
                        if (isMonthContext(tc)) return true;
                        const p = parseTimeContext(tc);
                        return p && p.date;
                    });
                    if (!hasWeekOrDate && !item.timeContexts.some(tc => EPOCH_CONTEXTS.includes(tc))) {
                        item.timeContexts.push('ongoing');
                        if (monthDur != null) {
                            if (!item.contextDurations) item.contextDurations = {};
                            if (!('ongoing' in item.contextDurations)) {
                                item.contextDurations['ongoing'] = monthDur;
                            }
                        }
                    }
                    dirty = true;
                }

                // Ensure item always has at least one context
                if (item.timeContexts.length === 0) {
                    item.timeContexts.push('ongoing');
                    dirty = true;
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
        saveItems();
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
        saveItems();
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
    if (dirty) saveItems();
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
    if (dirty) saveItems();
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
            saveItems();
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
        api.patch(`/items/${item.id}`, { done: newDone });
        item.done = newDone;
        if (newDone) {
            const ancestorPath = getAncestorPath(item.id);
            const ancestors = ancestorPath
                ? ancestorPath.map(a => a.name).join(' › ')
                : '';
            postTimelineOptimistic({
                text: `Done: ${item.name}`,
                projectName: ancestors || null,
                type: 'completion'
            });
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

    // ── Commitment option ──
    if (!item.done) {
        const projViewCtx = getCurrentViewContext();
        const projIsCommitted = isCommittedInContext(item, projViewCtx);
        const commitOpt = document.createElement('div');
        commitOpt.className = 'project-context-menu-item' + (projIsCommitted ? ' project-context-menu-item-danger' : '');
        commitOpt.textContent = projIsCommitted ? '⚡ Uncommit (breaks commitment)' : '⚡ Commit to this context';
        commitOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            if (projIsCommitted) {
                if (confirm('Uncommitting counts as a broken commitment. Continue?')) {
                    uncommitFromContext(item.id, projViewCtx);
                }
            } else {
                commitToContext(item.id, projViewCtx);
            }
        });
        menu.appendChild(commitOpt);
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
        api.del(`/items/${item.id}`).catch(err => { console.error('[optimistic] Item delete failed:', err); _showSaveError('item deletion'); });
        if (state.selectedItemId === item.id) {
            state.selectedItemId = null;
            savePref('selectedItemId', '');
        }
        reloadItems();
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
            setContextDone(item, viewCtx, !wasDone);
            if (!wasDone) {
                const ancestors = action._path
                    ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';
                postTimelineOptimistic({
                    text: `Done: ${action.name}`,
                    projectName: ancestors || null,
                    type: 'completion'
                });
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
    if (!isDoneInCtx || isBulk) {
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
        } else if (!isDoneInCtx) {
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

    // ── Commitment option (actions) ──
    if (!isBulk && !isDoneInCtx) {
        const actViewCtx = getCurrentViewContext();
        const actIsCommitted = isCommittedInContext(actionItem, actViewCtx);
        const actCommitOpt = document.createElement('div');
        actCommitOpt.className = 'project-context-menu-item' + (actIsCommitted ? ' project-context-menu-item-danger' : '');
        actCommitOpt.textContent = actIsCommitted ? '⚡ Uncommit (breaks commitment)' : '⚡ Commit to this context';
        actCommitOpt.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissProjectContextMenu();
            if (actIsCommitted) {
                if (confirm('Uncommitting counts as a broken commitment. Continue?')) {
                    uncommitFromContext(action.id, actViewCtx);
                }
            } else {
                commitToContext(action.id, actViewCtx);
            }
        });
        menu.appendChild(actCommitOpt);
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
            removeSourceContext(action.id, getCurrentViewContext());
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
                saveItems();
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
        if (!state.showDone && leaf && !item.isInbox && item.done) continue; // global done only for search

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
        const doneHidden = !state.showDone && isLeaf(item) && !item.isInbox && isContextDone(item, getCurrentViewContext());
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
                    // Collapse: no animation — just re-render
                    item.expanded = false;
                    saveItems();
                    renderProjects();
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
                api.patch(`/items/${item.id}`, { done: newDone });
                item.done = newDone;
                if (newDone) {
                    const ancestorPath = getAncestorPath(item.id);
                    const ancestors = ancestorPath
                        ? ancestorPath.map(a => a.name).join(' › ')
                        : '';
                    postTimelineOptimistic({
                        text: `Done: ${item.name}`,
                        projectName: ancestors || null,
                        type: 'completion'
                    });
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
                api.del(`/items/${item.id}`).catch(err => { console.error('[optimistic] Item delete failed:', err); _showSaveError('item deletion'); });
                if (state.selectedItemId === item.id) {
                    state.selectedItemId = null;
                    savePref('selectedItemId', '');
                }
                reloadItems();
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
        saveItems();
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

// Debounced fire-and-forget item save (300ms coalescing for rapid edits)
let _saveItemsTimer = null;
function saveItems() {
    if (_saveItemsTimer) clearTimeout(_saveItemsTimer);
    _saveItemsTimer = setTimeout(async () => {
        try {
            api.put('/items', { ...state.items }).catch(err => {
                console.error('[optimistic] Items bulk save failed:', err);
                _showSaveError('items');
            });
        } catch (e) {
            if (e.status === 409) {
                alert('⚠️ This tab has outdated data and was blocked from saving.\nThe page will now reload with the latest data.');
                location.reload();
                return;
            }
            console.error('[optimistic] Items save failed:', e);
            _showSaveError('items');
        }
    }, 300);
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
            // Optimistic local add
            const tempId = state.items.nextId++;
            const newLocalItem = { id: tempId, name: input.value.trim(), children: [], expanded: false, createdAt: Date.now(), done: false, timeContexts: getCurrentTimeContexts() };
            const parentArr = parentId ? findItemById(parentId)?.children : state.items.items;
            if (parentArr) parentArr.push(newLocalItem);
            // Fire-and-forget to server
            api.post('/items', {
                name: input.value.trim(),
                parentId: parentId,
                timeContexts: getCurrentTimeContexts()
            }).then(() => reloadItems()).catch(err => {
                console.error('[optimistic] Item creation failed:', err);
                _showSaveError('item creation');
            });
            renderAll();
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

    // ── Day closed: show "Good Night" instead of actions ──
    if (isDayClosed() && !state.workingOn && !state.onBreak) {
        container.querySelectorAll('.action-item, .action-group-header, .overflow-preview').forEach(el => el.remove());
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
    const _sortCtx = getCurrentViewContext();
    const sorted = indexed.sort((a, b) => {
        const aDone = isContextDone(a, _sortCtx);
        const bDone = isContextDone(b, _sortCtx);
        if (aDone !== bDone) return aDone ? 1 : -1;
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
        if (headerItem && !isContextDone(headerItem, getCurrentViewContext())) {
            const chViewCtx = getCurrentViewContext();
            const chBudget = getContextDuration(headerItem, chViewCtx);
            const chInv = computeTimeInvestment(headerItem, chViewCtx);
            const chInvested = chInv ? chInv.invested : 0;

            // Compute planned from descendants using recursive absorption
            function _chDescPlanned(node) {
                if (!node || isContextDone(node, chViewCtx)) return 0;
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
                    const rem = chBudget - chInvested - chPlanned;
                    if (rem >= 0) {
                        parts.push(`${_formatDuration(rem)} remaining`);
                    } else {
                        parts.push(`${_formatDuration(-rem)} over`);
                    }
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

        if (headerItem && !isContextDone(headerItem, getCurrentViewContext())) {
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
                setContextDone(headerItem, getCurrentViewContext(), true);
                const ancestors = getAncestorPath(headerId) || [];
                const ancestorStr = ancestors.map(a => a.name).join(' › ');
                postTimelineOptimistic({
                    text: `Done: ${headerItem.name}`,
                    projectName: ancestorStr || null,
                    type: 'completion'
                });
                renderAll();
            });
            hdrButtons.appendChild(doneBtn);

            // Followup button — marks header done & creates a next-sibling
            const hdrFollowupBtn = document.createElement('button');
            hdrFollowupBtn.className = 'action-btn action-btn-followup';
            hdrFollowupBtn.textContent = '➜';
            hdrFollowupBtn.title = 'Mark done & create follow-up';
            hdrFollowupBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                // 1. Mark as done
                setContextDone(headerItem, getCurrentViewContext(), true);
                // 2. Log to timeline
                const ancestors = getAncestorPath(headerId) || [];
                const ancestorStr = ancestors.map(a => a.name).join(' › ');
                postTimelineOptimistic({
                    text: `Done: ${headerItem.name}`,
                    projectName: ancestorStr || null,
                    type: 'completion'
                });
                // 3. Create next-sibling
                const location = findParentArray(headerId);
                if (location) {
                    const newItem = {
                        id: state.items.nextId++,
                        name: '',
                        children: [],
                        expanded: false,
                        createdAt: Date.now(),
                        done: false,
                        timeContexts: headerItem.timeContexts ? [...headerItem.timeContexts] : [],
                        contextDurations: headerItem.contextDurations ? { ...headerItem.contextDurations } : {},
                    };
                    location.array.splice(location.index + 1, 0, newItem);
                    saveItems();
                    renderAll();
                    setTimeout(() => {
                        const newActionEl = document.querySelector(`.action-item[data-id="${newItem.id}"] .action-name`);
                        if (newActionEl) {
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
                                    saveItems();
                                    renderAll();
                                } else if (!val && itemInTree) {
                                    const loc = findParentArray(newItem.id);
                                    if (loc) {
                                        loc.array.splice(loc.index, 1);
                                        saveItems();
                                        renderAll();
                                    }
                                }
                            };
                            input.addEventListener('keydown', (ev) => {
                                if (ev.key === 'Enter') { ev.preventDefault(); commitFollowup(); }
                                if (ev.key === 'Escape') {
                                    const loc = findParentArray(newItem.id);
                                    if (loc) { loc.array.splice(loc.index, 1); saveItems(); renderAll(); }
                                }
                            });
                            input.addEventListener('blur', () => { setTimeout(commitFollowup, 150); });
                        }
                    }, 50);
                } else {
                    renderAll();
                }
            });
            hdrButtons.appendChild(hdrFollowupBtn);
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

            // Skip aggregate header when: no root (ungrouped), or ≤1 regular actions with no context headers
            if (!group.root || (regularCount <= 1 && contextHeaderCount === 0)) {
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
            // Resolve to actual item (group.root is a path entry {id, name})
            const grpRootItem = group.root ? findItemById(group.root.id) : null;
            if (grpRootItem) {
                const grpViewCtx = getCurrentViewContext();
                const grpBudget = getContextDuration(grpRootItem, grpViewCtx);
                const grpInv = computeTimeInvestment(grpRootItem, grpViewCtx);
                const grpInvested = grpInv ? grpInv.invested : 0;

                // Compute planned from descendants using recursive absorption
                // (same logic as the capacity bar: max(own, childrenSum) at each node)
                function _descPlanned(node) {
                    if (!node || isContextDone(node, grpViewCtx)) return 0;
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
                    if (node.id === grpRootItem.id) return childSum;
                    const dur = getContextDuration(node, grpViewCtx);
                    if (hasChild) return Math.max(dur, childSum);
                    return dur;
                }
                const grpPlanned = _descPlanned(grpRootItem);

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
                        const rem = grpBudget - grpInvested - grpPlanned;
                        if (rem >= 0) {
                            parts.push(`${_formatDuration(rem)} remaining`);
                        } else {
                            parts.push(`${_formatDuration(-rem)} over`);
                        }
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

    // Filter out done items unless showDone is on (context-aware)
    const _viewCtx = getCurrentViewContext();
    if (!state.showDone) {
        allLeaves = allLeaves.filter(a => !isContextDone(a, _viewCtx));
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
        if (!state.showDone) sessionLeaves = sessionLeaves.filter(a => !isContextDone(a, _viewCtx));

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
    const _ovCtx = getCurrentViewContext();
    if (!state.showDone) allLeaves = allLeaves.filter(a => !isContextDone(a, _ovCtx));

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

        // Skip items already scheduled at a more specific level within the current view
        if (matches.length > 0) {
            matches = matches.filter(a => {
                if (horizon === 'week') {
                    // Viewing day → skip items that also have a specific day in this week
                    return !isItemInWeekDays(a, state.timelineViewDate);
                }
                if (horizon === 'month') {
                    // Viewing day/week → skip items that also have a week or day in this month
                    return !isItemInMonthDays(a, state.timelineViewDate);
                }
                if (horizon === 'epoch') {
                    // Viewing day/week/month → skip items with a more specific context in this epoch
                    return !isItemInEpochRange(a, state.epochFilter || 'ongoing');
                }
                return true;
            });
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
        if (inv.budget > 0) {
            if (inv.remaining >= 0) {
                parts.push(`${_formatDuration(inv.remaining)} remaining`);
            } else {
                parts.push(`${_formatDuration(-inv.remaining)} over`);
            }
        }
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
        saveItems();
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

    // Don't show overflow during deep view or sleep
    if (state.deepView) { if (existing) existing.remove(); return; }
    if (isDayClosed() && !state.workingOn && !state.onBreak) { if (existing) existing.remove(); return; }

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

    const viewCtx = getCurrentViewContext();
    for (const id of ids) {
        const numId = parseInt(id, 10);
        const item = findItemById(numId);
        if (item) setContextDone(item, viewCtx, true);
    }
    // Log a single combined completion entry
    const names = ids.map(id => findItemName(parseInt(id, 10)) || id);
    postTimelineOptimistic({
        text: `Done ${ids.length} items: ${names.join(', ')}`,
        projectName: null,
        type: 'completion'
    });
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
        removeSourceContext(parseInt(id, 10), ctx);
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
    const _actionItem = findItemById(action.id);
    const _actViewCtx = getCurrentViewContext();
    const _actionDone = isContextDone(_actionItem, _actViewCtx);
    const _actionCommitted = isCommittedInContext(_actionItem, _actViewCtx);
    item.className = 'action-item' + (_actionDone ? ' done' : '') + (state.selectedActionIds.has(actionIdStr) ? ' selected' : '') + (isLiveWorking ? ' action-item-working' : '') + (_actionCommitted ? ' committed' : '');
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
    if (!_actionDone) {
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
    if (!_actionDone) {
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
    if (!_actionDone) {
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
                    if (inv.remaining >= 0) {
                        parts.push(`${_formatDuration(inv.remaining)} remaining`);
                    } else {
                        parts.push(`${_formatDuration(-inv.remaining)} over`);
                    }
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
    doneBtn.textContent = _actionDone ? '↩' : '✓';
    doneBtn.title = _actionDone ? 'Mark as not done' : 'Mark as done';
    if (_actionDone) doneBtn.classList.add('action-btn-undone');
    doneBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = findItemById(action.id);
        if (!item) return;
        const wasDone = isContextDone(item, _actViewCtx);
        setContextDone(item, _actViewCtx, !wasDone);

        if (!wasDone) {
            // Log to timeline when marking done
            const ancestors = action._path
                ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                : '';
            postTimelineOptimistic({
                text: `Done: ${action.name}`,
                projectName: ancestors || null,
                type: 'completion'
            });
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
            removeSourceContext(action.id, getCurrentViewContext());
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



    // Followup button — marks as done, then creates a new sibling right after it
    const followupBtn = document.createElement('button');
    followupBtn.className = 'action-btn action-btn-followup';
    followupBtn.textContent = '➜';
    followupBtn.title = 'Mark done & create follow-up';
    if (!_actionDone) {
        followupBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // 1. Mark as done in context
            const item = findItemById(action.id);
            if (item) setContextDone(item, _actViewCtx, true);

            // 2. Log to timeline
            const ancestors = action._path
                ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                : '';
            postTimelineOptimistic({
                text: `Done: ${action.name}`,
                projectName: ancestors || null,
                type: 'completion'
            });

            // 3. Create a new sibling item immediately after this one in the tree
            const location = findParentArray(action.id);
            if (location) {
                const origItem = findItemById(action.id);
                const newItem = {
                    id: state.items.nextId++,
                    name: '',
                    children: [],
                    expanded: false,
                    createdAt: Date.now(),
                    done: false,
                    timeContexts: origItem && origItem.timeContexts ? [...origItem.timeContexts] : [],
                    contextDurations: origItem && origItem.contextDurations ? { ...origItem.contextDurations } : {},
                };
                location.array.splice(location.index + 1, 0, newItem);
                saveItems();
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
                                saveItems();
                                renderAll();
                            } else if (!val && itemInTree) {
                                // Remove the empty item if user didn't type anything
                                const loc = findParentArray(newItem.id);
                                if (loc) {
                                    loc.array.splice(loc.index, 1);
                                    saveItems();
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
    if (!_actionDone) {
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
    if (!_actionDone) {
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
    buttons.appendChild(followupBtn);

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
        let candidates = allItems.filter(i => !visibleIds.has(i.id) && !i.done); // global done only for add-existing
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

                api.patch(`/items/${_existingItemId}`, patch);
                renderAll();
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

        // Optimistic local add
        const tempId = state.items.nextId++;
        const newLocalItem = { id: tempId, name, children: [], expanded: false, createdAt: Date.now(), done: false, timeContexts, contextDurations };
        const parentArr = parentId ? findItemById(parentId)?.children : state.items.items;
        if (parentArr) parentArr.push(newLocalItem);
        // Fire-and-forget to server
        api.post('/items', {
            name,
            parentId,
            timeContexts,
            contextDurations
        }).then(() => reloadItems()).catch(err => {
            console.error('[optimistic] Item creation failed:', err);
            _showSaveError('item creation');
        });
        renderAll();

        // Auto-add to queue when focused on the live horizon
        if (state.viewHorizon === 'live') {
            addToQueue(tempId);
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
                api.patch(`/items/${itemId}`, { timeContexts: merged });
                renderAll();
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
        // Add to local state immediately (skip redundant full reload)
        if (newItem) {
            const parentArr2 = parentId ? findItemById(parentId)?.children : state.items.items;
            if (parentArr2) parentArr2.push(newItem);
            renderAll();
        }

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
// Now respects manual day lifecycle: returns true only when the day has been explicitly closed.
function isInSleepRange() {
    return isDayClosed();
}

// Check if the current time is past the configured day-end boundary (clock-based).
// Used for the "wind down" nudge — does NOT block actions.
function isPastDayEnd() {
    const logicalToday = getLogicalToday();
    const { dayStart, dayEnd } = getDayBoundaries(logicalToday);
    const now = new Date();
    return now < dayStart || now >= dayEnd;
}

// ─── Day Lifecycle Functions ───
// Manual day management: Start Day / Close Day / Reopen Day

function isDayStarted(dateKey) {
    const key = dateKey || getActiveDayKey();
    const override = state.settings.dayOverrides?.[key];
    return override?.dayStarted === true;
}

function isDayClosed(dateKey) {
    const key = dateKey || getActiveDayKey();
    const override = state.settings.dayOverrides?.[key];
    return override?.dayClosed === true;
}

// Returns the date key of the "active" day:
// - If today (logical) has dayStarted or dayClosed, use today.
// - If today has no flags but yesterday was started and NOT closed, yesterday is still active (wind-down).
// - If today has no flags and it's before today's planned start, and yesterday was closed, show yesterday's closed state.
// - Otherwise, use today (new day — "Start Day").
function getActiveDayKey() {
    const todayKey = getTodayLogicalDateKey();
    const todayOverride = state.settings.dayOverrides?.[todayKey];

    // Today explicitly started or closed — it's the active day
    if (todayOverride?.dayStarted || todayOverride?.dayClosed) return todayKey;

    // Check yesterday
    const yesterday = new Date(getLogicalToday());
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = getDateKey(yesterday);
    const yesterdayOverride = state.settings.dayOverrides?.[yesterdayKey];

    // Yesterday started but not closed → still active (wind-down)
    if (yesterdayOverride?.dayStarted && !yesterdayOverride?.dayClosed) {
        return yesterdayKey;
    }

    // Yesterday was closed and we're before today's planned start → persist Good Night
    if (yesterdayOverride?.dayClosed) {
        const todayTimes = getEffectiveDayTimes(new Date());
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(todayTimes.dayStartHour, todayTimes.dayStartMinute, 0, 0);
        if (now < todayStart) {
            return yesterdayKey; // still in "Good Night" until today's start
        }
    }

    return todayKey;
}

async function startDay() {
    const todayKey = getTodayLogicalDateKey();
    if (!state.settings.dayOverrides) state.settings.dayOverrides = {};
    if (!state.settings.dayOverrides[todayKey]) state.settings.dayOverrides[todayKey] = {};

    const now = new Date();
    state.settings.dayOverrides[todayKey].dayStartHour = now.getHours();
    state.settings.dayOverrides[todayKey].dayStartMinute = now.getMinutes();
    state.settings.dayOverrides[todayKey].dayStarted = true;
    state.settings.dayOverrides[todayKey].dayClosed = false;

    api.put('/settings', state.settings);
    renderAll();
}

async function closeDay() {
    const activeKey = getActiveDayKey();
    if (!state.settings.dayOverrides) state.settings.dayOverrides = {};
    if (!state.settings.dayOverrides[activeKey]) state.settings.dayOverrides[activeKey] = {};

    // Evaluate today's commitments
    const commitResults = evaluateCommitments(activeKey);
    const hasCommitments = commitResults.kept.length + commitResults.broken.length > 0;

    // Record commitment results in history
    for (const item of commitResults.kept) {
        _recordCommitmentResult(item.context, item.itemId, item.name, true);
    }
    for (const item of commitResults.broken) {
        _recordCommitmentResult(item.context, item.itemId, item.name, false);
    }

    const finishClose = async () => {
        const now = new Date();
        state.settings.dayOverrides[activeKey].dayEndHour = now.getHours();
        state.settings.dayOverrides[activeKey].dayEndMinute = now.getMinutes();
        state.settings.dayOverrides[activeKey].dayClosed = true;
        state.settings.dayOverrides[activeKey].dayClosedAt = Date.now();

        // Merge streak check-in (commitment-aware)
        await performCheckIn(commitResults);

        api.put('/settings', state.settings);
        renderAll();
    };

    // Show commitment review if there are commitments, else close directly
    if (hasCommitments) {
        showCommitmentReview(commitResults, finishClose);
    } else {
        await finishClose();
    }
}

async function reopenDay() {
    const activeKey = getActiveDayKey();
    if (!state.settings.dayOverrides) state.settings.dayOverrides = {};
    if (!state.settings.dayOverrides[activeKey]) state.settings.dayOverrides[activeKey] = {};

    state.settings.dayOverrides[activeKey].dayClosed = false;
    delete state.settings.dayOverrides[activeKey].dayClosedAt;

    api.put('/settings', state.settings);
    renderAll();
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
                removeSourceContext(Number(itemId), segCtx);
            }
        } else {
            // Regular action drag (multi-select aware)
            const dragIds = getMultiDragIds(e);
            if (dragIds.length === 0) return;
            const sourceCtx = e.dataTransfer.getData('application/x-source-context');
            for (const itemId of dragIds) {
                const item = findItemById(itemId);
                const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
                if (!isCopy && sourceCtx) { removeSourceContext(itemId, sourceCtx); }

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
                            try { api.put('/items', state.items); } catch (e) { if (e.status === 409) { alert('⚠️ This tab has outdated data. Reloading...'); location.reload(); return; } throw e; }
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
    const _fpActiveDayKey = getActiveDayKey();
    const _fpDayTimes = getEffectiveDayTimes(getLogicalToday());
    const fp = `${!!state.workingOn}|${!!state.onBreak}|${state.workingOn?.itemId || ''}|${state.focusQueue.length}|${state.workingOn?.startTime || state.onBreak?.startTime || ''}|${state.workingOn?.targetEndTime || state.onBreak?.targetEndTime || ''}|${isDayClosed()}|${isDayStarted()}|${isPastDayEnd()}|${_fpDayTimes.dayStartHour}:${_fpDayTimes.dayStartMinute}-${_fpDayTimes.dayEndHour}:${_fpDayTimes.dayEndMinute}|${_fpActiveDayKey}`;
    const liveSlot = document.getElementById('header-live-slot');
    if (!liveSlot) return;
    if (fp === _liveIndicatorFingerprint && liveSlot.children.length > 0) return;
    _liveIndicatorFingerprint = fp;

    // Clear the live slot
    liveSlot.innerHTML = '';

    const liveSession = state.workingOn || state.onBreak;

    // ── Idle / Sleep / Day lifecycle indicator ──
    if (!liveSession) {
        // Day is closed — show sleep indicator
        if (isDayClosed()) {
            _renderSleepIndicator(liveSlot);
            return;
        }

        // Day not started yet — show Start Day indicator
        if (!isDayStarted()) {
            _renderDayStartIndicator(liveSlot);
            return;
        }

        // Use the active day's boundaries (not getLogicalToday which may have rolled)
        const _activeDayKey = getActiveDayKey();
        const _activeDayParts = _activeDayKey.split('-').map(Number);
        const activeDay = new Date(_activeDayParts[0], _activeDayParts[1] - 1, _activeDayParts[2]);
        const { dayStart, dayEnd } = getDayBoundaries(activeDay);
        const nowMs = Date.now();

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
        const pastDayEnd = isPastDayEnd();

        const indicator = document.createElement('div');
        indicator.className = 'live-session-indicator live-session-indicator-idle' + (pastDayEnd ? ' live-session-indicator-winddown' : '');
        indicator.style.cursor = 'pointer';
        indicator.title = pastDayEnd ? 'Past your usual end time' : 'Click to view current idle time';

        const hasQueue = state.focusQueue.length > 0;

        const icon = document.createElement('span');
        icon.className = 'live-session-indicator-icon';
        icon.textContent = pastDayEnd ? '🌙' : (hasQueue ? '📋' : '💤');

        const label = document.createElement('span');
        label.className = 'live-session-indicator-label';
        label.textContent = pastDayEnd ? 'Wind down?' : (hasQueue ? `Queue (${state.focusQueue.length})` : 'Idle');

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

        // Close Day button
        const _closeDayBtn = document.createElement('button');
        _closeDayBtn.className = 'live-queue-all-btn live-close-day-btn';
        _closeDayBtn.textContent = '🌙 Close Day';
        _closeDayBtn.title = 'Close your day';
        _closeDayBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeDay();
        });
        indicator.appendChild(_closeDayBtn);

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
            const actions = getFilteredActions().filter(a => !isContextDone(a, getCurrentViewContext()));
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
        const actions = getFilteredActions().filter(a => !isContextDone(a, getCurrentViewContext()));
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

    // Quick check: any planned entries today that ended before now?
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
// Renders a calming sleep indicator when the day has been manually closed.

function _renderSleepIndicator(liveSlot) {
    const indicator = document.createElement('div');
    indicator.className = 'live-session-indicator live-session-indicator-sleep';
    indicator.title = 'Day closed — time to rest';

    const icon = document.createElement('span');
    icon.className = 'live-session-indicator-icon';
    icon.textContent = '🌙';

    const label = document.createElement('span');
    label.className = 'live-session-indicator-label';
    label.textContent = 'Good Night';

    // Countdown timer: time until next day's start
    const timer = document.createElement('span');
    timer.className = 'live-session-indicator-timer';
    // Compute next day's start time
    const now = new Date();
    const todayTimes = getEffectiveDayTimes(now);
    const nextStart = new Date(now);
    nextStart.setHours(todayTimes.dayStartHour, todayTimes.dayStartMinute, 0, 0);
    if (nextStart <= now) {
        // Already past today's start — next start is tomorrow
        nextStart.setDate(nextStart.getDate() + 1);
    }
    const remaining = nextStart.getTime() - now.getTime();
    timer.dataset.targetEnd = nextStart.getTime();
    timer.dataset.sessionStart = '';
    timer.textContent = _fmtHMS(remaining) + ' left';

    indicator.appendChild(icon);
    indicator.appendChild(label);
    indicator.appendChild(timer);

    // Reopen Day button
    const reopenBtn = document.createElement('button');
    reopenBtn.className = 'live-queue-all-btn live-reopen-day-btn';
    reopenBtn.textContent = '↩️ Reopen Day';
    reopenBtn.title = 'Reopen your day';
    reopenBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await reopenDay();
    });
    indicator.appendChild(reopenBtn);

    // DnD: drop onto sleep → schedule to today
    _attachLiveIndicatorDnD(indicator, 'idle');

    liveSlot.appendChild(indicator);
}

// ── Day Start Indicator ──
// Renders a "Start Day" indicator when the day hasn't been started yet.

function _renderDayStartIndicator(liveSlot) {
    const indicator = document.createElement('div');
    indicator.className = 'live-session-indicator live-session-indicator-daystart';
    indicator.title = 'Start your day';

    const icon = document.createElement('span');
    icon.className = 'live-session-indicator-icon';
    icon.textContent = '☀️';

    const label = document.createElement('span');
    label.className = 'live-session-indicator-label';
    label.textContent = 'New Day';

    indicator.appendChild(icon);
    indicator.appendChild(label);

    // Start Day button
    const startBtn = document.createElement('button');
    startBtn.className = 'live-queue-all-btn live-start-day-btn';
    startBtn.textContent = '☀️ Start Day';
    startBtn.title = 'Start your day — records your start time';
    startBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await startDay();
    });
    indicator.appendChild(startBtn);

    // DnD: drop onto day-start → schedule to today
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
                    ...(state.settings.dayOverrides[key] || {}),
                    dayStartHour: newSH, dayStartMinute: newSM,
                    dayEndHour: newEH, dayEndMinute: newEM,
                };
                api.put('/settings', state.settings);
                _liveIndicatorFingerprint = null; // force live indicator refresh
                renderTimeline(); // re-renders week view
                _renderLiveSessionIndicator();
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
                // Optimistic local add
                const tempId = state.items.nextId++;
                const newLocalItem = { id: tempId, name, children: [], expanded: false, createdAt: Date.now(), done: false, timeContexts: [dateKey] };
                state.items.items.push(newLocalItem);
                // Fire-and-forget to server
                api.post('/items', { name, parentId: null, timeContexts: [dateKey] }).then(() => reloadItems()).catch(err => {
                    console.error('[optimistic] Item creation failed:', err);
                    _showSaveError('item creation');
                });
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
            if (isContextDone(item, dateKey) && !state.showDone) return false;
            const tcs = item.timeContexts || [];
            return tcs.includes(dateKey) && !tcs.some(tc => tc.startsWith(dateKey + '@'));
        });

        // Session-level items (have segment/entry/live context for this day)
        const sessionItems = allItems.filter(item => {
            if (isContextDone(item, dateKey) && !state.showDone) return false;
            const tcs = item.timeContexts || [];
            return tcs.some(tc => tc.startsWith(dateKey + '@'));
        });

        // Merge all floating items and compute estimated mins
        const allFloating = [];
        for (const item of dayItems) {
            const estMins = item.contextDurations?.[dateKey] ?? item.estimatedDuration ?? 0;
            if (!isContextDone(item, dateKey)) totalEstMins += estMins;
            allFloating.push({ item, estMins, ctx: dateKey });
        }
        for (const sItem of sessionItems) {
            const segCtx = sItem.timeContexts.find(tc => tc.startsWith(dateKey + '@'));
            const estMins = sItem.contextDurations?.[segCtx] ?? sItem.contextDurations?.[dateKey] ?? sItem.estimatedDuration ?? 0;
            if (!isContextDone(sItem, dateKey)) totalEstMins += estMins;
            allFloating.push({ item: sItem, estMins, ctx: segCtx || dateKey });
        }

        // Helper: create a draggable chip for a floating item
        const _createWeekChip = ({ item, estMins, ctx }) => {
            const chip = document.createElement('div');
            chip.className = 'week-action-chip' + (isContextDone(item, dateKey) ? ' week-item-done' : '');
            chip.draggable = true;
            chip.dataset.itemId = String(item.id);

            const bullet = document.createElement('span');
            bullet.className = 'week-chip-bullet';
            bullet.textContent = isContextDone(item, dateKey) ? '✓' : '○';

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
                    api.patch(`/items/${item.id}`, { contextDurations: item.contextDurations });
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
                    patchTimelineOptimistic(entry.id, { timestamp: entry.timestamp, endTime: entry.endTime });
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
                        removeSourceContext(Number(segItemId), segCtx);
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
                if (!isCopy2 && sourceCtx) { removeSourceContext(id, sourceCtx); }
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
    const allItems = collectAllItems(state.items.items).filter(it => !it.deleted && (!state.showDone ? !it.done : true)); // global done for month overview

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
                    removeSourceContext(Number(itemId), segCtx);
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
                if (!_isDragCopy(e) && sourceCtx) { removeSourceContext(id, sourceCtx); }
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

        } else if (isDayClosed()) {
            // ── Day closed state ──
            const header = document.createElement('div');
            header.className = 'live-panel-header live-panel-sleep';
            header.innerHTML = `<span class="live-panel-icon">🌙</span> <span class="live-panel-title">Good Night</span>`;
            panel.appendChild(header);

            const msg = document.createElement('div');
            msg.className = 'live-panel-message';
            msg.textContent = 'Day closed — you earned it.';
            panel.appendChild(msg);

            const reopenRow = document.createElement('div');
            reopenRow.className = 'live-panel-actions';
            const reopenBtn = document.createElement('button');
            reopenBtn.className = 'live-panel-stop-btn';
            reopenBtn.textContent = '↩️ Reopen Day';
            reopenBtn.addEventListener('click', () => reopenDay());
            reopenRow.appendChild(reopenBtn);
            panel.appendChild(reopenRow);

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

        // ── Queue Header + List (only when queue has items) ──
        if (state.focusQueue.length > 0) {
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
        } // end if (focusQueue.length > 0)

        // ── Add Break Button (always visible) ──
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

    const allBlockEntries = allDayEntries.filter(e => isBlockEntry(e));
    const allMomentEntries = allDayEntries.filter(e => !isBlockEntry(e));

    // ── Divergence Detection: find planned sessions that ended without matching work ──
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
                    const dur = degradeSegmentContext(itemId, oldCtx);
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
            if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
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
        if (isContextDone(item, segCtx) && !state.showDone) return false;
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
            const _segDone0 = isContextDone(item, segCtx);
            if (!_segDone0) totalEstMins += estMins;

            const row = document.createElement('div');
            row.className = 'segment-queue-item' + (_segDone0 ? ' segment-item-done' : '');
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
            bullet.textContent = _segDone0 ? '✓' : '○';

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
                    api.patch(`/items/${action.id}`, { contextDurations: item.contextDurations });
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

                // Use the proper startWorking flow (keep the segment context — intention stays assigned)
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
            const _segDone1 = isContextDone(item, segCtx);
            doneBtn.textContent = _segDone1 ? '↩' : '✓';
            doneBtn.title = _segDone1 ? 'Mark not done' : 'Mark done';
            doneBtn.draggable = false;
            doneBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                if (!item) return;
                const wasDone = isContextDone(item, segCtx);
                setContextDone(item, segCtx, !wasDone);
                if (!wasDone) {
                    const anc = action._path
                        ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                        : '';
                    postTimelineOptimistic({
                        text: `Done: ${action.name}`,
                        projectName: anc || null,
                        type: 'completion'
                    });
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

    // Dynamic start toggle pill (sits inside the time row)
    const dynamicStartBtn = document.createElement('button');
    dynamicStartBtn.type = 'button';
    dynamicStartBtn.className = 'plan-editor-dynamic-toggle';
    dynamicStartBtn.textContent = 'FLEX';
    dynamicStartBtn.title = 'Dynamic start — start time slides with now';
    let dynamicStartActive = false;
    dynamicStartBtn.addEventListener('click', () => {
        dynamicStartActive = !dynamicStartActive;
        dynamicStartBtn.classList.toggle('active', dynamicStartActive);
    });

    timeRow.appendChild(dynamicStartBtn);
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

    // Buffer pills — own compact row, click to expand inline number input
    const prepInput = document.createElement('input');
    prepInput.type = 'hidden';
    prepInput.value = '0';
    const wdInput = document.createElement('input');
    wdInput.type = 'hidden';
    wdInput.value = '0';

    if (initialMode !== 'intend') {
        const bufferRow = document.createElement('div');
        bufferRow.className = 'plan-editor-row buffer-pill-row';

        const createBufferPill = (emoji, hiddenInput, title, isWd) => {
            const wrapper = document.createElement('span');
            wrapper.className = 'buffer-pill' + (isWd ? ' buffer-pill-wd' : ' buffer-pill-prep');
            wrapper.title = title;

            const emojiSpan = document.createElement('span');
            emojiSpan.className = 'buffer-pill-emoji';
            emojiSpan.textContent = emoji;

            const numInput = document.createElement('input');
            numInput.type = 'number';
            numInput.className = 'buffer-pill-input';
            numInput.min = '0';
            numInput.max = '120';
            numInput.value = '';
            numInput.placeholder = '0';
            numInput.style.display = 'none';

            const mLabel = document.createElement('span');
            mLabel.className = 'buffer-pill-unit';
            mLabel.textContent = 'm';
            mLabel.style.display = 'none';

            const toggle = () => {
                const isActive = wrapper.classList.contains('buffer-pill-active');
                if (isActive) {
                    wrapper.classList.remove('buffer-pill-active');
                    numInput.style.display = 'none';
                    mLabel.style.display = 'none';
                    numInput.value = '';
                    hiddenInput.value = '0';
                } else {
                    wrapper.classList.add('buffer-pill-active');
                    numInput.style.display = '';
                    mLabel.style.display = '';
                    numInput.value = '5';
                    hiddenInput.value = '5';
                    setTimeout(() => { numInput.focus(); numInput.select(); }, 50);
                }
            };

            emojiSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                toggle();
            });

            numInput.addEventListener('input', () => {
                const v = parseInt(numInput.value, 10) || 0;
                hiddenInput.value = String(v);
                if (v <= 0) {
                    wrapper.classList.remove('buffer-pill-active');
                    numInput.style.display = 'none';
                    mLabel.style.display = 'none';
                    hiddenInput.value = '0';
                }
            });

            numInput.addEventListener('click', (e) => e.stopPropagation());

            wrapper.appendChild(emojiSpan);
            wrapper.appendChild(numInput);
            wrapper.appendChild(mLabel);
            return wrapper;
        };

        bufferRow.appendChild(createBufferPill('🎒', prepInput, 'Prep time before session', false));
        bufferRow.appendChild(createBufferPill('🧹', wdInput, 'Wind-down time after session', true));
        bufferRow.appendChild(prepInput);
        bufferRow.appendChild(wdInput);
        content.appendChild(bufferRow);
    }

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
            const entry = postTimelineOptimistic({
                text: customTitle,
                projectName: null,
                type: 'planned',
                startTime: planStartMs,
                endTime: planEndMs,
                itemId: null,
                ...(dynamicStartActive ? { dynamicStart: true } : {}),
                ...(parseInt(prepInput.value, 10) > 0 ? { prepDuration: parseInt(prepInput.value, 10) * 60 } : {}),
                ...(parseInt(wdInput.value, 10) > 0 ? { windDownDuration: parseInt(wdInput.value, 10) * 60 } : {}),
            });
            createBufferEntries(entry);

            renderTimeline();
            renderActions();
            return;
        }

        const ancestors = selectedAction._path
            ? selectedAction._path.slice(0, -1).map(p => p.name).join(' › ')
            : '';

        const entry = postTimelineOptimistic({
            text: selectedAction.name,
            projectName: ancestors || null,
            type: 'planned',
            startTime: planStartMs,
            endTime: planEndMs,
            itemId: selectedAction.id,
            ...(dynamicStartActive ? { dynamicStart: true } : {}),
            ...(parseInt(prepInput.value, 10) > 0 ? { prepDuration: parseInt(prepInput.value, 10) * 60 } : {}),
            ...(parseInt(wdInput.value, 10) > 0 ? { windDownDuration: parseInt(wdInput.value, 10) * 60 } : {}),
        });
        createBufferEntries(entry);

        // Write back duration to item context estimate (learn from scheduling)
        const durationMins = Math.round((planEndMs - planStartMs) / 60000);
        const existingItem = findItemById(selectedAction.id);
        if (existingItem) {
            const ctx = getCurrentViewContext();
            if (!existingItem.contextDurations) existingItem.contextDurations = {};
            if (!(ctx in existingItem.contextDurations)) {
                existingItem.contextDurations[ctx] = durationMins;
                api.patch(`/items/${selectedAction.id}`, { contextDurations: existingItem.contextDurations });
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

function createIdleTimeBlock(startMs, endMs, isLive) {
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
        const actualEnd = isLive ? nowMs : Math.min(endMs, nowMs);
        openIdleWorkEditor(el, startMs, actualEnd);
    });
    el.appendChild(logBtn);

    // Break button — left-click opens duration picker
    const breakBtn = document.createElement('button');
    breakBtn.className = 'idle-break-btn';
    breakBtn.textContent = '☕';
    breakBtn.title = 'Take a break';
    breakBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showBreakDurationPicker(breakBtn);
    });
    el.appendChild(breakBtn);

    // Start button — starts a live activity retroactively from idle start
    if (isLive) {
        const startBtn = document.createElement('button');
        startBtn.className = 'idle-start-btn';
        startBtn.textContent = '▶';
        startBtn.title = 'Start working — retroactive from idle start';
        startBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openIdleStartPicker(el, startMs);
        });
        el.appendChild(startBtn);
    }

    return el;
}

// ── Idle Start Picker: quick-pick to start working retroactively from idle ──
function openIdleStartPicker(anchorEl, idleStartMs) {
    // Close any existing picker/editor
    document.querySelectorAll('.idle-start-picker').forEach(p => p.remove());
    document.querySelectorAll('.plan-editor').forEach(ed => ed.remove());

    const picker = document.createElement('div');
    picker.className = 'time-block idle-start-picker';

    const pickerIcon = document.createElement('div');
    pickerIcon.className = 'time-block-icon';
    pickerIcon.textContent = '▶';

    const pickerContent = document.createElement('div');
    pickerContent.className = 'plan-editor-content';

    const actionRow = document.createElement('div');
    actionRow.className = 'plan-editor-row';

    const actionInputWrap = document.createElement('div');
    actionInputWrap.className = 'plan-editor-autocomplete';

    const actionInput = document.createElement('input');
    actionInput.type = 'text';
    actionInput.className = 'plan-editor-input';
    actionInput.placeholder = 'What have you been doing?';

    const suggestions = document.createElement('div');
    suggestions.className = 'plan-editor-suggestions';

    actionInputWrap.appendChild(actionInput);
    actionInputWrap.appendChild(suggestions);
    actionRow.appendChild(actionInputWrap);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'plan-editor-row plan-editor-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'plan-editor-discard';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => picker.remove());

    const goBtn = document.createElement('button');
    goBtn.className = 'plan-editor-save';
    goBtn.textContent = '▶ Start';

    actionsRow.appendChild(cancelBtn);
    actionsRow.appendChild(goBtn);

    pickerContent.appendChild(actionRow);
    pickerContent.appendChild(actionsRow);

    picker.appendChild(pickerIcon);
    picker.appendChild(pickerContent);

    anchorEl.after(picker);
    actionInput.focus();

    // Autocomplete
    const autocomplete = setupAutocomplete(actionInput, suggestions, {
        onSelect: () => { /* allow Enter to submit */ },
    });

    // Submit — opens duration picker for the selected item
    const doStart = async () => {
        const selectedAction = autocomplete.getSelected();
        if (!selectedAction) {
            actionInput.focus();
            actionInput.classList.add('plan-editor-input-error');
            setTimeout(() => actionInput.classList.remove('plan-editor-input-error'), 600);
            return;
        }
        const ancestors = getAncestorPath(selectedAction.id);
        const projectName = (ancestors && ancestors.length > 0) ? ancestors[0].name : '';
        picker.remove();
        showDurationPicker(anchorEl, selectedAction.id, selectedAction.name, projectName, idleStartMs);
    };

    goBtn.addEventListener('click', doStart);
    actionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doStart();
        } else if (e.key === 'Escape') {
            picker.remove();
        }
    });
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

        const entry = postTimelineOptimistic({
            text: `Worked on: ${selectedAction.name} (${durStr})`,
            projectName: ancestors || null,
            type: 'work',
            startTime: planStartMs,
            endTime: planEndMs,
            itemId: selectedAction.id,
        });
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
    el.addEventListener('drop', async (e) => {
        if (!_acceptsDrag(e)) return;
        e.preventDefault();
        el.classList.remove('time-block-drag-over');

        // Cross-block drag: segment/entry item moving between blocks
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const oldCtx = e.dataTransfer.getData('application/x-segment-context');
            if (itemId && oldCtx && oldCtx !== contextStr) {
                (async () => {
                    degradeSegmentContext(itemId, oldCtx);
                    await addSegmentContext(Number(itemId), contextStr);
                })();
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
            if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
            await addSegmentContext(Number(id), contextStr, srcDur || undefined, { move: false });
        }
        clearActionSelection();
    });

    // ── Nested entry-assigned items ──
    const allItems = collectAllItems();
    const assignedItems = allItems.filter(a => {
        const item = findItemById(a.id);
        if (!item || !item.timeContexts) return false;
        if (isContextDone(item, contextStr) && !state.showDone) return false;
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
            const _gapDone = isContextDone(item, contextStr);
            if (!_gapDone) totalEstMins += estMins;

            const row = document.createElement('div');
            row.className = 'segment-queue-item' + (_gapDone ? ' segment-item-done' : '');
            row.draggable = true;
            row.dataset.itemId = action.id;

            row.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-segment-item-id', String(action.id));
                e.dataTransfer.setData('application/x-segment-context', contextStr);
                e.dataTransfer.setData('application/x-drag-source', 'timeline');
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('segment-item-dragging');
                _showAllHorizonLayers();
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('segment-item-dragging');
                _restoreHorizonLayers();
            });

            const bullet = document.createElement('span');
            bullet.className = 'segment-queue-bullet';
            bullet.textContent = _gapDone ? '✓' : '○';

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
                    api.patch(`/items/${action.id}`, { contextDurations: item.contextDurations });
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
                const inv2 = computeTimeInvestment(item, contextStr);
                const durMins = (inv2 && inv2.budget > 0) ? Math.max(1, inv2.remaining) : (estMins || 30);
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
                animateActionsZoomIn(() => {
                    state.selectedItemId = action.id;
                    savePref('selectedItemId', action.id);
                    state._animateActions = true;
                    renderAll();
                    requestAnimationFrame(() => scrollToSelectedItem());
                });
            });

            // Done button (toggle)
            const doneBtn2 = document.createElement('button');
            doneBtn2.className = 'segment-queue-done';
            doneBtn2.textContent = _gapDone ? '↩' : '✓';
            doneBtn2.title = _gapDone ? 'Mark not done' : 'Mark done';
            doneBtn2.draggable = false;
            doneBtn2.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                if (!item) return;
                const wasDone = isContextDone(item, contextStr);
                setContextDone(item, contextStr, !wasDone);
                if (!wasDone) {
                    const anc2 = action._path
                        ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                        : '';
                    postTimelineOptimistic({
                        text: `Done: ${action.name}`,
                        projectName: anc2 || null,
                        type: 'completion'
                    });
                }
                renderAll();
            });

            row.appendChild(bullet);
            row.appendChild(locateBtn2);
            row.appendChild(nameSpan);
            row.appendChild(est);
            row.appendChild(doneBtn2);
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
                <span class="segment-capacity-label">${_formatDuration(totalEstMins)} / ${_formatDuration(availMins)}</span>
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
    el.addEventListener('click', () => toggleLiveFocus());

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
            animateActionsZoomIn(() => {
                state.selectedItemId = state.workingOn.itemId;
                savePref('selectedItemId', state.workingOn.itemId);
                state._animateActions = true;
                renderAll();
                requestAnimationFrame(() => scrollToSelectedItem());
            });
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

    // Next button (queue only)
    if (state.focusQueue.length > 0) {
        const nextBtn = document.createElement('button');
        nextBtn.className = 'time-block-stop-btn time-block-next-btn';
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
        el.appendChild(nextBtn);
    }

    // Pause button (queue only)
    if (state.focusQueue.length > 0) {
        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'time-block-stop-btn time-block-pause-btn';
        pauseBtn.textContent = '⏸';
        pauseBtn.title = 'Pause this item & start the next one';
        pauseBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await pauseWorking();
        });
        el.appendChild(pauseBtn);
    }

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
    el.addEventListener('click', () => toggleLiveFocus());

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
    // Lazy DOM cache — re-queries if element disconnected
    let _c = {};
    function _q(key, selector, useId) {
        let el = _c[key];
        if (el && el.isConnected) return el;
        el = useId ? document.getElementById(selector) : document.querySelector(selector);
        _c[key] = el;
        return el;
    }
    idleUpdateInterval = setInterval(() => {
        // ── Update session header timer (if focused) ──
        const sessionTimer = _q('st', '.session-timer');
        if (sessionTimer) {
            const sStart = parseInt(sessionTimer.dataset.sessionStart, 10);
            const sTarget = sessionTimer.dataset.targetEnd ? parseInt(sessionTimer.dataset.targetEnd, 10) : null;
            const sNow = Date.now();
            if (sTarget) {
                const rem = sTarget - sNow;
                if (rem > 0) {
                    sessionTimer.textContent = _fmtHMS(rem) + ' left';
                    sessionTimer.classList.remove('session-timer-overtime');
                    sessionTimer.classList.add('session-timer-remaining');
                } else {
                    sessionTimer.textContent = '+' + _fmtHMS(Math.abs(rem)) + ' over';
                    sessionTimer.classList.remove('session-timer-remaining');
                    sessionTimer.classList.add('session-timer-overtime');
                }
                // Also update progress bar
                const progressFill = _q('pf', '.time-context-progress-fill');
                const progressLabel = _q('pl', '.time-context-progress-label');
                if (progressFill && progressLabel) {
                    const total = sTarget - sStart;
                    const elapsed = sNow - sStart;
                    const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
                    progressFill.style.width = `${Math.min(pct, 100)}%`;
                    if (pct >= 100) progressFill.classList.add('over');
                    progressLabel.textContent = `${Math.round(pct)}%`;
                }
            } else {
                sessionTimer.textContent = _fmtHMS(sNow - sStart);
            }
        }

        // ── Update live session indicator timer ──
        const indicatorTimer = _q('it', '.live-session-indicator-timer');
        if (indicatorTimer) {
            const iStart = parseInt(indicatorTimer.dataset.sessionStart, 10);
            const iTarget = indicatorTimer.dataset.targetEnd ? parseInt(indicatorTimer.dataset.targetEnd, 10) : null;
            const iNow = Date.now();
            if (iTarget) {
                const rem = iTarget - iNow;
                if (rem > 0) {
                    indicatorTimer.textContent = _fmtHMS(rem) + ' left';
                    indicatorTimer.classList.remove('live-session-indicator-overtime');
                } else {
                    indicatorTimer.textContent = '+' + _fmtHMS(Math.abs(rem)) + ' over';
                    indicatorTimer.classList.add('live-session-indicator-overtime');
                }
            } else {
                indicatorTimer.textContent = _fmtHMS(iNow - iStart);
            }
        }

        // ── Update live horizon layer timer ──
        const layerTimer = _q('lt', 'live-layer-timer', true);
        if (layerTimer && layerTimer.dataset.sessionStart) {
            const lStart = parseInt(layerTimer.dataset.sessionStart, 10);
            const lTarget = layerTimer.dataset.targetEnd ? parseInt(layerTimer.dataset.targetEnd, 10) : null;
            const lNow = Date.now();
            layerTimer.textContent = _fmtLiveTimer(lNow, lStart, lTarget);
            if (lTarget && lTarget < lNow) {
                layerTimer.classList.add('live-layer-timer-overtime');
            } else {
                layerTimer.classList.remove('live-layer-timer-overtime');
            }
        }

        // ── Update live panel timer (timeline area) ──
        const panelTimer = _q('pt', 'live-panel-timer', true);
        if (panelTimer && panelTimer.dataset.sessionStart) {
            const pStart = parseInt(panelTimer.dataset.sessionStart, 10);
            const pTarget = panelTimer.dataset.targetEnd ? parseInt(panelTimer.dataset.targetEnd, 10) : null;
            const pNow = Date.now();
            if (pTarget) {
                const rem = pTarget - pNow;
                if (rem > 0) {
                    panelTimer.textContent = `⏱️ ${_fmtHMS(rem)} remaining`;
                    panelTimer.classList.remove('live-panel-overtime');
                } else {
                    panelTimer.textContent = `⏱️ +${_fmtHMS(Math.abs(rem))} overtime`;
                    panelTimer.classList.add('live-panel-overtime');
                }
            } else {
                panelTimer.textContent = `⏱️ ${_fmtHMS(pNow - pStart)} elapsed`;
            }
        }

        // ── Update free time available duration (if focused) ──
        const freeAvail = _q('fa', '.session-avail-duration[data-end-ms]');
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
        const workingBlock = _q('wb', '.time-block-working');
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
        const breakBlock = _q('bb', '.time-block-break');
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
        const idleBlock = _q('ib', '.time-block-idle');
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

        // ── Refresh capacity bar (idle + free depend on current time) ──
        _tickCapacityBar();
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
        label.textContent = `${_formatDuration(totalEst)} / ${_formatDuration(availMins)}`;
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
                ...(state.settings.dayOverrides[key] || {}),
                ...current,
                ...(type === 'day-start'
                    ? { dayStartHour: newH, dayStartMinute: newM }
                    : { dayEndHour: newH, dayEndMinute: newM }),
            };
            api.put('/settings', state.settings);
            _liveIndicatorFingerprint = null;
            renderTimeline();
            _renderLiveSessionIndicator();
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
            api.put('/settings', state.settings);
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

    const isLog = entry.type === 'work' || entry.type === 'break';

    if (isLog) {
        // Edit button — opens the existing entry editor inline
        const editBtn = document.createElement('button');
        editBtn.className = 'compact-past-edit-btn';
        editBtn.textContent = '✏️';
        editBtn.title = 'Edit entry';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEntryEditor(entry, el);
        });
        el.appendChild(editBtn);

        // Delete button — removes the entry
        const delBtn = document.createElement('button');
        delBtn.className = 'compact-past-delete-btn';
        delBtn.textContent = '×';
        delBtn.title = 'Remove entry';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            degradeEntryContexts(entry.id);
            delTimelineOptimistic(entry.id);
            renderTimeline();
        });
        el.appendChild(delBtn);

        // No click-to-expand for logs
        el.style.cursor = 'default';
    } else {
        // Click to expand: replace compact row with full card (toggle) — idle, planned
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
    }

    return el;
}

// ── Insert Marker: hover-reveal "+" line for adding past entries between existing blocks ──
function createPastInsertMarker(afterTimestamp, beforeTimestamp) {
    const gap = beforeTimestamp - afterTimestamp;
    if (gap < 60000) return null; // skip gaps < 1 minute

    const marker = document.createElement('div');
    marker.className = 'past-insert-marker';
    marker.dataset.afterTime = afterTimestamp;
    marker.dataset.beforeTime = beforeTimestamp;

    const line = document.createElement('div');
    line.className = 'past-insert-marker-line';

    const btn = document.createElement('button');
    btn.className = 'past-insert-marker-btn';
    btn.textContent = '+';
    btn.title = `Add entry (${formatTime(afterTimestamp)} – ${formatTime(beforeTimestamp)})`;

    line.appendChild(btn);
    marker.appendChild(line);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPastEntryCreator(marker, afterTimestamp, beforeTimestamp);
    });

    return marker;
}

// ── Past Entry Creator: inline editor for adding a retroactive work/break entry ──
function openPastEntryCreator(markerEl, afterTs, beforeTs) {
    // Close any existing editors
    document.querySelectorAll('.past-entry-creator').forEach(ed => ed.remove());

    let planStartMs = afterTs;
    let planEndMs = beforeTs;
    let entryType = 'work'; // default

    const msToTimeStr = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const timeStrToMs = (str) => {
        const [h, m] = str.split(':').map(Number);
        const d = new Date(afterTs);
        d.setHours(h, m, 0, 0);
        return d.getTime();
    };

    const updateDuration = () => {
        const durMs = planEndMs - planStartMs;
        const totalMins = Math.max(1, Math.round(durMs / 60000));
        durationInput.value = totalMins;
    };

    // ── Build editor DOM ──
    const editor = document.createElement('div');
    editor.className = 'time-block plan-editor past-entry-creator';

    const editorIcon = document.createElement('div');
    editorIcon.className = 'time-block-icon';
    editorIcon.textContent = '🔥';

    const editorContent = document.createElement('div');
    editorContent.className = 'plan-editor-content';

    // Row 0: Type selector (Work / Break toggle pills)
    const typeRow = document.createElement('div');
    typeRow.className = 'plan-editor-row past-entry-type-row';

    const workPill = document.createElement('button');
    workPill.type = 'button';
    workPill.className = 'past-entry-type-pill active';
    workPill.textContent = '🔥 Work';

    const breakPill = document.createElement('button');
    breakPill.type = 'button';
    breakPill.className = 'past-entry-type-pill';
    breakPill.textContent = '☕ Break';

    const updateTypePills = () => {
        workPill.classList.toggle('active', entryType === 'work');
        breakPill.classList.toggle('active', entryType === 'break');
        editorIcon.textContent = entryType === 'work' ? '🔥' : '☕';
        actionInputWrap.style.display = entryType === 'break' ? 'none' : '';
    };

    workPill.addEventListener('click', () => { entryType = 'work'; updateTypePills(); });
    breakPill.addEventListener('click', () => { entryType = 'break'; updateTypePills(); });

    typeRow.appendChild(workPill);
    typeRow.appendChild(breakPill);

    // Row 1: Action autocomplete (for work type)
    const actionRow = document.createElement('div');
    actionRow.className = 'plan-editor-row';

    const actionInputWrap = document.createElement('div');
    actionInputWrap.className = 'plan-editor-autocomplete';

    const actionInput = document.createElement('input');
    actionInput.type = 'text';
    actionInput.className = 'plan-editor-input';
    actionInput.placeholder = 'What were you working on?';

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

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'plan-editor-discard';
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'plan-editor-save';
    saveBtn.textContent = 'Add Entry';

    actionsRow.appendChild(cancelBtn);
    actionsRow.appendChild(saveBtn);

    editorContent.appendChild(typeRow);
    editorContent.appendChild(actionRow);
    editorContent.appendChild(timeRow);
    editorContent.appendChild(actionsRow);

    editor.appendChild(editorIcon);
    editor.appendChild(editorContent);

    // Replace marker with editor
    markerEl.style.display = 'none';
    markerEl.after(editor);

    // Focus appropriate field
    actionInput.focus();

    // ── Autocomplete logic ──
    const autocomplete = setupAutocomplete(actionInput, suggestions, { allowFreeText: true });

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
        const result = parseTimeInput(startInput, planStartMs, () => true);
        if (result !== planStartMs) {
            planStartMs = result;
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

    // ── Cancel ──
    cancelBtn.addEventListener('click', () => {
        editor.remove();
        markerEl.style.display = '';
    });

    // ── Save ──
    saveBtn.addEventListener('click', async () => {
        if (entryType === 'work') {
            const selectedAction = autocomplete ? autocomplete.getSelected() : null;
            if (!selectedAction && !actionInput.value.trim()) {
                actionInput.focus();
                actionInput.classList.add('plan-editor-input-error');
                setTimeout(() => actionInput.classList.remove('plan-editor-input-error'), 600);
                return;
            }

            const durationMs = planEndMs - planStartMs;
            const hrs = Math.floor(durationMs / 3600000);
            const mins = Math.floor((durationMs % 3600000) / 60000);
            const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

            const payload = {
                type: 'work',
                startTime: planStartMs,
                endTime: planEndMs,
            };

            if (selectedAction) {
                const ancestors = selectedAction._path
                    ? selectedAction._path.slice(0, -1).map(p => p.name).join(' › ')
                    : '';
                payload.itemId = selectedAction.id;
                payload.projectName = ancestors || null;
                payload.text = `Worked on: ${selectedAction.name} (${durStr})`;
            } else {
                const name = actionInput.value.trim();
                payload.itemId = null;
                payload.text = `Worked on: ${name} (${durStr})`;
            }

            const entry = postTimelineOptimistic(payload);
        } else {
            // Break
            const durationMs = planEndMs - planStartMs;
            const hrs = Math.floor(durationMs / 3600000);
            const mins = Math.floor((durationMs % 3600000) / 60000);
            const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

            const entry = postTimelineOptimistic({
                type: 'break',
                startTime: planStartMs,
                endTime: planEndMs,
                text: `Break (${durStr})`,
            });
        }

        renderTimeline();
    });
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
        degradeEntryContexts(entry.id);
        delTimelineOptimistic(entry.id);
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
        degradeEntryContexts(entry.id);
        delTimelineOptimistic(entry.id);
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
        degradeEntryContexts(entry.id);
        delTimelineOptimistic(entry.id);
        renderTimeline();
    });

    el.appendChild(dot);
    el.appendChild(content);
    el.appendChild(del);

    return el;
}

function createPlannedTimeBlock(entry, isPhantom = false) {
    const el = document.createElement('div');
    const viewingToday = isCurrentDay(state.timelineViewDate);
    const nowMs = Date.now();
    // Compute effective start/end for dynamic-start entries
    // renderTimeline may have already pushed timestamps (entry._origTimestamp set)
    const isDynamic = entry.dynamicStart && (entry._origTimestamp != null || (function () {
        const { dayStart: _ds } = getDayBoundaries(state.timelineViewDate);
        const pb = Math.max(_ds.getTime(), viewingToday ? nowMs : 0);
        return pb > entry.timestamp;
    })());
    const effectiveStart = entry.timestamp; // already pushed by renderTimeline if applicable
    const effectiveEnd = entry.endTime;
    const remainingMs = Math.max(0, effectiveEnd - effectiveStart);
    const isExpiring = isDynamic && remainingMs > 0 && remainingMs <= 5 * 60000;
    const isExpired = isDynamic && remainingMs <= 0;

    const isBuffer = !!entry.bufferType;
    let classes = 'time-block time-block-planned focusable-block';
    if (isPhantom) classes += ' time-block-phantom';
    if (isBuffer) classes += ` time-block-buffer time-block-buffer-${entry.bufferType}`;
    if (entry.dynamicStart) classes += ' time-block-dynamic';
    if (isExpiring) classes += ' time-block-expiring';
    if (isExpired) classes += ' time-block-expired';
    el.className = classes;
    el.dataset.id = entry.id;
    el.dataset.startTime = effectiveStart;
    el.dataset.endTime = effectiveEnd;
    el.style.cursor = 'pointer';
    const bufferIcon = entry.bufferType === 'prep' ? '🎒' : entry.bufferType === 'winddown' ? '🧹' : null;
    el.addEventListener('click', () => toggleSessionFocus({
        startMs: effectiveStart, endMs: effectiveEnd,
        label: entry.text || 'Planned', type: 'planned',
        icon: bufferIcon || (entry.dynamicStart ? 'FLEX' : '📌'),
        projectName: entry.projectName || null,
        itemId: entry.itemId || null,
        entryId: entry.id,
        segmentKey: buildSegmentContext(getDateKey(new Date(entry.timestamp)), entry.timestamp, entry.endTime),
    }));

    const durationMs = Math.max(0, effectiveEnd - effectiveStart);
    const hrs = Math.floor(durationMs / 3600000);
    const mins = Math.floor((durationMs % 3600000) / 60000);

    // Icon
    const icon = document.createElement('div');
    icon.className = 'time-block-icon';
    icon.textContent = bufferIcon || (isPhantom ? '⏳' : (entry.dynamicStart ? 'FLEX' : '📌'));

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
            animateActionsZoomIn(() => {
                state.selectedItemId = entry.itemId;
                savePref('selectedItemId', entry.itemId);
                state._animateActions = true;
                renderAll();
                requestAnimationFrame(() => scrollToSelectedItem());
            });
        });
        label.appendChild(locateBtn);
        label.appendChild(labelText);
    }

    const time = document.createElement('div');
    time.className = 'time-block-time';
    time.textContent = `${formatTime(effectiveStart)} – ${formatTime(effectiveEnd)}`;

    const status = document.createElement('div');
    status.className = 'time-block-status';
    if (isExpired) {
        status.textContent = 'Expired';
    } else if (isDynamic) {
        status.textContent = hrs > 0 ? `${hrs}h ${mins}m remaining` : `${mins}m remaining`;
    } else {
        status.textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    }

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

    // Buffer blocks: no edit/delete/start, but keep + (add intention) and drag-drop.
    // We skip past start/edit/delete button creation and fall through for drag-drop + add-intention.

    // Start working button — click to begin working on this planned item
    let startBtn, editBtn, delBtn;
    if (!isBuffer) {
        startBtn = document.createElement('button');
        startBtn.className = 'plan-start-btn';
        startBtn.textContent = '▶';
        startBtn.title = 'Start working on this';
        startBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Keep the plan — planned sessions stay visible until they are past
            await startWorking(entry.itemId, entry.text, entry.projectName, entry.endTime);
        });

        // Edit button (replaces click-to-edit)
        editBtn = document.createElement('button');
        editBtn.className = 'time-block-edit-btn';
        editBtn.textContent = '✏️';
        editBtn.title = 'Edit entry';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEntryEditor(entry, el);
        });

        // Delete button
        delBtn = document.createElement('button');
        delBtn.className = 'plan-delete-btn';
        delBtn.textContent = '×';
        delBtn.title = 'Remove plan';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            deleteBuffersForEntry(entry.id);
            degradeEntryContexts(entry.id);
            delTimelineOptimistic(entry.id);
            renderTimeline();
        });
    }

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
    el.addEventListener('drop', async (e) => {
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
                    const dur = degradeSegmentContext(itemId, oldCtx);
                    await addSegmentContext(Number(itemId), entryCtx, dur);
                })();
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
            // Validate descendant constraint for item-bound sessions
            if (planDescendantIds && !planDescendantIds.has(id)) continue;
            const item = findItemById(id);
            const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
            if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
            await addSegmentContext(id, entryCtx, srcDur || undefined, { move: false });
        }
        clearActionSelection();
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
    if (!isBuffer) {
        el.appendChild(editBtn);
        el.appendChild(startBtn);
    }
    el.appendChild(addIntentBtn);
    if (!isBuffer) {
        el.appendChild(delBtn);
    }

    // ── Nested entry-assigned items (appended after main content) ──
    const allItems = collectAllItems();
    const assignedItems = allItems.filter(a => {
        const item = findItemById(a.id);
        if (!item || !item.timeContexts) return false;
        if (isContextDone(item, entryCtx) && !state.showDone) return false;
        return item.timeContexts.includes(entryCtx);
    });

    if (assignedItems.length > 0) {
        const queue = document.createElement('div');
        queue.className = 'segment-queue';

        let totalEstMins = 0;
        for (const action of assignedItems) {
            const item = findItemById(action.id);
            const estMins = getContextDuration(item, entryCtx);
            const _entryDone = isContextDone(item, entryCtx);
            if (!_entryDone) totalEstMins += estMins;

            const row = document.createElement('div');
            row.className = 'segment-queue-item' + (_entryDone ? ' segment-item-done' : '');
            row.draggable = true;
            row.dataset.itemId = action.id;

            // Drag-out: allow dragging to other blocks
            row.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-segment-item-id', String(action.id));
                e.dataTransfer.setData('application/x-segment-context', entryCtx);
                e.dataTransfer.setData('application/x-drag-source', 'timeline');
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('segment-item-dragging');
                _showAllHorizonLayers();
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('segment-item-dragging');
                _restoreHorizonLayers();
            });

            const bullet = document.createElement('span');
            bullet.className = 'segment-queue-bullet';
            bullet.textContent = _entryDone ? '✓' : '○';

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
                    api.patch(`/items/${action.id}`, { contextDurations: item.contextDurations });
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
                const inv3 = computeTimeInvestment(item, entryCtx);
                const durMins = (inv3 && inv3.budget > 0) ? Math.max(1, inv3.remaining) : (estMins || 30);
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
                animateActionsZoomIn(() => {
                    state.selectedItemId = action.id;
                    savePref('selectedItemId', action.id);
                    state._animateActions = true;
                    renderAll();
                    requestAnimationFrame(() => scrollToSelectedItem());
                });
            });

            // Done button (toggle)
            const doneBtn3 = document.createElement('button');
            doneBtn3.className = 'segment-queue-done';
            doneBtn3.textContent = _entryDone ? '↩' : '✓';
            doneBtn3.title = _entryDone ? 'Mark not done' : 'Mark done';
            doneBtn3.draggable = false;
            doneBtn3.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                if (!item) return;
                const wasDone = isContextDone(item, entryCtx);
                setContextDone(item, entryCtx, !wasDone);
                if (!wasDone) {
                    const anc3 = action._path
                        ? action._path.slice(0, -1).map(p => p.name).join(' › ')
                        : '';
                    postTimelineOptimistic({
                        text: `Done: ${action.name}`,
                        projectName: anc3 || null,
                        type: 'completion'
                    });
                }
                renderAll();
            });

            row.appendChild(bullet);
            row.appendChild(locateBtn3);
            row.appendChild(nameSpan);
            row.appendChild(est);
            row.appendChild(doneBtn3);
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
                <span class="segment-capacity-label">${_formatDuration(totalEstMins)} / ${_formatDuration(availMins)}</span>
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
    editorIcon.textContent = entry.type === 'break' ? '☕' : entry.type === 'planned' ? (entry.dynamicStart ? 'FLEX' : '📌') : '🔥';

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

    // Dynamic start toggle pill (for planned entries only)
    const dynamicStartBtn = document.createElement('button');
    dynamicStartBtn.type = 'button';
    dynamicStartBtn.className = 'plan-editor-dynamic-toggle';
    dynamicStartBtn.textContent = 'FLEX';
    dynamicStartBtn.title = 'Dynamic start — start time slides with now';
    let dynamicStartActive = !!entry.dynamicStart;
    dynamicStartBtn.classList.toggle('active', dynamicStartActive);
    dynamicStartBtn.addEventListener('click', () => {
        dynamicStartActive = !dynamicStartActive;
        dynamicStartBtn.classList.toggle('active', dynamicStartActive);
        // Update editor icon to reflect
        editorIcon.textContent = entry.type === 'break' ? '☕' : (dynamicStartActive ? 'FLEX' : (entry.type === 'planned' ? '📌' : '🔥'));
    });

    if (entry.type === 'planned') {
        timeRow.appendChild(dynamicStartBtn);
    }
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
        deleteBuffersForEntry(entry.id);
        degradeEntryContexts(entry.id);
        delTimelineOptimistic(entry.id);
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

    // Row 2c: Buffer pills (planned entries only, not buffer entries themselves)
    let bufPrepInput, bufWdInput;
    if (entry.type === 'planned' && !entry.bufferType) {
        const initPrepMins = entry.prepDuration ? Math.round(entry.prepDuration / 60) : 0;
        const initWdMins = entry.windDownDuration ? Math.round(entry.windDownDuration / 60) : 0;

        bufPrepInput = document.createElement('input');
        bufPrepInput.type = 'hidden';
        bufPrepInput.value = String(initPrepMins);

        bufWdInput = document.createElement('input');
        bufWdInput.type = 'hidden';
        bufWdInput.value = String(initWdMins);

        const bufferRow = document.createElement('div');
        bufferRow.className = 'plan-editor-row buffer-pill-row';

        const createBufferPill = (emoji, hiddenInput, title, isWd, initMins) => {
            const wrapper = document.createElement('span');
            wrapper.className = 'buffer-pill' + (isWd ? ' buffer-pill-wd' : ' buffer-pill-prep')
                + (initMins > 0 ? ' buffer-pill-active' : '');
            wrapper.title = title;

            const emojiSpan = document.createElement('span');
            emojiSpan.className = 'buffer-pill-emoji';
            emojiSpan.textContent = emoji;

            const numInput = document.createElement('input');
            numInput.type = 'number';
            numInput.className = 'buffer-pill-input';
            numInput.min = '0';
            numInput.max = '120';
            numInput.value = initMins > 0 ? String(initMins) : '';
            numInput.placeholder = '0';
            numInput.style.display = initMins > 0 ? '' : 'none';

            const mLabel = document.createElement('span');
            mLabel.className = 'buffer-pill-unit';
            mLabel.textContent = 'm';
            mLabel.style.display = initMins > 0 ? '' : 'none';

            const toggle = () => {
                const isActive = wrapper.classList.contains('buffer-pill-active');
                if (isActive) {
                    wrapper.classList.remove('buffer-pill-active');
                    numInput.style.display = 'none';
                    mLabel.style.display = 'none';
                    numInput.value = '';
                    hiddenInput.value = '0';
                } else {
                    wrapper.classList.add('buffer-pill-active');
                    numInput.style.display = '';
                    mLabel.style.display = '';
                    numInput.value = '5';
                    hiddenInput.value = '5';
                    setTimeout(() => { numInput.focus(); numInput.select(); }, 50);
                }
            };

            emojiSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                toggle();
            });

            numInput.addEventListener('input', () => {
                const v = parseInt(numInput.value, 10) || 0;
                hiddenInput.value = String(v);
                if (v <= 0) {
                    wrapper.classList.remove('buffer-pill-active');
                    numInput.style.display = 'none';
                    mLabel.style.display = 'none';
                    hiddenInput.value = '0';
                }
            });

            numInput.addEventListener('click', (e) => e.stopPropagation());

            wrapper.appendChild(emojiSpan);
            wrapper.appendChild(numInput);
            wrapper.appendChild(mLabel);
            return wrapper;
        };

        bufferRow.appendChild(createBufferPill('🎒', bufPrepInput, 'Prep time before session', false, initPrepMins));
        bufferRow.appendChild(createBufferPill('🧹', bufWdInput, 'Wind-down time after session', true, initWdMins));
        bufferRow.appendChild(bufPrepInput);
        bufferRow.appendChild(bufWdInput);
        editorContent.appendChild(bufferRow);
    }

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
            dynamicStart: dynamicStartActive ? true : false,
        };

        // Include buffer durations for planned entries
        if (entry.type === 'planned' && !entry.bufferType && bufPrepInput && bufWdInput) {
            const prepMins = parseInt(bufPrepInput.value, 10) || 0;
            const wdMins = parseInt(bufWdInput.value, 10) || 0;
            updates.prepDuration = prepMins > 0 ? prepMins * 60 : 0;
            updates.windDownDuration = wdMins > 0 ? wdMins * 60 : 0;
        }

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

        patchTimelineOptimistic(entry.id, updates);

        // Sync buffer entries if this is a planned entry
        if (entry.type === 'planned' && !entry.bufferType) {
            // Update entry in-place so syncBufferEntries sees current values
            Object.assign(entry, updates);
            syncBufferEntries(entry);
        }

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
                    api.patch(`/items/${itemId}`, patch);
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
    const weekTodayBtn = document.getElementById('week-nav-today-btn');

    // Hide 'This Week' unless we're in week horizon
    if (state.viewHorizon !== 'week') {
        if (weekTodayBtn) weekTodayBtn.style.display = 'none';
    }

    // Always update the day layer label to show the actual date
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    let dateText = viewDate.toLocaleDateString('en-US', options);
    if (viewDate.getFullYear() !== now.getFullYear()) {
        dateText += `, ${viewDate.getFullYear()}`;
    }
    if (dateEl) dateEl.textContent = dateText;

    if (state.viewHorizon === 'month' || state.viewHorizon === 'epoch' || state.viewHorizon === 'session') {
        // Non-day horizons: hide day-level Today button and picker
        if (todayBtn) todayBtn.style.display = 'none';
        if (pickerEl) pickerEl.style.display = 'none';
        return;
    }

    if (state.viewHorizon === 'week') {
        // Week mode: update week layer elements only (day layer label already set above)
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
        }
        // Update the week layer label
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
        if (weekTodayBtn) {
            weekTodayBtn.style.display = weekKey === currentWeek ? 'none' : '';
        }
        // Day layer buttons are hidden by renderHorizonTower when not in day mode
        if (todayBtn) todayBtn.style.display = 'none';
        if (pickerEl) pickerEl.style.display = 'none';
        return;
    }

    // Day mode (dateEl already set above)
    const isToday = isCurrentDay(viewDate);
    if (todayBtn) {
        todayBtn.style.display = isToday ? 'none' : '';
        todayBtn.textContent = 'Today';
    }
    if (pickerEl) {
        pickerEl.style.display = '';
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
                animateActionsZoomOut(() => {
                    state.selectedItemId = null;
                    savePref('selectedItemId', '');
                    state._animateActions = true;
                    renderAll();
                });
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
                        animateActionsZoomOut(() => {
                            state.selectedItemId = ancestor.id;
                            savePref('selectedItemId', ancestor.id);
                            state._animateActions = true;
                            renderAll();
                            requestAnimationFrame(() => scrollToSelectedItem());
                        });
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
        // Session segment — shown directly like other horizons
        const sessionSeg = document.createElement('span');
        sessionSeg.className = 'breadcrumb-segment breadcrumb-current';
        const timeRange = `${formatTime(focusedSession.startMs)}–${formatTime(focusedSession.endMs)}`;
        const typeLabel = focusedSession.label || focusedSession.type || '';
        sessionSeg.textContent = `📅 ${timeRange} ${typeLabel}`.trim();
        whenContainer.appendChild(sessionSeg);
    } else if (state.viewHorizon === 'epoch') {
        // Epoch view
        const epochIcons = { past: '📜', ongoing: '📦', future: '🔮' };
        const epochLabels = { past: 'Past', ongoing: 'Ongoing', future: 'Future' };
        const epochSeg = document.createElement('span');
        epochSeg.className = 'breadcrumb-segment breadcrumb-current';
        epochSeg.textContent = `${epochIcons[state.epochFilter] || '📦'} ${epochLabels[state.epochFilter] || 'Ongoing'}`;
        whenContainer.appendChild(epochSeg);
    } else if (state.viewHorizon === 'month') {
        // Month view
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const monthSeg = document.createElement('span');
        monthSeg.className = 'breadcrumb-segment breadcrumb-current';
        monthSeg.textContent = `🗓️ ${monthNames[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
        whenContainer.appendChild(monthSeg);
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
    } else if (state.viewHorizon === 'live') {
        // Live horizon — show current reality
        const liveSeg = document.createElement('span');
        liveSeg.className = 'breadcrumb-segment breadcrumb-current';
        if (state.workingOn) {
            liveSeg.textContent = `🔥 ${state.workingOn.itemName || 'Working'}`;
        } else if (state.onBreak) {
            liveSeg.textContent = '☕ Break';
        } else if (isInSleepRange()) {
            liveSeg.textContent = '🌙 Sleep';
        } else {
            liveSeg.textContent = '💤 Idle';
        }
        whenContainer.appendChild(liveSeg);
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

// ─── Header Overlap Detection ───
// When the breadcrumb-what + live indicator + right-cluster overlap, stack vertically
function checkHeaderOverlap() {
    const header = document.getElementById('section-header-actions');
    if (!header) return;
    const whatEl = header.querySelector('.header-breadcrumb-what');
    const rightEl = header.querySelector('.header-right-cluster');
    const liveEl = header.querySelector('.header-live-slot');
    if (!whatEl || !rightEl) return;

    // Temporarily remove stacked class to measure natural row layout
    header.classList.remove('section-header-stacked');

    requestAnimationFrame(() => {
        const whatRect = whatEl.getBoundingClientRect();
        const rightRect = rightEl.getBoundingClientRect();
        const gap = 8; // minimum gap in px before stacking

        let overlaps = whatRect.right > rightRect.left - gap;

        // Also check live slot content overlap (it's absolutely positioned, so check its children)
        if (!overlaps && liveEl && liveEl.children.length > 0) {
            const liveRect = liveEl.children[0].getBoundingClientRect();
            // Live content overlaps with right-cluster?
            overlaps = liveRect.right > rightRect.left - gap;
            // Live content overlaps with what-breadcrumb?
            if (!overlaps) {
                overlaps = whatRect.right > liveRect.left - gap;
            }
        }

        header.classList.toggle('section-header-stacked', overlaps);
    });
}

// ─── Duration Picker Popover ───
function showDurationPicker(anchorEl, itemId, itemName, projectName, retroStartMs) {
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
            await startWorking(itemId, itemName, projectName, targetEnd, retroStartMs);
        });
        presets.appendChild(btn);
    }
    picker.appendChild(presets);

    // Eagerly check overlap for the shortest preset (or pre-filled remaining)
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

    // Pre-fill with remaining time if the item has planned time with investment
    const _dpItem = findItemById(itemId);
    const _dpRemaining = _dpItem ? getRemainingDuration(_dpItem) : 0;
    if (_dpRemaining > 0) {
        input.value = _dpRemaining;
    }
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
        dismissDurationPicker();
        if (mins > 0) {
            const targetEnd = Date.now() + mins * 60000;
            await startWorking(itemId, itemName, projectName, targetEnd, retroStartMs);
        } else {
            await startWorking(itemId, itemName, projectName, null, retroStartMs);
        }
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

    // Focus the custom input and check overlap for pre-filled value
    setTimeout(() => {
        input.focus();
        if (_dpRemaining > 0) checkOverlap(_dpRemaining, warning);
    }, 50);
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
    input.min = '1';

    // Unit toggle state: 'min' or 'hr'
    let unit = 'min';

    // Pre-fill with existing context-aware estimate
    const existingItem = findItemById(itemId);
    const existingEst = getContextDuration(existingItem, currentCtx);
    if (existingEst) {
        if (existingEst >= 60 && existingEst % 60 === 0) {
            unit = 'hr';
            input.value = existingEst / 60;
        } else {
            input.value = existingEst;
        }
    }

    input.placeholder = unit === 'hr' ? 'hr' : 'min';
    input.max = unit === 'hr' ? '8' : '480';

    // Unit toggle button (min ↔ hr)
    const unitToggle = document.createElement('button');
    unitToggle.className = 'duration-picker-unit-toggle';
    unitToggle.textContent = unit;
    unitToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const curVal = parseFloat(input.value);
        if (unit === 'min') {
            unit = 'hr';
            unitToggle.textContent = 'hr';
            input.placeholder = 'hr';
            input.max = '8';
            if (curVal > 0) input.value = Math.round((curVal / 60) * 10) / 10;
        } else {
            unit = 'min';
            unitToggle.textContent = 'min';
            input.placeholder = 'min';
            input.max = '480';
            if (curVal > 0) input.value = Math.round(curVal * 60);
        }
        input.focus();
    });

    const setBtn = document.createElement('button');
    setBtn.className = 'duration-picker-start';
    setBtn.textContent = 'Set';
    setBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const rawVal = parseFloat(input.value);
        if (!rawVal || rawVal <= 0) return;
        const mins = unit === 'hr' ? Math.round(rawVal * 60) : Math.round(rawVal);
        dismissDurationPicker();
        await setEstimate(itemId, mins);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') setBtn.click();
        if (e.key === 'Escape') dismissDurationPicker();
    });

    customRow.appendChild(input);
    customRow.appendChild(unitToggle);
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
        api.patch(`/items/${itemId}`, { contextDurations: item.contextDurations });
    } else {
        item.contextDurations[ctx] = mins;
        api.patch(`/items/${itemId}`, { contextDurations: item.contextDurations });
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
    api.patch(`/items/${itemId}`, { contextLeadTimes: item.contextLeadTimes || {} });
    renderAll();
}

// Dismiss a lead-time ghost for a specific deadline context on a specific view context.
// e.g. dismissLeadTimeGhost(123, "2026-04-15", "2026-02-25") → ghost for April 15 deadline won't show on Feb 25.
async function dismissLeadTimeGhost(itemId, deadlineCtx, viewCtx) {
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.leadTimeDismissed) item.leadTimeDismissed = {};
    if (!item.leadTimeDismissed[deadlineCtx]) item.leadTimeDismissed[deadlineCtx] = [];
    if (!item.leadTimeDismissed[deadlineCtx].includes(viewCtx)) {
        item.leadTimeDismissed[deadlineCtx].push(viewCtx);
    }
    api.patch(`/items/${itemId}`, { leadTimeDismissed: item.leadTimeDismissed });
    renderAll();
}

// Schedule a lead-time ghost — promotes it into a real action for the current view context.
async function scheduleLeadTimeGhost(itemId, viewCtx) {
    await addTimeContext(itemId, viewCtx);
}

// ─── Pressure Bar ───
function _formatDuration(mins) {
    if (mins < 0) return '-' + _formatDuration(-mins);
    if (mins >= 60) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m ? `${h}h${m}m` : `${h}h`;
    }
    return `${mins}m`;
}

// ── Compute capacity breakdown for a single day ──
// Returns { doneMins, idleMins, plannedMins, freeMins, totalMins }
function computeDayCapacity(viewDate) {
    const { now, dayStart, dayEnd } = getDayBoundaries(viewDate);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();
    const nowMs = now.getTime();
    const viewingToday = isCurrentDay(viewDate);
    const totalMins = Math.round((dayEndMs - dayStartMs) / 60000);

    // ── Done: sum of completed work/break entries in the day ──
    const dayEntries = (state.timeline?.entries || [])
        .filter(e => e.endTime && (e.type === 'work' || e.type === 'break'))
        .filter(e => e.timestamp < dayEndMs && e.endTime > dayStartMs);

    let doneMs = 0;
    for (const e of dayEntries) {
        const s = Math.max(e.timestamp, dayStartMs);
        const end = Math.min(e.endTime, dayEndMs);
        if (end > s) doneMs += end - s;
    }

    // Include live work/break as done-in-progress
    if (viewingToday && state.workingOn) {
        const s = Math.max(state.workingOn.startTime, dayStartMs);
        const end = Math.min(nowMs, dayEndMs);
        if (end > s) doneMs += end - s;
    }
    if (viewingToday && state.onBreak) {
        const s = Math.max(state.onBreak.startTime, dayStartMs);
        const end = Math.min(nowMs, dayEndMs);
        if (end > s) doneMs += end - s;
    }

    const doneMins = Math.round(doneMs / 60000);

    // ── Elapsed time (for idle calculation) ──
    let elapsedMs = 0;
    if (viewingToday) {
        elapsedMs = Math.max(0, Math.min(nowMs, dayEndMs) - dayStartMs);
    } else if (dayEndMs <= nowMs) {
        // Past day — entire day elapsed
        elapsedMs = dayEndMs - dayStartMs;
    }
    // else: future day — no elapsed time

    const elapsedMins = Math.round(elapsedMs / 60000);
    const idleMins = Math.max(0, elapsedMins - doneMins);

    // ── Future available time ──
    let futureMins = 0;
    if (viewingToday) {
        futureMins = Math.max(0, Math.round((dayEndMs - Math.max(nowMs, dayStartMs)) / 60000));
    } else if (dayStartMs > nowMs) {
        // Future day — all waking hours are future
        futureMins = totalMins;
    }
    // else: past day — no future time

    // ── Planned: sum estimated durations of undone items assigned to this day ──
    // (This is demand from items visible in the actions list for this day)
    // We compute this in updateCapacitySummary since it depends on sortedActions

    return { doneMins, idleMins, plannedMins: 0, freeMins: futureMins, totalMins };
}

// ── Compute capacity for a session ──
function computeSessionCapacity(session) {
    const nowMs = Date.now();
    const totalMs = session.endMs - session.startMs;
    const totalMins = Math.round(totalMs / 60000);

    // Done: completed entries within session window
    const sessionEntries = (state.timeline?.entries || [])
        .filter(e => e.endTime && (e.type === 'work' || e.type === 'break'))
        .filter(e => e.timestamp < session.endMs && e.endTime > session.startMs);

    let doneMs = 0;
    for (const e of sessionEntries) {
        const s = Math.max(e.timestamp, session.startMs);
        const end = Math.min(e.endTime, session.endMs);
        if (end > s) doneMs += end - s;
    }

    // Live work/break
    if (state.workingOn) {
        const s = Math.max(state.workingOn.startTime, session.startMs);
        const end = Math.min(nowMs, session.endMs);
        if (end > s) doneMs += end - s;
    }
    if (state.onBreak) {
        const s = Math.max(state.onBreak.startTime, session.startMs);
        const end = Math.min(nowMs, session.endMs);
        if (end > s) doneMs += end - s;
    }

    const doneMins = Math.round(doneMs / 60000);
    const elapsedMs = Math.max(0, Math.min(nowMs, session.endMs) - session.startMs);
    const elapsedMins = Math.round(elapsedMs / 60000);
    const idleMins = Math.max(0, elapsedMins - doneMins);
    const futureMins = Math.max(0, totalMins - elapsedMins);

    return { doneMins, idleMins, plannedMins: 0, freeMins: futureMins, totalMins };
}

let _lastCapacityPlanned = 0; // Cached for tick-based refresh
let _lastCapacityTickMs = 0;

// Lightweight tick: recompute time-dependent capacity (done/idle/free) and
// re-render the bar using the cached plannedMins from the last full render.
function _tickCapacityBar() {
    const now = Date.now();
    if (now - _lastCapacityTickMs < 60000) return; // Throttle to once per minute
    _lastCapacityTickMs = now;

    const bar = document.getElementById('pressure-bar');
    const doneEl = document.getElementById('pressure-bar-done');
    const idleEl = document.getElementById('pressure-bar-idle');
    const plannedEl = document.getElementById('pressure-bar-planned');
    const label = document.getElementById('pressure-bar-label');
    if (!bar || !doneEl || !idleEl || !plannedEl || !label) return;

    // Skip non-time-based horizons
    if (state.viewHorizon === 'epoch') return;
    if (state.viewHorizon === 'live' && state.queueSessionStart) return;

    // Skip if inside a focused session (handled by _updateLiveCapacityBar)
    const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    if (focusedSession) return;

    // Recompute time-dependent values
    let doneMins = 0, idleMins = 0, freeMins = 0, totalMins = 0;

    if (state.viewHorizon === 'month') {
        const monthKey = getMonthKey(state.timelineViewDate);
        const monthRange = getMonthDateRange(monthKey);
        if (monthRange) {
            const cursor = new Date(monthRange.start);
            while (cursor <= monthRange.end) {
                const dayC = computeDayCapacity(new Date(cursor));
                doneMins += dayC.doneMins;
                idleMins += dayC.idleMins;
                freeMins += dayC.freeMins;
                totalMins += dayC.totalMins;
                cursor.setDate(cursor.getDate() + 1);
            }
        }
    } else if (state.viewHorizon === 'week') {
        const weekKey = getWeekKey(state.timelineViewDate);
        const weekRange = getWeekDateRange(weekKey);
        if (weekRange) {
            const cursor = new Date(weekRange.start);
            while (cursor <= weekRange.end) {
                const dayC = computeDayCapacity(new Date(cursor));
                doneMins += dayC.doneMins;
                idleMins += dayC.idleMins;
                freeMins += dayC.freeMins;
                totalMins += dayC.totalMins;
                cursor.setDate(cursor.getDate() + 1);
            }
        }
    } else {
        const dayC = computeDayCapacity(state.timelineViewDate);
        doneMins = dayC.doneMins;
        idleMins = dayC.idleMins;
        freeMins = dayC.freeMins;
        totalMins = dayC.totalMins;
    }

    const plannedMins = _lastCapacityPlanned;
    const isOver = plannedMins > freeMins;
    const effectivePlanned = Math.min(plannedMins, freeMins);
    const effectiveFree = freeMins - plannedMins;

    if (totalMins <= 0) return;

    const donePct = (doneMins / totalMins) * 100;
    const idlePct = (idleMins / totalMins) * 100;
    const plannedPct = (effectivePlanned / totalMins) * 100;

    doneEl.style.width = `${donePct}%`;
    idleEl.style.width = `${idlePct}%`;
    plannedEl.style.width = `${plannedPct}%`;
    bar.classList.toggle('over-capacity', isOver);

    // Update label
    const parts = [];
    if (doneMins > 0) parts.push(`${_formatDuration(doneMins)} done`);
    if (plannedMins > 0) parts.push(`${_formatDuration(plannedMins)} planned`);
    if (effectiveFree >= 0) {
        parts.push(`${_formatDuration(effectiveFree)} free`);
    } else {
        parts.push(`${_formatDuration(-effectiveFree)} over`);
    }
    label.textContent = parts.join(' · ');

    // Update hover label with idle
    const hoverParts = [];
    if (doneMins > 0) hoverParts.push(`${_formatDuration(doneMins)} done`);
    if (idleMins > 0) hoverParts.push(`${_formatDuration(idleMins)} idle`);
    if (plannedMins > 0) hoverParts.push(`${_formatDuration(plannedMins)} planned`);
    if (effectiveFree >= 0) {
        hoverParts.push(`${_formatDuration(effectiveFree)} free`);
    } else {
        hoverParts.push(`${_formatDuration(-effectiveFree)} over`);
    }
    bar.title = hoverParts.join(' · ');
}

function updateCapacitySummary(sortedActions) {
    const bar = document.getElementById('pressure-bar');
    const doneEl = document.getElementById('pressure-bar-done');
    const idleEl = document.getElementById('pressure-bar-idle');
    const plannedEl = document.getElementById('pressure-bar-planned');
    const label = document.getElementById('pressure-bar-label');
    if (!bar || !doneEl || !idleEl || !plannedEl || !label) return;

    const _capCtx = getCurrentViewContext();
    const undone = sortedActions.filter(a => !isContextDone(a, _capCtx));

    // ── Compute planned: aggregate ALL undone items whose timeContexts
    // fall within the viewed date range (not just the current context level) ──
    const focusedSession = state.focusStack.length > 0 ? state.focusStack[state.focusStack.length - 1] : null;
    // For session focus, match items with the segment key OR the entry key
    const sessionKeys = new Set();
    if (focusedSession?.segmentKey) sessionKeys.add(focusedSession.segmentKey);
    if (focusedSession?.entryId) {
        const dateKey = getDateKey(focusedSession.startMs ? new Date(focusedSession.startMs) : state.timelineViewDate);
        sessionKeys.add(`${dateKey}@entry:${focusedSession.entryId}`);
    }
    let viewStartDate, viewEndDate;

    if (sessionKeys.size === 0) {
        // Non-session: compute date range for the horizon
        if (state.viewHorizon === 'month') {
            const monthKey = getMonthKey(state.timelineViewDate);
            const range = getMonthDateRange(monthKey);
            if (range) {
                viewStartDate = getDateKey(range.start);
                viewEndDate = getDateKey(range.end);
            }
        } else if (state.viewHorizon === 'week') {
            const weekKey = getWeekKey(state.timelineViewDate);
            const range = getWeekDateRange(weekKey);
            if (range) {
                viewStartDate = getDateKey(range.start);
                viewEndDate = getDateKey(range.end);
            }
        } else {
            // Day
            viewStartDate = viewEndDate = getDateKey(state.timelineViewDate);
        }
    }

    // Helper: does a time context fall within the viewed range?
    // Only match contexts at the SAME specificity level or finer than the current horizon.
    // Day view → only day/segment contexts. Week → day+week. Month → all.
    const horizon = state.viewHorizon || 'day';
    function contextInRange(ctx) {
        const parsed = parseTimeContext(ctx);
        if (!parsed) return false;
        // Date or segment: always eligible — check if the date is in range
        if (parsed.date) return parsed.date >= viewStartDate && parsed.date <= viewEndDate;
        // Week: only count in week or month views
        if (parsed.week) {
            if (horizon === 'day') return false; // Don't inflate day bar with week items
            const wRange = getWeekDateRange('week:' + parsed.week);
            if (!wRange) return false;
            const wStart = getDateKey(wRange.start);
            const wEnd = getDateKey(wRange.end);
            return wEnd >= viewStartDate && wStart <= viewEndDate;
        }
        // Month: only count in month view
        if (parsed.month) {
            if (horizon === 'day' || horizon === 'week') return false;
            const mRange = getMonthDateRange('month:' + parsed.month);
            if (!mRange) return false;
            const mStart = getDateKey(mRange.start);
            const mEnd = getDateKey(mRange.end);
            return mEnd >= viewStartDate && mStart <= viewEndDate;
        }
        return false;
    }

    // ── Recursive subtree planned duration (absorption / expansion) ──
    // At each node: effectivePlanned = max(ownDuration, childrenSum)
    // This absorbs descendants into a parent's envelope, or expands when
    // children exceed the parent's estimate.
    const _getMatchingCtx = (tcs) => {
        if (sessionKeys.size > 0) {
            return tcs.find(tc => sessionKeys.has(tc));
        } else {
            return tcs.find(tc => contextInRange(tc));
        }
    };

    // Compute time window for invested-time clipping
    let _capacityWindow = null;
    if (sessionKeys.size > 0 && focusedSession) {
        _capacityWindow = { startMs: focusedSession.startMs, endMs: focusedSession.endMs };
    } else if (viewStartDate && viewEndDate) {
        const sw = getTimeWindowForContext(viewStartDate);
        const ew = getTimeWindowForContext(viewEndDate);
        if (sw && ew) _capacityWindow = { startMs: sw.startMs, endMs: ew.endMs };
    }

    function _itemInvestedMins(item) {
        if (!_workEntryIndex) _buildWorkEntryIndex();
        let ms = 0;
        const entries = _workEntryIndex.get(item.id);
        if (entries) {
            for (const e of entries) {
                if (!_capacityWindow) {
                    ms += (e.endTime - e.startTime);
                } else {
                    const s = Math.max(e.startTime, _capacityWindow.startMs);
                    const end = Math.min(e.endTime, _capacityWindow.endMs);
                    if (end > s) ms += (end - s);
                }
            }
        }
        // Count live work-in-progress
        if (state.workingOn && state.workingOn.itemId === item.id) {
            const nowMs = Date.now();
            if (!_capacityWindow) {
                ms += (nowMs - state.workingOn.startTime);
            } else {
                const s = Math.max(state.workingOn.startTime, _capacityWindow.startMs);
                const end = Math.min(nowMs, _capacityWindow.endMs);
                if (end > s) ms += (end - s);
            }
        }
        return Math.round(ms / 60000);
    }

    function computeSubtreePlanned(item) {
        if (!item || isContextDone(item, _capCtx)) return { planned: 0, missing: [] };

        // Process children first
        let childrenPlanned = 0;
        let childrenMissing = [];
        let hasMatchingChildren = false;

        if (item.children && item.children.length > 0) {
            for (const child of item.children) {
                const r = computeSubtreePlanned(child);
                if (r.planned > 0 || r.missing.length > 0) hasMatchingChildren = true;
                childrenPlanned += r.planned;
                childrenMissing.push(...r.missing);
            }
        }

        // Check this item's own match
        const tcs = item.timeContexts || [];
        const matchingCtx = _getMatchingCtx(tcs);

        if (!matchingCtx && !hasMatchingChildren) {
            return { planned: 0, missing: [] };
        }

        if (!matchingCtx) {
            // Item itself doesn't match, but children do → pass through
            return { planned: childrenPlanned, missing: childrenMissing };
        }

        const ownDur = item.contextDurations?.[matchingCtx] ?? item.estimatedDuration ?? 0;
        // Deduct invested time so only remaining demand counts against capacity
        const itemInvested = _itemInvestedMins(item);
        const effectiveOwnDur = Math.max(0, ownDur - itemInvested);

        if (hasMatchingChildren) {
            // Recursive absorption/expansion: max of effective envelope vs children sum
            return { planned: Math.max(effectiveOwnDur, childrenPlanned), missing: childrenMissing };
        }

        // Leaf node (or no children match the current view)
        if (effectiveOwnDur > 0) {
            return { planned: effectiveOwnDur, missing: [] };
        } else if (ownDur > 0) {
            // Had duration but fully invested — no "missing" warning
            return { planned: 0, missing: [] };
        } else {
            return { planned: 0, missing: [{ id: item.id, name: item.name || '?' }] };
        }
    }

    // Walk the root items tree
    let plannedMins = 0;
    const missingDurItems = [];

    for (const rootItem of (state.items.items || [])) {
        if (rootItem.isInbox) {
            // Inbox: process children without counting inbox item itself
            if (rootItem.children) {
                for (const child of rootItem.children) {
                    const r = computeSubtreePlanned(child);
                    plannedMins += r.planned;
                    missingDurItems.push(...r.missing);
                }
            }
            continue;
        }
        const r = computeSubtreePlanned(rootItem);
        plannedMins += r.planned;
        missingDurItems.push(...r.missing);
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
        doneEl.style.width = '0%';
        idleEl.style.width = '0%';
        plannedEl.style.width = '0%';
        const epochLabels = { past: 'past', ongoing: 'backlog', future: 'aspirations' };
        label.textContent = plannedMins > 0 ? `~${_formatDuration(plannedMins)} ${epochLabels[state.epochFilter] || 'backlog'}` : `${undone.length} item${undone.length !== 1 ? 's' : ''}`;
        return;
    }
    bar.classList.remove('pressure-bar-text-only');

    // ── Live context: queue-session-based capacity ──
    if (state.viewHorizon === 'live' && state.queueSessionStart) {
        const sessionStart = state.queueSessionStart;
        const nowMs = Date.now();

        // Done: sum durations of timeline work+break entries since session start
        let doneMs = 0;
        for (const e of (state.timeline?.entries || [])) {
            if (!e.startTime || !e.endTime) continue;
            if (e.startTime < sessionStart) continue;
            if (e.type === 'work' || e.type === 'break') {
                doneMs += (e.endTime - e.startTime);
            }
        }

        // Active: elapsed time of current work or break
        let activeMs = 0;
        if (state.workingOn) {
            activeMs = nowMs - state.workingOn.startTime;
        } else if (state.onBreak) {
            activeMs = nowMs - state.onBreak.startTime;
        }

        // Remaining: sum of queue durationMs
        let remainingMs = 0;
        for (const q of state.focusQueue) {
            remainingMs += (q.durationMs || 0);
        }

        const doneMins = Math.round(doneMs / 60000);
        const activeMins = Math.round(activeMs / 60000);
        const remainingMins = Math.round(remainingMs / 60000);
        const totalMins = doneMins + activeMins + remainingMins;

        if (totalMins <= 0) {
            doneEl.style.width = '0%';
            idleEl.style.width = '0%';
            plannedEl.style.width = '0%';
            label.textContent = state.workingOn ? 'Working' : state.onBreak ? 'Break' : 'Idle';
            bar.classList.remove('over-capacity');
            return;
        }

        const donePct = ((doneMins + activeMins) / totalMins) * 100;
        const plannedPct = (remainingMins / totalMins) * 100;

        doneEl.style.width = `${donePct}%`;
        idleEl.style.width = '0%';
        plannedEl.style.width = `${plannedPct}%`;
        bar.classList.remove('over-capacity');

        // Label
        const parts = [];
        if (doneMins + activeMins > 0) parts.push(`${_formatDuration(doneMins + activeMins)} done`);
        if (remainingMins > 0) parts.push(`${_formatDuration(remainingMins)} remaining`);
        label.textContent = parts.join(' · ');
        bar.title = parts.join(' · ') + ` · ${_formatDuration(totalMins)} total`;

        // Hide missing duration indicator in live context
        const missingEl = document.getElementById('pressure-bar-missing');
        if (missingEl) missingEl.classList.remove('visible');
        return;
    }

    // ── Compute capacity based on horizon ──
    let doneMins = 0, idleMins = 0, freeMins = 0, totalMins = 0;

    if (focusedSession) {
        // Session focus
        const cap = computeSessionCapacity(focusedSession);
        doneMins = cap.doneMins;
        idleMins = cap.idleMins;
        freeMins = cap.freeMins;
        totalMins = cap.totalMins;
    } else if (state.viewHorizon === 'month') {
        // Month: aggregate each day
        const monthKey = getMonthKey(state.timelineViewDate);
        const monthRange = getMonthDateRange(monthKey);
        if (monthRange) {
            const cursor = new Date(monthRange.start);
            while (cursor <= monthRange.end) {
                const dayC = computeDayCapacity(new Date(cursor));
                doneMins += dayC.doneMins;
                idleMins += dayC.idleMins;
                freeMins += dayC.freeMins;
                totalMins += dayC.totalMins;
                cursor.setDate(cursor.getDate() + 1);
            }
        }
    } else if (state.viewHorizon === 'week') {
        // Week: aggregate each day in the week
        const weekKey = getWeekKey(state.timelineViewDate);
        const weekRange = getWeekDateRange(weekKey);
        if (weekRange) {
            const cursor = new Date(weekRange.start);
            while (cursor <= weekRange.end) {
                const dayC = computeDayCapacity(new Date(cursor));
                doneMins += dayC.doneMins;
                idleMins += dayC.idleMins;
                freeMins += dayC.freeMins;
                totalMins += dayC.totalMins;
                cursor.setDate(cursor.getDate() + 1);
            }
        }
    } else {
        // Day level
        const dayC = computeDayCapacity(state.timelineViewDate);
        doneMins = dayC.doneMins;
        idleMins = dayC.idleMins;
        freeMins = dayC.freeMins;
        totalMins = dayC.totalMins;
    }

    // Cache for tick-based refresh
    _lastCapacityPlanned = plannedMins;

    // Clamp planned to not exceed free (excess = over-capacity)
    const isOver = plannedMins > freeMins;
    const effectivePlanned = Math.min(plannedMins, freeMins);
    const effectiveFree = freeMins - plannedMins;

    // ── Render segments as percentages of totalMins ──
    if (totalMins <= 0) {
        doneEl.style.width = '0%';
        idleEl.style.width = '0%';
        plannedEl.style.width = '0%';
        label.textContent = '0m';
        bar.classList.remove('over-capacity');
        return;
    }

    const donePct = (doneMins / totalMins) * 100;
    const idlePct = (idleMins / totalMins) * 100;
    const plannedPct = (effectivePlanned / totalMins) * 100;

    doneEl.style.width = `${donePct}%`;
    idleEl.style.width = `${idlePct}%`;
    plannedEl.style.width = `${plannedPct}%`;
    bar.classList.toggle('over-capacity', isOver);

    // ── Label ──
    const parts = [];
    if (doneMins > 0) parts.push(`${_formatDuration(doneMins)} done`);
    if (plannedMins > 0) parts.push(`${_formatDuration(plannedMins)} planned`);
    if (effectiveFree >= 0) {
        parts.push(`${_formatDuration(effectiveFree)} free`);
    } else {
        parts.push(`${_formatDuration(-effectiveFree)} over`);
    }
    label.textContent = parts.join(' · ');

    // ── Hover label with idle ──
    const hoverParts = [];
    if (doneMins > 0) hoverParts.push(`${_formatDuration(doneMins)} done`);
    if (idleMins > 0) hoverParts.push(`${_formatDuration(idleMins)} idle`);
    if (plannedMins > 0) hoverParts.push(`${_formatDuration(plannedMins)} planned`);
    if (effectiveFree >= 0) {
        hoverParts.push(`${_formatDuration(effectiveFree)} free`);
    } else {
        hoverParts.push(`${_formatDuration(-effectiveFree)} over`);
    }
    bar.title = hoverParts.join(' · ');

    // Re-render reflection panel if open
    if (state.reflectionPanelOpen) renderReflectionPanel();
}

// ─── Reflection Panel (expandable capacity bar drilldown) ───

function _setupReflectionPanelHandler() {
    const bar = document.getElementById('pressure-bar');
    if (!bar || bar._reflectionHandlerAttached) return;
    bar._reflectionHandlerAttached = true;
    bar.style.cursor = 'pointer';
    bar.addEventListener('click', (e) => {
        // Don't toggle if clicking the label or other interactive children
        e.stopPropagation();
        state.reflectionPanelOpen = !state.reflectionPanelOpen;
        const panel = document.getElementById('reflection-panel');
        const chevron = document.getElementById('pressure-bar-chevron');
        if (panel) {
            panel.style.display = state.reflectionPanelOpen ? '' : 'none';
        }
        if (chevron) {
            chevron.classList.toggle('open', state.reflectionPanelOpen);
        }
        if (state.reflectionPanelOpen) renderReflectionPanel();
    });
}

function renderReflectionPanel() {
    const statsEl = document.getElementById('reflection-stats');
    const treeEl = document.getElementById('reflection-tree');
    if (!statsEl || !treeEl) return;

    // Ensure work entry index is fresh
    if (!_workEntryIndex) _buildWorkEntryIndex();

    // For live mode, use session start → now (same as capacity bar's done computation)
    let timeWin;
    if (state.viewHorizon === 'live') {
        if (state.queueSessionStart) {
            timeWin = { startMs: state.queueSessionStart, endMs: Date.now() };
        } else {
            // No active queue session — fall back to day window
            timeWin = getTimeWindowForContext(getDateKey(getLogicalToday()));
        }
    } else {
        const viewCtx = getCurrentViewContext();
        timeWin = getTimeWindowForContext(viewCtx);
    }

    // ── Collect all items in the tree ──
    const allItems = state.items.items;

    // ── Build a set of item IDs that had work entries in this window ──
    const activeItemIds = new Set();
    if (_workEntryIndex) {
        for (const [itemId, entries] of _workEntryIndex) {
            for (const e of entries) {
                if (!timeWin) {
                    // No bounded window (epoch) — all work qualifies
                    activeItemIds.add(itemId);
                    break;
                }
                const s = Math.max(e.startTime, timeWin.startMs);
                const end = Math.min(e.endTime, timeWin.endMs);
                if (end > s) { activeItemIds.add(itemId); break; }
            }
        }
    }

    // ── Inject current live work session as a synthetic entry ──
    if (state.workingOn && state.workingOn.itemId && state.workingOn.startTime) {
        const liveId = state.workingOn.itemId;
        const syntheticEntry = {
            type: 'work',
            itemId: liveId,
            startTime: state.workingOn.startTime,
            endTime: Date.now(),
        };
        // Add to index temporarily
        if (!_workEntryIndex) _workEntryIndex = new Map();
        if (!_workEntryIndex.has(liveId)) _workEntryIndex.set(liveId, []);
        _workEntryIndex.get(liveId).push(syntheticEntry);
        activeItemIds.add(liveId);
        // Tag it so we can clean up after rendering
        syntheticEntry._synthetic = true;
    }

    // ── Build per-item investment + done stats recursively ──
    // An item is relevant if it (or any descendant) had work in the window,
    // or if a descendant is done and had work in the window.
    function _computeSubtreeStats(item) {
        let investedMs = 0;
        let doneCount = 0;
        let totalCount = 0;
        let hasData = false;
        const clippedEntries = []; // individual work sessions clipped to window

        // Compute own invested time from work entries clipped to window
        const entries = _workEntryIndex?.get(item.id);
        if (entries) {
            for (const e of entries) {
                if (!timeWin) {
                    investedMs += (e.endTime - e.startTime);
                    hasData = true;
                    clippedEntries.push({ startMs: e.startTime, endMs: e.endTime, durationMs: e.endTime - e.startTime });
                } else {
                    const s = Math.max(e.startTime, timeWin.startMs);
                    const end = Math.min(e.endTime, timeWin.endMs);
                    if (end > s) {
                        investedMs += (end - s);
                        hasData = true;
                        clippedEntries.push({ startMs: s, endMs: end, durationMs: end - s });
                    }
                }
            }
        }

        // Count this item if it had activity in the window
        if (activeItemIds.has(item.id)) {
            totalCount++;
            if (item.done) doneCount++;
        }

        // Recurse into children
        const childStats = [];
        if (item.children) {
            for (const child of item.children) {
                if (child.isInbox) continue; // skip inbox wrappers
                const cs = _computeSubtreeStats(child);
                investedMs += cs.investedMs;
                doneCount += cs.doneCount;
                totalCount += cs.totalCount;
                if (cs.hasData) hasData = true;
                childStats.push({ item: child, stats: cs });
            }
        }

        return { investedMs, doneCount, totalCount, hasData, childStats, clippedEntries };
    }

    // ── Compute stats for all top-level items ──
    const rootStats = [];
    let totalInvestedMs = 0;
    let totalDone = 0;
    let totalItems = 0;
    for (const item of allItems) {
        if (item.isInbox) {
            // Treat inbox children as roots
            if (item.children) {
                for (const child of item.children) {
                    const stats = _computeSubtreeStats(child);
                    if (stats.hasData || stats.totalCount > 0) {
                        rootStats.push({ item: child, stats });
                        totalInvestedMs += stats.investedMs;
                        totalDone += stats.doneCount;
                        totalItems += stats.totalCount;
                    }
                }
            }
            continue;
        }
        const stats = _computeSubtreeStats(item);
        if (stats.hasData || stats.totalCount > 0) {
            rootStats.push({ item, stats });
            totalInvestedMs += stats.investedMs;
            totalDone += stats.doneCount;
            totalItems += stats.totalCount;
        }
    }

    // Filter by project context if selected
    let displayStats = rootStats;
    if (state.selectedItemId) {
        // Find the selected item and show its children as roots
        const selectedItem = findItemById(state.selectedItemId);
        if (selectedItem) {
            const selStats = _computeSubtreeStats(selectedItem);
            // Show children of selected item as the top-level
            displayStats = selStats.childStats.filter(cs => cs.stats.hasData || cs.stats.totalCount > 0);
            totalInvestedMs = selStats.investedMs;
            totalDone = selStats.doneCount;
            totalItems = selStats.totalCount;
        }
    }

    // Sort by invested time descending (if toggled)
    if (state.reflectionSortByTime) {
        displayStats.sort((a, b) => b.stats.investedMs - a.stats.investedMs);
    }

    // ── Render stats summary ──
    statsEl.innerHTML = '';
    const totalMins = Math.round(totalInvestedMs / 60000);
    const statParts = [];
    if (totalMins > 0) statParts.push(`⏱ ${_formatDuration(totalMins)} invested`);
    if (totalDone > 0) statParts.push(`✓ ${totalDone} done`);
    if (totalItems > 0 && totalItems !== totalDone) statParts.push(`${totalItems} items`);
    if (statParts.length === 0) statParts.push('No activity');

    const statsText = document.createElement('span');
    statsText.textContent = statParts.join(' · ');
    statsEl.appendChild(statsText);

    // Sort toggle button
    const sortBtn = document.createElement('span');
    sortBtn.className = 'reflection-sort-toggle';
    sortBtn.textContent = state.reflectionSortByTime ? '⏱' : '🌳';
    sortBtn.title = state.reflectionSortByTime ? 'Sorted by time · click for tree order' : 'Tree order · click for time order';
    sortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.reflectionSortByTime = !state.reflectionSortByTime;
        renderReflectionPanel();
    });
    statsEl.appendChild(sortBtn);

    // ── Render tree ──
    treeEl.innerHTML = '';
    if (displayStats.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'reflection-tree-empty';
        emptyEl.textContent = 'No data for this context';
        treeEl.appendChild(emptyEl);
        return;
    }

    // Helper: collect all descendant item IDs that have clippedEntries
    function _collectIdsWithEntries(stats) {
        const ids = [];
        for (const cs of stats.childStats) {
            if (cs.stats.clippedEntries.length > 0) ids.push(cs.item.id);
            ids.push(..._collectIdsWithEntries(cs.stats));
        }
        return ids;
    }

    // Helper: expand all tree nodes in a stats subtree (so history entries become visible)
    function _expandAncestors(stats) {
        for (const cs of stats.childStats) {
            if (cs.stats.hasData && cs.stats.childStats.length > 0) {
                state.reflectionExpandedIds.add(cs.item.id);
                _expandAncestors(cs.stats);
            }
        }
    }

    function renderTreeLevel(statsList, container, depth) {
        for (const { item, stats } of statsList) {
            const row = document.createElement('div');
            row.className = 'reflection-tree-row';
            row.style.paddingLeft = `${8 + depth * 16}px`;

            // Expand toggle (if has children with data)
            const relevantChildren = stats.childStats.filter(cs => cs.stats.hasData || cs.stats.totalCount > 0);
            const hasExpandableChildren = relevantChildren.length > 0;
            const isExpanded = state.reflectionExpandedIds.has(item.id);

            const toggle = document.createElement('span');
            toggle.className = 'reflection-tree-toggle' + (hasExpandableChildren ? (isExpanded ? ' expanded' : '') : ' leaf');
            toggle.textContent = '▶';
            if (hasExpandableChildren) {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (state.reflectionExpandedIds.has(item.id)) {
                        state.reflectionExpandedIds.delete(item.id);
                    } else {
                        state.reflectionExpandedIds.add(item.id);
                    }
                    renderReflectionPanel();
                });
            }
            row.appendChild(toggle);

            // Name
            const nameEl = document.createElement('span');
            nameEl.className = 'reflection-tree-name';
            if (item.done) nameEl.classList.add('done');
            nameEl.textContent = item.name;
            row.appendChild(nameEl);

            // Investment badge (clickable — leaf shows own history, parent toggles all descendants)
            const ownMins = Math.round(stats.investedMs / 60000);
            if (ownMins > 0) {
                const durEl = document.createElement('span');
                durEl.className = 'reflection-tree-duration clickable';
                durEl.textContent = _formatDuration(ownMins);
                durEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (stats.clippedEntries.length > 0) {
                        // Leaf or item with own entries — toggle just this one
                        if (state.reflectionHistoryIds.has(item.id)) {
                            state.reflectionHistoryIds.delete(item.id);
                        } else {
                            state.reflectionHistoryIds.add(item.id);
                        }
                    } else {
                        // Parent — toggle all descendants that have entries
                        const descIds = _collectIdsWithEntries(stats);
                        const allShown = descIds.every(id => state.reflectionHistoryIds.has(id));
                        for (const id of descIds) {
                            if (allShown) state.reflectionHistoryIds.delete(id);
                            else state.reflectionHistoryIds.add(id);
                        }
                        // Also expand the tree nodes so the entries are visible
                        if (!allShown) {
                            _expandAncestors(stats);
                        }
                    }
                    renderReflectionPanel();
                });
                row.appendChild(durEl);
            }

            // Done count badge
            if (stats.doneCount > 0) {
                const doneBadge = document.createElement('span');
                doneBadge.className = 'reflection-tree-done-badge';
                doneBadge.textContent = `✓ ${stats.doneCount}`;
                row.appendChild(doneBadge);
            }

            container.appendChild(row);

            // Work entry history (shown when duration badge is tapped)
            if (state.reflectionHistoryIds.has(item.id) && stats.clippedEntries.length > 0) {
                const historyEl = document.createElement('div');
                historyEl.className = 'reflection-history';
                historyEl.style.paddingLeft = `${8 + (depth + 1) * 16}px`;
                const sorted = [...stats.clippedEntries].sort((a, b) => a.startMs - b.startMs);
                const showDate = state.viewHorizon !== 'day' && state.viewHorizon !== 'live';
                const now = new Date();
                const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                for (const entry of sorted) {
                    const entryRow = document.createElement('div');
                    entryRow.className = 'reflection-history-entry';
                    const sd = new Date(entry.startMs);
                    const ed = new Date(entry.endMs);
                    const fmt = d => `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                    const durMins = Math.round(entry.durationMs / 60000);
                    let datePrefix = '';
                    if (showDate) {
                        const diffDays = Math.round((now - sd) / 86400000);
                        if (diffDays === 0 && sd.getDate() === now.getDate()) {
                            datePrefix = 'Today';
                        } else if (diffDays <= 6) {
                            datePrefix = dayNames[sd.getDay()];
                        } else {
                            datePrefix = `${monthNames[sd.getMonth()]} ${sd.getDate()}`;
                        }
                        datePrefix += '  ';
                    }
                    entryRow.textContent = `${datePrefix}${fmt(sd)} – ${fmt(ed)}  ·  ${_formatDuration(durMins)}`;
                    historyEl.appendChild(entryRow);
                }
                container.appendChild(historyEl);
            }

            // Children
            if (isExpanded && hasExpandableChildren) {
                const childContainer = document.createElement('div');
                childContainer.className = 'reflection-tree-children';
                const orderedChildren = state.reflectionSortByTime
                    ? [...relevantChildren].sort((a, b) => b.stats.investedMs - a.stats.investedMs)
                    : relevantChildren;
                renderTreeLevel(orderedChildren, childContainer, depth + 1);
                container.appendChild(childContainer);
            }
        }
    }

    renderTreeLevel(displayStats, treeEl, 0);

    // Clean up synthetic live entry from the index
    if (_workEntryIndex) {
        for (const [id, entries] of _workEntryIndex) {
            const filtered = entries.filter(e => !e._synthetic);
            if (filtered.length === 0) _workEntryIndex.delete(id);
            else _workEntryIndex.set(id, filtered);
        }
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
                api.patch(`/items/${item.id}`, { timeContexts: itm.timeContexts });
            } else if (state.viewHorizon === 'month') {
                // Month → degrade to ongoing
                await sendToOngoing(item.id);
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
        .filter(e => e.endTime && (e.type === 'work' || e.type === 'break' || e.type === 'planned'))
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
        dismissDurationPicker();
        if (mins > 0) {
            const targetEnd = Date.now() + mins * 60000;
            await startBreak(targetEnd);
        } else {
            await startBreak();
        }
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

    postTimelineOptimistic({
        text,
        projectName: projectName,
        type: 'log'
    });
    renderTimeline();
    input.value = '';
}

// ─── Working On Timer ───

// Helper: compute the start time of the current idle period
function _getIdleStartMs() {
    const logicalToday = getLogicalToday();
    const { dayStart } = getDayBoundaries(logicalToday);
    let idleStartMs = dayStart.getTime();
    const entries = (state.timeline && state.timeline.entries) || [];
    const nowMs = Date.now();
    for (const entry of entries) {
        if (entry.endTime && entry.timestamp <= nowMs && (entry.type === 'work' || entry.type === 'break')) {
            if (entry.endTime > idleStartMs && entry.endTime <= nowMs) {
                idleStartMs = entry.endTime;
            }
        }
    }
    return idleStartMs;
}

async function startWorking(itemId, itemName, projectName, targetEndTime, retroactiveStartTime) {
    // Sleep guard: confirm before starting work during sleep
    if (isInSleepRange() && state.settings.sleepGuard !== false) {
        if (!confirm('You\'re in sleep mode. Start working anyway?')) return;
    }
    // If already working on something else, stop it first
    if (state.workingOn) {
        // Spotify-style: always re-queue the interrupted item at the head
        if (state.workingOn.itemId !== itemId) {
            const curEntry = {
                itemId: state.workingOn.itemId,
                itemName: state.workingOn.itemName,
                projectName: state.workingOn.projectName,
                durationMs: state.workingOn.targetEndTime ? Math.max(0, state.workingOn.targetEndTime - Date.now()) : 0,
            };
            state._suppressQueueAdvance = true;
            await stopWorking();
            state._suppressQueueAdvance = false;
            // Re-insert interrupted item at queue head
            state.focusQueue.unshift(curEntry);
            savePref('focusQueue', state.focusQueue);
            // Ensure queue session is tracked
            if (!state.queueSessionStart) {
                state.queueSessionStart = Date.now();
                savePref('queueSessionStart', state.queueSessionStart);
            }
        } else {
            await stopWorking();
        }
    }
    // If on a break, stop it first
    if (state.onBreak) {
        await stopBreak();
    }
    // Remove this item from queue if it was queued (it's now active, not queued)
    if (isInQueue(itemId)) {
        removeFromQueue(itemId);
    }
    const now = Date.now();
    state.workingOn = {
        itemId,
        itemName,
        projectName: projectName || null,
        startTime: retroactiveStartTime || now,
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
    const entry = postTimelineOptimistic({
        text: `Worked on: ${state.workingOn.itemName} (${durStr})`,
        projectName: state.workingOn.projectName,
        type: 'work',
        startTime: state.workingOn.startTime,
        endTime: endTime,
        targetEndTime: state.workingOn.targetEndTime || undefined,
        itemId: state.workingOn.itemId,
    });

    // Degrade all @work contexts back to the day context
    _degradeLiveContexts('work');

    // Clear working state
    state.workingOn = null;
    savePref('workingOn', null);

    // ── Focus Queue: auto-advance to next item ──
    if (!state._suppressQueueAdvance && state.focusQueue.length > 0) {
        await advanceQueue();
        return; // advanceQueue calls renderAll
    }

    // Queue session ended (empty queue or suppressed advance)
    if (state.focusQueue.length === 0 && state.queueSessionStart) {
        state.queueSessionStart = null;
        savePref('queueSessionStart', null);
    }

    renderAll();
}

// restoreWorkingOn — now handled in loadAll() from backend preferences

// ─── Break Timer ───

async function startBreak(targetEndTime) {
    // If working on something, stop it first (suppress queue advance — the break IS the next step)
    if (state.workingOn) {
        state._suppressQueueAdvance = true;
        await stopWorking();
        state._suppressQueueAdvance = false;
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
    const entry = postTimelineOptimistic({
        text: `Break (${durStr})`,
        type: 'break',
        startTime: state.onBreak.startTime,
        endTime: endTime,
        targetEndTime: state.onBreak.targetEndTime || undefined,
    });

    // Degrade all @break contexts back to the day context
    _degradeLiveContexts('break');

    // Clear break state
    state.onBreak = null;
    savePref('onBreak', null);

    // ── Focus Queue: auto-advance to next item after break ──
    if (state.focusQueue.length > 0) {
        await advanceQueue();
        return; // advanceQueue calls renderAll
    }

    // Queue session ended (empty queue after break)
    if (state.queueSessionStart) {
        state.queueSessionStart = null;
        savePref('queueSessionStart', null);
    }

    renderAll();
}

// restoreBreak — now handled in loadAll() from backend preferences

// ─── Commitments System ───
// Items can be "committed" to a time context — a promise to complete them within that window.
// committedContexts is an array on each item: ["2026-03-03", "week:2026-03-01", ...]

function isCommittedInContext(item, contextKey) {
    if (!item || !item.committedContexts) return false;
    return item.committedContexts.includes(contextKey);
}

function commitToContext(itemId, contextKey) {
    const item = findItemById(itemId);
    if (!item) return;
    if (!item.committedContexts) item.committedContexts = [];
    if (item.committedContexts.includes(contextKey)) return; // already committed
    item.committedContexts.push(contextKey);
    api.patch(`/items/${itemId}`, { committedContexts: item.committedContexts }).catch(err => {
        console.error('[commitments] PATCH failed:', err);
        _showSaveError('commitment update');
    });
    renderAll();
}

function uncommitFromContext(itemId, contextKey) {
    const item = findItemById(itemId);
    if (!item || !item.committedContexts) return;
    const idx = item.committedContexts.indexOf(contextKey);
    if (idx === -1) return;
    // Soft penalty: record as broken commitment
    _recordCommitmentResult(contextKey, itemId, item.name, false);
    item.committedContexts.splice(idx, 1);
    api.patch(`/items/${itemId}`, { committedContexts: item.committedContexts }).catch(err => {
        console.error('[commitments] PATCH failed:', err);
        _showSaveError('commitment update');
    });
    renderAll();
}

// Evaluate all commitments for a given date key (e.g., "2026-03-03")
// Returns { kept: [{itemId, name, context}], broken: [{itemId, name, context}] }
function evaluateCommitments(dateKey) {
    const results = { kept: [], broken: [] };
    function walk(items) {
        for (const item of items) {
            if (item.committedContexts && item.committedContexts.includes(dateKey)) {
                const done = isContextDone(item, dateKey) || item.done;
                const entry = { itemId: item.id, name: item.name, context: dateKey };
                if (done) {
                    results.kept.push(entry);
                } else {
                    results.broken.push(entry);
                }
            }
            if (item.children && item.children.length) walk(item.children);
        }
    }
    if (state.items && state.items.items) walk(state.items.items);
    return results;
}

// Record a commitment result in settings.commitmentHistory
function _recordCommitmentResult(contextKey, itemId, itemName, kept) {
    if (!state.settings.commitmentHistory) state.settings.commitmentHistory = [];
    state.settings.commitmentHistory.push({
        date: getTodayLogicalDateKey(),
        context: contextKey,
        itemId,
        name: itemName,
        kept,
        timestamp: Date.now()
    });
    // Keep history bounded (last 500 entries)
    if (state.settings.commitmentHistory.length > 500) {
        state.settings.commitmentHistory = state.settings.commitmentHistory.slice(-500);
    }
}

// Get commitment stats for display
function getCommitmentStats() {
    const history = state.settings.commitmentHistory || [];
    const todayKey = getTodayLogicalDateKey();
    const logicalToday = getLogicalToday();

    // This week
    const weekKey = getWeekKey(logicalToday);
    const weekRange = getWeekDateRange(weekKey);
    const weekStart = weekRange ? weekRange.start.getTime() : 0;

    // This month
    const monthStart = new Date(logicalToday.getFullYear(), logicalToday.getMonth(), 1).getTime();

    let weekKept = 0, weekTotal = 0;
    let monthKept = 0, monthTotal = 0;
    let allKept = 0, allTotal = 0;

    for (const entry of history) {
        allTotal++;
        if (entry.kept) allKept++;
        if (entry.timestamp >= weekStart) {
            weekTotal++;
            if (entry.kept) weekKept++;
        }
        if (entry.timestamp >= monthStart) {
            monthTotal++;
            if (entry.kept) monthKept++;
        }
    }

    return {
        week: { kept: weekKept, total: weekTotal, pct: weekTotal ? Math.round(weekKept / weekTotal * 100) : null },
        month: { kept: monthKept, total: monthTotal, pct: monthTotal ? Math.round(monthKept / monthTotal * 100) : null },
        allTime: { kept: allKept, total: allTotal, pct: allTotal ? Math.round(allKept / allTotal * 100) : null },
        recent: history.slice(-10).reverse()
    };
}

// Show commitment review modal (called before streak check-in on Close Day)
function showCommitmentReview(results, onContinue) {
    const total = results.kept.length + results.broken.length;

    // If no commitments today, skip review
    if (total === 0) {
        onContinue();
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay commitment-review-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-box commitment-review-modal';

    const title = document.createElement('h3');
    title.className = 'commitment-review-title';
    title.textContent = 'Today\'s Commitments';
    modal.appendChild(title);

    const list = document.createElement('div');
    list.className = 'commitment-review-list';
    for (const item of results.kept) {
        const row = document.createElement('div');
        row.className = 'commitment-review-item commitment-kept';
        row.textContent = `✅ ${item.name}`;
        list.appendChild(row);
    }
    for (const item of results.broken) {
        const row = document.createElement('div');
        row.className = 'commitment-review-item commitment-broken';
        row.textContent = `❌ ${item.name}`;
        list.appendChild(row);
    }
    modal.appendChild(list);

    const summary = document.createElement('div');
    summary.className = 'commitment-review-summary';
    summary.textContent = `${results.kept.length}/${total} kept`;
    modal.appendChild(summary);

    // Streak impact preview
    const mode = state.settings.commitmentMode || 'gentle';
    const streakImpact = document.createElement('div');
    streakImpact.className = 'commitment-review-streak-impact';
    const streak = getStreakData();
    if (mode === 'gentle') {
        streakImpact.textContent = `🔥 Streak continues (${streak.count + 1})`;
        streakImpact.classList.add('streak-continues');
    } else if (mode === 'balanced') {
        const pct = total > 0 ? (results.kept.length / total) * 100 : 100;
        if (pct >= 80) {
            streakImpact.textContent = `🔥 Streak continues (${streak.count + 1}) — ${Math.round(pct)}% kept`;
            streakImpact.classList.add('streak-continues');
        } else {
            streakImpact.textContent = `💔 Streak resets — ${Math.round(pct)}% kept (need 80%)`;
            streakImpact.classList.add('streak-resets');
        }
    } else if (mode === 'strict') {
        if (results.broken.length === 0) {
            streakImpact.textContent = `🔥 Streak continues (${streak.count + 1}) — all kept!`;
            streakImpact.classList.add('streak-continues');
        } else {
            streakImpact.textContent = `💔 Streak resets — ${results.broken.length} broken`;
            streakImpact.classList.add('streak-resets');
        }
    }
    modal.appendChild(streakImpact);

    const btnRow = document.createElement('div');
    btnRow.className = 'commitment-review-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'commitment-review-btn';
    closeBtn.textContent = '🌙 Close Day';
    closeBtn.addEventListener('click', () => {
        overlay.remove();
        onContinue();
    });
    btnRow.appendChild(closeBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.remove();
            onContinue();
        }
    });
    document.body.appendChild(overlay);
}

// Show streak expansion panel (commitment history)
function showStreakExpansion() {
    // Close if already open
    const existing = document.querySelector('.streak-expansion-overlay');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.className = 'streak-expansion-overlay';
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    const panel = document.createElement('div');
    panel.className = 'streak-expansion-panel';

    const streak = getStreakData();
    const alive = isStreakAlive(streak);
    const stats = getCommitmentStats();
    const mode = state.settings.commitmentMode || 'gentle';

    // Header
    const header = document.createElement('div');
    header.className = 'streak-expansion-header';
    header.innerHTML = `🔥 <strong>${alive ? streak.count : 0}</strong>-day streak <span class="streak-expansion-best">(Best: ${streak.longestStreak || streak.count})</span>`;
    panel.appendChild(header);

    // Mode indicator
    const modeEl = document.createElement('div');
    modeEl.className = 'streak-expansion-mode';
    const modeLabels = { gentle: '🌱 Gentle', balanced: '⚖️ Balanced', strict: '🎯 Strict' };
    modeEl.textContent = `Mode: ${modeLabels[mode] || mode}`;
    panel.appendChild(modeEl);

    // Stats
    const statsEl = document.createElement('div');
    statsEl.className = 'streak-expansion-stats';
    function statRow(label, s) {
        const row = document.createElement('div');
        row.className = 'streak-expansion-stat-row';
        if (s.total === 0) {
            row.innerHTML = `<span class="streak-stat-label">${label}</span> <span class="streak-stat-value">—</span>`;
        } else {
            row.innerHTML = `<span class="streak-stat-label">${label}</span> <span class="streak-stat-value">${s.kept}/${s.total} <span class="streak-stat-pct">${s.pct}%</span></span>`;
        }
        return row;
    }
    statsEl.appendChild(statRow('This week', stats.week));
    statsEl.appendChild(statRow('This month', stats.month));
    statsEl.appendChild(statRow('All time', stats.allTime));
    panel.appendChild(statsEl);

    // Recent results
    if (stats.recent.length > 0) {
        const recentTitle = document.createElement('div');
        recentTitle.className = 'streak-expansion-recent-title';
        recentTitle.textContent = 'Recent';
        panel.appendChild(recentTitle);

        const recentList = document.createElement('div');
        recentList.className = 'streak-expansion-recent';
        for (const entry of stats.recent) {
            const row = document.createElement('div');
            row.className = 'streak-expansion-recent-item';
            row.textContent = `${entry.kept ? '✅' : '❌'} ${entry.name}`;
            recentList.appendChild(row);
        }
        panel.appendChild(recentList);
    }

    overlay.appendChild(panel);

    // Position panel near streak widget
    const widget = document.getElementById('streak-widget');
    if (widget) {
        const wr = widget.getBoundingClientRect();
        panel.style.position = 'fixed';
        panel.style.top = `${wr.bottom + 8}px`;
        panel.style.right = `${window.innerWidth - wr.right}px`;
    }

    document.body.appendChild(overlay);
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

async function performCheckIn(commitResults) {
    const streak = getStreakData();
    const todayKey = getTodayLogicalDateKey();

    if (hasCheckedInToday(streak)) return; // Already checked in

    const mode = state.settings.commitmentMode || 'gentle';
    let shouldContinue = true;

    // Commitment-mode-aware streak logic
    if (commitResults && mode !== 'gentle') {
        const total = commitResults.kept.length + commitResults.broken.length;
        if (total > 0) {
            if (mode === 'strict') {
                shouldContinue = commitResults.broken.length === 0;
            } else if (mode === 'balanced') {
                const pct = (commitResults.kept.length / total) * 100;
                shouldContinue = pct >= 80;
            }
        }
    }

    if (shouldContinue && isStreakAlive(streak)) {
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
    api.put('/settings', state.settings);
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

    // Make streak widget clickable to expand (add once)
    if (!widget._commitmentClickBound) {
        widget.style.cursor = 'pointer';
        widget.addEventListener('click', (e) => {
            // Don't trigger expansion from the check-in button
            if (e.target.closest('#streak-checkin-btn')) return;
            showStreakExpansion();
        });
        widget._commitmentClickBound = true;
    }

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
        // On mobile, CSS media query handles layout — don't override with fixed widths
        if (window.innerWidth <= 900) {
            layout.style.gridTemplateColumns = '';
            return;
        }
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

    // Month nav state (independent)
    let monthViewDate = new Date(state.timelineViewDate);

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
                api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
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
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
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

    function getScheduleMonthKey() {
        return getMonthKey(monthViewDate);
    }

    function formatMonthLabel(d) {
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        return `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    }

    async function toggleMonth() {
        const mk = getScheduleMonthKey();
        if (assignedContexts.has(mk)) {
            // Remove this month context
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => tc !== mk);
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        } else if (scheduleMode === 'one-time') {
            await setContexts([mk]);
            return;
        } else {
            for (const id of itemIds) {
                const itm = findItemById(id);
                if (itm) {
                    itm.timeContexts = (itm.timeContexts || []).filter(tc => !EPOCH_CONTEXTS.includes(tc));
                    if (!itm.timeContexts.includes(mk)) itm.timeContexts.push(mk);
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
                }
            }
        }
        assignedContexts = getAssignedContexts();
        buildContent();
    }

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
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
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
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
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
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
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
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
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

    async function toggleContextDone(ctx) {
        for (const id of itemIds) {
            const itm = findItemById(id);
            if (itm) {
                const wasDone = isContextDone(itm, ctx);
                setContextDone(itm, ctx, !wasDone);
            }
        }
        buildContent();
        renderAll(); // update background views
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
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
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
                    api.patch(`/items/${id}`, { timeContexts: itm.timeContexts });
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
        const hasMonth = [...assignedContexts].some(tc => isMonthContext(tc));
        const hasWeek = [...assignedContexts].some(tc => isWeekContext(tc));
        const hasDate = [...assignedContexts].some(tc => /^\d{4}-\d{2}-\d{2}$/.test(tc));
        const hasSession = [...assignedContexts].some(tc => tc.includes('@'));

        // Count assigned contexts per tier (for badges on collapsed headers)
        const countEpoch = (hasOngoing ? 1 : 0) + (hasFuture ? 1 : 0) + (hasPast ? 1 : 0);
        const countMonth = [...assignedContexts].filter(tc => isMonthContext(tc)).length;
        const countWeek = [...assignedContexts].filter(tc => isWeekContext(tc)).length;
        const countDay = [...assignedContexts].filter(tc => /^\d{4}-\d{2}-\d{2}$/.test(tc)).length;
        const countSession = [...assignedContexts].filter(tc => tc.includes('@')).length;
        function badgeHtml(count) {
            return count > 0 ? `<span class="schedule-section-badge">${count}</span>` : '';
        }

        // Month section data
        const scheduleMk = getScheduleMonthKey();
        const monthLabel = formatMonthLabel(monthViewDate);
        const isMonthAssigned = assignedContexts.has(scheduleMk);
        const currentMonthKey = getMonthKey(getLogicalToday());
        const canMonthPrev = scheduleMk > currentMonthKey;

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

        // ── Context-done state for each tier ──
        function _isCtxDone(ctx) {
            return sampleItem ? isContextDone(sampleItem, ctx) : false;
        }
        const isOngoingDone = _isCtxDone('ongoing');
        const isFutureDone = _isCtxDone('future');
        const isMonthDone = _isCtxDone(scheduleMk);
        const isWeekDone = _isCtxDone(scheduleWk);

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
                            📦 ${hasOngoing ? '✓ Ongoing' : 'Move to Ongoing'}${hasOngoing && isOngoingDone ? '<span class="schedule-done-chip schedule-done-chip-active" data-done-ctx="ongoing">✓ Done</span>' : hasOngoing ? '<span class="schedule-done-chip" data-done-ctx="ongoing">Mark Done</span>' : ''}
                        </div>
                        <div class="schedule-epoch-toggle ${hasFuture ? 'schedule-epoch-active' : ''}" data-epoch="future" id="schedule-epoch-future-btn">
                            🔮 ${hasFuture ? '✓ Future' : 'Move to Future'}${hasFuture && isFutureDone ? '<span class="schedule-done-chip schedule-done-chip-active" data-done-ctx="future">✓ Done</span>' : hasFuture ? '<span class="schedule-done-chip" data-done-ctx="future">Mark Done</span>' : ''}
                        </div>
                    </div></div>
                </details>
        `;

        // ── Month section ──
        html += `
                <details class="schedule-section" data-tier="month"${sectionOpen('month', hasMonth) ? ' open' : ''}>
                    <summary class="schedule-section-header">🗓️ Month${badgeHtml(countMonth)}</summary>
                    <div class="schedule-section-content-wrapper"><div class="schedule-section-content">
                        <div class="schedule-week-nav">
                            <button class="schedule-cal-nav-btn${canMonthPrev ? '' : ' schedule-cal-nav-btn-disabled'}" id="schedule-month-prev"${canMonthPrev ? '' : ' disabled'}>‹</button>
                            <span class="schedule-week-label">${monthLabel}</span>
                            <button class="schedule-cal-nav-btn" id="schedule-month-next">›</button>
                        </div>
                        <div class="schedule-week-toggle ${isMonthAssigned ? 'schedule-week-active' : ''}" id="schedule-month-btn">
                            ${isMonthAssigned ? '✓ Assigned to this Month' : 'Assign to this Month'}${isMonthAssigned && isMonthDone ? '<span class="schedule-done-chip schedule-done-chip-active" data-done-ctx="' + scheduleMk + '">✓ Done</span>' : isMonthAssigned ? '<span class="schedule-done-chip" data-done-ctx="' + scheduleMk + '">Mark Done</span>' : ''}
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
                            ${isWeekAssigned ? '✓ Assigned to this Week' : 'Assign to this Week'}${weekLTLabel ? `<span class="schedule-leadtime-chip">${weekLTLabel}</span>` : ''}${isWeekAssigned && isWeekDone ? '<span class="schedule-done-chip schedule-done-chip-active" data-done-ctx="' + scheduleWk + '">✓ Done</span>' : isWeekAssigned ? '<span class="schedule-done-chip" data-done-ctx="' + scheduleWk + '">Mark Done</span>' : ''}
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
            const dayDone = isAssigned && _isCtxDone(dateKey);
            const doneBtn = isAssigned ? `<button class="schedule-cal-done-btn${dayDone ? ' schedule-cal-done-btn-active' : ''}" data-done-date="${dateKey}" title="${dayDone ? 'Mark not done' : 'Mark done'}">${dayDone ? '↩' : '✓'}</button>` : '';
            if (dayDone) cls += ' schedule-cal-day-done';
            html += `<div class="${cls}" data-date="${dateKey}">${d}${deadlineBtn}${doneBtn}</div>`;
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
                const sessDone = isAssigned && _isCtxDone(segKey);
                html += `<div class="schedule-session-item${isAssigned ? ' schedule-session-item-assigned' : ''}${sessDone ? ' schedule-session-done' : ''}" data-seg-key="${segKey}" data-block-ts="${block.timestamp}">
                    <span class="schedule-session-icon">📌</span>
                    <span class="schedule-session-label">${label}</span>
                    <span class="schedule-session-time">${timeRange}</span>${isAssigned ? `<span class="schedule-done-chip${sessDone ? ' schedule-done-chip-active' : ''}" data-done-ctx="${segKey}">${sessDone ? '✓' : '○'}</span>` : ''}
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

        // Month toggle
        modal.querySelector('#schedule-month-btn')?.addEventListener('click', toggleMonth);

        // Month nav
        if (canMonthPrev) {
            modal.querySelector('#schedule-month-prev').addEventListener('click', () => {
                monthViewDate = new Date(monthViewDate);
                monthViewDate.setMonth(monthViewDate.getMonth() - 1);
                buildContent();
            });
        }
        modal.querySelector('#schedule-month-next')?.addEventListener('click', () => {
            monthViewDate = new Date(monthViewDate);
            monthViewDate.setMonth(monthViewDate.getMonth() + 1);
            buildContent();
        });

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
                // Don't toggle work day if the deadline or done button was clicked
                if (e.target.classList.contains('schedule-cal-deadline-btn')) return;
                if (e.target.classList.contains('schedule-cal-done-btn')) return;
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

        // ✓ Done buttons on calendar days
        modal.querySelectorAll('.schedule-cal-done-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleContextDone(btn.dataset.doneDate);
            });
        });

        // ✓ Done chips on epoch/month/week/session tiers
        modal.querySelectorAll('.schedule-done-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                const ctx = chip.dataset.doneCtx;
                if (ctx) toggleContextDone(ctx);
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
            api.patch(`/items/${itemId}`, { goal });
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
                api.patch(`/items/${itemId}`, { goal: null });
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
            <div class="modal-divider"></div>
            <div class="modal-field">
                <label class="modal-label" for="defaults-commitment-mode">⚡ Commitment mode</label>
                <select id="defaults-commitment-mode" class="modal-input">
                    <option value="gentle">🌱 Gentle — streak always continues</option>
                    <option value="balanced">⚖️ Balanced — need 80% kept</option>
                    <option value="strict">🎯 Strict — any broken resets streak</option>
                </select>
                <span class="modal-hint">How broken commitments affect your streak</span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-field">
                <label class="modal-label">🤖 AI Provider</label>
                <select id="defaults-ai-provider" class="modal-input">
                    <option value="gemini">Gemini</option>
                    <option value="claude">Claude</option>
                    <option value="custom">Custom (OpenAI-compat)</option>
                </select>
            </div>
            <div class="modal-field">
                <label class="modal-label">🧠 AI Model</label>
                <input type="text" id="defaults-ai-model" class="modal-input" placeholder="e.g. gemini-2.0-flash" />
            </div>
            <div class="modal-field">
                <label class="modal-label">🔑 AI API Key</label>
                <input type="password" id="defaults-ai-key" class="modal-input" placeholder="Enter API key" autocomplete="off" />
            </div>
            <div class="modal-hint">Provider and key are stored locally in settings.json. Leave key blank to keep the current one.</div>

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

    // AI settings
    document.getElementById('defaults-ai-provider').value = state.settings.aiProvider || 'gemini';
    document.getElementById('defaults-ai-model').value = state.settings.aiModel || 'gemini-2.0-flash';
    // Don't pre-fill key for security — just show placeholder if set
    if (state.settings.aiApiKey) {
        document.getElementById('defaults-ai-key').placeholder = '••••••••  (key saved)';
    }

    // Commitment mode
    document.getElementById('defaults-commitment-mode').value = state.settings.commitmentMode || 'gentle';

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
        // AI settings
        state.settings.aiProvider = document.getElementById('defaults-ai-provider').value;
        state.settings.aiModel = document.getElementById('defaults-ai-model').value;
        const newKey = document.getElementById('defaults-ai-key').value.trim();
        if (newKey) state.settings.aiApiKey = newKey; // Only overwrite if user typed a new key
        // Commitment mode
        state.settings.commitmentMode = document.getElementById('defaults-commitment-mode').value;
        api.put('/settings', state.settings);
        // Reload copilot config label
        try {
            const res = await fetch('/api/ai/config');
            const cfg = await res.json();
            const ml = document.getElementById('copilot-model-label');
            if (ml) ml.textContent = cfg.available ? cfg.model : '⚠️ No API key';
        } catch { }
        overlay.remove();
        _liveIndicatorFingerprint = null; // force live indicator refresh
        renderTimeline();
        _renderLiveSessionIndicator();
    });
}

// ─── Hide-Past Accordion Animation ───
function animateHidePastToggle(isHiding) {
    const timeline = document.getElementById('timeline-list');

    // ── Shared helpers ──
    const DURATION = '280ms';
    const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
    const TRANS = `max-height ${DURATION} ${EASING}, opacity ${DURATION} ${EASING}, margin ${DURATION} ${EASING}, padding ${DURATION} ${EASING}`;

    function collapseElements(elements) {
        elements.forEach(el => {
            const h = el.offsetHeight;
            const style = getComputedStyle(el);
            const mt = style.marginTop, mb = style.marginBottom;
            const pt = style.paddingTop, pb = style.paddingBottom;
            const startOpacity = style.opacity;  // respect CSS-defined opacity (e.g. dimmed past)
            el.style.overflow = 'hidden';
            el.style.transition = 'none';
            el.style.maxHeight = h + 'px';
            el.style.marginTop = mt;
            el.style.marginBottom = mb;
            el.style.paddingTop = pt;
            el.style.paddingBottom = pb;
            el.style.opacity = startOpacity;
            void el.offsetHeight;
            el.style.transition = TRANS;
            el.style.maxHeight = '0px';
            el.style.marginTop = '0px';
            el.style.marginBottom = '0px';
            el.style.paddingTop = '0px';
            el.style.paddingBottom = '0px';
            el.style.opacity = '0';
            let done = false;
            const cleanup = () => { if (done) return; done = true; el.remove(); };
            el.addEventListener('transitionend', (e) => { if (e.propertyName === 'max-height') cleanup(); });
            setTimeout(cleanup, 350);
        });
    }

    function expandElements(elements) {
        elements.forEach(el => {
            const h = el.offsetHeight;
            const style = getComputedStyle(el);
            const mt = style.marginTop, mb = style.marginBottom;
            const pt = style.paddingTop, pb = style.paddingBottom;
            const targetOpacity = style.opacity;  // respect CSS-defined opacity (e.g. dimmed past)
            el.style.overflow = 'hidden';
            el.style.transition = 'none';
            el.style.maxHeight = '0px';
            el.style.marginTop = '0px';
            el.style.marginBottom = '0px';
            el.style.paddingTop = '0px';
            el.style.paddingBottom = '0px';
            el.style.opacity = '0';
            void el.offsetHeight;
            el.style.transition = TRANS;
            el.style.maxHeight = h + 'px';
            el.style.marginTop = mt;
            el.style.marginBottom = mb;
            el.style.paddingTop = pt;
            el.style.paddingBottom = pb;
            el.style.opacity = targetOpacity;
            let done = false;
            const cleanup = () => {
                if (done) return; done = true;
                el.style.overflow = '';
                el.style.transition = '';
                el.style.maxHeight = '';
                el.style.marginTop = '';
                el.style.marginBottom = '';
                el.style.paddingTop = '';
                el.style.paddingBottom = '';
                el.style.opacity = '';
            };
            el.addEventListener('transitionend', (e) => { if (e.propertyName === 'max-height') cleanup(); });
            setTimeout(cleanup, 350);
        });
    }

    // ── Week view: animate individual past day rows ──
    if (state.viewHorizon === 'week') {
        if (isHiding) {
            // Temporarily show past so they render, then animate away
            state.pastDisplayMode = 'show';
            renderTimeline();
            state.pastDisplayMode = 'hide';

            const toCollapse = [];
            timeline.querySelectorAll('.week-day-row.week-day-past').forEach(row => {
                const prev = row.previousElementSibling;
                if (prev && prev.classList.contains('week-sleep-divider')) toCollapse.push(prev);
                toCollapse.push(row);
            });
            collapseElements(toCollapse);
        } else {
            renderTimeline();
            const toExpand = [];
            timeline.querySelectorAll('.week-day-row.week-day-past').forEach(row => {
                const prev = row.previousElementSibling;
                if (prev && prev.classList.contains('week-sleep-divider')) toExpand.push(prev);
                toExpand.push(row);
            });
            expandElements(toExpand);
        }
        return;
    }

    // ── Month view: animate individual past week cards ──
    if (state.viewHorizon === 'month') {
        if (isHiding) {
            state.pastDisplayMode = 'show';
            renderTimeline();
            state.pastDisplayMode = 'hide';
            const pastCards = [...timeline.querySelectorAll('.month-week-card-past')];
            collapseElements(pastCards);
        } else {
            renderTimeline();
            const pastCards = [...timeline.querySelectorAll('.month-week-card-past')];
            expandElements(pastCards);
        }
        return;
    }

    // ── Day view: snapshot old, render new, crossfade ──
    if (isHiding) {
        // Render WITH past first (state-toggle), snapshot, then render WITHOUT
        state.pastDisplayMode = 'show';
        renderTimeline();
        state.pastDisplayMode = 'hide';
        // Snapshot current children count
        const oldChildren = [...timeline.children];
        // Re-render without past
        renderTimeline();
        const newChildren = new Set([...timeline.children]);
        // Find elements that disappeared (old only)
        const removed = oldChildren.filter(c => !newChildren.has(c));
        if (removed.length > 0) {
            // Re-insert old-only elements at top for collapse animation
            removed.forEach(el => timeline.insertBefore(el, timeline.firstChild));
            collapseElements(removed);
        }
    } else {
        // Render with past included, animate new elements in
        // First snapshot current (without past)
        const oldChildSet = new Set([...timeline.children]);
        renderTimeline();
        // Find new elements that weren't there before
        const added = [...timeline.children].filter(c => !oldChildSet.has(c));
        if (added.length > 0) {
            expandElements(added);
        }
    }
}

// ─── Nav Slide Animation ───
let _navAnimating = false;
function animateNavTransition(direction, updateFn) {
    // direction: 'left' = forward (next), 'right' = backward (prev)
    const timeline = document.getElementById('timeline-list');
    // Actions use staggered fade-in from renderActions() — no directional slide
    const targets = [timeline];

    // Also animate the active horizon layer's display (label area) in sync
    const _layerDisplayMap = {
        epoch: 'horizon-epoch-layer', month: 'horizon-month-layer',
        week: 'horizon-week-layer', day: 'horizon-day-layer',
        session: 'horizon-session-layer'
    };
    const layerId = _layerDisplayMap[state.viewHorizon];
    if (layerId) {
        const layerDisplay = document.getElementById(layerId)?.querySelector(
            '.epoch-nav-display, .month-nav-display, .week-nav-display, .date-nav-display, .session-nav-display'
        );
        if (layerDisplay) targets.push(layerDisplay);
    }

    // Cancel any in-flight animation
    for (const el of targets) {
        el.classList.remove('nav-slide-out-left', 'nav-slide-out-right', 'nav-slide-in-left', 'nav-slide-in-right');
        el.getAnimations().forEach(a => a.cancel());
    }

    // Phase 1: slide old content out
    const outClass = direction === 'left' ? 'nav-slide-out-left' : 'nav-slide-out-right';
    for (const el of targets) el.classList.add(outClass);

    let _slideOutDone = false;
    const onSlideOutDone = () => {
        if (_slideOutDone) return;
        _slideOutDone = true;
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

// ── Group collapse (no animation – expand-only policy) ──
function _animateGroupCollapse(headerEl, callback) {
    // Toggle chevron immediately for responsiveness
    const chevron = headerEl.querySelector('.action-group-chevron');
    if (chevron) chevron.classList.remove('expanded');

    // No collapse animation — call back immediately
    callback();
}

// ── Actions zoom-out (breadcrumb navigate to broader focus) ──
function animateActionsZoomOut(updateFn) {
    const container = document.getElementById('actions-list');
    if (!container) { updateFn(); return; }
    // Cancel any existing zoom animation
    container.classList.remove('actions-zoom-out');
    container.getAnimations().forEach(a => a.cancel());
    // Phase 1: zoom-out current content
    container.classList.add('actions-zoom-out');
    const onDone = () => {
        container.classList.remove('actions-zoom-out');
        // Phase 2: update state + re-render (stagger-in handled by _animateActions)
        updateFn();
    };
    container.addEventListener('animationend', onDone, { once: true });
    // Safety timeout
    setTimeout(() => { if (container.classList.contains('actions-zoom-out')) onDone(); }, 200);
}

// ── Actions zoom-in (focus dot drill into item) ──
function animateActionsZoomIn(updateFn) {
    const container = document.getElementById('actions-list');
    if (!container) { updateFn(); return; }
    container.classList.remove('actions-zoom-in');
    container.getAnimations().forEach(a => a.cancel());
    container.classList.add('actions-zoom-in');
    const onDone = () => {
        container.classList.remove('actions-zoom-in');
        updateFn();
    };
    container.addEventListener('animationend', onDone, { once: true });
    setTimeout(() => { if (container.classList.contains('actions-zoom-in')) onDone(); }, 200);
}


// ── Vertical layer transition (slide + scale) ──
// direction: 'up' = zooming in (epoch→day), 'down' = zooming out (day→epoch)
function animateLayerTransition(direction, updateFn) {
    const timeline = document.getElementById('timeline-list');
    const targets = [timeline];
    const allClasses = ['nav-slide-out-up', 'nav-slide-out-down', 'nav-slide-in-up', 'nav-slide-in-down'];
    const towerClasses = ['tower-slide-out-up', 'tower-slide-out-down', 'tower-slide-in-up', 'tower-slide-in-down'];

    // Animate only the display/label areas inside each layer (not the arrow buttons)
    const towerDisplays = [...document.querySelectorAll(
        '.epoch-nav-display, .month-nav-display, .week-nav-display, .date-nav-display, .session-nav-display, .live-nav-display'
    )];

    // Cancel any in-flight animation
    for (const el of targets) {
        allClasses.forEach(c => el.classList.remove(c));
        el.getAnimations().forEach(a => a.cancel());
    }
    for (const el of towerDisplays) {
        towerClasses.forEach(c => el.classList.remove(c));
        el.getAnimations().forEach(a => a.cancel());
    }

    let outDone = false;
    let inDone = false;

    // Phase 1: slide old content out
    const outClass = direction === 'up' ? 'nav-slide-out-up' : 'nav-slide-out-down';
    const towerOutClass = direction === 'up' ? 'tower-slide-out-up' : 'tower-slide-out-down';
    for (const el of targets) el.classList.add(outClass);
    for (const el of towerDisplays) el.classList.add(towerOutClass);

    const onSlideOutDone = () => {
        if (outDone) return;
        outDone = true;
        for (const el of targets) el.classList.remove(outClass);
        for (const el of towerDisplays) el.classList.remove(towerOutClass);

        // Phase 2: update state + re-render
        updateFn();

        // Phase 3: slide new content in (re-query displays since DOM may have changed)
        const freshDisplays = [...document.querySelectorAll(
            '.epoch-nav-display, .month-nav-display, .week-nav-display, .date-nav-display, .session-nav-display, .live-nav-display'
        )];
        const inClass = direction === 'up' ? 'nav-slide-in-up' : 'nav-slide-in-down';
        const towerInClass = direction === 'up' ? 'tower-slide-in-up' : 'tower-slide-in-down';
        for (const el of targets) el.classList.add(inClass);
        for (const el of freshDisplays) el.classList.add(towerInClass);

        const cleanup = () => {
            if (inDone) return;
            inDone = true;
            for (const el of targets) el.classList.remove(inClass);
            for (const el of freshDisplays) el.classList.remove(towerInClass);
            _navAnimating = false;
        };
        timeline.addEventListener('animationend', (e) => {
            if (e.target === timeline) cleanup();
        }, { once: true });
        setTimeout(cleanup, 250);
    };

    _navAnimating = true;
    timeline.addEventListener('animationend', (e) => {
        if (e.target === timeline) onSlideOutDone();
    }, { once: true });
    setTimeout(() => {
        if (!outDone) onSlideOutDone();
    }, 250);
}

// ─── Mobile Tab Bar ───
function initMobileTabBar() {
    const tabBar = document.getElementById('mobile-tab-bar');
    if (!tabBar) return;

    const panelMap = {
        projects: document.getElementById('sidebar-projects'),
        actions: document.getElementById('main-content'),
        timeline: document.getElementById('sidebar-timeline'),
    };

    const tabOrder = ['projects', 'actions', 'timeline'];
    let _mobileTabAnimating = false;

    function getMobileActiveTab() {
        return localStorage.getItem('mobileActiveTab') || 'actions';
    }

    function showPanel(key) {
        const panel = panelMap[key];
        if (key === 'actions') {
            panel.classList.remove('mobile-hidden');
        } else {
            panel.classList.add('mobile-active');
        }
    }

    function hidePanel(key) {
        const panel = panelMap[key];
        if (key === 'actions') {
            panel.classList.add('mobile-hidden');
        } else {
            panel.classList.remove('mobile-active');
        }
    }

    function switchMobileTab(tabName, animate = true) {
        if (window.innerWidth > 900) animate = false;
        const prevTab = getMobileActiveTab();

        // Update tab bar buttons
        tabBar.querySelectorAll('.mobile-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });

        // No animation needed — same tab or initial load
        if (!animate || prevTab === tabName || _mobileTabAnimating) {
            Object.keys(panelMap).forEach(key => {
                if (key === tabName) showPanel(key);
                else hidePanel(key);
            });
            localStorage.setItem('mobileActiveTab', tabName);
            return;
        }

        // Determine direction
        const prevIdx = tabOrder.indexOf(prevTab);
        const nextIdx = tabOrder.indexOf(tabName);
        const goingLeft = nextIdx > prevIdx; // "forward" = content slides left

        const outPanel = panelMap[prevTab];
        const inPanel = panelMap[tabName];

        _mobileTabAnimating = true;

        // Show incoming panel and position it off-screen
        showPanel(tabName);
        inPanel.classList.add('mobile-tab-animating');
        outPanel.classList.add('mobile-tab-animating');

        // Set initial positions
        const offset = goingLeft ? '100%' : '-100%';
        const exitOffset = goingLeft ? '-100%' : '100%';
        inPanel.style.transform = `translateX(${offset})`;
        inPanel.style.opacity = '0';
        outPanel.style.transform = 'translateX(0)';
        outPanel.style.opacity = '1';

        // Force reflow
        void inPanel.offsetHeight;

        // Animate
        requestAnimationFrame(() => {
            inPanel.style.transition = 'transform 280ms cubic-bezier(0.4, 0, 0.2, 1), opacity 280ms cubic-bezier(0.4, 0, 0.2, 1)';
            outPanel.style.transition = 'transform 280ms cubic-bezier(0.4, 0, 0.2, 1), opacity 280ms cubic-bezier(0.4, 0, 0.2, 1)';

            inPanel.style.transform = 'translateX(0)';
            inPanel.style.opacity = '1';
            outPanel.style.transform = `translateX(${exitOffset})`;
            outPanel.style.opacity = '0';
        });

        const cleanup = () => {
            // Clear inline styles
            [inPanel, outPanel].forEach(el => {
                el.style.transform = '';
                el.style.opacity = '';
                el.style.transition = '';
                el.classList.remove('mobile-tab-animating');
            });
            // Hide old panel
            hidePanel(prevTab);
            _mobileTabAnimating = false;
        };

        inPanel.addEventListener('transitionend', (e) => {
            if (e.propertyName === 'transform') cleanup();
        }, { once: true });
        // Safety fallback
        setTimeout(cleanup, 350);

        localStorage.setItem('mobileActiveTab', tabName);
    }

    tabBar.addEventListener('click', e => {
        const tab = e.target.closest('.mobile-tab');
        if (tab) switchMobileTab(tab.dataset.tab);
    });

    // Restore last tab (default: actions) — no animation on initial load
    const saved = localStorage.getItem('mobileActiveTab') || 'actions';
    switchMobileTab(saved, false);

    // ── Swipe gestures for tab switching ──
    let _swipeStartX = 0, _swipeStartY = 0;
    const appLayout = document.querySelector('.app-layout');
    if (appLayout && 'ontouchstart' in window) {
        appLayout.addEventListener('touchstart', (e) => {
            if (window.innerWidth > 900) return;
            _swipeStartX = e.touches[0].clientX;
            _swipeStartY = e.touches[0].clientY;
        }, { passive: true });

        appLayout.addEventListener('touchend', (e) => {
            if (window.innerWidth > 900) return;
            const dx = e.changedTouches[0].clientX - _swipeStartX;
            const dy = e.changedTouches[0].clientY - _swipeStartY;
            // Only trigger if horizontal movement dominates and exceeds threshold
            if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
            const currentTab = getMobileActiveTab();
            const idx = tabOrder.indexOf(currentTab);
            if (dx < 0 && idx < tabOrder.length - 1) {
                // Swipe left → next tab
                switchMobileTab(tabOrder[idx + 1]);
            } else if (dx > 0 && idx > 0) {
                // Swipe right → previous tab
                switchMobileTab(tabOrder[idx - 1]);
            }
        }, { passive: true });
    }
}

// ─── Event Bindings ───
document.addEventListener('DOMContentLoaded', () => {
    // Skin system
    initSkin();

    // Panel resize (draggable dividers)
    panelResize.init();

    // Load data
    loadAll();

    // Mobile tab bar
    initMobileTabBar();

    // Mobile overflow menu toggle
    const overflowBtn = document.getElementById('top-bar-overflow-btn');
    const overflowMenu = document.getElementById('top-bar-overflow-menu');
    if (overflowBtn && overflowMenu) {
        overflowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu.classList.toggle('open');
        });
        document.addEventListener('click', () => overflowMenu.classList.remove('open'));
        overflowMenu.addEventListener('click', (e) => e.stopPropagation());
    }

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
        state._animateActions = true;
        renderAll();
    });

    // Deep view toggle: show items from all layers of the selected project
    const deepViewBtn = document.getElementById('deep-view-btn');
    deepViewBtn.classList.toggle('active', state.deepView);
    deepViewBtn.title = state.deepView ? 'Showing all layers' : 'Show all layers';
    deepViewBtn.addEventListener('click', () => {
        state.deepView = !state.deepView;
        savePref('deepView', state.deepView);
        deepViewBtn.classList.toggle('active', state.deepView);
        deepViewBtn.title = state.deepView ? 'Showing all layers' : 'Show all layers';
        state._animateActions = true;
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
        state._animateActions = true;
        renderAll();
    });

    // Bookmarks button
    document.getElementById('bookmarks-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showBookmarksDropdown();
    });

    // Date nav buttons — renderAll() so actions list updates with time context
    document.getElementById('date-nav-prev').addEventListener('click', () => {
        if (state.viewHorizon === 'month') {
            const d = state.timelineViewDate;
            state.timelineViewDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
            clearFocusStack();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            animateNavTransition('right', () => { state._animateActions = true; renderAll(); });
            return;
        }
        const d = new Date(state.timelineViewDate);
        const step = state.viewHorizon === 'week' ? 7 : 1;
        d.setDate(d.getDate() - step);
        state.timelineViewDate = d;
        clearFocusStack();
        savePref('timelineViewDate', d.toISOString());
        animateNavTransition('right', () => { state._animateActions = true; renderAll(); });
    });
    document.getElementById('date-nav-next').addEventListener('click', () => {
        if (state.viewHorizon === 'month') {
            const d = state.timelineViewDate;
            state.timelineViewDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);
            clearFocusStack();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            animateNavTransition('left', () => { state._animateActions = true; renderAll(); });
            return;
        }
        const d = new Date(state.timelineViewDate);
        const step = state.viewHorizon === 'week' ? 7 : 1;
        d.setDate(d.getDate() + step);
        state.timelineViewDate = d;
        clearFocusStack();
        savePref('timelineViewDate', d.toISOString());
        animateNavTransition('left', () => { state._animateActions = true; renderAll(); });
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
            state._animateActions = true;
            renderAll();
        }
    });
    // Back to today button
    document.getElementById('date-nav-today-btn').addEventListener('click', () => {
        const today = getLogicalToday();
        const todayKey = getDateKey(today);
        const currentKey = getDateKey(state.timelineViewDate);
        if (currentKey === todayKey) return; // already there
        const dir = currentKey < todayKey ? 'left' : 'right';
        animateNavTransition(dir, () => {
            state.timelineViewDate = today;
            clearFocusStack();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            state._animateActions = true;
            renderAll();
        });
    });

    // Day arrow DnD targets — drop to reschedule to prev/next day
    function setupDayArrowDnD(btnId, dayOffset) {
        const btn = document.getElementById(btnId);
        btn.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
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
            const isCopy = _isDragCopy(e);
            if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                const segCtx = e.dataTransfer.getData('application/x-segment-context');
                if (!itemId) return;
                const segItem = findItemById(Number(itemId));
                const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
                if (!isCopy && segCtx) {
                    removeSourceContext(Number(itemId), segCtx);
                }
                await addTimeContext(parseInt(itemId, 10), targetDateKey, segSrcDur || undefined);
                renderAll();
                return;
            }
            // Regular action/project drag (multi-select aware)
            const dragIds = getMultiDragIds(e);
            const sourceCtx = e.dataTransfer.getData('application/x-source-context');
            for (const id of dragIds) {
                const item = findItemById(id);
                const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
                if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
                await addTimeContext(id, targetDateKey, srcDur || undefined);
            }
            if (dragIds.length > 0) clearActionSelection();
            renderAll();
        });
    }
    setupDayArrowDnD('date-nav-prev', -1);
    setupDayArrowDnD('date-nav-next', 1);

    // Week arrow DnD targets — drop to reschedule to prev/next week
    function setupWeekArrowDnD(btnId, weekOffset) {
        const btn = document.getElementById(btnId);
        btn.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
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
            const isCopy = _isDragCopy(e);
            if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                const segCtx = e.dataTransfer.getData('application/x-segment-context');
                if (!itemId) return;
                const segItem = findItemById(Number(itemId));
                const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
                if (!isCopy && segCtx) {
                    removeSourceContext(Number(itemId), segCtx);
                }
                await addTimeContext(parseInt(itemId, 10), targetWeekKey, segSrcDur || undefined);
                renderAll();
                return;
            }
            // Regular action/project drag (multi-select aware)
            const dragIds = getMultiDragIds(e);
            const sourceCtx = e.dataTransfer.getData('application/x-source-context');
            for (const id of dragIds) {
                const item = findItemById(id);
                const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
                if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
                await addTimeContext(id, targetWeekKey, srcDur || undefined);
            }
            if (dragIds.length > 0) clearActionSelection();
            renderAll();
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
        animateLayerTransition('down', () => {
            clearFocusStack();
            state.viewHorizon = 'epoch';
            savePref('viewHorizon', 'epoch');
            state._animateActions = true;
            renderAll();
        });
    });

    // DnD on the epoch layer — sends to whatever epoch is currently displayed
    // (blocked when showing Past since you can't schedule to Past)
    epochLayer.addEventListener('dragover', (e) => {
        if (state.epochFilter === 'past') return; // can't drop on past
        if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
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
        const isCopy = _isDragCopy(e);
        // Segment queue item (intention) drag
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            const segItem = findItemById(Number(itemId));
            const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
            if (!isCopy && segCtx) {
                removeSourceContext(Number(itemId), segCtx);
            }
            await addTimeContext(parseInt(itemId, 10), targetEpoch, segSrcDur || undefined);
            renderAll();
            return;
        }
        // Regular action/project drag
        // Multi-select aware
        const dragIds = getMultiDragIds(e);
        const sourceCtx = e.dataTransfer.getData('application/x-source-context');
        for (const id of dragIds) {
            const item = findItemById(id);
            const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
            if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
            await addTimeContext(id, targetEpoch, srcDur || undefined);
        }
        if (dragIds.length > 0) clearActionSelection();
        renderAll();
    });

    // Month layer: click to navigate to month view, prev/next month, DnD
    const monthLayer = document.getElementById('horizon-month-layer');
    monthLayer.addEventListener('click', (e) => {
        if (e.target.closest('.month-nav-btn, .date-nav-today-btn')) return;
        if (state.viewHorizon === 'month') return;
        const _layerDepth = { epoch: 0, month: 1, week: 2, day: 3, session: 4 };
        const dir = (_layerDepth[state.viewHorizon] || 0) < _layerDepth.month ? 'up' : 'down';
        animateLayerTransition(dir, () => {
            clearFocusStack();
            state.viewHorizon = 'month';
            savePref('viewHorizon', 'month');
            state._animateActions = true;
            renderAll();
        });
    });
    document.getElementById('month-nav-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        const d = state.timelineViewDate;
        state.timelineViewDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
        clearFocusStack();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        animateNavTransition('right', () => { state._animateActions = true; renderAll(); });
    });
    document.getElementById('month-nav-next').addEventListener('click', (e) => {
        e.stopPropagation();
        const d = state.timelineViewDate;
        state.timelineViewDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        clearFocusStack();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        animateNavTransition('left', () => { state._animateActions = true; renderAll(); });
    });
    document.getElementById('month-nav-this-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const today = getLogicalToday();
        const todayMonth = getMonthKey(today);
        const currentMonth = getMonthKey(state.timelineViewDate);
        if (currentMonth === todayMonth) return; // already there
        const dir = currentMonth < todayMonth ? 'left' : 'right';
        animateNavTransition(dir, () => {
            state.timelineViewDate = today;
            clearFocusStack();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            state._animateActions = true;
            renderAll();
        });
    });
    // DnD on month layer — sends to current month context
    monthLayer.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        monthLayer.classList.add('horizon-layer-drag-over');
    });
    monthLayer.addEventListener('dragleave', () => {
        monthLayer.classList.remove('horizon-layer-drag-over');
    });
    monthLayer.addEventListener('drop', async (e) => {
        e.preventDefault();
        monthLayer.classList.remove('horizon-layer-drag-over');
        const targetMonthKey = getMonthKey(state.timelineViewDate);
        const isCopy = _isDragCopy(e);
        // Segment queue item drag
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            const segItem = findItemById(Number(itemId));
            const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
            if (!isCopy && segCtx) {
                removeSourceContext(Number(itemId), segCtx);
            }
            await addTimeContext(parseInt(itemId, 10), targetMonthKey, segSrcDur || undefined);
            renderAll();
            return;
        }
        // Regular action/project drag (multi-select aware)
        const dragIds = getMultiDragIds(e);
        const sourceCtx = e.dataTransfer.getData('application/x-source-context');
        for (const id of dragIds) {
            const item = findItemById(id);
            const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
            if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
            await addTimeContext(id, targetMonthKey, srcDur || undefined);
        }
        if (dragIds.length > 0) clearActionSelection();
        renderAll();
    });

    // Week layer: click to navigate to week view, drag to degrade to week scope
    const weekLayer = document.getElementById('horizon-week-layer');
    weekLayer.addEventListener('click', (e) => {
        // Don't trigger horizon switch when clicking nav buttons, picker, or today btn
        if (e.target.closest('.week-nav-btn, .date-nav-picker, .date-nav-today-btn')) return;
        if (state.viewHorizon === 'week') return; // already active — don't re-trigger
        const _layerDepth = { epoch: 0, month: 1, week: 2, day: 3, session: 4 };
        const dir = (_layerDepth[state.viewHorizon] || 0) < _layerDepth.week ? 'up' : 'down';
        animateLayerTransition(dir, () => {
            state._weekScrollTarget = getDateKey(state.timelineViewDate); // remember source day
            clearFocusStack();
            state.viewHorizon = 'week';
            savePref('viewHorizon', 'week');
            state._animateActions = true;
            renderAll();
        });
    });
    // Week nav arrow buttons
    document.getElementById('week-nav-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        state.timelineViewDate.setDate(state.timelineViewDate.getDate() - 7);
        clearFocusStack();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        _updateWeekNavLabel();
        animateNavTransition('right', () => { state._animateActions = true; renderAll(); });
    });
    document.getElementById('week-nav-next').addEventListener('click', (e) => {
        e.stopPropagation();
        state.timelineViewDate.setDate(state.timelineViewDate.getDate() + 7);
        clearFocusStack();
        savePref('timelineViewDate', state.timelineViewDate.toISOString());
        _updateWeekNavLabel();
        animateNavTransition('left', () => { state._animateActions = true; renderAll(); });
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
        const today = getLogicalToday();
        const todayWeek = getWeekKey(today);
        const currentWeek = getWeekKey(state.timelineViewDate);
        if (currentWeek === todayWeek) return; // already there
        const dir = currentWeek < todayWeek ? 'left' : 'right';
        animateNavTransition(dir, () => {
            state.timelineViewDate = today;
            clearFocusStack();
            savePref('timelineViewDate', state.timelineViewDate.toISOString());
            _updateWeekNavLabel();
            state._animateActions = true;
            renderAll();
        });
    });
    weekLayer.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
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
        const isCopy = _isDragCopy(e);
        // Segment queue item drag
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            const segItem = findItemById(Number(itemId));
            const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
            if (!isCopy && segCtx) {
                removeSourceContext(Number(itemId), segCtx);
            }
            await addTimeContext(parseInt(itemId, 10), weekKey, segSrcDur || undefined);
            renderAll();
            return;
        }
        // Regular action/project drag
        // Multi-select aware
        const dragIds = getMultiDragIds(e);
        const sourceCtx = e.dataTransfer.getData('application/x-source-context');
        for (const id of dragIds) {
            const item = findItemById(id);
            const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
            if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
            await addTimeContext(id, weekKey, srcDur || undefined);
        }
        if (dragIds.length > 0) clearActionSelection();
        renderAll();
    });

    // Day layer: click to navigate back to day, drag to promote from ongoing
    const dayLayer = document.getElementById('horizon-day-layer');
    dayLayer.addEventListener('click', (e) => {
        // Navigate: from session → back to day, or from ongoing/week → day
        if (e.target.closest('.date-nav-btn')) return;
        // Only ignore date-display clicks when already in day view
        if (state.viewHorizon === 'day' && e.target.closest('.date-nav-display')) return;
        if (state.viewHorizon === 'day') return;
        const _layerDepth = { epoch: 0, month: 1, week: 2, day: 3, session: 4 };
        const dir = (_layerDepth[state.viewHorizon] || 0) < _layerDepth.day ? 'up' : 'down';
        animateLayerTransition(dir, () => {
            clearFocusStack();
            state.viewHorizon = 'day';
            savePref('viewHorizon', 'day');
            state._animateActions = true;
            renderAll();
        });
    });
    dayLayer.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
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
        const isCopy = _isDragCopy(e);
        const dateKey = getDateKey(state.timelineViewDate);
        // Segment queue item (intention) drag
        if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
            const itemId = e.dataTransfer.getData('application/x-segment-item-id');
            const segCtx = e.dataTransfer.getData('application/x-segment-context');
            if (!itemId) return;
            const segItem = findItemById(Number(itemId));
            const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
            if (!isCopy && segCtx) {
                removeSourceContext(Number(itemId), segCtx);
            }
            await addTimeContext(parseInt(itemId, 10), dateKey, segSrcDur || undefined);
            renderAll();
            return;
        }
        // Regular action/project drag
        // Multi-select aware
        const dragIds = getMultiDragIds(e);
        const sourceCtx = e.dataTransfer.getData('application/x-source-context');
        for (const id of dragIds) {
            const item = findItemById(id);
            const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
            if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
            await addTimeContext(id, dateKey, srcDur || undefined);
        }
        if (dragIds.length > 0) clearActionSelection();
        renderAll();
    });

    // ── Session layer: click to enter session horizon, prev/next to navigate, DnD to schedule ──
    const sessionLayer = document.getElementById('horizon-session-layer');
    if (sessionLayer) {
        sessionLayer.addEventListener('click', (e) => {
            if (e.target.closest('.session-nav-btn, .date-nav-today-btn')) return;
            if (state.viewHorizon === 'session') return; // already active
            animateLayerTransition('up', () => {
                // Enter session horizon — auto-select current segment
                const segments = buildPlanSegments();
                state.sessionIndex = getCurrentSessionIndex(segments);
                state.viewHorizon = 'session';
                savePref('viewHorizon', 'session');
                savePref('sessionIndex', state.sessionIndex);
                _syncSessionToFocusStack(segments[state.sessionIndex]);
                state._animateActions = true;
                renderAll();
            });
        });
        document.getElementById('session-nav-prev').addEventListener('click', (e) => {
            e.stopPropagation();
            navigateSession(-1);
        });
        document.getElementById('session-nav-next').addEventListener('click', (e) => {
            e.stopPropagation();
            navigateSession(+1);
        });
        document.getElementById('session-nav-now-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            // Jump to today's current session
            const today = getLogicalToday();
            const todayKey = getDateKey(today);
            const currentKey = getDateKey(state.timelineViewDate);
            const segments = buildPlanSegments();
            const targetIdx = getCurrentSessionIndex(segments);
            const sameDay = currentKey === todayKey;
            const sameSession = sameDay && state.sessionIndex === targetIdx;
            if (sameSession) return; // already there
            // Direction: same-day compare session indices, otherwise compare dates
            const dir = sameDay
                ? (state.sessionIndex < targetIdx ? 'left' : 'right')
                : (currentKey < todayKey ? 'left' : 'right');
            animateNavTransition(dir, () => {
                state.timelineViewDate = today;
                savePref('timelineViewDate', state.timelineViewDate.toISOString());
                const segs = buildPlanSegments();
                state.sessionIndex = getCurrentSessionIndex(segs);
                savePref('sessionIndex', state.sessionIndex);
                _syncSessionToFocusStack(segs[state.sessionIndex]);
                state._animateActions = true;
                renderAll();
            });
        });
        sessionLayer.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
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
            // Get active session segment for context (always use state.sessionIndex — matches the layer label)
            const segments = buildPlanSegments();
            if (segments.length === 0) return;
            const segIdx = Math.max(0, Math.min(segments.length - 1, state.sessionIndex));
            const seg = segments[segIdx];
            if (!seg) return;
            const isCopy = _isDragCopy(e);
            // Segment queue item drag
            if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                const segCtx = e.dataTransfer.getData('application/x-segment-context');
                if (!itemId) return;
                const segItem = findItemById(Number(itemId));
                const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
                if (!isCopy && segCtx) {
                    removeSourceContext(Number(itemId), segCtx);
                }
                // Add to the active session's segment
                await addSegmentContext(parseInt(itemId, 10), seg.segmentKey, segSrcDur || undefined, { move: false });
                renderAll();
                return;
            }
            // Regular action drag
            // Multi-select aware
            const dragIds = getMultiDragIds(e);
            const sourceCtx = e.dataTransfer.getData('application/x-source-context');
            for (const id of dragIds) {
                const item = findItemById(id);
                const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
                if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
                await addSegmentContext(id, seg.segmentKey, srcDur || undefined, { move: false });
            }
            if (dragIds.length > 0) clearActionSelection();
            renderAll();
        });

        // Session arrow DnD targets — drop to assign to prev/next session
        function setupSessionArrowDnD(btnId, sessionOffset) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('application/x-action-id') && !e.dataTransfer.types.includes('application/x-segment-item-id')) return;
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
                const segments = buildPlanSegments();
                if (segments.length === 0) return;
                const targetIdx = Math.max(0, Math.min(segments.length - 1, state.sessionIndex + sessionOffset));
                const targetSeg = segments[targetIdx];
                if (!targetSeg) return;
                const isCopy = _isDragCopy(e);
                // Segment queue item drag
                if (e.dataTransfer.types.includes('application/x-segment-item-id')) {
                    const itemId = e.dataTransfer.getData('application/x-segment-item-id');
                    const segCtx = e.dataTransfer.getData('application/x-segment-context');
                    if (!itemId) return;
                    const segItem = findItemById(Number(itemId));
                    const segSrcDur = segCtx ? getContextDuration(segItem, segCtx) : getContextDuration(segItem);
                    if (!isCopy && segCtx) {
                        removeSourceContext(Number(itemId), segCtx);
                    }
                    await addSegmentContext(parseInt(itemId, 10), targetSeg.segmentKey, segSrcDur || undefined, { move: false });
                    renderAll();
                    return;
                }
                // Regular action drag (multi-select aware)
                const dragIds = getMultiDragIds(e);
                const sourceCtx = e.dataTransfer.getData('application/x-source-context');
                for (const id of dragIds) {
                    const item = findItemById(id);
                    const srcDur = sourceCtx ? getContextDuration(item, sourceCtx) : getContextDuration(item);
                    if (!isCopy && sourceCtx) { removeSourceContext(id, sourceCtx); }
                    await addSegmentContext(id, targetSeg.segmentKey, srcDur || undefined, { move: false });
                }
                if (dragIds.length > 0) clearActionSelection();
                renderAll();
            });
        }
        setupSessionArrowDnD('session-nav-prev', -1);
        setupSessionArrowDnD('session-nav-next', 1);
    }

    // ─── Wheel navigation on the horizon tower ───
    // Vertical scroll: switch between horizon layers
    // Horizontal scroll: prev/next within the current layer
    {
        const timeContext = document.getElementById('time-context');
        let _horizonWheelCooldown = false;

        timeContext.addEventListener('wheel', (e) => {
            // Only act if we have meaningful delta
            const absX = Math.abs(e.deltaX);
            const absY = Math.abs(e.deltaY);
            if (absX < 5 && absY < 5) return;

            // Debounce to prevent rapid-fire
            if (_horizonWheelCooldown) return;
            _horizonWheelCooldown = true;
            setTimeout(() => { _horizonWheelCooldown = false; }, 300);

            e.preventDefault();

            const isHorizontal = absX > absY;

            if (isHorizontal) {
                // ── Horizontal: prev/next within the current layer ──
                const dir = e.deltaX > 0 ? 1 : -1; // right = next, left = prev
                switch (state.viewHorizon) {
                    case 'epoch':
                        cycleEpoch(dir);
                        break;
                    case 'month':
                        document.getElementById(dir > 0 ? 'month-nav-next' : 'month-nav-prev')?.click();
                        break;
                    case 'week':
                        document.getElementById(dir > 0 ? 'week-nav-next' : 'week-nav-prev')?.click();
                        break;
                    case 'day':
                        document.getElementById(dir > 0 ? 'date-nav-next' : 'date-nav-prev')?.click();
                        break;
                    case 'session':
                        navigateSession(dir);
                        break;
                    // 'live' has no prev/next
                }
            } else {
                // ── Vertical: switch between horizon layers ──
                const _layerOrder = ['epoch', 'month', 'week', 'day', 'session', 'live'];
                const curIdx = _layerOrder.indexOf(state.viewHorizon);
                const newIdx = e.deltaY > 0
                    ? Math.min(curIdx + 1, _layerOrder.length - 1)
                    : Math.max(curIdx - 1, 0);
                if (newIdx === curIdx) return;

                const targetLayer = _layerOrder[newIdx];
                const dir = newIdx > curIdx ? 'up' : 'down';

                // Use the same logic as clicking each layer
                if (targetLayer === 'live') {
                    toggleLiveFocus();
                } else if (targetLayer === 'session') {
                    animateLayerTransition('up', () => {
                        const segments = buildPlanSegments();
                        state.sessionIndex = getCurrentSessionIndex(segments);
                        state.viewHorizon = 'session';
                        savePref('viewHorizon', 'session');
                        savePref('sessionIndex', state.sessionIndex);
                        _syncSessionToFocusStack(segments[state.sessionIndex]);
                        state._animateActions = true;
                        renderAll();
                    });
                } else {
                    animateLayerTransition(dir, () => {
                        clearFocusStack();
                        if (targetLayer === 'week') {
                            state._weekScrollTarget = getDateKey(state.timelineViewDate);
                        }
                        state.viewHorizon = targetLayer;
                        savePref('viewHorizon', targetLayer);
                        state._animateActions = true;
                        renderAll();
                    });
                }
            }
        }, { passive: false });
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
        // Animate the timeline transition (calls renderTimeline directly)
        animateHidePastToggle(!wasHidden);
        // Update non-timeline UI (horizon tower, actions, projects, etc.)
        // Skip the deferred renderTimeline inside renderAll so it doesn't clobber the animation
        state._skipTimelineRender = true;
        renderAll();
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

    // ============================================================
    // ── AI Copilot Module ──
    // ============================================================
    {
        const copilotFab = document.getElementById('copilot-fab');
        const copilotPanel = document.getElementById('copilot-panel');
        const copilotOverlay = document.getElementById('copilot-overlay');
        const copilotClose = document.getElementById('copilot-close');
        const copilotInput = document.getElementById('copilot-input');
        const copilotSend = document.getElementById('copilot-send');
        const copilotMessages = document.getElementById('copilot-messages');
        const copilotModelLabel = document.getElementById('copilot-model-label');

        let copilotOpen = false;
        let copilotPendingPlan = null;
        let copilotPendingPlanIndex = -1;
        let copilotLoading = false;
        let copilotHistoryLoaded = false;

        // ── Helpers ──
        function formatTime(ts) {
            const d = new Date(ts);
            return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        }

        function formatDate(ts) {
            const d = new Date(ts);
            const today = new Date();
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            if (d.toDateString() === today.toDateString()) return 'Today';
            if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
            return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        }

        // ── Panel toggle ──
        function toggleCopilot(forceOpen) {
            copilotOpen = forceOpen !== undefined ? forceOpen : !copilotOpen;
            copilotPanel.classList.toggle('copilot-panel-open', copilotOpen);
            copilotOverlay.classList.toggle('copilot-overlay-visible', copilotOpen);
            if (copilotOpen) {
                if (!copilotHistoryLoaded) loadChatHistory();
                setTimeout(() => copilotInput.focus(), 300);
            }
        }

        copilotFab.addEventListener('click', () => toggleCopilot());
        copilotClose.addEventListener('click', () => toggleCopilot(false));
        copilotOverlay.addEventListener('click', () => toggleCopilot(false));

        // ── Load AI config ──
        (async function loadAiConfig() {
            try {
                const res = await fetch('/api/ai/config');
                const config = await res.json();
                copilotModelLabel.textContent = config.model || '';
                if (!config.available) {
                    copilotModelLabel.textContent = '⚠️ No API key';
                    copilotModelLabel.title = 'Set API key in Settings';
                }
            } catch {
                copilotModelLabel.textContent = '';
            }
        })();

        // ── Date separator ──
        let _lastRenderedDate = '';

        function maybeAddDateSeparator(timestamp) {
            const dateStr = new Date(timestamp).toDateString();
            if (dateStr !== _lastRenderedDate) {
                _lastRenderedDate = dateStr;
                const sep = document.createElement('div');
                sep.className = 'copilot-date-sep';
                sep.textContent = formatDate(timestamp);
                copilotMessages.appendChild(sep);
            }
        }

        // ── Message rendering ──
        function addMessage(role, content, timestamp, skipScroll) {
            if (timestamp) maybeAddDateSeparator(timestamp);

            const bubble = document.createElement('div');
            bubble.className = `copilot-message copilot-message-${role === 'assistant' ? 'ai' : role}`;
            if ((role === 'assistant' || role === 'ai') && typeof marked !== 'undefined') {
                bubble.innerHTML = marked.parse(content, { breaks: true });
                bubble.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
            } else {
                bubble.textContent = content;
            }

            // Timestamp
            if (timestamp) {
                const ts = document.createElement('span');
                ts.className = 'copilot-timestamp';
                ts.textContent = formatTime(timestamp);
                bubble.appendChild(ts);
            }

            copilotMessages.appendChild(bubble);
            if (!skipScroll) copilotMessages.scrollTop = copilotMessages.scrollHeight;
            return bubble;
        }

        function addPlanCard(plan, status, planIndex, skipScroll, intentText) {
            const card = document.createElement('div');
            card.className = 'copilot-plan-card';

            if (status === 'applied') card.classList.add('copilot-plan-done');
            if (status === 'cancelled') card.classList.add('copilot-plan-dismissed');

            const header = document.createElement('div');
            header.className = 'copilot-plan-header';
            const statusLabel = status === 'applied' ? ' ✅' : status === 'cancelled' ? ' ✕' : '';
            header.textContent = `📋 Plan (${plan.length}+ action${plan.length !== 1 ? 's' : ''})${statusLabel}`;
            card.appendChild(header);

            // Show the AI's intent description if provided
            if (intentText) {
                const intent = document.createElement('div');
                intent.className = 'copilot-plan-intent';
                intent.textContent = intentText;
                card.appendChild(intent);
            }

            const list = document.createElement('div');
            list.className = 'copilot-plan-list';

            for (const mutation of plan) {
                const row = document.createElement('div');
                row.className = 'copilot-plan-row';
                const desc = document.createElement('span');
                desc.className = 'copilot-plan-desc';
                let text = mutation.description || `${mutation.tool}(...)`;
                if (mutation.parentPath) text += ` (under ${mutation.parentPath})`;
                if (mutation.targetName) text = text.replace(`#${mutation.args?.id}`, `"${mutation.targetName}"`);
                desc.textContent = text;
                row.appendChild(desc);
                list.appendChild(row);
            }

            card.appendChild(list);

            // Only show action buttons for pending plans
            if (!status || status === 'pending') {
                const actions = document.createElement('div');
                actions.className = 'copilot-plan-actions';

                const approveBtn = document.createElement('button');
                approveBtn.className = 'copilot-plan-btn copilot-plan-approve';
                approveBtn.textContent = '✅ Apply';
                approveBtn.addEventListener('click', () => executePendingPlan(card, planIndex));

                const rejectBtn = document.createElement('button');
                rejectBtn.className = 'copilot-plan-btn copilot-plan-reject';
                rejectBtn.textContent = '✕ Cancel';
                rejectBtn.addEventListener('click', async () => {
                    copilotPendingPlan = null;
                    card.classList.add('copilot-plan-dismissed');
                    // Persist cancellation
                    await fetch(`/api/ai/plan/${planIndex}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'cancelled' })
                    });
                    card.querySelector('.copilot-plan-actions')?.remove();
                    addMessage('assistant', 'Plan cancelled. What else can I help with?', Date.now());
                });

                actions.appendChild(approveBtn);
                actions.appendChild(rejectBtn);
                card.appendChild(actions);

                // Track this as the active plan
                copilotPendingPlan = plan;
                copilotPendingPlanIndex = planIndex;
            }

            copilotMessages.appendChild(card);
            if (!skipScroll) copilotMessages.scrollTop = copilotMessages.scrollHeight;
        }

        function createExecLog() {
            const container = document.createElement('div');
            container.className = 'copilot-message copilot-message-ai copilot-loading';

            // Header with total timer
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
            const headerLabel = document.createElement('span');
            headerLabel.textContent = '⏳ Working...';
            headerLabel.style.fontWeight = 'bold';
            const totalTimer = document.createElement('span');
            totalTimer.style.cssText = 'font-size:0.8em;opacity:0.6;font-family:monospace';
            totalTimer.textContent = '0.0s';
            header.appendChild(headerLabel);
            header.appendChild(totalTimer);
            container.appendChild(header);

            // Thoughts section (collapsible)
            const thoughtsToggle = document.createElement('div');
            thoughtsToggle.style.cssText = 'font-size:0.8em;cursor:pointer;user-select:none;opacity:0.6;margin-bottom:4px;display:none';
            thoughtsToggle.textContent = '💭 Show thoughts ▸';
            container.appendChild(thoughtsToggle);
            const thoughtsBox = document.createElement('div');
            thoughtsBox.style.cssText = 'display:none;border-left:2px solid rgba(255,255,255,0.15);padding-left:8px;margin-bottom:6px;font-style:italic;opacity:0.75;font-size:0.85em';
            container.appendChild(thoughtsBox);
            let thoughtsVisible = false;
            thoughtsToggle.addEventListener('click', () => {
                thoughtsVisible = !thoughtsVisible;
                thoughtsBox.style.display = thoughtsVisible ? 'block' : 'none';
                thoughtsToggle.textContent = thoughtsVisible ? '💭 Hide thoughts ▾' : '💭 Show thoughts ▸';
            });

            // Steps log
            const stepsLog = document.createElement('div');
            container.appendChild(stepsLog);

            copilotMessages.appendChild(container);
            copilotMessages.scrollTop = copilotMessages.scrollHeight;

            // Total timer
            const startTime = Date.now();
            const totalInterval = setInterval(() => {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                totalTimer.textContent = `${elapsed}s`;
            }, 100);

            // Per-step timer tracking
            let activeTimerInterval = null;
            let activeTimerEl = null;
            let activeStepStart = null;

            function stopActiveTimer() {
                if (activeTimerInterval) {
                    clearInterval(activeTimerInterval);
                    activeTimerInterval = null;
                    if (activeTimerEl && activeStepStart) {
                        const dur = ((Date.now() - activeStepStart) / 1000).toFixed(1);
                        activeTimerEl.textContent = `${dur}s`;
                        activeTimerEl.style.opacity = '0.5';
                    }
                }
            }

            function startStepTimer() {
                stopActiveTimer();
                activeStepStart = Date.now();
                const timerSpan = document.createElement('span');
                timerSpan.style.cssText = 'font-size:0.75em;opacity:0.7;font-family:monospace;margin-left:6px';
                timerSpan.textContent = '0.0s';
                activeTimerEl = timerSpan;
                activeTimerInterval = setInterval(() => {
                    const dur = ((Date.now() - activeStepStart) / 1000).toFixed(1);
                    timerSpan.textContent = `${dur}s`;
                }, 100);
                return timerSpan;
            }

            const log = {
                el: container,
                addThought(text) {
                    thoughtsToggle.style.display = 'block';
                    const entry = document.createElement('div');
                    entry.style.marginBottom = '3px';
                    entry.textContent = text.split('\n')[0];
                    thoughtsBox.appendChild(entry);
                    copilotMessages.scrollTop = copilotMessages.scrollHeight;
                },
                addToolStart(displayName, argsStr) {
                    const entry = document.createElement('div');
                    entry.style.cssText = 'margin-bottom:2px;display:flex;align-items:baseline;flex-wrap:wrap';
                    const label = document.createElement('span');
                    label.innerHTML = `<span style="opacity:0.7">🔧</span> <strong>${displayName}</strong>`;
                    entry.appendChild(label);
                    if (argsStr) {
                        const argsEl = document.createElement('span');
                        argsEl.style.cssText = 'font-size:0.8em;opacity:0.6;margin-left:4px';
                        argsEl.textContent = `(${argsStr})`;
                        entry.appendChild(argsEl);
                    }
                    const timer = startStepTimer();
                    entry.appendChild(timer);
                    stepsLog.appendChild(entry);
                    copilotMessages.scrollTop = copilotMessages.scrollHeight;
                },
                addToolResult(resultText) {
                    stopActiveTimer();
                    if (resultText) {
                        const entry = document.createElement('div');
                        entry.style.cssText = 'font-size:0.75em;opacity:0.4;margin-bottom:4px;margin-left:20px;white-space:pre-wrap;max-height:60px;overflow:hidden';
                        entry.textContent = `↳ ${resultText.slice(0, 150)}`;
                        stepsLog.appendChild(entry);
                        copilotMessages.scrollTop = copilotMessages.scrollHeight;
                    }
                },
                addExecStep(text) {
                    const entry = document.createElement('div');
                    entry.style.cssText = 'margin-bottom:2px;display:flex;align-items:baseline';
                    const label = document.createElement('span');
                    label.style.fontWeight = 'bold';
                    label.textContent = `⚡ ${text}`;
                    entry.appendChild(label);
                    const timer = startStepTimer();
                    entry.appendChild(timer);
                    stepsLog.appendChild(entry);
                    copilotMessages.scrollTop = copilotMessages.scrollHeight;
                },
                remove() {
                    stopActiveTimer();
                    clearInterval(totalInterval);
                    container.remove();
                }
            };
            return log;
        }

        // ── Load chat history ──
        async function loadChatHistory() {
            try {
                const res = await fetch('/api/ai/history');
                const data = await res.json();

                // Clear welcome message
                copilotMessages.innerHTML = '';
                _lastRenderedDate = '';

                if (!data.messages || data.messages.length === 0) {
                    // Show welcome if no history
                    copilotMessages.innerHTML = `
                        <div class="copilot-welcome">
                            <span class="copilot-welcome-icon">✨</span>
                            <span class="copilot-welcome-text">Hey! I'm your AI copilot. Ask me anything about your tasks, or let me help you organize.</span>
                        </div>`;
                    copilotHistoryLoaded = true;
                    return;
                }

                let planIndex = 0;
                for (const msg of data.messages) {
                    if (msg.role === 'user') {
                        addMessage('user', msg.content, msg.timestamp, true);
                    } else if (msg.role === 'assistant') {
                        addMessage('assistant', msg.content, msg.timestamp, true);
                    } else if (msg.role === 'plan') {
                        addPlanCard(msg.content, msg.status, planIndex, true);
                        planIndex++;
                    }
                }

                copilotMessages.scrollTop = copilotMessages.scrollHeight;
                copilotHistoryLoaded = true;
            } catch (err) {
                console.error('Failed to load chat history:', err);
                copilotHistoryLoaded = true;
            }
        }

        // ── Friendly tool name mapping ──
        const TOOL_DISPLAY_NAMES = {
            get_items: 'Reading task tree',
            get_timeline: 'Reading timeline',
            get_settings: 'Reading settings',
            get_preferences: 'Reading preferences',
            read_file: 'Reading file',
            list_files: 'Listing files',
            run_command: 'Running command'
        };

        function getToolDisplayName(toolName, args) {
            if (toolName === 'read_file' && args?.filePath) return `Reading ${args.filePath}`;
            if (toolName === 'list_files' && args?.dirPath) return `Listing ${args.dirPath}`;
            if (toolName === 'run_command' && args?.command) return `Running: ${args.command}`;
            return TOOL_DISPLAY_NAMES[toolName] || toolName;
        }

        // ── Send message ──
        async function sendMessage() {
            const text = copilotInput.value.trim();
            if (!text || copilotLoading) return;

            copilotInput.value = '';
            copilotInput.style.height = 'auto';

            // Clear welcome if it's the first message
            const welcome = copilotMessages.querySelector('.copilot-welcome');
            if (welcome) welcome.remove();

            addMessage('user', text, Date.now());

            const execLog = createExecLog();
            copilotLoading = true;
            copilotSend.disabled = true;

            try {
                const res = await fetch('/api/ai/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: text
                    })
                });

                if (!res.ok) {
                    execLog.remove();
                    const err = await res.json().catch(() => ({ error: 'Request failed' }));
                    addMessage('assistant', `❌ Error: ${err.error || 'Something went wrong'}`, Date.now());
                    return;
                }

                // Read SSE stream
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let finalData = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });

                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        try {
                            const event = JSON.parse(line.slice(6));

                            if (event.type === 'status') {
                                if (event.text) execLog.addThought(event.text);
                            } else if (event.type === 'tool_start') {
                                const displayName = getToolDisplayName(event.tool, event.args);
                                const argsStr = event.args ? Object.entries(event.args).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
                                execLog.addToolStart(displayName, argsStr);
                            } else if (event.type === 'tool_done') {
                                execLog.addToolResult(event.result);
                            } else if (event.type === 'done') {
                                finalData = event;
                            } else if (event.type === 'error') {
                                execLog.remove();
                                addMessage('assistant', `❌ Error: ${event.error || 'Something went wrong'}`, Date.now());
                                return;
                            }
                        } catch { /* skip malformed lines */ }
                    }
                }

                execLog.remove();

                if (finalData) {
                    if (finalData.plan && finalData.plan.length > 0) {
                        // Get plan index from server
                        const histRes = await fetch('/api/ai/history');
                        const histData = await histRes.json();
                        const planIdx = histData.messages.filter(m => m.role === 'plan').length - 1;
                        // Text is shown as intent inside the plan card
                        addPlanCard(finalData.plan, 'pending', planIdx, false, finalData.text);
                    } else if (finalData.text) {
                        addMessage('assistant', finalData.text, Date.now());
                    }
                }

            } catch (err) {
                loadingEl.remove();
                addMessage('assistant', `❌ Connection error: ${err.message}`, Date.now());
            } finally {
                copilotLoading = false;
                copilotSend.disabled = false;
            }
        }

        copilotSend.addEventListener('click', sendMessage);
        copilotInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Auto-resize textarea as user types
        function autoResizeCopilotInput() {
            copilotInput.style.height = 'auto';
            copilotInput.style.height = Math.min(copilotInput.scrollHeight, 120) + 'px';
        }
        copilotInput.addEventListener('input', autoResizeCopilotInput);

        // ── Execute pending plan ──
        async function executePendingPlan(card, planIndex) {
            if (!copilotPendingPlan) return;

            const plan = copilotPendingPlan;
            copilotPendingPlan = null;

            card.querySelectorAll('.copilot-plan-btn').forEach(b => b.disabled = true);
            card.classList.add('copilot-plan-executing');

            // Show execution progress with log manager
            const execLog = createExecLog();

            try {
                const res = await fetch('/api/ai/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ toolCalls: plan })
                });

                // Read SSE stream for real-time progress
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let finalData = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });

                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        try {
                            const event = JSON.parse(line.slice(6));

                            if (event.type === 'exec_step') {
                                const stepText = event.description || getToolDisplayName(event.tool, event.args);
                                const progress = event.total ? ` (${event.step}/${event.total})` : '';
                                execLog.addExecStep(`${stepText}${progress}`);
                            } else if (event.type === 'status') {
                                if (event.text) execLog.addThought(event.text);
                            } else if (event.type === 'tool_start') {
                                const displayName = getToolDisplayName(event.tool, event.args);
                                const argsStr = event.args ? Object.entries(event.args).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
                                execLog.addToolStart(displayName, argsStr);
                            } else if (event.type === 'tool_done') {
                                execLog.addToolResult(event.result);
                            } else if (event.type === 'done') {
                                finalData = event;
                            } else if (event.type === 'error') {
                                execLog.remove();
                                addMessage('assistant', `❌ Error: ${event.error || 'Execution failed'}`, Date.now());
                                card.classList.remove('copilot-plan-executing');
                                return;
                            }
                        } catch { /* skip malformed */ }
                    }
                }

                execLog.remove();

                if (finalData) {
                    const allResults = finalData.results || [];
                    const successes = allResults.filter(r => r.success) || [];
                    const failures = allResults.filter(r => !r.success) || [];

                    card.classList.add('copilot-plan-done');
                    card.querySelector('.copilot-plan-actions')?.remove();

                    // Persist applied status
                    await fetch(`/api/ai/plan/${planIndex}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'applied' })
                    });

                    // Show AI summary from continuation, or default count message
                    if (finalData.summary) {
                        addMessage('assistant', finalData.summary, Date.now());
                    } else if (failures.length > 0) {
                        addMessage('assistant', `⚠️ ${successes.length} succeeded, ${failures.length} failed: ${failures.map(f => f.result?.error).join(', ')}`, Date.now());
                    } else {
                        addMessage('assistant', `✅ Done! ${successes.length} action${successes.length !== 1 ? 's' : ''} applied.`, Date.now());
                    }

                    await loadAll();
                    renderAll();
                }

            } catch (err) {
                execLog.remove();
                addMessage('assistant', `❌ Execution error: ${err.message}`, Date.now());
                card.classList.remove('copilot-plan-executing');
            }
        }

        // ── Clear chat ──
        document.getElementById('copilot-clear')?.addEventListener('click', async () => {
            if (!confirm('Clear chat history? This cannot be undone.')) return;
            await fetch('/api/ai/history', { method: 'DELETE' });
            copilotMessages.innerHTML = `
                <div class="copilot-welcome">
                    <span class="copilot-welcome-icon">✨</span>
                    <span class="copilot-welcome-text">Hey! I'm your AI copilot. Ask me anything about your tasks, or let me help you organize.</span>
                </div>`;
            _lastRenderedDate = '';
            copilotPendingPlan = null;
        });

        // ── Keyboard shortcut: Ctrl/Cmd + K to toggle copilot ──
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                toggleCopilot();
            }
            if (e.key === 'Escape' && copilotOpen) {
                if (document.activeElement === copilotInput || !document.querySelector('.modal-overlay, .plan-editor')) {
                    toggleCopilot(false);
                }
            }
        });
    }
});
