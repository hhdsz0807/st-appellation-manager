/**
 * 称呼管理器 · 界面层
 *
 * 只负责把数据画出来、把用户操作交给 api；不直接读写酒馆状态。
 * 所有 id / class 都带 stam- 前缀，避免和别的扩展撞车。
 */

const STAGE_SUGGESTIONS = ['初见', '认识', '熟悉', '亲密', '恋人', '家人', '搭档', '敌对', '决裂'];

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
        else node.setAttribute(key, String(value));
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function field(labelText, control, hint) {
    return el('label', { class: 'stam-field' }, [
        el('span', { class: 'stam-field-label', text: labelText }),
        control,
        hint ? el('span', { class: 'stam-hint', text: hint }) : null,
    ]);
}

function checkbox(labelText, checked, onChange, title) {
    const input = el('input', { type: 'checkbox', checked: checked ? 'checked' : null, title: title ?? null });
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'stam-check' }, [input, el('span', { text: labelText })]);
}

function button(labelText, onClick, extraClass = '') {
    return el('button', {
        class: `stam-btn ${extraClass}`.trim(),
        type: 'button',
        text: labelText,
        onclick: onClick,
    });
}

/**
 * 「从正文提取称呼」区块。
 * 流程：粘正文 → 调模型逐块抽 → 把小说人名映射到当前聊天的角色 → 一键写成称呼表。
 */
