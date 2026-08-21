'use strict';

/**
 * 这是一份面向 UI Blueprint Schema 的轻量 Draft-07 校验器。
 *
 * 工具链刻意不依赖项目的 node_modules：cocos-ui-builder 会被复制到不同的
 * Creator 2.4 项目中，并且 `validate` 必须在首次安装 Bridge 之前就可运行。
 * 因此这里仅实现 schema/ui-blueprint.schema.json 实际使用到的关键字，而不是
 * 假装提供完整 JSON Schema 引擎。遇到 Schema 中未支持的关键字会直接报错，
 * 防止 Schema 演进后校验器静默放宽约束。
 */

const supportedKeywords = new Set([
    '$schema', '$id', 'title', 'description', 'default',
    'type', 'const', 'enum', 'required', 'additionalProperties', 'properties',
    'items', 'uniqueItems', 'minLength', 'pattern', 'minimum', 'maximum',
    '$ref', 'oneOf', 'definitions',
]);

function valueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
}

function matchesType(value, expectedType) {
    if (expectedType === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (expectedType === 'integer') return Number.isInteger(value);
    if (expectedType === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
    if (expectedType === 'array') return Array.isArray(value);
    if (expectedType === 'null') return value === null;
    return typeof value === expectedType;
}

function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLocalRef(rootSchema, ref) {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) {
        throw new Error(`只支持 Schema 内部引用: ${ref}`);
    }
    return ref.slice(2).split('/').reduce((current, segment) => {
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!current || !Object.prototype.hasOwnProperty.call(current, key)) {
            throw new Error(`Schema 引用不存在: ${ref}`);
        }
        return current[key];
    }, rootSchema);
}

function assertSupportedSchema(schema, schemaPath = '#') {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new Error(`Schema 节点必须是对象: ${schemaPath}`);
    }
    for (const key of Object.keys(schema)) {
        if (!supportedKeywords.has(key)) throw new Error(`Schema 使用了未支持的关键字 ${key}: ${schemaPath}`);
    }
    if (schema.properties) {
        for (const [key, child] of Object.entries(schema.properties)) assertSupportedSchema(child, `${schemaPath}/properties/${key}`);
    }
    if (schema.definitions) {
        for (const [key, child] of Object.entries(schema.definitions)) assertSupportedSchema(child, `${schemaPath}/definitions/${key}`);
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) assertSupportedSchema(schema.items, `${schemaPath}/items`);
    if (schema.oneOf) schema.oneOf.forEach((child, index) => assertSupportedSchema(child, `${schemaPath}/oneOf/${index}`));
}

/**
 * 根据传入 Schema 严格校验 JSON 值并返回稳定、适合 CLI 展示的错误数组。
 * 默认值只属于文档契约，本函数不偷偷修改蓝图输入。
 */
function validateJsonSchema(value, rootSchema) {
    assertSupportedSchema(rootSchema);
    const errors = [];

    function visit(currentValue, schema, instancePath) {
        if (schema.$ref) return visit(currentValue, resolveLocalRef(rootSchema, schema.$ref), instancePath);

        if (schema.oneOf) {
            const candidates = schema.oneOf.map(candidate => {
                const candidateErrors = [];
                const previousErrors = errors.splice(0, errors.length);
                visit(currentValue, candidate, instancePath);
                candidateErrors.push(...errors.splice(0, errors.length));
                errors.push(...previousErrors);
                return candidateErrors;
            });
            const matching = candidates.filter(candidateErrors => candidateErrors.length === 0);
            if (matching.length !== 1) errors.push(`${instancePath} 必须且只能匹配 oneOf 中的一种结构`);
            return;
        }

        const expectedTypes = schema.type === undefined ? null : (Array.isArray(schema.type) ? schema.type : [schema.type]);
        if (expectedTypes && !expectedTypes.some(type => matchesType(currentValue, type))) {
            errors.push(`${instancePath} 类型必须是 ${expectedTypes.join('|')}，实际为 ${valueType(currentValue)}`);
            return;
        }
        if (Object.prototype.hasOwnProperty.call(schema, 'const') && !valuesEqual(currentValue, schema.const)) {
            errors.push(`${instancePath} 必须等于 ${JSON.stringify(schema.const)}`);
        }
        if (schema.enum && !schema.enum.some(option => valuesEqual(currentValue, option))) {
            errors.push(`${instancePath} 必须是 ${schema.enum.map(option => JSON.stringify(option)).join('、')} 之一`);
        }

        if (typeof currentValue === 'string') {
            if (schema.minLength !== undefined && currentValue.length < schema.minLength) errors.push(`${instancePath} 长度不能小于 ${schema.minLength}`);
            if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(currentValue))) errors.push(`${instancePath} 不匹配格式 ${schema.pattern}`);
        }
        if (typeof currentValue === 'number') {
            if (schema.minimum !== undefined && currentValue < schema.minimum) errors.push(`${instancePath} 不能小于 ${schema.minimum}`);
            if (schema.maximum !== undefined && currentValue > schema.maximum) errors.push(`${instancePath} 不能大于 ${schema.maximum}`);
        }
        if (Array.isArray(currentValue)) {
            if (schema.uniqueItems) {
                const serialized = currentValue.map(item => JSON.stringify(item));
                if (new Set(serialized).size !== serialized.length) errors.push(`${instancePath} 不能包含重复项`);
            }
            if (schema.items) currentValue.forEach((item, index) => visit(item, schema.items, `${instancePath}[${index}]`));
        }
        if (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)) {
            for (const requiredKey of schema.required || []) {
                if (!Object.prototype.hasOwnProperty.call(currentValue, requiredKey)) errors.push(`${instancePath}.${requiredKey} 是必填字段`);
            }
            const properties = schema.properties || {};
            if (schema.additionalProperties === false) {
                for (const key of Object.keys(currentValue)) {
                    if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${instancePath}.${key} 是未声明字段`);
                }
            }
            for (const [key, childSchema] of Object.entries(properties)) {
                if (Object.prototype.hasOwnProperty.call(currentValue, key)) visit(currentValue[key], childSchema, `${instancePath}.${key}`);
            }
        }
    }

    visit(value, rootSchema, '$');
    return errors;
}

module.exports = { validateJsonSchema };
