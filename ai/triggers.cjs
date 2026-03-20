/**
 * ai/triggers.cjs — AI Trigger Engine
 * 
 * Server-side event bus that monitors application state and invokes the AI
 * autonomously when conditions are met. Messages are saved to chat history
 * and users are notified via the unread badge system.
 * 
 * Architecture:
 * - Generic trigger registry (easy to add new triggers)
 * - 30-second tick loop checks all enabled triggers
 * - Rate limiting (default 100/hour, configurable)
 * - Per-trigger cooldown prevents duplicate fires
 * - Uses triggerChat() from executor.cjs for lightweight AI calls
 */

const { triggerChat } = require('./executor.cjs');

// ── Built-in Trigger Definitions ──

const BUILT_IN_TRIGGERS = {
    session_ending: {
        label: '⏰ Session Ending',
        description: 'Notifies when a work session or break is about to end',
        defaultEnabled: true,
        defaultConfig: { minutesBefore: 5 },
        configSchema: [
            { key: 'minutesBefore', label: 'Minutes before end', type: 'number', min: 1, max: 60 }
        ],
        cooldownMs: 10 * 60 * 1000, // 10 min — don't re-fire for the same session
        check(state) {
            const active = state.workingOn || state.onBreak;
            if (!active || !active.targetEndTime || !active.startTime) return false;
            const remaining = active.targetEndTime - Date.now();
            const totalDuration = active.targetEndTime - active.startTime;
            const configuredMs = (state._triggerConfig?.minutesBefore || 5) * 60 * 1000;
            // Cap at 1/3 of total duration so short sessions aren't triggered immediately
            const thresholdMs = Math.min(configuredMs, totalDuration / 3);
            return remaining > 0 && remaining <= thresholdMs;
        },
        buildPrompt(state) {
            const isBreak = !state.workingOn && !!state.onBreak;
            const active = state.workingOn || state.onBreak;
            const remaining = Math.round((active.targetEndTime - Date.now()) / 60000);
            const label = isBreak ? 'break' : `work session on "${active.itemName || 'current task'}"`;
            return `[TRIGGER: Session Ending] The user's current ${label} is ending in about ${remaining} minute(s). ` +
                `Keep your response very brief (2-3 sentences max). Let them know time is almost up. ` +
                (isBreak ? `Suggest getting ready to jump back into work.` : `Suggest what to do next based on their plan.`) + ` ` +
                `Be encouraging and ADHD-friendly — no pressure, just a gentle nudge.`;
        }
    },

    session_overtime: {
        label: '⏱️ Session Overtime',
        description: 'Repeating nudge when session or break goes past planned end',
        defaultEnabled: true,
        defaultConfig: { repeatIntervalMin: 10 },
        configSchema: [
            { key: 'repeatIntervalMin', label: 'Repeat every (minutes)', type: 'number', min: 5, max: 60 }
        ],
        cooldownMs: 0, // managed by repeatIntervalMin
        _lastFiredAt: 0,
        check(state) {
            const active = state.workingOn || state.onBreak;
            if (!active || !active.targetEndTime) return false;
            if (active.targetEndTime - Date.now() > 0) return false; // not overtime yet
            const interval = (state._triggerConfig?.repeatIntervalMin || 10) * 60 * 1000;
            return (Date.now() - (this._lastFiredAt || 0)) >= interval;
        },
        buildPrompt(state) {
            const isBreak = !state.workingOn && !!state.onBreak;
            const active = state.workingOn || state.onBreak;
            const overMin = Math.round((Date.now() - active.targetEndTime) / 60000);
            const label = isBreak ? 'break' : `work session on "${active.itemName || 'current task'}"`;
            return `[TRIGGER: Session Overtime] The user is ${overMin} minute(s) past their planned end time for their ${label}. ` +
                `Give a very brief (2-3 sentences) gentle nudge. ` +
                (isBreak ? `Remind them the break is over and suggest getting back to work.` : `Acknowledge they might be in flow, but remind them they're over time. Suggest either wrapping up or consciously extending.`) + ` ` +
                `Be ADHD-friendly — no guilt, just awareness.`;
        }
    },

    idle_too_long: {
        label: '😴 Idle Too Long',
        description: 'Repeating nudge when not working or on break for a while',
        defaultEnabled: true,
        defaultConfig: { idleMinutes: 15, repeatIntervalMin: 15 },
        configSchema: [
            { key: 'idleMinutes', label: 'Idle threshold (minutes)', type: 'number', min: 5, max: 120 },
            { key: 'repeatIntervalMin', label: 'Repeat every (minutes)', type: 'number', min: 5, max: 120 }
        ],
        cooldownMs: 0, // managed by repeatIntervalMin
        _lastFiredAt: 0,
        check(state) {
            // Only fire when user is not working and not on break
            if (state.workingOn || state.onBreak) return false;
            // Need a reference point — use lastSessionEnd from state
            const lastEnd = state._lastSessionEndTime;
            if (!lastEnd) return false;
            const idleMs = Date.now() - lastEnd;
            const thresholdMs = (state._triggerConfig?.idleMinutes || 15) * 60 * 1000;
            if (idleMs < thresholdMs) return false;
            const interval = (state._triggerConfig?.repeatIntervalMin || 15) * 60 * 1000;
            return (Date.now() - (this._lastFiredAt || 0)) >= interval;
        },
        buildPrompt(state) {
            const idleMin = state._lastSessionEndTime ? Math.round((Date.now() - state._lastSessionEndTime) / 60000) : '?';
            return `[TRIGGER: Idle Too Long] The user has been idle for about ${idleMin} minute(s) — no active work session or break. ` +
                `Give a very brief (2-3 sentences) gentle nudge to help them get started again. ` +
                `Suggest picking something from their plan. Reduce decision paralysis by naming one specific option. ` +
                `Be ADHD-friendly — this is about gentle momentum, not guilt.`;
        }
    },

    work_stretch: {
        label: '🧘 Take a Break',
        description: 'Repeating nudge to take a break after working continuously',
        defaultEnabled: true,
        defaultConfig: { workMinutes: 25, repeatIntervalMin: 25 },
        configSchema: [
            { key: 'workMinutes', label: 'After working (minutes)', type: 'number', min: 10, max: 120 },
            { key: 'repeatIntervalMin', label: 'Repeat every (minutes)', type: 'number', min: 10, max: 120 }
        ],
        cooldownMs: 0,
        _lastFiredAt: 0,
        check(state) {
            if (!state.workingOn || !state.workingOn.startTime) return false;
            const workingMs = Date.now() - state.workingOn.startTime;
            const thresholdMs = (state._triggerConfig?.workMinutes || 25) * 60 * 1000;
            if (workingMs < thresholdMs) return false;
            const interval = (state._triggerConfig?.repeatIntervalMin || 25) * 60 * 1000;
            return (Date.now() - (this._lastFiredAt || 0)) >= interval;
        },
        buildPrompt(state) {
            const workMin = Math.round((Date.now() - state.workingOn.startTime) / 60000);
            const taskName = state.workingOn.itemName || 'current task';
            return `[TRIGGER: Take a Break] The user has been working on "${taskName}" for ${workMin} minutes straight. ` +
                `Suggest a quick break — stretching, water, a short walk, or just looking away from the screen. ` +
                `Keep it very brief (2-3 sentences). Be encouraging about their focus but remind them that breaks help with ADHD and sustained attention.`;
        }
    },

    day_end_approaching: {
        label: '🌅 Day End Approaching',
        description: 'Gentle wind-down nudge as the day end time approaches',
        defaultEnabled: true,
        defaultConfig: { minutesBefore: 30 },
        configSchema: [
            { key: 'minutesBefore', label: 'Minutes before day end', type: 'number', min: 5, max: 120 }
        ],
        cooldownMs: 60 * 60 * 1000, // 1 hour — only once per day end
        check(state) {
            const settings = state.settings || {};
            const endH = settings.dayEndHour ?? 22;
            const endM = settings.dayEndMinute ?? 0;
            const now = new Date();
            const dayEnd = new Date(now);
            dayEnd.setHours(endH, endM, 0, 0);
            // Only fire if day end is in the future
            if (dayEnd <= now) return false;
            const remaining = dayEnd - now;
            const thresholdMs = (state._triggerConfig?.minutesBefore || 30) * 60 * 1000;
            return remaining <= thresholdMs;
        },
        buildPrompt(state) {
            const settings = state.settings || {};
            const endH = settings.dayEndHour ?? 22;
            const endM = settings.dayEndMinute ?? 0;
            return `[TRIGGER: Day End Approaching] The user's configured day end time is ${endH}:${String(endM).padStart(2, '0')}. ` +
                `It's getting close! Give a brief (2-3 sentences) wind-down nudge. ` +
                `Suggest wrapping up current work and mention anything important left for today. ` +
                `Be warm and ADHD-friendly — this is a soft nudge, not a hard cutoff.`;
        }
    },

    day_start_reminder: {
        label: '☀️ Day Start Reminder',
        description: 'Reminder that planned day start has passed — nudge to start the day',
        defaultEnabled: true,
        defaultConfig: { minutesAfter: 15 },
        configSchema: [
            { key: 'minutesAfter', label: 'Minutes after planned start', type: 'number', min: 0, max: 120 }
        ],
        cooldownMs: 60 * 60 * 1000, // 1 hour — only once per morning
        check(state) {
            const settings = state.settings || {};
            const startH = settings.dayStartHour ?? 8;
            const startM = settings.dayStartMinute ?? 0;
            const now = new Date();

            // Compute today's date key (YYYY-MM-DD)
            const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const todayOverride = settings.dayOverrides?.[todayKey];

            // Don't fire if this day is already started or closed
            if (todayOverride?.dayStarted || todayOverride?.dayClosed) return false;

            // Compute the planned start time
            const dayStart = new Date(now);
            dayStart.setHours(startH, startM, 0, 0);

            // Only fire if planned start is in the past
            if (now < dayStart) return false;

            // Fire after the configured grace period
            const elapsed = now - dayStart;
            const thresholdMs = (state._triggerConfig?.minutesAfter ?? 15) * 60 * 1000;
            return elapsed >= thresholdMs;
        },
        buildPrompt(state) {
            const settings = state.settings || {};
            const startH = settings.dayStartHour ?? 8;
            const startM = settings.dayStartMinute ?? 0;
            const now = new Date();
            const elapsed = Math.round((now - new Date(now.getFullYear(), now.getMonth(), now.getDate(), startH, startM)) / 60000);
            return `[TRIGGER: Day Start Reminder] The user's planned day start time was ${startH}:${String(startM).padStart(2, '0')} ` +
                `(about ${elapsed} minutes ago), but they haven't started their day yet. ` +
                `Give a brief (2-3 sentences) encouraging nudge. Remind them it's a new day full of opportunities and things to do. ` +
                `Gently suggest clicking "Start Day" to kick things off. ` +
                `Be warm, optimistic, and ADHD-friendly — reduce inertia, no guilt, just a friendly invite to begin.`;
        }
    },

    session_started: {
        label: '🚀 Session Started',
        description: 'Quick context nudge when starting a work session or break',
        defaultEnabled: true,
        defaultConfig: {},
        configSchema: [],
        cooldownMs: 5 * 60 * 1000,
        isEventDriven: true,
        eventType: 'session_started',
        buildPrompt(state, eventData) {
            const isBreak = eventData?.isBreak;
            const taskName = eventData?.itemName || 'the task';
            const durMin = eventData?.targetDurationMin;
            const durStr = durMin ? ` They've set ${durMin} minutes.` : '';
            if (isBreak) {
                return `[TRIGGER: Break Started] The user just started a break.${durStr} ` +
                    `Give a very brief (2-3 sentences) encouraging message. Suggest a quick way to recharge — stretching, water, fresh air. ` +
                    `Be warm and ADHD-friendly.`;
            }
            return `[TRIGGER: Session Started] The user just started working on "${taskName}".${durStr} ` +
                `Give a very brief (2-3 sentences) encouraging kickoff. Mention any relevant context from their plan for today. ` +
                `Help them focus — suggest one concrete first step to reduce startup friction. Be ADHD-friendly and energizing.`;
        }
    },

    session_completed: {
        label: '✅ Session Completed',
        description: 'Suggests what to do next after finishing a work session or break',
        defaultEnabled: true,
        defaultConfig: {},
        configSchema: [],
        cooldownMs: 5 * 60 * 1000,
        isEventDriven: true,
        eventType: 'session_completed',
        buildPrompt(state, eventData) {
            const isBreak = eventData?.isBreak;
            const taskName = eventData?.itemName || 'the task';
            const durationMin = eventData?.durationMs ? Math.round(eventData.durationMs / 60000) : null;
            const durStr = durationMin ? ` (${durationMin} minutes)` : '';
            if (isBreak) {
                return `[TRIGGER: Break Completed] The user just finished their break${durStr}. ` +
                    `Welcome them back! Give a very brief (2-3 sentences) suggestion for what to work on next based on their plan. ` +
                    `Reduce decision paralysis by suggesting one clear next step. Be energizing.`;
            }
            return `[TRIGGER: Session Completed] The user just finished working on "${taskName}"${durStr}. ` +
                `Congratulate them on the progress! Suggest a quick physical refresh like a short walk, stretching, or grabbing a glass of water. ` +
                `Then, give a brief (2-3 sentences) suggestion for what to do next based on their plan for today. ` +
                `Be encouraging and reduce decision paralysis by suggesting a clear next step.`;
        }
    },

    heartbeat: {
        label: '💓 Heartbeat Check-in',
        description: 'Periodic check-in on overall progress',
        defaultEnabled: false, // opt-in — could be noisy
        defaultConfig: { intervalMinutes: 60 },
        configSchema: [
            { key: 'intervalMinutes', label: 'Check-in interval (minutes)', type: 'number', min: 15, max: 240 }
        ],
        cooldownMs: 0, // cooldown is managed by the interval itself
        _lastFiredAt: 0,
        check(state) {
            const interval = (state._triggerConfig?.intervalMinutes || 60) * 60 * 1000;
            const elapsed = Date.now() - (this._lastFiredAt || 0);
            return elapsed >= interval;
        },
        buildPrompt(state) {
            return `[TRIGGER: Heartbeat Check-in] Periodic check-in. Give a very brief (2-3 sentences) overview of how the user's day is going. ` +
                `Mention what they've accomplished, how much time they have left, and if anything needs attention. ` +
                `Keep it light, encouraging, and ADHD-friendly.`;
        }
    }
};

