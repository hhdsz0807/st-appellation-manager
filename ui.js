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

    const content = el('div', { class: 'stam-content' }, [
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
        filterBar.querySelectorAll('.stam-chip').forEach(chip => {
            chip.classList.toggle('stam-chip-active', chip.dataset.filter === state.filter);
        });
    }

    render();
    return { root, render, setStatus };
}

export default createPanel;