function createExtractSection(api, setStatus) {
    const ui = { sourceName: '' };

    /* ---------- 正文输入 ---------- */

    const textarea = el('textarea', {
        id: 'stam-extract-text',
        class: 'stam-textarea',
        rows: '6',
        placeholder: '把小说正文粘贴到这里，或点下面的按钮导入 .txt / .md 文件。\n\n正文只留在浏览器内存里，不会写进聊天记录——刷新页面后需要重新粘贴（提取出来的结果会保留）。',
    });
    textarea.value = api.getExtractText();
    textarea.addEventListener('input', () => {
        api.setExtractText(textarea.value, ui.sourceName);
        updatePlan();
    });

    const fileInput = el('input', { type: 'file', accept: '.txt,.md,text/plain', style: { display: 'none' } });
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            textarea.value = text;
            ui.sourceName = file.name;
            api.setExtractText(text, file.name);
            updatePlan();
            setStatus(`已读入 ${file.name}（${text.length} 字）`);
        } catch (error) {
            setStatus(`读文件失败：${error.message}`);
        }
    });

    /* ---------- 模型来源 ---------- */

    const settings0 = api.getExtractSettings();

    const modeSelect = el('select', { id: 'stam-extract-mode' }, [
        el('option', { value: 'st', text: '酒馆当前连接（推荐）' }),
        el('option', { value: 'custom', text: '自定义 OpenAI 兼容端点' }),
    ]);
    modeSelect.value = settings0.mode;
    modeSelect.addEventListener('change', () => {
        api.setExtractOption('mode', modeSelect.value);
        syncMode();
    });

    const baseUrlInput = el('input', { type: 'text', id: 'stam-extract-baseurl', placeholder: 'https://api.example.com/v1' });
    baseUrlInput.value = settings0.custom.baseUrl;
    baseUrlInput.addEventListener('change', () => api.setExtractCustom('baseUrl', baseUrlInput.value.trim()));

    const modelInput = el('input', { type: 'text', id: 'stam-extract-model', placeholder: '模型名，例如 deepseek-chat' });
    modelInput.value = settings0.custom.model;
    modelInput.addEventListener('change', () => api.setExtractCustom('model', modelInput.value.trim()));

    const apiKeyInput = el('input', { type: 'password', id: 'stam-extract-apikey', placeholder: 'API Key（明文存在酒馆设置里）', autocomplete: 'off' });
    apiKeyInput.value = settings0.custom.apiKey;
    apiKeyInput.addEventListener('change', () => api.setExtractCustom('apiKey', apiKeyInput.value.trim()));

    const customBox = el('div', { class: 'stam-grid' }, [
        field('端点地址', baseUrlInput),
        field('模型名', modelInput),
        field('API Key', apiKeyInput),
    ]);

    /* ---------- 分块 ---------- */

    const chunkInput = el('input', { type: 'number', min: '200', max: '20000', step: '100', id: 'stam-extract-chunk' });
    chunkInput.value = String(settings0.chunkChars);
    chunkInput.addEventListener('change', () => {
        api.setExtractOption('chunkChars', Number(chunkInput.value));
        updatePlan();
    });

    const maxChunksInput = el('input', { type: 'number', min: '1', max: '200', step: '1', id: 'stam-extract-maxchunks' });
    maxChunksInput.value = String(settings0.maxChunks);
    maxChunksInput.addEventListener('change', () => {
        api.setExtractOption('maxChunks', Number(maxChunksInput.value));
        updatePlan();
    });

    const offsetInput = el('input', { type: 'number', min: '0', step: '100', id: 'stam-extract-offset' });
    offsetInput.value = String(settings0.startOffset);
    offsetInput.addEventListener('change', () => {
        api.setExtractOption('startOffset', Number(offsetInput.value));
        updatePlan();
    });

    const planHint = el('div', { class: 'stam-hint', id: 'stam-extract-plan' });

    /* ---------- 运行 ---------- */

    const runBtn = button('开始提取', async () => {
        runBtn.disabled = true;
        setStatus('提取中…');
        const result = await api.startExtract();
        runBtn.disabled = false;
        if (!result.started) {
            setStatus(result.reason ?? '没有开始');
            return;
        }
        const bits = [`《${result.novelName}》整理出 ${result.pairs} 对关系的称呼表`];
        if (result.failures) bits.push(`${result.failures} 块失败`);
        if (result.aborted) bits.push('（已中止）');
        if (result.stoppedEarly) bits.push('（连续失败，提前停了）');
        setStatus(`提取完成：${bits.join('，')}。`);
    });

    const abortBtn = button('中止', () => api.abortExtract(), 'stam-danger');
    abortBtn.disabled = true;

    const progressBar = el('div', { class: 'stam-progress-fill' });
    const progressWrap = el('div', { class: 'stam-progress' }, [progressBar]);
    const progressText = el('div', { class: 'stam-hint' });
    const logBox = el('div', { class: 'stam-log' });

    /* ---------- 结果 ---------- */

    const resultBox = el('div', { class: 'stam-extract-results' });
    const mappingBox = el('div', { class: 'stam-mapping' });

    const actions = el('div', { class: 'stam-toolbar' }, [
        button('写进当前聊天的称呼表', () => {
            const outcome = api.applyExtract();
            if (!outcome.applied) {
                setStatus('没有可写的行——先看上面的映射，把「未映射」的名字对上。');
                return;
            }
            setStatus(`已写入 ${outcome.applied} 对关系${outcome.unmapped.length ? `；${outcome.unmapped.length} 个名字没映射，已跳过：${outcome.unmapped.join('、')}` : ''}`);
            render();
        }),
        button('存为全局默认库', () => {
            const count = api.saveExtractToLibrary();
            setStatus(count ? `已把 ${count} 对关系存进全局默认库，别的聊天不用映射也能用` : '没有可存的关系（先完成名字映射）');
            render();
        }),
        button('清空本小说的称呼表', () => {
            if (!window.confirm('清空这部小说提取出来的全部称呼？（小说条目保留，已写进聊天的关系不受影响）')) return;
            api.clearExtract();
            setStatus('已清空称呼表');
            render();
        }, 'stam-danger'),
    ]);

    /* ---------- 小说库工具栏 ---------- */

    const novelSelect = el('select', { id: 'stam-novel-select', class: 'stam-novel-select' });
    novelSelect.addEventListener('change', () => {
        api.setActiveNovel(novelSelect.value);
        const text = api.getExtractText();
        textarea.value = text;
        setStatus('已切换小说');
        render();
    });

    const newNovelBtn = button('新建', () => {
        const name = window.prompt('新小说的名字（比如书名）', '');
        if (name === null) return;
        api.createNovel(name.trim());
        textarea.value = api.getExtractText();
        setStatus('已新建小说');
        render();
    });
    const renameNovelBtn = button('重命名', () => {
        const state = api.getExtractUiState();
        if (!state.novel) return;
        const name = window.prompt('新的名字', state.novel.name);
        if (name === null) return;
        api.renameNovel(state.novel.id, name.trim());
        render();
    });
    const deleteNovelBtn = button('删除', () => {
        const state = api.getExtractUiState();
        if (!state.novel) return;
        if (!window.confirm(`删除《${state.novel.name}》？提取出来的称呼表会一起没掉。`)) return;
        api.deleteNovel(state.novel.id);
        textarea.value = api.getExtractText();
        setStatus('已删除小说');
        render();
    }, 'stam-danger');

    const injectNovelCheck = el('input', { type: 'checkbox', id: 'stam-inject-novel' });
    injectNovelCheck.addEventListener('change', () => {
        api.setNovelInject(injectNovelCheck.checked);
        setStatus(injectNovelCheck.checked ? '已开启：原著称呼表会一起注入提示词' : '已关闭原著称呼表注入');
    });

    const novelToolbar = el('div', { class: 'stam-toolbar' }, [
        el('span', { class: 'stam-hint', text: '小说：' }),
        novelSelect,
        newNovelBtn,
        renameNovelBtn,
        deleteNovelBtn,
    ]);

    /* ---------- 组装 ---------- */

    const root = el('fieldset', { class: 'stam-box', id: 'stam-extract-box' }, [
        el('legend', { text: '小说称呼库' }),
        el('div', { class: 'stam-hint', text: '先在这里把小说的称呼建立起来——跟当前开着哪个聊天无关，建好了以后哪个聊天都能拿来用。' }),
        novelToolbar,
        el('details', { class: 'stam-extract', open: 'open' }, [
            el('summary', { text: '导入正文并提取' }),
            el('div', { class: 'stam-extract-body' }, [
                textarea,
                el('div', { class: 'stam-toolbar' }, [
                    button('导入 txt / md 文件', () => fileInput.click()),
                    button('清空正文', () => {
                        textarea.value = '';
                        ui.sourceName = '';
                        api.setExtractText('', '');
                        updatePlan();
                    }),
                    fileInput,
                ]),
                field('用哪个模型', modeSelect, '「酒馆当前连接」= 你已经在酒馆里配好的那个模型，不用再填密钥'),
                customBox,
                el('div', { class: 'stam-grid' }, [
                    field('每块字数', chunkInput, '越大越省请求，但模型容易看漏'),
                    field('最多几块', maxChunksInput, '一次最多发几次请求'),
                    field('从第几个字开始', offsetInput, '长篇分几次跑时用'),
                ]),
                planHint,
                el('div', { class: 'stam-toolbar' }, [runBtn, abortBtn]),
                progressWrap,
                progressText,
                logBox,
            ]),
        ]),
        el('div', { class: 'stam-subtitle' }, [
            el('span', { text: '称呼表' }),
            el('span', { class: 'stam-hint', id: 'stam-table-count' }),
        ]),
        el('div', { class: 'stam-toolbar' }, [
            button('复制表格', () => api.copyNovelTable()),
            button('导出本小说 JSON', () => api.exportNovelFile()),
            button('导入小说 JSON', () => api.importNovelFile()),
            el('label', { class: 'stam-check' }, [injectNovelCheck, el('span', { text: '把这张表一起注入提示词' })]),
        ]),
        resultBox,
        el('details', { class: 'stam-extract' }, [
            el('summary', { text: '把这个称呼表用到当前聊天（可选）' }),
            el('div', { class: 'stam-extract-body' }, [
                el('div', {
                    class: 'stam-hint',
                    text: '小说的名字和聊天里的人不一定对得上，所以这里做一次映射。同名会自动对上，你只需要改错的那些。',
                }),
                mappingBox,
                actions,
            ]),
        ]),
    ]);

    /* ---------- 行为 ---------- */

    function syncMode() {
        customBox.style.display = modeSelect.value === 'custom' ? '' : 'none';
    }

    function updatePlan() {
        const plan = api.planExtract();
        if (!String(api.getExtractText()).trim()) {
            planHint.textContent = '还没有正文。粘贴或导入之后，这里会先告诉你要发几次请求。';
            return;
        }
        if (!plan.requests) {
            planHint.textContent = `起始位置（第 ${offsetInput.value} 字）已经超过正文长度（${plan.total} 字），把起始位置改小。`;
            return;
        }
        planHint.textContent = `计划：发送 ${plan.requests} 次请求，处理第 ${plan.from}–${plan.to} 字；正文共 ${plan.total} 字，之后还剩 ${plan.remaining} 字。`;
    }

    function renderProgress(state) {
        if (state.running && state.progress) {
            const pct = state.progress.total ? Math.round((state.progress.done / state.progress.total) * 100) : 0;
            progressBar.style.width = `${pct}%`;
            progressText.textContent = `进行中：第 ${state.progress.done}/${state.progress.total} 块（${pct}%）`;
            progressWrap.style.display = '';
        } else if (state.novel?.chunksTotal) {
            progressBar.style.width = '100%';
            progressText.textContent = `上次跑了 ${state.novel.chunksDone}/${state.novel.chunksTotal} 块。`;
            progressWrap.style.display = '';
        } else {
            progressWrap.style.display = 'none';
            progressText.textContent = '';
        }
        runBtn.disabled = state.running;
        abortBtn.disabled = !state.running;
    }

    function renderLog(state) {
        logBox.textContent = '';
        if (!state.log.length) return;
        for (const line of state.log) {
            logBox.append(el('div', { class: 'stam-log-line', text: line }));
        }
    }

    function renderResults(state) {
        resultBox.textContent = '';
        const table = state.table ?? [];
        const countLabel = document.getElementById('stam-table-count');
        if (countLabel) {
            countLabel.textContent = table.length
                ? `共 ${table.length} 对关系，来自 ${state.novel?.results?.length ?? 0} 条原始记录`
                : '';
        }
        if (!table.length) {
            resultBox.append(el('div', {
                class: 'stam-hint',
                text: state.novel ? '这部小说还没有称呼。粘正文进来跑一次提取。' : '还没有小说。点上面「新建」，或直接粘正文跑提取（会自动建一部）。',
            }));
            return;
        }
        resultBox.append(el('div', { class: 'stam-x-rows' }, [
            el('div', { class: 'stam-x-row stam-x-head' }, [
                el('div', { text: '称呼方 → 被称呼方' }),
                el('div', { text: '称呼' }),
                el('div', { text: '命中/置信' }),
                el('div', { text: '别名' }),
            ]),
            ...table.slice(0, 400).map(row => el('div', { class: 'stam-x-row' }, [
                el('div', { class: 'stam-pair' }, [
                    el('span', { text: row.from }),
                    el('span', { class: 'stam-arrow', text: '→' }),
                    el('span', { text: row.to }),
                ]),
                el('strong', { text: row.call }),
                el('div', { class: 'stam-hint', text: `${row.count} 块 / ${(row.confidence * 100).toFixed(0)}%` }),
                el('div', { class: 'stam-hint', text: (row.aliases ?? []).join('、') }),
            ])),
        ]));
        if (table.length > 400) {
            resultBox.append(el('div', { class: 'stam-hint', text: `还有 ${table.length - 400} 条未显示（复制表格或导出 JSON 能拿到全部）。` }));
        }
        const withEvidence = table.find(row => row.evidence?.length);
        if (withEvidence) {
            resultBox.append(el('details', { class: 'stam-help' }, [
                el('summary', { text: '看几条原文证据（核对模型有没有编）' }),
                el('div', {}, table.filter(r => r.evidence?.length).slice(0, 12).map(row =>
                    el('div', { class: 'stam-hint', text: `${row.from} → ${row.to}「${row.call}」：${row.evidence[0]}` }))),
            ]));
        }
    }

    function renderMapping(state) {
        mappingBox.textContent = '';
        const names = [...new Set((state.table ?? []).flatMap(row => [row.from, row.to]))];
        if (!names.length) {
            mappingBox.append(el('div', { class: 'stam-hint', text: '称呼表还是空的。' }));
            return;
        }
        const participants = state.participants ?? [];
        if (participants.length < 2) {
            mappingBox.append(el('div', { class: 'stam-hint', text: '当前没有打开聊天，写不进去。先打开一张卡或一个群聊。' }));
            return;
        }
        const user = participants.find(p => p.kind === 'user');
        const mapped = names.filter(n => state.mapping?.[n]).length;
        mappingBox.append(el('div', { class: 'stam-hint', text: `已对上 ${mapped}/${names.length} 个名字。代词（我/你/他）不会自动映射——小说里的「我」多半是主角，不是你。` }));
        for (const name of names) {
            const options = [
                el('option', { value: '', text: '不映射' }),
                ...(user ? [el('option', { value: user.key, text: `用户：${user.name}` })] : []),
                ...participants.filter(p => p.kind === 'character').map(p => el('option', { value: p.key, text: p.name })),
            ];
            const select = el('select', { class: 'stam-map-select' }, options);
            select.value = state.mapping?.[name] ?? '';
            select.addEventListener('change', () => {
                api.setMapping(name, select.value);
                render();
            });
            const ok = Boolean(state.mapping?.[name]);
            mappingBox.append(el('div', { class: `stam-map-row${ok ? '' : ' stam-x-unmapped'}` }, [
                el('span', { class: 'stam-map-name', text: name }),
                select,
            ]));
        }
    }

    function render() {
        const state = api.getExtractUiState();
        syncMode();
        renderNovelPicker(state);
        injectNovelCheck.checked = Boolean(state.injectNovel);
        renderProgress(state);
        renderLog(state);
        renderResults(state);
        renderMapping(state);
        updatePlan();
    }

    function renderNovelPicker(state) {
        const novels = state.novels ?? [];
        novelSelect.textContent = '';
        if (!novels.length) {
            novelSelect.append(el('option', { value: '', text: '（还没有小说）' }));
            novelSelect.disabled = true;
        } else {
            novelSelect.disabled = false;
            for (const novel of novels) {
                novelSelect.append(el('option', {
                    value: novel.id,
                    text: `${novel.name}（${novel.results.length} 条）`,
                }));
            }
            novelSelect.value = state.activeId ?? '';
        }
        const hasNovel = Boolean(state.novel);
        renameNovelBtn.disabled = !hasNovel;
        deleteNovelBtn.disabled = !hasNovel;
    }

    syncMode();
    render();
    return { root, render };
}