// ── Trigger Engine Class ──

class TriggerEngine {
    constructor({ stores, chatStore, settingsStore, notifyAiUnread }) {
        this._stores = stores;
        this._chatStore = chatStore;
        this._settingsStore = settingsStore;
        this._notifyAiUnread = notifyAiUnread;
        this._interval = null;
        this._cooldowns = {}; // triggerId → last fired timestamp
        this._invocationTimestamps = []; // for rate limiting
        this._lastSessionEndTime = null; // for idle detection
        this._running = false;
    }

    /**
     * Get all trigger definitions with their current enabled/config state.
     */
    async getTriggers(settings = null) {
        if (!settings) settings = await this._settingsStore.read();
        const triggerSettings = settings.triggers || {};

        return Object.entries(BUILT_IN_TRIGGERS).map(([id, def]) => {
            const userConfig = triggerSettings[id] || {};
            return {
                id,
                label: def.label,
                description: def.description,
                enabled: userConfig.enabled !== undefined ? userConfig.enabled : def.defaultEnabled,
                config: { ...def.defaultConfig, ...userConfig.config },
                configSchema: def.configSchema || [],
                isEventDriven: !!def.isEventDriven
            };
        });
    }

    /**
     * Update a trigger's enabled state and/or config.
     */
    async updateTrigger(triggerId, updates) {
        if (!BUILT_IN_TRIGGERS[triggerId]) {
            throw new Error(`Unknown trigger: ${triggerId}`);
        }
        const settings = await this._settingsStore.read();
        if (!settings.triggers) settings.triggers = {};
        if (!settings.triggers[triggerId]) settings.triggers[triggerId] = {};

        if (updates.enabled !== undefined) {
            settings.triggers[triggerId].enabled = updates.enabled;
        }
        if (updates.config) {
            settings.triggers[triggerId].config = {
                ...(settings.triggers[triggerId].config || {}),
                ...updates.config
            };
        }

        await this._settingsStore.write(settings);
        return this.getTriggers();
    }

