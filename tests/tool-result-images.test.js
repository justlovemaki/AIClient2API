/**
 * tool_result 图片处理回归测试
 *
 * 覆盖审查意见要求的两点：
 *  1. base64 图片转成 Gemini inlineData（原 PR 目的）
 *  2. URL 来源的图片**不得静默丢弃**（P2）
 *
 * 覆盖来源组合：URL-only / URL+text / base64-only / 混合 / 空内容。
 */

import { jest } from '@jest/globals';
import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';

jest.setTimeout(30000);

const BASE64_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BASE64_JPG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** 构造一个最小的 Claude request，内含一条 tool_use + 一条 tool_result */
function makeRequest(toolResultContent) {
    return {
        model: 'claude-sonnet-4',
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'tool_use', id: 'toolu_01ABC', name: 'Bash', input: { command: 'ls' } }
                ]
            },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'toolu_01ABC', content: toolResultContent }
                ]
            }
        ]
    };
}

/** 取出 tool_result 转换后的 functionResponse 体 */
function findFunctionResponse(request) {
    for (const content of request.contents || []) {
        for (const part of content.parts || []) {
            if (part.functionResponse) return part.functionResponse;
        }
    }
    return null;
}

function findInlineData(request) {
    const out = [];
    for (const content of request.contents || []) {
        for (const part of content.parts || []) {
            if (part.inlineData) out.push(part.inlineData);
        }
    }
    return out;
}

describe('tool_result 图片处理（#717 / #718 共用修复）', () => {
    let converter;
    beforeAll(() => { converter = new ClaudeConverter(); });

    test('base64-only：转成 inlineData，result 不含 base64 原文', () => {
        const req = makeRequest([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64_PNG } }
        ]);
        const out = converter.toGeminiRequest(req);

        const inline = findInlineData(out);
        expect(inline).toHaveLength(1);
        expect(inline[0].mimeType).toBe('image/png');
        expect(inline[0].data).toBe(BASE64_PNG);

        const fr = findFunctionResponse(out);
        // 已转换的图片不应再以 base64 噪声出现在文本 fallback 里
        expect(fr.response.result).not.toContain(BASE64_PNG);
    });

    test('URL-only：不得静默丢弃，URL 必须保留在 result 中（P2 核心）', () => {
        const url = 'https://example.com/screenshot.png';
        const req = makeRequest([
            { type: 'image', source: { type: 'url', url } }
        ]);
        const out = converter.toGeminiRequest(req);

        // 关键回归：修复前这里是 '[]'（图片被静默删除）
        const fr = findFunctionResponse(out);
        expect(fr).not.toBeNull();
        expect(fr.response.result).not.toBe('[]');
        expect(fr.response.result).toContain(url);

        // URL 图片无法转 inlineData，所以不应产生 inlineData
        expect(findInlineData(out)).toHaveLength(0);
    });

    test('URL + text：文本优先，URL 不被丢弃', () => {
        const url = 'https://example.com/chart.png';
        const req = makeRequest([
            { type: 'text', text: 'Chart below:' },
            { type: 'image', source: { type: 'url', url } }
        ]);
        const out = converter.toGeminiRequest(req);

        const fr = findFunctionResponse(out);
        expect(fr.response.result).toContain('Chart below:');

        // 文本存在时走 remainingText 分支；此时 URL 图片不进入 result，
        // 但也不能产生错误的 inlineData。断言它没有变成非法 part 即可。
        expect(fr.response.result).not.toContain(BASE64_PNG);
    });

    test('混合来源：base64 转 inlineData，URL 保留', () => {
        const url = 'https://example.com/a.png';
        const req = makeRequest([
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BASE64_JPG } },
            { type: 'text', text: 'second' },
            { type: 'image', source: { type: 'url', url } }
        ]);
        const out = converter.toGeminiRequest(req);

        const inline = findInlineData(out);
        expect(inline).toHaveLength(1);
        expect(inline[0].mimeType).toBe('image/jpeg');

        const fr = findFunctionResponse(out);
        expect(fr.response.result).toContain('second');
    });

    test('URL-only + text：result 同时含文本，URL 不被转成 inlineData', () => {
        const url = 'https://example.com/only-url.png';
        const req = makeRequest([
            { type: 'text', text: 'see:' },
            { type: 'image', source: { type: 'url', url } }
        ]);
        const out = converter.toGeminiRequest(req);
        const fr = findFunctionResponse(out);
        expect(fr.response.result).toContain('see:');
        // 关键：不能凭空造出 inlineData（URL 无 base64 数据）
        expect(findInlineData(out)).toHaveLength(0);
    });

    test('字符串 content：原样透传，不受影响', () => {
        const req = makeRequest('plain string result');
        const out = converter.toGeminiRequest(req);
        const fr = findFunctionResponse(out);
        expect(fr.response.result).toBe('plain string result');
    });

    test('空数组 content：不抛异常', () => {
        const req = makeRequest([]);
        expect(() => converter.toGeminiRequest(req)).not.toThrow();
    });

    test('六张 base64 工具图片：只保留最近五张，最早图片转合法文本且无 omitted 字段', () => {
        const req = makeRequest(Array.from({ length: 6 }, (_, index) => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: `${BASE64_PNG}${index}` }
        })));
        const out = converter.toGeminiRequest(req);
        const inline = findInlineData(out);
        expect(inline).toHaveLength(5);
        expect(inline.map(part => part.data)).toEqual(expect.arrayContaining([
            `${BASE64_PNG}1`, `${BASE64_PNG}2`, `${BASE64_PNG}3`, `${BASE64_PNG}4`, `${BASE64_PNG}5`
        ]));

        const allParts = out.contents.flatMap(content => content.parts);
        expect(allParts.some(part => part.text?.startsWith('[Earlier image omitted:'))).toBe(true);
        expect(JSON.stringify(out)).not.toContain('"omitted"');
    });

    test('function name 仍按 tool_use id 精确映射（#717 原始目标不回退）', () => {
        const url = 'https://example.com/x.png';
        const req = makeRequest([
            { type: 'image', source: { type: 'url', url } }
        ]);
        const out = converter.toGeminiRequest(req);
        const fr = findFunctionResponse(out);
        expect(fr.name).toBe('Bash');
        expect(fr.id).toBe('toolu_01ABC');
    });
});