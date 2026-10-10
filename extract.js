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
    if (/\/models$/i.test(trimmed)) return trimmed.replace(/\/models$/i, '/chat/completions');
    return `${trimmed}/chat/completions`;
}

/** 拼 /models 地址：用来拉模型列表，不让用户手打模型名。 */
export function joinModelsUrl(baseUrl) {
    const raw = String(baseUrl ?? '').trim();
    if (!raw) return '';
    const trimmed = raw.replace(/\/+$/, '');
    if (/\/models$/i.test(trimmed)) return trimmed;
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, '/models');
    return `${trimmed}/models`;
}

/**
 * 从各家五花八门的 /models 响应里挖出模型信息。
 * OpenAI / vLLM / Ollama / LM Studio / one-api 的字段名都不一样，这里都认。
 * 有的供应商还会报 supported_endpoints（比如只支持 /messages 的 Claude 系），一并带出来。
 */
export function parseModelList(data) {
    const list = Array.isArray(data)
        ? data
        : (Array.isArray(data?.data) ? data.data
            : (Array.isArray(data?.models) ? data.models : []));
    const out = [];
    const seen = new Set();
    for (const entry of list) {
        const id = typeof entry === 'string'
            ? entry
            : (entry?.id ?? entry?.name ?? entry?.model ?? entry?.model_name);
        const clean = String(id ?? '').trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        const endpoints = Array.isArray(entry?.supported_endpoints)
            ? entry.supported_endpoints.map(e => String(e))
            : null;
        out.push({ id: clean, endpoints });
    }
    return out;
}

/** 只要模型 id，按字母序。 */
export function pickModelIds(data) {
    return parseModelList(data).map(m => m.id).sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * 这个模型能不能走 OpenAI 的 /chat/completions。
 * 供应商没报端点信息的按「能」算——不误伤大多数不报这个字段的接口。
 */
export function supportsChatCompletions(model) {
    if (!model?.endpoints?.length) return true;
    return model.endpoints.some(e => /chat\/completions/i.test(e));
}

/** 拉取端点支持的模型列表。fetchImpl 可注入，方便离线测。 */
export async function fetchModelList({ baseUrl, apiKey, fetchImpl, signal } = {}) {
    const url = joinModelsUrl(baseUrl);
    if (!url) throw new Error('先填端点地址');
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error('当前环境没有 fetch');

    let response;
    try {
        response = await doFetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            signal,
        });
    } catch (error) {
        // 浏览器在这里抛 Failed to fetch 时，HTTP 层根本没过——多半是跨域被拦、被插件拦、或网络不通
        throw new Error(`连不上 ${url}（网络层就失败了：${error?.message ?? error}）。常见原因是跨域被拦、广告拦截插件、或网络不通。`);
    }

    if (!response.ok) {
        const detail = String(await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`${url} 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error(`${url} 返回的不是 JSON，这个地址可能不是 OpenAI 兼容的接口根路径`);
    }
    const models = parseModelList(data);
    if (!models.length) {
        throw new Error(`${url} 没有返回任何模型（响应里找不到 data[].id 之类的字段）`);
    }
    // 能走 /chat/completions 的排前面——默认要选的是它们
    return [...models].sort((a, b) =>
        Number(supportsChatCompletions(b)) - Number(supportsChatCompletions(a))
        || a.id.localeCompare(b.id, 'en'));
}

/**
 * 拉完列表后决定选哪个：能保留就保留，否则挑第一个能用的。
 * noChat 里是本端点明确不支持 /chat/completions 的模型，不能默认选它们。
 */
export function pickDefaultModel(models, current, { noChat = [] } = {}) {
    const list = Array.isArray(models) ? models : [];
    const blocked = new Set(noChat ?? []);
    const kept = String(current ?? '').trim();
    if (kept && list.includes(kept) && !blocked.has(kept)) return kept;
    const firstUsable = list.find(id => !blocked.has(id));
    if (firstUsable) return firstUsable;
    if (kept && list.includes(kept)) return kept;
    return kept || list[0] || '';
}

/** 从 OpenAI 兼容响应里取正文；结构不对就抛出可读错误。 */
export function pickChatCompletionContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    // 有些端点把内容拆成数组（多模态格式）
    if (Array.isArray(content)) {
        const joined = content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
        if (joined.trim()) return joined;
    }
    const legacy = data?.choices?.[0]?.text;
    if (typeof legacy === 'string' && legacy.trim()) return legacy;

    // 内容为空但只有思考内容：多半是推理模型把预算花在思考上被截断了
    const reasoning = data?.choices?.[0]?.message?.reasoning_content ?? data?.choices?.[0]?.message?.reasoning;
    if (typeof reasoning === 'string' && reasoning.trim()) {
        throw new Error('模型只吐出了思考内容，正式回答被长度限制截断了。换个非推理模型，或把「每块字数」调小让回复短一点。');
    }
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
 * 单飞：同一件事在飞的时候，后来的调用复用同一个 Promise。
 *
 * 拉模型列表必须用它——连点「重新拉取」或者自动+手动叠在一起，
 * 会同时发好几个请求、每个回来都重渲染一次，界面上看起来就是不停闪。
 */
export function createSingleFlight() {
    let inFlight = null;
    return {
        get busy() {
            return inFlight !== null;
        },
        run(task) {
            if (inFlight) return inFlight;
            const promise = (async () => {
                try {
                    return await task();
                } finally {
                    inFlight = null;
                }
            })();
            inFlight = promise;
            return promise;
        },
    };
}

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