    /**
     * Start the tick loop.
     */
    start() {
        if (this._interval) return;
        this._running = true;
        console.log('[TriggerEngine] Started (30s tick interval)');
        this._interval = setInterval(() => this._tick(), 30 * 1000);
    }

    /**
     * Stop the tick loop.
     */
    stop() {
        this._running = false;
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
        console.log('[TriggerEngine] Stopped');
    }

    /**
     * Fire an event-driven trigger (called from application code).
     */
    async fireEvent(eventType, eventData = {}) {
        const triggers = await this.getTriggers();
        const matching = triggers.filter(t => {
            const def = BUILT_IN_TRIGGERS[t.id];
            return def.isEventDriven && def.eventType === eventType && t.enabled;
        });

        for (const trigger of matching) {
            await this._invoke(trigger.id, eventData);
        }

        // Track session end time for idle detection
        if (eventType === 'session_completed') {
            this._lastSessionEndTime = Date.now();
        }
    }

    /**
     * Main tick — check all tick-driven triggers.
     */
    async _tick() {
        if (!this._running) return;

        try {
            // Read settings once for the entire tick
            const settings = await this._settingsStore.read();
            const triggers = await this.getTriggers(settings);
            const state = await this._buildState(settings);

            for (const trigger of triggers) {
                if (!trigger.enabled) continue;
                const def = BUILT_IN_TRIGGERS[trigger.id];
                if (def.isEventDriven) continue; // event-driven triggers skip tick

                // Inject per-trigger config into state for the check function
                state._triggerConfig = trigger.config;

                if (def.check.call(def, state)) {
                    await this._invoke(trigger.id, {}, settings);
                }
            }
        } catch (err) {
            console.error('[TriggerEngine] Tick error:', err.message);
        }
    }

