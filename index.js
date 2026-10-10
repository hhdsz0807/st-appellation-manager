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
    applyExtractToChatState,
    autoMapNames,
    buildNovelTable,
    buildParticipants,
    buildPatches,
    buildRelationGraph,
    chunkText,
    clearAllRelations,
    clearRelation,
    collectNames,
    composeInlineTable,
    composeNovelPromptBlock,
    composePromptBlock,
    createNovel,
    defaultSettings,
    exportBundle,
    exportNovel,
    findOrphanRelations,
    focusParticipantKey,
    getRelation,
    importBundle,
    lintRelations,
    listNovels,
    mergeExtractResults,
    newNovelId,
    normalizeChatState,
    normalizeNovel,
    normalizeNovels,
    normalizeSettings,
    novelGraphInput,
    novelTableToText,
    parseRelationKey,
    patchesToRelations,
    relationKey,
    resolveRelation,
    scanCandidates,
    setRelation as setRelationPure,
} from './core.js';
import { createCaller, createSingleFlight, fetchModelList, joinModelsUrl, pickDefaultModel, runExtraction, supportsChatCompletions } from './extract.js';
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

/**
 * 提取的运行态。故意只放内存：
 * 正文可能有几百 KB，塞进设置或聊天元数据会让每次存档都拖着一坨文本。
 * 代价是刷新页面后需要重新粘正文（提取出来的称呼表本身是持久化的）。
 * 正文按小说分开存，切换小说不会互相冲掉。
 */
const extractRuntime = {
    texts: new Map(),        // novelId -> 正文
    sourceNames: new Map(),  // novelId -> 文件名
    running: false,
    abortRequested: false,
    modelListLoading: false,
    modelListError: null,
    modelListUrl: '',
    modelListOk: '',
    progress: null,
    log: [],
    startedAt: 0,
};

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
 * 小说库
 *
 * 「先建立小说的称呼」——结果存在全局设置里，跟当前开着哪个聊天无关。
 * 聊天里要用的时候才做一次「名字 → 聊天角色」的映射，映射存在聊天里。
 * ------------------------------------------------------------------ */

function novelsState() {
    return getSettings().novels;
}

function activeNovelId() {
    return novelsState().activeId ?? null;
}

function activeNovel() {
    const store = novelsState();
    return store.activeId ? (store.items[store.activeId] ?? null) : null;
}

/** 取当前小说的正文（只读内存）。 */
function activeText() {
    const id = activeNovelId();
    return id ? (extractRuntime.texts.get(id) ?? '') : '';
}

function setActiveText(text, sourceName = '') {
    const id = activeNovelId();
    if (!id) return;
    extractRuntime.texts.set(id, String(text ?? ''));
    if (sourceName) extractRuntime.sourceNames.set(id, String(sourceName).slice(0, 200));
}

/** 直接替换小说库里的一部小说，并落盘。 */
function writeNovel(novel) {
    const settings = getSettings();
    const store = normalizeNovels(settings.novels);
    const clean = normalizeNovel({ ...novel, updatedAt: Date.now() });
    store.items[clean.id] = clean;
    if (!store.activeId) store.activeId = clean.id;
    settings.novels = store;
    saveSettings();
    return clean;
}

function removeNovel(id) {
    const settings = getSettings();
    const store = normalizeNovels(settings.novels);
    delete store.items[id];
    store.activeId = store.activeId === id ? (Object.keys(store.items)[0] ?? null) : store.activeId;
    settings.novels = store;
    saveSettings();
    extractRuntime.texts.delete(id);
    extractRuntime.sourceNames.delete(id);
}

/** 当前聊天里，这部小说的「人名 → 角色键」映射。 */
function chatMapping(novelId) {
    if (!novelId) return {};
    return readChatState().novelMapping?.[novelId] ?? {};
}

function writeChatMapping(novelId, name, key) {
    if (!novelId) return;
    const state = readChatState();
    const forNovel = { ...(state.novelMapping?.[novelId] ?? {}), [name]: key || null };
    writeChatState({ ...state, novelMapping: { ...state.novelMapping, [novelId]: forNovel } });
}

