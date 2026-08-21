'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
    beginSafetyBackup,
    clearSafetyBackup,
    defaultProjectRoot,
    isApplyResultHealthy,
    recoverFromExternalBackup,
    requestJson,
    resolveProjectRoot,
} = require('../cli');
const { dryRun, loadBlueprint, validateBlueprint } = require('../lib/blueprint');

const projectRoot = defaultProjectRoot;
const examplePath = 'packages/mcp-bridge/tools/cocos-ui-builder/examples/minimal.ui-blueprint.json';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function expectInvalid(blueprint, expectedMessage) {
    const result = validateBlueprint(blueprint);
    assert.strictEqual(result.valid, false, `蓝图应校验失败: ${expectedMessage}`);
    assert(result.errors.some(error => error.includes(expectedMessage)), result.errors.join('\n'));
}

function writeFixture(tempProject, name, blueprint) {
    const fixturePath = path.join(tempProject, name);
    fs.writeFileSync(fixturePath, JSON.stringify(blueprint, null, 2), 'utf8');
    return name;
}

async function expectDisconnectedRequest() {
    // 先让系统分配一个真实空闲端口，再关闭监听；相比硬编码端口，这个断连测试
    // 不会与开发机上已经运行的 Creator 或其他服务偶然冲突。
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    await assert.rejects(() => requestJson(port, '/mcp-status', undefined, 200), /ECONNREFUSED|socket hang up/);
}

async function run() {
    assert.strictEqual(resolveProjectRoot(projectRoot), projectRoot);
    assert.throws(() => resolveProjectRoot(true), /--project 需要/);

    const loaded = loadBlueprint(projectRoot, examplePath);
    const validation = validateBlueprint(loaded.blueprint);
    assert.strictEqual(validation.valid, true, validation.errors.join('\n'));
    assert.strictEqual(validation.summary.nodes, 4);
    assert.strictEqual(validation.summary.components, 1);

    const dryRunResult = dryRun(projectRoot, examplePath);
    assert.strictEqual(dryRunResult.valid, true);
    assert.strictEqual(dryRunResult.operation, 'create');
    assert.strictEqual(dryRunResult.mode, 'update-or-create');

    // Schema 是输入白名单：未知字段、越界值和非 assets 引用都必须在进入
    // Creator 之前失败，而不是由场景脚本“尽量处理”。
    const unknownField = clone(loaded.blueprint);
    unknownField.root.unexpected = true;
    expectInvalid(unknownField, '未声明字段');

    const invalidOpacity = clone(loaded.blueprint);
    invalidOpacity.root.transform.opacity = 256;
    expectInvalid(invalidOpacity, '不能大于 255');

    const externalAsset = clone(loaded.blueprint);
    externalAsset.root.children[0].children[0].asset = 'db://internal/default_sprite_splash.png';
    expectInvalid(externalAsset, '不匹配格式');

    const duplicateId = clone(loaded.blueprint);
    duplicateId.root.children[0].children[1].id = 'title';
    expectInvalid(duplicateId, '节点语义 ID 重复');

    const missingReference = clone(loaded.blueprint);
    missingReference.root.components = [{ type: 'ExampleView', properties: { closeButton: { $node: 'missing' } } }];
    expectInvalid(missingReference, '引用了不存在的节点语义 ID');

    const ambiguousReference = clone(loaded.blueprint);
    ambiguousReference.root.components = [{ type: 'ExampleView', properties: { invalid: { $node: 'title', $asset: 'db://assets/icon.png' } } }];
    expectInvalid(ambiguousReference, '必须且只能包含');

    const malformedComponentReference = clone(loaded.blueprint);
    malformedComponentReference.root.components = [{ type: 'ExampleView', properties: { invalid: { $component: { node: 'title', type: '' } } } }];
    expectInvalid(malformedComponentReference, '$component 必须且只能包含非空 node 和 type');

    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-ui-builder-test-'));
    try {
        fs.mkdirSync(path.join(tempProject, 'assets', 'ui_generated'), { recursive: true });

        const updateOnly = clone(loaded.blueprint);
        updateOnly.target.mode = 'update-only';
        const updateOnlyResult = dryRun(tempProject, writeFixture(tempProject, 'update-only.json', updateOnly));
        assert.strictEqual(updateOnlyResult.valid, false);
        assert(updateOnlyResult.errors.some(error => error.includes('update-only')));

        const createOnly = clone(loaded.blueprint);
        createOnly.target.mode = 'create-only';
        const existingTarget = path.join(tempProject, 'assets', 'ui_generated', 'UiBlueprintExample.prefab');
        fs.writeFileSync(existingTarget, 'before', 'utf8');
        const createOnlyResult = dryRun(tempProject, writeFixture(tempProject, 'create-only.json', createOnly));
        assert.strictEqual(createOnlyResult.valid, false);
        assert(createOnlyResult.errors.some(error => error.includes('create-only')));

        // 已有目标的外部恢复必须逐字节还原操作前内容。
        const existingTransaction = beginSafetyBackup(loaded.blueprint, tempProject);
        fs.writeFileSync(existingTarget, 'corrupted', 'utf8');
        const existingRecovery = recoverFromExternalBackup(existingTransaction);
        assert.strictEqual(existingRecovery.restored, true);
        assert.strictEqual(fs.readFileSync(existingTarget, 'utf8'), 'before');
        clearSafetyBackup(existingTransaction);

        // 新建失败时不能伪造或删除 meta；CLI 只把 Creator 已生成的可疑文件整体
        // 隔离到项目外，交由后续人工/AssetDB 判断。
        fs.rmSync(existingTarget);
        const newTransaction = beginSafetyBackup(loaded.blueprint, tempProject);
        fs.writeFileSync(existingTarget, 'invalid-new-prefab', 'utf8');
        fs.writeFileSync(`${existingTarget}.meta`, 'creator-generated-meta', 'utf8');
        const newRecovery = recoverFromExternalBackup(newTransaction);
        assert.strictEqual(newRecovery.restored, true);
        assert.strictEqual(newRecovery.action, 'quarantine-invalid-new-prefab');
        assert.strictEqual(fs.existsSync(existingTarget), false);
        assert.strictEqual(fs.existsSync(`${existingTarget}.meta`), false);
        assert.strictEqual(newRecovery.quarantined.length, 2);
        clearSafetyBackup(newTransaction);
    } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
    }

    const healthySavedResult = {
        success: true,
        saved: true,
        health: { creatorResponsive: true, prefabReopened: true, validation: { valid: true } },
    };
    assert.strictEqual(isApplyResultHealthy(healthySavedResult), true);
    for (const unhealthy of [
        { ...healthySavedResult, success: false },
        { ...healthySavedResult, health: { ...healthySavedResult.health, creatorResponsive: false } },
        { ...healthySavedResult, health: { ...healthySavedResult.health, prefabReopened: false } },
        { ...healthySavedResult, health: { ...healthySavedResult.health, validation: { valid: false } } },
        { success: true, saved: false, diskUnchanged: false },
    ]) {
        assert.strictEqual(isApplyResultHealthy(unhealthy), false, JSON.stringify(unhealthy));
    }
    assert.strictEqual(isApplyResultHealthy({ success: true, saved: false, diskUnchanged: true }), true);

    await expectDisconnectedRequest();
    process.stdout.write('cocos-ui-builder tests passed: schema, modes, recovery, disconnect, health contract.\n');
}

run().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
