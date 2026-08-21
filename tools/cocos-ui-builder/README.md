# Cocos UI Builder 使用与迁移指南

## 1. 这套工具解决什么问题

Cocos UI Builder 面向 Cocos Creator 2.4.x，用声明式 `ui-blueprint.json` 一次性创建或更新 UI Prefab，避免 AI 逐节点调用 MCP。

默认目标是先让功能和流程跑通：不依赖截图，不做像素级还原，不直接编辑 `.prefab`、`.scene`、`.fire` 或 `.meta` 文本。

整套方案由三部分组成：

- `packages/mcp-bridge/`：运行在 Creator 内的 MCP 插件，负责批量应用、保存、重新打开校验和内部回滚。
- `packages/mcp-bridge/tools/cocos-ui-builder/`：与 Bridge 同版本交付的项目外 CLI，负责资产扫描、蓝图校验、dry-run、外部安全备份和调用 MCP。
- `.agents/skills/cocos-ui-builder/`：告诉 AI 何时、按什么顺序使用上述工具。

CLI 与 MCP Bridge 共享 Blueprint 格式和事务健康契约，因此放在同一仓库、按同一
commit/tag 交付；为降低 fork 同步冲突，CLI 只占用独立的 `tools/cocos-ui-builder/`
新增目录，不接入上游已有源码目录。Skill 是可单独复制的使用说明，不在项目或
Bridge 内维护第二份镜像。没有运行中的 MCP Bridge 时，仍可扫描资产、生成蓝图并
执行本地 `validate`/`dry-run`；真正创建或修改 Prefab 的 `apply` 必须连接 Creator
内的 Bridge。禁止在 Bridge 离线时退回手改 `.prefab` 或 `.meta`。

## 2. 日常使用：只说一句需求

是的，你可以直接这样说：

```text
docs/hero/ 是功能说明和效果图。
使用 cocos-ui-builder 根据其中资料实现英雄升星功能，优先保证功能和流程跑通，不做截图验收。
有合适的现成 Prefab 就安全更新，没有就新建；资源不合适时使用 Label、Button、Sprite 和空节点搭功能骨架。
```

或者更短：

```text
使用 cocos-ui-builder，根据 docs/hero/ 实现英雄升星功能，功能优先，不需要截图。
```

支持自动发现 Skill 的 AI 还可以省略技能名，直接说：

```text
docs/hero/ 是功能说明和效果图，根据里面的资料帮我实现英雄升星功能，功能优先，不需要截图。
```

为了让不同 AI 客户端的行为更稳定，推荐保留“使用 cocos-ui-builder”这一句，但不需要写任何命令。

这就是正常入口。你不需要创建蓝图，也不需要手工运行下面的命令。AI 会自动：

1. 枚举 `docs/hero/`，读取其中的策划案、Markdown、JSON、文本等说明；效果图只作为可选输入。
2. 检查同模块代码和现有 Prefab，决定安全更新还是新建。
3. 编写业务 TypeScript。
4. 生成 UI 蓝图。
5. 自动完成连接检查、有限资产扫描、蓝图校验、dry-run 和安全 apply。
6. 确认 Creator 仍可用、Prefab 能关闭后重新打开，再交付结果。

为了兼容不支持图片的 AI，建议资料目录里至少放一份文字功能说明。只有效果图而没有任何交互说明时，AI 只能搭静态骨架，不能可靠推断业务流程。

## 3. 五个命令分别做什么

这五个命令是 AI 的内部流水线，也是发生问题时给开发者使用的排障入口：

- `status`：确认 MCP Bridge 是否在线，并核对连接的是不是当前 Creator 项目；不修改任何文件。
- `scan`：按模块关键词快速找现有 Prefab、图片、字体和同类 TypeScript；只返回路径。一次没找到高匹配资源就停止扫描，改用基础节点。
- `validate`：检查 AI 生成的蓝图 JSON 是否符合格式，节点、组件和事件引用是否完整；不连接 Creator。
- `dry-run`：连接项目信息做执行前预演，确认是新建还是更新，并检查资源路径是否缺失；不修改 Prefab。
- `apply`：唯一真正修改 Prefab 的步骤。它先备份，再让 Creator 批量应用、保存、关闭、重新打开和复检；失败会回滚或隔离无效新文件。

