const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const proxyPath = path.join(repoRoot, 'dist', 'mcp-proxy.js');
const packageInfo = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

if (!fs.existsSync(proxyPath)) {
    throw new Error(`Proxy build not found: ${proxyPath}`);
}

const proxy = childProcess.spawn(process.execPath, [proxyPath], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let stdoutBuffer = '';
let stderrBuffer = '';
let nextId = 1;

proxy.stderr.on('data', data => { stderrBuffer += data.toString(); });
proxy.stdout.on('data', data => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const handler = pending.get(message.id);
        if (handler) {
            pending.delete(message.id);
            handler(message);
        }
    }
});

function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Timed out waiting for ${method}. stderr: ${stderrBuffer}`));
        }, 5000);
        pending.set(id, message => {
            clearTimeout(timer);
            resolve(message);
        });
        proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function run() {
    const initialized = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-bridge-smoke', version: '1.0.0' }
    });
    assert(initialized.result.serverInfo.version === packageInfo.version, 'serverInfo.version does not match package.json');
    assert(initialized.result.instructions.includes('get_active_instances'), 'Server instructions are missing the instance workflow');

    proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await request('tools/list');
    const toolNames = listed.result.tools.map(tool => tool.name);
    for (const requiredTool of ['get_active_instances', 'set_active_instance', 'get_scene_hierarchy', 'modify_prefab_offline']) {
        assert(toolNames.includes(requiredTool), `Missing tool: ${requiredTool}`);
    }
    assert(new Set(toolNames).size === toolNames.length, 'tools/list contains duplicate tool names');

    const instancesResponse = await request('tools/call', { name: 'get_active_instances', arguments: {} });
    const instances = JSON.parse(instancesResponse.result.content[0].text);
    if (instances.length > 0) {
        const selectedResponse = await request('tools/call', { name: 'set_active_instance', arguments: { port: instances[0].port } });
        const selected = JSON.parse(selectedResponse.result.content[0].text);
        assert(selected.projectPath === instances[0].projectPath, 'Selected instance projectPath does not match');
    }

    const invalidSelection = await request('tools/call', { name: 'set_active_instance', arguments: { port: 65535 } });
    assert(invalidSelection.error && invalidSelection.error.code === -32602, 'Invalid instance port was not rejected');
    process.stdout.write(`MCP smoke test passed: ${toolNames.length} tools, ${instances.length} active instance(s).\n`);
}

run().then(() => proxy.kill()).catch(error => {
    proxy.kill();
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
});
