/**
 * 称呼管理器 · 扩展入口（SillyTavern UI 扩展）
 *
 * 职责：和酒馆对接——读设置、读写聊天元数据、注入提示词、注册宏和斜杠命令、挂面板。
 * 数据处理在 core.js，画面在 ui.js。
 *
 * 安装位置：public/scripts/extensions/third-party/st-appellation-manager/
 */

import {
    EXT_ID,
    USER_KEY,
    buildParticipants,
    clearAllRelations,
    clearRelation,
    composeInlineTable,
    composePromptBlock,
    defaultSettings,
    exportBundle,
    findOrphanRelations,
    focusParticipantKey,
    getRelation,
    importBundle,
    lintRelations,
    normalizeChatState,
    normalizeSettings,
    parseRelationKey,
    resolveRelation,
    scanCandidates,
    setRelation as setRelationPure,
} from './core.js';
import { createPanel } from './ui.js';

/** 注入用的键名；酒馆内部用它区分不同扩展的注入内容。 */
const INJECT_KEY = 'st_appellation_manager';
const LOG_PREFIX = '[称呼管理器]';

let panel = null;
let panelTimer = null;
let listenersBound = false;
let initialized = false;
const registeredMacros = [];
/** 记录已绑定的 { 事件名, 处理函数 }，卸载时才能精确解绑。 */
const boundListeners = [];

/* ------------------------------------------------------------------ *
 * 宿主对接
 * ------------------------------------------------------------------ */

/** 每次都重新取一次上下文：酒馆的上下文对象是快照，缓存会拿到过期的角色/聊天 ID。 */
function host() {
    const st = globalThis.SillyTavern;
    if (!st || typeof st.getContext !== 'function') return null;
    try {
        return st.getContext();
    } catch (error) {
        console.error(LOG_PREFIX, '取不到酒馆上下文', error);
        return null;
    }
}

function getSettings() {
    const ctx = host();
    if (!ctx) return defaultSettings();
    const store = ctx.extensionSettings;
    if (!store) return defaultSettings();
    store[EXT_ID] = normalizeSettings(store[EXT_ID]);
    return store[EXT_ID];
}

function saveSettings() {
    const ctx = host();
    ctx?.saveSettingsDebounced?.();
}

function readChatState() {
    const ctx = host();
    const raw = ctx?.chatMetadata?.[EXT_ID];
    return normalizeChatState(raw);
}

