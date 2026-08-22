#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dryRun, loadBlueprint, scanAssets, validateBlueprint } = require('./lib/blueprint');

// CLI 与 Bridge 一同存放在 packages/mcp-bridge 中，但它操作的是宿主 Cocos
// 项目。把默认路径关系集中在这里，避免业务函数散落硬编码；在不同目录布局中
// 使用时可通过 --project 显式覆盖，从而保持工具可移植。
const bridgeRoot = path.resolve(__dirname, '..', '..');
const defaultProjectRoot = path.resolve(bridgeRoot, '..', '..');
const requiredBridgeTools = Object.freeze([
    'scan_ui_assets',
    'dry_run_ui_blueprint',
    'validate_ui_blueprint',
    'apply_ui_blueprint',
]);

function resolveProjectRoot(explicitPath) {
    if (explicitPath !== undefined && typeof explicitPath !== 'string') {
        throw new Error('--project 需要一个 Cocos 项目根目录路径');
    }
    const rootPath = explicitPath
        ? path.resolve(process.cwd(), explicitPath)
        : defaultProjectRoot;
    if (!fs.existsSync(path.join(rootPath, 'project.json')) || !fs.statSync(path.join(rootPath, 'project.json')).isFile()) {
        throw new Error(`未找到 Cocos project.json: ${rootPath}。请确认目录布局，或通过 --project 指定项目根目录。`);
    }
    if (!fs.existsSync(path.join(rootPath, 'assets')) || !fs.statSync(path.join(rootPath, 'assets')).isDirectory()) {
        throw new Error(`未找到 Cocos assets 目录: ${rootPath}`);
    }
    return rootPath;
}