/**
 * 这部小说在当前聊天里的实际映射 = 同名自动对上的 + 用户手动改过的。
 * 手动值优先，所以自动匹配只是「默认值」，用户改一次就一直记住。
 */
function effectiveMapping(novel) {
    if (!novel) return {};
    const names = collectNames(novel.results);
    const manual = chatMapping(novel.id);
    const auto = autoMapNames(names, participantsOf());
    const out = {};
    for (const name of names) {
        out[name] = Object.prototype.hasOwnProperty.call(manual, name) ? manual[name] : (auto[name] ?? null);
    }
    return out;
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

    // 可选：把当前这部小说的原著称呼表也带上（人名级，不依赖聊天里有谁）。
    if (inject.enabled && settings.extract.injectNovel && text.length < inject.maxChars) {
        const novel = activeNovel();
        const novelBlock = novel ? composeNovelPromptBlock(novel, { maxChars: inject.maxChars - text.length }) : '';
        if (novelBlock) text = text ? `${text}\n\n${novelBlock}` : novelBlock;
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

    /* ---------------- 正文提取 ---------------- */

    /* ---------------- 小说库与正文提取 ---------------- */

    getExtractUiState() {
        const settings = getSettings();
        const novel = activeNovel();
        const novelId = novel?.id ?? null;
        return {
            novels: listNovels(settings.novels),
            activeId: novelId,
            novel,
            table: buildNovelTable(novel?.results ?? []),
            participants: participantsOf(),
            mapping: effectiveMapping(novel),
            running: extractRuntime.running,
            progress: extractRuntime.progress,
            log: extractRuntime.log.slice(-12),
            textChars: activeText().length,
            sourceName: extractRuntime.sourceNames.get(novelId) ?? '',
            injectNovel: Boolean(settings.extract.injectNovel),
            modelListLoading: extractRuntime.modelListLoading,
            modelListError: extractRuntime.modelListError,
            modelListUrl: extractRuntime.modelListUrl,
            modelListOk: extractRuntime.modelListOk,
        };
    },
    getExtractText() {
        return activeText();
    },
    setExtractText(text, sourceName = '') {
        setActiveText(text, sourceName);
    },
    getExtractSettings() {
        return getSettings().extract;
    },
    /** 开跑前先算清代价：要发几次请求、处理正文的哪一段。 */
    planExtract() {
        const extract = getSettings().extract;
        const text = activeText();
        const chunks = chunkText(text, {
            chunkChars: extract.chunkChars,
            maxChunks: extract.maxChunks,
            startOffset: extract.startOffset,
        });
        const first = chunks[0];
        const last = chunks[chunks.length - 1];
        return {
            requests: chunks.length,
            from: first ? first.start : 0,
            to: last ? last.end : 0,
            total: text.length,
            remaining: Math.max(0, text.length - (last ? last.end : 0)),
        };
    },
    setExtractOption(key, value) {
        const settings = getSettings();
        settings.extract = { ...settings.extract, [key]: value };
        saveSettings();
        refreshInjection();
    },
    setExtractCustom(key, value) {
        const settings = getSettings();
        const previous = settings.extract.custom?.[key];
        const custom = { ...settings.extract.custom, [key]: value };
        // 只有地址真的变了才清空模型列表——否则输入框每次失焦都会把列表清没，用户还得手动重拉
        if (key === 'baseUrl' && String(previous ?? '') !== String(value ?? '')) custom.models = [];
        settings.extract.custom = custom;
        saveSettings();
    },
    /**
     * 从端点拉模型列表，存进设置里给下拉用。
     * 用户永远不需要手打模型名——填了地址和密钥，这一步自动发生。
     *
     * 两条纪律（都是踩过的坑）：
     *  1. 同一时刻只允许一个在飞（createSingleFlight）：连点/自动+手动叠在一起会发多个请求，
     *     每个回来都重渲染一遍，看起来就是不停闪。
     *  2. modelListLoading 必须在最后一次渲染之前落回 false，否则界面会永远停在「正在拉取…」——
     *     模型其实已经拿到了，但没人再画一遍。
     *  另外只刷模型那一小块（renderModels），不重建整个提取区。
     */
    async refreshModelList({ silent = false } = {}) {
        const settings = getSettings();
        const custom = settings.extract.custom;
        if (!custom.baseUrl) {
            if (!silent) panel?.setStatus('先填端点地址');
            return { ok: false, error: '没填端点地址' };
        }
        return modelListFlight.run(() => fetchModelListOnce(custom, silent));
    },

    /* ---------------- 小说管理 ---------------- */

    /** 新建一部小说并切过去。 */
    createNovel(name) {
        const settings = getSettings();
        const store = normalizeNovels(settings.novels);
        const novel = createNovel(name || `小说 ${Object.keys(store.items).length + 1}`);
        store.items[novel.id] = novel;
        store.activeId = novel.id;
        settings.novels = store;
        saveSettings();
        extractRuntime.log = [];
        return novel;
    },
    setActiveNovel(id) {
        const settings = getSettings();
        const store = normalizeNovels(settings.novels);
        if (!store.items[id]) return false;
        store.activeId = id;
        settings.novels = store;
        saveSettings();
        extractRuntime.log = [];
        extractRuntime.progress = null;
        return true;
    },
    renameNovel(id, name) {
        const store = novelsState();
        const novel = store.items[id];
        if (!novel) return false;
        writeNovel({ ...novel, name: String(name ?? '').trim() || novel.name });
        return true;
    },
    deleteNovel(id) {
        if (!novelsState().items[id]) return false;
        removeNovel(id);
        return true;
    },
    setNovelInject(enabled) {
        const settings = getSettings();
        settings.extract = { ...settings.extract, injectNovel: Boolean(enabled) };
        saveSettings();
        refreshInjection();
    },
    getNovelTableText(options) {
        const novel = activeNovel();
        if (!novel) return '';
        return novelTableToText(buildNovelTable(novel.results), options);
    },
    exportNovelFile() {
        const novel = activeNovel();
        if (!novel) {
            panel?.setStatus('还没有小说可以导出');
            return;
        }
        downloadJson(exportNovel(novel), `novel-${safeFileName(novel.name)}.json`);
        panel?.setStatus(`已导出《${novel.name}》的称呼表`);
    },
    importNovelFile() {
        pickJsonFile(async text => {
            const result = importBundle(text);
            if (!result.novel) throw new Error('这个文件里没有小说数据');
            const settings = getSettings();
            const store = normalizeNovels(settings.novels);
            // 导入的新小说换一个 id，避免覆盖同名小说
            const incoming = { ...result.novel, id: newNovelId() };
            store.items[incoming.id] = incoming;
            store.activeId = incoming.id;
            settings.novels = store;
            saveSettings();
            panel?.render();
            panel?.setStatus(`已导入《${incoming.name}》，${incoming.results.length} 条原始称呼`);
        });
    },
    /** 把称呼表以 Markdown 表格复制到剪贴板。 */
    async copyNovelTable() {
        const text = api.getNovelTableText({ withEvidence: false });
        if (!text) {
            panel?.setStatus('当前小说还没有称呼表');
            return false;
        }
        try {
            await navigator.clipboard.writeText(text);
            panel?.setStatus('称呼表已复制到剪贴板，可以直接粘进世界书或角色卡');
            return true;
        } catch (error) {
            console.warn(LOG_PREFIX, '复制失败', error);
            panel?.setStatus('浏览器不让直接写剪贴板，用「导出 JSON」或手动选中表格复制');
            return false;
        }
    },

    /* ---------------- 应用到当前聊天 ---------------- */

    setMapping(name, key) {
        writeChatMapping(activeNovelId(), name, key);
    },

    /* ---------------- 关系图 ---------------- */

    /** 当前聊天的关系图模型：以 centerKey 为圆心。 */
    getGraphModel(centerKey) {
        const settings = getSettings();
        return buildRelationGraph({
            participants: participantsOf(),
            chatState: readChatState(),
            library: settings.library,
            centerKey,
        });
    },
    /** 当前小说称呼表的关系图模型（纯人名级，没有「用户」）。 */
    getNovelGraphModel(centerKey) {
        const table = buildNovelTable(activeNovel()?.results ?? []);
        return buildRelationGraph({ ...novelGraphInput(table), chatState: null, centerKey });
    },
    /** 默认圆心：当前正在说话的那个角色，单聊里就是这张卡。 */
    defaultGraphCenter() {
        const ctx = host();
        const participants = participantsOf();
        return focusParticipantKey(participants, ctx?.name2) ?? participants[0]?.key ?? null;
    },
    setUiOption(key, value) {
        const settings = getSettings();
        settings.ui = { ...settings.ui, [key]: value };
        saveSettings();
    },
    abortExtract() {
        if (!extractRuntime.running) return;
        extractRuntime.abortRequested = true;
        logExtract('已请求中止，等当前这块收尾…');
        try {
            host()?.stopGeneration?.();
        } catch (error) {
            console.warn(LOG_PREFIX, '中止请求失败', error);
        }
        panel?.renderExtract();
    },

    async startExtract() {
        if (extractRuntime.running) return { started: false, reason: '已经在跑了' };
        const ctx = host();
        if (!ctx) return { started: false, reason: '取不到酒馆上下文' };

        let extract = getSettings().extract;
        if (extract.mode === 'custom' && !extract.custom.model) {
            // 还没选模型就先去拉一次，绝不逼用户手打模型名
            const pulled = await api.refreshModelList({ silent: true });
            if (!pulled.ok) {
                return { started: false, reason: `没法自动确定模型名：${pulled.error}。检查一下端点地址和密钥。` };
            }
            extract = getSettings().extract;
        }
        if (extract.mode === 'custom' && extract.custom.noChat?.includes(extract.custom.model)) {
            return {
                started: false,
                reason: `「${extract.custom.model}」在这个端点上不支持 /chat/completions（只支持别的格式），换一个模型。`,
            };
        }
        if (!activeNovel()) {
            // 没有小说就直接建一部，省掉「先点新建」这一步。
            const created = api.createNovel(deriveNovelName());
            panel?.setStatus(`已新建《${created.name}》`);
        }
        const text = activeText();
        if (!text.trim()) return { started: false, reason: '先粘贴正文或导入 txt 文件' };

        const plan = api.planExtract();
        if (!plan.requests) return { started: false, reason: '这个起始位置已经超过正文长度了' };

        const modelLabel = extract.mode === 'custom'
            ? `自定义端点 ${extract.custom.model || '（未填模型名）'}`
            : '酒馆当前连接';
        const confirmed = window.confirm(
            `要发 ${plan.requests} 次模型请求，处理第 ${plan.from}–${plan.to} 字（正文共 ${plan.total} 字）。\n`
            + `模型：${modelLabel}\n\n每次请求都会真的调用模型。继续？`,
        );
        if (!confirmed) return { started: false, reason: '已取消' };

        let caller;
        try {
            caller = createCaller(extract, ctx, { maxTokens: 1600 });
        } catch (error) {
            return { started: false, reason: `模型配置有问题：${error.message}` };
        }

        extractRuntime.running = true;
        extractRuntime.abortRequested = false;
        extractRuntime.startedAt = Date.now();
        extractRuntime.log = [];
        extractRuntime.progress = { done: 0, total: plan.requests };
        panel?.renderExtract();

        let outcome;
        try {
            outcome = await runExtraction({
                text,
                opts: {
                    chunkChars: extract.chunkChars,
                    maxChunks: extract.maxChunks,
                    startOffset: extract.startOffset,
                },
                caller,
                shouldAbort: () => extractRuntime.abortRequested,
                onProgress: progress => {
                    if (progress.total) {
                        extractRuntime.progress = { done: progress.done ?? 0, total: progress.total };
                    }
                    describeProgress(progress);
                    panel?.renderExtract();
                },
            });
        } catch (error) {
            console.error(LOG_PREFIX, '提取过程出错', error);
            logExtract(`出错：${error?.message ?? error}`);
            extractRuntime.running = false;
            panel?.renderExtract();
            return { started: false, reason: `提取失败：${error?.message ?? error}` };
        }

        extractRuntime.running = false;

        // 新结果并进这部小说已有的结果里（分几次跑完整本书时不会互相覆盖）。
        const novel = activeNovel();
        const merged = mergeExtractResults([novel?.results ?? [], outcome.results]);
        const saved = writeNovel({
            ...(novel ?? {}),
            sourceName: extractRuntime.sourceNames.get(novel?.id) ?? novel?.sourceName ?? '',
            sourceChars: text.length,
            chunksDone: extractRuntime.progress?.done ?? 0,
            chunksTotal: outcome.chunks,
            nextOffset: outcome.nextOffset,
            results: merged,
            notes: outcome.failures.slice(0, 5).map(f => `第 ${f.index + 1} 块失败：${f.error}`),
        });

        const table = buildNovelTable(saved.results);
        const names = collectNames(saved.results);
        logExtract(`本轮结束：新增 ${outcome.results.length} 条，合计 ${merged.length} 条原始称呼，整理成 ${table.length} 对关系的称呼表`);
        panel?.render();
        return {
            started: true,
            results: merged.length,
            pairs: table.length,
            names: names.length,
            failures: outcome.failures.length,
            aborted: outcome.aborted,
            stoppedEarly: outcome.stoppedEarly,
            nextOffset: outcome.nextOffset,
            novelName: saved.name,
        };
    },

    /** 把当前小说里已映射上的称呼写进本聊天的关系表。原来手填的关系会被同键覆盖，其余保留。 */
    applyExtract() {
        const novel = activeNovel();
        if (!novel?.results.length) return { applied: 0, unmapped: [] };
        const mapping = effectiveMapping(novel);
        const state = readChatState();
        const unmapped = collectNames(novel.results).filter(n => !mapping[n]);
        const next = applyExtractToChatState(state, novel.results, mapping);
        writeChatState(next);
        refreshInjection();
        return {
            applied: patchesToRelations(buildPatches(novel.results, mapping)).length,
            unmapped,
        };
    },

    /** 把当前小说的称呼表存进全局默认库，别的聊天不用再映射也能用。 */
    saveExtractToLibrary() {
        const novel = activeNovel();
        if (!novel?.results.length) return 0;
        const relations = patchesToRelations(buildPatches(novel.results, effectiveMapping(novel)));
        if (!relations.length) return 0;
        const settings = getSettings();
        const library = { ...settings.library };
        for (const rel of relations) {
            library[relationKey(rel.from, rel.to)] = {
                call: rel.call,
                aliases: rel.aliases,
                stage: '',
                note: '',
            };
        }
        settings.library = library;
        saveSettings();
        refreshInjection();
        return relations.length;
    },

    /** 清空当前小说的提取结果（保留小说条目本身）。 */
    clearExtract() {
        const novel = activeNovel();
        if (!novel) return;
        writeNovel({ ...novel, results: [], chunksDone: 0, chunksTotal: 0, nextOffset: 0, notes: [] });
        panel?.render();
    },
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 新建小说时给个有信息量的默认名，省得用户对着一串「未命名」发呆。 */
function deriveNovelName() {
    const name = extractRuntime.sourceNames.get(activeNovelId());
    if (name) return String(name).replace(/\.[^.]+$/, '').slice(0, 60);
    return `小说 ${new Date().toLocaleDateString('zh-CN')}`;
}

function safeFileName(name) {
    return String(name ?? 'novel').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'novel';
}

function downloadJson(data, fileName) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function pickJsonFile(onText) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            await onText(await file.text());
        } catch (error) {
            console.error(LOG_PREFIX, '导入失败', error);
            panel?.setStatus(`导入失败：${error.message}`);
        }
    });
    input.click();
}

