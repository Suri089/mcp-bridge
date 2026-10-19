'use strict';

const assert = require('assert');
const {
    compareRepeatedComponents,
    getUniqueComponent,
    selectComponentForMutation,
    snapshotRepeatedComponents,
} = require('../dist/utils/ComponentIdentityGuard');

class Component {}
class Group extends Component {
    constructor(uuid, type) {
        super();
        this.uuid = uuid;
        this.type = type;
    }
}
class Other extends Component {}
const node = {
    name: 'Root',
    uuid: 'root',
    children: [],
    _components: [new Group('first', 101), new Group('last', 305)],
    getComponents(type) { return this._components.filter(component => component instanceof type); },
    removeComponent(component) { this._components.splice(this._components.indexOf(component), 1); },
};

assert.throws(() => getUniqueComponent(node, Group, 'NodeOrderGroup'), /componentId/);
assert.throws(() => selectComponentForMutation(node, 'stale-id', Group, 'NodeOrderGroup'), /拒绝回退/);
assert.throws(() => selectComponentForMutation(node, 'first', Other, 'Other'), /不匹配/);
assert.strictEqual(selectComponentForMutation(node, 'last', Group, 'NodeOrderGroup'), node._components[1]);
assert.strictEqual(getUniqueComponent(node, Other, 'Other'), null);

function fixture() {
    const data = [
        { __type__: 'cc.Prefab', data: { __id__: 1 } },
        { __type__: 'cc.Node', _name: 'Root', _components: [], _children: [] },
    ];
    function append(component) {
        data.push(component);
        return { __id__: data.length - 1 };
    }
    for (const type of [101, 102, 103, 104, 105, 106, 201, 202, 203, 204, 205, 206, 301, 302, 303, 304, 305]) {
        data[1]._components.push(append({ __type__: 'TestGroup', type, open: true, valid: true, _enabled: true }));
    }
    const child = { __type__: 'cc.Node', _name: 'filterContent', _components: [], _children: [] };
    data[1]._children.push(append(child));
    child._prefab = append({ __type__: 'cc.PrefabInfo', fileId: 'filter-content' });
    child._components.push(append({ __type__: 'TestGroup', type: 101, open: true, valid: true }));
    child._components.push(append({ __type__: 'TestGroup', type: 105, open: true, valid: true }));
    return data;
}

const baseline = snapshotRepeatedComponents(fixture());
assert.strictEqual(baseline.length, 2);
function expectCorruption(change) {
    const data = fixture();
    change(data);
    const result = compareRepeatedComponents(baseline, snapshotRepeatedComponents(data));
    assert.strictEqual(result.valid, false);
    assert(result.errors.length > 0);
}
expectCorruption(data => { data[2].type = 305; });
expectCorruption(data => { data[2].open = false; });
expectCorruption(data => { data[2].valid = false; });
expectCorruption(data => { data[2]._enabled = false; });
expectCorruption(data => { data[1]._components.reverse(); });
expectCorruption(data => { data[1]._components.pop(); });
expectCorruption(data => { data[data.length - 2].type = 105; });
const unchanged = fixture();
unchanged[1]._name = 'RenamedRoot';
unchanged[2]._id = 'recreated-component-id';
unchanged[2]._objFlags = 123;
unchanged[unchanged[1]._children[0].__id__]._name = 'RenamedChild';
assert.strictEqual(compareRepeatedComponents(baseline, snapshotRepeatedComponents(JSON.stringify(unchanged))).valid, true);
assert.throws(() => snapshotRepeatedComponents('{}'), /序列化数组/);
assert.throws(() => snapshotRepeatedComponents([{ __type__: 'cc.Prefab', data: { __id__: 99 } }]), /根节点/);

let dirtyNotifications = 0;
global.Editor = {
    Ipc: { sendToMain() { dirtyNotifications++; }, sendToAll() {} },
    warn() {},
    require() { return { curMode: () => ({ name: 'prefab' }) }; },
};
global.cc = {
    Component,
    Class: { Attr: { getClassAttrs: () => ({}) } },
    js: {
        getClassByName: type => type === 'NodeOrderGroup' ? Group : null,
        isChildClassOf: (type, base) => type.prototype instanceof base,
    },
    engine: { getInstanceById: id => id === node.uuid ? node : null },
    director: { getScene: () => ({ children: [node] }) },
};
const sceneHandlers = require('../dist/scene-script');
function mutate(args) {
    let reply;
    sceneHandlers['manage-components']({ reply(error, value) { reply = { error, value }; } }, { nodeId: node.uuid, ...args });
    return reply;
}

