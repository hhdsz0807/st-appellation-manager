/**
 * core.js 离线自测（不依赖酒馆、不依赖浏览器）。
 * 运行：node test-core.mjs
 */

import * as mod from './core.js';

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push({ name, error });
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
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

/* ---------------- 固定数据 ---------------- */

const { USER_KEY } = mod;
const characters = [
    { name: '白鹭', avatar: 'bailu.png' },
    { name: '星野', avatar: 'xingye.png' },
];
const hostSolo = { name1: '小陆', characterId: 0, characters, groupId: null, groups: [] };
const hostGroup = {
    name1: '小陆',
    characterId: undefined,
    characters,
    groupId: 'g1',
    groups: [{ id: 'g1', members: ['bailu.png', 'xingye.png'] }],
};

const BAILU = 'char:bailu.png';
const XINGYE = 'char:xingye.png';

const soloMessages = [
    { is_user: true, name: '小陆', mes: '“白鹭姐，今天怎么有空过来？”我看向白鹭。' },
    { is_user: false, name: '白鹭', mes: '“陆哥，你来了。”白鹭低声说道。' },
];

const groupMessages = [
    { is_user: false, name: '白鹭', mes: '她称呼星野为“小星星”，语气很软。' },
    { is_user: true, name: '小陆', mes: '“白鹭姐，今天怎么有空过来？”我看向白鹭。' },
    { is_user: true, name: '小陆', mes: '“白鹭姐，帮我看一眼这个。”' },
    { is_user: false, name: '白鹭', mes: '“陆哥，你来了。”白鹭低声说道。' },
];

/* ---------------- 参与者 ---------------- */

console.log('参与者解析');
check('单聊：用户 + 1 个角色', () => {
    const list = mod.buildParticipants(hostSolo);
    assertEqual(list.map(p => p.name), ['小陆', '白鹭']);
    assertEqual(list[0].key, USER_KEY);
    assertEqual(list[1].key, BAILU);
    assertEqual(list[1].kind, 'character');
});
check('群聊：用户 + 全部群成员', () => {
    const list = mod.buildParticipants(hostGroup);
    assertEqual(list.map(p => p.name), ['小陆', '白鹭', '星野']);
});
check('当前角色定位：group 顺序里能按 name2 命中', () => {
    const list = mod.buildParticipants(hostGroup);
    assertEqual(mod.focusParticipantKey(list, '星野'), XINGYE);
});

/* ---------------- 关系读写 ---------------- */

console.log('\n关系读写');
let state = mod.emptyChatState();
check('写入关系并归一化别名（逗号分隔 → 数组，且剔除与主称呼重复的）', () => {
    state = mod.setRelation(state, BAILU, USER_KEY, { call: '陆哥', aliases: '哥，小陆哥，陆哥', stage: '熟悉' });
    const rel = mod.getRelation(state, BAILU, USER_KEY);
    assertEqual(rel.call, '陆哥');
    assertEqual(rel.aliases, ['哥', '小陆哥']);
    assertEqual(rel.stage, '熟悉');
});
check('关系键可解析回源与目标', () => {
    assertEqual(mod.parseRelationKey(mod.relationKey(BAILU, XINGYE)), { from: BAILU, to: XINGYE });
});
check('字段全空时自动删除该条关系', () => {
    const next = mod.setRelation(state, BAILU, XINGYE, { call: '', aliases: [], stage: '', note: '' });
    assert(next.relations[mod.relationKey(BAILU, XINGYE)] === undefined, '空关系应被删除');
});
check('清空单条 / 清空全部', () => {
    const one = mod.clearRelation(state, BAILU, USER_KEY);
    assert(one.relations[mod.relationKey(BAILU, USER_KEY)] === undefined, '单条应被清掉');
    const all = mod.clearAllRelations(state);
    assertEqual(Object.keys(all.relations), []);
});
check('脏数据不会让归一化抛错', () => {
    const dirty = mod.normalizeChatState({
        relations: { 'not-a-key': { call: 'x' }, 'a=>b': 'garbage', 'c=>d': { call: 1, aliases: 2 } },
    });
    assert(typeof dirty.relations === 'object', '应返回对象');
    assert(dirty.relations['not-a-key'] === undefined, '非法关系键应被丢弃');
});
check('孤儿关系能被找出来', () => {
    const s = mod.setRelation(mod.emptyChatState(), XINGYE, BAILU, { call: '白鹭' });
    const orphans = mod.findOrphanRelations(s, mod.buildParticipants(hostSolo));
    assertEqual(orphans.length, 1);
    assertEqual(orphans[0].to, BAILU);
});

/* ---------------- 提示词拼接 ---------------- */

console.log('\n提示词拼接');
state = mod.emptyChatState();
state = mod.setRelation(state, BAILU, USER_KEY, { call: '陆哥', aliases: '哥，小陆哥', stage: '熟悉' });
state = mod.setRelation(state, USER_KEY, BAILU, { call: '白鹭姐' });
const library = mod.normalizeLibrary({
    [mod.relationKey(BAILU, XINGYE)]: { call: '小星' },
});

