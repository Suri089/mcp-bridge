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
			if (typeof value.$asset === "string") {
				assetUrls.add(value.$asset);
				if (!value.$asset.startsWith("db://")) {
					errors.push(`${valuePath}.$asset 必须使用 db:// 资源路径`);
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
			if (node.transform && typeof node.transform !== "object") {
				errors.push(`${nodePath}.transform 必须是对象`);
			}
			if (node.asset !== undefined) {
				if (typeof node.asset !== "string" || !node.asset.startsWith("db://")) {
					errors.push(`${nodePath}.asset 必须使用 db:// 资源路径`);
				} else {
					assetUrls.add(node.asset);
				}
			}
			if (node.components !== undefined && !Array.isArray(node.components)) {
				errors.push(`${nodePath}.components 必须是数组`);
			} else if (Array.isArray(node.components)) {
				node.components.forEach((component: any, index: number) => {
					components++;
					if (!component || typeof component.type !== "string" || !component.type.trim()) {
						errors.push(`${nodePath}.components[${index}].type 必须是非空字符串`);
					}
					collectValue(component && component.properties, `${nodePath}.components[${index}].properties`);
				});
			}
			if (node.events !== undefined && !Array.isArray(node.events)) {
				errors.push(`${nodePath}.events 必须是数组`);
			} else if (Array.isArray(node.events)) {
				node.events.forEach((event: any, index: number) => {
					events++;
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
		return {
			blueprintPath: path.relative(Editor.Project.path, loaded.filePath).replace(/\\/g, "/"),
			...validation,
			targetExists,
			operation: targetExists ? "update" : "create",
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
			const relativeToProject = path.relative(projectPath, currentPath);
			if (relativeToProject.startsWith("..") || path.isAbsolute(relativeToProject)) return;
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
