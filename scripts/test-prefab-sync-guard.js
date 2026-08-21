'use strict';

const assert = require('assert');
const { findAutoSyncPrefabInstances } = require('../dist/utils/PrefabSyncGuard');

// 夹具同时覆盖压缩 UUID 归一化、嵌套遍历、手动同步实例和其它资源。纯函数
// 测试不启动 Creator，确保工具层拒绝逻辑不会依赖编辑器当前缓存状态。
const scene = {
    name: 'Scene',
    children: [
        {
            name: 'Canvas',
            uuid: 'canvas',
            children: [
                {
                    name: 'TargetAutoSync',
                    uuid: 'auto-target',
                    _prefab: { sync: true, asset: { _uuid: 'compressed-target' } },
                },
                {
                    name: 'TargetManualSync',
                    uuid: 'manual-target',
                    _prefab: { sync: false, asset: { _uuid: 'compressed-target' } },
                },
                {
                    name: 'OtherAutoSync',
                    uuid: 'auto-other',
                    _prefab: { sync: true, asset: { uuid: 'other-prefab' } },
                },
            ],
        },
    ],
};

const normalizeUuid = uuid => uuid === 'compressed-target' ? 'target-prefab' : uuid;
const matches = findAutoSyncPrefabInstances(scene, 'target-prefab', normalizeUuid);
assert.deepStrictEqual(matches, [{
    name: 'TargetAutoSync',
    uuid: 'auto-target',
    path: 'Scene/Canvas/TargetAutoSync',
}]);
assert.deepStrictEqual(findAutoSyncPrefabInstances(scene, 'missing', normalizeUuid), []);
assert.deepStrictEqual(findAutoSyncPrefabInstances(null, 'target-prefab', normalizeUuid), []);

process.stdout.write('Prefab sync guard tests passed: target matching, sync mode, UUID normalization.\n');