check('关系表按「源 → 目标：称呼（别名；关系）」输出', () => {
    const text = mod.composePromptBlock({
        participants: mod.buildParticipants(hostGroup),
        chatState: state,
        library,
        opts: { includeAliases: true, includeStage: true, includeNote: false, header: true, fallbackRule: true, targets: 'all' },
    });
    assertIncludes(text, '白鹭 → 小陆：陆哥（别名：哥、小陆哥；关系：熟悉）');
    assertIncludes(text, '小陆 → 白鹭：白鹭姐');
    assertIncludes(text, '白鹭 → 星野：小星', '全局默认库应作为兜底');
});
check('范围=只含用户相关时，排除角色与角色之间的称呼', () => {
    const text = mod.composePromptBlock({
        participants: mod.buildParticipants(hostGroup),
        chatState: state,
        library,
        opts: { includeAliases: true, targets: 'user' },
    });
    assert(!text.includes('星野'), '不该出现角色间的称呼');
});
check('关掉表头与兜底规则', () => {
    const text = mod.composePromptBlock({
        participants: mod.buildParticipants(hostGroup),
        chatState: state,
        library,
        opts: { header: false, fallbackRule: false, includeAliases: false, targets: 'all' },
    });
    assert(!text.includes('【称呼表】'), '不该有表头');
    assert(!text.includes('未列出的关系'), '不该有兜底规则');
});
check('没有登记任何称呼时返回空字符串（不注入空内容）', () => {
    const text = mod.composePromptBlock({ participants: mod.buildParticipants(hostGroup), chatState: null, library: null, opts: {} });
    assertEqual(text, '');
});
check('超出长度上限时逐条截断并说明，不静默丢弃', () => {
    const big = mod.emptyChatState();
    big.relations[mod.relationKey(BAILU, USER_KEY)] = { call: '甲'.repeat(300), aliases: [], stage: '', note: '' };
    const text = mod.composePromptBlock({
        participants: mod.buildParticipants(hostGroup),
        chatState: big,
        library,
        opts: { header: true, fallbackRule: true, targets: 'all', maxChars: 260 },
    });
    assertIncludes(text, '因长度限制未列出');
    assert(text.length <= 260, `截断后长度 ${text.length} 应 <= 260`);
    assert(!text.includes('甲'.repeat(300)), '超长的那条不该原样出现');
});
check('单行表用于宏 {{callTable}}', () => {
    const line = mod.composeInlineTable({ participants: mod.buildParticipants(hostGroup), chatState: state, library });
    assertIncludes(line, '白鹭→小陆:陆哥');
    assert(!line.includes('\n'), '不应换行');
});

/* ---------------- 扫描 ---------------- */

console.log('\n候选扫描');
check('单聊：能从「陆哥，你来了」提出角色→用户的候选', () => {
    const found = mod.scanCandidates({ messages: soloMessages, participants: mod.buildParticipants(hostSolo), limit: 40 });
    const hit = found.find(c => c.from === BAILU && c.to === USER_KEY && c.call === '陆哥');
    assert(hit, `应扫到 陆哥，实际：${found.map(c => `${c.fromName}->${c.toName}:${c.call}`).join(' | ')}`);
    assert(hit.count >= 1, '出现次数应 >= 1');
});
check('单聊：能从用户消息里提出用户→角色的候选', () => {
    const found = mod.scanCandidates({ messages: soloMessages, participants: mod.buildParticipants(hostSolo), limit: 40 });
    const hit = found.find(c => c.from === USER_KEY && c.to === BAILU && c.call === '白鹭姐');
    assert(hit, `应扫到 白鹭姐，实际：${found.map(c => c.call).join(' | ')}`);
});
check('「称呼X为“Y”」句式能抓到 Y 而不是 X 或 X为', () => {
    const found = mod.scanCandidates({ messages: groupMessages, participants: mod.buildParticipants(hostGroup), limit: 40 });
    const hit = found.find(c => c.from === BAILU && c.to === XINGYE && c.call === '小星星');
    assert(hit, `应扫到 小星星，实际：${found.map(c => `${c.fromName}->${c.toName}:${c.call}`).join(' | ')}`);
    assert(!found.some(c => c.call === '星野为'), '不该把「星野为」当称呼');
    assert(!found.some(c => c.call === '呼星野'), '不该把「呼星野」当称呼');
});
check('群聊里指代不明时宁可不报（陆哥 无法定位到人）', () => {
    const found = mod.scanCandidates({ messages: groupMessages, participants: mod.buildParticipants(hostGroup), limit: 40 });
    assert(!found.some(c => c.call === '陆哥'), '群聊里 陆哥 不应被归到某个人头上');
});
check('同一候选重复出现会累加次数', () => {
    const found = mod.scanCandidates({ messages: groupMessages, participants: mod.buildParticipants(hostGroup), limit: 40 });
    const hit = found.find(c => c.call === '白鹭姐');
    assert(hit && hit.count >= 2, `白鹭姐 应出现 >= 2 次，实际 ${hit?.count}`);
});
check('候选带证据样本', () => {
    const found = mod.scanCandidates({ messages: soloMessages, participants: mod.buildParticipants(hostSolo), limit: 40 });
    assert(found.every(c => c.samples.length >= 1), '每条候选都应带样本');
});
check('minCount 能过滤掉只出现一次的候选', () => {
    const found = mod.scanCandidates({ messages: soloMessages, participants: mod.buildParticipants(hostSolo), limit: 40, minCount: 5 });
    assertEqual(found.length, 0);
});
check('代码块整体跳过；HTML 只剥标签、保留正文', () => {
    const noisy = [{ is_user: false, name: '白鹭', mes: '```\n她称呼小陆为“代码哥”\n```\n<div>称呼小陆为“标签哥”</div>' }];
    const found = mod.scanCandidates({ messages: noisy, participants: mod.buildParticipants(hostSolo), limit: 40 });
    assert(!found.some(c => c.call === '代码哥'), '代码块里的内容不该被扫出来');
    assert(found.some(c => c.call === '标签哥'), `HTML 标签要剥掉，正文仍参与扫描，实际：${found.map(c => c.call).join(' | ')}`);
    assert(!found.some(c => c.call.includes('<')), '候选里不该带标签片段');
});

/* ---------------- 一致性检查 ---------------- */

