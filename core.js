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
    // 小说名 → 聊天角色的映射是「每聊天」的事：同一部小说用到不同聊天，映射本来就不一样。
    const novelMapping = {};
    for (const [novelId, map] of Object.entries(src.novelMapping && typeof src.novelMapping === 'object' ? src.novelMapping : {})) {
        if (!map || typeof map !== 'object') continue;
        const clean = {};
        for (const [name, key] of Object.entries(map)) {
            const n = str(name).trim();
            if (!n) continue;
            clean[n] = key === null || key === undefined || key === '' ? null : String(key);
        }
        novelMapping[String(novelId)] = clean;
    }
    return {
        version: SCHEMA_VERSION,
        relations,
        novelMapping,
        auto: normalizeAutoState(src.auto),
        updatedAt: Number(src.updatedAt) || 0,
    };
}

export function emptyChatState() {
    return { version: SCHEMA_VERSION, relations: {}, novelMapping: {}, auto: emptyAutoState(), updatedAt: 0 };
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
        // 总开关默认关闭：装完什么都不做，不注入、不自动改、不自动回滚，等你手动打开
        enabled: false,
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
        extract: {
            mode: 'st',          // st=用酒馆当前连接 | custom=直连自定义 OpenAI 兼容端点
            custom: { baseUrl: '', model: '', apiKey: '', models: [], noChat: [] },
            chunkChars: EXTRACT_DEFAULTS.chunkChars,
            maxChunks: EXTRACT_DEFAULTS.maxChunks,
            startOffset: EXTRACT_DEFAULTS.startOffset,
            temperature: 0,
            injectNovel: false,  // 是否把当前小说的称呼表也注入提示词
        },
        novels: { version: SCHEMA_VERSION, items: {}, activeId: null },
        // 自动维护：默认关闭，打开后每 N 条角色回复用本地扫描更新一次称呼
        auto: {
            enabled: false,
            everyN: 5,           // 每多少条角色回复更新一次
            lookback: 12,        // 用最近多少楼当依据
            minConfidence: 0.6,  // 本地扫描的置信度门槛
            minCount: 1,
            maxPerRun: 6,        // 一次最多写几条，防止一次改一大片
        },
        // 界面偏好：关系默认用放射图看（表格留着手工改）；面板默认收起，别一开扩展抽屉就占满屏
        ui: { relationsView: 'graph', novelView: 'graph', collapsed: true },
        library: {},
    };
}

/** 合并式归一化设置：只补齐缺失项，不删掉用户已有的自定义值。 */
export function normalizeSettings(raw) {
    const base = defaultSettings();
    const src = raw && typeof raw === 'object' ? raw : {};
    const inject = { ...base.inject, ...(src.inject && typeof src.inject === 'object' ? src.inject : {}) };
    const scan = { ...base.scan, ...(src.scan && typeof src.scan === 'object' ? src.scan : {}) };
    const extract = { ...base.extract, ...(src.extract && typeof src.extract === 'object' ? src.extract : {}) };
    const custom = { ...base.extract.custom, ...(extract.custom && typeof extract.custom === 'object' ? extract.custom : {}) };
    const ui = { ...base.ui, ...(src.ui && typeof src.ui === 'object' ? src.ui : {}) };
    const auto = { ...base.auto, ...(src.auto && typeof src.auto === 'object' ? src.auto : {}) };

    inject.depth = clampInt(inject.depth, 0, 10000, base.inject.depth);
    inject.position = [0, 1, 2].includes(Number(inject.position)) ? Number(inject.position) : base.inject.position;
    inject.role = [0, 1, 2].includes(Number(inject.role)) ? Number(inject.role) : base.inject.role;
    inject.maxChars = clampInt(inject.maxChars, 200, 100000, base.inject.maxChars);
    inject.targets = ['all', 'user', 'focus'].includes(inject.targets) ? inject.targets : 'all';

    scan.limit = clampInt(scan.limit, 1, 500, base.scan.limit);
    scan.minCount = clampInt(scan.minCount, 1, 100, base.scan.minCount);

    extract.mode = ['st', 'custom'].includes(extract.mode) ? extract.mode : 'st';
    extract.chunkChars = clampInt(extract.chunkChars, 200, 20000, base.extract.chunkChars);
    extract.maxChunks = clampInt(extract.maxChunks, 1, 500, base.extract.maxChunks);
    extract.startOffset = clampInt(extract.startOffset, 0, 100000000, base.extract.startOffset);
    extract.temperature = clampNumber(extract.temperature, 0, 2, 0);
    extract.injectNovel = Boolean(extract.injectNovel);
    custom.baseUrl = str(custom.baseUrl).trim();
    custom.model = str(custom.model).trim();
    custom.apiKey = str(custom.apiKey);
    // 从端点 /models 拉回来的候选，缓存下来，省得每次开面板都重新请求
    custom.models = (Array.isArray(custom.models) ? custom.models : [])
        .map(m => str(m).trim())
        .filter(Boolean)
        .slice(0, 500);
    // 其中明确不支持 /chat/completions 的（比如只支持 /messages 的 Claude 系），别默认选它们
    custom.noChat = (Array.isArray(custom.noChat) ? custom.noChat : [])
        .map(m => str(m).trim())
        .filter(Boolean)
        .slice(0, 500);
    extract.custom = custom;

    ui.relationsView = ['graph', 'table'].includes(ui.relationsView) ? ui.relationsView : 'graph';
    ui.novelView = ['graph', 'table'].includes(ui.novelView) ? ui.novelView : 'graph';
    // 没设置过就默认收起
    ui.collapsed = ui.collapsed === undefined ? true : Boolean(ui.collapsed);

    auto.enabled = Boolean(auto.enabled);
    auto.everyN = clampInt(auto.everyN, 1, 200, base.auto.everyN);
    auto.lookback = clampInt(auto.lookback, 1, 500, base.auto.lookback);
    auto.minConfidence = clampNumber(auto.minConfidence, 0, 1, base.auto.minConfidence);
    auto.minCount = clampInt(auto.minCount, 1, 100, base.auto.minCount);
    auto.maxPerRun = clampInt(auto.maxPerRun, 1, 100, base.auto.maxPerRun);

    return {
        ...base,
        ...src,
        enabled: Boolean(src.enabled),
        inject,
        scan,
        extract,
        auto,
        ui,
        novels: normalizeNovels(src.novels),
        library: normalizeLibrary(src.library),
    };
}

