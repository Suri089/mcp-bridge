import * as fs from "fs";
import * as path from "path";

declare const Editor: any;

export type UiBlueprintValidation = {
	valid: boolean;
	errors: string[];
	warnings: string[];
	summary: {
		target: string;
		nodes: number;
		components: number;
		events: number;
		assetReferences: number;
	};
};

/**
 * UI 蓝图读取、校验与轻量资产盘点。
 * 只处理项目内的声明式蓝图，不读写 Cocos 序列化资源。
 */
export class UiBlueprint {
	static readonly maxBlueprintBytes = 2 * 1024 * 1024;

	static resolveProjectFile(inputPath: string) {
		if (!inputPath || typeof inputPath !== "string") {
			throw new Error("blueprintPath 必须是项目内文件路径");
		}
		const projectPath = path.resolve(Editor.Project.path);
		let filePath = inputPath.startsWith("db://")
			? Editor.assetdb.urlToFspath(inputPath)
			: path.resolve(projectPath, inputPath);
		if (!filePath) {
			throw new Error(`无法解析蓝图路径: ${inputPath}`);
		}
		filePath = path.resolve(filePath);
		const relative = path.relative(projectPath, filePath);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`蓝图必须位于项目目录内: ${inputPath}`);
		}
		return filePath;
	}

	static load(inputPath: string) {
		const filePath = UiBlueprint.resolveProjectFile(inputPath);
		if (!fs.existsSync(filePath)) {
			throw new Error(`蓝图文件不存在: ${inputPath}`);
		}
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) {
			throw new Error(`蓝图路径不是文件: ${inputPath}`);
		}
		if (stat.size > UiBlueprint.maxBlueprintBytes) {
			throw new Error(`蓝图超过 ${UiBlueprint.maxBlueprintBytes} 字节限制`);
		}
		let blueprint: any;
		try {
			blueprint = JSON.parse(fs.readFileSync(filePath, "utf8"));
		} catch (error: any) {
			throw new Error(`蓝图 JSON 解析失败: ${error.message}`);
		}
		return { blueprint, filePath };
	}

	static validate(blueprint: any): UiBlueprintValidation {
		const errors: string[] = [];
		const warnings: string[] = [];
		const seenIds = new Set<string>();
		const referencedNodeIds = new Set<string>();
		const assetUrls = new Set<string>();
		let nodes = 0;
		let components = 0;
		let events = 0;

		/**
		 * Bridge 不能假设所有调用方都遵守 Skill 并先经过项目 CLI。这里保留
		 * 与 v1 Schema 对齐的未知字段防线，避免拼错字段被静默忽略后仍然保存。
		 * 完整格式权威仍是项目内 JSON Schema；此处只做事务入口的纵深防御。
		 */
		const assertKnownKeys = (value: any, allowed: string[], valuePath: string) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			const allowedSet = new Set(allowed);
			Object.keys(value).forEach((key) => {
				if (!allowedSet.has(key)) errors.push(`${valuePath}.${key} 是未声明字段`);
			});
		};

		if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) {
			errors.push("蓝图根必须是对象");
		}
		if (blueprint && blueprint.version !== 1) {
			errors.push("当前仅支持 version: 1");
		}
		const target = blueprint && blueprint.target;
		if (!target || typeof target !== "object") {
			errors.push("缺少 target 对象");
		} else {
			assertKnownKeys(target, ["prefab", "mode", "template"], "target");
			if (typeof target.prefab !== "string" || !target.prefab.startsWith("db://assets/") || !target.prefab.endsWith(".prefab")) {
				errors.push("target.prefab 必须是 db://assets/ 下的 .prefab 路径");
			}
			if (target.mode && !["update-or-create", "update-only", "create-only"].includes(target.mode)) {
				errors.push("target.mode 仅支持 update-or-create、update-only、create-only");
			}
		}

		const collectValue = (value: any, valuePath: string) => {
			if (Array.isArray(value)) {
				value.forEach((item, index) => collectValue(item, `${valuePath}[${index}]`));
				return;
			}
			if (!value || typeof value !== "object") return;
			const referenceKeys = ["$asset", "$node", "$component"].filter((key) => Object.prototype.hasOwnProperty.call(value, key));
			if (referenceKeys.length > 0) {
				if (referenceKeys.length !== 1 || Object.keys(value).length !== 1) {
					errors.push(`${valuePath} 必须且只能包含一种蓝图引用`);
				}
				if (referenceKeys[0] === "$node" && (typeof value.$node !== "string" || !value.$node.trim())) {
					errors.push(`${valuePath}.$node 必须是非空语义 ID`);
				}
				if (referenceKeys[0] === "$component") {
					assertKnownKeys(value.$component, ["node", "type"], `${valuePath}.$component`);
					if (!value.$component || typeof value.$component.node !== "string" || typeof value.$component.type !== "string") {
						errors.push(`${valuePath}.$component 必须包含 node 和 type`);
					}
				}
			}
			if (typeof value.$asset === "string") {
				assetUrls.add(value.$asset);
				if (!value.$asset.startsWith("db://assets/")) {
					errors.push(`${valuePath}.$asset 必须使用 db://assets/ 资源路径`);
				}
			}
			if (typeof value.$node === "string") referencedNodeIds.add(value.$node);
			if (value.$component && typeof value.$component.node === "string") {
				referencedNodeIds.add(value.$component.node);
			}
			Object.keys(value).forEach((key) => collectValue(value[key], `${valuePath}.${key}`));
		};

		const visitNode = (node: any, nodePath: string, isRoot: boolean) => {
			if (!node || typeof node !== "object" || Array.isArray(node)) {
				errors.push(`${nodePath} 必须是对象`);
				return;
			}
			nodes++;
			assertKnownKeys(node, ["id", "name", "type", "active", "transform", "layout", "asset", "components", "events", "children"], nodePath);
			if (typeof node.id !== "string" || !node.id.trim()) {
				errors.push(`${nodePath}.id 必须是非空字符串`);
			} else if (seenIds.has(node.id)) {
				errors.push(`节点语义 ID 重复: ${node.id}`);
			} else {
				seenIds.add(node.id);
			}
			if (node.name !== undefined && (typeof node.name !== "string" || !node.name.trim())) {
				errors.push(`${nodePath}.name 必须是非空字符串`);
			}
			if (node.type && !["node", "page", "container", "sprite", "label", "button", "layout"].includes(node.type)) {
				errors.push(`${nodePath}.type 不受支持: ${node.type}`);
			}
			if (isRoot && node.type === "label") warnings.push("根节点使用 label 类型通常不是预期设计");
			if (node.active !== undefined && typeof node.active !== "boolean") {
				errors.push(`${nodePath}.active 必须是布尔值`);
			}
			if (node.transform && (typeof node.transform !== "object" || Array.isArray(node.transform))) {
				errors.push(`${nodePath}.transform 必须是对象`);
			} else if (node.transform) {
				assertKnownKeys(node.transform, ["x", "y", "width", "height", "anchorX", "anchorY", "scaleX", "scaleY", "angle", "opacity", "color"], `${nodePath}.transform`);
				for (const key of ["x", "y", "width", "height", "anchorX", "anchorY", "scaleX", "scaleY", "angle", "opacity"]) {
					if (node.transform[key] !== undefined && (typeof node.transform[key] !== "number" || !Number.isFinite(node.transform[key]))) {
						errors.push(`${nodePath}.transform.${key} 必须是有限数字`);
					}
				}
				if (typeof node.transform.width === "number" && node.transform.width < 0) errors.push(`${nodePath}.transform.width 不能小于 0`);
				if (typeof node.transform.height === "number" && node.transform.height < 0) errors.push(`${nodePath}.transform.height 不能小于 0`);
				for (const key of ["anchorX", "anchorY"]) {
					if (typeof node.transform[key] === "number" && (node.transform[key] < 0 || node.transform[key] > 1)) errors.push(`${nodePath}.transform.${key} 必须在 0 到 1 之间`);
				}
				if (typeof node.transform.opacity === "number" && (node.transform.opacity < 0 || node.transform.opacity > 255)) errors.push(`${nodePath}.transform.opacity 必须在 0 到 255 之间`);
				if (node.transform.color !== undefined && (typeof node.transform.color !== "string" || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(node.transform.color))) {
					errors.push(`${nodePath}.transform.color 必须是 #RRGGBB 或 #RRGGBBAA`);
				}
			}
			if (node.asset !== undefined) {
				if (typeof node.asset !== "string" || !node.asset.startsWith("db://assets/")) {
					errors.push(`${nodePath}.asset 必须使用 db://assets/ 资源路径`);
				} else {
					assetUrls.add(node.asset);
				}
			}
			if (node.components !== undefined && !Array.isArray(node.components)) {
				errors.push(`${nodePath}.components 必须是数组`);
			} else if (Array.isArray(node.components)) {
				node.components.forEach((component: any, index: number) => {
					components++;
					assertKnownKeys(component, ["type", "properties"], `${nodePath}.components[${index}]`);
					if (!component || typeof component.type !== "string" || !component.type.trim()) {
						errors.push(`${nodePath}.components[${index}].type 必须是非空字符串`);
					}
					if (component && component.properties !== undefined && (!component.properties || typeof component.properties !== "object" || Array.isArray(component.properties))) {
						errors.push(`${nodePath}.components[${index}].properties 必须是对象`);
					}
					collectValue(component && component.properties, `${nodePath}.components[${index}].properties`);
				});
			}
			if (node.events !== undefined && !Array.isArray(node.events)) {
				errors.push(`${nodePath}.events 必须是数组`);
			} else if (Array.isArray(node.events)) {
				node.events.forEach((event: any, index: number) => {
					events++;
					assertKnownKeys(event, ["sourceComponent", "property", "target", "component", "handler", "customEventData"], `${nodePath}.events[${index}]`);
					if (!event || typeof event.component !== "string" || typeof event.handler !== "string") {
						errors.push(`${nodePath}.events[${index}] 缺少 component 或 handler`);
					}
					if (event && typeof event.target === "string") referencedNodeIds.add(event.target);
				});
			}
			if (node.children !== undefined && !Array.isArray(node.children)) {
				errors.push(`${nodePath}.children 必须是数组`);
			} else if (Array.isArray(node.children)) {
				node.children.forEach((child: any, index: number) => visitNode(child, `${nodePath}.children[${index}]`, false));
			}
		};

		if (!blueprint || !blueprint.root) {
			errors.push("缺少 root 节点");
		} else {
			assertKnownKeys(blueprint, ["version", "target", "managedRegions", "protectedRegions", "root"], "blueprint");
			for (const key of ["managedRegions", "protectedRegions"]) {
				if (blueprint[key] !== undefined && (!Array.isArray(blueprint[key]) || blueprint[key].some((item) => typeof item !== "string" || !item.trim()))) {
					errors.push(`${key} 必须是非空字符串数组`);
				}
			}
			visitNode(blueprint.root, "root", true);
		}
		referencedNodeIds.forEach((id) => {
			if (!seenIds.has(id)) errors.push(`引用了不存在的节点语义 ID: ${id}`);
		});

		return {
			valid: errors.length === 0,
			errors,
			warnings,
			summary: {
				target: target && typeof target.prefab === "string" ? target.prefab : "",
				nodes,
				components,
				events,
				assetReferences: assetUrls.size,
			},
		};
	}

	static collectAssetUrls(blueprint: any) {
		const urls = new Set<string>();
		const visit = (value: any) => {
			if (Array.isArray(value)) return value.forEach(visit);
			if (!value || typeof value !== "object") return;
			if (typeof value.asset === "string" && value.asset.startsWith("db://")) urls.add(value.asset);
			if (typeof value.$asset === "string" && value.$asset.startsWith("db://")) urls.add(value.$asset);
			Object.keys(value).forEach((key) => visit(value[key]));
		};
		visit(blueprint);
		return Array.from(urls);
	}

	static dryRun(inputPath: string) {
		const loaded = UiBlueprint.load(inputPath);
		const validation = UiBlueprint.validate(loaded.blueprint);
		const target = validation.summary.target;
		const targetExists = !!target && Editor.assetdb.exists(target);
		const missingAssets = UiBlueprint.collectAssetUrls(loaded.blueprint).filter((url) => !Editor.assetdb.exists(url));
		const mode = loaded.blueprint && loaded.blueprint.target
			? loaded.blueprint.target.mode || "update-or-create"
			: "update-or-create";
		const errors = validation.errors.slice();

		// mode 是事务的写入边界。dry-run 必须提前报告冲突，调用方才能在进入
		// Prefab 编辑模式前停止；apply 内部仍保留同样判断作为纵深防御。
		if (validation.valid && mode === "update-only" && !targetExists) {
			errors.push("target.mode 为 update-only，但目标 Prefab 不存在");
		}
		if (validation.valid && mode === "create-only" && targetExists) {
			errors.push("target.mode 为 create-only，但目标 Prefab 已存在");
		}
		return {
			blueprintPath: path.relative(Editor.Project.path, loaded.filePath).replace(/\\/g, "/"),
			...validation,
			valid: errors.length === 0,
			errors,
			targetExists,
			operation: targetExists ? "update" : "create",
			mode,
			missingAssets: missingAssets.slice(0, 50),
		};
	}

	static scanAssets(args: any) {
		const projectPath = path.resolve(Editor.Project.path);
		const assetsPath = path.join(projectPath, "assets");
		const rawKeywords = Array.isArray(args && args.keywords) ? args.keywords : [args && args.keyword];
		const keywords = rawKeywords.filter(Boolean).map((value) => String(value).toLowerCase());
		const limit = Math.max(1, Math.min(Number(args && args.limit) || 80, 200));
		const roots = Array.isArray(args && args.searchPaths) && args.searchPaths.length
			? args.searchPaths.map((item) => path.resolve(projectPath, item))
			: [assetsPath];
		const allowedExtensions = new Set([".prefab", ".fire", ".png", ".jpg", ".jpeg", ".plist", ".atlas", ".ttf", ".fnt", ".ts"]);
		const matches: any[] = [];
		const visit = (currentPath: string) => {
			if (matches.length >= limit * 4 || !fs.existsSync(currentPath)) return;
			const currentRelative = path.relative(projectPath, currentPath);
			if (currentRelative.startsWith("..") || path.isAbsolute(currentRelative)) return;
			const entries = fs.readdirSync(currentPath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".") || entry.name === "library" || entry.name === "temp") continue;
				const entryPath = path.join(currentPath, entry.name);
				if (entry.isDirectory()) {
					visit(entryPath);
					continue;
				}
				const extension = path.extname(entry.name).toLowerCase();
				if (!allowedExtensions.has(extension)) continue;
				// 返回值必须指向实际文件。旧实现复用了 currentPath 的相对目录，
				// 导致同一目录下所有命中项都返回 `db://assets/目录`，无法作为蓝图资源。
				const relativeToProject = path.relative(projectPath, entryPath);
				const normalized = relativeToProject.replace(/\\/g, "/").toLowerCase();
				const name = entry.name.toLowerCase();
				let score = keywords.length === 0 ? 1 : 0;
				for (const keyword of keywords) {
					if (name.includes(keyword)) score += 5;
					else if (normalized.includes(keyword)) score += 2;
				}
				if (score === 0) continue;
				matches.push({
					url: `db://${relativeToProject.replace(/\\/g, "/")}`,
					type: extension.slice(1),
					score,
				});
			}
		};
		roots.forEach(visit);
		matches.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
		return {
			keywords,
			count: Math.min(matches.length, limit),
			truncated: matches.length > limit,
			assets: matches.slice(0, limit),
		};
	}
}