console.log('\n一致性检查');
check('登记了但聊天里从没出现过 → 提示 unused', () => {
    const s = mod.emptyChatState();
    s.relations[mod.relationKey(USER_KEY, BAILU)] = { call: '从没喊过的称呼', aliases: [], stage: '', note: '' };
    const issues = mod.lintRelations({ messages: soloMessages, participants: mod.buildParticipants(hostSolo), chatState: s, library: null, limit: 40 });
    assert(issues.some(i => i.code === 'unused'), '应报 unused');
});
check('登记值与高频候选不一致 → 提示 conflict', () => {
    const s = mod.emptyChatState();
    s.relations[mod.relationKey(USER_KEY, BAILU)] = { call: '白鹭', aliases: [], stage: '', note: '' };
    const issues = mod.lintRelations({ messages: groupMessages, participants: mod.buildParticipants(hostGroup), chatState: s, library: null, limit: 40 });
    const conflict = issues.find(i => i.code === 'conflict');
    assert(conflict, `应报 conflict，实际：${JSON.stringify(issues)}`);
    assertEqual(conflict.candidate, '白鹭姐');
});

/* ---------------- 导入导出 ---------------- */

console.log('\n导入导出');
check('导出后重新导入，本聊天关系不丢', () => {
    const bundle = mod.exportBundle({ chatState: state, library, settings: mod.defaultSettings() });
    const text = JSON.stringify(bundle);
    const back = mod.importBundle(text);
    assertEqual(Object.keys(back.chat.relations).sort(), Object.keys(state.relations).sort());
    assertEqual(back.chat.relations[mod.relationKey(BAILU, USER_KEY)].call, '陆哥');
    assertEqual(Object.keys(back.library).length, 1);
});
check('裸对象（只有 relations）也能导入', () => {
    const back = mod.importBundle({ relations: { [mod.relationKey(USER_KEY, BAILU)]: { call: '白鹭姐' } } });
    assertEqual(back.chat.relations[mod.relationKey(USER_KEY, BAILU)].call, '白鹭姐');
});
check('非法 JSON 会抛出可读错误', () => {
    let threw = false;
    try {
        mod.importBundle('{ not json');
    } catch (error) {
        threw = true;
        assertIncludes(error.message, '合法 JSON');
    }
    assert(threw, '应抛错');
});

/* ---------------- 设置归一化 ---------------- */

console.log('\n设置归一化');
check('缺字段补默认值，越界值被夹回合法范围', () => {
    const s = mod.normalizeSettings({ inject: { depth: -5, position: 99, role: 7, maxChars: 1, targets: 'nope' }, scan: { limit: 9999 } });
    assertEqual(s.inject.depth, 0);
    assertEqual(s.inject.position, 1);
    assertEqual(s.inject.role, 0);
    assertEqual(s.inject.maxChars, 200);
    assertEqual(s.inject.targets, 'all');
    assertEqual(s.scan.limit, 500);
});
check('用户自定义的未知设置项被保留', () => {
    const s = mod.normalizeSettings({ myCustomFlag: true, inject: {} });
    assertEqual(s.myCustomFlag, true);
});

/* ---------------- 正文提取 ---------------- */

console.log('\n正文提取 · 切块');

// 说明：chunkText 的最小块长是 200（防止有人把块切得比一次请求还碎），
// 所以测试正文必须够长，才能切出多块。
const NOVEL_LINE = '白鹭推门进来，看见星野正坐在窗边。“小星星，你怎么来了？”白鹭笑着问。星野抬头：“陆哥让我来的。”白鹭愣了愣。她很少听星野这么称呼小陆。“陆哥今天不在。”白鹭说，“你先坐。”';
const NOVEL = NOVEL_LINE.repeat(6);

check('按字数切块，块之间留重叠', () => {
    const chunks = mod.chunkText(NOVEL, { chunkChars: 200, overlapChars: 10, maxChunks: 20 });
    assert(chunks.length >= 3, `应该切成多块，实际 ${chunks.length}`);
    assertEqual(chunks[0].start, 0);
    assert(chunks[0].text.length <= 200, '每块不超过设定字数');
    for (let i = 1; i < chunks.length; i += 1) {
        assertEqual(chunks[i].start, chunks[i - 1].end - 10, `第 ${i} 块应与上一块重叠 10 字`);
    }
    assertEqual(chunks[chunks.length - 1].end, NOVEL.length, '最后一块应覆盖到结尾');
});
check('maxChunks 生效，不会无限切', () => {
    assertEqual(mod.chunkText(NOVEL, { chunkChars: 200, overlapChars: 0, maxChunks: 2 }).length, 2);
});
check('startOffset 支持小说分几次跑', () => {
    const chunks = mod.chunkText(NOVEL, { chunkChars: 200, overlapChars: 0, maxChunks: 2, startOffset: 50 });
    assertEqual(chunks[0].start, 50);
});
check('空文本切出 0 块；起始位置超长也切出 0 块', () => {
    assertEqual(mod.chunkText('', {}).length, 0);
    assertEqual(mod.chunkText('短文本', { startOffset: 999 }).length, 0);
});
check('overlap 大于块长时不会死循环', () => {
    const chunks = mod.chunkText(NOVEL, { chunkChars: 200, overlapChars: 999, maxChunks: 5 });
    assert(chunks.length > 0 && chunks.length <= 5, `应正常结束，实际 ${chunks.length} 块`);
});

console.log('\n正文提取 · 提示词与解析');