/** 提取日志只留最近 200 行，够回溯就行。 */
function logExtract(line) {
    extractRuntime.log.push(line);
    if (extractRuntime.log.length > 200) extractRuntime.log.splice(0, extractRuntime.log.length - 200);
}

/** 拉模型列表的单飞闸门：同一时刻只允许一个在飞。 */
const modelListFlight = createSingleFlight();

async function fetchModelListOnce(custom, silent) {
    extractRuntime.modelListUrl = joinModelsUrl(custom.baseUrl);
    extractRuntime.modelListError = null;
    extractRuntime.modelListLoading = true;
    panel?.renderModels?.();

    try {
        const list = await fetchModelList({ baseUrl: custom.baseUrl, apiKey: custom.apiKey });
        // list 已经按「能走 /chat/completions 的排前面」排好
        const models = list.map(m => m.id);
        const noChat = list.filter(m => !supportsChatCompletions(m)).map(m => m.id);
        const settings = getSettings();
        const model = pickDefaultModel(models, settings.extract.custom.model, { noChat });
        settings.extract.custom = { ...settings.extract.custom, models, noChat, model };
        saveSettings();
        extractRuntime.modelListError = null;
        extractRuntime.modelListOk = `成功，${models.length} 个模型`;
        if (!silent) {
            panel?.setStatus(noChat.length
                ? `拉到 ${models.length} 个模型（其中 ${noChat.length} 个不支持 /chat/completions），已选「${model}」`
                : `拉到 ${models.length} 个模型，已选「${model}」`);
        }
        return { ok: true, models, model, noChat };
    } catch (error) {
        extractRuntime.modelListError = String(error?.message ?? error);
        extractRuntime.modelListOk = '';
        console.error(LOG_PREFIX, '拉模型列表失败', extractRuntime.modelListUrl, error);
        if (!silent) panel?.setStatus(`拉模型列表失败：${extractRuntime.modelListError}`);
        return { ok: false, error: extractRuntime.modelListError, url: extractRuntime.modelListUrl };
    } finally {
        // 顺序要紧：先把 loading 落回 false，再渲染，界面才拿得到「已经拉完」的最终状态
        extractRuntime.modelListLoading = false;
        panel?.renderModels?.();
    }
}