function writeChatState(next) {
    const ctx = host();
    if (!ctx) return;
    if (!ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') return;
    ctx.chatMetadata[EXT_ID] = next;
    ctx.saveMetadataDebounced?.();
}

function participantsOf() {
    const ctx = host();
    if (!ctx) return [];
    return buildParticipants({
        name1: ctx.name1,
        characterId: ctx.characterId,
        characters: ctx.characters,
        groupId: ctx.groupId,
        groups: ctx.groups,
    });
}

function messagesOf() {
    const ctx = host();
    return Array.isArray(ctx?.chat) ? ctx.chat : [];
}

/* ------------------------------------------------------------------ *
 * 提示词注入
 * ------------------------------------------------------------------ */

function refreshInjection() {
    const ctx = host();
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;

    const settings = getSettings();
    const inject = settings.inject;
    const participants = participantsOf();

    let text = '';
    if (inject.enabled && participants.length > 1) {
        text = composePromptBlock({
            participants,
            chatState: readChatState(),
            library: settings.library,
            opts: inject,
            focusKey: focusParticipantKey(participants, ctx.name2),
        });
    }

    try {
        // setExtensionPrompt(键, 文本, 位置, 深度, 是否参与世界书扫描, 角色)
        ctx.setExtensionPrompt(INJECT_KEY, text, inject.position, inject.depth, false, inject.role);
    } catch (error) {
        console.error(LOG_PREFIX, '注入提示词失败', error);
    }
}

/* ------------------------------------------------------------------ *
 * 面板读写接口
 * ------------------------------------------------------------------ */

const api = {
    getSettings,
    getParticipants: participantsOf,
    getFocusKey() {
        const ctx = host();
        return focusParticipantKey(participantsOf(), ctx?.name2);
    },
    resolve(from, to) {
        const settings = getSettings();
        return resolveRelation({ chatState: readChatState(), library: settings.library, from, to });
    },
    setRelation(from, to, patch) {
        writeChatState(setRelationPure(readChatState(), from, to, patch));
        refreshInjection();
    },
    clearRelation(from, to) {
        writeChatState(clearRelation(readChatState(), from, to));
        refreshInjection();
    },
    clearAll() {
        writeChatState(clearAllRelations(readChatState()));
        refreshInjection();
    },
    getOrphans() {
        return findOrphanRelations(readChatState(), participantsOf());
    },
    setInjectOption(key, value) {
        const settings = getSettings();
        settings.inject = { ...settings.inject, [key]: value };
        saveSettings();
        refreshInjection();
    },
    async scan() {
        const settings = getSettings();
        return scanCandidates({
            messages: messagesOf(),
            participants: participantsOf(),
            limit: settings.scan.limit,
            minCount: settings.scan.minCount,
        });
    },
    async lint() {
        const settings = getSettings();
        return lintRelations({
            messages: messagesOf(),
            participants: participantsOf(),
            chatState: readChatState(),
            library: settings.library,
            limit: settings.scan.limit,
            minCount: settings.scan.minCount,
        });
    },
    adoptCandidate(candidate) {
        const state = readChatState();
        const existing = getRelation(state, candidate.from, candidate.to);
        const patch = { call: candidate.call };
        if (existing?.call && existing.call !== candidate.call) {
            // 旧称呼不丢，降级成别名，方便回头对照。
            patch.aliases = [...(existing.aliases ?? []), existing.call];
        }
        writeChatState(setRelationPure(state, candidate.from, candidate.to, patch));
        refreshInjection();
    },
    exportJSON() {
        const settings = getSettings();
        const bundle = exportBundle({ chatState: readChatState(), library: settings.library, settings });
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        link.href = url;
        link.download = `appellation-${stamp}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        panel?.setStatus('已导出 JSON 文件');
    },
    importJSON() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const result = importBundle(text);
                writeChatState(result.chat);
                const settings = getSettings();
                if (Object.keys(result.library).length) {
                    settings.library = { ...settings.library, ...result.library };
                }
                if (result.inject) settings.inject = { ...settings.inject, ...result.inject };
                saveSettings();
                refreshInjection();
                panel?.render();
                panel?.setStatus(`已导入 ${Object.keys(result.chat.relations).length} 条本聊天关系`);
            } catch (error) {
                console.error(LOG_PREFIX, '导入失败', error);
                panel?.setStatus(`导入失败：${error.message}`);
            }
        });
        input.click();
    },
};

/* ------------------------------------------------------------------ *
 * 面板挂载
 * ------------------------------------------------------------------ */

function mountPanel() {
    const container = document.getElementById('extensions_settings2');
    if (!container) return false;
    if (!panel) panel = createPanel(api);
    if (!panel.root.isConnected) {
        container.append(panel.root);
        console.log(LOG_PREFIX, '面板已挂载到扩展设置区');
    }
    return true;
}

function startPanelMounting() {
    if (mountPanel()) return;
    let attempts = 0;
    if (panelTimer) clearInterval(panelTimer);
    panelTimer = setInterval(() => {
        attempts += 1;
        if (mountPanel() || attempts > 80) {
            clearInterval(panelTimer);
            panelTimer = null;
            if (attempts > 80) console.warn(LOG_PREFIX, '没找到扩展设置区容器，面板未挂载');
        }
    }, 250);
}

/* ------------------------------------------------------------------ *
 * 宏
 * ------------------------------------------------------------------ */

function resolveKeyByName(name) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return null;
    const participants = participantsOf();
    const user = participants.find(p => p.kind === 'user');
    if ([USER_KEY, '用户', 'user', 'User', 'persona'].includes(wanted)) return user?.key ?? null;
    const exact = participants.find(p => p.name === wanted);
    if (exact) return exact.key;
    const loose = participants.find(p => p.name.startsWith(wanted) || wanted.startsWith(p.name));
    return loose?.key ?? null;
}

/** 取「源对目标」的称呼；没登记就回退成目标的显示名，保证宏永远返回可读文本。 */
function lookupCall(fromName, toName, { alias = false } = {}) {
    const fromKey = resolveKeyByName(fromName);
    const toKey = resolveKeyByName(toName);
    const participants = participantsOf();
    const fallback = toKey ? (participants.find(p => p.key === toKey)?.name ?? String(toName ?? '')) : String(toName ?? '');
    if (!fromKey || !toKey) return alias ? '' : fallback;
    const settings = getSettings();
    const hit = resolveRelation({ chatState: readChatState(), library: settings.library, from: fromKey, to: toKey });
    if (!hit) return alias ? '' : fallback;
    if (alias) return (hit.relation.aliases ?? []).join('、');
    return hit.relation.call || hit.relation.aliases?.[0] || fallback;
}

function inlineTable() {
    const settings = getSettings();
    return composeInlineTable({
        participants: participantsOf(),
        chatState: readChatState(),
        library: settings.library,
    });
}

async function installMacros() {
    let engine = null;
    try {
        // 新版宏引擎（酒馆 1.13+ 的实验特性，1.19 默认开启）。内部模块，导入失败会自动退回旧接口。
        engine = await import('../../../macros/macro-system.js');
    } catch (error) {
        console.warn(LOG_PREFIX, '新版宏引擎不可用，改用旧版宏接口', error);
        engine = null;
    }

    const registry = engine?.macros;
    if (registry && typeof registry.register === 'function') {
        const defs = [
            {
                name: 'call',
                unnamedArgs: [{ name: 'from' }, { name: 'to' }],
                description: '取「源对目标」的称呼，未登记时回退为目标名字',
                exampleUsage: '{{call::白鹭::用户}}',
                handler: args => lookupCall(args.unnamedArgs?.[0], args.unnamedArgs?.[1]),
            },
            {
                name: 'callAlias',
                unnamedArgs: [{ name: 'from' }, { name: 'to' }],
                description: '取「源对目标」的别名列表',
                exampleUsage: '{{callAlias::用户::白鹭}}',
                handler: args => lookupCall(args.unnamedArgs?.[0], args.unnamedArgs?.[1], { alias: true }),
            },
            {
                name: 'callTable',
                unnamedArgs: 0,
                description: '当前聊天的称呼表（单行压缩）',
                exampleUsage: '{{callTable}}',
                handler: () => inlineTable(),
            },
        ];
        for (const def of defs) {
            try {
                registry.register(def.name, {
                    category: 'appellation',
                    description: def.description,
                    unnamedArgs: def.unnamedArgs,
                    returns: 'string',
                    exampleUsage: def.exampleUsage,
                    handler: def.handler,
                });
                registeredMacros.push(def.name);
            } catch (error) {
                console.warn(LOG_PREFIX, `注册宏 ${def.name} 失败`, error);
            }
        }
        console.log(LOG_PREFIX, `已注册宏：${registeredMacros.join(', ')}`);
        return;
    }

    // 退回旧接口：只支持无参宏。
    const ctx = host();
    if (typeof ctx?.registerMacro !== 'function') {
        console.warn(LOG_PREFIX, '宿主机不支持注册宏，跳过');
        return;
    }
    const legacy = [
        ['callUser', () => lookupCall(participantsOf().find(p => p.kind === 'character')?.name, '用户')],
        ['callChar', () => lookupCall('用户', participantsOf().find(p => p.kind === 'character')?.name)],
        ['callTable', () => inlineTable()],
    ];
    for (const [name, fn] of legacy) {
        try {
            ctx.registerMacro(name, fn, '称呼管理器');
            registeredMacros.push(name);
        } catch (error) {
            console.warn(LOG_PREFIX, `注册宏 ${name} 失败`, error);
        }
    }
    console.log(LOG_PREFIX, `已注册旧版宏：${registeredMacros.join(', ')}`);
}

/* ------------------------------------------------------------------ *
 * 斜杠命令
 * ------------------------------------------------------------------ */

function formatRelationList() {
    const settings = getSettings();
    const state = readChatState();
    const participants = participantsOf();
    const nameOf = key => participants.find(p => p.key === key)?.name ?? key;
    const rows = [];
    for (const [key, value] of Object.entries(state.relations)) {
        const parsed = parseRelationKey(key);
        if (!parsed) continue;
        const call = value.call || value.aliases?.[0] || '';
        rows.push(`${nameOf(parsed.from)} → ${nameOf(parsed.to)}：${call}${value.stage ? `（${value.stage}）` : ''}`);
    }
    for (const [key, value] of Object.entries(settings.library ?? {})) {
        if (state.relations[key]) continue;
        const parsed = parseRelationKey(key);
        if (!parsed) continue;
        const call = value.call || value.aliases?.[0] || '';
        rows.push(`${nameOf(parsed.from)} → ${nameOf(parsed.to)}：${call}（全局默认）`);
    }
    return rows.length ? rows.join('\n') : '当前聊天还没有登记任何称呼。';
}

function installSlashCommand() {
    const ctx = host();
    const Parser = ctx?.SlashCommandParser;
    const Command = ctx?.SlashCommand;
    const NamedArg = ctx?.SlashCommandNamedArgument;
    const Arg = ctx?.SlashCommandArgument;
    const TYPES = ctx?.ARGUMENT_TYPE;
    if (!Parser || !Command || !NamedArg || !Arg || !TYPES) {
        console.warn(LOG_PREFIX, '宿主机不支持斜杠命令，跳过');
        return;
    }

    const build = (aliases) => Command.fromProps({
        name: 'appellation',
        aliases,
        callback: async (namedArgs, unnamedArgs) => {
            const action = String(unnamedArgs ?? '').trim().toLowerCase() || 'list';
            const from = String(namedArgs?.from ?? '').trim();
            const to = String(namedArgs?.to ?? '').trim();
            const call = String(namedArgs?.call ?? '').trim();
            const fromKey = resolveKeyByName(from);
            const toKey = resolveKeyByName(to);

            if (action === 'list') return formatRelationList();
            if (action === 'set') {
                if (!fromKey || !toKey) return '找不到源或目标。可写角色名或「用户」。';
                const patch = { call };
                if (call) patch.aliases = [];
                writeChatState(setRelationPure(readChatState(), fromKey, toKey, patch));
                refreshInjection();
                panel?.render();
                return `已设置：${from} → ${to} = ${call || '（清空）'}`;
            }
            if (action === 'del' || action === 'delete') {
                if (!fromKey || !toKey) return '找不到源或目标。';
                writeChatState(clearRelation(readChatState(), fromKey, toKey));
                refreshInjection();
                panel?.render();
                return `已删除：${from} → ${to}`;
            }
            return '用法：/appellation list | /appellation set from=源 to=目标 call=称呼 | /appellation del from=源 to=目标';
        },
        namedArgumentList: [
            NamedArg.fromProps({ name: 'from', description: '称呼的发出者（角色名或「用户」）', typeList: [TYPES.STRING] }),
            NamedArg.fromProps({ name: 'to', description: '称呼的对象（角色名或「用户」）', typeList: [TYPES.STRING] }),
            NamedArg.fromProps({ name: 'call', description: '要设置的称呼', typeList: [TYPES.STRING] }),
        ],
        unnamedArgumentList: [
            Arg.fromProps({ description: '动作：list / set / del', typeList: [TYPES.STRING], isRequired: false }),
        ],
        helpString: '查看和修改当前聊天的称呼关系',
        returns: 'string',
    });

    try {
        Parser.addCommandObject(build(['称呼']));
    } catch (error) {
        console.warn(LOG_PREFIX, '中文命令别名注册失败，只注册 appellation', error);
        try {
            Parser.addCommandObject(build([]));
        } catch (inner) {
            console.error(LOG_PREFIX, '注册斜杠命令失败', inner);
        }
    }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

function bindEvents() {
    if (listenersBound) return;
    const ctx = host();
    const events = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types;
    if (!events || !types) {
        console.warn(LOG_PREFIX, '宿主机不提供事件总线，改为只在打开面板时刷新');
        return;
    }
    const refreshAll = () => {
        refreshInjection();
        panel?.render();
    };
    for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'GENERATION_AFTER_COMMANDS', 'GROUP_UPDATED', 'CHARACTER_EDITED']) {
        const type = types[name];
        if (!type) continue;
        events.on(type, refreshAll);
        boundListeners.push({ eventBus: events, type, handler: refreshAll });
    }
    if (types.APP_READY) {
        events.on(types.APP_READY, startPanelMounting);
        boundListeners.push({ eventBus: events, type: types.APP_READY, handler: startPanelMounting });
    }
    listenersBound = true;
}

export async function init() {
    if (initialized) return;
    if (!host()) {
        console.error(LOG_PREFIX, '找不到 SillyTavern 上下文，扩展未启动');
        return;
    }
    initialized = true;

    getSettings();
    bindEvents();
    startPanelMounting();
    refreshInjection();
    await installMacros();
    installSlashCommand();
    console.log(LOG_PREFIX, '已加载');
}

/** 手动卸载入口：解绑监听、清掉注入、注销宏、摘掉面板。酒馆禁用扩展通常还需要刷新页面。 */
export function clean() {
    const ctx = host();
    while (boundListeners.length) {
        const { eventBus, type, handler } = boundListeners.pop();
        try {
            eventBus?.removeListener?.(type, handler);
        } catch (error) {
            console.warn(LOG_PREFIX, '解绑事件失败', error);
        }
    }
    if (panelTimer) {
        clearInterval(panelTimer);
        panelTimer = null;
    }
    try {
        ctx?.setExtensionPrompt?.(INJECT_KEY, '', 0, 0, false, 0);
    } catch (error) {
        console.warn(LOG_PREFIX, '清理注入失败', error);
    }
    for (const name of registeredMacros) {
        try {
            ctx?.unregisterMacro?.(name);
        } catch (error) {
            console.warn(LOG_PREFIX, `注销宏 ${name} 失败`, error);
        }
    }
    registeredMacros.length = 0;
    document.getElementById('stam-panel')?.remove();
    panel = null;
    initialized = false;
    listenersBound = false;
    console.log(LOG_PREFIX, '已卸载');
}

init().catch(error => console.error(LOG_PREFIX, '初始化失败', error));