export function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * 设置对象的稳定缓存。
 *
 * 踩过的坑：如果每次读设置都重新归一化出一个新对象，那么任何「先读设置 → await 网络请求 → 写回设置」
 * 的代码都在往一个已经被换掉的孤儿对象上写。表现就是「接口明明返回成功了，界面上什么都没有」——
 * 因为写进去的那份根本不在 store 里。
 *
 * 所以：同一个源对象在多次读取之间必须返回同一个实例；只有外部真的换了对象才重新归一化。
 */
export function createSettingsCache() {
    let cached = null;
    return {
        /**
         * @param {object} raw store 里当前存放的设置对象；
         *                    如果它就是上次归一化出来的那个实例，直接原样返回。
         */
        get(raw) {
            // 关键：比的是「我们上次返回的那个对象」，不是「上次传进来的原始对象」。
            // 归一化之后写回 store 的是新对象，拿原始对象比会永远不相等，结果每次读都重新造一个——
            // 孤儿引用就是这么产生的。
            if (cached && raw === cached) return cached;
            cached = normalizeSettings(raw);
            return cached;
        },
        reset() {
            cached = null;
        },
    };
}

/**
 * 把文件字节解成文本。
 *
 * 中文小说 txt 十有八九是 GBK / GB18030，直接当 UTF-8 读会整篇乱码（满屏 ），
 * 所以这里按 BOM → 严格 UTF-8 → GB18030 → Big5 的顺序试，返回实际用的编码。
 */
export function decodeTextBuffer(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
    const tryDecode = (encoding, slice) => {
        try {
            return new TextDecoder(encoding).decode(slice ?? bytes);
        } catch {
            return null;
        }
    };

    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return { text: tryDecode('utf-8', bytes.subarray(3)) ?? '', encoding: 'UTF-8 (BOM)' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        const text = tryDecode('utf-16le', bytes.subarray(2));
        if (text !== null) return { text, encoding: 'UTF-16 LE' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        const text = tryDecode('utf-16be', bytes.subarray(2));
        if (text !== null) return { text, encoding: 'UTF-16 BE' };
    }

    // 严格模式：能当成 UTF-8 解出来就一定是 UTF-8
    let utf8 = null;
    try {
        utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        utf8 = null;
    }
    if (utf8 !== null) return { text: utf8, encoding: 'UTF-8' };

    for (const encoding of ['gb18030', 'big5']) {
        const text = tryDecode(encoding);
        if (text !== null && !text.includes('\uFFFD') && text.length) return { text, encoding };
    }

    // 实在认不出来：用宽松 UTF-8 兜底，让用户至少能看到内容决定怎么办
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: '认不出的编码（可能有乱码）' };
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
 * 关系图（放射状）
 *
 * 选一个核心角色当圆心，其他人放射状摆在周围：
 *   spokes —— 核心 ↔ 每个人的双向称呼（→ 是核心这么叫对方，← 是对方这么叫核心）
 *   chords —— 外围角色两两之间的关系（角色一多就不画，免得糊成一团）
 * 纯数据，画图在 ui.js。
 * ------------------------------------------------------------------ */

/** 外围同时最多画几条弦；超过这个数就只显示与核心的关系。 */
export const GRAPH_MAX_CHORDS_NODES = 5;

/**
 * 图形几何参数。坐标系是 0–100 的百分比，容器靠 CSS 撑成正方形。
 * 抽出来是为了能离线验证「标签会不会压住圆心节点」这类看不见的问题。
 */
export const GRAPH_GEOMETRY = {
    cx: 50,
    cy: 50,
    radius: 33,
    // 标签沿辐条的位置（0=圆心 1=外围节点）。0.62 是算过的：
    // 再往外挪，斜向辐条上的标签就会压到外围节点（节点最宽 26%，半宽 13）。
    labelT: 0.62,
    labelOffset: 9,    // 两个方向的标签各往垂直方向偏多少，避免叠在一起
    chordBulge: 16,    // 弦往外鼓多少，免得正好穿过圆心
    // 节点当成矩形做避让判断用的半尺寸（百分比），与 style.css 里的 max-width 对应
    nodeHalfWidth: 13,
    nodeHalfHeight: 5,
    centerHalfHeight: 7,
};

/** 外围节点的坐标：从正上方开始，均匀分布。 */
export function graphLayout(count, geometry = GRAPH_GEOMETRY) {
    const n = Math.max(0, Number(count) || 0);
    const out = [];
    for (let i = 0; i < n; i += 1) {
        const angle = ((-90 + (360 / n) * i) * Math.PI) / 180;
        out.push({
            x: geometry.cx + geometry.radius * Math.cos(angle),
            y: geometry.cy + geometry.radius * Math.sin(angle),
        });
    }
    return out;
}

/** 一条辐条上两个方向标签的位置：分居连线两侧。 */
export function graphSpokeLabels(from, to, geometry = GRAPH_GEOMETRY) {
    const vx = to.x - from.x;
    const vy = to.y - from.y;
    const len = Math.hypot(vx, vy) || 1;
    const px = -vy / len;
    const py = vx / len;
    const baseX = from.x + vx * geometry.labelT;
    const baseY = from.y + vy * geometry.labelT;
    const off = geometry.labelOffset;
    return {
        outward: { x: baseX + px * off, y: baseY + py * off },
        inward: { x: baseX - px * off, y: baseY - py * off },
    };
}

/** 外围两人之间的弧线控制点，以及弧线中点（放标签用）。 */
export function graphChordControl(a, b, geometry = GRAPH_GEOMETRY) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let dx = mx - geometry.cx;
    let dy = my - geometry.cy;
    if (Math.hypot(dx, dy) < 1) {
        // 两点正好关于圆心对称，中点在圆心上，改成沿垂直方向鼓出去
        dx = -(b.y - a.y);
        dy = b.x - a.x;
    }
    const norm = Math.hypot(dx, dy) || 1;
    return {
        mid: { x: mx, y: my },
        control: { x: mx + (dx / norm) * geometry.chordBulge, y: my + (dy / norm) * geometry.chordBulge },
    };
}

