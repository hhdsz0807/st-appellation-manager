/**
 * core.js 离线自测（不依赖酒馆、不依赖浏览器）。
 * 运行：node test-core.mjs
 *
 * core.js 是纯逻辑，没有任何相对导入，所以这里用 data: URL 直接当模块加载，
 * 不需要额外装包或改 package.json。
 */

import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./core.js', import.meta.url), 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);

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

/* ---------------- 汇总 ---------------- */

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
    for (const f of failures) console.error(`\n[${f.name}]\n${f.error.stack}`);
    process.exitCode = 1;
}
