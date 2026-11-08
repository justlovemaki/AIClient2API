// Sanitized structural replay of app-2026-11-08.log (2026-11-08 07:02).
// Prompts, account identifiers, encrypted reasoning and moderation metadata omitted.
export function incompleteImageEvents() {
    const reasoning = { id: 'rs_before_image', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Planning image generation' }] };
    const stalled = [
        { id: 'ig_first', type: 'image_generation_call', status: 'generating' },
        { id: 'ig_second', type: 'image_generation_call', status: 'generating' }
    ];
    const apology = {
        id: 'msg_failure', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '抱歉，图片生成工具暂时出现异常，未能完成生成。请稍后重试。' }]
    };
    const response = {
        id: 'resp_original', model: 'gpt-5.6-sol', status: 'completed', error: null,
        reasoning: { effort: 'medium', summary: 'detailed' },
        output: [reasoning, stalled[0], { id: 'rs_after_image', type: 'reasoning', summary: [] }, stalled[1], apology],
        tool_usage: { image_gen: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, web_search: { num_requests: 0 } },
        usage: { input_tokens: 5049, output_tokens: 343, total_tokens: 5392,
            input_tokens_details: { cached_tokens: 4352 }, output_tokens_details: { reasoning_tokens: 32 } }
    };
    return [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } },
        { type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, output_index: 0, delta: 'Planning image generation' },
        { type: 'response.reasoning_summary_text.done', item_id: reasoning.id, output_index: 0, text: 'Planning image generation' },
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
        { type: 'response.output_item.added', output_index: 1, item: { ...stalled[0], status: 'in_progress' } },
        { type: 'response.image_generation_call.in_progress', output_index: 1, item_id: stalled[0].id },
        { type: 'response.image_generation_call.generating', output_index: 1, item_id: stalled[0].id },
        { type: 'response.output_item.done', output_index: 1, item: stalled[0] },
        { type: 'response.output_item.added', output_index: 2, item: { id: 'rs_after_image', type: 'reasoning', summary: [] } },
        { type: 'response.output_item.done', output_index: 2, item: { id: 'rs_after_image', type: 'reasoning', summary: [] } },
        { type: 'response.output_item.added', output_index: 3, item: { ...stalled[1], status: 'in_progress' } },
        { type: 'response.image_generation_call.generating', output_index: 3, item_id: stalled[1].id },
        { type: 'response.output_item.done', output_index: 3, item: stalled[1] },
        { type: 'response.output_item.added', output_index: 4, item: { ...apology, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', output_index: 4, item_id: apology.id, delta: apology.content[0].text },
        { type: 'response.output_item.done', output_index: 4, item: apology },
        { type: 'response.completed', response }
    ].map((event, sequence_number) => ({ ...event, sequence_number }));
}