check('系统提示词要求纯 JSON，并禁止把真名当称呼', () => {
    const sys = mod.extractSystemPrompt();
    assertIncludes(sys, 'JSON');
    assertIncludes(sys, '真名本身不算称呼');
});
check('用户提示词带上块序号和原文', () => {
    const prompt = mod.extractUserPrompt({ text: '白鹭笑了。' }, 1, 5);
    assertIncludes(prompt, '第 2 / 5 块');
    assertIncludes(prompt, '白鹭笑了。');
});
check('解析标准 JSON 输出', () => {
    const raw = JSON.stringify({ appellations: [{ from: '白鹭', to: '星野', call: '小星星', evidence: '“小星星，你怎么来了？”', confidence: 0.9 }] });
    const parsed = mod.parseExtractResponse(raw);
    assertEqual(parsed.error, null);
    assertEqual(parsed.items.length, 1);
    assertEqual(parsed.items[0].call, '小星星');
});
check('模型多写了寒暄或 ``` 围栏也能挖出 JSON', () => {
    const raw = '好的，分析如下：\n```json\n{"appellations":[{"from":"星野","to":"小陆","call":"陆哥"}]}\n```\n希望有帮助。';
    const parsed = mod.parseExtractResponse(raw);
    assertEqual(parsed.error, null);
    assertEqual(parsed.items[0].call, '陆哥');
});
check('直接返回数组也能解析', () => {
    const parsed = mod.parseExtractResponse('[{"from":"A","to":"B","call":"老弟"}]');
    assertEqual(parsed.items[0].call, '老弟');
});
check('空响应 / 非 JSON 都给可读错误而不是抛异常', () => {
    assertIncludes(mod.parseExtractResponse('').error, '空内容');
    assertIncludes(mod.parseExtractResponse('我不知道').error, 'JSON');
});
check('无结果时返回空数组而不是报错', () => {
    const parsed = mod.parseExtractResponse('{"appellations":[]}');
    assertEqual(parsed.error, null);
    assertEqual(parsed.items, []);
});
check('脏条目被丢掉：缺字段、自指、标点当称呼、超长', () => {
    const parsed = mod.parseExtractResponse(JSON.stringify({
        appellations: [
            { from: 'A', to: 'B', call: '' },
            { from: 'A', to: 'A', call: '自己' },
            { from: 'A', to: 'B', call: '，。！' },
            { from: 'A', to: 'B', call: '甲'.repeat(40) },
            { from: 'A', to: 'B', call: '老弟' },
        ],
    }));
    assertEqual(parsed.items.length, 1);
    assertEqual(parsed.items[0].call, '老弟');
});

console.log('\n正文提取 · 合并与映射');

const chunkA = [{ from: '白鹭', to: '星野', call: '小星星', evidence: 'e1', confidence: 0.9 }];
const chunkB = [
    { from: '白鹭', to: '星野', call: '小星星', evidence: 'e2', confidence: 0.8 },
    { from: '星野', to: '小陆', call: '陆哥', evidence: 'e3', confidence: 0.95 },
];

check('同一条关系跨块合并，累加命中块数并留多条证据', () => {
    const merged = mod.mergeExtractResults([chunkA, chunkB]);
    const hit = merged.find(m => m.call === '小星星');
    assertEqual(hit.count, 2);
    assertEqual(hit.evidence.length, 2);
    assertEqual(merged[0].call, '小星星', '默认按命中次数降序');
});
check('名字按出现次数收集', () => {
    const names = mod.collectNames(mod.mergeExtractResults([chunkA, chunkB]));
    assertEqual(names[0], '星野');
});
check('同名角色自动映射到参与者', () => {
    const mapping = mod.autoMapNames(['白鹭', '星野'], mod.buildParticipants(hostSolo));
    assertEqual(mapping['白鹭'], BAILU);
    assertEqual(mapping['星野'], null, '单聊里没有星野，应留空等人工指定');
});
check('代词一律不自动映射（小说里的「我」多半是主角）', () => {
    const mapping = mod.autoMapNames(['我', '你', '他'], mod.buildParticipants(hostSolo));
    assertEqual(mapping['我'], null);
    assertEqual(mapping['你'], null);
    assertEqual(mapping['他'], null);
});
check('映射不上的行在落表时被丢弃，不猜', () => {
    const patches = mod.buildPatches(chunkB, { 白鹭: BAILU, 星野: XINGYE, 小陆: null });
    assertEqual(patches.length, 1, '只有 白鹭→星野 能落');
    assertEqual(patches[0].call, '小星星');
});
check('同一对的多个称呼：出现最多的当主称呼，其余降为别名', () => {
    const relations = mod.patchesToRelations([
        { from: BAILU, to: USER_KEY, call: '陆哥', count: 5 },
        { from: BAILU, to: USER_KEY, call: '小陆', count: 3 },
        { from: BAILU, to: USER_KEY, call: '阿陆', count: 1 },
    ]);
    assertEqual(relations.length, 1);
    assertEqual(relations[0].call, '陆哥');
    assertEqual(relations[0].aliases, ['小陆', '阿陆']);
});
check('一条命令把提取结果写进称呼关系表', () => {
    const results = mod.mergeExtractResults([chunkA, chunkB]);
    const next = mod.applyExtractToChatState(mod.emptyChatState(), results, { 白鹭: BAILU, 星野: XINGYE, 小陆: USER_KEY });
    assertEqual(mod.getRelation(next, BAILU, XINGYE).call, '小星星');
    assertEqual(mod.getRelation(next, XINGYE, USER_KEY).call, '陆哥');
});
check('提取设置也能被夹到合法范围', () => {
    const s = mod.normalizeSettings({ extract: { mode: '乱写', chunkChars: 5, maxChunks: 9999, temperature: 9, custom: { baseUrl: '  x  ' } } });
    assertEqual(s.extract.mode, 'st');
    assertEqual(s.extract.chunkChars, 200);
    assertEqual(s.extract.maxChunks, 500);
    assertEqual(s.extract.temperature, 2);
    assertEqual(s.extract.custom.baseUrl, 'x');
});

/* ---------------- 小说称呼库 ---------------- */

console.log('\n小说称呼库');