对应关系可以理解为：

```text
status   = 找到正确的 Creator
scan     = 找可复用内容
validate = 检查蓝图写得对不对
dry-run  = 检查这次准备改什么、能不能安全改
apply    = 真正落地，并验证 Creator 和 Prefab 仍然正常
```

日常让 AI 实现功能时，不需要在提示词里写这五个命令。只要说“使用 cocos-ui-builder”并给出资料目录或需求即可。

## 4. 首次启用（只做一次）

### 4.1 构建 MCP Bridge

在项目根目录执行：

```bash
cd packages/mcp-bridge
npm install
npm run build
npm run test:mcp
```

不要省略 `test:mcp`：`build` 只能证明代码可生成 dist，测试才会确认最终代理
实际暴露了 UI Blueprint 工具并满足协议与健康契约。两者通过后再重启 Creator。

`dist/` 和 `node_modules/` 不进入 Git，因此首次安装、切换版本或修改 MCP Bridge 源码后都需要重新构建。

### 4.2 启动 Creator 和 MCP 服务

1. 重新启动 Cocos Creator，使其加载最新的 `dist/main.js` 和 `dist/scene-script.js`。
2. 打开菜单 `MCP 桥接器/开启MCP设置面板`。
3. 启动 MCP 服务；默认端口从 `8200` 开始，多项目并行时会自动选择后续端口。
4. 回到项目根目录检查连接：

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js status
```

返回的 `projectPath` 必须是当前项目。找不到服务时可以显式指定端口：

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js status --port 8200
```

默认目录布局是 `<Cocos项目>/packages/mcp-bridge`。若 Bridge 安装在其他位置，
所有 CLI 命令都可加 `--project <Cocos项目根目录>`，不需要修改工具源码。

## 5. 更多提示词示例

没有独立资料目录时，可以直接给 AI 这样的任务：

```text
使用 cocos-ui-builder 实现“邮件奖励弹窗”。
优先保证打开、关闭、领取和空状态流程可用，不做截图验收。
如果没有合适资源，先使用 Label、Button、Sprite 和空节点搭出功能骨架。
必须通过 packages/mcp-bridge/tools/cocos-ui-builder/cli.js apply 落地，不要直接调用底层 apply_ui_blueprint。
```

AI 应按以下顺序执行：

1. 阅读策划案、简短需求或可选参考图。
2. 检查同模块代码和现有 Prefab；功能优先模式只做一次有限扫描，未找到高匹配内容就使用基础节点。
3. 先编写业务 TypeScript，并等待 Creator 导入和编译。
4. 生成 `ui-blueprint.json`。
5. 依次执行 `validate`、`dry-run`、`apply`。
6. 只在 `apply` 返回完整健康结果后标记完成。

## 6. 手动命令与排障

正常的 AI 任务不需要手工执行本节命令。排查连接、蓝图或资源问题时，所有命令都从 Cocos 项目根目录执行。

### 6.1 扫描可复用内容

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js scan mail reward 邮件 奖励 --limit 40
```

扫描只返回轻量路径索引。为了速度，不要反复全项目扫描；一次没有高匹配结果即可进入基础节点方案。

### 6.2 校验蓝图 JSON

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js validate path/to/ui-blueprint.json
```

它检查 Schema、节点语义 ID、组件、事件和引用格式，不连接 Creator，也不修改资源。

### 6.3 dry-run

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js dry-run path/to/ui-blueprint.json
```

它额外检查目标 Prefab 是否存在、计划执行创建还是更新、蓝图引用的资源是否缺失。存在错误或 `missingAssets` 时禁止 `apply`。

### 6.4 安全应用

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js apply path/to/ui-blueprint.json
```

