# UI Blueprint v1

Schema：`packages/mcp-bridge/tools/cocos-ui-builder/schema/ui-blueprint.schema.json`

## 节点身份

- `id` 是整份蓝图内唯一的语义 ID。
- 默认节点名称等于 `name || id`。
- 更新现有 Prefab 时，批处理器在当前父节点下按名称匹配；因此同一父节点下的受管节点名称必须唯一。
- v1 不会删除蓝图之外的节点。

## 支持的节点类型

- `node`、`page`、`container`：普通节点。
- `sprite`：自动确保 `cc.Sprite`。
- `label`：自动确保 `cc.Label`。
- `button`：自动确保 `cc.Sprite` 和 `cc.Button`。
- `layout`：自动确保 `cc.Layout`。

`components` 可额外挂载 Cocos 内置组件或已完成编译的项目组件。

## 引用

资源引用使用路径：

```json
{ "$asset": "db://assets/path/image.png/image" }
```

节点引用使用语义 ID：

```json
{ "$node": "rewardList" }
```

组件引用：

```json
{
  "$component": {
    "node": "rewardList",
    "type": "RewardListComp"
  }
}
```

禁止在蓝图中写硬编码 UUID。

## 事件

```json
{
  "events": [
    {
      "sourceComponent": "cc.Button",
      "property": "clickEvents",
      "target": "rootView",
      "component": "SomeView",
      "handler": "onClickClose"
    }
  ]
}
```

自定义组件必须已经由 Creator 导入并编译完成，才能应用蓝图。

## 命令

```bash
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js validate path/to/ui-blueprint.json
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js dry-run path/to/ui-blueprint.json
node packages/mcp-bridge/tools/cocos-ui-builder/cli.js apply path/to/ui-blueprint.json
```

`apply` 会自动发现当前项目的 MCP Bridge 端口，也可以使用 `--port 8200`。
