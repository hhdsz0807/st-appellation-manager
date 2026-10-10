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
check('提取结果能随聊天一起导出导入', () => {
    const results = mod.mergeExtractResults([chunkB]);
    const state = mod.applyExtractToChatState(mod.emptyChatState(), results, { 白鹭: BAILU, 星野: XINGYE });
    state.extract = mod.normalizeExtractState({ ...state.extract, results, mapping: { 白鹭: BAILU, 星野: XINGYE } });
    const bundle = mod.exportBundle({ chatState: state, library: {}, settings: mod.defaultSettings() });
    const back = mod.importBundle(JSON.stringify(bundle));
    assertEqual(back.chat.extract.results.length, results.length);
    assertEqual(back.chat.extract.mapping['白鹭'], BAILU);
});
check('提取设置也能被夹到合法范围', () => {
    const s = mod.normalizeSettings({ extract: { mode: '乱写', chunkChars: 5, maxChunks: 9999, temperature: 9, custom: { baseUrl: '  x  ' } } });
    assertEqual(s.extract.mode, 'st');
    assertEqual(s.extract.chunkChars, 200);
    assertEqual(s.extract.maxChunks, 500);
    assertEqual(s.extract.temperature, 2);
    assertEqual(s.extract.custom.baseUrl, 'x');
});

/* ---------------- 汇总 ---------------- */

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
    for (const f of failures) console.error(`\n[${f.name}]\n${f.error.stack}`);
    process.exitCode = 1;
}