function print(value, compact = false) {
    process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

function resolveTargetPrefabPath(blueprint, rootPath = defaultProjectRoot) {
    const targetUrl = blueprint && blueprint.target && blueprint.target.prefab;
    if (typeof targetUrl !== 'string' || !targetUrl.startsWith('db://assets/') || !targetUrl.endsWith('.prefab')) {
        throw new Error('蓝图目标不是合法的 assets Prefab 路径');
    }
    const assetsRoot = path.resolve(rootPath, 'assets');
    const targetPath = path.resolve(rootPath, targetUrl.slice('db://'.length));
    const relative = path.relative(assetsRoot, targetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('蓝图目标超出 assets 目录');
    return targetPath;
}

function beginSafetyBackup(blueprint, rootPath = defaultProjectRoot) {
    const targetPath = resolveTargetPrefabPath(blueprint, rootPath);
    const existed = fs.existsSync(targetPath);
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-ui-builder-'));
    const backupPath = path.join(backupDir, path.basename(targetPath) + '.before-apply');
    if (existed) fs.copyFileSync(targetPath, backupPath);
    return { targetPath, existed, backupDir, backupPath };
}

function recoverFromExternalBackup(transaction) {
    if (transaction.existed) {
        fs.mkdirSync(path.dirname(transaction.targetPath), { recursive: true });
        fs.copyFileSync(transaction.backupPath, transaction.targetPath);
        return { restored: true, action: 'restore-existing-prefab', backupDir: transaction.backupDir };
    }
    const quarantined = [];
    for (const sourcePath of [transaction.targetPath, `${transaction.targetPath}.meta`]) {
        if (!fs.existsSync(sourcePath)) continue;
        const quarantinePath = path.join(transaction.backupDir, path.basename(sourcePath));
        fs.renameSync(sourcePath, quarantinePath);
        quarantined.push(quarantinePath);
    }
    return { restored: true, action: 'quarantine-invalid-new-prefab', quarantined, backupDir: transaction.backupDir };
}

function clearSafetyBackup(transaction) {
    const tempRoot = path.resolve(os.tmpdir());
    const backupDir = path.resolve(transaction.backupDir);
    const relative = path.relative(tempRoot, backupDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(backupDir).startsWith('cocos-ui-builder-')) {
        throw new Error(`拒绝清理非预期安全副本目录: ${backupDir}`);
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
}

/**
 * 保存型事务的成功条件必须完整满足 Creator 存活、Prefab 重开和回读语义校验。
 * 单看 `success` 或 `prefabReopened` 会把“重开后组件/引用已经损坏”误报为成功。
 * `--no-save` 只用于诊断：它没有磁盘副作用，因此改用 diskUnchanged 契约。
 */
function isApplyResultHealthy(result) {
    const savedResultIsHealthy = !!(
        result &&
        result.success === true &&
        result.saved === true &&
        result.health &&
        result.health.creatorResponsive === true &&
        result.health.prefabReopened === true &&
        result.health.validation &&
        result.health.validation.valid === true
    );
    const unsavedResultIsSafe = !!(
        result &&
        result.success === true &&
        result.saved === false &&
        result.diskUnchanged === true
    );
    return savedResultIsHealthy || unsavedResultIsSafe;
}

function parseOptions(values) {
    const positional = [];
    const options = {};
    for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (!value.startsWith('--')) {
            positional.push(value);
            continue;
        }
        const key = value.slice(2);
        const next = values[index + 1];
        if (!next || next.startsWith('--')) options[key] = true;
        else {
            options[key] = next;
            index++;
        }
    }
    return { positional, options };
}

function requestJson(port, route, body, timeoutMs = 65000) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? '' : JSON.stringify(body);
        const request = http.request({
            host: '127.0.0.1',
            port,
            path: route,
            method: body === undefined ? 'GET' : 'POST',
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
            timeout: timeoutMs,
        }, response => {
            let data = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { data += chunk; });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}: ${data}`));
                try { resolve(JSON.parse(data)); }
                catch (error) { reject(new Error(`响应不是合法 JSON: ${error.message}`)); }
            });
        });
        request.on('timeout', () => request.destroy(new Error(`请求超时: ${route}`)));
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

async function discoverPort(explicitPort, rootPath = defaultProjectRoot) {
    const ports = explicitPort ? [Number(explicitPort)] : Array.from({ length: 11 }, (_, index) => 8200 + index);
    for (const port of ports) {
        try {
            const status = await requestJson(port, '/mcp-status', undefined, 700);
            if (status && typeof status.projectPath === 'string' &&
                path.resolve(status.projectPath).toLowerCase() === path.resolve(rootPath).toLowerCase()) return port;
        } catch (_error) {}
    }
    throw new Error('未找到当前项目的 MCP Bridge。请在 Creator 中启动 MCP 桥接器，或通过 --port 指定端口。');
}

async function callTool(port, name, args) {
    const response = await requestJson(port, '/call-tool', { name, arguments: args });
    const text = response && response.content && response.content[0] ? response.content[0].text : '';
    if (typeof text === 'string' && text.startsWith('Error:')) throw new Error(text.slice(6).trim());
    try { return JSON.parse(text); }
    catch (_error) { return { message: text }; }
}

/**
 * 在开始安全副本和 Creator 事务前确认活动编辑器实际加载了匹配的 Bridge dist。
 * 这把“源码已构建、编辑器仍运行旧 dist”从模糊 Unknown tool 变成一次明确拒绝。
 */
function summarizeBridgeStatus(status, toolsResponse, expectedDistMtimeMs = null) {
    const toolNames = new Set(
        toolsResponse && Array.isArray(toolsResponse.tools)
            ? toolsResponse.tools.map(tool => tool && tool.name).filter(Boolean)
            : [],
    );
    const missingTools = requiredBridgeTools.filter(name => !toolNames.has(name));
    const loadedDistMtimeMs = status && Number.isFinite(status.loadedDistMtimeMs)
        ? Math.trunc(status.loadedDistMtimeMs)
        : null;
    const normalizedExpectedMtimeMs = Number.isFinite(expectedDistMtimeMs)
        ? Math.trunc(expectedDistMtimeMs)
        : null;
    const versionVerified = normalizedExpectedMtimeMs === null
        ? loadedDistMtimeMs !== null
        : loadedDistMtimeMs === normalizedExpectedMtimeMs;
    return {
        ...status,
        ready: missingTools.length === 0 && versionVerified,
        versionVerified,
        expectedDistMtimeMs: normalizedExpectedMtimeMs,
        toolCount: toolNames.size,
        requiredTools: requiredBridgeTools,
        missingTools,
    };
}

async function inspectBridge(port) {
    const [status, toolsResponse] = await Promise.all([
        requestJson(port, '/mcp-status'),
        requestJson(port, '/list-tools'),
    ]);
    const localDistPath = path.join(bridgeRoot, 'dist', 'main.js');
    const expectedDistMtimeMs = fs.existsSync(localDistPath)
        ? Math.trunc(fs.statSync(localDistPath).mtimeMs)
        : null;
    return summarizeBridgeStatus(status, toolsResponse, expectedDistMtimeMs);
}

async function main(argv = process.argv.slice(2)) {
    const command = argv[0];
    const { positional, options } = parseOptions(argv.slice(1));
    const emit = value => print(value, options.compact === true);
    if (!command || command === 'help' || options.help) {
        process.stdout.write('用法: node cli.js <scan|validate|dry-run|apply|status> [参数] [--project <Cocos项目根目录>] [--keep-open] [--compact]\n');
        return;
    }
    const projectRoot = resolveProjectRoot(options.project);
    if (command === 'scan') {
        const limit = Math.max(1, Math.min(Number(options.limit) || 80, 200));
        emit(scanAssets(projectRoot, positional, limit));
        return;
    }
    if (command === 'validate') {
        if (!positional[0]) throw new Error('validate 需要蓝图文件路径');
        const loaded = loadBlueprint(projectRoot, positional[0]);
        const result = validateBlueprint(loaded.blueprint);
        emit(result);
        if (!result.valid) process.exitCode = 1;
        return;
    }
    if (command === 'dry-run') {
        if (!positional[0]) throw new Error('dry-run 需要蓝图文件路径');
        const result = dryRun(projectRoot, positional[0]);
        emit(result);
        if (!result.valid || result.missingAssets.length > 0) process.exitCode = 1;
        return;
    }
    if (command === 'status') {
        const port = await discoverPort(options.port, projectRoot);
        emit(await inspectBridge(port));
        return;
    }
    if (command === 'apply') {
        if (!positional[0]) throw new Error('apply 需要蓝图文件路径');
        const preflight = dryRun(projectRoot, positional[0]);
        if (!preflight.valid || preflight.missingAssets.length > 0) {
            emit(preflight);
            process.exitCode = 1;
            return;
        }
        // 只有纯文件预检完全通过后才探测 Creator，确保模式冲突不会触达编辑器。
        const port = await discoverPort(options.port, projectRoot);
        const bridgeStatus = await inspectBridge(port);
        if (!bridgeStatus.ready) {
            emit({
                success: false,
                saved: false,
                diskUnchanged: true,
                failureStage: 'bridge-version-preflight',
                bridge: bridgeStatus,
                message: bridgeStatus.missingTools.length > 0
                    ? '活动 Creator 缺少 UI Blueprint 必需工具；请重建 Bridge 并重启 Creator 后重试。'
                    : '活动 Creator 仍加载旧 Bridge dist；请重启 Creator 后重试。',
            });
            process.exitCode = 1;
            return;
        }
        const loaded = loadBlueprint(projectRoot, positional[0]);
        const transaction = beginSafetyBackup(loaded.blueprint, projectRoot);
        let result;
        try {
            result = await callTool(port, 'apply_ui_blueprint', {
                blueprintPath: positional[0],
                save: options['no-save'] !== true,
                // 默认返回普通场景，让下一次事务能在写入前检查自动同步实例。
                // `--keep-open` 只用于明确需要继续人工检查 Prefab 的诊断场景。
                closeAfterSave: options['keep-open'] !== true,
            });
        } catch (error) {
            const externalRecovery = recoverFromExternalBackup(transaction);
            throw new Error(`${error.message}\n已执行项目外安全恢复: ${JSON.stringify(externalRecovery)}`);
        }
        if (!isApplyResultHealthy(result)) {
            if (result && result.rollback && result.rollback.restored === true) clearSafetyBackup(transaction);
            else {
                result = { ...result, externalRecovery: recoverFromExternalBackup(transaction) };
            }
            emit(result);
            process.exitCode = 1;
            return;
        }
        clearSafetyBackup(transaction);
        emit(result);
        return;
    }
    throw new Error(`未知命令: ${command}`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    defaultProjectRoot,
    beginSafetyBackup,
    clearSafetyBackup,
    discoverPort,
    inspectBridge,
    isApplyResultHealthy,
    main,
    parseOptions,
    recoverFromExternalBackup,
    requestJson,
    requiredBridgeTools,
    resolveProjectRoot,
    resolveTargetPrefabPath,
    summarizeBridgeStatus,
};
