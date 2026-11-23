import { applySystemPromptReplacements } from '../converters/utils.js';
import { MODEL_PROTOCOL_PREFIX as PROTOCOL } from './constants.js';

const isSystemRole = role => role === 'system' || role === 'developer';
const isChatInstruction = message => isSystemRole(message?.role);
const isResponsesInstruction = item => item && (
    ((!item.type || item.type === 'message') && isSystemRole(item.role)) ||
    ((!item.role || isSystemRole(item.role)) && isSystemRole(item.type))
);

/** Remove client system instructions without touching conversation or tool items. */
export function clearRequestSystemPrompts(body, protocol) {
    switch (protocol) {
        case PROTOCOL.OPENAI:
        case PROTOCOL.GROK:
            if (Array.isArray(body.messages)) body.messages = body.messages.filter(message => !isChatInstruction(message));
            break;
        case PROTOCOL.OPENAI_RESPONSES:
        case PROTOCOL.CODEX:
            delete body.instructions;
            if (Array.isArray(body.input)) body.input = body.input.filter(item => !isResponsesInstruction(item));
            break;
        case PROTOCOL.CLAUDE:
            delete body.system;
            break;
        case PROTOCOL.GEMINI:
            delete body.systemInstruction;
            delete body.system_instruction;
            break;
    }
}

/** Replace only system/developer text, preserving request structure and other content. */
export function replaceRequestSystemPrompts(body, protocol, rules) {
    if (!Array.isArray(rules) || rules.length === 0) return;

    const replace = value => typeof value === 'string' ? applySystemPromptReplacements(value, rules) : value;
    const replaceParts = (parts, textTypes) => {
        if (!Array.isArray(parts)) return;
        for (const part of parts) {
            if (part && typeof part.text === 'string' && textTypes.includes(part.type)) {
                part.text = replace(part.text);
            }
        }
    };
    const replaceMessages = (messages, textTypes, isInstruction) => {
        if (!Array.isArray(messages)) return;
        for (const message of messages) {
            if (!isInstruction(message)) continue;
            if (typeof message.content === 'string') {
                message.content = replace(message.content);
            } else {
                replaceParts(message.content, textTypes);
            }
        }
    };

    switch (protocol) {
        case PROTOCOL.OPENAI:
            replaceMessages(body.messages, ['text'], isChatInstruction);
            break;
        case PROTOCOL.OPENAI_RESPONSES:
        case PROTOCOL.CODEX:
            if (typeof body.instructions === 'string') body.instructions = replace(body.instructions);
            replaceMessages(body.input, ['input_text', 'text'], isResponsesInstruction);
            break;
        case PROTOCOL.CLAUDE:
            if (typeof body.system === 'string') body.system = replace(body.system);
            else replaceParts(body.system, ['text']);
            break;
        case PROTOCOL.GEMINI:
            for (const key of ['systemInstruction', 'system_instruction']) {
                const instruction = body[key];
                if (typeof instruction === 'string') {
                    body[key] = replace(instruction);
                } else if (Array.isArray(instruction?.parts)) {
                    for (const [index, part] of instruction.parts.entries()) {
                        if (typeof part === 'string') instruction.parts[index] = replace(part);
                        else if (typeof part?.text === 'string') part.text = replace(part.text);
                    }
                } else if (typeof instruction?.text === 'string') {
                    instruction.text = replace(instruction.text);
                }
            }
            break;
    }
}
