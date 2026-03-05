/**
 * ai/provider.cjs — Generic AI provider adapter
 * 
 * Single interface, multiple backends (Gemini, Claude, OpenAI-compatible).
 * Provider selection via process.env.AI_PROVIDER.
 */

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');

// ============ Gemini Schema Sanitization ============

/**
 * Recursively sanitize a JSON Schema to be compatible with Gemini's API.
 * Gemini rejects:
 *   - Union types like type: ['number', 'null'] → pick first non-null, add nullable
 *   - 'required' arrays inside nested object schemas (only top-level is ok)
 *   - Nested object items with their own 'required' field
 */
function sanitizeSchemaForGemini(schema, isTopLevel = true) {
    if (!schema || typeof schema !== 'object') return schema;

    const result = { ...schema };

    // Handle union types: type: ['number', 'null'] → just use the non-null type
    // Gemini's protobuf doesn't support union types or nullable on some model versions
    if (Array.isArray(result.type)) {
        const types = result.type.filter(t => t !== 'null');
        result.type = types[0] || 'string';
        // Don't set nullable — not reliably supported across Gemini models
    }

    // Recursively sanitize properties
    if (result.properties) {
        const cleanProps = {};
        for (const [key, val] of Object.entries(result.properties)) {
            cleanProps[key] = sanitizeSchemaForGemini(val, false);
        }
        result.properties = cleanProps;
    }

    // Recursively sanitize array items
    if (result.items) {
        result.items = sanitizeSchemaForGemini(result.items, false);
    }

    // Remove 'required' from nested schemas (Gemini only supports top-level required)
    if (!isTopLevel && result.required) {
        delete result.required;
    }

    return result;
}

// ============ Gemini Adapter ============

function createGeminiAdapter(apiKey, model) {
    const genAI = new GoogleGenerativeAI(apiKey);

    return {
        name: 'gemini',
        model,

        async chat({ systemPrompt, messages, tools, temperature = 0.7 }) {
            // Convert tools to Gemini function declarations with sanitized schemas
            const functionDeclarations = tools ? tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters ? sanitizeSchemaForGemini(t.parameters, true) : undefined
            })) : undefined;

            const generativeModel = genAI.getGenerativeModel({
                model,
                systemInstruction: systemPrompt,
                ...(functionDeclarations && functionDeclarations.length > 0 ? {
                    tools: [{ functionDeclarations }]
                } : {}),
            });

            // Convert messages to Gemini content format
            const contents = messages.map(m => {
                if (m.role === 'tool' && m.toolResults) {
                    // Tool results → functionResponse parts
                    return {
                        role: 'user',
                        parts: m.toolResults.map(tr => ({
                            functionResponse: {
                                name: tr.name,
                                response: JSON.parse(tr.result)
                            }
                        }))
                    };
                }
                if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                    // Assistant response with tool calls → model role with functionCall parts
                    const parts = [];
                    if (m.content) parts.push({ text: m.content });
                    for (const tc of m.toolCalls) {
                        parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
                    }
                    return { role: 'model', parts };
                }
                return {
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content || '' }]
                };
            });

            const result = await generativeModel.generateContent({
                contents,
                generationConfig: { temperature }
            });

            const response = result.response;
            const candidate = response.candidates?.[0];

            if (!candidate) {
                return { text: 'No response generated.', toolCalls: [] };
            }

            // Extract text and tool calls from parts
            let text = '';
            const toolCalls = [];

            for (const part of candidate.content.parts) {
                if (part.text) {
                    text += part.text;
                }
                if (part.functionCall) {
                    toolCalls.push({
                        name: part.functionCall.name,
                        args: part.functionCall.args || {}
                    });
                }
            }

            return { text, toolCalls };
        }
    };
}

// ============ Claude Adapter ============