export function buildRelationGraph({ participants = [], chatState = null, library = null, centerKey = null } = {}) {
    const list = (participants ?? []).filter(p => p && p.key);
    const center = list.find(p => p.key === centerKey) ?? list[0] ?? null;
    if (!center) return { center: null, nodes: [], spokes: [], chords: [], chordsSkipped: 0 };

    const others = list.filter(p => p.key !== center.key);
    const lookup = (from, to) => {
        const hit = resolveRelation({ chatState, library, from: from.key, to: to.key });
        if (!hit) return null;
        const call = appellationText(hit);
        if (!call) return null;
        return { call, aliases: hit.relation.aliases ?? [], source: hit.source };
    };

    const spokes = others.map(other => ({
        key: other.key,
        name: other.name,
        kind: other.kind,
        outward: lookup(center, other),   // 核心 → 对方
        inward: lookup(other, center),    // 对方 → 核心
    }));

    const chords = [];
    let chordsSkipped = 0;
    if (others.length <= GRAPH_MAX_CHORDS_NODES) {
        for (let i = 0; i < others.length; i += 1) {
            for (let j = i + 1; j < others.length; j += 1) {
                const aToB = lookup(others[i], others[j]);
                const bToA = lookup(others[j], others[i]);
                if (aToB || bToA) {
                    chords.push({
                        a: others[i].key,
                        b: others[j].key,
                        aName: others[i].name,
                        bName: others[j].name,
                        aToB,
                        bToA,
                    });
                }
            }
        }
    } else {
        // 数一下被省掉的弦，好在界面上如实说明「不是没有，是没画」
        for (let i = 0; i < others.length; i += 1) {
            for (let j = i + 1; j < others.length; j += 1) {
                if (lookup(others[i], others[j]) || lookup(others[j], others[i])) chordsSkipped += 1;
            }
        }
    }

    return {
        center: { key: center.key, name: center.name, kind: center.kind },
        nodes: list.map(p => ({ key: p.key, name: p.name, kind: p.kind })),
        spokes,
        chords,
        chordsSkipped,
    };
}

/**
 * 把小说称呼表（人名级）转成画图用的输入。
 * 小说里没有「用户」，所以全部当成 character，键统一加 name: 前缀。
 */
export function novelGraphInput(table) {
    const names = [];
    for (const row of table ?? []) {
        if (!names.includes(row.from)) names.push(row.from);
        if (!names.includes(row.to)) names.push(row.to);
    }
    const participants = names.map(name => ({ key: `name:${name}`, name, kind: 'character' }));
    const library = {};
    for (const row of table ?? []) {
        library[relationKey(`name:${row.from}`, `name:${row.to}`)] = {
            call: row.call,
            aliases: row.aliases ?? [],
            stage: '',
            note: '',
        };
    }
    return { participants, library };
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
 * 小说称呼库
 *
 * 核心定位：**先建立小说的称呼**，跟当前开着哪个聊天无关。
 * 所以结果存在全局设置里的「小说库」中，每部小说一份；名字就是小说里的人物名。
 * 聊天里要用的时候才做一次「名字 → 聊天角色」的映射（映射属于聊天，不存在这儿）。
 *
 * 这一整套不碰网络，模型调用由 extract.js 注入，所以能离线测。
 * ------------------------------------------------------------------ */

export const EXTRACT_DEFAULTS = {
    chunkChars: 1500,
    overlapChars: 120,
    maxChunks: 12,
    startOffset: 0,
    maxTokens: 1600,
};

/** 归一化一条提取结果（小说人物名级）。 */
function normalizeExtractItem(item) {
    const from = str(item?.from).trim();
    const to = str(item?.to).trim();
    const call = str(item?.call).trim();
    if (!from || !to || !call || from === to) return null;
    return {
        from,
        to,
        call,
        count: clampInt(item?.count, 1, 100000, 1),
        confidence: clampNumber(item?.confidence, 0, 1, 0.7),
        evidence: (Array.isArray(item?.evidence) ? item.evidence : [item?.evidence])
            .map(e => str(e).trim())
            .filter(Boolean)
            .slice(0, 3),
    };
}

export function newNovelId() {
    return `novel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createNovel(name = '未命名小说', extra = {}) {
    const now = Date.now();
    return normalizeNovel({
        id: newNovelId(),
        name: str(name).trim() || '未命名小说',
        createdAt: now,
        updatedAt: now,
        ...extra,
    });
}

/** 归一化一部小说。 */
export function normalizeNovel(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const results = [];
    const seen = new Set();
    for (const item of Array.isArray(src.results) ? src.results : []) {
        const clean = normalizeExtractItem(item);
        if (!clean) continue;
        const key = `${clean.from}=>${clean.to}|${clean.call}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(clean);
    }
    return {
        id: str(src.id).trim() || newNovelId(),
        name: str(src.name).trim().slice(0, 100) || '未命名小说',
        createdAt: Number(src.createdAt) || Date.now(),
        updatedAt: Number(src.updatedAt) || 0,
        sourceName: str(src.sourceName).slice(0, 200),
        sourceChars: clampInt(src.sourceChars, 0, 100000000, 0),
        chunksDone: clampInt(src.chunksDone, 0, 100000, 0),
        chunksTotal: clampInt(src.chunksTotal, 0, 100000, 0),
        nextOffset: clampInt(src.nextOffset, 0, 100000000, 0),
        results,
        notes: (Array.isArray(src.notes) ? src.notes : []).map(n => str(n)).filter(Boolean).slice(0, 20),
    };
}