const NOVEL_RESULTS = [
    { from: '白鹭', to: '星野', call: '小星星', evidence: 'e1', confidence: 0.9, count: 5 },
    { from: '白鹭', to: '星野', call: '星星', evidence: 'e2', confidence: 0.7, count: 2 },
    { from: '星野', to: '小陆', call: '陆哥', evidence: 'e3', confidence: 0.95, count: 8 },
];

check('新建小说拿到唯一 id 和默认名', () => {
    const a = mod.createNovel('白鹭传');
    const b = mod.createNovel();
    assertEqual(a.name, '白鹭传');
    assert(a.id !== b.id, 'id 不能重复');
    assertEqual(a.results, []);
});
check('归一化会丢掉重复条目和空条目', () => {
    const novel = mod.normalizeNovel({
        name: '测试',
        results: [...NOVEL_RESULTS, NOVEL_RESULTS[0], { from: 'A', to: 'B', call: '' }, { from: 'C', to: 'C', call: '自己' }],
    });
    assertEqual(novel.results.length, 3, '重复的和空的都该去掉');
});
check('小说库归一化：activeId 指向不存在的小说时自动落到第一部', () => {
    const one = mod.createNovel('一');
    const store = mod.normalizeNovels({ items: { [one.id]: one }, activeId: '不存在的id' });
    assertEqual(store.activeId, one.id);
});
check('空库的 activeId 是 null', () => {
    assertEqual(mod.normalizeNovels(null).activeId, null);
});
check('列小说按更新时间倒序', () => {
    const one = mod.normalizeNovel({ id: 'a', name: '旧', updatedAt: 100 });
    const two = mod.normalizeNovel({ id: 'b', name: '新', updatedAt: 200 });
    assertEqual(mod.listNovels({ items: { a: one, b: two } }).map(n => n.name), ['新', '旧']);
});

check('称呼表：同对的多个称呼，命中多的当主称呼，其余是别名', () => {
    const table = mod.buildNovelTable(NOVEL_RESULTS);
    const pair = table.find(r => r.from === '白鹭' && r.to === '星野');
    assertEqual(pair.call, '小星星');
    assertEqual(pair.aliases, ['星星']);
    assertEqual(pair.count, 5);
    assertEqual(pair.variants.map(v => v.call), ['小星星', '星星']);
});
check('称呼表按命中次数排序，最常用的排最前', () => {
    const table = mod.buildNovelTable(NOVEL_RESULTS);
    assertEqual(table[0].call, '陆哥', '命中 8 次的该排第一');
});
check('称呼表不依赖聊天参与者（小说里没有的角色照样在表里）', () => {
    const table = mod.buildNovelTable([{ from: '路人甲', to: '路人乙', call: '老乙', count: 1, confidence: 0.8 }]);
    assertEqual(table.length, 1);
    assertEqual(table[0].from, '路人甲');
});
check('称呼表能转成可粘贴的 Markdown 表格', () => {
    const text = mod.novelTableToText(mod.buildNovelTable(NOVEL_RESULTS));
    const lines = text.split('\n');
    assertEqual(lines.length, 4, `表头 + 分隔 + 2 对关系，实际 ${lines.length}`);
    assertIncludes(lines[0], '| 称呼方 | 被称呼方 | 称呼 | 别名 | 命中 |');
    assertIncludes(text, '| 白鹭 | 星野 | 小星星 | 星星 | 5 |');
});
check('证据带换行和竖线时不会撑坏表格', () => {
    const text = mod.novelTableToText(
        mod.buildNovelTable([{ from: 'A', to: 'B', call: '老弟', count: 1, evidence: '第一行\n第二行|带竖线' }]),
        { withEvidence: true },
    );
    assertEqual(text.split('\n').length, 3, '证据里的换行必须被洗掉');
    assertIncludes(text, '第一行 第二行 带竖线');
});
check('空表转出空串，不产出半个表格', () => {
    assertEqual(mod.novelTableToText([]), '');
});
check('原著称呼表能压成提示词片段，并在超长时说明', () => {
    const novel = mod.normalizeNovel({ name: '白鹭传', results: NOVEL_RESULTS });
    const block = mod.composeNovelPromptBlock(novel, { maxChars: 3000 });
    assertIncludes(block, '白鹭传');
    assertIncludes(block, '白鹭 → 星野：小星星（别名：星星）');
    // maxChars 的下限是 200，所以要超长得靠表本身够大
    const big = mod.normalizeNovel({
        name: '长篇',
        results: Array.from({ length: 40 }, (_, i) => ({ from: `甲${i}`, to: `乙${i}`, call: `称呼${i}`, count: 1 })),
    });
    const tiny = mod.composeNovelPromptBlock(big, { maxChars: 200 });
    assertIncludes(tiny, '因长度限制未列出');
    assert(tiny.length <= 200 + 40, `截断后应接近上限，实际 ${tiny.length}`);
});
check('没有称呼的小说压出空串（不注入空内容）', () => {
    assertEqual(mod.composeNovelPromptBlock(mod.createNovel('空'), {}), '');
});
check('单部小说能单独导出再导入', () => {
    const novel = mod.normalizeNovel({ name: '白鹭传', results: NOVEL_RESULTS });
    const bundle = mod.exportNovel(novel);
    assertEqual(bundle.type, 'st-appellation-manager/novel');
    assertEqual(bundle.novel.table.length, 2, '导出时附上整理好的称呼表');
    const back = mod.importBundle(JSON.stringify(bundle));
    assertEqual(back.novel.name, '白鹭传');
    assertEqual(back.novel.results.length, 3);
    assertEqual(back.chat, null, '单部小说导入不该顺手造一个聊天状态');
});
check('小说库能随完整 bundle 一起备份还原', () => {
    const novel = mod.normalizeNovel({ name: '白鹭传', results: NOVEL_RESULTS });
    const settings = mod.normalizeSettings({ novels: { items: { [novel.id]: novel }, activeId: novel.id } });
    const bundle = mod.exportBundle({ chatState: mod.emptyChatState(), library: {}, settings });
    const back = mod.importBundle(JSON.stringify(bundle));
    assertEqual(Object.keys(back.novels.items).length, 1);
    assertEqual(back.novels.activeId, novel.id);
    assertEqual(back.novels.items[novel.id].results.length, 3);
});

