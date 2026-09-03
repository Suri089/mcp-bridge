'use strict';

const assert = require('assert');
const {
    exitPrefabModeToScene,
    waitForStableEditMode,
} = require('../dist/utils/EditModeTransition');

async function testAsyncExit() {
    const sceneMode = { name: 'scene' };
    const prefabMode = { name: 'prefab' };
    let current = prefabMode;
    let popCount = 0;
    const editMode = {
        curMode: () => current,
        pop: () => {
            popCount++;
            setTimeout(() => {
                current = sceneMode;
            }, 10);
        },
    };
    const result = await exitPrefabModeToScene(editMode, {
        pollIntervalMs: 2,
        perPopTimeoutMs: 100,
        totalTimeoutMs: 300,
    });
    assert.strictEqual(result.mode, 'scene');
    assert.strictEqual(result.popCount, 1);
    assert.strictEqual(popCount, 1);
}

async function testNestedPrefabExit() {
    const modes = [{ name: 'scene' }, { name: 'prefab' }, { name: 'prefab' }];
    let index = 2;
    const editMode = {
        curMode: () => modes[index],
        pop: () => {
            setTimeout(() => {
                index--;
            }, 5);
        },
    };
    const result = await exitPrefabModeToScene(editMode, {
        pollIntervalMs: 2,
        perPopTimeoutMs: 100,
        totalTimeoutMs: 500,
    });
    assert.strictEqual(result.mode, 'scene');
    assert.strictEqual(result.popCount, 2);
}

async function testBlockedDialogFailsWithoutRepeatedPop() {
    const prefabMode = { name: 'prefab' };
    let popCount = 0;
    const editMode = {
        curMode: () => prefabMode,
        pop: () => {
            popCount++;
        },
    };
    await assert.rejects(
        () => exitPrefabModeToScene(editMode, {
            pollIntervalMs: 2,
            perPopTimeoutMs: 20,
            totalTimeoutMs: 50,
        }),
        /应用\/回退/,
    );
    assert.strictEqual(popCount, 1);
}

async function testStableSaveWait() {
    const firstPrefabMode = { name: 'prefab' };
    const stablePrefabMode = { name: 'prefab' };
    let current = firstPrefabMode;
    setTimeout(() => {
        current = stablePrefabMode;
    }, 5);
    const result = await waitForStableEditMode({ curMode: () => current, pop: () => {} }, 'prefab', {
        pollIntervalMs: 2,
        stableMs: 10,
        timeoutMs: 100,
    });
    assert.strictEqual(result.mode, 'prefab');
    assert(result.waitedMs >= 10);
}

Promise.resolve()
    .then(testAsyncExit)
    .then(testNestedPrefabExit)
    .then(testBlockedDialogFailsWithoutRepeatedPop)
    .then(testStableSaveWait)
    .then(() => {
        process.stdout.write('Edit mode transition tests passed: async exit, nested stack, blocked dialog, stable save.\n');
    })
    .catch((error) => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
    });