/** 归一化整个小说库。 */
export function normalizeNovels(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const items = {};
    const source = src.items && typeof src.items === 'object' ? src.items : {};
    for (const [id, novel] of Object.entries(source)) {
        const clean = normalizeNovel({ ...novel, id });
        items[clean.id] = clean;
    }
    const activeId = str(src.activeId).trim();
    return {
        version: SCHEMA_VERSION,
        items,
        activeId: activeId && items[activeId] ? activeId : (Object.keys(items)[0] ?? null),
    };
}

export function listNovels(novels) {
    const clean = normalizeNovels(novels);
    return Object.values(clean.items).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/**
 * 把原始的「谁喊谁什么」条目整理成一张称呼表：
 * 同一对的多个称呼，命中多的当主称呼，其余降为别名。
 * 这就是用户要的那张「小说称呼表」，纯人名级，不涉及聊天。
 */
export function buildNovelTable(results) {
    const merged = mergeExtractResults([results]);
    const byPair = new Map();
    for (const item of merged) {
        const key = `${item.from}=>${item.to}`;
        let group = byPair.get(key);
        if (!group) {
            group = { from: item.from, to: item.to, calls: [] };
            byPair.set(key, group);
        }
        group.calls.push(item);
    }
    const out = [];
    for (const group of byPair.values()) {
        group.calls.sort((a, b) => (b.count - a.count) || a.call.localeCompare(b.call, 'zh-Hans-CN'));
        const main = group.calls[0];
        out.push({
            from: group.from,
            to: group.to,
            call: main.call,
            aliases: uniq(group.calls.slice(1).map(c => c.call)).filter(a => a !== main.call),
            count: main.count,
            confidence: main.confidence,
            evidence: main.evidence,
            variants: group.calls.map(c => ({ call: c.call, count: c.count })),
        });
    }
    return out.sort((a, b) =>
        b.count - a.count
        || a.from.localeCompare(b.from, 'zh-Hans-CN')
        || a.to.localeCompare(b.to, 'zh-Hans-CN')
        || a.call.localeCompare(b.call, 'zh-Hans-CN'));
}

/** 称呼表的纯文本形式（Markdown 表格），方便直接粘进世界书或角色卡。 */
export function novelTableToText(table, { withEvidence = false } = {}) {
    const rows = Array.isArray(table) ? table : [];
    if (!rows.length) return '';
    const head = withEvidence
        ? '| 称呼方 | 被称呼方 | 称呼 | 别名 | 命中 | 原文证据 |'
        : '| 称呼方 | 被称呼方 | 称呼 | 别名 | 命中 |';
    const sep = withEvidence
        ? '| --- | --- | --- | --- | --- | --- |'
        : '| --- | --- | --- | --- | --- |';
    const body = rows.map(row => {
        const cells = [
            row.from,
            row.to,
            row.call,
            (row.aliases ?? []).join('、'),
            String(row.count ?? ''),
        ];
        if (withEvidence) {
            // 表格里不能出现换行和竖线，先把证据洗一遍
            cells.push(String(row.evidence?.[0] ?? '').replace(/[\r\n|]+/g, ' ').trim());
        }
        return `| ${cells.join(' | ')} |`;
    });
    return [head, sep, ...body].join('\n');
}

/** 把一部小说的称呼表压成可注入提示词的一段。 */
export function composeNovelPromptBlock(novel, { maxChars = 3000, includeAliases = true, header = true } = {}) {
    const table = buildNovelTable(novel?.results);
    if (!table.length) return '';
    const lines = table.map(row => {
        const extras = includeAliases && row.aliases?.length ? `（别名：${row.aliases.join('、')}）` : '';
        return `${row.from} → ${row.to}：${row.call}${extras}`;
    });
    const head = header
        ? `【原著称呼表${novel?.name ? `｜${novel.name}` : ''}】以下称呼出自原著，用来提醒人物之间习惯怎么称呼，不要复述本表。`
        : '';
    const max = clampInt(maxChars, 200, 100000, 3000);
    const kept = [];
    let length = head.length;
    for (const line of lines) {
        if (length + line.length + 1 > max) break;
        kept.push(line);
        length += line.length + 1;
    }
    const dropped = lines.length - kept.length;
    return [head, ...kept, dropped > 0 ? `（另有 ${dropped} 条因长度限制未列出）` : ''].filter(Boolean).join('\n');
}

export function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * 把长正文切成块。块之间留一小段重叠，避免「跨块的称呼」正好被切断。
 * 返回 [{ index, start, end, text }]。
 */
export function chunkText(text, opts = {}) {
    const src = str(text);
    const size = clampInt(opts.chunkChars, 200, 20000, EXTRACT_DEFAULTS.chunkChars);
    const overlap = clampInt(opts.overlapChars, 0, size - 1, Math.min(EXTRACT_DEFAULTS.overlapChars, size - 1));
    const limit = clampInt(opts.maxChunks, 1, 500, EXTRACT_DEFAULTS.maxChunks);
    const start = clampInt(opts.startOffset, 0, Math.max(0, src.length), 0);

    const chunks = [];
    let pos = start;
    while (pos < src.length && chunks.length < limit) {
        const end = Math.min(src.length, pos + size);
        chunks.push({ index: chunks.length, start: pos, end, text: src.slice(pos, end) });
        if (end >= src.length) break;
        const next = end - overlap;
        pos = next > pos ? next : end;
    }
    return chunks;
}

export function extractSystemPrompt() {
    return [
        '你是信息抽取器。唯一任务：从给定的中文小说片段里，找出「谁称呼谁、用什么称呼」，然后只输出 JSON。',
        '',
        '输出格式（严格照做，不要任何解释文字，不要 markdown 代码块）：',
        '{"appellations":[{"from":"称呼发出者","to":"被称呼者","call":"称呼原文","evidence":"原文里出现这个称呼的那一小句","confidence":0.9}]}',
        '',
        '规则：',
        '1. from / to 只能填片段里真实出现的人物名字；第一人称就写「我」，不要替换成人名。',
        '2. call 必须是片段里逐字出现过的称呼。不允许改写，不允许把普通名词、动词、语气词当称呼。',
        '3. 人物真名本身不算称呼。只有昵称、称谓、绰号、代称才算（例如「陆哥」「小星星」「白鹭姐」「师傅」）。',
        '4. confidence 填 0 到 1。拿不准的宁可不输出——少而准远好过多而错。',
        '5. evidence 抄原文，不要自己造句。',
        '6. 没有任何称呼就输出 {"appellations":[]}。除了这个 JSON，什么都不要输出。',
    ].join('\n');
}

export function extractUserPrompt(chunk, index, total) {
    return [
        `【正文片段 第 ${index + 1} / ${total} 块】`,
        '<<<',
        str(chunk?.text ?? '').trim(),
        '>>>',
        '',
        '按系统提示的格式输出 JSON。',
    ].join('\n');
}

function tryParseJson(text) {
    try {
        const data = JSON.parse(text);
        return data && typeof data === 'object' ? data : null;
    } catch {
        return null;
    }
}

/** 从一堆文本里挖出最外层 JSON（对付模型多写的寒暄或 ``` 围栏）。 */
function extractJsonSlice(text) {
    const s = str(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '');
    const firstBrace = s.indexOf('{');
    const lastBrace = s.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) return s.slice(firstBrace, lastBrace + 1);
    const firstBracket = s.indexOf('[');
    const lastBracket = s.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) return s.slice(firstBracket, lastBracket + 1);
    return null;
}

