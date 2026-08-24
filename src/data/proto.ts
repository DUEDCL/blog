/**
 * 上游协议适配（R39）。他要「支持多种请求格式」，图里点了五个：
 * OpenAI Responses / OpenAI Compatible / Anthropic / Amazon Bedrock / Google (Gemini)。
 *
 * **实现了四个，Bedrock 明确不做** —— 它不是「换个 base URL 和字段名」的事：
 * 每个请求要按 AWS SigV4 用密钥派生签名（HMAC 链 + 规范化请求 + 区域/服务作用域），
 * 而且端点是按区域走的 `bedrock-runtime.<region>.amazonaws.com`，
 * 与「一个 base + 一个 key」的配置模型对不上。要用 Bedrock 的话，
 * 在它前面挂一个 OpenAI 兼容的转发层，然后按 `openai` 配 —— 那条路是通的。
 *
 * 每个协议只需要回答六个问题：打哪个地址、带什么头、body 长什么样、
 * 流式怎么抽增量、非流式怎么抽正文、模型列表在哪。其余（重试、落库、剥 think、
 * 转成本站自己的 SSE）全在 `worker.ts` 里共用，与协议无关。
 */

/** 一轮对话里的一句。system 单独传 —— 四个协议里有三个把它放在 body 顶层 */
export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export type Proto = 'openai' | 'responses' | 'anthropic' | 'gemini';

/** 后台下拉里显示的名字。`bedrock` 只是为了给出那句解释，不能选 */
export const PROTO_LABEL: Record<string, string> = {
  openai: 'OpenAI Compatible',
  responses: 'OpenAI Responses',
  anthropic: 'Anthropic',
  gemini: 'Google (Gemini)',
  bedrock: 'Amazon Bedrock（不支持，见说明）',
};

export interface Shape {
  url(base: string, model: string, key: string): string;
  headers(key: string): Record<string, string>;
  body(o: {
    model: string;
    system: string;
    turns: Turn[];
    max: number;
    temp: number;
    stream: boolean;
  }): unknown;
  /** 从一行 SSE 的 payload（已剥掉 `data:`）里抽增量文本 */
  delta(j: Record<string, unknown>): string;
  /** 从整块非流式响应里抽正文 */
  once(j: Record<string, unknown>): string;
  listUrl(base: string, key: string): string;
  listPick(j: Record<string, unknown>): string[];
}

/** 去掉末尾斜杠；`/v1` 结尾的也剥掉 —— Anthropic 与 Gemini 要自己拼版本段 */
const root = (base: string) => base.replace(/\/+$/, '').replace(/\/v1$/, '');

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** OpenAI 兼容：绝大多数中转站、vLLM、Ollama、DeepSeek、Moonshot 都是这一套 */
const openai: Shape = {
  url: (base) => `${base.replace(/\/+$/, '')}/chat/completions`,
  headers: (key) => ({ authorization: `Bearer ${key}` }),
  body: ({ model, system, turns, max, temp, stream }) => ({
    model,
    messages: [{ role: 'system', content: system }, ...turns],
    stream,
    max_tokens: max,
    temperature: temp,
  }),
  delta: (j) => {
    const c = (j.choices as { delta?: { content?: unknown }; text?: unknown }[] | undefined)?.[0];
    return str(c?.delta?.content) || str(c?.text);
  },
  once: (j) => {
    const c = (j.choices as { message?: { content?: unknown }; text?: unknown }[] | undefined)?.[0];
    return str(c?.message?.content) || str(c?.text) || str(j.response);
  },
  listUrl: (base) => `${base.replace(/\/+$/, '')}/models`,
  listPick: (j) =>
    ((j.data as { id?: unknown }[] | undefined) ?? []).map((m) => str(m.id)).filter(Boolean),
};

/**
 * OpenAI Responses API。与上面那套是**两个不同的 API**，不是别名：
 * 端点是 `/responses`，历史叫 `input` 不叫 `messages`，system 叫 `instructions`，
 * 流式是带类型的事件（`response.output_text.delta` 才是正文，其余是状态）。
 */
const responses: Shape = {
  url: (base) => `${base.replace(/\/+$/, '')}/responses`,
  headers: (key) => ({ authorization: `Bearer ${key}` }),
  body: ({ model, system, turns, max, temp, stream }) => ({
    model,
    instructions: system,
    input: turns.map((t) => ({ role: t.role, content: t.content })),
    stream,
    max_output_tokens: max,
    temperature: temp,
  }),
  delta: (j) => (j.type === 'response.output_text.delta' ? str(j.delta) : ''),
  once: (j) => {
    if (typeof j.output_text === 'string') return j.output_text;
    const out = (j.output as { content?: { text?: unknown }[] }[] | undefined) ?? [];
    return out
      .flatMap((o) => o.content ?? [])
      .map((c) => str(c.text))
      .join('');
  },
  listUrl: (base) => `${base.replace(/\/+$/, '')}/models`,
  listPick: openai.listPick,
};

/**
 * Anthropic Messages API。三处与 OpenAI 不同，错一个就是 400：
 * 鉴权头是 `x-api-key` 不是 `Authorization`、必须带 `anthropic-version`、
 * `max_tokens` 是**必填**。system 在 body 顶层，不在 messages 里。
 * 流式是带 `event:` 的多类型事件，正文只在 `content_block_delta`。
 */
const anthropic: Shape = {
  url: (base) => `${root(base)}/v1/messages`,
  headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  body: ({ model, system, turns, max, temp, stream }) => ({
    model,
    system,
    messages: turns,
    stream,
    max_tokens: max,
    temperature: temp,
  }),
  delta: (j) => {
    if (j.type !== 'content_block_delta') return '';
    return str((j.delta as { text?: unknown } | undefined)?.text);
  },
  once: (j) =>
    ((j.content as { text?: unknown }[] | undefined) ?? []).map((c) => str(c.text)).join(''),
  listUrl: (base) => `${root(base)}/v1/models`,
  listPick: openai.listPick,
};

/**
 * Google Gemini。最不一样的一个：
 * - 模型名进**路径**（`models/<model>:streamGenerateContent`），不在 body 里；
 * - key 进 **query**，没有鉴权头；
 * - 角色叫 `model` 不叫 `assistant`，内容包在 `parts[].text` 里；
 * - 要 `alt=sse` 才是逐条 SSE，否则返回一个巨大的 JSON 数组。
 */
const gemini: Shape = {
  url: (base, model, key) =>
    `${root(base)}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`,
  headers: () => ({}),
  body: ({ system, turns, max, temp }) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    })),
    generationConfig: { maxOutputTokens: max, temperature: temp },
  }),
  delta: (j) => {
    const c = (j.candidates as { content?: { parts?: { text?: unknown }[] } }[] | undefined)?.[0];
    return (c?.content?.parts ?? []).map((p) => str(p.text)).join('');
  },
  once: (j) => gemini.delta(j),
  listUrl: (base, key) => `${root(base)}/v1beta/models?key=${encodeURIComponent(key)}`,
  listPick: (j) =>
    ((j.models as { name?: unknown }[] | undefined) ?? [])
      .map((m) => str(m.name).replace(/^models\//, ''))
      .filter(Boolean),
};

export const SHAPES: Record<Proto, Shape> = { openai, responses, anthropic, gemini };

/** 非流式时 Gemini 的端点不一样（`:generateContent`），单独给一个改写 */
export const onceUrl = (proto: Proto, url: string) =>
  proto === 'gemini' ? url.replace(':streamGenerateContent', ':generateContent').replace('alt=sse&', '') : url;

export { root, str };
