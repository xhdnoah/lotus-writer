const Anthropic = require('@anthropic-ai/sdk').default;

const SYSTEM = `你是科幻小说写作助手的“资料官”。作者正在写一段文字，你要找出其中值得查证的科学、技术、天文、物理、生物、哲学或历史概念，供作者去维基百科等可信来源阅读。
规则：
- 只挑真实存在、可查证的概念；忽略人物名、虚构名词和日常词汇。
- 把作者的口语化描述映射到规范的百科词条名，例如“宇宙的寿命”→“宇宙的终极命运”“热寂”“宇宙年龄”。
- zh 用中文维基百科最可能的条目标题（简体），en 用英文维基百科条目标题。
- 按与这段文字的相关度排序，最多 6 个。`;

const SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phrase: { type: 'string', description: '原文中触发该概念的字词' },
          zh: { type: 'string' },
          en: { type: 'string' },
          why: { type: 'string', description: '一句话说明与这段文字的关系' },
        },
        required: ['phrase', 'zh', 'en', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['concepts'],
  additionalProperties: false,
};

let cached = { key: null, client: null };

function clientFor(apiKey) {
  // Fall back to the SDK's own credential resolution (ANTHROPIC_API_KEY, `ant auth login`) when no key is set in-app.
  if (cached.client && cached.key === (apiKey || null)) return cached.client;
  cached = { key: apiKey || null, client: apiKey ? new Anthropic({ apiKey }) : new Anthropic() };
  return cached.client;
}

async function extractConcepts(text, apiKey) {
  try {
    const response = await clientFor(apiKey).beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
    });
    if (response.stop_reason === 'refusal') return { ok: false, error: '模型拒绝了这段文本' };
    const block = response.content.find((b) => b.type === 'text');
    if (!block) return { ok: false, error: '没有返回内容' };
    return { ok: true, concepts: JSON.parse(block.text).concepts };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return { ok: false, error: 'API Key 无效' };
    if (error instanceof Anthropic.RateLimitError) return { ok: false, error: '请求过于频繁，稍后再试' };
    if (error instanceof Anthropic.APIError) return { ok: false, error: `API 错误 ${error.status ?? ''}` };
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { extractConcepts };