/**
 * 解析模型返回的提取结果。
 * 返回 { items, error }：error 非空时 items 一定为空，调用方据此记账。
 */
export function parseExtractResponse(raw) {
    const text = str(raw).trim();
    if (!text) return { items: [], error: '模型返回了空内容' };

    let data = tryParseJson(text);
    if (!data) {
        const slice = extractJsonSlice(text);
        if (slice) data = tryParseJson(slice);
    }
    if (!data) return { items: [], error: '返回内容不是可解析的 JSON' };

    const list = Array.isArray(data)
        ? data
        : [data.appellations, data.items, data.results, data.data].find(Array.isArray);
    if (!list) return { items: [], error: 'JSON 里找不到 appellations 数组' };

    const items = [];
    for (const entry of list) {
        const from = str(entry?.from).trim();
        const to = str(entry?.to).trim();
        const call = str(entry?.call).trim();
        if (!from || !to || !call) continue;
        if (from === to) continue;
        if (from.length > 30 || to.length > 30 || call.length > 30) continue;
        if (/^[\s\p{P}]+$/u.test(call)) continue;
        items.push({
            from,
            to,
            call,
            evidence: str(entry?.evidence).trim().slice(0, 160),
            confidence: clampNumber(entry?.confidence, 0, 1, 0.7),
        });
    }
    return { items, error: null };
}

/**
 * 合并提取条目：同一条关系只留一行，累加命中次数，保留最多 3 条证据。
 * 累加的是条目自带的 count——每块现抽出来的条目没有 count（按 1 算），
 * 已经落过盘的条目带着之前的命中次数，所以「再整理一次」不会把次数抹平。
 */