export function createPanel(api) {
    const state = {
        collapsed: false,
        filter: 'all',       // all | user | focus
        candidates: [],
        issues: [],
        status: '',
    };

    /* ---------------- 注入设置 ---------------- */

    const injectToggle = el('input', { type: 'checkbox', id: 'stam-inject-enabled' });
    injectToggle.addEventListener('change', () => {
        api.setInjectOption('enabled', injectToggle.checked);
        setStatus(injectToggle.checked ? '已开启提示词注入' : '已关闭提示词注入');
    });

    const positionSelect = el('select', { id: 'stam-inject-position' }, [
        el('option', { value: '0', text: '主提示内（system 区）' }),
        el('option', { value: '1', text: '对话内（按深度插入）' }),
        el('option', { value: '2', text: '主提示前' }),
    ]);
    positionSelect.addEventListener('change', () => api.setInjectOption('position', Number(positionSelect.value)));

    const depthInput = el('input', { type: 'number', min: '0', max: '100', step: '1', id: 'stam-inject-depth' });
    depthInput.addEventListener('change', () => api.setInjectOption('depth', Number(depthInput.value)));

    const roleSelect = el('select', { id: 'stam-inject-role' }, [
        el('option', { value: '0', text: 'system' }),
        el('option', { value: '1', text: 'user' }),
        el('option', { value: '2', text: 'assistant' }),
    ]);
    roleSelect.addEventListener('change', () => api.setInjectOption('role', Number(roleSelect.value)));

    const targetsSelect = el('select', { id: 'stam-inject-targets' }, [
        el('option', { value: 'all', text: '全部关系' }),
        el('option', { value: 'user', text: '只含与用户相关的称呼' }),
        el('option', { value: 'focus', text: '只含当前角色相关的称呼' }),
    ]);
    targetsSelect.addEventListener('change', () => api.setInjectOption('targets', targetsSelect.value));

    const injectOptions = el('div', { class: 'stam-grid' }, [
        field('注入位置', positionSelect),
        field('深度', depthInput, '仅「对话内」位置生效'),
        field('消息角色', roleSelect),
        field('范围', targetsSelect),
    ]);

    const injectChecks = el('div', { class: 'stam-checks' }, [
        checkbox('带别名', true, v => api.setInjectOption('includeAliases', v)),
        checkbox('带关系阶段', true, v => api.setInjectOption('includeStage', v)),
        checkbox('带备注', false, v => api.setInjectOption('includeNote', v)),
        checkbox('带表头说明', true, v => api.setInjectOption('header', v)),
        checkbox('带兜底规则', true, v => api.setInjectOption('fallbackRule', v)),
    ]);
    const injectCheckInputs = [...injectChecks.querySelectorAll('input')];

    const injectBox = el('fieldset', { class: 'stam-box', id: 'stam-inject-box' }, [
        el('legend', {}, [
            injectToggle,
            el('span', { text: ' 提示词注入（把称呼表送进模型）' }),
        ]),
        injectOptions,
        injectChecks,
        el('div', { class: 'stam-hint', text: '只影响送进模型的提示词，不会修改你已有的聊天记录。' }),
    ]);

    /* ---------------- 关系表 ---------------- */

    const relationsBox = el('div', { class: 'stam-relations' });

    const filterBar = el('div', { class: 'stam-toolbar' }, [
        el('span', { class: 'stam-hint', text: '查看：' }),
        ...[
            ['all', '全部'],
            ['user', '与用户相关'],
            ['focus', '与当前角色相关'],
        ].map(([value, label]) => el('button', {
            class: 'stam-chip',
            type: 'button',
            text: label,
            dataset: { filter: value },
            onclick: () => { state.filter = value; render(); },
        })),
    ]);

    /* ---------------- 候选与检查 ---------------- */

    const candidateBox = el('div', { class: 'stam-candidates' });
    const issueBox = el('div', { class: 'stam-issues' });

    const statusLine = el('div', { class: 'stam-status', id: 'stam-status' });

    const toolbar = el('div', { class: 'stam-toolbar' }, [
        button('扫描候选称呼', async () => {
            setStatus('扫描中…');
            const found = await api.scan();
            state.candidates = found;
            setStatus(found.length ? `扫到 ${found.length} 条候选` : '最近聊天里没扫到新候选');
            render();
        }),
        button('一致性检查', async () => {
            setStatus('检查中…');
            state.issues = await api.lint();
            setStatus(state.issues.length ? `发现 ${state.issues.length} 条提示` : '没有发现问题');
            render();
        }),
        button('导出 JSON', () => api.exportJSON()),
        button('导入 JSON', () => api.importJSON()),
        button('清空本聊天称呼', () => {
            if (window.confirm('确定清空本聊天登记的全部称呼关系？（不影响全局默认库，也不改聊天记录）')) {
                api.clearAll();
                setStatus('已清空本聊天的称呼关系');
                render();
            }
        }, 'stam-danger'),
    ]);

    const helpBox = el('details', { class: 'stam-help' }, [
        el('summary', { text: '可用宏与命令' }),
        el('div', { class: 'stam-hint' }, [
            el('div', { text: '宏（写在世界书/角色卡/快捷回复里，生成时自动替换）：' }),
            el('ul', {}, [
                el('li', { text: '{{call::源::目标}} —— 源对目标的称呼，源/目标可写角色名或「用户」' }),
                el('li', { text: '{{callAlias::源::目标}} —— 别名列表，逗号分隔' }),
                el('li', { text: '{{callTable}} —— 当前聊天的整张称呼表（单行）' }),
            ]),
            el('div', { text: '斜杠命令：' }),
            el('ul', {}, [
                el('li', { text: '/appellation list —— 列出当前聊天登记的称呼' }),
                el('li', { text: '/appellation set 源 目标 称呼 —— 设置一条称呼' }),
                el('li', { text: '/appellation del 源 目标 —— 删除一条称呼' }),
            ]),
        ]),
    ]);

    /* ---------------- 组装 ---------------- */

    const extractSection = createExtractSection(api, setStatus);

    const content = el('div', { class: 'stam-content' }, [
        extractSection.root,
        injectBox,
        el('fieldset', { class: 'stam-box' }, [
            el('legend', { text: '称呼关系' }),
            filterBar,
            relationsBox,
        ]),
        el('fieldset', { class: 'stam-box' }, [
            el('legend', { text: '操作' }),
            toolbar,
            candidateBox,
            issueBox,
        ]),
        helpBox,
        statusLine,
    ]);

    const toggleBtn = el('button', { class: 'stam-collapse', type: 'button', text: '−' });
    toggleBtn.addEventListener('click', () => {
        state.collapsed = !state.collapsed;
        content.style.display = state.collapsed ? 'none' : '';
        toggleBtn.textContent = state.collapsed ? '+' : '−';
    });

    const root = el('div', { class: 'stam-panel', id: 'stam-panel' }, [
        el('div', { class: 'stam-header' }, [
            el('span', { class: 'stam-title', text: '称呼管理器' }),
            toggleBtn,
        ]),
        content,
    ]);

    function setStatus(text) {
        state.status = text;
        statusLine.textContent = text || '';
    }

    /* ---------------- 渲染 ---------------- */

    function renderInject() {
        const settings = api.getSettings();
        const inject = settings.inject;
        injectToggle.checked = Boolean(inject.enabled);
        positionSelect.value = String(inject.position);
        depthInput.value = String(inject.depth);
        roleSelect.value = String(inject.role);
        targetsSelect.value = String(inject.targets);
        const flags = [inject.includeAliases, inject.includeStage, inject.includeNote, inject.header, inject.fallbackRule];
        injectCheckInputs.forEach((input, i) => { input.checked = Boolean(flags[i]); });
        injectOptions.style.opacity = inject.enabled ? '' : '0.55';
        injectChecks.style.opacity = inject.enabled ? '' : '0.55';
    }

    function visiblePairs() {
        const participants = api.getParticipants();
        const focusKey = api.getFocusKey();
        const pairs = [];
        for (const from of participants) {
            for (const to of participants) {
                if (from.key === to.key) continue;
                if (state.filter === 'user' && from.kind !== 'user' && to.kind !== 'user') continue;
                if (state.filter === 'focus' && focusKey && from.key !== focusKey && to.key !== focusKey) continue;
                pairs.push({ from, to });
            }
        }
        return pairs;
    }

    function relationRow(from, to) {
        const hit = api.resolve(from.key, to.key);
        const rel = hit?.relation ?? { call: '', aliases: [], stage: '', note: '' };

        const callInput = el('input', { type: 'text', placeholder: '称呼', value: rel.call ?? '', class: 'stam-input-call' });
        callInput.addEventListener('change', () => {
            api.setRelation(from.key, to.key, { call: callInput.value });
            setStatus(`已保存：${from.name} → ${to.name}`);
            render();
        });

        const aliasInput = el('input', {
            type: 'text',
            placeholder: '别名，逗号分隔',
            value: (rel.aliases ?? []).join('，'),
            class: 'stam-input-alias',
        });
        aliasInput.addEventListener('change', () => {
            api.setRelation(from.key, to.key, { aliases: aliasInput.value });
            setStatus(`已保存别名：${from.name} → ${to.name}`);
            render();
        });

        const stageInput = el('input', {
            type: 'text',
            placeholder: '关系阶段',
            value: rel.stage ?? '',
            list: 'stam-stage-list',
            class: 'stam-input-stage',
        });
        stageInput.addEventListener('change', () => {
            api.setRelation(from.key, to.key, { stage: stageInput.value });
            render();
        });

        const noteInput = el('input', {
            type: 'text',
            placeholder: '备注',
            value: rel.note ?? '',
            class: 'stam-input-note',
        });
        noteInput.addEventListener('change', () => {
            api.setRelation(from.key, to.key, { note: noteInput.value });
            render();
        });

        const sourceBadge = hit?.source === 'library'
            ? el('span', { class: 'stam-badge', text: '全局', title: '当前值来自全局默认库，编辑后会写入本聊天' })
            : (hit ? el('span', { class: 'stam-badge stam-badge-chat', text: '本聊天' }) : null);

        return el('div', { class: `stam-row${hit ? '' : ' stam-row-empty'}` }, [
            el('div', { class: 'stam-pair' }, [
                el('span', { class: 'stam-from', text: from.name }),
                el('span', { class: 'stam-arrow', text: '→' }),
                el('span', { class: 'stam-to', text: to.name }),
                sourceBadge,
            ]),
            callInput,
            aliasInput,
            stageInput,
            noteInput,
            button('清除', () => {
                api.clearRelation(from.key, to.key);
                setStatus(`已清除：${from.name} → ${to.name}`);
                render();
            }, 'stam-small stam-danger'),
        ]);
    }

    function renderRelations() {
        relationsBox.textContent = '';
        const participants = api.getParticipants();
        const pairs = visiblePairs();

        relationsBox.append(el('datalist', { id: 'stam-stage-list' },
            STAGE_SUGGESTIONS.map(s => el('option', { value: s }))));

        if (participants.length < 2) {
            relationsBox.append(el('div', { class: 'stam-hint', text: '当前没有选中角色，先打开一张角色卡或一个群聊。' }));
            return;
        }
        if (!pairs.length) {
            relationsBox.append(el('div', { class: 'stam-hint', text: '这个筛选下没有可编辑的关系。' }));
            return;
        }

        const head = el('div', { class: 'stam-row stam-row-head' }, [
            el('div', { class: 'stam-pair', text: '关系' }),
            el('div', { text: '称呼' }),
            el('div', { text: '别名' }),
            el('div', { text: '阶段' }),
            el('div', { text: '备注' }),
            el('div', {}),
        ]);
        const body = el('div', { class: 'stam-rows' }, [head, ...pairs.map(p => relationRow(p.from, p.to))]);
        relationsBox.append(body);

        const orphans = api.getOrphans();
        if (orphans.length) {
            relationsBox.append(el('div', { class: 'stam-hint', text: `另外还有 ${orphans.length} 条关系指向已不在当前聊天里的角色，已隐藏。` }));
        }
    }

    function renderCandidates() {
        candidateBox.textContent = '';
        if (!state.candidates.length) return;
        candidateBox.append(el('div', { class: 'stam-subtitle', text: `候选称呼（${state.candidates.length}）—— 点「采纳」写入关系表` }));
        const list = el('div', { class: 'stam-cand-list' });
        for (const cand of state.candidates) {
            const sample = cand.samples?.[0] ? el('div', { class: 'stam-hint', text: `例：${cand.samples[0]}` }) : null;
            list.append(el('div', { class: 'stam-cand' }, [
                el('div', { class: 'stam-cand-main' }, [
                    el('span', { text: `${cand.fromName} → ${cand.toName}：` }),
                    el('strong', { text: cand.call }),
                    el('span', { class: 'stam-hint', text: `  ${cand.count} 次 / 置信 ${cand.confidence}` }),
                ]),
                button('采纳', () => {
                    api.adoptCandidate(cand);
                    state.candidates = state.candidates.filter(c => c !== cand);
                    setStatus(`已采纳：${cand.fromName} → ${cand.toName} 记为「${cand.call}」`);
                    render();
                }, 'stam-small'),
                sample,
            ]));
        }
        candidateBox.append(list);
    }

    function renderIssues() {
        issueBox.textContent = '';
        if (!state.issues.length) return;
        issueBox.append(el('div', { class: 'stam-subtitle', text: `一致性检查（${state.issues.length}）` }));
        const list = el('div', { class: 'stam-issue-list' });
        for (const issue of state.issues) {
            list.append(el('div', { class: `stam-issue stam-issue-${issue.level}` }, [
                el('div', { text: issue.message }),
                issue.candidate
                    ? button('改用这个', () => {
                        api.setRelation(issue.from, issue.to, { call: issue.candidate });
                        state.issues = state.issues.filter(i => i !== issue);
                        setStatus('已按检查结果更新称呼');
                        render();
                    }, 'stam-small')
                    : null,
            ]));
        }
        issueBox.append(list);
    }

    function render() {
        renderInject();
        renderRelations();
        renderCandidates();
        renderIssues();
        extractSection.render();
        filterBar.querySelectorAll('.stam-chip').forEach(chip => {
            chip.classList.toggle('stam-chip-active', chip.dataset.filter === state.filter);
        });
    }

    render();
    return { root, render, renderExtract: extractSection.render, setStatus };
}

export default createPanel;
