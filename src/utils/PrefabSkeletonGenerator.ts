import { PrefabOperation } from "./OfflinePrefabEditor";

export type PrefabSkeletonNodeType =
	| "node"
	| "sprite"
	| "label"
	| "button"
	| "list"
	| "item"
	| "scroll"
	| "toggle"
	| "layout"
	| "mask"
	| "animation"
	| "spine"
	| "bar";

export interface PrefabSkeletonNodeBlueprint {
	path: string;
	type?: PrefabSkeletonNodeType;
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	anchorX?: number;
	anchorY?: number;
	opacity?: number;
	active?: boolean;
	text?: string;
}

export interface PrefabSkeletonBlueprint {
	rootName: string;
	root?: {
		width?: number;
		height?: number;
		x?: number;
		y?: number;
		anchorX?: number;
		anchorY?: number;
	};
	nodes: PrefabSkeletonNodeBlueprint[];
}

export interface PrefabSkeletonPlan {
	valid: boolean;
	rootName: string;
	operations: PrefabOperation[];
	errors: string[];
	warnings: string[];
}

interface NormalizedNode {
	path: string;
	name: string;
	parentPath: string;
	type: PrefabSkeletonNodeType;
	source: PrefabSkeletonNodeBlueprint;
	order: number;
}

const TYPE_PREFIX: Record<PrefabSkeletonNodeType, string> = {
	node: "node_",
	sprite: "spr_",
	label: "lbl_",
	button: "btn_",
	list: "list_",
	item: "item_",
	scroll: "scroll_",
	toggle: "toggle_",
	layout: "layout_",
	mask: "mask_",
	animation: "anim_",
	spine: "spine_",
	bar: "bar_",
};

const PREFIX_TYPE: Array<[string, PrefabSkeletonNodeType]> = Object.entries(TYPE_PREFIX).map(
	([type, prefix]) => [prefix, type as PrefabSkeletonNodeType],
);

const TYPE_ALIASES: Record<string, PrefabSkeletonNodeType> = {
	empty: "node",
	container: "node",
	node: "node",
	spr: "sprite",
	sprite: "sprite",
	image: "sprite",
	img: "sprite",
	lbl: "label",
	label: "label",
	text: "label",
	btn: "button",
	button: "button",
	list: "list",
	item: "item",
	scroll: "scroll",
	scrollview: "scroll",
	toggle: "toggle",
	layout: "layout",
	mask: "mask",
	anim: "animation",
	animation: "animation",
	spine: "spine",
	progress: "bar",
	progressbar: "bar",
	bar: "bar",
};

export class PrefabSkeletonGenerator {
	public static createPlan(blueprint: PrefabSkeletonBlueprint): PrefabSkeletonPlan {
		const errors: string[] = [];
		const warnings: string[] = [];
		const rootName = this.normalizeRootName(blueprint && blueprint.rootName);
		const nodes = this.normalizeNodes(blueprint, rootName, errors, warnings);

		if (!rootName) {
			errors.push("rootName 不能为空。");
		}
		if (!blueprint || !Array.isArray(blueprint.nodes)) {
			errors.push("nodes 必须是节点蓝图数组。");
		}

		if (errors.length > 0) {
			return { valid: false, rootName, operations: [], errors, warnings };
		}

		const operations: PrefabOperation[] = [
			{
				action: "add_node",
				targetPath: "",
				nodeName: rootName,
			},
		];

		const rootProperties = this.buildNodeProperties(blueprint.root || {});
		if (Object.keys(rootProperties).length > 0) {
			operations.push({
				action: "update_property",
				targetPath: "",
				properties: rootProperties,
			});
		}

		const sortedNodes = nodes.sort((a, b) => {
			const depthDiff = this.depth(a.path) - this.depth(b.path);
			return depthDiff !== 0 ? depthDiff : a.order - b.order;
		});

		for (const node of sortedNodes) {
			operations.push({
				action: "add_node",
				targetPath: node.parentPath,
				nodeName: node.name,
			});

			const nodeProperties = this.buildNodeProperties(node.source);
			if (Object.keys(nodeProperties).length > 0) {
				operations.push({
					action: "update_property",
					targetPath: node.path,
					properties: nodeProperties,
				});
			}

			for (const component of this.buildComponentOperations(node)) {
				operations.push(component);
			}

			if (node.type === "list") {
				warnings.push(`${node.path} 已按列表容器创建；自定义 List 脚本绑定建议在后续业务脚本阶段处理。`);
			}
		}

		return { valid: true, rootName, operations, errors, warnings };
	}