export function mergeExtractResults(chunkItemLists) {
    const buckets = new Map();
    for (const items of chunkItemLists ?? []) {
        for (const item of items ?? []) {
            const key = `${item.from}=>${item.to}|${item.call}`;
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = { from: item.from, to: item.to, call: item.call, count: 0, confidence: 0, evidence: [] };
                buckets.set(key, bucket);
            }
            bucket.count += Math.max(1, Number(item.count) || 1);
            bucket.confidence = Math.max(bucket.confidence, Number(item.confidence) || 0);
            if (item.evidence && bucket.evidence.length < 3 && !bucket.evidence.includes(item.evidence)) {
                bucket.evidence.push(item.evidence);
            }
        }
    }
    return [...buckets.values()].sort((a, b) =>
        b.count - a.count
        || a.from.localeCompare(b.from, 'zh-Hans-CN')
        || a.to.localeCompare(b.to, 'zh-Hans-CN')
        || a.call.localeCompare(b.call, 'zh-Hans-CN'));
}

/** 结果里出现过的所有人物名，按出现次数从多到少。 */
export function collectNames(results) {
    const counter = new Map();
    for (const item of results ?? []) {
        counter.set(item.from, (counter.get(item.from) ?? 0) + item.count);
        counter.set(item.to, (counter.get(item.to) ?? 0) + item.count);
    }
    return [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')).map(([name]) => name);
}

/** 代词不自动映射——小说里的「我」通常是主角，不是坐在屏幕前的你。 */
const PRONOUN_NAMES = new Set(['我', '你', '他', '她', '它', '您', '咱', '俺', '我们', '你们', '他们', '她们', '大家', '对方']);

/**
 * 把小说人物名映射到当前聊天的参与者键。
 * 精确同名 → 单向前缀包含且唯一 → 否则留空等人工指定。代词一律留空。
 */
export function autoMapNames(names, participants) {
    const map = {};
    const list = participants ?? [];
    for (const raw of names ?? []) {
        const name = str(raw).trim();
        if (!name) continue;
        if (PRONOUN_NAMES.has(name)) {
            map[name] = null;
            continue;
        }
        const exact = list.find(p => p.name === name);
        if (exact) {
            map[name] = exact.key;
            continue;
        }
        const loose = list.filter(p => p.name.startsWith(name) || name.startsWith(p.name));
        map[name] = loose.length === 1 ? loose[0].key : null;
    }
    return map;
}

/**
 * 把「人物名级」的提取结果按映射翻成「参与者键级」的补丁。
 * 映射不上的直接丢掉，不做猜测。
 */
export function buildPatches(results, mapping) {
    const patches = [];
    for (const item of results ?? []) {
        const from = mapping?.[item.from];
        const to = mapping?.[item.to];
        if (!from || !to || from === to) continue;
        patches.push({ from, to, call: item.call, count: item.count ?? 1 });
    }
    return patches;
}

/**
 * 同一对关系里的多个称呼，取出现最多的当主称呼，其余降为别名。
 * 这就是「不用自己填表」的关键一步。
 */
export function patchesToRelations(patches) {
    const byPair = new Map();
    for (const patch of patches ?? []) {
        const key = relationKey(patch.from, patch.to);
        let group = byPair.get(key);
        if (!group) {
            group = { from: patch.from, to: patch.to, calls: [] };
            byPair.set(key, group);
        }
        group.calls.push({ call: patch.call, count: patch.count ?? 1 });
    }
    const out = [];
    for (const group of byPair.values()) {
        group.calls.sort((a, b) => (b.count - a.count) || a.call.localeCompare(b.call, 'zh-Hans-CN'));
        const main = group.calls[0].call;
        out.push({
            from: group.from,
            to: group.to,
            call: main,
            aliases: uniq(group.calls.slice(1).map(c => c.call)).filter(a => a !== main),
        });
    }
    return out;
}

/** 一次性把提取结果写进聊天关系表，返回新状态。 */
export function applyExtractToChatState(chatState, results, mapping) {
    let next = normalizeChatState(chatState);
    for (const rel of patchesToRelations(buildPatches(results, mapping))) {
        next = setRelation(next, rel.from, rel.to, { call: rel.call, aliases: rel.aliases });
    }
    return next;
}

/* ------------------------------------------------------------------ *
 * 自动维护：按楼层更新称呼，删楼时级联回滚
 *
 * 酒馆给不了「这条回复是谁」的稳定 id：
 *   - 消息对象里没有 uuid，send_date 精度只到分钟（同分钟两条就撞）；
 *   - deleteMessage 是先 splice 再 emit，事件里给的是删除后的 chat.length，拿不到被删的索引。
 * 所以这里用「send_date + 正文前 60 字」当身份，并且靠**前后两次快照做差集**判断哪楼没了。
 *
 * 每次自动更新的依据都记进 journal（含写入前的旧值），删楼时按时间倒序回滚。
 * ------------------------------------------------------------------ */

export function messageRef(message) {
    const text = str(message?.mes)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return { date: str(message?.send_date), fp: text.slice(0, 60) };
}

export function refKey(ref) {
    return `${str(ref?.date)}|${str(ref?.fp)}`;
}

/** 给当前聊天的每条消息编身份。index 只用于界面显示和滑动重定位。 */
export function snapshotMessageRefs(messages) {
    return (messages ?? []).map((message, index) => {
        const ref = messageRef(message);
        return { index, date: ref.date, fp: ref.fp };
    });
}

/** 旧快照里有、新快照里没有的，就是被删掉的楼。 */
export function missingRefs(before, after) {
    const alive = new Set((after ?? []).map(refKey));
    return (before ?? []).filter(ref => !alive.has(refKey(ref)));
}

/** 角色回复（非用户、非系统）的条数，用来算「隔几条回复更新一次」。 */
export function assistantMessageCount(messages) {
    return (messages ?? []).filter(message => message && !message.is_user && !message.is_system).length;
}

export function emptyAutoState() {
    return { journal: [], lastRunAssistantCount: 0, lastRunAt: 0 };
}

export function normalizeJournal(raw) {
    const out = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
        if (!entry || typeof entry !== 'object') continue;
        const key = str(entry.key).trim();
        if (!key || !parseRelationKey(key)) continue;
        const after = normalizeRelation(entry.after);
        if (!after) continue;
        out.push({
            id: str(entry.id).trim() || `je_${out.length}_${Math.random().toString(36).slice(2, 8)}`,
            at: Number(entry.at) || 0,
            key,
            from: str(entry.from),
            to: str(entry.to),
            call: str(entry.call),
            before: normalizeRelation(entry.before),
            after,
            ref: { date: str(entry.ref?.date), fp: str(entry.ref?.fp) },
        });
    }
    return out;
}

