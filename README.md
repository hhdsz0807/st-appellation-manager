# 称呼管理器 (Appellation Manager)

SillyTavern 浏览器扩展。用来集中管理三类称呼：

| 关系 | 例子 |
| --- | --- |
| 角色 → 用户 | 白鹭管你叫「陆哥」 |
| 用户 → 角色 | 你管白鹭叫「白鹭姐」 |
| 角色 → 角色 | 白鹭管星野叫「小星星」（群聊） |

每条关系可以带**别名**（陆哥 / 哥 / 小陆哥）和**关系阶段**（初见、熟悉、亲密、决裂……）。
登记之后，扩展会把整张称呼表压成一段提示词注入给模型，让角色说话时称呼保持一致；
同时支持从最近的聊天里**反向扫描**出「谁喊谁什么」的候选，点一下就能采纳。

## 它不做什么

- 不改你已经存下来的聊天记录。历史消息永远是原文。
- 不做文本替换式的「全局改名」。称呼只影响**送进模型的提示词**和扩展面板里的显示。
- 不往角色卡、世界书里写东西。

## 安装

**方式一：让酒馆自己拉（推荐）**

酒馆 → 扩展 → **Install extension** → 粘贴仓库地址：

```
https://github.com/hhdsz0807/st-appellation-manager
```

装完刷新页面。

**方式二：手动放目录**

扩展目录：`<SillyTavern>/public/scripts/extensions/third-party/st-appellation-manager/`

把本目录（`manifest.json` / `index.js` / `core.js` / `ui.js` / `style.css`）整体复制进去，刷新酒馆页面即可。
`test-core.mjs` 是开发自测文件，可以不复制。

```powershell
# 在 D:\cli 下执行（会覆盖同名目录，先确认目标路径）
Copy-Item -Recurse -Force 'D:\cli\extensions\st-appellation-manager' `
  'D:\cli\SillyTavern\public\scripts\extensions\third-party\'
