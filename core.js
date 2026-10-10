/**
 * 称呼管理器 · 纯逻辑层
 *
 * 本文件不依赖 SillyTavern、DOM、jQuery 或任何外部模块，只做数据模型 + 纯函数。
 * 目的：让「关系表怎么存、提示词怎么拼、候选怎么扫」这三件事可以脱离酒馆单独测试，
 *      也避免把宿主 API 混进数据处理里。
 *
 * 外部只通过 index.js 调用本文件的导出函数。
 */

export const EXT_ID = 'st-appellation-manager';
export const SCHEMA_VERSION = 1;

/** 用户（persona）在关系表里的固定键。角色键统一为 `char:<avatar文件名>`。 */
export const USER_KEY = '__user__';

/** 关系键分隔符：`<源键>=><目标键>` */
const SEP = '=>';

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

export function relationKey(fromKey, toKey) {
    return `${String(fromKey)}${SEP}${String(toKey)}`;
}

export function parseRelationKey(key) {
    const idx = String(key ?? '').indexOf(SEP);
    if (idx < 0) return null;
    return { from: key.slice(0, idx), to: key.slice(idx + SEP.length) };
}

function uniq(list) {
    return [...new Set(list)];
}

function str(value) {
    return value === null || value === undefined ? '' : String(value);
}

/* ------------------------------------------------------------------ *
 * 数据结构与归一化
 * ------------------------------------------------------------------ */

function normalizeAliasList(value) {
    if (Array.isArray(value)) {
        return value.map(v => str(v).trim()).filter(Boolean);
    }
    return str(value).split(/[,，、;；|\s]+/u).map(s => s.trim()).filter(Boolean);
}

/** 归一化单条关系；空关系返回 null（视为不存在）。 */
export function normalizeRelation(value) {
    if (!value || typeof value !== 'object') return null;
    const call = str(value.call).trim();
    const aliases = uniq(normalizeAliasList(value.aliases).filter(a => a !== call));
    const stage = str(value.stage).trim();
    const note = str(value.note).trim();
    if (!call && !aliases.length && !stage && !note) return null;
    return { call, aliases, stage, note };
}

/** 归一化「本聊天」的称呼数据。未知字段会被丢弃，但不会因为脏数据抛错。 */
export function normalizeChatState(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const relations = {};
    const source = src.relations && typeof src.relations === 'object' && !Array.isArray(src.relations)
        ? src.relations
        : {};
    for (const [key, value] of Object.entries(source)) {
        if (!parseRelationKey(key)) continue;
        const entry = normalizeRelation(value);
        if (entry) relations[key] = entry;
    }
    return {
        version: SCHEMA_VERSION,
        relations,
        updatedAt: Number(src.updatedAt) || 0,
    };
}

export function emptyChatState() {
    return { version: SCHEMA_VERSION, relations: {}, updatedAt: 0 };
}

/** 归一化「全局默认」关系库。 */
export function normalizeLibrary(raw) {
    const relations = {};
    const src = raw && typeof raw === 'object' ? raw : {};
    for (const [key, value] of Object.entries(src)) {
        if (!parseRelationKey(key)) continue;
        const entry = normalizeRelation(value);
        if (entry) relations[key] = entry;
    }
    return relations;
}

/** 全局设置默认值。position / role 用数字，与酒馆的枚举取值对齐（见 README）。 */
export function defaultSettings() {
    return {
        version: SCHEMA_VERSION,
        inject: {
            enabled: true,
            position: 1,      // 0=主提示内 1=对话内(按深度) 2=主提示前
            depth: 4,
            role: 0,          // 0=system 1=user 2=assistant
            targets: 'all',   // all | user | focus
            includeAliases: true,
            includeStage: true,
            includeNote: false,
            header: true,
            fallbackRule: true,
            maxChars: 4000,
        },
        scan: {
            limit: 40,
            minCount: 1,
        },
        library: {},
    };
}

/** 合并式归一化设置：只补齐缺失项，不删掉用户已有的自定义值。 */
export function normalizeSettings(raw) {
    const base = defaultSettings();
    const src = raw && typeof raw === 'object' ? raw : {};
    const inject = { ...base.inject, ...(src.inject && typeof src.inject === 'object' ? src.inject : {}) };
    const scan = { ...base.scan, ...(src.scan && typeof src.scan === 'object' ? src.scan : {}) };
    inject.depth = clampInt(inject.depth, 0, 10000, base.inject.depth);
    inject.position = [0, 1, 2].includes(Number(inject.position)) ? Number(inject.position) : base.inject.position;
    inject.role = [0, 1, 2].includes(Number(inject.role)) ? Number(inject.role) : base.inject.role;
    inject.maxChars = clampInt(inject.maxChars, 200, 100000, base.inject.maxChars);
    inject.targets = ['all', 'user', 'focus'].includes(inject.targets) ? inject.targets : 'all';
    scan.limit = clampInt(scan.limit, 1, 500, base.scan.limit);
    scan.minCount = clampInt(scan.minCount, 1, 100, base.scan.minCount);
    return { ...base, ...src, inject, scan, library: normalizeLibrary(src.library) };
}