export function normalizeAutoState(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        journal: normalizeJournal(src.journal),
        lastRunAssistantCount: clampInt(src.lastRunAssistantCount, 0, 1000000, 0),
        lastRunAt: Number(src.lastRunAt) || 0,
    };
}

/** 每条关系的「当前归属」：最后一条 journal 决定它现在应该是多少。 */
export function foldJournal(journal) {
    const map = new Map();
    for (const entry of normalizeJournal(journal)) map.set(entry.key, entry);
    return map;
}

/**
 * 哪些关系仍然是「自动维护在管」的——即当前值和 journal 记的最终值完全一致。
 * 只要用户手工改过，值就不一致，自动维护就不会再动它。
 */
export function autoOwnedKeys(journal, chatState) {
    const state = normalizeChatState(chatState);
    const owned = new Set();
    for (const [key, entry] of foldJournal(journal)) {
        const current = state.relations[key];
        if (!current) continue;
        if (JSON.stringify(current) === JSON.stringify(entry.after)) owned.add(key);
    }
    return owned;
}

/**
 * 决定这一轮自动更新写什么。
 * 保守策略：不存在的才创建；已存在且仍归自动管的，只往别名里补，绝不改主称呼（否则会来回抖）。
 */
export function planAutoUpdate({ candidates = [], chatState = null, journal = [], opts = {} } = {}) {
    const state = normalizeChatState(chatState);
    const owned = autoOwnedKeys(journal, state);
    const minConfidence = clampNumber(opts.minConfidence, 0, 1, 0.6);
    const minCount = clampInt(opts.minCount, 1, 100, 1);
    const maxPerRun = clampInt(opts.maxPerRun, 1, 100, 6);

    const apply = [];
    const skipped = [];
    const handled = new Set();

    for (const cand of candidates ?? []) {
        if (!cand?.from || !cand?.to || cand.from === cand.to) continue;
        const key = relationKey(cand.from, cand.to);
        if (handled.has(key)) continue;
        if ((cand.confidence ?? 0) < minConfidence) {
            skipped.push({ ...cand, reason: '置信度不够' });
            continue;
        }
        if ((cand.count ?? 0) < minCount) {
            skipped.push({ ...cand, reason: '出现次数不够' });
            continue;
        }
        const current = state.relations[key] ?? null;
        if (current && !owned.has(key)) {
            skipped.push({ ...cand, reason: '这对关系你手工改过，自动维护不碰' });
            continue;
        }
        if (current?.call === cand.call) {
            skipped.push({ ...cand, reason: '已经是这个称呼了' });
            continue;
        }

        let after;
        if (!current) {
            after = { call: cand.call, aliases: [], stage: '', note: '' };
        } else if (!current.call) {
            after = { ...current, call: cand.call };
        } else {
            after = {
                ...current,
                aliases: uniq([...(current.aliases ?? []), cand.call]).filter(a => a !== current.call),
            };
        }
        const normalized = normalizeRelation(after);
        if (!normalized || JSON.stringify(normalized) === JSON.stringify(current)) {
            skipped.push({ ...cand, reason: '没有可写的变化' });
            continue;
        }

        handled.add(key);
        apply.push({
            key,
            from: cand.from,
            to: cand.to,
            call: cand.call,
            before: current,
            after: normalized,
            confidence: cand.confidence ?? 0,
            count: cand.count ?? 1,
        });
        if (apply.length >= maxPerRun) break;
    }

    return { apply, skipped };
}

/** 把计划写进关系表，并为每条改动记一条 journal。ref 是「这次更新的依据是哪一楼」。 */
export function applyAutoUpdate(chatState, plan, ref, now = Date.now()) {
    const state = normalizeChatState(chatState);
    const entries = [];
    for (const item of plan?.apply ?? []) {
        state.relations[item.key] = item.after;
        entries.push({
            id: `je_${now.toString(36)}_${entries.length}_${Math.random().toString(36).slice(2, 6)}`,
            at: now,
            key: item.key,
            from: item.from,
            to: item.to,
            call: item.call,
            before: item.before,
            after: item.after,
            ref: { date: str(ref?.date), fp: str(ref?.fp) },
        });
    }
    state.auto.journal = [...state.auto.journal, ...entries];
    state.auto.lastRunAssistantCount = clampInt(ref?.assistantCount, 0, 1000000, state.auto.lastRunAssistantCount);
    state.auto.lastRunAt = now;
    state.updatedAt = now;
    return { chatState: state, entries };
}

/** 只更新「上次跑到第几条回复」这类计数，不写关系。 */
export function touchAutoProgress(chatState, { assistantCount, now = Date.now() } = {}) {
    const state = normalizeChatState(chatState);
    state.auto.lastRunAssistantCount = clampInt(assistantCount, 0, 1000000, state.auto.lastRunAssistantCount);
    state.auto.lastRunAt = now;
    return state;
}

