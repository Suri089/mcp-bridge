const packageInfo = require('../../package.json');

export const serverVersion = packageInfo.version as string;

export const serverInstructions = [
    'Before calling project tools, call get_active_instances. If more than one Cocos Creator project is running, select the intended project by projectPath with set_active_instance; never guess or silently choose the first project.',
    'Before writes, inspect the target with get_scene_hierarchy, manage_components(get), search_project, or the relevant read tool. Do not guess node IDs, component types, property names, asset UUIDs, or paths.',
    'Follow the target repository AGENTS.md and local project rules. Do not use modify_scene_offline or modify_prefab_offline when project rules prohibit direct serialized scene or prefab edits.',
    'After changes, save through the appropriate tool, read the changed state again, and inspect console output or an editor screenshot when useful. Treat delete, move, overwrite, build, and offline serialized-asset edits as potentially destructive.',
    'If the selected instance disappears or its port is reused by a different project, stop and select the project again.'
].join(' ');

export const instanceTools = [
    {
        name: 'get_active_instances',
        description: 'List Cocos Creator MCP Bridge instances on ports 8200-8210, including projectName, projectPath, port, and whether each instance is selected.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'set_active_instance',
        description: 'Select one currently running Cocos Creator project by its port. Obtain the port from get_active_instances; arbitrary or offline ports are rejected.',
        inputSchema: {
            type: 'object',
            properties: {
                port: { type: 'integer', minimum: 8200, maximum: 8210, description: 'A currently running instance port returned by get_active_instances.' }
            },
            required: ['port'],
            additionalProperties: false
        }
    }
];