export function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ *
 * 参与者（用户 + 当前角色 / 群成员）
 * ------------------------------------------------------------------ */

/**
 * 从宿主上下文解析本次聊天的参与者。
 * host 需要提供：name1、characterId、characters、groupId、groups。
 */
export function buildParticipants(host) {
    const h = host && typeof host === 'object' ? host : {};
    const characters = Array.isArray(h.characters) ? h.characters : [];
    const groups = Array.isArray(h.groups) ? h.groups : [];
    const out = [];

    const userKey = USER_KEY;
    out.push({
        key: userKey,
        name: str(h.name1).trim() || '用户',
        kind: 'user',
        avatar: null,
    });

    const members = [];
    const groupId = h.groupId;
    if (groupId !== undefined && groupId !== null && groupId !== '') {
        const group = groups.find(g => str(g?.id) === str(groupId));
        for (const avatar of group?.members ?? []) {
            const found = characters.find(c => c?.avatar === avatar);
            if (found) members.push(found);
        }
    } else if (h.characterId !== undefined && h.characterId !== null && h.characterId !== '') {
        const found = characters[h.characterId];
        if (found) members.push(found);
    }

    for (const ch of members) {
        const avatar = str(ch?.avatar).trim();
        if (!avatar) continue;
        const key = `char:${avatar}`;
        if (out.some(p => p.key === key)) continue;
        out.push({
            key,
            name: str(ch?.name).trim() || avatar,
            kind: 'character',
            avatar,
        });
    }

    return out;
}

export function participantMap(participants) {
    const map = new Map();
    for (const p of participants ?? []) map.set(p.key, p);
    return map;
}

export function participantName(participants, key) {
    return participantMap(participants).get(key)?.name ?? key;
}

/** 当前「正在扮演」的角色键；单聊就是唯一角色，群聊取 name2 匹配到的那个。 */
export function focusParticipantKey(participants, name2 = '') {
    const chars = (participants ?? []).filter(p => p.kind === 'character');
    if (chars.length <= 1) return chars[0]?.key ?? null;
    const hit = chars.find(p => p.name === str(name2).trim());
    return hit?.key ?? chars[0]?.key ?? null;
}

/* ------------------------------------------------------------------ *
 * 关系读写（返回新对象，不改原状态）
 * ------------------------------------------------------------------ */

export function resolveRelation({ chatState, library, from, to }) {
    const key = relationKey(from, to);
    const chatHit = chatState?.relations?.[key];
    if (chatHit && (chatHit.call || chatHit.aliases?.length)) {
        return { key, relation: chatHit, source: 'chat' };
    }
    const libHit = library?.[key];
    if (libHit && (libHit.call || libHit.aliases?.length)) {
        return { key, relation: libHit, source: 'library' };
    }
    return null;
}

export function getRelation(state, from, to) {
    return state?.relations?.[relationKey(from, to)] ?? null;
}

/** 写入/更新一条关系。patch 里传空字符串可清空对应字段；整条变空则自动删除。 */
export function setRelation(state, from, to, patch) {
    const next = normalizeChatState(state);
    const key = relationKey(from, to);
    const merged = { ...(next.relations[key] ?? { call: '', aliases: [], stage: '', note: '' }), ...(patch ?? {}) };
    const normalized = normalizeRelation(merged);
    if (!normalized) {
        delete next.relations[key];
    } else {
        next.relations[key] = normalized;
    }
    next.updatedAt = Date.now();
    return next;
}

export function clearRelation(state, from, to) {
    const next = normalizeChatState(state);
    delete next.relations[relationKey(from, to)];
    next.updatedAt = Date.now();
    return next;
}

export function clearAllRelations(state) {
    const next = emptyChatState();
    next.updatedAt = Date.now();
    return next;
}

