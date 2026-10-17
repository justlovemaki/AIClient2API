/**
 * Grok Web Payload Builders
 * Handles message format conversion and payload construction
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Convert OpenAI-style messages to Grok Web format
 */
export function convertMessagesToGrokFormat(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return [{ role: 'user', content: '' }];
    }

    return messages.map(msg => {
        if (typeof msg.content === 'string') {
            return {
                role: msg.role || 'user',
                content: msg.content
            };
        }

        if (Array.isArray(msg.content)) {
            const content = [];
            for (const item of msg.content) {
                if (item.type === 'text') {
                    content.push(item.text || '');
                } else if (item.type === 'image_url') {
                    content.push({
                        type: 'image',
                        image_url: item.image_url?.url || ''
                    });
                }
            }
            return {
                role: msg.role || 'user',
                content: content.length > 0 ? content : (msg.content || '')
            };
        }

        return {
            role: msg.role || 'user',
            content: msg.content || ''
        };
    });
}

/**
 * Build start conversation payload for Grok Web WebSocket
 * Based on grok2api implementation
 */
export function buildStartConversationPayload(conversationId, clientEventId, messages) {
    const firstMessage = messages[0];
    if (!firstMessage) {
        return {};
    }

    const content = [];

    const messageContent = {
        "type": "input_text",
        "text": firstMessage.content || "",
        "properties": {
            "modelSlug": "grok-4.3",
            "isInitial": true,
            "isKidsMode": false,
            "skipUpsampler": false,
            "enableSideBySide": true
        }
    };

    if (firstMessage.tool_calls && firstMessage.tool_calls.length > 0) {
        messageContent.properties.enableTools = true;
    }

    content.push(messageContent);

    return {
        "session_id": conversationId,
        "event": {
            "type": "conversation.item.create",
            "client_event_id": clientEventId,
            "conversation": {
                "id": conversationId
            },
            "item": {
                "type": "message",
                "role": "user",
                "content": content
            }
        }
    };
}

/**
 * Build response chunk in the expected format
 */
export function buildResponseChunk(collected, isDone) {
    const response = {
        message: collected.message,
        done: isDone
    };

    if (collected.tool_calls && collected.tool_calls.length > 0) {
        response.tool_calls = collected.tool_calls;
    }

    if (collected.usage) {
        response.usage = collected.usage;
    }

    return response;
}

/**
 * Parse incoming WebSocket message
 */
export function parseMessage(data) {
    if (!data) return null;

    try {
        if (typeof data === 'string') {
            return JSON.parse(data);
        }
        if (Buffer.isBuffer(data)) {
            return JSON.parse(data.toString('utf8'));
        }
        return data;
    } catch (e) {
        return null;
    }
}