/**
 * 删楼级联回滚：把依据这些楼写进去的改动，按时间倒序退回去。
 *
 * 两条纪律：
 *  1. 倒序——同一条关系可能被改过多次，每条 journal 的 before 是当时的真实值。
 *  2. 回滚前再确认「当前值还等于它当初写下的值」。如果用户中途手工改过，
 *     说明这条关系已经归人手管了，**不能回滚**（否则删一楼会顺手抹掉你手工写的称呼），
 *     只把记录丢掉并如实报出来。
 */
export function revertByRefs(chatState, refs, now = Date.now()) {
    const state = normalizeChatState(chatState);
    const wanted = new Set((refs ?? []).map(refKey));
    if (!wanted.size) return { chatState: state, reverted: [], skipped: [] };

    const hits = [];
    state.auto.journal.forEach((entry, index) => {
        if (wanted.has(refKey(entry.ref))) hits.push({ entry, index });
    });
    if (!hits.length) return { chatState: state, reverted: [], skipped: [] };

    const hitIds = new Set(hits.map(hit => hit.entry.id));
    hits.sort((a, b) => b.index - a.index);

    const reverted = [];
    const skipped = [];
    for (const { entry } of hits) {
        const current = state.relations[entry.key] ?? null;
        if (JSON.stringify(current) !== JSON.stringify(entry.after)) {
            skipped.push(entry);
            continue;
        }
        if (entry.before) state.relations[entry.key] = entry.before;
        else delete state.relations[entry.key];
        reverted.push(entry);
    }
    state.auto.journal = state.auto.journal.filter(entry => !hitIds.has(entry.id));
    state.updatedAt = now;
    return { chatState: state, reverted, skipped };
}

/** 单独撤销一条 journal（界面上点「撤销这条」）。 */
export function revertOneEntry(chatState, id, now = Date.now()) {
    const state = normalizeChatState(chatState);
    const index = state.auto.journal.findIndex(entry => entry.id === id);
    if (index < 0) return { chatState: state, reverted: null, reason: '找不到这条记录' };
    const entry = state.auto.journal[index];
    const later = state.auto.journal.slice(index + 1).some(other => other.key === entry.key);
    if (later) {
        return { chatState: state, reverted: null, reason: '这条之后这对关系还被改过，请用「撤销最近一次」或删楼来回滚' };
    }
    const current = state.relations[entry.key] ?? null;
    if (JSON.stringify(current) !== JSON.stringify(entry.after)) {
        return { chatState: state, reverted: null, reason: '这条关系你已经手工改过，不覆盖你的改动' };
    }
    if (entry.before) state.relations[entry.key] = entry.before;
    else delete state.relations[entry.key];
    state.auto.journal = state.auto.journal.filter(other => other.id !== id);
    state.updatedAt = now;
    return { chatState: state, reverted: entry };
}

/** 清掉依据已不存在的楼写的记录（开关过插件、或换过聊天之后会发生）。 */
export function pruneJournalByRefs(chatState, refs) {
    const state = normalizeChatState(chatState);
    const alive = new Set((refs ?? []).map(refKey));
    const kept = state.auto.journal.filter(entry => alive.has(refKey(entry.ref)));
    const dropped = state.auto.journal.length - kept.length;
    state.auto.journal = kept;
    return { chatState: state, dropped };
}

/** 滑动/改写之后，把指向那条消息的记录重新绑到它的新身份上。 */
export function retargetJournalRefs(chatState, fromRef, toRef) {
    if (!fromRef || !toRef || refKey(fromRef) === refKey(toRef)) return { chatState: normalizeChatState(chatState), changed: 0 };
    const state = normalizeChatState(chatState);
    let changed = 0;
    for (const entry of state.auto.journal) {
        if (refKey(entry.ref) !== refKey(fromRef)) continue;
        entry.ref = { date: str(toRef.date), fp: str(toRef.fp) };
        changed += 1;
    }
    return { chatState: state, changed };
}

/* ------------------------------------------------------------------ *
 * 导入 / 导出
 * ------------------------------------------------------------------ */

export function exportBundle({ chatState, library, settings }) {
    const normalized = normalizeSettings(settings);
    return {
        type: 'st-appellation-manager/bundle',
        version: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        chat: normalizeChatState(chatState),
        library: normalizeLibrary(library),
        inject: normalized.inject,
        novels: normalized.novels,
    };
}

/** 只导出一部小说（含称呼表），方便单独备份或分享。 */
export function exportNovel(novel) {
    const clean = normalizeNovel(novel);
    return {
        type: 'st-appellation-manager/novel',
        version: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        novel: { ...clean, table: buildNovelTable(clean.results) },
    };
}

/** 解析导入内容；支持完整 bundle、单部小说，也支持只含 relations 的裸对象。 */
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

    if (data.type === 'st-appellation-manager/novel') {
        return { novel: normalizeNovel(data.novel), chat: null, library: null, inject: null };
    }

    const isBundle = data.type === 'st-appellation-manager/bundle';
    const chat = normalizeChatState(isBundle ? data.chat : data);
    const library = isBundle ? normalizeLibrary(data.library) : {};
    const inject = isBundle && data.inject ? normalizeSettings({ inject: data.inject }).inject : null;
    const novels = isBundle && data.novels ? normalizeNovels(data.novels) : null;
    return { chat, library, inject, novels };
}