	private static normalizeRootName(rootName: string | undefined): string {
		return (rootName || "").trim();
	}

	private static normalizeNodes(
		blueprint: PrefabSkeletonBlueprint,
		rootName: string,
		errors: string[],
		warnings: string[],
	): NormalizedNode[] {
		if (!blueprint || !Array.isArray(blueprint.nodes)) {
			return [];
		}

		const nodes: NormalizedNode[] = [];
		const pathSet = new Set<string>();

		blueprint.nodes.forEach((source, order) => {
			const rawPath = (source && source.path ? source.path : "").replace(/\\/g, "/").trim();
			const path = this.stripRootPrefix(rawPath, rootName);
			if (!path) {
				errors.push(`nodes[${order}].path 不能为空，且不能指向根节点本身。`);
				return;
			}

			if (path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
				errors.push(`节点路径 "${rawPath}" 不合法：不要使用开头/结尾斜杠或连续斜杠。`);
				return;
			}

			if (pathSet.has(path)) {
				errors.push(`节点路径重复: ${path}`);
				return;
			}
			pathSet.add(path);

			const segments = path.split("/");
			const name = segments[segments.length - 1];
			const parentPath = segments.slice(0, -1).join("/");
			const inferredType = this.inferTypeFromName(name);
			const explicitType = source.type ? this.normalizeType(source.type) : undefined;
			const type = explicitType || inferredType;

			for (const segment of segments) {
				if (!this.isStandardSegment(segment)) {
					errors.push(`节点名 "${segment}" 不符合规范：请使用小写 snake_case，且以 ${this.allowedPrefixesText()} 开头。`);
				}
			}

			if (!type) {
				errors.push(`节点 "${path}" 无法从命名推断类型，请使用 ${this.allowedPrefixesText()} 前缀或显式 type。`);
				return;
			}

			const expectedPrefix = TYPE_PREFIX[type];
			if (!name.startsWith(expectedPrefix)) {
				errors.push(`节点 "${path}" 的 type=${type}，命名应以 "${expectedPrefix}" 开头。`);
			}

			if (explicitType && inferredType && explicitType !== inferredType) {
				errors.push(`节点 "${path}" 的 type=${explicitType} 与命名前缀推断类型 ${inferredType} 不一致。`);
			}

			nodes.push({ path, name, parentPath, type, source, order });
		});

		const declaredPaths = new Set(nodes.map((node) => node.path));
		for (const node of nodes) {
			if (node.parentPath && !declaredPaths.has(node.parentPath)) {
				errors.push(`节点 "${node.path}" 的父节点 "${node.parentPath}" 未在蓝图中声明。`);
			}
		}

		return nodes;
	}

	private static stripRootPrefix(path: string, rootName: string): string {
		if (!rootName) {
			return path;
		}
		if (path === rootName) {
			return "";
		}
		const prefix = `${rootName}/`;
		return path.startsWith(prefix) ? path.substring(prefix.length) : path;
	}

	private static normalizeType(type: string): PrefabSkeletonNodeType | undefined {
		return TYPE_ALIASES[String(type).toLowerCase()];
	}

	private static inferTypeFromName(name: string): PrefabSkeletonNodeType | undefined {
		const match = PREFIX_TYPE.find(([prefix]) => name.startsWith(prefix));
		return match ? match[1] : undefined;
	}

	private static isStandardSegment(name: string): boolean {
		if (!/^[a-z][a-z0-9_]*$/.test(name)) {
			return false;
		}
		return PREFIX_TYPE.some(([prefix]) => name.startsWith(prefix));
	}

	private static allowedPrefixesText(): string {
		return Object.values(TYPE_PREFIX).join(" / ");
	}

