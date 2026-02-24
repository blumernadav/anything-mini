/**
 * ai/tools.cjs — Tool definitions mapping AI function calls to existing API
 * 
 * Each tool has a name, description, parameters schema (for the AI),
 * and an execute function that operates on the data stores directly.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROJECT_ROOT = path.join(__dirname, '..');

// ============ Security Helpers ============

function resolveProjectPath(relativePath) {
    // Block absolute paths and path traversal
    if (path.isAbsolute(relativePath) || relativePath.includes('..')) {
        return null;
    }
    const resolved = path.resolve(PROJECT_ROOT, relativePath);
    // Ensure it's still within PROJECT_ROOT
    if (!resolved.startsWith(PROJECT_ROOT)) return null;
    return resolved;
}

// ============ Data Store Helpers ============
// Read/write JSON directly (same as server.cjs stores, but standalone)

function readStore(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeStore(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============ Item Tree Helpers ============

function findItemById(items, id) {
    for (const item of items) {
        if (item.id === id) return item;
        if (item.children) {
            const found = findItemById(item.children, id);
            if (found) return found;
        }
    }
    return null;
}

function findParentOf(items, id, parent = null) {
    for (const item of items) {
        if (item.id === id) return parent;
        if (item.children) {
            const found = findParentOf(item.children, id, item);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

function getItemPath(items, id) {
    for (const item of items) {
        if (item.id === id) return [item.name];
        if (item.children) {
            const subPath = getItemPath(item.children, id);
            if (subPath) return [item.name, ...subPath];
        }
    }
    return null;
}

// ============ Tool Definitions ============

const READ_TOOLS = [
    {
        name: 'get_items',
        description: 'Get the full items/projects tree. Returns the hierarchical structure of all items with their IDs, names, children, time contexts, and done status.',
        parameters: {
            type: 'object',
            properties: {},
        },
        async execute() {
            const data = readStore('items.json');
            return { items: data?.items || [] };
        }
    },
    {
        name: 'get_timeline',
        description: 'Get timeline entries (time tracking history). Returns logged work sessions with start/end times, durations, and linked item IDs.',
        parameters: {
            type: 'object',
            properties: {
                daysBack: {
                    type: 'number',
                    description: 'Number of days back to fetch. Default: 7'
                }
            }
        },
        async execute(args) {
            const data = readStore('timeline.json');
            const days = args?.daysBack || 7;
            const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
            const entries = (data?.entries || []).filter(e => (e.timestamp || e.startTime || 0) >= cutoff);
            return { entries, totalCount: data?.entries?.length || 0 };
        }
    },
    {
        name: 'get_settings',
        description: 'Get app settings (day start/end hours, etc).',
        parameters: {
            type: 'object',
            properties: {},
        },
        async execute() {
            return readStore('settings.json') || {};
        }
    },
    {
        name: 'get_preferences',
        description: 'Get user preferences including the current work timer (workingOn field), break status, skin, view settings. The workingOn field shows what the user is currently working on (itemId, itemName, projectName, startTime, targetEndTime) or null if idle.',
        parameters: {
            type: 'object',
            properties: {},
        },
        async execute() {
            return readStore('preferences.json') || {};
        }
    },
    {
        name: 'read_file',
        description: 'Read the contents of a file in the project. Path is relative to project root (e.g. "script.js", "ai/tools.cjs"). Returns file contents with line numbers. Max 100KB.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Relative path to the file from project root'
                },
                startLine: {
                    type: 'number',
                    description: 'Optional start line (1-indexed). If omitted, reads from beginning.'
                },
                endLine: {
                    type: 'number',
                    description: 'Optional end line (1-indexed, inclusive). If omitted, reads to end.'
                }
            },
            required: ['filePath']
        },
        async execute(args) {
            const resolved = resolveProjectPath(args.filePath);
            if (!resolved) return { error: 'Invalid path — must be relative to project root, no ".." allowed' };
            if (!fs.existsSync(resolved)) return { error: `File not found: ${args.filePath}` };
            const stat = fs.statSync(resolved);
            if (stat.isDirectory()) return { error: `${args.filePath} is a directory, not a file. Use list_files instead.` };
            if (stat.size > 100 * 1024) return { error: `File too large (${Math.round(stat.size / 1024)}KB). Max 100KB.` };
            const content = fs.readFileSync(resolved, 'utf8');
            const lines = content.split('\n');
            const start = Math.max(1, args.startLine || 1);
            const end = Math.min(lines.length, args.endLine || lines.length);
            const slice = lines.slice(start - 1, end);
            const numbered = slice.map((line, i) => `${start + i}: ${line}`).join('\n');
            return { filePath: args.filePath, totalLines: lines.length, showing: `${start}-${end}`, content: numbered };
        }
    },
    {
        name: 'list_files',
        description: 'List files and directories at a given path in the project. Path is relative to project root. Excludes node_modules and .git by default.',
        parameters: {
            type: 'object',
            properties: {
                dirPath: {
                    type: 'string',
                    description: 'Relative path to the directory. Use "." or omit for project root.'
                }
            }
        },
        async execute(args) {
            const dirPath = args?.dirPath || '.';
            const resolved = resolveProjectPath(dirPath);
            if (!resolved) return { error: 'Invalid path — must be relative to project root, no ".." allowed' };
            if (!fs.existsSync(resolved)) return { error: `Directory not found: ${dirPath}` };
            if (!fs.statSync(resolved).isDirectory()) return { error: `${dirPath} is a file, not a directory. Use read_file instead.` };
            const entries = fs.readdirSync(resolved, { withFileTypes: true })
                .filter(e => e.name !== 'node_modules' && e.name !== '.git')
                .map(e => ({
                    name: e.name,
                    type: e.isDirectory() ? 'directory' : 'file',
                    size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : undefined
                }));
            return { path: dirPath, entries };
        }
    }
];

const WRITE_TOOLS = [
    {
        name: 'create_item',
        description: 'Create a new item/task in the tree. Can be a root item or a child of an existing item. The item will be added to the top of its parent\'s children list.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the item to create'
                },
                parentId: {
                    type: 'number',
                    description: 'ID of the parent item to nest under. Omit for root-level item.'
                },
                timeContexts: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Time contexts like ["ongoing"], ["2026-W09"], ["2026-02-24"]. Defaults to ["ongoing"].'
                },
                contextDurations: {
                    type: 'object',
                    description: 'Planned durations per time context in minutes. Keys are context strings (e.g. "2026-02-24", "ongoing"), values are durations in minutes. Example: {"2026-02-24": 30}'
                }
            },
            required: ['name']
        },
        async execute(args) {
            const data = readStore('items.json');
            const newItem = {
                id: data.nextId++,
                name: args.name,
                children: [],
                expanded: false,
                createdAt: Date.now(),
                done: false,
                timeContexts: args.timeContexts || ['ongoing']
            };
            if (args.contextDurations) newItem.contextDurations = args.contextDurations;

            if (args.parentId) {
                const parent = findItemById(data.items, args.parentId);
                if (!parent) return { error: `Parent item ${args.parentId} not found` };
                parent.children = parent.children || [];
                parent.children.unshift(newItem);
            } else {
                const inboxIdx = data.items.findIndex(i => i.isInbox);
                data.items.splice(inboxIdx >= 0 ? inboxIdx + 1 : 0, 0, newItem);
            }

            writeStore('items.json', data);
            return { created: newItem, message: `Created "${args.name}" (id: ${newItem.id})` };
        },
        describe(args) {
            if (args.parentId) {
                return `➕ Create "${args.name}" under item #${args.parentId}`;
            }
            return `➕ Create "${args.name}" (root level)`;
        }
    },
    {
        name: 'update_item',
        description: 'Update an existing item by its ID. Can change name, done status, time contexts, notes, deadline, etc.',
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'number',
                    description: 'ID of the item to update'
                },
                name: {
                    type: 'string',
                    description: 'New name for the item'
                },
                done: {
                    type: 'boolean',
                    description: 'Mark as done or not done'
                },
                timeContexts: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'New time contexts'
                },
                contextDurations: {
                    type: 'object',
                    description: 'Planned durations per time context in minutes. Keys are context strings (e.g. "2026-02-24", "ongoing"), values are durations in minutes. Example: {"2026-02-24": 30}. Merges with existing durations.'
                },
                notes: {
                    type: 'string',
                    description: 'Notes for the item'
                },
                deadline: {
                    type: 'string',
                    description: 'Deadline date string (ISO format)'
                }
            },
            required: ['id']
        },
        async execute(args) {
            const data = readStore('items.json');
            const item = findItemById(data.items, args.id);
            if (!item) return { error: `Item ${args.id} not found` };

            const { id, contextDurations, ...updates } = args;
            Object.assign(item, updates);
            // Merge contextDurations (don't overwrite existing entries)
            if (contextDurations) {
                if (!item.contextDurations) item.contextDurations = {};
                Object.assign(item.contextDurations, contextDurations);
            }
            writeStore('items.json', data);

            return { updated: item, message: `Updated "${item.name}" (id: ${id})` };
        },
        describe(args) {
            const changes = Object.keys(args).filter(k => k !== 'id');
            return `✏️ Update item #${args.id}: ${changes.join(', ')}`;
        }
    },
    {
        name: 'delete_item',
        description: 'Delete an item and all its children from the tree. Use with caution.',
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'number',
                    description: 'ID of the item to delete'
                }
            },
            required: ['id']
        },
        async execute(args) {
            const data = readStore('items.json');

            // Find item name before deleting
            const item = findItemById(data.items, args.id);
            if (!item) return { error: `Item ${args.id} not found` };
            const name = item.name;

            const deleteRecursive = (items) => {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].id === args.id) {
                        items.splice(i, 1);
                        return true;
                    }
                    if (items[i].children && deleteRecursive(items[i].children)) return true;
                }
                return false;
            };

            deleteRecursive(data.items);
            writeStore('items.json', data);

            return { deleted: args.id, message: `Deleted "${name}" (id: ${args.id})` };
        },
        describe(args) {
            return `🗑️ Delete item #${args.id}`;
        }
    },
    {
        name: 'reorder_children',
        description: 'Reorder the children of an item. Provide the parent ID and either a new order of child IDs, or set reverse:true to reverse them.',
        parameters: {
            type: 'object',
            properties: {
                parentId: {
                    type: 'number',
                    description: 'ID of the parent item whose children to reorder'
                },
                childIds: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Ordered array of child IDs. All children must be listed. Omit if using reverse.'
                },
                reverse: {
                    type: 'boolean',
                    description: 'If true, simply reverse the current children order. Overrides childIds.'
                }
            },
            required: ['parentId']
        },
        async execute(args) {
            const data = readStore('items.json');
            const parent = findItemById(data.items, args.parentId);
            if (!parent) return { error: `Parent item ${args.parentId} not found` };
            if (!parent.children || parent.children.length === 0) return { error: 'Parent has no children' };

            if (args.reverse) {
                parent.children.reverse();
            } else if (args.childIds) {
                const childMap = {};
                for (const c of parent.children) childMap[c.id] = c;
                const reordered = [];
                for (const id of args.childIds) {
                    if (!childMap[id]) return { error: `Child ${id} not found under parent ${args.parentId}` };
                    reordered.push(childMap[id]);
                    delete childMap[id];
                }
                // Append any unmentioned children at the end
                for (const c of parent.children) {
                    if (childMap[c.id]) reordered.push(c);
                }
                parent.children = reordered;
            } else {
                return { error: 'Specify childIds or reverse:true' };
            }

            writeStore('items.json', data);
            return { message: `Reordered children of "${parent.name}" (${parent.children.length} items)` };
        },
        describe(args) {
            if (args.reverse) return `🔄 Reverse children order of item #${args.parentId}`;
            return `🔄 Reorder children of item #${args.parentId}`;
        }
    },
    {
        name: 'create_timeline_entry',
        description: 'Create a new timeline entry (log a work session). Specify start/end times and optionally link to an item.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name/label for the timeline entry'
                },
                startTime: {
                    type: 'number',
                    description: 'Start time as Unix timestamp (milliseconds)'
                },
                endTime: {
                    type: 'number',
                    description: 'End time as Unix timestamp (milliseconds)'
                },
                duration: {
                    type: 'number',
                    description: 'Duration in minutes'
                },
                itemId: {
                    type: 'number',
                    description: 'ID of the linked item'
                }
            },
            required: ['name']
        },
        async execute(args) {
            const data = readStore('timeline.json');
            const entry = {
                ...args,
                id: data.nextId++,
                timestamp: args.startTime || Date.now()
            };
            data.entries.push(entry);
            writeStore('timeline.json', data);

            return { created: entry, message: `Logged "${args.name}"` };
        },
        describe(args) {
            return `📝 Log timeline: "${args.name}"${args.duration ? ` (${args.duration}min)` : ''}`;
        }
    },
    {
        name: 'stop_work',
        description: 'Stop the current work timer and log a timeline entry with the duration. Only works if the user is currently working on something (workingOn is not null).',
        parameters: {
            type: 'object',
            properties: {},
        },
        async execute() {
            const prefs = readStore('preferences.json');
            if (!prefs || !prefs.workingOn) return { error: 'Not currently working on anything' };

            const endTime = Date.now();
            const durationMs = endTime - prefs.workingOn.startTime;
            const hrs = Math.floor(durationMs / 3600000);
            const mins = Math.floor((durationMs % 3600000) / 60000);
            const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

            // Create timeline entry
            const timeline = readStore('timeline.json') || { entries: [], nextId: 1 };
            const entry = {
                id: timeline.nextId++,
                text: `Worked on: ${prefs.workingOn.itemName} (${durStr})`,
                projectName: prefs.workingOn.projectName,
                type: 'work',
                startTime: prefs.workingOn.startTime,
                endTime: endTime,
                targetEndTime: prefs.workingOn.targetEndTime || undefined,
                itemId: prefs.workingOn.itemId,
                timestamp: prefs.workingOn.startTime
            };
            timeline.entries.push(entry);
            writeStore('timeline.json', timeline);

            const stoppedName = prefs.workingOn.itemName;

            // Clear working state
            prefs.workingOn = null;
            writeStore('preferences.json', prefs);

            return { message: `Stopped working on "${stoppedName}" (${durStr})`, entry };
        },
        describe() {
            const prefs = readStore('preferences.json');
            const name = prefs?.workingOn?.itemName || 'current task';
            return `⏹️ Stop working on "${name}"`;
        }
    },
    {
        name: 'start_work',
        description: 'Start the work timer on a specific item. If already working on something else, you should stop_work first.',
        parameters: {
            type: 'object',
            properties: {
                itemId: {
                    type: 'number',
                    description: 'ID of the item to start working on'
                },
                durationMinutes: {
                    type: 'number',
                    description: 'Optional planned duration in minutes. Sets a target end time.'
                }
            },
            required: ['itemId']
        },
        async execute(args) {
            const prefs = readStore('preferences.json');
            const items = readStore('items.json');
            const item = findItemById(items?.items || [], args.itemId);
            if (!item) return { error: `Item ${args.itemId} not found` };

            const pathArr = getItemPath(items.items, args.itemId);
            const projectName = pathArr ? pathArr.slice(0, -1).join(' › ') : null;

            const now = Date.now();
            prefs.workingOn = {
                itemId: args.itemId,
                itemName: item.name,
                projectName,
                startTime: now,
                targetEndTime: args.durationMinutes ? now + (args.durationMinutes * 60000) : null
            };
            writeStore('preferences.json', prefs);

            return { message: `Started working on "${item.name}"${args.durationMinutes ? ` (${args.durationMinutes}min)` : ''}` };
        },
        describe(args) {
            const items = readStore('items.json');
            const item = findItemById(items?.items || [], args.itemId);
            const name = item?.name || `item #${args.itemId}`;
            return `▶️ Start working on "${name}"${args.durationMinutes ? ` (${args.durationMinutes}min)` : ''}`;
        }
    },
    {
        name: 'extend_work',
        description: 'Extend or modify the current work timer. Can add minutes to the existing target end time, or set a new duration from now. Only works if currently working on something.',
        parameters: {
            type: 'object',
            properties: {
                addMinutes: {
                    type: 'number',
                    description: 'Minutes to add to the current target end time (can be negative to shorten). If there is no target end time, sets one from now.'
                },
                setMinutesFromNow: {
                    type: 'number',
                    description: 'Set the target end time to this many minutes from now (overrides current target).'
                }
            }
        },
        async execute(args) {
            const prefs = readStore('preferences.json');
            if (!prefs || !prefs.workingOn) return { error: 'Not currently working on anything' };

            const now = Date.now();
            if (args.setMinutesFromNow) {
                prefs.workingOn.targetEndTime = now + (args.setMinutesFromNow * 60000);
            } else if (args.addMinutes) {
                const base = prefs.workingOn.targetEndTime || now;
                prefs.workingOn.targetEndTime = base + (args.addMinutes * 60000);
            } else {
                return { error: 'Specify addMinutes or setMinutesFromNow' };
            }

            writeStore('preferences.json', prefs);
            const remaining = Math.round((prefs.workingOn.targetEndTime - now) / 60000);
            return { message: `Timer for "${prefs.workingOn.itemName}" updated — ${remaining}min remaining` };
        },
        describe(args) {
            const prefs = readStore('preferences.json');
            const name = prefs?.workingOn?.itemName || 'current task';
            if (args.addMinutes) return `⏱️ Add ${args.addMinutes}min to "${name}" timer`;
            if (args.setMinutesFromNow) return `⏱️ Set "${name}" timer to ${args.setMinutesFromNow}min from now`;
            return `⏱️ Modify "${name}" timer`;
        }
    },
    {
        name: 'write_file',
        description: 'Write content to a file in the project (create or overwrite). Path is relative to project root. Creates parent directories if needed.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Relative path to the file from project root'
                },
                content: {
                    type: 'string',
                    description: 'Full content to write to the file'
                }
            },
            required: ['filePath', 'content']
        },
        async execute(args) {
            const resolved = resolveProjectPath(args.filePath);
            if (!resolved) return { error: 'Invalid path — must be relative to project root, no ".." allowed' };
            // Create parent directories if needed
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolved, args.content, 'utf8');
            const lines = args.content.split('\n').length;
            return { message: `Wrote ${lines} lines to ${args.filePath}`, filePath: args.filePath };
        },
        describe(args) {
            return `📝 Write file: ${args.filePath}`;
        }
    },
    {
        name: 'run_command',
        description: 'Run a shell command in the project root directory. Returns stdout, stderr, and exit code. Timeout: 30 seconds. Use this to run builds, tests, git commands, list files with grep, etc.',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The shell command to execute (e.g. "npm run build", "ls -la", "grep -r something .")'
                }
            },
            required: ['command']
        },
        async execute(args) {
            try {
                const stdout = execSync(args.command, {
                    cwd: PROJECT_ROOT,
                    timeout: 30000,
                    maxBuffer: 1024 * 1024,
                    encoding: 'utf8',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                const truncated = stdout.length > 10240 ? stdout.slice(0, 10240) + '\n... (truncated)' : stdout;
                return { stdout: truncated, stderr: '', exitCode: 0 };
            } catch (err) {
                const stdout = (err.stdout || '').slice(0, 10240);
                const stderr = (err.stderr || '').slice(0, 5120);
                return { stdout, stderr, exitCode: err.status || 1, error: err.message?.split('\n')[0] };
            }
        },
        describe(args) {
            return `🖥️ Run: \`${args.command}\``;
        }
    }
];

/**
 * Get all tool definitions. If writeMode is false, only return read tools.
 */
