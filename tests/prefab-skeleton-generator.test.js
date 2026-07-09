const assert = require("assert");
const { PrefabSkeletonGenerator } = require("../dist/utils/PrefabSkeletonGenerator");

function test(name, fn) {
	try {
		fn();
		console.log(`ok - ${name}`);
	} catch (error) {
		console.error(`not ok - ${name}`);
		throw error;
	}
}

test("creates prefab operations from a standardized UI skeleton blueprint", () => {
	const plan = PrefabSkeletonGenerator.createPlan({
		rootName: "NewShopView",
		root: { width: 720, height: 1280 },
		nodes: [
			{ path: "spr_bg", type: "sprite", width: 720, height: 1280 },
			{ path: "node_top", type: "node" },
			{ path: "node_top/lbl_title", type: "label", text: "商城" },
			{ path: "node_top/btn_close", type: "button" },
			{ path: "node_content", type: "node" },
			{ path: "node_content/list_reward", type: "list" },
			{ path: "node_content/list_reward/item_reward", type: "item" },
		],
	});

	assert.deepStrictEqual(plan.errors, []);
	assert.strictEqual(plan.valid, true);
	assert.strictEqual(plan.operations[0].action, "add_node");
	assert.strictEqual(plan.operations[0].nodeName, "NewShopView");

	const addTitle = plan.operations.find((op) => op.action === "add_node" && op.nodeName === "lbl_title");
	assert.deepStrictEqual(addTitle, {
		action: "add_node",
		targetPath: "node_top",
		nodeName: "lbl_title",
	});

	assert.ok(
		plan.operations.some(
			(op) =>
				op.action === "add_component" &&
				op.targetPath === "node_top/lbl_title" &&
				op.componentType === "cc.Label" &&
				op.properties.string === "商城",
		),
	);
	assert.ok(
		plan.operations.some(
			(op) =>
				op.action === "add_component" &&
				op.targetPath === "node_top/btn_close" &&
				op.componentType === "cc.Button",
		),
	);
	assert.ok(
		plan.operations.some(
			(op) =>
				op.action === "add_component" &&
				op.targetPath === "spr_bg" &&
				op.componentType === "cc.Sprite",
		),
	);
});

test("rejects blueprint nodes that do not use the required type prefix", () => {
	const plan = PrefabSkeletonGenerator.createPlan({
		rootName: "BadView",
		nodes: [{ path: "node_top/Title", type: "label" }],
	});

	assert.strictEqual(plan.valid, false);
	assert.ok(plan.errors.some((error) => error.includes("lbl_")));
});

test("infers node type from the standardized prefix when type is omitted", () => {
	const plan = PrefabSkeletonGenerator.createPlan({
		rootName: "RewardView",
		nodes: [
			{ path: "node_content", type: "node" },
			{ path: "node_content/lbl_count", text: "0/10" },
			{ path: "node_content/btn_claim" },
		],
	});

	assert.deepStrictEqual(plan.errors, []);
	assert.ok(
		plan.operations.some(
			(op) =>
				op.action === "add_component" &&
				op.targetPath === "node_content/lbl_count" &&
				op.componentType === "cc.Label" &&
				op.properties.string === "0/10",
		),
	);
	assert.ok(
		plan.operations.some(
			(op) =>
				op.action === "add_component" &&
				op.targetPath === "node_content/btn_claim" &&
				op.componentType === "cc.Button",
		),
	);
});
