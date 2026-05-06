# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

AIris — Obsidian 侧边栏 AI 生图插件。用户在 Markdown 笔记中选中文本/图片作为上下文，通过侧边栏触发多 AI 提供商图片生成，结果以 `![[embed]]` 形式插入笔记。

## 语言
- 使用中文回答和代码注释

## 常用命令

```bash
npm run dev        # 开发模式（watch + version-sync）
npm run build      # 生产构建（tsc 类型检查 + esbuild）
npm run lint       # ESLint 检查（含 obsidianmd 规则集）
npm run deploy:dev # 部署到本地开发 vault（需配置 scripts/deploy-dev.sh）
```

**改动后必须运行**: `npm run build` 和 `npm run lint`

## 规则
- 使用 Context7 MCP 检索 API 文档
- 精简注释，这是一个纯 vibe-coding 项目，不需要过多注释

## 文件大小限制

- **单文件上限**: 800 行；超过 500 行时考虑模块化
- **核心原则**: 每个文件只做一件事

## 架构概览

```
main.ts                    # 插件入口，注册 View/Ribbon/Settings
src/
├── api/
│   ├── api-manager.ts     # 统一路由层，按 settings.apiProvider 分发
│   ├── providers/         # 三个 Provider 实现（openrouter/openai/gemini）
│   ├── types.ts           # API 请求/响应类型
│   └── utils.ts           # 共享工具
├── notes/
│   ├── sidebar-copilot-view.ts    # 侧边栏 View（ItemView 子类）
│   ├── notes-selection-handler.ts # 选区捕获 + 生图入口 + 插入笔记
│   ├── note-image-task-manager.ts # 并发任务管理（最多 9 任务）
│   ├── types.ts
│   └── index.ts
├── settings/
│   ├── settings.ts        # CanvasAISettings 接口 + 默认值 + provider 工具函数
│   └── settings-tab.ts    # Obsidian 设置 Tab UI
└── utils/
    ├── image-utils.ts     # 图片提取、压缩、保存到 vault
    └── format-utils.ts
lang/
├── helpers.ts             # t() 函数 + isZhLocale()
└── locale/
    ├── en.json            # Source of Truth
    └── zh-cn.json         # 中文翻译
```

### 核心数据流

1. 用户在侧边栏输入 prompt → `SideBarCoPilotView`
2. `NotesSelectionHandler.handleImageGeneration()` 捕获选区、提取文档图片
3. `NoteImageTaskManager.startTask()` 创建带超时的并发任务
4. `ApiManager` 路由到对应 Provider，调用 `generateImageWithRoles()`
5. 返回 `GeneratedImageCandidate`（含 base64 data URL）
6. 用户点击插入 → `insertImageCandidate()` 保存到 vault 并嵌入笔记

### API Provider 系统

`settings.apiProvider` 决定当前活跃 Provider（openrouter/openai/gemini）。每个 Provider 实现 `chatCompletion`、`streamChatCompletion`、`generateImage`、`multimodalChat`。`paletteImageModel` 格式为 `"provider|modelId"`，可覆盖默认 Provider 专用于图片生成。OpenAI Provider 兼容任意 OpenAI 格式端点（如 Gravitex gpt-image-2），通过 `openAIBaseUrl` 配置。

## 多语言 (i18n)

- `lang/locale/en.json` 为主（Source of Truth），`zh-cn.json` 为翻译
- 使用 `t('key')` 调用，支持参数插值 `t('Hello {name}', { name: 'World' })`
- UI 文本用 Sentence case（仅首字母大写）

## 提交前检查

完整规范见 `docs/audit-checklist.md`，关键点：

- 无 `any` 类型，catch 用 `unknown` + 类型守卫
- DOM 操作用 `createEl`/`addClass`，不用 `innerHTML` 或 `element.style.xxx`
- 网络请求用 `requestUrl`，不用 `fetch`
- Promise 必须 `await` 或 `void`，不能悬空
- `console.log` 只允许 `debug/warn/error`
- `PluginSettingTab.display()` 返回 `void`，不能是 `Promise<void>`