function getTools(writeMode = false) {
    return writeMode ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS];
}

/**
 * Get tool definitions formatted for the AI provider (just name, description, parameters).
 */
function getToolDefinitions(writeMode = false) {
    return getTools(writeMode).map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
    }));
}

/**
 * Execute a single tool call by name.
 */
async function executeTool(name, args) {
    const allTools = [...READ_TOOLS, ...WRITE_TOOLS];
    const tool = allTools.find(t => t.name === name);
    if (!tool) return { error: `Unknown tool: ${name}` };
    return tool.execute(args);
}

/**
 * Generate a human-readable description of a tool call.
 */
function describeToolCall(name, args) {
    const allTools = [...READ_TOOLS, ...WRITE_TOOLS];
    const tool = allTools.find(t => t.name === name);
    if (!tool) return `❓ Unknown: ${name}`;
    if (tool.describe) return tool.describe(args);
    return `🔧 ${name}(${JSON.stringify(args)})`;
}

/**
 * Enrich tool calls with human-readable descriptions and context.
 */
function enrichPlan(toolCalls) {
    const data = readStore('items.json');

    return toolCalls.map(tc => {
        const enriched = {
            tool: tc.name,
            args: tc.args,
            description: describeToolCall(tc.name, tc.args),
            isWrite: WRITE_TOOLS.some(t => t.name === tc.name)
        };

        // Add context for item references
        if (tc.args.parentId && data?.items) {
            const pathArr = getItemPath(data.items, tc.args.parentId);
            if (pathArr) enriched.parentPath = pathArr.join(' › ');
        }
        if (tc.args.id && data?.items) {
            const item = findItemById(data.items, tc.args.id);
            if (item) enriched.targetName = item.name;
        }

        return enriched;
    });
}

function isReadTool(name) {
    return READ_TOOLS.some(t => t.name === name);
}

module.exports = { getTools, getToolDefinitions, executeTool, describeToolCall, enrichPlan, isReadTool };