	private static depth(path: string): number {
		return path.split("/").length;
	}

	private static buildNodeProperties(source: Partial<PrefabSkeletonNodeBlueprint>): Record<string, any> {
		const properties: Record<string, any> = {};

		if (typeof source.width === "number" || typeof source.height === "number") {
			properties._contentSize = {
				__type__: "cc.Size",
				width: typeof source.width === "number" ? source.width : 100,
				height: typeof source.height === "number" ? source.height : 100,
			};
		}

		if (typeof source.anchorX === "number" || typeof source.anchorY === "number") {
			properties._anchorPoint = {
				__type__: "cc.Vec2",
				x: typeof source.anchorX === "number" ? source.anchorX : 0.5,
				y: typeof source.anchorY === "number" ? source.anchorY : 0.5,
			};
		}

		if (typeof source.x === "number" || typeof source.y === "number") {
			properties._trs = {
				__type__: "TypedArray",
				ctor: "Float64Array",
				array: [
					typeof source.x === "number" ? source.x : 0,
					typeof source.y === "number" ? source.y : 0,
					0,
					0,
					0,
					0,
					1,
					1,
					1,
					1,
				],
			};
		}

		if (typeof source.opacity === "number") {
			properties._opacity = source.opacity;
		}
		if (typeof source.active === "boolean") {
			properties._active = source.active;
		}

		return properties;
	}

	private static buildComponentOperations(node: NormalizedNode): PrefabOperation[] {
		const operations: PrefabOperation[] = [];
		if (node.type === "sprite") {
			operations.push(this.addComponent(node.path, "cc.Sprite", {}));
		} else if (node.type === "label") {
			operations.push(this.addComponent(node.path, "cc.Label", { string: node.source.text || "Label" }));
		} else if (node.type === "button") {
			operations.push(this.addComponent(node.path, "cc.Sprite", {}));
			operations.push(this.addComponent(node.path, "cc.Button", this.buttonDefaults()));
		} else if (node.type === "scroll") {
			operations.push(this.addComponent(node.path, "cc.ScrollView", {}));
		} else if (node.type === "toggle") {
			operations.push(this.addComponent(node.path, "cc.Toggle", {}));
		} else if (node.type === "layout") {
			operations.push(this.addComponent(node.path, "cc.Layout", {}));
		} else if (node.type === "mask") {
			operations.push(this.addComponent(node.path, "cc.Mask", {}));
		} else if (node.type === "animation") {
			operations.push(this.addComponent(node.path, "cc.Animation", {}));
		} else if (node.type === "spine") {
			operations.push(this.addComponent(node.path, "sp.Skeleton", {}));
		} else if (node.type === "bar") {
			operations.push(this.addComponent(node.path, "cc.ProgressBar", {}));
		}
		return operations;
	}

	private static addComponent(targetPath: string, componentType: string, properties: Record<string, any>): PrefabOperation {
		return {
			action: "add_component",
			targetPath,
			componentType,
			properties,
		};
	}

	private static buttonDefaults(): Record<string, any> {
		return {
			_normalMaterial: null,
			_grayMaterial: null,
			duration: 0.1,
			zoomScale: 0.9,
			clickEvents: [],
			_N$interactable: true,
			_N$enableAutoGrayEffect: false,
			_N$transition: 3,
			transition: 3,
			_N$normalColor: this.color(255, 255, 255, 255),
			_N$pressedColor: this.color(211, 211, 211, 255),
			pressedColor: this.color(211, 211, 211, 255),
			_N$hoverColor: this.color(255, 255, 255, 255),
			hoverColor: this.color(255, 255, 255, 255),
			_N$disabledColor: this.color(124, 124, 124, 255),
			disabledColor: this.color(124, 124, 124, 255),
			_N$normalSprite: null,
			_N$pressedSprite: null,
			pressedSprite: null,
			_N$hoverSprite: null,
			hoverSprite: null,
			_N$disabledSprite: null,
			disabledSprite: null,
			_N$target: null,
		};
	}

	private static color(r: number, g: number, b: number, a: number): any {
		return { __type__: "cc.Color", r, g, b, a };
	}
}
