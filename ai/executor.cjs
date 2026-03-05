/**
 * ai/executor.cjs — AI interaction orchestrator
 * 
 * Orchestrates the full flow: context → tools → provider → response/plan.
 * Implements an agentic loop: read tools are auto-executed and their results
 * fed back to the AI. Only write tools are surfaced as plans for user approval.
 * 
 * All data access goes through the server's store instances (DB or JSON).
 */

const { getProvider } = require('./provider.cjs');
const { buildContext, buildSystemPrompt, buildTriggerContext, buildTriggerSystemPrompt } = require('./context.cjs');
const { getToolDefinitions, executeTool, enrichPlan, isReadTool } = require('./tools.cjs');

const MAX_TOOL_ROUNDS = 50;

/**
 * Extract quick-reply actions from AI response text.
 * The AI can include a ```actions-json [...] ``` code block with an array of label strings.
 * Returns { cleanText, actions } where cleanText has the block removed.
 */
function extractActions(text) {
    if (!text) return { cleanText: text, actions: null };
    // Robust regex: case-insensitive, allows spaces between backticks and tag,
    // handles varied whitespace/newlines around the JSON content
    const regex = /```\s*actions-json\s*\n?([\s\S]*?)\n?\s*```/i;
    const match = text.match(regex);
    if (!match) {
        // Debug: check if AI included actions in a different format
        if (text.includes('actions-json') || text.includes('Actions-json')) {
            console.log('[extractActions] Found "actions-json" text but regex did not match. Raw tail:', text.slice(-200));
        }
        return { cleanText: text, actions: null };
    }
    try {
        const raw = match[1].trim();
        const actions = JSON.parse(raw);
        if (!Array.isArray(actions) || actions.length === 0) return { cleanText: text, actions: null };
        // Ensure all items are strings
        const labels = actions.filter(a => typeof a === 'string').slice(0, 4);
        if (labels.length === 0) return { cleanText: text, actions: null };
        const cleanText = text.replace(regex, '').trim();
        return { cleanText, actions: labels };
    } catch (e) {
        console.log('[extractActions] JSON parse failed:', e.message, 'Raw:', match[1].trim().slice(0, 100));
        return { cleanText: text, actions: null };
    }
}

function getAiConfig(settings) {
    settings = settings || {};
    return {
        provider: settings.aiProvider || undefined,
        model: settings.aiModel || undefined,
        apiKey: settings.aiApiKey || undefined
    };
}

/**
 * Run a chat interaction with agentic read-tool loop.
 * 
 * Flow:
 * 1. Send message + tools to AI
 * 2. If AI returns ONLY read tool calls → auto-execute, feed results back, repeat
 * 3. If AI returns write tool calls → return them as a plan for approval
 * 4. If AI returns text only → return it
 * 
 * @param {string} message - User's message
 * @param {Array} history - Previous messages [{role, content}]
 * @param {Function} onEvent - SSE event emitter
 * @param {object} settings - App settings (for AI config)
 * @param {object} stores - { items, timeline, settings, preferences } store instances
 * @returns {{ text: string, plan?: Array }}
 */
async function chat(message, history = [], onEvent = null, settings = null, stores = null) {
    const emit = onEvent || (() => { });
    const config = getAiConfig(settings);
    const provider = getProvider(config);
    const context = await buildContext(stores);
    const systemPrompt = buildSystemPrompt(context);
    const tools = getToolDefinitions(true);

    // Build conversation for multi-turn
    const conversation = [
        ...history,
        { role: 'user', content: message }
    ];


    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {

        const result = await provider.chat({
            systemPrompt,
            messages: conversation,
            tools: tools.length > 0 ? tools : undefined,
            temperature: 0.7
        });

        // No tool calls → done — this round's text IS the final answer
        if (!result.toolCalls || result.toolCalls.length === 0) {
            const { cleanText, actions } = extractActions(result.text || 'I wasn\'t able to find a clear answer. Could you try rephrasing?');
            return { text: cleanText, actions };
        }

        // Separate read vs write tool calls
        const readCalls = result.toolCalls.filter(tc => isReadTool(tc.name));
        const writeCalls = result.toolCalls.filter(tc => !isReadTool(tc.name));

        // If there are write tool calls → return them as a plan (don't auto-execute)
        if (writeCalls.length > 0) {
            const { cleanText, actions } = extractActions(result.text || '');
            return {
                text: cleanText,
                plan: await enrichPlan(writeCalls, stores),
                actions
            };
        }

        // Only read calls — stream narration text live but don't persist it
        if (result.text) {
            emit({ type: 'status', text: result.text, tools: readCalls.map(tc => tc.name) });
        }

        // Only read calls → auto-execute and feed results back
        // Add the AI's response (with tool calls) to the conversation
        conversation.push({
            role: 'assistant',
            content: result.text || '',
            toolCalls: result.toolCalls
        });

        // Execute read tools in parallel
        for (const tc of readCalls) {
            emit({ type: 'tool_start', tool: tc.name, args: tc.args });
        }
        const toolResults = await Promise.all(readCalls.map(async (tc) => {
            try {
                const toolResult = await executeTool(tc.name, tc.args, stores);
                const result = JSON.stringify(toolResult);
                const preview = result.length > 200 ? result.slice(0, 200) + '…' : result;
                emit({ type: 'tool_done', tool: tc.name, result: preview });
                return { toolUseId: tc.id, name: tc.name, result };
            } catch (err) {
                const result = JSON.stringify({ error: err.message });
                emit({ type: 'tool_done', tool: tc.name, result });
                return { toolUseId: tc.id, name: tc.name, result };
            }
        }));

        // Add tool results to conversation
        conversation.push({
            role: 'tool',
            toolResults
        });
    }

    // Max rounds reached — don't dump narration, just explain
    return { text: 'I ran out of analysis rounds. Please try a more specific question so I can be more focused.', actions: null };
}

