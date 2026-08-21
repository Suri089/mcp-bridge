'use strict';

const fs = require('fs');
const path = require('path');
const { validateJsonSchema } = require('./json-schema');

const schemaPath = path.resolve(__dirname, '..', 'schema', 'ui-blueprint.schema.json');
const blueprintSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const maxBlueprintBytes = 2 * 1024 * 1024;

function loadBlueprint(projectRoot, inputPath) {
    const filePath = path.resolve(projectRoot, inputPath);
    const relative = path.relative(projectRoot, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`蓝图必须位于项目内: ${inputPath}`);
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`蓝图文件不存在: ${inputPath}`);
    }
    if (fs.statSync(filePath).size > maxBlueprintBytes) {
        throw new Error(`蓝图超过 ${maxBlueprintBytes} 字节限制`);
    }
    return { filePath, blueprint: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
}

function validateBlueprint(blueprint) {
    // 先用版本化 Schema 拒绝未知字段、错误类型和越界值；语义遍历只负责
    // JSON Schema 无法表达的跨节点引用、统计摘要与资源收集。
    const errors = validateJsonSchema(blueprint, blueprintSchema);
    const warnings = [];
    const seenIds = new Set();
    const references = new Set();
    const assets = new Set();
    let nodes = 0;
    let components = 0;
    let events = 0;

    function collectValue(value) {
        if (Array.isArray(value)) return value.forEach(collectValue);
        if (!value || typeof value !== 'object') return;
        const referenceKeys = ['$asset', '$node', '$component'].filter(key => Object.prototype.hasOwnProperty.call(value, key));
        if (referenceKeys.length > 0) {
            if (referenceKeys.length !== 1 || Object.keys(value).length !== 1) errors.push('蓝图引用对象必须且只能包含 $asset、$node、$component 之一');
            if (referenceKeys[0] === '$asset') {
                if (typeof value.$asset !== 'string' || !value.$asset.startsWith('db://assets/')) errors.push('$asset 必须是 db://assets/ 资源路径');
                else assets.add(value.$asset);
            }
            if (referenceKeys[0] === '$node') {
                if (typeof value.$node !== 'string' || !value.$node.trim()) errors.push('$node 必须是非空语义 ID');
                else references.add(value.$node);
            }
            if (referenceKeys[0] === '$component') {
                const componentReference = value.$component;
                const keys = componentReference && typeof componentReference === 'object' && !Array.isArray(componentReference)
                    ? Object.keys(componentReference)
                    : [];
                if (!componentReference || keys.length !== 2 || !keys.includes('node') || !keys.includes('type') ||
                    typeof componentReference.node !== 'string' || !componentReference.node.trim() ||
                    typeof componentReference.type !== 'string' || !componentReference.type.trim()) {
                    errors.push('$component 必须且只能包含非空 node 和 type');
                } else {
                    references.add(componentReference.node);
                }
            }
        }
        Object.keys(value).forEach(key => collectValue(value[key]));
    }

    function visit(node, nodePath) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            errors.push(`${nodePath} 必须是对象`);
            return;
        }
        nodes++;
        if (typeof node.id === 'string' && node.id.trim()) {
            if (seenIds.has(node.id)) errors.push(`节点语义 ID 重复: ${node.id}`);
            else seenIds.add(node.id);
        }
        if (typeof node.asset === 'string') assets.add(node.asset);
        if (node.components !== undefined && !Array.isArray(node.components)) errors.push(`${nodePath}.components 必须是数组`);
        for (const component of Array.isArray(node.components) ? node.components : []) {
            components++;
            if (!component || typeof component.type !== 'string') errors.push(`${nodePath} 存在无效组件`);
            collectValue(component && component.properties);
        }
        if (node.events !== undefined && !Array.isArray(node.events)) errors.push(`${nodePath}.events 必须是数组`);
        for (const event of Array.isArray(node.events) ? node.events : []) {
            events++;
            if (!event || typeof event.component !== 'string' || typeof event.handler !== 'string') errors.push(`${nodePath} 存在无效事件`);
            if (event && typeof event.target === 'string') references.add(event.target);
        }
        if (node.children !== undefined && !Array.isArray(node.children)) errors.push(`${nodePath}.children 必须是数组`);
        (Array.isArray(node.children) ? node.children : []).forEach((child, index) => visit(child, `${nodePath}.children[${index}]`));
    }

    if (blueprint && blueprint.root) visit(blueprint.root, 'root');
    references.forEach(id => {
        if (!seenIds.has(id)) errors.push(`引用了不存在的节点语义 ID: ${id}`);
    });
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        summary: {
            target: blueprint && blueprint.target ? blueprint.target.prefab || '' : '',
            nodes,
            components,
            events,
            assetReferences: assets.size,
        },
        assetUrls: Array.from(assets),
    };
}