async function run() {
    assert(mutate({ action: 'update', componentType: 'NodeOrderGroup', properties: { type: 999 } }).error);
    assert(mutate({ action: 'update', componentType: 'NodeOrderGroup', componentId: 'stale-id', properties: { type: 999 } }).error);
    assert(mutate({ action: 'remove', componentType: 'NodeOrderGroup' }).error);
    assert.deepStrictEqual(node._components.map(component => component.type), [101, 305]);
    assert.strictEqual(dirtyNotifications, 0);

    const blueprintResult = await new Promise(resolve => sceneHandlers['apply-ui-blueprint']({ reply(error, value) { resolve({ error, value }); } }, {
        blueprint: { root: { id: 'Root', components: [{ type: 'NodeOrderGroup', properties: { type: 999 } }] } },
        createRoot: false,
    }));
    assert(blueprintResult.error, '已有重复组件时，蓝图必须拒绝按类型写入');
    assert.deepStrictEqual(node._components.map(component => component.type), [101, 305]);

    assert.ifError(mutate({ action: 'update', componentType: 'NodeOrderGroup', componentId: 'last', properties: { type: 306 } }).error);
    assert.deepStrictEqual(node._components.map(component => component.type), [101, 306]);
    assert.ifError(mutate({ action: 'remove', componentId: 'last' }).error);
    assert.strictEqual(getUniqueComponent(node, Group, 'NodeOrderGroup').type, 101);

    let serializedState = fixture();
    Editor.serialize = (root, options) => {
        assert.strictEqual(options.reserveContentsForSyncablePrefab, true, '自动同步节点必须保留完整内容才能检查重复组件');
        return JSON.stringify(serializedState);
    };
    function validateScene() {
        let reply;
        sceneHandlers['validate-ui-blueprint']({ reply(error, value) { reply = { error, value }; } }, {
            blueprint: { root: { id: 'Root' } }, rootId: node.uuid, repeatedComponents: baseline,
        });
        assert.ifError(reply.error);
        return reply.value;
    }
    assert.strictEqual(validateScene().componentIntegrity.valid, true);
    serializedState[2].type = 305;
    assert.strictEqual(validateScene().valid, false, '蓝图未声明的重复组件被覆盖也必须失败');

    const { ToolDispatcher } = require('../dist/tools/ToolDispatcher');
    const originalRefresh = Editor.assetdb;
    let refreshCalls = 0;
    Editor.assetdb = { exists: () => true, refresh(path, done) { refreshCalls++; done(null); } };
    function refresh(properties) {
        let reply;
        ToolDispatcher.manageEditor({ action: 'refresh_editor', properties }, (error, value) => { reply = { error, value }; });
        return reply;
    }
    assert.strictEqual(refresh({ path: 'db://assets/scripts/Existing.ts' }).value.skipped, true);
    assert.strictEqual(refreshCalls, 0);
    assert.ifError(refresh({ path: 'db://assets/scripts/Existing.ts', forceScriptRefresh: true }).error);
    assert.strictEqual(refreshCalls, 1);
    Editor.assetdb.exists = () => false;
    assert.ifError(refresh({ path: 'db://assets/scripts/New.ts' }).error);
    assert.strictEqual(refreshCalls, 2);
    Editor.assetdb = originalRefresh;

    await testTransactions(ToolDispatcher);
    process.stdout.write('Component identity guard tests passed: ambiguous writes rejected, exact IDs preserved, repeated values/order checked, redundant script refresh skipped.\n');
}

/** 使用临时 JSON 和窄接口替身验证真实事务控制流，不保存用户资源。 */
async function testTransactions(ToolDispatcher) {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { UiBlueprint } = require('../dist/utils/UiBlueprint');
    const { CommandQueue } = require('../dist/core/CommandQueue');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-integrity-test-'));
    const filePath = path.join(tempDir, 'serialized-fixture.json');
    const originalSource = JSON.stringify(fixture());
    const previous = { load: UiBlueprint.load, dryRun: UiBlueprint.dryRun, call: CommandQueue.callSceneScriptWithTimeout, timer: global.setTimeout, assetdb: Editor.assetdb };
    try {
        UiBlueprint.load = () => ({ blueprint: { target: { prefab: 'db://assets/ui/Test.prefab' }, root: { id: 'Root' } } });
        UiBlueprint.dryRun = () => ({ valid: true, missingAssets: [] });
        global.setTimeout = callback => { queueMicrotask(callback); return 0; };
        for (const phase of ['healthy', 'before-save', 'after-save']) {
            fs.writeFileSync(filePath, originalSource, 'utf8');
            let runtimeSource = fixture();
            let saves = 0;
            let restores = 0;
            Editor.assetdb = {
                exists: () => true,
                urlToUuid: () => 'test-prefab',
                urlToFspath: () => filePath,
                saveExists(url, source, done) { restores++; fs.writeFileSync(filePath, source, 'utf8'); done(null); },
                refresh(url, done) { done(null); },
            };
            CommandQueue.callSceneScriptWithTimeout = (pkg, method, args, done) => {
                if (method === 'inspect-auto-sync-prefab-instances') return done(null, { safe: true });
                if (method === 'probe-prefab-health') return done(null, { healthy: true });
                if (method === 'close-prefab') return done(null, {});
                if (method === 'apply-ui-blueprint') {
                    if (phase === 'before-save') runtimeSource[2].type = 305;
                    return done(null, { rootUuid: 'root' });
                }
                if (method === 'validate-ui-blueprint') {
                    const componentIntegrity = compareRepeatedComponents(args.repeatedComponents, snapshotRepeatedComponents(runtimeSource));
                    return done(null, { valid: componentIntegrity.valid, componentIntegrity });
                }
                if (method === 'save-prefab') {
                    saves++;
                    const serialized = fixture();
                    if (phase === 'after-save') serialized[2].type = 305;
                    fs.writeFileSync(filePath, JSON.stringify(serialized), 'utf8');
                    return done(null, {});
                }
                throw new Error(`Unexpected scene call: ${method}`);
            };
            const result = await new Promise((resolve, reject) => ToolDispatcher.applyUiBlueprint({ blueprintPath: 'test.json' }, (error, value) => error ? reject(error) : resolve(value)));
            assert.strictEqual(result.success, phase === 'healthy', phase);
            assert.strictEqual(saves, phase === 'before-save' ? 0 : 1, phase);
            assert.strictEqual(restores, phase === 'after-save' ? 1 : 0, phase);
            if (phase === 'after-save') assert.strictEqual(result.rollback.restored, true);
            assert.strictEqual(fs.readFileSync(filePath, 'utf8'), originalSource, '失败后必须保留或恢复原始值');
        }
    } finally {
        UiBlueprint.load = previous.load;
        UiBlueprint.dryRun = previous.dryRun;
        CommandQueue.callSceneScriptWithTimeout = previous.call;
        global.setTimeout = previous.timer;
        Editor.assetdb = previous.assetdb;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
});