function describeProgress(progress) {
    switch (progress.phase) {
        case 'begin':
            logExtract(`开始：切成 ${progress.total} 块`);
            break;
        case 'chunk':
            logExtract(`第 ${progress.index + 1}/${progress.total} 块（第 ${progress.start}–${progress.end} 字）…`);
            break;
        case 'ok':
            logExtract(`第 ${progress.index + 1}/${progress.total} 块 ✓ 抽到 ${progress.got} 条`);
            break;
        case 'badjson':
            logExtract(`第 ${progress.index + 1}/${progress.total} 块 ✗ ${progress.error}`);
            break;
        case 'fail':
            logExtract(`第 ${progress.index + 1}/${progress.total} 块 ✗ ${progress.error}`);
            break;
        case 'stoppedEarly':
            logExtract(`连续失败 ${progress.failures.length} 次，提前停下，不再继续烧请求`);
            break;
        default:
            break;
    }
}

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
    const refreshLight = () => {
        refreshInjection();
        panel?.renderLight();
    };
    // 聊天换了、群成员变了：整块重建
    for (const name of ['CHAT_CHANGED', 'GROUP_UPDATED', 'CHARACTER_EDITED']) {
        const type = types[name];
        if (!type) continue;
        events.on(type, refreshAll);
        boundListeners.push({ eventBus: events, type, handler: refreshAll });
    }
    // 收发消息、生成前：只轻量刷新，别打断正在编辑关系的人
    for (const name of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'GENERATION_AFTER_COMMANDS']) {
        const type = types[name];
        if (!type) continue;
        events.on(type, refreshLight);
        boundListeners.push({ eventBus: events, type, handler: refreshLight });
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