/** 找出参与者在场、但关系表里没有对应参与者的孤儿条目（角色被移出群/换卡后会出现）。 */
export function findOrphanRelations(state, participants) {
    const known = new Set((participants ?? []).map(p => p.key));
    const out = [];
    for (const [key, value] of Object.entries(state?.relations ?? {})) {
        const parsed = parseRelationKey(key);
        if (!parsed) continue;
        if (!known.has(parsed.from) || !known.has(parsed.to)) {
            out.push({ key, ...parsed, relation: value });
        }
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * 提示词拼接
 * ------------------------------------------------------------------ */

export function appellationText(hit, opts = {}) {
    const rel = hit?.relation;
    if (!rel) return '';
    return rel.call || rel.aliases?.[0] || '';
}

/**
 * 把称呼表压成一段注入文本。
 * opts：见 defaultSettings().inject；focusKey 用于 targets='focus'。
 */
export function composePromptBlock({ participants = [], chatState = null, library = null, opts = {}, focusKey = null } = {}) {
    const map = participantMap(participants);
    const targets = opts.targets ?? 'all';
    const lines = [];

    for (const from of participants) {
        for (const to of participants) {
            if (from.key === to.key) continue;
            if (targets === 'user' && from.kind !== 'user' && to.kind !== 'user') continue;
            if (targets === 'focus' && focusKey && from.key !== focusKey && to.key !== focusKey) continue;

            const hit = resolveRelation({ chatState, library, from: from.key, to: to.key });
            const call = appellationText(hit, opts);
            if (!call) continue;

            const extras = [];
            if (opts.includeAliases && hit.relation.aliases?.length) {
                extras.push(`别名：${hit.relation.aliases.join('、')}`);
            }
            if (opts.includeStage && hit.relation.stage) {
                extras.push(`关系：${hit.relation.stage}`);
            }
            if (opts.includeNote && hit.relation.note) {
                extras.push(`备注：${hit.relation.note}`);
            }
            const tail = extras.length ? `（${extras.join('；')}）` : '';
            lines.push(`${from.name} → ${to.name}：${call}${tail}`);
        }
    }

    if (!lines.length) return '';

    const head = opts.header
        ? `【称呼表】以下为已确认的称呼，请在对话中自然使用，不要复述本表。`
        : '';
    const foot = opts.fallbackRule
        ? `（未列出的关系按原本的名字称呼。称呼会随关系阶段变化时，以关系更贴合的写法为准。）`
        : '';

    const body = [...lines].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const max = clampInt(opts.maxChars, 200, 100000, 4000);

    const build = (keptLines, droppedCount) => [
        head,
        ...keptLines,
        droppedCount > 0 ? `（另有 ${droppedCount} 条称呼因长度限制未列出）` : '',
        foot,
    ].filter(Boolean).join('\n');

    let text = build(body, 0);
    if (text.length <= max) return text;

    // 超长时逐条往下砍，直到真的放得下为止——不静默丢关系，也不假装没被截断。
    for (let keptCount = body.length - 1; keptCount >= 0; keptCount -= 1) {
        text = build(body.slice(0, keptCount), body.length - keptCount);
        if (text.length <= max) return text;
    }
    return text;
}

/** 极简单行版本，给宏 {{callTable}} 用。 */
export function composeInlineTable({ participants = [], chatState = null, library = null, opts = {} } = {}) {
    const items = [];
    for (const from of participants) {
        for (const to of participants) {
            if (from.key === to.key) continue;
            const hit = resolveRelation({ chatState, library, from: from.key, to: to.key });
            const call = appellationText(hit, opts);
            if (!call) continue;
            items.push(`${from.name}→${to.name}:${call}`);
        }
    }
    return items.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).join('；');
}

/* ------------------------------------------------------------------ *
 * 扫描：从最近聊天里找出「谁喊谁什么」的候选
 * ------------------------------------------------------------------ */

/** 明显不是称呼的高频词，避免把语气词、连接词当称呼收进来。 */
const STOP_WORDS = new Set([
    '我', '你', '他', '她', '它', '您', '咱', '我们', '你们', '他们', '她们', '这', '那', '这个', '那个',
    '的', '了', '吗', '呢', '吧', '啊', '呀', '哇', '哦', '噢', '嗯', '诶', '哎', '喂', '哈', '嘿', '唉',
    '是', '不', '没', '别', '就', '都', '也', '还', '又', '再', '很', '太', '真', '好', '对', '行', '能', '会', '要', '得',
    '但', '而', '和', '与', '在', '有', '被', '把', '给', '从', '到', '向', '让', '就是', '然后', '所以', '因为',
    '可是', '但是', '如果', '只是', '已经', '真的', '好像', '似乎', '什么', '怎么', '为什么', '一个', '一切', '自己',
    '说', '道', '问', '答', '笑', '看', '听', '想', '知道', '明白', '等等', '一下', '一点', '现在', '时候',
]);

/**
 * 扫描用的句式规则。
 * 中文里「他叫她小星星」「称她为『姐姐』」「称呼星野为‘小星’」都是同一个意思，
 * 所以拆成 5 条规则，各自标注置信度，最后按 (关系, 称呼) 去重合并。
 */
const NAME_CLASS = '[^\\s，,。、！!？?：:；;"“”\'‘’「」『』（）()\\[\\]【】]{1,12}';
const QUOTE = '["“”\'‘’「」『』]';
const CALL_VERB = '(?:称呼|称作|称为|叫作|叫做|叫|称|喊|唤)';
const PRONOUN = '(?:他|她|它)?';

const SCAN_RULES = [
    {
        id: 'calledTwoArg',
        confidence: 0.92,
        group: 2,
        re: new RegExp(`(?:${CALL_VERB})${PRONOUN}(${NAME_CLASS})为\\s*${QUOTE}?(${NAME_CLASS})${QUOTE}?`, 'gu'),
    },
    {
        id: 'calledOneArg',
        confidence: 0.9,
        group: 1,
        re: new RegExp(`${CALL_VERB}${PRONOUN}为\\s*${QUOTE}?(${NAME_CLASS})${QUOTE}?`, 'gu'),
    },
    {
        id: 'calledBare',
        confidence: 0.75,
        group: 1,
        re: new RegExp(`${CALL_VERB}${PRONOUN}${QUOTE}?(${NAME_CLASS})${QUOTE}?`, 'gu'),
    },
    {
        id: 'vocative',
        confidence: 0.7,
        group: 1,
        re: new RegExp(`(?:^|[\\n。！？!?；;])\\s*[（(【\\["“'‘「『]*(${NAME_CLASS})[，,：:]`, 'gu'),
    },
    {
        id: 'vocativeVerb',
        confidence: 0.6,
        group: 1,
        re: new RegExp(`(${NAME_CLASS})\\s*[，,]\\s*(?:他|她|它)?(?:说|道|问|答|笑|喊|叫|低声|轻声|开口)`, 'gu'),
    },
];

function stripForScan(text) {
    return str(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_`>#|]/g, ' ');
}

/** 候选清洗：去掉被正则顺手吃进来的助词、系动词，避免「星野为」这种假称呼。 */
function tidyCall(raw) {
    return str(raw)
        .trim()
        .replace(/^[的地得]/u, '')
        .replace(/[为作做成为是的]/u, '')
        .trim();
}

function isPlausibleCall(raw) {
    const s = str(raw).trim();
    if (s.length < 1 || s.length > 12) return false;
    if (STOP_WORDS.has(s)) return false;
    if (/^\d+$/u.test(s)) return false;
    if (!/[\p{L}\p{N}]/u.test(s)) return false;
    if (/^(?:的|地|得|着|过|啦|咯|喽|嘛|罢了)$/u.test(s)) return false;
    return true;
}

function speakerOf(message, participants) {
    if (!message) return null;
    if (message.is_user) return participants.find(p => p.kind === 'user') ?? null;
    const named = participants.find(p => p.kind === 'character' && p.name === str(message.name).trim());
    if (named) return named;
    const chars = participants.filter(p => p.kind === 'character');
    return chars.length === 1 ? chars[0] : null;
}

function nearestOther(text, index, others) {
    let best = null;
    let bestDist = Infinity;
    for (const p of others) {
        let from = 0;
        while (from <= text.length) {
            const pos = text.indexOf(p.name, from);
            if (pos < 0) break;
            const dist = Math.abs(pos - index);
            if (dist < bestDist) {
                bestDist = dist;
                best = p;
            }
            from = pos + Math.max(1, p.name.length);
        }
    }
    // 单聊里消息文本通常不会写出对方的名字，此时唯一在场的另一人就只能是目标。
    if (!best && others.length === 1) return others[0];
    return best;
}

function snippet(text, index) {
    const start = Math.max(0, index - 12);
    const end = Math.min(text.length, index + 18);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * 扫描候选称呼。
 * messages 为酒馆的 chat 数组（元素含 mes / is_user / name）。
 * 结果只作候选，绝不自动写入关系表。
 */
export function scanCandidates({ messages = [], participants = [], limit = 40, minCount = 1 } = {}) {
    const buckets = new Map();
    const tail = Array.isArray(messages) ? messages.slice(-clampInt(limit, 1, 500, 40)) : [];

    for (const message of tail) {
        const text = stripForScan(message?.mes);
        if (!text) continue;
        const speaker = speakerOf(message, participants);
        if (!speaker) continue;
        const others = participants.filter(p => p.key !== speaker.key);
        if (!others.length) continue;

        for (const rule of SCAN_RULES) {
            rule.re.lastIndex = 0;
            let match;
            while ((match = rule.re.exec(text)) !== null) {
                const raw = tidyCall(match[rule.group]);
                if (!isPlausibleCall(raw)) continue;
                if (raw === speaker.name) continue;
                const target = nearestOther(text, match.index, others);
                if (!target) continue;
                if (raw === target.name) continue; // 直接喊真名不算「称呼」，避免把名字当成昵称收进候选
                const id = `${relationKey(speaker.key, target.key)}|${raw}`;
                let bucket = buckets.get(id);
                if (!bucket) {
                    bucket = {
                        from: speaker.key,
                        to: target.key,
                        fromName: speaker.name,
                        toName: target.name,
                        call: raw,
                        count: 0,
                        confidence: rule.confidence,
                        ruleId: rule.id,
                        samples: [],
                    };
                    buckets.set(id, bucket);
                }
                bucket.count += 1;
                if (bucket.samples.length < 3) bucket.samples.push(snippet(text, match.index));
            }
        }
    }

    return [...buckets.values()]
        .filter(b => b.count >= clampInt(minCount, 1, 100, 1))
        .sort((a, b) => b.confidence - a.confidence || b.count - a.count || a.call.localeCompare(b.call));
}

/**
 * 一致性检查（只读）：
 *  - unused：登记了称呼，但最近 N 楼里一次都没出现（可能过时）
 *  - conflict：最近 N 楼里高频出现的候选与登记值不一致
 */
export function lintRelations({ messages = [], participants = [], chatState = null, library = null, limit = 40, minCount = 1 } = {}) {
    const issues = [];
    const tail = Array.isArray(messages) ? messages.slice(-clampInt(limit, 1, 500, 40)) : [];
    const corpus = tail.map(m => stripForScan(m?.mes)).join('\n');
    const candidates = scanCandidates({ messages: tail, participants, limit, minCount });

    for (const from of participants) {
        for (const to of participants) {
            if (from.key === to.key) continue;
            const hit = resolveRelation({ chatState, library, from: from.key, to: to.key });
            if (!hit) continue;
            const call = appellationText(hit);
            if (call && !corpus.includes(call)) {
                issues.push({
                    level: 'info',
                    code: 'unused',
                    from: from.key,
                    to: to.key,
                    message: `「${from.name} → ${to.name}」登记为「${call}」，但最近 ${tail.length} 楼里没有出现过。`,
                });
            }
        }
    }

    for (const cand of candidates) {
        if (cand.count < 2) continue;
        const hit = resolveRelation({ chatState, library, from: cand.from, to: cand.to });
        const registered = appellationText(hit);
        if (registered && registered !== cand.call) {
            issues.push({
                level: 'warn',
                code: 'conflict',
                from: cand.from,
                to: cand.to,
                candidate: cand.call,
                message: `「${cand.fromName} → ${cand.toName}」登记为「${registered}」，但最近聊天里出现「${cand.call}」${cand.count} 次。`,
                samples: cand.samples,
            });
        }
    }

    return issues;
}

/* ------------------------------------------------------------------ *
 * 导入 / 导出
 * ------------------------------------------------------------------ */

export function exportBundle({ chatState, library, settings }) {
    return {
        type: 'st-appellation-manager/bundle',
        version: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        chat: normalizeChatState(chatState),
        library: normalizeLibrary(library),
        inject: normalizeSettings({ inject: settings?.inject }).inject,
    };
}

/** 解析导入内容；支持完整 bundle，也支持只含 relations 的裸对象。 */
export function importBundle(raw) {
    let data = raw;
    if (typeof raw === 'string') {
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error('导入内容不是合法 JSON');
        }
    }
    if (!data || typeof data !== 'object') throw new Error('导入内容为空或格式不正确');

    const isBundle = data.type === 'st-appellation-manager/bundle';
    const chat = normalizeChatState(isBundle ? data.chat : data);
    const library = isBundle ? normalizeLibrary(data.library) : {};
    const inject = isBundle && data.inject ? normalizeSettings({ inject: data.inject }).inject : null;
    return { chat, library, inject };
}