/**
 * Execute a previously approved plan, then continue with AI for remaining steps.
 * 
 * After executing write tools, feeds results back to the AI.
 * If the AI returns more write tools → auto-execute them (already approved intent).
 * Continues until the AI returns text-only or max rounds reached.
 * 
 * @param {Array} toolCalls - [{tool, args}] from the approved plan
 * @param {Array} history - Chat history for continuation context
 * @param {Function} onEvent - SSE event emitter
 * @param {object} settings - App settings (for AI config)
 * @param {object} stores - { items, timeline, settings, preferences } store instances
 * @returns {{ results: Array, continuationResults: Array, summary: string }}
 */
async function executeAndContinue(toolCalls, history = [], onEvent = null, settings = null, stores = null) {
    const emit = onEvent || (() => { });
    const allResults = [];

    // Execute the initial approved plan
    for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        emit({ type: 'exec_step', step: i + 1, total: toolCalls.length, tool: tc.tool, args: tc.args, description: tc.description });
        try {
            const result = await executeTool(tc.tool, tc.args, stores);
            allResults.push({
                tool: tc.tool,
                success: !result.error,
                result
            });
        } catch (err) {
            allResults.push({
                tool: tc.tool,
                success: false,
                result: { error: err.message }
            });
        }
    }

    // Now feed execution results back to AI for continuation
    const config = getAiConfig(settings);
    const provider = getProvider(config);
    const context = await buildContext(stores);
    const systemPrompt = buildSystemPrompt(context);
    const tools = getToolDefinitions(true);

    // Build continuation conversation
    const conversation = [...history];

    // Add a summary of what was just executed as tool results
    const executionSummary = allResults.map(r =>
        `${r.success ? '✅' : '❌'} ${r.tool}: ${r.result.message || r.result.error || JSON.stringify(r.result)}`
    ).join('\n');

    conversation.push({
        role: 'user',
        content: `[System: The following actions were just executed]\n${executionSummary}\n\nContinue with the remaining steps if any. If all done, summarize what was accomplished.`
    });

    let summaryText = '';

    // Agentic continuation loop
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {

        const result = await provider.chat({
            systemPrompt,
            messages: conversation,
            tools: tools.length > 0 ? tools : undefined,
            temperature: 0.7
        });

        // No tool calls → done — this round's text is the actual summary
        if (!result.toolCalls || result.toolCalls.length === 0) {
            if (result.text) {
                summaryText = result.text; // Use final answer, not accumulated narration
            }
            break;
        }

        // Has tool calls — check if only read tools (narration to discard)
        const readCalls = result.toolCalls.filter(tc => isReadTool(tc.name));
        const writeCalls = result.toolCalls.filter(tc => !isReadTool(tc.name));

        // Stream narration text live so user sees what the AI is doing
        if (result.text) {
            const toolInfo = [...readCalls, ...writeCalls].map(tc => ({ name: tc.name, args: tc.args }));
            emit({ type: 'status', text: result.text, tools: toolInfo });
        }

        // Only accumulate text from rounds with write tool calls (intent text),
        // NOT from read-only rounds ("Let me look at..." narration)
        if (writeCalls.length > 0 && result.text) {
            summaryText += (summaryText ? '\n' : '') + result.text;
        }

        if (readCalls.length > 0) {
            conversation.push({
                role: 'assistant',
                content: result.text || '',
                toolCalls: readCalls
            });
            const toolResults = [];
            for (const tc of readCalls) {
                emit({ type: 'tool_start', tool: tc.name, args: tc.args });
                try {
                    const toolResult = await executeTool(tc.name, tc.args, stores);
                    toolResults.push({ toolUseId: tc.id, name: tc.name, result: JSON.stringify(toolResult) });
                } catch (err) {
                    toolResults.push({ toolUseId: tc.id, name: tc.name, result: JSON.stringify({ error: err.message }) });
                }
                const resultStr = toolResults[toolResults.length - 1].result;
                const preview = resultStr.length > 200 ? resultStr.slice(0, 200) + '…' : resultStr;
                emit({ type: 'tool_done', tool: tc.name, result: preview });
            }
            conversation.push({ role: 'tool', toolResults });
        }

        // Auto-execute write calls (already approved intent)
        if (writeCalls.length > 0) {
            for (const tc of writeCalls) {
                emit({ type: 'tool_start', tool: tc.name, args: tc.args });
                let execResult;
                try {
                    execResult = await executeTool(tc.name, tc.args, stores);
                    allResults.push({ tool: tc.name, success: !execResult.error, result: execResult });
                } catch (err) {
                    execResult = { error: err.message };
                    allResults.push({ tool: tc.name, success: false, result: execResult });
                }
                const resultStr = JSON.stringify(execResult);
                const preview = resultStr.length > 200 ? resultStr.slice(0, 200) + '…' : resultStr;
                emit({ type: 'tool_done', tool: tc.name, result: preview });
            }

            // Feed these results back for the next round
            const contSummary = writeCalls.map((tc, i) => {
                const r = allResults[allResults.length - writeCalls.length + i];
                return `${r.success ? '✅' : '❌'} ${r.tool}: ${r.result.message || r.result.error || 'done'}`;
            }).join('\n');

            conversation.push({
                role: 'user',
                content: `[System: Additional actions executed]\n${contSummary}\n\nContinue if more steps remain, or summarize.`
            });
        }
    }

    return { results: allResults, summary: summaryText };
}

