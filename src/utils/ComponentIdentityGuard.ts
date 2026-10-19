/** 组件实例不明确时中止写入，不能降级为普通属性解析警告。 */
export class ComponentIdentityError extends Error {}

/** 按组件类型查询时拒绝重复实例，避免默默覆盖第一项。 */
export function getUniqueComponent(node: any, componentClass: any, type: string): any {
    const components = node.getComponents(componentClass);
    if (components.length > 1) {
        throw new ComponentIdentityError(`节点 ${node.name} 存在 ${components.length} 个 ${type}，必须通过 componentId 定位具体实例；禁止按类型操作第一项`);
    }
    return components[0] || null;
}

/** 组件 ID 不存在时拒绝回退到类型匹配，避免误改其它实例。 */
export function selectComponentForMutation(node: any, componentId: string, componentClass: any, type: string): any {
    if (componentId) {
        const component = (node._components || []).find((item: any) => item.uuid === componentId);
        if (!component) throw new ComponentIdentityError(`找不到组件 ID: ${componentId}，已拒绝回退到组件类型`);
        if (componentClass && !(component instanceof componentClass)) {
            throw new ComponentIdentityError(`组件 ID ${componentId} 与类型 ${type} 不匹配`);
        }
        return component;
    }
    return componentClass ? getUniqueComponent(node, componentClass, type) : null;
}

/** 只读提取已有 Prefab 中重复组件的顺序和标量属性，不依赖资源 UUID 常量。 */
export function snapshotRepeatedComponents(source: string | any[]): any[] {
    const data = typeof source === 'string' ? JSON.parse(source) : source;
    if (!Array.isArray(data)) throw new Error('重复组件检查需要 Creator 序列化数组');
    const dereference = (value: any) => value && typeof value.__id__ === 'number' ? data[value.__id__] : null;
    const prefab = data[0] && data[0].__type__ === 'cc.Prefab' ? data[0] : null;
    const root = prefab ? dereference(prefab.data) : data[0];
    if (!root || !Array.isArray(root._components)) throw new Error('重复组件检查找不到 Prefab 根节点');
    const groups = [];
    const visited = new Set();
    const visit = (node: any, identity: string) => {
        if (!node || visited.has(node)) throw new Error('重复组件检查遇到无效或重复节点引用');
        visited.add(node);
        const componentsByType = new Map<string, any[]>();
        for (const reference of node._components || []) {
            const component = dereference(reference);
            if (!component || typeof component.__type__ !== 'string') throw new Error('重复组件检查遇到无效组件引用');
            const properties = {};
            for (const key of Object.keys(component).sort()) {
                if (['__type__', '_id', '_objFlags', 'node'].includes(key)) continue;
                const value = component[key];
                if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) properties[key] = value;
            }
            if (!componentsByType.has(component.__type__)) componentsByType.set(component.__type__, []);
            componentsByType.get(component.__type__).push(properties);
        }
        componentsByType.forEach((components, type) => {
            if (components.length > 1) groups.push({ node: identity, type, components });
        });
        (node._children || []).forEach((reference: any, index: number) => {
            const child = dereference(reference);
            if (!child) throw new Error('重复组件检查遇到无效子节点引用');
            const prefabInfo = dereference(child._prefab);
            const segment = prefabInfo && prefabInfo.fileId ? ['fileId', prefabInfo.fileId] : ['child', index, child._name];
            visit(child, `${identity}/${JSON.stringify(segment)}`);
        });
    };
    visit(root, 'root');
    return groups;
}

/** 核对原有重复组件，发现数量、顺序或标量属性变化时让事务失败。 */
export function compareRepeatedComponents(expected: any[], actual: any[]): { valid: boolean; checkedGroups: number; errors: string[] } {
    const errors = [];
    for (const group of expected) {
        const found = actual.find((item: any) => item.node === group.node && item.type === group.type);
        if (!found || JSON.stringify(found.components) !== JSON.stringify(group.components)) {
            errors.push(`原有重复组件被改动: ${group.node} / ${group.type}（数量、顺序或标量属性不一致）`);
        }
    }
    return { valid: errors.length === 0, checkedGroups: expected.length, errors };
}