check('映射存在聊天里，且能随聊天导出导入', () => {
    const state = mod.normalizeChatState({ novelMapping: { novel_1: { 白鹭: BAILU, 我: null, '': 'x' } } });
    assertEqual(state.novelMapping.novel_1['白鹭'], BAILU);
    assertEqual(state.novelMapping.novel_1['我'], null);
    assert(!('' in state.novelMapping.novel_1), '空名字该被丢掉');
    const bundle = mod.exportBundle({ chatState: state, library: {}, settings: mod.defaultSettings() });
    const back = mod.importBundle(JSON.stringify(bundle));
    assertEqual(back.chat.novelMapping.novel_1['白鹭'], BAILU);
});
check('同一部小说用到不同聊天时，映射各自独立（不串味）', () => {
    const novel = mod.normalizeNovel({ name: '白鹭传', results: NOVEL_RESULTS });
    const chatA = mod.normalizeChatState({ novelMapping: { [novel.id]: { 白鹭: BAILU } } });
    const chatB = mod.normalizeChatState({});
    assertEqual(chatA.novelMapping[novel.id]['白鹭'], BAILU);
    assertEqual(chatB.novelMapping[novel.id], undefined);
});

/* ---------------- 放射状关系图 ---------------- */

console.log('\n放射状关系图');

const graphParticipants = mod.buildParticipants(hostGroup); // 小陆 / 白鹭 / 星野
const graphState = (() => {
    let s = mod.emptyChatState();
    s = mod.setRelation(s, BAILU, XINGYE, { call: '小星星' });      // 白鹭 → 星野
    s = mod.setRelation(s, XINGYE, USER_KEY, { call: '陆哥' });     // 星野 → 小陆
    s = mod.setRelation(s, USER_KEY, BAILU, { call: '小白' });      // 小陆 → 白鹭
    return s;
})();

check('圆心默认为第一个参与者；指定了就按指定的来', () => {
    assertEqual(mod.buildRelationGraph({ participants: graphParticipants }).center.key, USER_KEY);
    assertEqual(mod.buildRelationGraph({ participants: graphParticipants, centerKey: BAILU }).center.key, BAILU);
});
check('没有参与者时返回空图，不抛错', () => {
    const graph = mod.buildRelationGraph({ participants: [] });
    assertEqual(graph.center, null);
    assertEqual(graph.spokes, []);
});
check('以白鹭为圆心：辐射出小陆和星野，方向不串', () => {
    const graph = mod.buildRelationGraph({ participants: graphParticipants, chatState: graphState, centerKey: BAILU });
    assertEqual(graph.spokes.map(s => s.name).sort(), ['小陆', '星野']);

    const toXingye = graph.spokes.find(s => s.name === '星野');
    assertEqual(toXingye.outward.call, '小星星', '白鹭 → 星野 应该是「小星星」');
    assertEqual(toXingye.inward, null, '星野没这么叫过白鹭，应该是空');

    const toUser = graph.spokes.find(s => s.name === '小陆');
    assertEqual(toUser.outward, null, '白鹭没这么叫过小陆');
});
check('双向都有称呼时两个方向都带上', () => {
    let s = graphState;
    s = mod.setRelation(s, XINGYE, BAILU, { call: '白鹭姐' });
    const graph = mod.buildRelationGraph({ participants: graphParticipants, chatState: s, centerKey: BAILU });
    const toXingye = graph.spokes.find(sp => sp.name === '星野');
    assertEqual(toXingye.outward.call, '小星星');
    assertEqual(toXingye.inward.call, '白鹭姐');
});
check('外围之间的称呼会画成弦（角色不多时）', () => {
    const graph = mod.buildRelationGraph({ participants: graphParticipants, chatState: graphState, centerKey: BAILU });
    assertEqual(graph.chords.length, 1, '星野 → 小陆 这条该出现');
    assertEqual(graph.chords[0].bToA.call, '陆哥');
    assertEqual(graph.chords[0].aToB, null);
});
check('角色太多时不画弦，但如实报出省掉了几条', () => {
    const many = [{ key: USER_KEY, name: '我', kind: 'user' }];
    for (let i = 0; i < 7; i += 1) many.push({ key: `char:c${i}`, name: `角色${i}`, kind: 'character' });
    let s = mod.emptyChatState();
    s = mod.setRelation(s, 'char:c1', 'char:c2', { call: '甲' });
    s = mod.setRelation(s, 'char:c3', 'char:c4', { call: '乙' });
    const graph = mod.buildRelationGraph({ participants: many, chatState: s, centerKey: USER_KEY });
    assertEqual(graph.chords.length, 0);
    assertEqual(graph.chordsSkipped, 2, '该如实说有两对没画');
});
check('全局默认库里的称呼也算数（标出来源是库）', () => {
    const library = { [mod.relationKey(BAILU, XINGYE)]: { call: '星星', aliases: [], stage: '', note: '' } };
    const graph = mod.buildRelationGraph({ participants: graphParticipants, library, centerKey: BAILU });
    const toXingye = graph.spokes.find(s => s.name === '星野');
    assertEqual(toXingye.outward.call, '星星');
    assertEqual(toXingye.outward.source, 'library');
});
check('小说称呼表能喂给同一个图：键加前缀、方向正确', () => {
    const table = mod.buildNovelTable(NOVEL_RESULTS);
    const input = mod.novelGraphInput(table);
    assertEqual(input.participants.map(p => p.name).sort(), ['小陆', '星野', '白鹭']);
    assertEqual(input.participants.every(p => p.key.startsWith('name:')), true);

    const graph = mod.buildRelationGraph({ ...input, centerKey: 'name:白鹭' });
    const toXingye = graph.spokes.find(s => s.name === '星野');
    assertEqual(toXingye.outward.call, '小星星');
    assertEqual(toXingye.inward, null);
    // 星野 → 小陆 是外围两人的关系，走弦
    const toXiaolu = graph.spokes.find(s => s.name === '小陆');
    assertEqual(toXiaolu.outward, null);
    assertEqual(toXiaolu.inward, null);
    assertEqual(graph.chords.length, 1);
    assertEqual(graph.chords[0].aName, '星野');
    assertEqual(graph.chords[0].bName, '小陆');
    assertEqual(graph.chords[0].aToB.call, '陆哥');
    assertEqual(graph.chords[0].bToA, null);
});
check('空表喂进去得到空图，不抛错', () => {
    const input = mod.novelGraphInput([]);
    assertEqual(input.participants, []);
    assertEqual(mod.buildRelationGraph(input).center, null);
});

