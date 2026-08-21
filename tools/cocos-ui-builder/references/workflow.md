# Cocos UI 自动化工作流

## 输入归一化

- 同时有效果图和策划案：效果图决定视觉结构，策划案决定状态、数据和交互。
- 只有效果图：提取画布尺寸、区域、节点层级、复用元素和缺失交互。
- 只有策划案：提取页面状态、数据字段、按钮行为、空状态和异常状态，视觉使用项目同类页面规范。
- 只有一句需求：先盘点同模块与同类型页面；只有会改变业务行为的缺失信息才询问用户。

归一化结果保持在当前任务上下文中。只有复杂页面才创建 `requirements.normalized.json`，不要把文档内容复制进 `status.json`。

## 资产路线

执行：

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js scan <关键词...> --limit 80
```

按优先级选择：

1. 高匹配现有 Prefab：使用该 Prefab 作为 `target.prefab`，设置 `update-only`。
2. 相似 Prefab：当前 MVP 不自动复制复杂 Prefab；使用其结构作为参考，创建新的受管 Prefab。
3. 有通用组件或页面模板：在蓝图中组装复用组件。
4. 无可复用内容：设置 `update-or-create`，由 Creator 扩展创建新 Prefab。

不要只凭文件名认定 Prefab 可直接覆盖。修改现有 Prefab 前检查同模块控制器和节点职责；自动化只增改蓝图声明的节点，不删除未声明节点。

## 执行顺序

1. 编写或修改 TypeScript 业务代码。
2. 运行 ESLint/TypeScript 检查。
3. 等待 Creator 完成新增脚本导入和编译。
4. 生成或更新 `ui-blueprint.json`。
5. 执行 `validate` 和 `dry-run`。
6. dry-run 无错误、无缺失资源后，通过 `node packages/mcp-bridge/tools/cocos-ui-builder/cli.js apply <蓝图路径>` 执行；CLI 会先在系统临时目录建立项目外安全副本。
7. `apply` 内部完成批量节点变更、保存前语义校验和一次保存。
8. 保存后必须关闭并重新打开目标 Prefab，再次执行语义校验。Creator 无响应、Prefab 无法重新打开或复检失败时，整次操作失败：已有 Prefab 恢复原内容，新建的无效 Prefab 自动移除；若 Creator 进程中断，CLI 使用项目外副本恢复已有文件，或将可疑的新 Prefab 与 `.meta` 隔离到系统临时目录。
9. 执行功能验收：检查脚本编译、节点与组件引用、事件绑定、显隐与关键状态切换；默认不截图。

## 状态文件

`status.json` 只保存：

```json
{
  "stage": "code|blueprint|apply|verify|done|blocked",
  "blueprint": "项目相对路径",
  "target": "db://assets/...prefab",
  "lastSuccessHash": "可选",
  "blockers": []
}
```

不要写入完整节点树、Creator 日志、图片分析全文或代码片段。

## 停止条件

- dry-run 存在缺失资源或 Schema 错误：不进入 Creator。
- 目标为复杂现有 Prefab 且无法确认安全根节点：停止并请求用户指定目标或改为新建。
- Creator 语义校验失败：不保存现有 Prefab。
- `apply` 没有返回 `success: true`、`health.prefabReopened: true` 和回读语义校验结果：不得标记完成。
- 保存后健康检查失败：确认 `rollback.restored: true`；否则立即停止，不再操作其他资源。
- 关键交互缺少可自动验证入口：输出 3 至 5 步最小人工点击验收步骤，不使用截图弥补。

## 功能验收标准

- TypeScript 与本次变更范围内的 ESLint 检查通过。
- `validate`、`dry-run`、保存前语义校验、保存后重新打开校验均无错误，资源引用无缺失。
- Creator 在操作后仍可响应，目标 Prefab 能正常进入编辑模式并解析出有效根节点。
- 需求涉及的节点、组件、事件绑定、打开/关闭入口和状态刷新路径存在。
- 能自动驱动运行时交互时，验证关键按钮与状态转换；不能自动驱动时，在 `handoff.md` 中给出最小人工点击路径。
- 默认不做截图、像素对比或视觉修正循环；只有用户明确提出视觉验收时才启用。
