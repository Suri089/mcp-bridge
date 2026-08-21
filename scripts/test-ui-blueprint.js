'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ui-blueprint-test-'));
const assetsRoot = path.join(tempProject, 'assets');

function dbUrlToPath(url) {
    if (typeof url !== 'string' || !url.startsWith('db://')) return '';
    return path.join(tempProject, url.slice('db://'.length).replace(/\//g, path.sep));
}

// UiBlueprint 是 Creator 主进程模块，单元测试只模拟它实际读取的最窄 Editor
// 接口；不模拟场景、Prefab 序列化或 AssetDB 写操作。
global.Editor = {
    Project: { path: tempProject },
    assetdb: {
        exists(url) {
            const filePath = dbUrlToPath(url);
            return !!filePath && fs.existsSync(filePath);
        },
        urlToFspath(url) {
            return dbUrlToPath(url);
        },
    },
};

const { UiBlueprint } = require('../dist/utils/UiBlueprint');

function writeBlueprint(name, mode) {
    const blueprint = {
        version: 1,
        target: { prefab: 'db://assets/ui/Test.prefab', mode },
        root: { id: 'Test', type: 'page', children: [{ id: 'title', type: 'label' }] },
    };
    const filePath = path.join(tempProject, name);
    fs.writeFileSync(filePath, JSON.stringify(blueprint), 'utf8');
    return name;
}

function expectInvalid(blueprint, expectedMessage) {
    const result = UiBlueprint.validate(blueprint);
    assert.strictEqual(result.valid, false, `蓝图应校验失败: ${expectedMessage}`);
    assert(result.errors.some(error => error.includes(expectedMessage)), result.errors.join('\n'));
}

try {
    fs.mkdirSync(path.join(assetsRoot, 'ui'), { recursive: true });
    fs.mkdirSync(path.join(assetsRoot, 'textures'), { recursive: true });
    fs.writeFileSync(path.join(assetsRoot, 'textures', 'button.png'), 'fixture', 'utf8');

    const updateOnly = UiBlueprint.dryRun(writeBlueprint('update-only.json', 'update-only'));
    assert.strictEqual(updateOnly.valid, false);
    assert(updateOnly.errors.some(error => error.includes('update-only')));

    fs.writeFileSync(path.join(assetsRoot, 'ui', 'Test.prefab'), 'fixture', 'utf8');
    const createOnly = UiBlueprint.dryRun(writeBlueprint('create-only.json', 'create-only'));
    assert.strictEqual(createOnly.valid, false);
    assert(createOnly.errors.some(error => error.includes('create-only')));

    const strictBlueprint = {
        version: 1,
        target: { prefab: 'db://assets/ui/Strict.prefab' },
        root: { id: 'Strict', type: 'page', transform: { opacity: 256 } },
    };
    expectInvalid(strictBlueprint, 'opacity 必须在 0 到 255');
    strictBlueprint.root.transform = {};
    strictBlueprint.root.unexpected = true;
    expectInvalid(strictBlueprint, '未声明字段');
    delete strictBlueprint.root.unexpected;
    strictBlueprint.root.components = [{ type: 'StrictView', properties: { icon: { $asset: 'db://internal/icon' } } }];
    expectInvalid(strictBlueprint, 'db://assets/');

    const scan = UiBlueprint.scanAssets({ keywords: ['button'], limit: 10 });
    assert(scan.assets.some(item => item.url === 'db://assets/textures/button.png'), JSON.stringify(scan));
    assert(scan.assets.every(item => path.extname(item.url)), '扫描结果必须是文件 URL，不能是目录 URL');

    process.stdout.write('UI Blueprint unit tests passed: target modes and asset scan URLs.\n');
} finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
}