console.log('\n关系图几何（这部分看不到渲染，只能靠算）');

const G = mod.GRAPH_GEOMETRY;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

check('外围节点均匀排布，且都落在 0–100 的框里', () => {
    for (const count of [1, 2, 3, 4, 5, 8]) {
        const ring = mod.graphLayout(count);
        assertEqual(ring.length, count);
        for (const p of ring) {
            assert(Math.abs(dist(p, { x: G.cx, y: G.cy }) - G.radius) < 1e-9, `半径应为 ${G.radius}`);
            assert(p.x > 0 && p.x < 100 && p.y > 0 && p.y < 100, `越界：${JSON.stringify(p)}`);
        }
        // 彼此不能重合
        for (let i = 0; i < ring.length; i += 1) {
            for (let j = i + 1; j < ring.length; j += 1) {
                assert(dist(ring[i], ring[j]) > 1, '节点重合了');
            }
        }
    }
});
check('第一个节点在正上方，四个节点分别在上右下左', () => {
    assert(Math.abs(mod.graphLayout(1)[0].x - G.cx) < 1e-9, '单节点应在正上方');
    assert(mod.graphLayout(1)[0].y < G.cy, '单节点应在圆心上方');
    const four = mod.graphLayout(4);
    assert(Math.abs(four[0].x - G.cx) < 1e-9 && four[0].y < G.cy, '第 0 个在上');
    assert(four[1].x > G.cx && Math.abs(four[1].y - G.cy) < 1e-9, '第 1 个在右');
    assert(Math.abs(four[2].x - G.cx) < 1e-9 && four[2].y > G.cy, '第 2 个在下');
    assert(four[3].x < G.cx && Math.abs(four[3].y - G.cy) < 1e-9, '第 3 个在左');
});
check('两个方向的标签分居连线两侧，不会叠在一起', () => {
    const from = { x: G.cx, y: G.cy };
    for (const to of mod.graphLayout(6)) {
        const { outward, inward } = mod.graphSpokeLabels(from, to, G);
        assert(dist(outward, inward) > G.labelOffset, '两个标签挨太近了');
        // 分别在连线的两侧：到直线的有符号距离应反号
        const vx = to.x - from.x;
        const vy = to.y - from.y;
        const side = p => vx * (p.y - from.y) - vy * (p.x - from.x);
        assert(side(outward) * side(inward) < 0, '两个标签应各在连线一侧');
    }
});
check('标签离圆心够远，不会被圆心那个节点压住', () => {
    for (const to of mod.graphLayout(8)) {
        const { outward, inward } = mod.graphSpokeLabels({ x: G.cx, y: G.cy }, to, G);
        // 圆心节点最大宽度 26% → 半宽 13%，标签至少要在 13% 之外
        assert(dist(outward, { x: G.cx, y: G.cy }) > 13, '外向标签离圆心太近');
        assert(dist(inward, { x: G.cx, y: G.cy }) > 13, '内向标签离圆心太近');
        assert(outward.x > 0 && outward.x < 100 && inward.x > 0 && inward.x < 100, '标签横向越界');
    }
});
check('标签不会压到任何一个节点方框上（斜向辐条最容易出问题）', () => {
    const outside = (p, c, hw, hh) => Math.abs(p.x - c.x) > hw || Math.abs(p.y - c.y) > hh;
    for (const count of [1, 2, 3, 4, 5, 6, 8, 12]) {
        const from = { x: G.cx, y: G.cy };
        for (const to of mod.graphLayout(count)) {
            const { outward, inward } = mod.graphSpokeLabels(from, to, G);
            for (const label of [outward, inward]) {
                assert(outside(label, from, G.nodeHalfWidth, G.centerHalfHeight),
                    `标签压住圆心节点：count=${count} label=${JSON.stringify(label)}`);
                assert(outside(label, to, G.nodeHalfWidth, G.nodeHalfHeight),
                    `标签压住外围节点：count=${count} label=${JSON.stringify(label)}`);
            }
        }
    }
});
check('弦的控制点把弧线推离圆心', () => {
    const ring = mod.graphLayout(4);
    const { mid, control } = mod.graphChordControl(ring[0], ring[2], G);
    assert(dist(mid, { x: G.cx, y: G.cy }) < 1, '上下的中点本来就该在圆心附近');
    assert(dist(control, { x: G.cx, y: G.cy }) > G.chordBulge * 0.9, '正对时该往侧面鼓出去');
});
check('不相邻的两个外围节点，弧线朝外鼓', () => {
    const ring = mod.graphLayout(3);
    const a = ring[0];
    const b = ring[1];
    const { mid, control } = mod.graphChordControl(a, b, G);
    assert(dist(control, { x: G.cx, y: G.cy }) > dist(mid, { x: G.cx, y: G.cy }), '控制点应比中点更远离圆心');
});

