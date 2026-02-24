/**
 * ai/executor.cjs — AI interaction orchestrator
 * 
 * Orchestrates the full flow: context → tools → provider → response/plan.
 * Implements an agentic loop: read tools are auto-executed and their results
 * fed back to the AI. Only write tools are surfaced as plans for user approval.
 */

const { getProvider } = require('./provider.cjs');
const { buildContext, buildSystemPrompt } = require('./context.cjs');
const { getToolDefinitions, executeTool, enrichPlan, isReadTool } = require('./tools.cjs');
const fs = require('fs');
const path = require('path');

const MAX_TOOL_ROUNDS = 5; // prevent infinite loops

function getAiConfig() {
    const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
    let settings = {};
    try {
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
    } catch { }
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
 * @returns {{ text: string, plan?: Array }}
 */
async function chat(message, history = []) {
    const config = getAiConfig();
    const provider = getProvider(config);
    const context = buildContext();
    const systemPrompt = buildSystemPrompt(context);
    const tools = getToolDefinitions(true);

    // Build conversation for multi-turn
    const conversation = [
        ...history,
        { role: 'user', content: message }
    ];

    let collectedText = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const result = await provider.chat({
            systemPrompt,
            messages: conversation,
            tools: tools.length > 0 ? tools : undefined,
            temperature: 0.7
        });

        // Collect any text
        if (result.text) {
            collectedText += (collectedText ? '\n' : '') + result.text;
        }

        // No tool calls → done
        if (!result.toolCalls || result.toolCalls.length === 0) {
            return { text: collectedText };
        }

        // Separate read vs write tool calls
        const readCalls = result.toolCalls.filter(tc => isReadTool(tc.name));
        const writeCalls = result.toolCalls.filter(tc => !isReadTool(tc.name));

        // If there are write tool calls → return them as a plan (don't auto-execute)
        if (writeCalls.length > 0) {
            return {
                text: collectedText,
                plan: enrichPlan(writeCalls)
            };
        }

        // Only read calls → auto-execute and feed results back
        // Add the AI's response (with tool calls) to the conversation
        conversation.push({
            role: 'assistant',
            content: result.text || '',
            toolCalls: result.toolCalls
        });

        // Execute each read tool and add results to conversation
        const toolResults = [];
        for (const tc of readCalls) {
            try {
                const toolResult = await executeTool(tc.name, tc.args);
                toolResults.push({
                    toolUseId: tc.id,
                    name: tc.name,
                    result: JSON.stringify(toolResult)
                });
            } catch (err) {
                toolResults.push({
                    toolUseId: tc.id,
                    name: tc.name,
                    result: JSON.stringify({ error: err.message })
                });
            }
        }

        // Add tool results to conversation
        conversation.push({
            role: 'tool',
            toolResults
        });
    }

    // Max rounds reached
    return { text: collectedText || 'I needed too many data lookups to answer. Please try a more specific question.' };
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
 * @returns {{ results: Array, continuationResults: Array, summary: string }}
 */
async function executeAndContinue(toolCalls, history = []) {
    const allResults = [];

    // Execute the initial approved plan
    for (const tc of toolCalls) {
        try {
            const result = await executeTool(tc.tool, tc.args);
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
    const config = getAiConfig();
    const provider = getProvider(config);
    const context = buildContext();
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

        if (result.text) {
            summaryText += (summaryText ? '\n' : '') + result.text;
        }

        // No tool calls → done
        if (!result.toolCalls || result.toolCalls.length === 0) {
            break;
        }

        // Separate read vs write
        const readCalls = result.toolCalls.filter(tc => isReadTool(tc.name));
        const writeCalls = result.toolCalls.filter(tc => !isReadTool(tc.name));

        // Handle read calls first (auto-execute silently)
        if (readCalls.length > 0) {
            conversation.push({
                role: 'assistant',
                content: result.text || '',
                toolCalls: result.toolCalls
            });
            const toolResults = [];
            for (const tc of readCalls) {
                try {
                    const toolResult = await executeTool(tc.name, tc.args);
                    toolResults.push({ toolUseId: tc.id, name: tc.name, result: JSON.stringify(toolResult) });
                } catch (err) {
                    toolResults.push({ toolUseId: tc.id, name: tc.name, result: JSON.stringify({ error: err.message }) });
                }
            }
            conversation.push({ role: 'tool', toolResults });
        }

        // Auto-execute write calls (already approved intent)
        if (writeCalls.length > 0) {
            for (const tc of writeCalls) {
                try {
                    const result = await executeTool(tc.name, tc.args);
                    allResults.push({ tool: tc.name, success: !result.error, result });
                } catch (err) {
                    allResults.push({ tool: tc.name, success: false, result: { error: err.message } });
                }
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

module.exports = { chat, executeAndContinue };

