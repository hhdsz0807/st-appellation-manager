/**
 * 称呼管理器 · 正文提取的模型调用与编排
 *
 * 两种模型来源：
 *   st      —— 用酒馆当前连接（你在酒馆里配的任何模型，包括自定义 OpenAI 兼容端点）。
 *              调用 host.generateRaw()，不碰密钥、不受浏览器跨域限制，推荐。
 *   custom  —— 扩展自己直连一个 OpenAI 兼容端点（浏览器 fetch）。
 *              需要对方接口带 CORS 头，密钥存在酒馆设置里（明文，见 README 警告）。
 *
 * 编排（切块、解析、合并、映射）的纯逻辑都在 core.js。
 */

import {
    extractSystemPrompt,
    extractUserPrompt,
    mergeExtractResults,
    parseExtractResponse,
    chunkText,
} from './core.js';

/** 拼 /chat/completions 地址：允许用户只填到 /v1，也允许直接填完整地址。 */
export function joinChatCompletionsUrl(baseUrl) {
    const raw = String(baseUrl ?? '').trim();
    if (!raw) return '';
    const trimmed = raw.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
    return `${trimmed}/chat/completions`;
}

/** 从 OpenAI 兼容响应里取正文；结构不对就抛出可读错误。 */
export function pickChatCompletionContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    // 有些端点把内容拆成数组（多模态格式）
    if (Array.isArray(content)) {
        const joined = content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
        if (joined.trim()) return joined;
    }
    const legacy = data?.choices?.[0]?.text;
    if (typeof legacy === 'string') return legacy;
    throw new Error('返回结构里找不到 choices[0].message.content');
}

/** 用酒馆当前连接生成。host 是 SillyTavern.getContext() 的结果。 */
export function createStCaller(host, { maxTokens = 1600 } = {}) {
    return async ({ system, user }) => {
        if (typeof host?.generateRaw !== 'function') {
            throw new Error('这台酒馆没有暴露 generateRaw，无法用当前连接提取');
        }
        // trimNames 必须关掉：默认会把角色名从返回文本里删掉，正好会把我们要的名字删没。
        return await host.generateRaw({
            prompt: user,
            systemPrompt: system,
            responseLength: maxTokens,
            trimNames: false,
        });
    };
}

/** 直连自定义 OpenAI 兼容端点。fetchImpl 可注入，方便离线测。 */
export function createCustomCaller({ baseUrl, model, apiKey, temperature = 0, maxTokens = 1600, fetchImpl }) {
    const url = joinChatCompletionsUrl(baseUrl);
    if (!url) throw new Error('没填自定义端点地址');
    if (!String(model ?? '').trim()) throw new Error('没填模型名');

    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error('当前环境没有 fetch');

    return async ({ system, user, signal }) => {
        const response = await doFetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                model,
                temperature,
                max_tokens: maxTokens,
                stream: false,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
            }),
            signal,
        });

        if (!response.ok) {
            const detail = String(await response.text().catch(() => '')).slice(0, 200);
            throw new Error(`端点返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
        }
        return pickChatCompletionContent(await response.json());
    };
}

/**
 * 按设置挑一个调用器。
 * @param {{mode:'st'|'custom', custom:{baseUrl:string,model:string,apiKey:string}, temperature:number}} extract
 * @param {object} host SillyTavern.getContext()
 * @param {object} [opts] maxTokens / fetchImpl（测试时可注入假 fetch）
 */
export function createCaller(extract, host, opts = {}) {
    const maxTokens = opts.maxTokens ?? 1600;
    if (extract?.mode === 'custom') {
        return createCustomCaller({
            baseUrl: extract.custom?.baseUrl,
            model: extract.custom?.model,
            apiKey: extract.custom?.apiKey,
            temperature: extract.temperature ?? 0,
            maxTokens,
            fetchImpl: opts.fetchImpl,
        });
    }
    return createStCaller(host, { maxTokens });
}

/** 连续失败多少次就放弃（避免配置错了还一直烧请求）。 */
export const CONSECUTIVE_FAILURE_LIMIT = 2;

/**
 * 跑一轮提取。
 * @param {object} params
 * @param {string} params.text 正文
 * @param {object} params.opts chunkChars / maxChunks / startOffset
 * @param {(args:{system:string,user:string,signal:AbortSignal}) => Promise<string>} params.caller
 * @param {(progress:object) => void} [params.onProgress]
 * @param {() => boolean} [params.shouldAbort]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{results:Array, failures:Array, chunks:number, aborted:boolean, nextOffset:number, stoppedEarly:boolean}>}
 */
export async function runExtraction({ text, opts = {}, caller, onProgress, shouldAbort, signal } = {}) {
    const chunks = chunkText(text, opts);
    const perChunk = [];
    const failures = [];
    let consecutiveFailures = 0;
    let aborted = false;
    let stoppedEarly = false;
    let nextOffset = Number(opts?.startOffset) || 0;

    const total = chunks.length;
    onProgress?.({ phase: 'begin', total, chunks });

    for (const chunk of chunks) {
        if (shouldAbort?.() || signal?.aborted) {
            aborted = true;
            break;
        }

        onProgress?.({ phase: 'chunk', index: chunk.index, done: chunk.index, total, start: chunk.start, end: chunk.end });

        try {
            const raw = await caller({
                system: extractSystemPrompt(),
                user: extractUserPrompt(chunk, chunk.index, total),
                signal,
            });
            const parsed = parseExtractResponse(raw);
            perChunk.push(parsed.items);
            nextOffset = chunk.end;
            if (parsed.error) {
                failures.push({ index: chunk.index, error: parsed.error, raw: String(raw).slice(0, 400) });
                consecutiveFailures += 1;
                onProgress?.({ phase: 'badjson', index: chunk.index, done: chunk.index + 1, total, error: parsed.error });
            } else {
                consecutiveFailures = 0;
                onProgress?.({ phase: 'ok', index: chunk.index, done: chunk.index + 1, total, got: parsed.items.length });
            }
        } catch (error) {
            perChunk.push([]);
            consecutiveFailures += 1;
            failures.push({ index: chunk.index, error: error?.message ?? String(error) });
            onProgress?.({ phase: 'fail', index: chunk.index, done: chunk.index + 1, total, error: error?.message ?? String(error) });
        }

        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT && chunk.index < total - 1) {
            stoppedEarly = true;
            onProgress?.({ phase: 'stoppedEarly', total, done: chunk.index + 1, failures });
            break;
        }
    }

    const results = mergeExtractResults(perChunk);
    onProgress?.({ phase: 'end', total, done: perChunk.length, results, failures, aborted, stoppedEarly, nextOffset });

    return { results, failures, chunks: total, aborted, nextOffset, stoppedEarly };
}