/* ---------------- 小说 txt 编码识别 ---------------- */

console.log('\n小说 txt 编码识别');

const encode = (text, encoding) => {
    // 只用来生成测试字节；Node 的 TextEncoder 只支持 utf-8，其余手写
    if (encoding === 'utf-8') return new TextEncoder().encode(text);
    if (encoding === 'utf-16le') {
        const bytes = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i += 1) {
            const code = text.charCodeAt(i);
            bytes[i * 2] = code & 0xFF;
            bytes[i * 2 + 1] = code >> 8;
        }
        return bytes;
    }
    throw new Error(`测试没实现 ${encoding}`);
};

check('正常 UTF-8 直接认出来', () => {
    const result = mod.decodeTextBuffer(encode('白鹭看着星野。', 'utf-8'));
    assertEqual(result.text, '白鹭看着星野。');
    assertEqual(result.encoding, 'UTF-8');
});
check('UTF-8 BOM 会被剥掉，不留下看不见的字符', () => {
    const raw = encode('白鹭', 'utf-8');
    const withBom = new Uint8Array([0xEF, 0xBB, 0xBF, ...raw]);
    const result = mod.decodeTextBuffer(withBom);
    assertEqual(result.text, '白鹭');
    assertEqual(result.encoding, 'UTF-8 (BOM)');
});
check('UTF-16 LE 带 BOM 能读', () => {
    const raw = encode('白鹭', 'utf-16le');
    const withBom = new Uint8Array([0xFF, 0xFE, ...raw]);
    const result = mod.decodeTextBuffer(withBom);
    assertEqual(result.text, '白鹭');
    assertEqual(result.encoding, 'UTF-16 LE');
});
check('GBK 小说不会变成满屏乱码（关键：不能落回 UTF-8）', () => {
    // GBK 字节：白 潞 —— 这不是合法 UTF-8，正好用来验证回退
    const gbk = new Uint8Array([0xB0, 0xD7, 0xC2, 0xBA]);
    const result = mod.decodeTextBuffer(gbk);
    assertEqual(result.encoding, 'gb18030');
    assertEqual(result.text, new TextDecoder('gb18030').decode(gbk));
    assert(!result.text.includes('\uFFFD'), '不该出现替换字符');
    // 反证：直接当 UTF-8 读确实会坏
    assert(new TextDecoder('utf-8').decode(gbk).includes('\uFFFD'), 'UTF-8 读这串本来就该坏，测试前提成立');
});
check('空文件不抛错，返回空文本', () => {
    const result = mod.decodeTextBuffer(new Uint8Array([]));
    assertEqual(result.text, '');
});
check('传 null / undefined 也不炸', () => {
    assertEqual(mod.decodeTextBuffer(null).text, '');
    assertEqual(mod.decodeTextBuffer(undefined).text, '');
});

/* ---------------- 设置对象身份必须稳定 ---------------- */

console.log('\n设置对象稳定性（「接口成功但界面空」的根因）');

check('归一化出来的对象回传时原样返回（store 里放的就是它）', () => {
    const cache = mod.createSettingsCache();
    const a = cache.get({ inject: { depth: 3 } });
    const b = cache.get(a);   // store 里存的就是 a，下一次读必须原样拿回
    assert(a === b, '回传自己产出的对象必须是同一个实例，否则 await 期间的引用会变孤儿');
    assertEqual(b.inject.depth, 3, '归一化值要保留');
});
check('写回 store 之后再读，拿到的还是同一个实例', () => {
    // 归一化会造新对象并写回 store，下一次读必须认出它，否则每次读都换实例
    const store = { settings: undefined };
    const cache = mod.createSettingsCache();
    const read = () => {
        const cached = cache.get(store.settings);
        if (store.settings !== cached) store.settings = cached;
        return cached;
    };
    const a = read();
    const b = read();
    assert(a === b, '第二次读不该再造一个新对象');
});
check('外部换了源对象时会重新归一化', () => {
    const cache = mod.createSettingsCache();
    const a = cache.get({ inject: { depth: 3 } });
    const b = cache.get({ inject: { depth: 9 } });
    assert(a !== b, '换了源对象就该重新归一化');
    assertEqual(b.inject.depth, 9);
});
check('reset 之后重新归一化', () => {
    const cache = mod.createSettingsCache();
    const raw = {};
    const a = cache.get(raw);
    cache.reset();
    assert(a !== cache.get(raw), 'reset 后应重新构造');
});
check('回归：await 期间别处读过设置，写回的值不会丢', () => {
    // 复现线上那个 bug：拉取过程中间渲染了一次，设置对象被换掉，写回写到孤儿上
    const store = { settings: undefined };
    const cache = mod.createSettingsCache();
    const readSettings = () => {
        const cached = cache.get(store.settings);
        if (store.settings !== cached) store.settings = cached;
        return cached;
    };

    const held = readSettings();                    // 拉取开始：抓住引用
    readSettings();                                 // 拉取途中：别处又读了一次（就是那次渲染）

    held.extract.custom = {                          // 往手里的引用写
        ...held.extract.custom,
        baseUrl: 'https://x/v1',
        model: 'm',
        apiKey: '',
        models: ['m1', 'm2'],
        noChat: [],
    };

    const seen = readSettings();
    assertEqual(seen.extract.custom.models, ['m1', 'm2'], '写进去的模型列表必须还能读到');
    assert(seen === held, '同一份设置应始终是同一个实例');
});

/* ---------------- 汇总 ---------------- */

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
    for (const f of failures) console.error(`\n[${f.name}]\n${f.error.stack}`);
    process.exitCode = 1;
}