也可以指定 Creator 端口：

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js apply path/to/ui-blueprint.json --port 8200
```

`apply` 默认在保存、重开和语义校验后返回普通场景，以便下一次事务先检查目标
Prefab 是否在当前场景中存在自动同步实例。仅在明确需要停留于 Prefab 编辑模式做
人工诊断时使用 `--keep-open`；若预检发现自动同步实例，事务会在写入前拒绝，避免
Creator 2.4 弹出“应用/退回”并阻塞自动保存。

不要绕过 CLI 直接调用 MCP 的 `apply_ui_blueprint`。Creator 内部回滚由 MCP Bridge 完成，而 Creator 进程异常退出时的项目外恢复由 CLI 完成。

## 7. 蓝图最小示例

完整字段说明见 [references/blueprint.md](references/blueprint.md)，Schema 位于 [schema/ui-blueprint.schema.json](schema/ui-blueprint.schema.json)，可运行示例位于 [examples/minimal.ui-blueprint.json](examples/minimal.ui-blueprint.json)。

```json
{
  "version": 1,
  "target": {
    "prefab": "db://assets/ui_generated/MailRewardView.prefab",
    "mode": "update-or-create"
  },
  "root": {
    "id": "MailRewardView",
    "type": "page",
    "transform": {
      "width": 750,
      "height": 1334
    },
    "children": [
      {
        "id": "title",
        "type": "label",
        "components": [
          {
            "type": "cc.Label",
            "properties": {
              "string": "Mail Reward",
              "fontSize": 36
            }
          }
        ]
      },
      {
        "id": "closeButton",
        "type": "button",
        "transform": {
          "width": 120,
          "height": 64
        }
      }
    ]
  }
}
```

目标模式：

- `update-only`：只允许更新已存在的 Prefab，目标不存在时停止。
- `create-only`：只允许新建，目标已经存在时停止。
- `update-or-create`：存在则更新，不存在则新建。

更新现有复杂 Prefab 时优先使用 `update-only`，避免路径写错后意外创建新文件。

## 8. 成功标准与故障恢复

已保存的操作只有同时满足以下条件才算成功：

- 返回 `success: true`。
- 返回 `saved: true`。
- 返回 `health.creatorResponsive: true`。
- 返回 `health.prefabReopened: true`。
- 重新打开后的 `health.validation.valid` 为 `true`。

安全执行顺序为：

1. CLI 在系统临时目录备份已有 Prefab。
2. Creator 打开目标 Prefab；打不开则不修改。
3. 批量应用蓝图并执行保存前语义校验。
4. Creator 保存一次。
5. 关闭并重新打开目标 Prefab。
6. 再次验证根节点、组件、资源和节点引用。
7. 全部通过后删除临时备份并返回成功。

失败时：

- 已有 Prefab 由 MCP Bridge 恢复操作前内容，并重新检查能否打开。
- 无效的新 Prefab 由 MCP Bridge 删除。
- Creator 进程中断或内部回滚结果不完整时，CLI 恢复已有 Prefab；新 Prefab 及其 `.meta` 会被移动到结果中给出的 `externalRecovery.backupDir`，不会继续留在 `assets/` 阻塞下次启动。
- 没有 `success: true` 的结果禁止继续操作其他 Prefab。

无法对断电、磁盘损坏等系统级故障作绝对保证，但正常的脚本异常、资源缺失、Prefab 无法重新打开和 Creator 连接中断都会按失败处理，不会误报完成。

## 9. Git 仓库关系与提交建议

当前 `packages/mcp-bridge` 是独立 Git 仓库，不是主项目的 submodule：

- 主仓库：包含当前 Cocos 项目的外层 Git 仓库
- MCP Bridge 仓库：`GameClient/packages/mcp-bridge`
- 主仓库通过 `.gitignore` 的 `GameClient/packages/*` 忽略它

因此可以在 `packages/mcp-bridge` 内单独提交，但有两个重要结果：

1. 主项目的提交不会记录 MCP Bridge 的 commit，也不会把它分发给其他开发者。
2. 其他人拉取主项目后，必须另外 clone/更新 MCP Bridge，或由主项目改成 Git submodule 才能固定版本。

当前 UI Blueprint 改动以新增逻辑为主：新增四个 MCP 工具、蓝图场景处理器、健康检查和回滚流程。旧工具的路由和参数没有被替换；唯一触及旧删除逻辑的改动，是不再为没有父节点的临时节点发送 `scene:dirty`。因此对旧工具的直接影响较低，但 MCP Bridge 是整体编译和加载的 Creator 插件，仍需要执行构建、smoke test，并在测试 Prefab 上做一次 Creator 重开验证后再合入公共分支。

推荐在 MCP Bridge 独立仓库先创建功能分支并提 PR，而不是直接把未验证变更推到共享 `dev`：

```bash
cd packages/mcp-bridge
git switch -c feat/ui-blueprint-safe-apply
npm run build
npm run test:mcp
git add scripts/smoke-mcp.js src/scene-script.ts src/tools/ToolDispatcher.ts src/tools/ToolRegistry.ts src/utils/UiBlueprint.ts
git commit -m "feat: add safe UI blueprint transactions"
```

CLI 位于 MCP Bridge 自己的 `tools/cocos-ui-builder/` 隔离目录，并随 Bridge 同一
commit/tag 交付；这避免主项目和 fork 各维护一份协议客户端，也尽量不触碰上游
已有目录。Skill 自包含在外层仓库 `.agents/skills/cocos-ui-builder/` 的单一目录中，
迁移时只需复制整个 Skill 目录，不在 GameClient 或 MCP Bridge 内维护镜像。长期给
多个项目使用时，应为 MCP Bridge 打 tag，并通过 submodule 或明确 commit 锁定版本。

## 10. 迁移到其他项目

### 10.1 必须提供

1. MCP Bridge 的已提交版本：clone 到目标项目的 `packages/mcp-bridge/`。
2. 整个 `.agents/skills/cocos-ui-builder/` 自包含目录。
3. 目标工作区自己的 `.codex/config.toml` MCP 连接配置；它只保存相对启动路径，不复制 Skill 内容。

### 10.2 按使用的 AI 客户端选择

- 使用支持 Agent Skill 的客户端：保留 `.agents/skills/cocos-ui-builder/`，并按客户端要求注册或扫描该目录。
- 不使用 Skill 的客户端：仍可直接运行 CLI，但需要把本文件中的执行顺序放入项目规则或提示词。

### 10.3 不要复制

- `packages/mcp-bridge/node_modules/`
- `packages/mcp-bridge/dist/`，应在目标机器重新构建；只有发布预编译安装包时才包含它
- Creator 的 `library/`、`temp/`、`local/`、`build/`
- 当前项目的 `settings/mcp-bridge.json`
- 任何手工创建或从其他项目复用的 `.meta`

### 10.4 目标项目安装步骤

```bash
git clone --branch <已验证分支或标签> <mcp-bridge仓库地址> packages/mcp-bridge
cd packages/mcp-bridge
npm install
npm run build
npm run test:mcp
cd ../..
```

然后：

1. 若 Codex 从 Cocos 项目根启动，配置 `cwd = "packages/mcp-bridge"`；若从包含 GameClient 的父仓库启动，配置 `cwd = "GameClient/packages/mcp-bridge"`。`command` 使用 `node`，`args` 使用 `["dist/mcp-proxy.js"]`，不要写旧项目的绝对路径。
2. 重启目标项目的 Cocos Creator 2.4.x。
3. 启动 MCP Bridge。
4. 执行 `node packages/mcp-bridge/tools/cocos-ui-builder/cli.js status`，确认返回目标项目路径。
5. 用目标项目内的路径生成一份测试蓝图。
6. 依次执行 `validate`、`dry-run`、`apply`。
7. 确认测试 Prefab 能自动关闭、重新打开并返回健康结果。
8. 通过 Creator 的 AssetDB 删除测试资源，不要在文件系统直接删除 Prefab 或 `.meta`。

### 10.5 兼容边界

- 当前实现面向 Cocos Creator 2.4.x，不应直接复制到 Creator 3.x。
- 蓝图中的项目自定义组件类必须先由 Creator 编译完成。
- 资源必须使用目标项目自己的 `db://assets/...` 路径，不可复制原项目 UUID。
- 不同项目的 UI 基类、资源管理、模块目录和代码规范不同，业务 TypeScript 必须按目标项目规则调整；蓝图工具本身不负责迁移业务框架。

更详细的执行规则见 [references/workflow.md](references/workflow.md)。
