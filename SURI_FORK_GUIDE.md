# Suri Fork 使用与维护指南

本文档只说明 `Suri089/mcp-bridge` Fork 增加的安装、同步和多 AI 客户端配置流程。上游项目的原始说明请查看 `README.md`。

## 仓库约定

- `origin`：`git@github.com:Suri089/mcp-bridge.git`
- `upstream`：`git@github.com:firekula/mcp-bridge.git`
- `main`：只跟随原作者的 `main`
- `dev`：保存通用 AI 客户端支持和其他 Fork 增强

## 新电脑或新 Cocos 项目一键安装

将以下任一脚本复制到 Cocos Creator 项目根目录，或与 `packages` 同级的 `tools` 目录：

- Windows：`setup-mcp.bat`
- macOS、Linux 或 Git Bash：`setup-mcp.sh`

Windows 可直接双击 `setup-mcp.bat`。脚本会自动：

1. 在当前项目的 `packages/mcp-bridge` 克隆 `origin/dev`；
2. 配置固定的 `upstream`；
3. 同步 `upstream/main` 到本地 `main`，再合并到 `dev`；
4. 执行 `npm install`；
5. 执行 `npm run build`；
6. 询问是否安装公共代理并配置检测到的 AI 客户端。

再次运行会安全更新已有仓库。出现以下情况时脚本会停止，不会删除或覆盖目录：

- `mcp-bridge` 存在未提交修改；
- 已有仓库的 `origin` 不是 `Suri089/mcp-bridge`；
- 目标目录存在但不是 Git 仓库；
- `main` 无法 fast-forward；
- 上游不可访问或合并发生冲突。

## 多项目共用一份 MCP 代理

建议每台机器只安装一份稳定的 `mcp-proxy.js`，所有 AI 客户端都指向它。各 Cocos Creator 项目仍分别安装完整插件，并监听 8200–8210 中的可用端口。

Windows 在仓库根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-ai-clients.ps1
```

脚本提示输入公共代理安装目录，默认是：

```text
%USERPROFILE%\.mcp-bridge
```

最终代理位置默认为：

```text
%USERPROFILE%\.mcp-bridge\mcp-proxy.js
```

脚本会：

1. 构建并复制 `dist/mcp-proxy.js`；
2. 扫描本机已安装的 AI 客户端；
3. 为已有配置创建带时间戳的备份；
4. 增量写入 `mcp-bridge` 配置；
5. 保留其他 MCP Server 和非 MCP 设置。

指定安装目录和客户端：

```powershell
.\scripts\install-ai-clients.ps1 `
    -InstallDirectory 'D:\Tools\mcp-bridge' `
    -Clients 'Codex','Claude Desktop','Cursor'
```

常用选项：

- `-ConfigureAll`：为清单中的全部客户端创建配置；
- `-SkipBuild`：直接安装已有的 `dist/mcp-proxy.js`。

配置完成后需重启对应 AI 客户端。Cocos Creator 的 MCP 设置面板仍负责启动/停止项目内服务；AI 客户端的一键配置不需要重复执行。

## 多项目路由原理

```text
Codex / Claude / Cursor / 其他 MCP 客户端
                    │ STDIO
                    ▼
       公共 mcp-proxy.js
                    │ 扫描 127.0.0.1:8200–8210
                    ▼
       各 Cocos 项目的 mcp-bridge
```

代理通过 `get_active_instances` 获取运行中的项目。如果同时运行多个项目，应通过 `set_active_instance` 选择目标端口，后续工具调用才会转发到对应项目。

## 手动同步上游

Windows 双击：

```text
scripts\sync-upstream.bat
```

或在终端运行：

```powershell
.\scripts\sync-upstream.ps1
```

macOS、Linux 或 Git Bash：

```bash
bash scripts/sync-upstream.sh
```

同步流程：

```text
upstream/main → 本地 main → origin/main → 当前开发分支
```

PowerShell 版本的常用选项：

- `-PushCurrentBranch`：同步完成后推送当前开发分支；
- `-SkipPushBase`：不推送 `origin/main`，只执行本地同步。

脚本发现脏工作区、非 fast-forward 的 `main` 或合并冲突时会停止，不执行强制重置。
