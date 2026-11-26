# Codex 对话看板

把 Codex 会话里的代码改动、待办和提醒汇到一块看板。按项目跟进进度，把事项发回 Codex，也可以从卡片回到关联会话。

**Windows 便携应用** · React + TypeScript · Tauri + Rust · SQLite

[快速开始](#快速开始) · [日常使用](#日常使用) · [同步与数据](#同步与数据) · [开发与构建](#开发与构建)

![对话看板演示界面，左侧是项目列表，右侧是待处理、进行中和已完成三列](docs/images/conversation-board.png)

*上图使用示例项目和会话。*

## 快速开始

1. 解压完整项目包，双击 [conversation-board.exe](portable/conversation-board.exe)。
2. 在「待处理」列点击「添加事项」，输入一行 Codex 提示词。
3. 想同步 Codex 会话时，先在本机安装并登录 Codex。然后点击右上角齿轮，开启「对话同步」，首次开启后按提示重启 Codex。

便携版需要 Windows 和 WebView2。卡片上的「在 Codex 中查看」会打开 Codex 桌面版。

## 日常使用

| 要做什么 | 在哪里操作 |
| --- | --- |
| 聚焦一个项目 | 在左侧切换项目，点击项目旁的星标即可追踪或取消追踪。「仅追踪」视图也可添加追踪项目。顶部可以按同步日期和关键词筛选。 |
| 跟进事项 | 事项按状态显示在「待处理」「进行中」「已完成」三列。长列表在各自列内滚动。 |
| 把任务交给 Codex | 选择「开启新对话」或「沿用之前对话」，在卡片上查看处理状态。 |
| 整理历史事项 | 点击卡片上的归档按钮。从顶部「已归档」进入历史列表，随时恢复。 |
| 编辑事项 | 点击卡片或编辑按钮修改标题和备注。有同步来源的事项可以展开查看依据。 |
| 接收 Windows 提醒 | 开启对话同步和 AI 分析后，可以在 Codex 会话中提出提醒。看板运行时会投递到期通知。 |

点击右上角的关闭按钮时，可以选择最小化到任务栏或直接关闭，并记住选择。随时可在「设置 → 关闭窗口时」改回「每次询问」。

## 同步与数据

- **对话同步** · 开启后，应用为 Codex 配置会话钩子。代码改动在本机记录。可以在设置中重试失败记录或撤销上次同步。
- **API 配置** · 在「设置 → API 配置」填写兼容 Chat Completions 的 API 地址、模型和密钥，供待办与提醒提取、AI 智能命名使用。密钥保存在 Windows 凭据管理器。
- **AI 智能命名** · 保存 API 配置后可在设置中开启。手动新建事项的提示词、同步代码改动的相关请求和文件名会发给配置的服务生成简短标题。手动事项的原始提示词保存在备注里，发回 Codex 时使用原文。命名失败时沿用原有标题。
- **本地数据** · 看板沿用 `%APPDATA%\com.desktopnotes.stickynotes` 中的 SQLite 数据库。首次运行会创建所需数据。查找 Codex 会话时，应用优先使用 `CODEX_HOME`，默认读取用户目录下的 `.codex`。

## 开发与构建

开发环境需要 Windows、Node.js 20+、Rust 稳定版、Visual Studio C++ Build Tools 和 WebView2。

### 本地运行

```powershell
npm ci
npm run desktop:dev
```

### 构建便携版

```powershell
npm run desktop:build
```

构建完成后，可从 `src-tauri/target/release/conversation-board.exe` 启动。

### 测试

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
powershell -ExecutionPolicy Bypass -File tests/chat-sync-hook.test.ps1
```