/**
 * Lightweight AI chat for trigger-initiated background invocations.
 * No SSE streaming, no plan approval — just returns text.
 * Uses read-tool loop but caps at 10 rounds for speed.
 * 
 * @param {string} prompt - The trigger prompt
 * @param {object} stores - { items, timeline, settings, preferences }
 * @param {object} [settings] - App settings for AI config
 * @returns {Promise<string>} - AI response text
 */
async function triggerChat(prompt, stores, settings = null) {
    const config = getAiConfig(settings);
    const provider = getProvider(config);
    // Lightweight context — only preferences/settings, no items tree or timeline
    const context = await buildTriggerContext(stores);
    const systemPrompt = buildTriggerSystemPrompt(context);
    const tools = getToolDefinitions(true); // read-only tools

    const conversation = [
        { role: 'user', content: prompt }
    ];

    const MAX_TRIGGER_ROUNDS = 10; // lighter cap for background invocations

    for (let round = 0; round < MAX_TRIGGER_ROUNDS; round++) {
        const result = await provider.chat({
            systemPrompt,
            messages: conversation,
            tools: tools.length > 0 ? tools : undefined,
            temperature: 0.7
        });

        // No tool calls → done
        if (!result.toolCalls || result.toolCalls.length === 0) {
            const { cleanText, actions } = extractActions(result.text || '');
            return { text: cleanText, actions };
        }

        // Only auto-execute read tools; ignore any write tools in trigger mode
        const readCalls = result.toolCalls.filter(tc => isReadTool(tc.name));
        if (readCalls.length === 0) {
            // AI wants to write but triggers can't approve plans — return text
            const { cleanText, actions } = extractActions(result.text || '');
            return { text: cleanText, actions };
        }

        conversation.push({
            role: 'assistant',
            content: result.text || '',
            toolCalls: readCalls
        });

        // Execute read tools in parallel
        const toolResults = await Promise.all(readCalls.map(async (tc) => {
            try {
                const toolResult = await executeTool(tc.name, tc.args, stores);
                return { toolUseId: tc.id, name: tc.name, result: JSON.stringify(toolResult) };
            } catch (err) {
                return { toolUseId: tc.id, name: tc.name, result: JSON.stringify({ error: err.message }) };
            }
        }));

        conversation.push({ role: 'tool', toolResults });
    }

    return { text: 'I ran out of analysis rounds for this check-in.', actions: null };
}

module.exports = { chat, executeAndContinue, triggerChat };

