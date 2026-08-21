/**
 * Prefab 自动同步预检所需的最小节点形状。
 *
 * 这里故意不依赖 `cc.Node`：纯遍历逻辑可以在 Node 环境单测，Creator 场景脚本
 * 只负责把真实节点交进来。`_prefab` 属于 Creator 2.4 的编辑器序列化信息，访问
 * 被集中在这一处，避免其它事务代码继续扩散内部字段知识。
 */
export interface PrefabSyncInspectableNode {
	name?: string;
	uuid?: string;
	children?: PrefabSyncInspectableNode[];
	_prefab?: {
		sync?: boolean;
		asset?: {
			_uuid?: string;
			uuid?: string;
		};
	};
}

/** UI Builder 拒绝事务时返回的精简冲突证据。 */
export interface AutoSyncPrefabInstanceMatch {
	name: string;
	uuid: string;
	path: string;
}

/**
 * 查找节点树中引用目标资源的自动同步 Prefab 根实例。
 *
 * `normalizeUuid` 由 Creator 适配层注入，用于统一 22 位压缩 UUID 与 36 位 UUID；
 * 默认值适合单测和已经标准化的输入。遍历顺序固定为父节点优先、子节点原顺序，
 * 让错误报告可复现，也便于定位第一个冲突节点。
 */
export function findAutoSyncPrefabInstances(
	root: PrefabSyncInspectableNode | null | undefined,
	targetPrefabUuid: string,
	normalizeUuid: (uuid: string) => string = (uuid) => uuid,
): AutoSyncPrefabInstanceMatch[] {
	if (!root || !targetPrefabUuid) return [];
	const normalizedTarget = normalizeUuid(targetPrefabUuid);
	const matches: AutoSyncPrefabInstanceMatch[] = [];

	const visit = (node: PrefabSyncInspectableNode, parentPath: string): void => {
		const nodeName = typeof node.name === "string" && node.name ? node.name : "<unnamed>";
		const nodePath = parentPath ? `${parentPath}/${nodeName}` : nodeName;
		const prefabInfo = node._prefab;
		const asset = prefabInfo && prefabInfo.asset;
		const assetUuid = asset && (asset._uuid || asset.uuid);
		if (
			prefabInfo &&
			prefabInfo.sync === true &&
			typeof assetUuid === "string" &&
			normalizeUuid(assetUuid) === normalizedTarget
		) {
			matches.push({
				name: nodeName,
				uuid: typeof node.uuid === "string" ? node.uuid : "",
				path: nodePath,
			});
		}

		const children = Array.isArray(node.children) ? node.children : [];
		for (let index = 0; index < children.length; index += 1) {
			if (children[index]) visit(children[index], nodePath);
		}
	};

	visit(root, "");
	return matches;
}
