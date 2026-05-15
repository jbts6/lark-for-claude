# 同步更新 README.md 和 README_CN.md

## 背景

代码经过多轮重构后，README 中的内容已严重过时，需要同步更新以反映当前代码的实际行为。

## 需要更新的差异点

### 1. 配对机制已完全移除
- `dmPolicy` 不再支持 `pairing`，只有 `allowlist` | `disabled`
- `claude-feishu access pair <code>` 和 `claude-feishu access deny <code>` 命令已移除
- 不再有配对码生成、配对审批流程
- 默认策略从 `pairing` 改为 `allowlist`
- "Step 5: Pair Your Account" 整节需要重写为 "Step 5: Authorize Users"
- "Pairing in Router Mode" 整节需要删除
- "DM pairing" 行在模式对比表中需要移除
- Features 中的 "DM pairing" 需要移除
- AI 部署指南中的配对流程需要更新

### 2. 三按钮卡片
- 确认卡片和权限卡片从 ✅/❌ 两按钮 → ✅/✅✅/❌ 三按钮
- ✅ = 允许一次，✅✅ = 始终允许，❌ = 拒绝
- 文字回复支持 `y code`（允许）、`yy code`（始终允许）、`n code`（拒绝）
- Features 中 "Confirm cards" 描述需要更新

### 3. FEISHU_APP_CHAT_ID 环境变量
- 新增 `FEISHU_APP_CHAT_ID` 环境变量，作为 `chat_id` 的回退
- `chat_id` 解析链：显式参数 → workdir 匹配 groups → `FEISHU_APP_CHAT_ID`
- 新增 `claude-feishu auth chat-id <chat_id>` 命令
- 环境变量表需要添加此变量

### 4. 文件布局变更
- `approved/` 目录已移除（不再有配对审批信号）
- `inbox/` 目录已移除（不再下载附件）
- `debug.log` 和 `router-debug.log` 现在自动轮换（5MB 上限，3 份备份）
- 文件布局图和多设备同步表需要更新

### 5. 安全性更新
- 确认码使用 8 字节随机性（crypto.randomBytes）
- 不再有配对码过期/限制相关安全条目
- 新增：日志自动轮换防止磁盘耗尽
- 新增：PID 校验防止误判进程
- 新增：正则转义防止注入
- 新增：日志脱敏（redact）
- 新增：.env 文件权限 600
- 移除：配对码过期、未审批消息限制、并发配对码限制

### 6. 测试计数
- 从 58 tests → 65 tests

### 7. FEISHU_ACCESS_MODE 说明
- `static` 模式不再"降级为 allowlist"，而是直接使用 allowlist 逻辑
- 描述需要更准确

### 8. 访问管理命令更新
- `policy` 只接受 `allowlist` | `disabled`
- 移除 `pair` 和 `deny` 子命令
- 保留 `allow` 和 `remove` 子命令

### 9. AI 自动化部署指南
- `dmPolicy` 示例改为 `allowlist`
- 移除 `pending` 字段
- 移除配对流程
- 添加 `FEISHU_APP_CHAT_ID` 配置
- 故障排查表移除配对相关条目

## 实施步骤

| 步骤 | 内容 | 文件 |
|------|------|------|
| 1 | 更新 README.md（英文版） | README.md |
| 2 | 更新 README_CN.md（中文版） | README_CN.md |
| 3 | 交叉检查两版一致性 | README.md, README_CN.md |

### 步骤 1: README.md 更新清单

1. **模式对比表**：移除 "DM pairing" 行
2. **Worker Mode 关键行为**：移除 "DM pairing" 条目
3. **Features 列表**：
   - 移除 "DM pairing" 条目
   - 更新 "Confirm cards" 描述为三按钮
   - 更新 "Access control" 描述（移除 pairing-based onboarding）
4. **Quick Start Step 5**：重写为 "Authorize Users"（使用 `access allow`）
5. **Multi-Group Router Setup**：
   - 移除 "3. Pairing in Router Mode" 整节
   - 重新编号后续节
6. **Access Management**：
   - DM Policies 表：移除 `pairing` 行，更新默认为 `allowlist`
   - 移除 `pair` 和 `deny` 命令
   - 更新 `policy` 命令只接受 `allowlist|disabled`
7. **File Layout**：移除 `approved/` 和 `inbox/`，添加日志轮换说明
8. **Multi-Device Sync**：更新文件表，移除 `approved/` 行
9. **Environment Variables**：添加 `FEISHU_APP_CHAT_ID`，更新 `FEISHU_ACCESS_MODE` 描述
10. **Security**：更新安全条目（移除配对相关，添加新安全措施）
11. **Testing**：更新测试计数为 65
12. **AI Deployment Guide**：
    - 更新 `dmPolicy` 示例
    - 移除 `pending` 字段
    - 添加 `FEISHU_APP_CHAT_ID`
    - 更新配对流程为 `access allow`
    - 更新故障排查表

### 步骤 2: README_CN.md 同步更新

所有与 README.md 相同的变更点，翻译为中文。