function createClaudeAdapter(apiKey, model) {
    const client = new Anthropic.default({ apiKey });

    return {
        name: 'claude',
        model,

        async chat({ systemPrompt, messages, tools, temperature = 0.7 }) {
            // Convert tools to Claude format
            const claudeTools = tools ? tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters || { type: 'object', properties: {} }
            })) : undefined;

            // Convert messages to Claude format (handle tool calls and results)
            const rawMessages = messages.map(m => {
                if (m.role === 'tool' && m.toolResults) {
                    // Tool results → user message with tool_result blocks
                    return {
                        role: 'user',
                        content: m.toolResults.map(tr => ({
                            type: 'tool_result',
                            tool_use_id: tr.toolUseId || tr.name,
                            content: tr.result
                        }))
                    };
                }
                if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                    // Assistant with tool calls → tool_use content blocks
                    const content = [];
                    if (m.content) content.push({ type: 'text', text: m.content });
                    for (const tc of m.toolCalls) {
                        content.push({
                            type: 'tool_use',
                            id: tc.id || tc.name,
                            name: tc.name,
                            input: tc.args || {}
                        });
                    }
                    return { role: 'assistant', content };
                }
                return {
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: m.content || ''
                };
            });

            // Sanitize: strip orphaned tool_use blocks (no matching tool_result after)
            const claudeMessages = [];
            for (let i = 0; i < rawMessages.length; i++) {
                const msg = rawMessages[i];
                if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                    const hasToolUse = msg.content.some(b => b.type === 'tool_use');
                    if (hasToolUse) {
                        const next = rawMessages[i + 1];
                        const hasToolResult = next && next.role === 'user' &&
                            Array.isArray(next.content) &&
                            next.content.some(b => b.type === 'tool_result');
                        if (!hasToolResult) {
                            // Strip tool_use blocks — keep only text
                            const textParts = msg.content.filter(b => b.type === 'text');
                            const text = textParts.map(b => b.text).join('') || '';
                            claudeMessages.push({ role: 'assistant', content: text || 'OK' });
                            continue;
                        }
                    }
                }
                // Ensure non-empty content
                if (!msg.content && msg.content !== '') {
                    msg.content = msg.role === 'assistant' ? 'OK' : '...';
                }
                claudeMessages.push(msg);
            }

            // Merge consecutive same-role messages (Claude requires strict alternation)
            const mergedMessages = [];
            for (const msg of claudeMessages) {
                const prev = mergedMessages[mergedMessages.length - 1];
                if (prev && prev.role === msg.role && typeof prev.content === 'string' && typeof msg.content === 'string') {
                    prev.content += '\n' + msg.content;
                } else {
                    mergedMessages.push(msg);
                }
            }

            const params = {
                model,
                max_tokens: 4096,
                system: systemPrompt,
                messages: mergedMessages,
                temperature,
            };

            if (claudeTools && claudeTools.length > 0) {
                params.tools = claudeTools;
            }

            const response = await client.messages.create(params);

            // Extract text and tool calls
            let text = '';
            const toolCalls = [];

            for (const block of response.content) {
                if (block.type === 'text') {
                    text += block.text;
                }
                if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        name: block.name,
                        args: block.input || {}
                    });
                }
            }

            return { text, toolCalls };
        }
    };
}

// ============ Custom / OpenAI-compatible Adapter ============

function createCustomAdapter(apiKey, model, baseUrl = 'http://localhost:11434/v1') {
    return {
        name: 'custom',
        model,

        async chat({ systemPrompt, messages, tools, temperature = 0.7 }) {
            const body = {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...messages
                ],
                temperature,
            };

            if (tools && tools.length > 0) {
                body.tools = tools.map(t => ({
                    type: 'function',
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters || {}
                    }
                }));
            }

            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            const response = await fetch(baseUrl + '/chat/completions', {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Custom provider error: ${response.status} ${err}`);
            }

            const data = await response.json();
            const choice = data.choices?.[0];

            if (!choice) {
                return { text: 'No response generated.', toolCalls: [] };
            }

            const text = choice.message?.content || '';
            const toolCalls = (choice.message?.tool_calls || []).map(tc => ({
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments || '{}')
            }));

            return { text, toolCalls };
        }
    };
}

// ============ Factory ============

let _adapter = null;
let _adapterConfig = null; // track config to detect changes

function getProvider(overrideConfig) {
    const provider = overrideConfig?.provider || process.env.AI_PROVIDER || 'gemini';
    const apiKey = overrideConfig?.apiKey || process.env.AI_API_KEY;
    const model = overrideConfig?.model || process.env.AI_MODEL || 'gemini-2.0-flash';
    const customUrl = process.env.AI_CUSTOM_URL;

    // Check if config changed → reset adapter
    const configKey = `${provider}:${model}:${apiKey?.slice(0, 8)}`;
    if (_adapter && _adapterConfig === configKey) return _adapter;

    if (!apiKey && provider !== 'custom') {
        throw new Error(`AI API key not configured. Set it in Settings (⚙️) or in .env`);
    }

    switch (provider) {
        case 'gemini':
            _adapter = createGeminiAdapter(apiKey, model);
            break;
        case 'claude':
            _adapter = createClaudeAdapter(apiKey, model);
            break;
        case 'custom':
            _adapter = createCustomAdapter(apiKey, model, customUrl);
            break;
        default:
            throw new Error(`Unknown AI provider: ${provider}. Use gemini, claude, or custom.`);
    }

    _adapterConfig = configKey;
    console.log(`AI Provider initialized: ${provider} (${model})`);
    return _adapter;
}

// Allow re-initialization (e.g., if env changes)
function resetProvider() {
    _adapter = null;
}

module.exports = { getProvider, resetProvider };
