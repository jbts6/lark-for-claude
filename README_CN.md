# Feishu Channel for Claude Code

[![npm version](https://img.shields.io/npm/v/lark-for-claude)](https://www.npmjs.com/package/lark-for-claude)
[![license](https://img.shields.io/npm/l/lark-for-claude)](LICENSE)

[English](./README.md) | **中文**

一个基于 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 原生 [Channel 接口](https://docs.anthropic.com/en/docs/claude-code/channels) 的[飞书（Lark）](https://www.feishu.cn/)频道插件。在飞书中直接与 Claude 对话——私聊、群聊、交互卡片，一应俱全。

基于 MCP Channel 协议，使用 **WebSocket 长连接**——无需公网 HTTPS 端点。

```bash
npx lark-for-claude   # 一键安装
```

***

## 目录

- [架构与模式](#架构与模式)
- [功能特性](#功能特性)
- [前置条件](#前置条件)
- [快速上手](#快速上手)
- [多群路由配置](#多群路由配置)
- [访问管理](#访问管理)
- [文件结构](#文件结构)
- [多设备同步](#多设备同步)
- [环境变量](#环境变量)
- [工作原理](#工作原理)
- [测试与开发](#测试与开发)
- [安全性](#安全性)
- [AI 自动化部署指南](#ai-自动化部署指南)

***

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

| <br />   | Channel 模式           | Worker 模式（通过 Router）                | 被动模式          |
| -------- | -------------------- | ----------------------------------- | ------------- |
| **连接方式** | 直连飞书 WebSocket       | Unix socket → Router → 飞书 WebSocket | 无             |
| **适用场景** | 单人 / 单项目             | 多人 / 多项目                            | 非频道 Claude 实例 |
| **消息路由** | 所有消息 → 当前实例          | chat\_id → workdir → worker         | 不适用           |
| **自动启动** | Router 启动失败时回退       | 首个 `claude-feishu` 自动启动 Router      | 始终            |
| **实例数量** | 1 个 Claude / 1 个 Bot | N 个 Claude / 1 个 Bot                | 不适用           |

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
- Router 启动失败时，自动回退到 Channel 模式

***

## 功能特性

- **多群路由** — 一个飞书机器人服务多个 Claude Code 实例，各自独立项目
- **自动管理 Router** — 首次启动自动创建，全部断开后自动关闭
- **私聊** — 通过飞书 DM 与 Claude 对话
- **群聊** — 添加机器人到群聊，支持 @提及和自定义触发模式
- **访问控制** — 基于白名单的用户授权和按群策略
- **权限卡片** — 工具权限请求的交互式审批卡片（✅ 允许一次 / ✅✅ 始终允许 / ❌ 拒绝）
- **确认卡片** — 高风险操作的交互式确认卡片（✅ / ✅✅ / ❌ 三按钮 + 文字回复）
- **未回复提醒** — 30 分钟 / 60 分钟 / 120 分钟递进提醒
- **表情回应** — 收到消息时可配置表情回应（默认：👍）
- **消息编辑** — 更新已发送的消息（不推送通知）
- **智能连接** — 仅在作为飞书频道启动时才建立连接
- **优雅退出** — 通过 ppid 轮询检测父进程退出
- **Worker 自动重连** — Worker 断连后自动重新连接 Router
- **日志轮换** — 自动日志轮换（5MB 上限，3 份备份），防止磁盘耗尽

***

## 前置条件

- [Bun](https://bun.sh/) 运行时
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 已安装
- 飞书（或 Lark）工作区，拥有管理员权限以创建应用

***

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
   | 权限                                 | 用途       |
   | ---------------------------------- | -------- |
   | `im:message`                       | 发送消息     |
   | `im:message.receive_v1`            | 接收消息     |
   | `im:message.p2p_msg:readonly`      | 读取私聊消息   |
   | `im:message.group_at_msg:readonly` | 读取群聊 @消息 |
   | `im:chat:readonly`                 | 读取会话元数据  |
   | `im:resource`                      | 下载和上传附件  |
6. **发布**应用版本使权限生效

### 第 2 步：安装插件

```bash
npx lark-for-claude
```

自动完成：安装依赖 → 注册插件 → 创建 `claude-feishu` 快捷方式。

<details>
<summary>手动安装</summary>

```bash
git clone https://github.com/jbts6/lark-for-claude.git
cd lark-for-claude
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
claude-feishu auth cli_YOUR_APP_ID YOUR_APP_SECRET
```

凭据存储在 `~/.claude/channels/feishu/.env`（权限 600）。

### 第 5 步：授权用户

通过飞书 open\_id 将用户添加到白名单：

```bash
claude-feishu access allow ou_xxxxxxxxxxxxxxxxxxxx
```

要查找用户的 open\_id，可在用户向机器人发送消息后查看调试日志：

```bash
tail -5 ~/.claude/channels/feishu/debug.log
```

也可以设置默认聊天 ID 用于出站消息（可选）：

```bash
claude-feishu auth chat-id oc_xxxxxxxxxxxxxxxxxxxx
```

大功告成——授权用户现在可以向机器人发消息，Claude 即会回复。

***

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

### 3. 手动启动 Router（可选）

```bash
bun run router
```

### 4. 查看 Router 状态

```bash
kill -USR1 $(pgrep -f 'bun router.ts')
cat ~/.claude/channels/feishu/router-debug.log | tail -10
```

***

## 访问管理

所有访问管理命令在 Claude Code 终端中通过 `claude-feishu access` 运行。

### 查看状态

```
claude-feishu access
```

### 私聊策略

| 策略              | 行为                                   |
| --------------- | ------------------------------------ |
| `allowlist`（默认） | 仅 `allowFrom` 中的用户可以发送私聊消息；其他用户被静默丢弃 |
| `disabled`      | 所有私聊消息被丢弃                            |

```
claude-feishu access policy allowlist
```

### 用户管理

```bash
# 按 open_id 允许用户
claude-feishu access allow ou_xxxxxxxxxxxxxxxxxxxx

# 移除用户
claude-feishu access remove ou_xxxxxxxxxxxxxxxxxxxx
```

### 群聊管理

群聊默认关闭。需先由群管理员将机器人添加到群中。

```bash
# 启用群聊（仅 @提及时响应）
claude-feishu access group add oc_xxxxxxxxxxxxxxxxxxxx

# 响应所有消息（无需 @提及）
claude-feishu access group add oc_xxxxxxxxxxxxxxxxxxxx --no-mention

# 限制群内特定用户
claude-feishu access group add oc_xxxxxxxxxxxxxxxxxxxx --allow ou_id1,ou_id2

# 移除群聊
claude-feishu access group rm oc_xxxxxxxxxxxxxxxxxxxx
```

### 投递设置

```bash
# 收到消息时回应表情（默认：Get）
claude-feishu access set ackReaction Get

# 设置每条消息的最大字符数
claude-feishu access set textChunkLimit 4096

# 群聊自定义触发模式
claude-feishu access set mentionPatterns ["@claude","@assistant"]
```

***

## 文件结构

```
~/.claude/channels/feishu/
├── .env              # 应用凭据（FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_CHAT_ID）
├── access.json       # 访问控制状态（自动管理）
├── debug.log         # 服务端调试日志（5MB 自动轮换，3 份备份）
├── router-debug.log  # Router 调试日志（5MB 自动轮换，3 份备份）
└── router.sock       # Worker-Router IPC 的 Unix socket
```

***

## 多设备同步

在多台设备上使用同一个飞书机器人（例如：公司电脑 + 家里笔记本），只需复制**两个文件**：

### 需要复制的文件

| 文件                 | 内容                                                                | 是否必须同步                    |
| ------------------ | ----------------------------------------------------------------- | ------------------------- |
| `.env`             | 应用凭据（FEISHU\_APP\_ID, FEISHU\_APP\_SECRET, FEISHU\_APP\_CHAT\_ID） | ✅ **必须** — 没有它机器人无法连接     |
| `access.json`      | 访问控制（allowFrom、群组、策略）                                             | ✅ **必须** — 没有它所有用户都显示为未授权 |
| `debug.log`        | 调试日志                                                              | ❌ 不需要 — 自动创建并自动轮换         |
| `router-debug.log` | Router 调试日志                                                       | ❌ 不需要 — 自动创建并自动轮换         |
| `router.sock`      | Unix socket                                                       | ❌ 不需要 — 运行时自动创建           |

### 同步方式

**方式一：手动复制**

```bash
# 在源设备上
scp ~/.claude/channels/feishu/.env ~/.claude/channels/feishu/access.json 目标设备:~

# 在目标设备上
mkdir -p ~/.claude/channels/feishu
mv ~/.env ~/.claude/channels/feishu/.env
mv ~/access.json ~/.claude/channels/feishu/access.json
chmod 600 ~/.claude/channels/feishu/.env
```

**方式二：软链接到同步文件夹**（如 Dropbox、iCloud、Syncthing）

```bash
# 创建同步配置文件夹
mkdir -p ~/Sync/feishu-config

# 将现有配置复制进去
cp ~/.claude/channels/feishu/.env ~/.claude/channels/feishu/access.json ~/Sync/feishu-config/

# 用软链接替换原文件
mv ~/.claude/channels/feishu/.env ~/.claude/channels/feishu/.env.bak
mv ~/.claude/channels/feishu/access.json ~/.claude/channels/feishu/access.json.bak
ln -s ~/Sync/feishu-config/.env ~/.claude/channels/feishu/.env
ln -s ~/Sync/feishu-config/access.json ~/.claude/channels/feishu/access.json
```

**方式三：使用 FEISHU\_STATE\_DIR 指向同步位置**

```bash
# 添加到 shell 配置文件（~/.bashrc、~/.zshrc 等）
export FEISHU_STATE_DIR="$HOME/Sync/feishu-config"
```

这样整个状态目录都在同步文件夹中——无需软链接。

### 注意事项

- **Channel 模式下同一时间只能有一台设备运行机器人**。同一应用的两个 WebSocket 连接可能导致消息丢失或重复。
- **Router 模式支持多设备**：每台设备运行自己的 Worker，Router 负责去重。但 Router 本身只应在一台设备上运行。
- **`access.json`** **变更不会自动同步**：在设备 A 上添加用户后，设备 B 在文件同步前不会看到变更。2 秒的访问缓存意味着同步后变更会很快生效。
- **`access.json`** **中的** **`workdir`** **路径是绝对路径**：`/home/user/project-a` 在另一台设备上可能不存在。请使用一致的路径或按设备调整。

***

## 环境变量

| 变量                   | 必需 | 说明                                        |
| -------------------- | -- | ----------------------------------------- |
| `FEISHU_APP_ID`      | 是  | 飞书应用 ID（`cli_...`）                        |
| `FEISHU_APP_SECRET`  | 是  | 飞书应用密钥                                    |
| `FEISHU_ENCRYPT_KEY` | 否  | 事件载荷加密密钥                                  |
| `FEISHU_APP_CHAT_ID` | 否  | 出站消息的默认聊天 ID（未指定 chat\_id 时的回退）           |
| `FEISHU_ACCESS_MODE` | 否  | 设为 `static` 使用纯白名单模式（运行时不写入 access.json）  |
| `FEISHU_STATE_DIR`   | 否  | 覆盖状态目录路径（默认：`~/.claude/channels/feishu/`） |

***

## 工作原理

### 智能连接检测

插件通过向上遍历进程树，检查祖先进程命令行中是否包含 `--dangerously-load-development-channels` 和 `feishu`，来判断当前是否运行在飞书频道的 Claude 实例下。非频道 Claude 实例（如普通 `claude` 或 `claude --channels plugin:discord@...`）会跳过飞书 WebSocket 连接，仅保留 MCP 工具可用。

### 孤儿进程保护

当父 Claude 进程退出时，插件在 2 秒内检测到 ppid 变化并优雅关闭。这防止了孤儿 `bun server.ts` 进程占用 100% CPU——这是由于 Bun 在 Unix domain socket 断开时不可靠地触发 stdin `end`/`close` 事件的变通方案。

### Worker 自动重连

当 Worker 与 Router 的 Unix socket 连接断开时，3 秒后自动尝试重连。无需手动干预即可应对 Router 临时重启和网络抖动。

### 访问控制缓存

`access.json` 文件基于修改时间的 2 秒 TTL 缓存。避免每条消息都调用 `readFileSync`，同时确保配置变更在数秒内生效。

### 日志轮换

调试日志（`debug.log`、`router-debug.log`）超过 5MB 时自动轮换。最多保留 3 份备份文件（`debug.log.1`、`debug.log.2`、`debug.log.3`）。轮换检查采用惰性策略，每 100 次写入检查一次以减少开销。

***

## 测试与开发

```bash
bun test              # 运行测试（65 个测试）
bun run lint          # 使用 Biome 检查代码风格
bun run lint:fix      # 自动修复代码风格问题
bun run format        # 使用 Biome 格式化代码
bun run typecheck     # TypeScript 类型检查
bun run check         # 完整检查：类型检查 + 代码风格 + 测试
```

测试覆盖：访问控制（gate 逻辑）、文本分块、提及检测、权限回复解析（包括 `yy`/`yesyes` 始终允许）、确认码生成、聊天授权、聊天 ID 解析与回退、消息解析、附件信息、时间戳格式化、日志轮换、Router 工作目录解析、访问缓存。

***

## 安全性

- 凭据文件权限 `chmod 600`——仅所有者可读
- 状态目录权限 `chmod 700`
- Router Unix socket 权限 `chmod 600`
- 确认码使用 8 字节加密随机数（`crypto.randomBytes`）
- 访问控制变更只能在 Claude Code 终端中操作——绝不能从频道消息中操作（防止提示注入）
- 聊天白名单阻止未授权消息投递
- 日志轮换防止无限增长导致磁盘耗尽
- 日志输出对敏感 ID（open\_id、chat\_id）进行脱敏
- PID 校验防止误判祖先进程
- 正则转义防止 CLI 模式处理中的注入
- 待处理权限和确认自动在 1 小时后过期

***

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
npx lark-for-claude
```

自动完成：安装 → 注册插件 → 创建 `claude-feishu` 快捷方式。

### 凭据配置

```bash
# 写入凭据到状态目录
mkdir -p ~/.claude/channels/feishu
cat > ~/.claude/channels/feishu/.env << 'EOF'
FEISHU_APP_ID=cli_YOUR_APP_ID
FEISHU_APP_SECRET=YOUR_APP_SECRET
FEISHU_APP_CHAT_ID=oc_YOUR_CHAT_ID
EOF
chmod 600 ~/.claude/channels/feishu/.env
```

或在 Claude Code 会话中使用 CLI 命令：

```
claude-feishu auth cli_YOUR_APP_ID YOUR_APP_SECRET
claude-feishu auth chat-id oc_YOUR_CHAT_ID
```

### 多群路由配置

写入 `~/.claude/channels/feishu/access.json`：

```json
{
  "dmPolicy": "allowlist",
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
  "ackReaction": "Get",
  "defaultWorkdir": "/absolute/path/to/default-project"
}
```

关键字段：

- `groups[chat_id].workdir` — 将飞书群映射到项目目录
- `defaultWorkdir` — 私聊和未配置群组的回退目录
- `dmPolicy` — `allowlist`（默认）或 `disabled`
- `ackReaction` — 已读回执的表情码（默认：`Get`）

### 启动命令

```bash
# 单项目（Channel 模式或自动 Router）
cd /path/to/project && claude-feishu

# 多项目（Router 模式）
cd /path/to/project-a && claude-feishu &  # 首个：启动 Router
cd /path/to/project-b && claude-feishu &  # 连接为 Worker
```

### 用户授权

按 open\_id 预授权用户：

```bash
claude-feishu access allow ou_xxxxxxxxxxxxxxxxxxxx
```

要查找用户的 open\_id，可在用户发送消息后查看调试日志：

```bash
tail -5 ~/.claude/channels/feishu/debug.log
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

| 症状         | 检查                          | 修复                                                |
| ---------- | --------------------------- | ------------------------------------------------- |
| 机器人无响应     | `debug.log` 中的错误            | 验证 `.env` 中的凭据                                    |
| Router 未启动 | `router-debug.log`          | 检查端口/socket 是否被占用                                 |
| Worker 未连接 | `debug.log` 中的 "worker" 条目  | 验证 Router socket 是否存在                             |
| 私聊被静默丢弃    | `access.json` 中的 `dmPolicy` | 必须为 `allowlist`，不能是 `disabled`；将用户添加到 `allowFrom` |
| 群消息被忽略     | 群是否在 `access.json` 中？       | `claude-feishu access group add <chat_id>`        |
| 卡片按钮无效     | 回调是否已配置？                    | 在飞书应用中添加 `card.action.trigger`                    |
| 出站消息无默认聊天  | 是否设置了 `FEISHU_APP_CHAT_ID`？ | `claude-feishu auth chat-id <chat_id>`            |

***

## 许可证

MIT