```

装好后在「扩展」抽屉里能看到 **称呼管理器** 面板。如果没出现，按 F12 看控制台有没有
`[称呼管理器]` 开头的报错。

## 用法（第一次用，照这个顺序走）

1. 打开一张角色卡或一个群聊。
2. 到「扩展」抽屉找到 **称呼管理器** 面板 → 「称呼关系」区域。
3. 表格里每一行是一个方向的关系（`白鹭 → 小陆`），按顺序填：**称呼**、别名、阶段、备注。
   填完点一下别处（输入框失焦即保存），面板下方会显示「已保存」。
4. 点 **扫描候选称呼**。扩展会读最近 40 楼消息，找出「他叫她小星星」这类句子里的称呼，
   列在下面。觉得对就点 **采纳**（原来的登记会自动降级成别名，不会丢）。
5. 点 **一致性检查**：会告诉你哪些登记的称呼在最近聊天里从没出现过（可能过时），
   以及哪些称呼实际用法和登记值不一样。
6. 「提示词注入」区域保持开启，注入位置默认「对话内、深度 4」。想让模型更严格地遵守，
   可以改到「主提示内」。

## 提示词注入说明

开关打开且当前聊天至少有两个参与者时，会注入类似这样的一段：

```
【称呼表】以下为已确认的称呼，请在对话中自然使用，不要复述本表。
白鹭 → 小陆：陆哥（别名：哥、小陆哥；关系：熟悉）
小陆 → 白鹭：白鹭姐
（未列出的关系按原本的名字称呼。称呼会随关系阶段变化时，以关系更贴合的写法为准。）
```

可调项：

| 选项 | 作用 |
| --- | --- |
| 注入位置 | `主提示内` / `对话内（按深度）` / `主提示前` |
| 深度 | 只在「对话内」时生效，数字越大越靠上 |
| 消息角色 | 这段内容以 system / user / assistant 的身份出现 |
| 范围 | 全部关系 / 只含与用户相关 / 只含当前角色相关 |
| 带别名·阶段·备注 | 控制每行括号里的内容 |
| 带表头说明·兜底规则 | 控制首行和末行 |
| 长度上限 | 超长时逐条截断，并在正文里写明「另有 N 条未列出」 |

## 宏

写在世界书、角色卡、快捷回复里的宏，生成时自动替换：

| 宏 | 结果 |
| --- | --- |
| `{{call::白鹭::用户}}` | 白鹭对你的称呼；没登记时回退成目标的名字 |
| `{{callAlias::用户::白鹭}}` | 别名列表，顿号分隔；没有则空 |
| `{{callTable}}` | 当前聊天的整张称呼表（单行压缩） |

源和目标都能写：角色名、「用户」、`user`。名字支持前缀匹配（写「白」能匹配到「白鹭」，唯一时）。

宏名必须是 ASCII（酒馆的宏语法只认 `[a-zA-Z][\w-_]*`），所以中文宏名不可用。

## 斜杠命令

```
/appellation list
/appellation set from=白鹭 to=用户 call=陆哥
/appellation del from=白鹭 to=用户
```

中文别名 `/称呼` 会在宿主机允许时一起注册。

## 数据存在哪

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 本聊天的称呼 | `chat_metadata["st-appellation-manager"]` | 跟着聊天文件走，换设备/导出聊天都会带上 |
| 全局默认库 | `extension_settings["st-appellation-manager"].library` | 本聊天没登记的称呼会回退到它 |
| 注入选项 | `extension_settings["st-appellation-manager"].inject` | 全局生效 |

面板上的 **导出 JSON / 导入 JSON** 可以把「本聊天关系 + 全局库 + 注入选项」打包备份或迁移。
导入支持完整 bundle，也支持只含 `relations` 的裸对象。

## 验证状态

**已通过（离线自动验证，可复现）**

- `node test-core.mjs` → 30 项全过。覆盖：参与者解析（单聊/群聊）、关系读写与脏数据归一化、
  提示词拼接与截断、候选扫描（含「称呼X为Y」句式、指代不明时不乱报、代码块跳过）、
  一致性检查、导入导出、设置夹取。
- 扩展入口模块能在 Node 下成功加载（`core.js` / `ui.js` 语法与导入路径有效）。
- `manifest.json` 通过 TavernWeave 扩展清单校验器：字段、路径、入口文件全部合法，无警告。

**还没验证（必须在真实酒馆里跑过才算数）**

- 扩展管理器里能否看到、能否启用/禁用。
- 面板挂载在 `#extensions_settings2` 是否真的出现，样式在你的主题下是否正常。
- 事件负载：`CHAT_CHANGED` / `MESSAGE_RECEIVED` / `GENERATION_AFTER_COMMANDS` 触发时刷新是否及时。
- 设置与聊天元数据是否真的持久化（刷新后还在）。
- 宏 `{{call::}}` 在你这台酒馆的实际宏引擎里是否生效（本扩展优先走新版宏引擎
  `scripts/macros/macro-system.js`，导入失败会自动退回旧版无参宏）。
- 斜杠命令 `/appellation` 与中文别名 `/称呼` 是否可执行。
- 提示词里是否真的出现了称呼表（用酒馆的 Prompt 查看器核对）。

以上任意一项没过，都不要当它已经能用。

## 开发

- `core.js`：纯逻辑，无宿主依赖，可直接在 Node 里测。
- `ui.js`：只画界面，所有读写都通过 `index.js` 传进来的 `api`。
- `index.js`：唯一的宿主接线层（上下文、元数据、注入、宏、命令、面板）。
- 改动后跑一遍 `node test-core.mjs`；动了 `index.js` / `ui.js` 再跑一次
  `node -e "import('./index.js')"` 确认能加载。

依赖的宿主接口（SillyTavern 1.19.0 实测存在）：
`SillyTavern.getContext()` 提供的 `chatMetadata`、`saveMetadataDebounced`、`extensionSettings`、
`saveSettingsDebounced`、`eventSource`、`eventTypes`、`setExtensionPrompt`、`chat`、
`characters`、`groups`、`name1`、`name2`、`characterId`、`groupId`、`registerMacro`、`unregisterMacro`、
`SlashCommandParser` / `SlashCommand` / `SlashCommandNamedArgument` / `SlashCommandArgument` / `ARGUMENT_TYPE`。
