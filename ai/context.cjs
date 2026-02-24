/**
 * ai/context.cjs — World state snapshot builder
 * 
 * Builds a pruned snapshot of all app data for injection into AI prompts.
 * Prunes items tree (depth limit, done filter), filters timeline to recent days.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJson(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Prune the items tree for context injection.
 * - Limits depth
 * - Optionally filters out done items
 * - Summarizes large branches
 */
function pruneItems(items, maxDepth = 4, currentDepth = 0, includeDone = false) {
    if (!items || !Array.isArray(items)) return [];

    return items
        .filter(item => includeDone || !item.done)
        .map(item => {
            const pruned = {
                id: item.id,
                name: item.name,
            };

            // Include key properties if they exist
            if (item.isInbox) pruned.isInbox = true;
            if (item.done) pruned.done = true;
            if (item.timeContexts && item.timeContexts.length > 0) {
                pruned.timeContexts = item.timeContexts;
            }
            if (item.contextDurations) pruned.contextDurations = item.contextDurations;
            if (item.deadline) pruned.deadline = item.deadline;
            if (item.notes) pruned.notes = item.notes;

            // Handle children
            if (item.children && item.children.length > 0) {
                if (currentDepth >= maxDepth) {
                    pruned.childrenCount = item.children.length;
                    pruned.childrenSummary = `${item.children.length} children (collapsed)`;
                } else {
                    const prunedChildren = pruneItems(item.children, maxDepth, currentDepth + 1, includeDone);
                    if (prunedChildren.length > 0) {
                        pruned.children = prunedChildren;
                    }
                }
            }

            return pruned;
        });
}

/**
 * Filter timeline entries to recent N days.
 */
function filterTimeline(entries, days = 7) {
    if (!entries || !Array.isArray(entries)) return [];
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return entries
        .filter(e => (e.timestamp || e.startTime || 0) >= cutoff)
        .map(e => ({
            id: e.id,
            name: e.name,
            startTime: e.startTime,
            endTime: e.endTime,
            duration: e.duration,
            itemId: e.itemId,
            type: e.type
        }));
}

/**
 * Build the full context snapshot for AI consumption.
 */
function buildContext() {
    const items = readJson('items.json');
    const timeline = readJson('timeline.json');
    const settings = readJson('settings.json');
    const preferences = readJson('preferences.json');

    const now = new Date();

    // Build structured context
    const context = {
        currentTime: now.toISOString(),
        currentTimeLocal: now.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Jerusalem'
        }),
    };

    // Active task
    if (preferences?.workingOn) {
        context.activeTask = {
            name: preferences.workingOn.itemName,
            project: preferences.workingOn.projectName,
            startedAt: new Date(preferences.workingOn.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            runningFor: Math.round((Date.now() - preferences.workingOn.startTime) / 60000) + ' minutes'
        };
    }

    // On break?
    if (preferences?.onBreak) {
        context.onBreak = true;
    }

    // View state
    context.viewHorizon = preferences?.viewHorizon || 'day';
    context.streak = preferences?.streak || 0;

    // Pruned items tree
    if (items?.items) {
        context.itemsTree = pruneItems(items.items);
        context.totalItemCount = countItems(items.items);
    }

    // Recent timeline
    if (timeline?.entries) {
        context.recentTimeline = filterTimeline(timeline.entries, 7);
    }

    // Settings
    if (settings) {
        context.dayStart = `${settings.dayStartHour || 8}:${String(settings.dayStartMinute || 0).padStart(2, '0')}`;
        context.dayEnd = `${settings.dayEndHour || 22}:${String(settings.dayEndMinute || 0).padStart(2, '0')}`;
    }

    return context;
}

function countItems(items) {
    if (!items || !Array.isArray(items)) return 0;
    let count = 0;
    for (const item of items) {
        count++;
        if (item.children) count += countItems(item.children);
    }
    return count;
}

/**
 * Format context into a system prompt string.
 */
function buildSystemPrompt(context) {
    return `You are the AI copilot for "Anything Mini", an ADHD-friendly productivity app.

CORE VALUES: ADHD-friendly, simple, low friction.
- Be concise and actionable
- Don't overwhelm with too many options
- Suggest small, concrete next steps
- Be warm and encouraging

CURRENT STATE:
- Time: ${context.currentTimeLocal}
${context.activeTask ? `- Currently working on: "${context.activeTask.name}" (${context.activeTask.project}) — started ${context.activeTask.startedAt}, running for ${context.activeTask.runningFor}` : '- Not currently working on anything'}
${context.onBreak ? '- Currently on a break' : ''}
- View: ${context.viewHorizon} view
- Day hours: ${context.dayStart} – ${context.dayEnd}
- Total items in tree: ${context.totalItemCount || 0}

ITEMS TREE (pruned):
${JSON.stringify(context.itemsTree, null, 2)}

RECENT TIMELINE (last 7 days):
${JSON.stringify(context.recentTimeline, null, 2)}

IMPORTANT RULES:
- When creating items, always try to place them under an appropriate parent project. Ask the user if unsure.
- TimeContexts are arrays of strings like ["ongoing"], ["2026-W09"], ["2026-02-24"], ["2026-02"] etc.
- "ongoing" means the item is always visible. Date-specific contexts scope it to that period.
- When the user asks you to do something that requires changes, use the available tools to make those changes.
- Always explain what you're going to do before doing it.
- If in read-only mode, you can only answer questions — explain what you WOULD do if asked to make changes.

CODE CAPABILITIES:
- You can read and write files in the project using read_file, write_file, and list_files.
- You can run shell commands (build, test, git, grep, etc.) using run_command.
- All file paths are relative to the project root.
- When fixing code: read the relevant file(s) first, understand the code, then propose changes.
- Keep changes small and focused — one fix per iteration.
- After writing a file, consider running a quick validation (e.g. node -c for syntax check).

TOOL USAGE EFFICIENCY (CRITICAL):
- You have ~10 tool rounds. Be strategic — don't waste rounds.
- NEVER narrate what you're about to do ("Let me look at..."). Just DO it.
- For LARGE files (script.js is ~21000 lines): ALWAYS use run_command with grep to find relevant sections, then read_file with startLine/endLine to read just those lines. NEVER try to read the whole file.
- If a tool call fails or returns too much data, change your approach — do NOT retry the same thing.
- If you have enough information to answer, STOP calling tools and give the answer.
- Combine multiple observations into a single response rather than exploring endlessly.`;
}

module.exports = { buildContext, buildSystemPrompt, pruneItems, filterTimeline };
