/**
 * extract.js 离线自测（模型调用层 + 编排）。
 * 运行：node test-extract.mjs
 *
 * 全程用假 fetch / 假调用器，不发任何真实网络请求。
 */

import {
    CONSECUTIVE_FAILURE_LIMIT,
    createCaller,
    createCustomCaller,
    createStCaller,
    fetchModelList,
    joinChatCompletionsUrl,
    joinModelsUrl,
    parseModelList,
    pickChatCompletionContent,
    pickDefaultModel,
    pickModelIds,
    runExtraction,
    supportsChatCompletions,
} from './extract.js';
import { autoMapNames, buildParticipants, collectNames, mergeExtractResults } from './core.js';

let passed = 0;
const failures = [];

function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed += 1;
            console.log(`  ok   ${name}`);
        })
        .catch(error => {
            failures.push({ name, error });
            console.log(`  FAIL ${name}\n       ${error.message}`);
        });
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message ?? '值不相等'}：实际 ${a}，期望 ${b}`);
}

function assertIncludes(haystack, needle, message) {
    if (!String(haystack).includes(needle)) {
        throw new Error(`${message ?? '未包含'}：「${needle}」不在结果里\n结果：${haystack}`);
    }
}

/** 造一个假的 OpenAI 兼容响应。 */
function fakeResponse(content, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => String(content),
    };
}

/* ---------------- 地址与响应解析 ---------------- */

console.log('端点地址');

await check('只填到 /v1 会自动补 /chat/completions', () => {
    assertEqual(joinChatCompletionsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
});
await check('尾斜杠被吃掉', () => {
    assertEqual(joinChatCompletionsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
});
await check('已经填全了就不重复拼', () => {
    assertEqual(joinChatCompletionsUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
});
await check('空地址返回空串', () => {
    assertEqual(joinChatCompletionsUrl('   '), '');
});

console.log('\n响应取正文');

await check('标准 OpenAI 结构', () => {
    assertEqual(pickChatCompletionContent({ choices: [{ message: { content: 'hi' } }] }), 'hi');
});
await check('内容被拆成数组时拼接', () => {
    assertEqual(pickChatCompletionContent({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
});
await check('老式 text 字段兜底', () => {
    assertEqual(pickChatCompletionContent({ choices: [{ text: 'legacy' }] }), 'legacy');
});
await check('结构不对时报可读错误', () => {
    let threw = false;
    try {
        pickChatCompletionContent({ nothing: true });
    } catch (error) {
        threw = true;
        assertIncludes(error.message, 'choices[0].message.content');
    }
    assert(threw, '应抛错');
});

console.log('\n模型列表（不让用户手打模型名）');

await check('/models 地址拼接', () => {
    assertEqual(joinModelsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/models');
    assertEqual(joinModelsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
    assertEqual(joinModelsUrl('https://api.example.com/v1/models'), 'https://api.example.com/v1/models');
    assertEqual(joinModelsUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models');
    assertEqual(joinModelsUrl('  '), '');
});
await check('反过来，填 /models 也能推出 /chat/completions', () => {
    assertEqual(joinChatCompletionsUrl('https://api.example.com/v1/models'), 'https://api.example.com/v1/chat/completions');
});
await check('认 OpenAI 的 {data:[{id}]}', () => {
    assertEqual(pickModelIds({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), ['gpt-4o', 'gpt-4o-mini']);
});
await check('认裸数组、{models:[{name}]}、字符串数组', () => {
    assertEqual(pickModelIds(['b', 'a']), ['a', 'b']);
    assertEqual(pickModelIds({ models: [{ name: 'qwen2.5' }] }), ['qwen2.5']);
    assertEqual(pickModelIds({ data: [{ model: 'deepseek-chat' }] }), ['deepseek-chat']);
});
await check('去重并丢掉空值，结果排序稳定', () => {
    assertEqual(pickModelIds({ data: [{ id: 'x' }, { id: 'x' }, { id: '' }, { id: '  ' }, { nothing: 1 }] }), ['x']);
});
await check('没有模型时返回空数组', () => {
    assertEqual(pickModelIds(null), []);
    assertEqual(pickModelIds({ data: [] }), []);
});
await check('fetchModelList 带上 Bearer 并发 GET', async () => {
    let seen = null;
    const models = await fetchModelList({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-x',
        fetchImpl: async (url, init) => {
            seen = { url, init };
            return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }), text: async () => '' };
        },
    });
    assertEqual(seen.url, 'https://api.example.com/v1/models');
    assertEqual(seen.init.method, 'GET');
    assertEqual(seen.init.headers.Authorization, 'Bearer sk-x');
    assertEqual(models.map(m => m.id), ['m1', 'm2']);
});
await check('fetchModelList 的错误带状态码和响应片段', async () => {
    let message = '';
    try {
        await fetchModelList({
            baseUrl: 'https://x/v1',
            fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'not found', json: async () => ({}) }),
        });
    } catch (error) {
        message = error.message;
    }
    assertIncludes(message, '404');
    assertIncludes(message, 'not found');
    assertIncludes(message, 'https://x/v1/models', '报错里要说清试的是哪个地址');
});
await check('网络层失败（浏览器跨域被拦）给出人能看懂的提示', async () => {
    let message = '';
    try {
        await fetchModelList({
            baseUrl: 'https://x/v1',
            fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
        });
    } catch (error) {
        message = error.message;
    }
    assertIncludes(message, '连不上');
    assertIncludes(message, 'Failed to fetch');
    assertIncludes(message, '跨域');
});
await check('返回不是 JSON 时提示地址可能填错层级', async () => {
    let message = '';
    try {
        await fetchModelList({
            baseUrl: 'https://x/v1',
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); }, text: async () => '<html>hi</html>' }),
        });
    } catch (error) {
        message = error.message;
    }
    assertIncludes(message, '不是 JSON');
});
await check('没填地址直接报错，不发请求', async () => {
    let threw = false;
    try {
        await fetchModelList({ baseUrl: '', fetchImpl: async () => { throw new Error('不该被调用'); } });
    } catch (error) {
        threw = true;
        assertIncludes(error.message, '端点地址');
    }
    assert(threw, '应报错');
});
await check('列表拉回来但没有模型时报可读错误', async () => {
    let message = '';
    try {
        await fetchModelList({
            baseUrl: 'https://x/v1',
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' }),
        });
    } catch (error) {
        message = error.message;
    }
    assertIncludes(message, '没有返回任何模型');
});
await check('自动选模型：能保留就保留，否则用列表第一个', () => {
    assertEqual(pickDefaultModel(['a', 'b'], 'b'), 'b', '列表里还有就保留用户的选择');
    assertEqual(pickDefaultModel(['a', 'b'], 'z'), 'a', '已不在列表里就退回第一个');
    assertEqual(pickDefaultModel(['only'], ''), 'only');
    assertEqual(pickDefaultModel([], 'kept'), 'kept', '拉不到列表时不要清掉已有值');
});
await check('明知不支持 /chat/completions 的模型不会被默认选中', () => {
    // 真实场景：commandcode 那种端点，字母序第一个恰好是只支持 /messages 的 Claude
    const models = ['claude-fable-5', 'deepseek/deepseek-v4-flash', 'gpt-5.5'];
    const noChat = ['claude-fable-5'];
    assertEqual(pickDefaultModel(models, '', { noChat }), 'deepseek/deepseek-v4-flash');
    assertEqual(pickDefaultModel(models, 'claude-fable-5', { noChat }), 'deepseek/deepseek-v4-flash',
        '上次自动选错了，这次要改过来');
    assertEqual(pickDefaultModel(models, 'gpt-5.5', { noChat }), 'gpt-5.5', '用户自己选的可用模型要尊重');
    assertEqual(pickDefaultModel(['claude-fable-5'], 'claude-fable-5', { noChat }), 'claude-fable-5',
        '全是不可用的，那就还留着，别清空');
});
await check('supported_endpoints 能识别出来', () => {
    const list = parseModelList({
        data: [
            { id: 'claude-sonnet-5', supported_endpoints: ['/messages'] },
            { id: 'gpt-5.5', supported_endpoints: ['/messages', '/chat/completions'] },
            { id: 'no-info' },
        ],
    });
    assertEqual(list.length, 3);
    assertEqual(supportsChatCompletions(list[0]), false, '只支持 /messages 的不该算可用');
    assertEqual(supportsChatCompletions(list[1]), true);
    assertEqual(supportsChatCompletions(list[2]), true, '没报端点的按可用算，不误伤');
});
await check('拉到的列表把可用的排在前面', async () => {
    const list = await fetchModelList({
        baseUrl: 'https://x/v1',
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({
                data: [
                    { id: 'aaa-claude', supported_endpoints: ['/messages'] },
                    { id: 'zzz-gpt', supported_endpoints: ['/chat/completions'] },
                ],
            }),
        }),
    });
    assertEqual(list.map(m => m.id), ['zzz-gpt', 'aaa-claude'], '可用的要排前面，哪怕字母序靠后');
});

/* ---------------- 自定义端点调用器 ---------------- */

console.log('\n自定义端点调用器');

await check('请求体带 model / messages / temperature，并带 Bearer 头', async () => {
    let seen = null;
    const caller = createCustomCaller({
        baseUrl: 'https://api.example.com/v1',
        model: 'test-model',
        apiKey: 'sk-test',
        temperature: 0.3,
        fetchImpl: async (url, init) => {
            seen = { url, init };
            return fakeResponse('{"appellations":[]}');
        },
    });
    const out = await caller({ system: 'S', user: 'U' });
    assertEqual(out, '{"appellations":[]}');
    assertEqual(seen.url, 'https://api.example.com/v1/chat/completions');
    assertEqual(seen.init.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(seen.init.body);
    assertEqual(body.model, 'test-model');
    assertEqual(body.temperature, 0.3);
    assertEqual(body.messages[0], { role: 'system', content: 'S' });
    assertEqual(body.messages[1], { role: 'user', content: 'U' });
});
await check('不带密钥时不发 Authorization 头', async () => {
    let seen = null;
    const caller = createCustomCaller({
        baseUrl: 'https://x/v1',
        model: 'm',
        apiKey: '',
        fetchImpl: async (url, init) => { seen = init; return fakeResponse('{}'); },
    });
    await caller({ system: 's', user: 'u' });
    assert(!('Authorization' in seen.headers), '不该有 Authorization');
});
await check('HTTP 错误带上状态码和响应片段', async () => {
    const caller = createCustomCaller({
        baseUrl: 'https://x/v1',
        model: 'm',
        fetchImpl: async () => fakeResponse('invalid api key', { ok: false, status: 401 }),
    });
    let message = '';
    try {
        await caller({ system: 's', user: 'u' });
    } catch (error) {
        message = error.message;
    }
    assertIncludes(message, '401');
    assertIncludes(message, 'invalid api key');
});
await check('缺地址 / 缺模型名直接报错，不发请求', () => {
    let threw = false;
    try { createCustomCaller({ baseUrl: '', model: 'm' }); } catch { threw = true; }
    assert(threw, '缺地址应报错');
    threw = false;
    try { createCustomCaller({ baseUrl: 'https://x/v1', model: '' }); } catch { threw = true; }
    assert(threw, '缺模型名应报错');
});

/* ---------------- 酒馆连接调用器 ---------------- */

console.log('\n酒馆连接调用器');

await check('走 generateRaw，并且必须关掉 trimNames', async () => {
    let seen = null;
    const host = {
        generateRaw: async (args) => { seen = args; return '{"appellations":[]}'; },
    };
    const caller = createStCaller(host, { maxTokens: 900 });
    const out = await caller({ system: 'SYS', user: 'USER' });
    assertEqual(out, '{"appellations":[]}');
    assertEqual(seen.systemPrompt, 'SYS');
    assertEqual(seen.prompt, 'USER');
    assertEqual(seen.responseLength, 900);
    assertEqual(seen.trimNames, false, 'trimNames 必须为 false，否则角色名会被删掉');
});
await check('没有 generateRaw 时报可读错误', async () => {
    const caller = createStCaller({}, {});
    let message = '';
    try { await caller({ system: 's', user: 'u' }); } catch (error) { message = error.message; }
    assertIncludes(message, 'generateRaw');
});
await check('createCaller 按 mode 选对调用器', async () => {
    const st = createCaller({ mode: 'st' }, { generateRaw: async () => 'st' });
    assertEqual(await st({ system: '', user: '' }), 'st');
    const custom = createCaller(
        { mode: 'custom', custom: { baseUrl: 'https://x/v1', model: 'm', apiKey: '' }, temperature: 0 },
        null,
        { fetchImpl: async () => fakeResponse('custom') },
    );
    assertEqual(await custom({ system: '', user: '' }), 'custom');
});

/* ---------------- 编排 ---------------- */

console.log('\n提取编排');

/** chunkText 的最小块长是 200，所以测试正文得够长，才能切出多块。 */
const LINE = '白鹭看着星野。“小星星，你怎么来了？”星野说：“陆哥让我来的。”白鹭笑了，她又叫了一声小星星。';
const NOVEL = LINE.repeat(12);

await check('逐块调用，最后合并出结果，并报出进度', async () => {
    const phases = [];
    const calls = [];
    const out = await runExtraction({
        text: NOVEL,
        opts: { chunkChars: 200, overlapChars: 5, maxChunks: 5 },
        caller: async ({ user }) => {
            calls.push(user);
            // 假模型：从提示词里认出块序号，返回不同内容
            const index = /第 (\d+) \//.exec(user)?.[1] ?? '1';
            return JSON.stringify({ appellations: [{ from: '白鹭', to: '星野', call: `称呼${index}` }] });
        },
        onProgress: p => phases.push(p.phase),
    });
    assert(calls.length >= 2, `应该调用多次，实际 ${calls.length}`);
    assertEqual(out.results.length, calls.length, '每块的称呼都不同，应各占一行');
    assert(phases.includes('begin') && phases.includes('chunk') && phases.includes('ok') && phases.includes('end'), `缺进度事件：${phases}`);
    assertEqual(out.failures.length, 0);
    assert(out.nextOffset > 0, '应记录下次可以接着跑的位置');
});
await check('同一条关系跨多块出现会累加次数', async () => {
    const out = await runExtraction({
        text: NOVEL,
        opts: { chunkChars: 200, overlapChars: 0, maxChunks: 5 },
        caller: async () => JSON.stringify({ appellations: [{ from: '白鹭', to: '星野', call: '小星星' }] }),
    });
    assert(out.results.length === 1, `应合并且只有一行，实际 ${out.results.length}`);
    assert(out.results[0].count >= 2, `命中次数应 >= 2，实际 ${out.results[0].count}`);
});
await check('模型返回废话时记 badjson，连败到上限就停', async () => {
    let calls = 0;
    const phases = [];
    const out = await runExtraction({
        text: NOVEL,
        opts: { chunkChars: 200, overlapChars: 0, maxChunks: 5 },
        caller: async () => { calls += 1; return '我觉得这里没有称呼。'; },
        onProgress: p => phases.push(p),
    });
    assertEqual(out.results.length, 0);
    assertEqual(out.failures.length, CONSECUTIVE_FAILURE_LIMIT);
    assertEqual(calls, CONSECUTIVE_FAILURE_LIMIT, '不该把剩下的块全跑完');
    assertEqual(out.stoppedEarly, true);
    assert(phases.some(p => p.phase === 'badjson'), '应有 badjson 事件');
});
await check('连续失败到上限就提前停，不再烧请求', async () => {
    let calls = 0;
    const phases = [];
    const out = await runExtraction({
        text: '甲'.repeat(2000),
        opts: { chunkChars: 200, overlapChars: 0, maxChunks: 20 },
        caller: async () => { calls += 1; throw new Error('401 未授权'); },
        onProgress: p => phases.push(p),
    });
    assertEqual(calls, CONSECUTIVE_FAILURE_LIMIT, `应只试 ${CONSECUTIVE_FAILURE_LIMIT} 次，实际 ${calls}`);
    assertEqual(out.stoppedEarly, true);
    assert(phases.some(p => p.phase === 'stoppedEarly'), '应有 stoppedEarly 事件');
    assert(out.failures.length === CONSECUTIVE_FAILURE_LIMIT);
});
await check('中间一次成功会重置连败计数', async () => {
    let calls = 0;
    const out = await runExtraction({
        text: NOVEL,
        opts: { chunkChars: 200, overlapChars: 0, maxChunks: 3 },
        caller: async () => {
            calls += 1;
            if (calls === 1) throw new Error('第一次挂了');
            return JSON.stringify({ appellations: [{ from: 'A', to: 'B', call: '老弟' }] });
        },
    });
    assertEqual(out.failures.length, 1);
    assertEqual(out.stoppedEarly, false, '中间成功后不该提前停');
    assertEqual(out.results.length, 1, '后两块返回同一条关系，应合并成一行');
    assertEqual(out.results[0].count, 2, '应累计 2 次命中');
});
await check('shouldAbort 能中途叫停', async () => {
    let calls = 0;
    let stop = false;
    const out = await runExtraction({
        text: '甲'.repeat(3000),
        opts: { chunkChars: 300, overlapChars: 0, maxChunks: 10 },
        caller: async () => {
            calls += 1;
            if (calls === 2) stop = true;
            return JSON.stringify({ appellations: [] });
        },
        shouldAbort: () => stop,
    });
    assertEqual(calls, 2, '叫停后不该再发第三次');
    assertEqual(out.aborted, true);
});
await check('跑完之后能直接接上映射和落表（端到端）', async () => {
    const characters = [{ name: '白鹭', avatar: 'bailu.png' }, { name: '星野', avatar: 'xingye.png' }];
    const participants = buildParticipants({ name1: '小陆', characterId: undefined, characters, groupId: 'g', groups: [{ id: 'g', members: ['bailu.png', 'xingye.png'] }] });
    const out = await runExtraction({
        text: NOVEL,
        opts: { chunkChars: 200, overlapChars: 0, maxChunks: 5 },
        caller: async () => JSON.stringify({
            appellations: [
                { from: '白鹭', to: '星野', call: '小星星', confidence: 0.9 },
                { from: '星野', to: '小陆', call: '陆哥', confidence: 0.9 },
                { from: '星野', to: '老王', call: '老王', confidence: 0.9 },
            ],
        }),
    });
    const names = collectNames(mergeExtractResults([out.results]));
    const mapping = autoMapNames(names, participants);
    assertEqual(mapping['白鹭'], 'char:bailu.png');
    assertEqual(mapping['星野'], 'char:xingye.png');
    assertEqual(mapping['小陆'], '__user__', '「小陆」正好是用户 persona 的名字，应映射到用户');
    assertEqual(mapping['老王'], null, '当前聊天里没有老王，应留空而不是硬塞给谁');
});

/* ---------------- 汇总 ---------------- */

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
    for (const f of failures) console.error(`\n[${f.name}]\n${f.error.stack}`);
    process.exitCode = 1;
}