    /**
     * Build application state snapshot for trigger checks.
     */
    async _buildState(settings = null) {
        const prefs = await this._stores.preferences.read();
        if (!settings) settings = await this._settingsStore.read();
        return {
            workingOn: prefs.workingOn || null,
            onBreak: prefs.onBreak || null,
            settings,
            _lastSessionEndTime: this._lastSessionEndTime
        };
    }

    /**
     * Invoke the AI for a triggered event.
     * @param {string} triggerId
     * @param {object} eventData
     * @param {object} [preloadedSettings] - Pre-loaded settings to avoid redundant reads
     */
    async _invoke(triggerId, eventData = {}, preloadedSettings = null) {
        const def = BUILT_IN_TRIGGERS[triggerId];
        if (!def) return;

        // Check cooldown
        const lastFired = this._cooldowns[triggerId] || 0;
        if (def.cooldownMs && (Date.now() - lastFired) < def.cooldownMs) {
            return; // still in cooldown
        }

        // Load settings once (reuse preloaded if available)
        const settings = preloadedSettings || await this._settingsStore.read();

        // Check rate limit
        const rateLimit = settings.triggerRateLimit || 100;
        const now = Date.now();
        const oneHourAgo = now - 60 * 60 * 1000;
        this._invocationTimestamps = this._invocationTimestamps.filter(ts => ts > oneHourAgo);
        if (this._invocationTimestamps.length >= rateLimit) {
            console.log(`[TriggerEngine] Rate limit reached (${rateLimit}/hour), skipping ${triggerId}`);
            return;
        }

        // Build prompt — reuse settings we already have
        const state = await this._buildState(settings);
        const triggers = await this.getTriggers(settings);
        const triggerInfo = triggers.find(t => t.id === triggerId);
        state._triggerConfig = triggerInfo?.config || {};
        const prompt = def.buildPrompt(state, eventData);

        console.log(`[TriggerEngine] Invoking AI for trigger: ${triggerId}`);

        try {
            // Call AI — pass settings directly
            const response = await triggerChat(prompt, this._stores, settings);
            const responseText = typeof response === 'string' ? response : response?.text;
            const responseActions = typeof response === 'object' ? response?.actions : null;

            if (!responseText || responseText.trim().length === 0) {
                console.log(`[TriggerEngine] AI returned empty response for ${triggerId}, skipping`);
                return;
            }

            // Save to chat history with trigger metadata
            const chatData = await this._chatStore.read();
            const msg = {
                role: 'assistant',
                content: responseText,
                timestamp: Date.now(),
                trigger: triggerId,
                triggerLabel: def.label
            };
            if (responseActions) msg.actions = responseActions;
            chatData.messages.push(msg);

            // Increment unread count
            chatData.unreadCount = (chatData.unreadCount || 0) + 1;
            await this._chatStore.write(chatData);

            // Push SSE notification
            this._notifyAiUnread(chatData.unreadCount);

            // Update cooldown
            this._cooldowns[triggerId] = Date.now();
            if (def._lastFiredAt !== undefined) {
                def._lastFiredAt = Date.now();
            }

            // Record invocation for rate limiting
            this._invocationTimestamps.push(Date.now());

            console.log(`[TriggerEngine] ✅ ${triggerId} → message saved, unread: ${chatData.unreadCount}`);
        } catch (err) {
            console.error(`[TriggerEngine] ❌ ${triggerId} failed:`, err.message);
        }
    }
}

module.exports = { TriggerEngine, BUILT_IN_TRIGGERS };