function dbUrlToCandidate(projectRoot, url) {
    if (!url.startsWith('db://assets/')) return null;
    const relative = url.slice('db://'.length);
    const direct = path.join(projectRoot, relative.replace(/\//g, path.sep));
    if (fs.existsSync(direct)) return direct;
    const assetMatch = relative.match(/^(.*\.(?:png|jpg|jpeg|plist|atlas|ttf|fnt|prefab|fire))(?:\/.*)?$/i);
    return assetMatch ? path.join(projectRoot, assetMatch[1].replace(/\//g, path.sep)) : direct;
}

function dryRun(projectRoot, inputPath) {
    const loaded = loadBlueprint(projectRoot, inputPath);
    const validation = validateBlueprint(loaded.blueprint);
    const targetCandidate = validation.summary.target ? dbUrlToCandidate(projectRoot, validation.summary.target) : null;
    const missingAssets = validation.assetUrls.filter(url => {
        const candidate = dbUrlToCandidate(projectRoot, url);
        return !candidate || !fs.existsSync(candidate);
    });
    const mode = loaded.blueprint && loaded.blueprint.target ? loaded.blueprint.target.mode || 'update-or-create' : 'update-or-create';
    const targetExists = !!targetCandidate && fs.existsSync(targetCandidate);
    const errors = validation.errors.slice();
    // 目标模式是事务安全边界，必须在连接 Creator 前就完成判断。
    if (validation.valid && mode === 'update-only' && !targetExists) errors.push('target.mode 为 update-only，但目标 Prefab 不存在');
    if (validation.valid && mode === 'create-only' && targetExists) errors.push('target.mode 为 create-only，但目标 Prefab 已存在');
    return {
        blueprintPath: path.relative(projectRoot, loaded.filePath).replace(/\\/g, '/'),
        valid: errors.length === 0,
        errors,
        warnings: validation.warnings,
        summary: validation.summary,
        targetExists,
        operation: targetExists ? 'update' : 'create',
        mode,
        missingAssets,
    };
}

function scanAssets(projectRoot, keywords, limit) {
    const assetsRoot = path.join(projectRoot, 'assets');
    const normalizedKeywords = keywords.map(value => value.toLowerCase());
    const allowed = new Set(['.prefab', '.fire', '.png', '.jpg', '.jpeg', '.plist', '.atlas', '.ttf', '.fnt', '.ts']);
    const results = [];
    function visit(currentPath) {
        if (!fs.existsSync(currentPath) || results.length >= limit * 4) return;
        for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const entryPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath);
                continue;
            }
            const extension = path.extname(entry.name).toLowerCase();
            if (!allowed.has(extension)) continue;
            const relative = path.relative(projectRoot, entryPath).replace(/\\/g, '/');
            const normalized = relative.toLowerCase();
            let score = normalizedKeywords.length === 0 ? 1 : 0;
            for (const keyword of normalizedKeywords) {
                if (entry.name.toLowerCase().includes(keyword)) score += 5;
                else if (normalized.includes(keyword)) score += 2;
            }
            if (score > 0) results.push({ url: `db://${relative}`, type: extension.slice(1), score });
        }
    }
    visit(assetsRoot);
    results.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    return { keywords: normalizedKeywords, count: Math.min(results.length, limit), truncated: results.length > limit, assets: results.slice(0, limit) };
}

module.exports = { dryRun, loadBlueprint, scanAssets, validateBlueprint };
