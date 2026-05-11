# Feishu Channel for Claude Code

[![npm version](https://img.shields.io/npm/v/feishuchannel-for-claudecode)](https://www.npmjs.com/package/feishuchannel-for-claudecode)
[![license](https://img.shields.io/npm/l/feishuchannel-for-claudecode)](LICENSE)

[English](./README.md) | **中文**

一个基于 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 原生 [Channel 接口](https://docs.anthropic.com/en/docs/claude-code/channels) 的[飞书（Lark）](https://www.feishu.cn/)频道插件。在飞书中直接与 Claude 对话——私聊、群聊、文件共享、交互卡片，一应俱全。

基于 MCP Channel 协议，使用 **WebSocket 长连接**——无需公网 HTTPS 端点。

```bash
npx feishuchannel-for-claudecode   # 一键安装
```

---

## 目录

- [架构与模式](#架构与模式)
- [功能特性](#功能特性)
- [前置条件](#前置条件)
- [快速上手](#快速上手)
- [多群路由配置](#多群路由配置)
- [访问管理](#访问管理)
- [文件结构](#文件结构)
- [环境变量](#环境变量)
- [工作原理](#工作原理)
- [测试与开发](#测试与开发)
- [安全性](#安全性)
- [AI 自动化部署指南](#ai-自动化部署指南)

---

## 架构与模式

插件运行在**三种模式**下，根据运行时上下文自动选择：

```
┌─────────────────────────────────────────────────────────────────┐
│                        模式选择流程                               │
│                                                                 │
│  启动 claude-feishu                                             │
│       │                                                         │
│       ▼                                                         │
│  祖先进程中是否包含 --channels feishu？                           │
│       │                                                         │
│    否 ──→ 被动模式（无连接，仅保留工具）                           │
│    是                                                           │
│       │                                                         │
│       ▼                                                         │
│  能否启动/连接 Router？                                          │
│       │                                                         │
│    能 ──→ Worker 模式（通过 Unix socket 连接 Router）            │
│    否 ──→ Channel 模式（直连飞书 WebSocket）                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 模式对比

| | Channel 模式 | Worker 模式（通过 Router） | 被动模式 |
|---|---|---|---|
| **连接方式** | 直连飞书 WebSocket | Unix socket → Router → 飞书 WebSocket | 无 |
| **适用场景** | 单人 / 单项目 | 多人 / 多项目 | 非频道 Claude 实例 |
| **DM 配对** | ✅ 支持 | ✅ 支持（通过 Router） | 不适用 |
| **消息路由** | 所有消息 → 当前实例 | chat_id → workdir → worker | 不适用 |
| **自动启动** | Router 启动失败时回退 | 首个 `claude-feishu` 自动启动 Router | 始终 |
| **实例数量** | 1 个 Claude / 1 个 Bot | N 个 Claude / 1 个 Bot | 不适用 |

### Channel 模式（1:1）

```
┌─────────────┐
│  飞书机器人   │──── WebSocket ────→ Claude Code 实例
└─────────────┘
```

最简单的配置。一个 Bot 对应一个 Claude。所有消息发送到唯一连接的实例。

### Worker 模式（1:N 通过 Router）

```
┌─────────────┐                    ┌─ Claude Code (/path/to/project-a)
│  飞书机器人   │──── WebSocket ──→ Router ──┼─ Claude Code (/path/to/project-b)
└─────────────┘                    └─ Claude Code (/path/to/project-c)
                                        ▲
                                   Unix socket
```

Router 持有唯一的飞书 WebSocket 连接。每个 Claude Code 实例作为 **Worker** 通过 Unix socket 连接。消息路由规则：

```
chat_id → groups[chat_id].workdir → 已注册的 worker（按工作目录匹配）
```

**关键行为：**
- 首个 `claude-feishu` **自动启动** Router 进程
- 后续实例**自动连接**为 Worker
- 所有 Worker 断开后，Router **10 秒后自动关闭**
- Router 支持 DM 配对——新用户获得配对码，流程与 Channel 模式一致
- Router 启动失败时，自动回退到 Channel 模式

---

## 功能特性

- **多群路由** — 一个飞书机器人服务多个 Claude Code 实例，各自独立项目
- **自动管理 Router** — 首次启动自动创建，全部断开后自动关闭
- **DM 配对** — Channel 和 Router 模式均支持配对认证
- **私聊** — 通过飞书 DM 与 Claude 对话
- **群聊** — 添加机器人到群聊，支持 @提及和自定义触发模式
- **访问控制** — 配对认证、白名单、按群策略
- **确认卡片** — 高风险操作的交互式确认卡片（✅/❌ 按钮 + 文字回复）
- **权限卡片** — 工具权限请求的交互式审批/拒绝卡片
- **未回复提醒** — 30 分钟 / 60 分钟 / 120 分钟递进提醒
- **附件收发** — 发送和接收文件、图片
- **表情回应** — 收到消息时可配置表情回应（默认：👍）
- **消息编辑** — 更新已发送的消息（不推送通知）
- **智能连接** — 仅在作为飞书频道启动时才建立连接
- **优雅退出** — 通过 ppid 轮询检测父进程退出
- **Worker 自动重连** — Worker 断连后自动重新连接 Router

---

## 前置条件

- [Bun](https://bun.sh/) 运行时
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 已安装
- 飞书（或 Lark）工作区，拥有管理员权限以创建应用

---

## 快速上手

### 第 1 步：创建飞书应用

1. 前往[飞书开放平台](https://open.feishu.cn)（国际版使用 [Lark Open Platform](https://open.larksuite.com)）
2. 创建**自建应用**（企业内部应用）
3. 记录 **App ID**（`cli_...`）和 **App Secret**

4. 在**事件与回调**下，配置**两个独立的标签页**：

   **事件配置标签页：**
   - 切换为**使用长连接**（WebSocket 模式）
   - 添加事件：`im.message.receive_v1`

   **回调配置标签页：**
   - 切换为**使用长连接**（WebSocket 模式）
   - 添加回调：`card.action.trigger`（确认/权限卡片按钮必需）

5. 在**权限管理**下，添加：

   | 权限 | 用途 |
   |---|---|
   | `im:message` | 发送消息 |
   | `im:message.receive_v1` | 接收消息 |
   | `im:message.p2p_msg:readonly` | 读取私聊消息 |
   | `im:message.group_at_msg:readonly` | 读取群聊 @消息 |
   | `im:chat:readonly` | 读取会话元数据 |
   | `im:resource` | 下载和上传附件 |

6. **发布**应用版本使权限生效

### 第 2 步：安装插件

```bash
npx feishuchannel-for-claudecode
```

自动完成：克隆仓库 → 安装依赖 → 注册插件 → 创建 `claude-feishu` 快捷方式。

<details>
<summary>手动安装</summary>

```bash
git clone https://github.com/phxwang/feishuchannel-for-claudecode.git
cd feishuchannel-for-claudecode
bun install
claude plugin marketplace add .
claude plugin install feishu@feishu-local
```

</details>

### 第 3 步：启动 Claude Code 飞书频道

```bash
claude-feishu
```

后续启动时，`claude-feishu` 自动恢复以当前目录命名的会话。如无匹配会话，则打开交互式会话选择器。

完整命令等价于：

```bash
claude --dangerously-load-development-channels plugin:feishu@feishu-local
```

### 第 4 步：配置凭据

在 Claude Code 终端中运行：

```
/feishu:auth cli_YOUR_APP_ID YOUR_APP_SECRET
```

凭据存储在 `~/.claude/channels/feishu/.env`（权限 600）。

### 第 5 步：配对你的账号

1. 在飞书中搜索你的机器人（按应用名称）
2. 向机器人发送任意消息
3. 机器人回复配对码和操作指引
4. 在 Claude Code 中运行：

   ```
   /feishu:access pair <配对码>
   ```

5. 机器人确认：*"Paired! Say hi to Claude."*

大功告成——向机器人发消息，Claude 即会回复。

---

## 多群路由配置

### 1. 配置群组工作目录

在 `~/.claude/channels/feishu/access.json` 中为每个群添加 `workdir`：

```jsonc
{
  "groups": {
    "oc_groupA": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/path/to/project-a"
    },
    "oc_groupB": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/path/to/project-b"
    }
  },
  "defaultWorkdir": "/path/to/default-project"  // 私聊和未配置群组路由到这里
}
```

### 2. 启动 Claude Code 实例

在不同终端中，分别在项目目录启动 Claude：

```bash
cd /path/to/project-a && claude-feishu   # 首个：启动 Router + 连接为 Worker
cd /path/to/project-b && claude-feishu   # 后续：连接到已有 Router
cd /path/to/project-c && claude-feishu   # 后续：连接到已有 Router
```

**首个**实例自动启动 Router。后续实例连接为 Worker。Router 按 `chat_id → workdir → 已连接的 worker` 路由消息。

### 3. Router 模式下的配对

Router 模式支持与 Channel 模式相同的 DM 配对流程。当未知用户发送私聊消息时：

1. Router 生成配对码并回复操作指引
2. 用户在**任意**已连接的 Claude Code 终端运行 `/feishu:access pair <配对码>`
3. 用户被添加到 `allowFrom`，此后可以正常发消息

> **注意：** 配对审批必须在 Claude Code 终端中完成——绝不能从飞书消息中审批（防止提示注入攻击）。

### 4. 手动启动 Router（可选）

```bash
bun run router
```

### 5. 查看 Router 状态

```bash
kill -USR1 $(pgrep -f 'bun router.ts')
cat ~/.claude/channels/feishu/router-debug.log | tail -10
```

---

## 访问管理

所有访问管理命令在 Claude Code 终端中通过 `/feishu:access` 运行。

### 查看状态

```
/feishu:access
```

### 私聊策略

| 策略 | 行为 |
|---|---|
| `pairing`（默认） | 未知用户获得配对码，需审批 |
| `allowlist` | 未知用户被静默丢弃 |
| `disabled` | 所有私聊消息被丢弃 |

```
/feishu:access policy allowlist
```

> **提示：** 所有用户配对完成后，切换到 `allowlist` 可阻止未授权的配对请求。

### 用户管理

```bash
# 审批配对
/feishu:access pair <配对码>

# 拒绝配对
/feishu:access deny <配对码>

# 按 open_id 手动允许用户
/feishu:access allow ou_xxxxxxxxxxxxxxxxxxxx

# 移除用户
/feishu:access remove ou_xxxxxxxxxxxxxxxxxxxx
```

### 群聊管理

群聊默认关闭。需先由群管理员将机器人添加到群中。

```bash
# 启用群聊（仅 @提及时响应）
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx

# 响应所有消息（无需 @提及）
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx --no-mention

# 限制群内特定用户
/feishu:access group add oc_xxxxxxxxxxxxxxxxxxxx --allow ou_id1,ou_id2

# 移除群聊
/feishu:access group rm oc_xxxxxxxxxxxxxxxxxxxx
```

### 投递设置

```bash
# 收到消息时回应表情（默认：Get）
/feishu:access set ackReaction Get

# 设置每条消息的最大字符数
/feishu:access set textChunkLimit 4096

# 群聊自定义触发模式
/feishu:access set mentionPatterns ["@claude","@assistant"]
```

---

## 文件结构

```
~/.claude/channels/feishu/
├── .env              # 应用凭据（FEISHU_APP_ID, FEISHU_APP_SECRET）
├── access.json       # 访问控制状态（自动管理）
├── approved/         # 配对审批信号（临时）
├── inbox/            # 下载的附件
├── debug.log         # 服务端调试日志
├── router-debug.log  # Router 调试日志（使用 Router 时）
└── router.sock       # Worker-Router IPC 的 Unix socket
```

---

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 飞书应用 ID（`cli_...`） |
| `FEISHU_APP_SECRET` | 是 | 飞书应用密钥 |
| `FEISHU_ENCRYPT_KEY` | 否 | 事件载荷加密密钥 |
| `FEISHU_ACCESS_MODE` | 否 | 设为 `static` 禁用配对（降级为白名单模式） |
| `FEISHU_STATE_DIR` | 否 | 覆盖状态目录路径（默认：`~/.claude/channels/feishu/`） |

---

## 工作原理

### 智能连接检测

插件通过向上遍历进程树，检查祖先进程命令行中是否包含 `--dangerously-load-development-channels` 和 `feishu`，来判断当前是否运行在飞书频道的 Claude 实例下。非频道 Claude 实例（如普通 `claude` 或 `claude --channels plugin:discord@...`）会跳过飞书 WebSocket 连接，仅保留 MCP 工具可用。

### 孤儿进程保护

当父 Claude 进程退出时，插件在 2 秒内检测到 ppid 变化并优雅关闭。这防止了孤儿 `bun server.ts` 进程占用 100% CPU——这是由于 Bun 在 Unix domain socket 断开时不可靠地触发 stdin `end`/`close` 事件的变通方案。

### Worker 自动重连

当 Worker 与 Router 的 Unix socket 连接断开时，3 秒后自动尝试重连。无需手动干预即可应对 Router 临时重启和网络抖动。

### 访问控制缓存

`access.json` 文件基于修改时间的 2 秒 TTL 缓存。避免每条消息都调用 `readFileSync`，同时确保配置变更在数秒内生效。

---

## 测试与开发

```bash
bun test              # 运行测试（58 个测试，226 个断言）
bun run lint          # 使用 Biome 检查代码风格
bun run lint:fix      # 自动修复代码风格问题
bun run format        # 使用 Biome 格式化代码
bun run typecheck     # TypeScript 类型检查
bun run check         # 完整检查：类型检查 + 代码风格 + 测试
```

测试覆盖：访问控制（gate 逻辑）、文本分块、提及检测、权限回复解析、确认码生成、聊天授权、消息解析、附件信息、时间戳格式化、过期条目清理、Router 工作目录解析、访问缓存。

---

## 安全性

- 凭据文件权限 `chmod 600`——仅所有者可读
- 状态目录权限 `chmod 700`
- Router Unix socket 权限 `chmod 600`
- 配对码 1 小时后过期
- 2 次未审批消息后，发送者被静默丢弃直到配对码过期
- 最多 3 个并发待审批配对码
- 访问控制变更只能在 Claude Code 终端中操作——绝不能从频道消息中操作（防止提示注入）
- 文件路径校验阻止发送频道状态文件
- 聊天白名单阻止未授权消息投递
- 确认码使用排除易混淆字符 `l` 的字符集

---

## AI 自动化部署指南

本节为 AI 代理提供精简的、逐步的飞书频道插件自动部署和配置指南。

### 前置条件检查

```bash
# 验证 Bun 已安装
bun --version || (echo "安装 Bun: curl -fsSL https://bun.sh/install | bash" && exit 1)

# 验证 Claude Code 已安装
claude --version || (echo "请先安装 Claude Code" && exit 1)
```

### 一键部署

```bash
npx feishuchannel-for-claudecode
```

自动完成：克隆 → 安装 → 注册插件 → 创建 `claude-feishu` 快捷方式。

### 凭据配置

```bash
# 写入凭据到状态目录
mkdir -p ~/.claude/channels/feishu
cat > ~/.claude/channels/feishu/.env << 'EOF'
FEISHU_APP_ID=cli_YOUR_APP_ID
FEISHU_APP_SECRET=YOUR_APP_SECRET
EOF
chmod 600 ~/.claude/channels/feishu/.env
```

或在 Claude Code 会话中使用技能命令：

```
/feishu:auth cli_YOUR_APP_ID YOUR_APP_SECRET
```

### 多群路由配置

写入 `~/.claude/channels/feishu/access.json`：

```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "p2pChats": {},
  "groups": {
    "oc_GROUP_ID_A": {
      "requireMention": true,
      "allowFrom": [],
      "workdir": "/absolute/path/to/project-a"
    },
    "oc_GROUP_ID_B": {
      "requireMention": false,
      "allowFrom": [],
      "workdir": "/absolute/path/to/project-b"
    }
  },
  "pending": {},
  "ackReaction": "Get",
  "defaultWorkdir": "/absolute/path/to/default-project"
}
```

关键字段：
- `groups[chat_id].workdir` — 将飞书群映射到项目目录
- `defaultWorkdir` — 私聊和未配置群组的回退目录
- `dmPolicy` — `pairing`（默认）、`allowlist` 或 `disabled`
- `ackReaction` — 已读回执的表情码（默认：`Get`）

### 启动命令

```bash
# 单项目（Channel 模式或自动 Router）
cd /path/to/project && claude-feishu

# 多项目（Router 模式）
cd /path/to/project-a && claude-feishu &  # 首个：启动 Router
cd /path/to/project-b && claude-feishu &  # 连接为 Worker
```

### 配对流程（自动化）

用户向机器人发送私聊消息后，收到配对码。审批：

```
/feishu:access pair ABCDE
```

或按 open_id 预授权用户：

```
/feishu:access allow ou_xxxxxxxxxxxxxxxxxxxx
```

### 验证清单

```bash
# 1. 插件已安装
claude plugin list | grep feishu

# 2. 凭据已配置
test -f ~/.claude/channels/feishu/.env && echo "OK" || echo "MISSING"

# 3. 测试通过
cd $(dirname $(which claude-feishu))/.. && bun test

# 4. Router 运行中（多群模式）
test -S ~/.claude/channels/feishu/router.sock && echo "Router active" || echo "No router"

# 5. 调试日志
tail -5 ~/.claude/channels/feishu/debug.log
tail -5 ~/.claude/channels/feishu/router-debug.log
```

### 故障排查

| 症状 | 检查 | 修复 |
|---|---|---|
| 机器人无响应 | `debug.log` 中的错误 | 验证 `.env` 中的凭据 |
| Router 未启动 | `router-debug.log` | 检查端口/socket 是否被占用 |
| Worker 未连接 | `debug.log` 中的 "worker" 条目 | 验证 Router socket 是否存在 |
| 未收到配对码 | `access.json` 中的 `dmPolicy` | 必须为 `pairing`，不能是 `disabled` |
| 群消息被忽略 | 群是否在 `access.json` 中？ | `/feishu:access group add <chat_id>` |
| 卡片按钮无效 | 回调是否已配置？ | 在飞书应用中添加 `card.action.trigger` |

---

## 许可证

MIT
