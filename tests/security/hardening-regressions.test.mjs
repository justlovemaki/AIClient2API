import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import AdmZip from 'adm-zip';

const originalCwd = process.cwd();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient2api-regressions-'));
let server, logger;
const intervals = [];
after(async () => {
    for (const timer of intervals) clearInterval(timer);
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    logger?.close();
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
});
process.chdir(root);
for (const dir of ['configs', 'src/plugins/api-potluck', 'src/plugins/disabled-probe', 'src/plugins-user/review-user']) {
    await fs.mkdir(dir, { recursive: true });
}
await fs.writeFile('package.json', '{"type":"module"}');
await fs.writeFile('src/plugins/api-potluck/index.js', "export default {name:'api-potluck'};");
await fs.writeFile('src/plugins/disabled-probe/index.js', "export default {name:'disabled-probe'};");
await fs.writeFile('src/plugins-user/review-user/index.js', `
    import { writeFileSync } from 'node:fs';
    writeFileSync('configs/UNAPPROVED_EXECUTED', 'must never run');
    export default {name:'review-user'};
`);
const password = 'original-review-password';
const token = 'a'.repeat(64);
await fs.writeFile('configs/pwd', password);
await fs.writeFile('configs/token-store.json', JSON.stringify({ tokens: { [token]: { expiryTime: Date.now() + 120000 } } }));
await fs.writeFile('configs/normal-credentials.json', '{"test":"normal-provider-file"}');
await fs.writeFile('configs/plugins.json', JSON.stringify({ plugins: {
    'api-potluck': { enabled: true }, 'disabled-probe': { enabled: false }, 'review-user': { enabled: false }
} }));

const { PluginManager, discoverPlugins, getPluginManager } = await import('../../src/core/plugin-manager.js');
const { default: potluck } = await import('../../src/plugins/api-potluck/index.js');
const { handlePotluckApiRoutes } = await import('../../src/plugins/api-potluck/api-routes.js');
const { createKey } = await import('../../src/plugins/api-potluck/key-manager.js');
const { createRequestHandler } = await import('../../src/handlers/request-handler.js');
const { createPluginApproval, getPluginPackageHash } = await import('../../src/core/plugin-trust.js');
const { validatePluginExport } = await import('../../src/core/plugin-security.js');
const { CONFIG } = await import('../../src/core/config-manager.js');
({ default: logger } = await import('../../src/utils/logger.js'));
CONFIG.LOGIN_MIN_INTERVAL = 1;

const manager = getPluginManager();
// Use the REAL builtin handler, with only its deployment directory relocated.
manager.register({ ...potluck, _baseDir: path.join(root, 'src/plugins/api-potluck') });
await discoverPlugins();
await manager.initAll({ UI_ENABLED: false, MODEL_PROVIDER: 'test' });
const originalSetInterval = globalThis.setInterval;
let key;
try {
    globalThis.setInterval = (...args) => {
        const timer = originalSetInterval(...args);
        intervals.push(timer);
        return timer;
    };
    key = await createKey('regression-user', 100);
} finally {
    globalThis.setInterval = originalSetInterval;
}
// Force an actual signing key to exist, so forged-receipt tests cannot pass just
// because the key is missing. The unrelated receipt must not authorize this name.
const packageHash = await getPluginPackageHash(path.join(root, 'src/plugins-user/review-user'));
const unrelatedReceipt = await createPluginApproval('different-plugin', packageHash);
const keyFile = path.join(root, '.private/plugin-approval.key');
const appConfig = { UI_ENABLED: false, MODEL_PROVIDER: 'test', SYSTEM_PROMPT_FILE_PATH: 'configs/input_system_prompt.txt' };
server = http.createServer(createRequestHandler(appConfig, null));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const bearer = value => ({ authorization: `Bearer ${value}` });
const wait = () => new Promise(resolve => setTimeout(resolve, 15));
async function request(url, options = {}) {
    const response = await fetch(origin + url, options);
    return { status: response.status, body: await response.text() };
}
async function post(url, data) {
    return request(url, { method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify(data) });
}

for (const code of ['ENOSPC', 'EACCES', 'EROFS']) {
    test(`config persistence failure (${code}) aborts init instead of enabling disabled builtins`, async () => {
        const failed = new PluginManager();
        let calls = 0;
        const plugin = { name: 'disabled-probe', _baseDir: path.join(root, 'src/plugins/disabled-probe'), _enabled: true, init() { calls++; } };
        failed.register(plugin);
        failed.saveConfig = async () => { throw Object.assign(new Error(`simulated ${code}`), { code }); };
        await assert.rejects(failed.initAll({}), { code });
        assert.equal(calls, 0);
        assert.equal(plugin._enabled, false);
        assert.equal(failed.initialized, false);
        assert.equal(failed.pluginsConfig.plugins['disabled-probe'].enabled, false);
    });
}

test('malformed plugin configuration aborts before any lifecycle hook runs', async () => {
    const saved = await fs.readFile('configs/plugins.json', 'utf8');
    try {
        for (const content of ['{broken', 'null', '{"plugins":[]}', '{"plugins":{"disabled-probe":{"enabled":"false"}}}']) {
            await fs.writeFile('configs/plugins.json', content);
            const failed = new PluginManager();
            let calls = 0;
            failed.register({ name: 'disabled-probe', _baseDir: path.join(root, 'src/plugins/disabled-probe'), init() { calls++; } });
            await assert.rejects(failed.initAll({}));
            assert.equal(calls, 0);
            assert.equal(failed.initialized, false);
        }
    } finally { await fs.writeFile('configs/plugins.json', saved); }
});

test('Potluck users can query usage using their own Bearer or x-api-key, with UI on or off', async () => {
    for (const ui of [false, true]) {
        appConfig.UI_ENABLED = ui;
        for (const headers of [bearer(key.id), { 'x-api-key': key.id }]) {
            const response = await request('/api/potluckuser/usage', { headers });
            assert.equal(response.status, 200, response.body);
            assert.equal(JSON.parse(response.body).data.name, 'regression-user');
        }
    }
    appConfig.UI_ENABLED = false;
});

test('public Potluck user route still rejects missing, invalid and prototype credentials', async () => {
    for (const headers of [{}, bearer('maki_invalid'), bearer('constructor'), bearer('__proto__')]) {
        assert.equal((await request('/api/potluckuser/usage', { headers })).status, 401);
    }
    assert.equal((await request('/api/potluckuser/keys', { headers: bearer(key.id) })).status, 404);
    for (const headers of [{}, bearer(key.id), bearer('constructor'), bearer('__proto__')]) {
        assert.equal((await request('/api/potluck/keys', { headers })).status, 401);
    }
    assert.equal((await request('/api/potluck/stats', { headers: bearer(token) })).status, 200);
});

test('Potluck admin handler uses the hardened token verifier even when called directly', async () => {
    for (const value of ['constructor', '__proto__', key.id]) {
        let status;
        await handlePotluckApiRoutes('GET', '/api/potluck/stats', { headers: bearer(value) }, {
            writeHead(code) { status = code; }, end() {}
        });
        assert.equal(status, 401);
    }
});

test('compatibility alias cannot expose adjacent admin routes or be claimed by another/user plugin', () => {
    const route = routePath => ({ method: '*', path: routePath, public: true, handler() {} });
    assert.doesNotThrow(() => validatePluginExport({ name: 'api-potluck', routes: [route('/api/potluckuser')] }, 'api-potluck', false));
    assert.throws(() => validatePluginExport({ name: 'api-potluck', routes: [route('/api/potluck')] }, 'api-potluck', false));
    assert.throws(() => validatePluginExport({ name: 'api-potluck', routes: [route('/api/potluckuser')] }, 'api-potluck', true));
    assert.throws(() => validatePluginExport({ name: 'other-plugin', routes: [route('/api/potluckuser')] }, 'other-plugin', false));
});

test('disabled Potluck cannot be reached through its public-route exception', async () => {
    await manager.setPluginEnabled('api-potluck', false);
    assert.equal((await request('/api/potluckuser/usage', { headers: bearer(key.id) })).status, 401);
    assert.equal((await request('/api/potluckuser/usage', { headers: bearer(token) })).status, 503);
    await manager.setPluginEnabled('api-potluck', true);
});

test('prompt editor rejects approval/password/source/private-file overwrites without changing files or config', async () => {
    const savedPlugins = await fs.readFile('configs/plugins.json', 'utf8');
    const savedKey = await fs.readFile(keyFile, 'utf8');
    const savedSource = await fs.readFile('src/plugins-user/review-user/index.js', 'utf8');
    for (const file of ['configs/plugins.json', 'configs/config.json', 'configs/pwd', 'configs/token-store.json',
        'src/plugins-user/review-user/index.js', '.private/plugin-approval.key', 'configs/../.private/plugin-approval.key', '../outside.txt']) {
        const response = await post('/api/config', { SYSTEM_PROMPT_FILE_PATH: file, systemPrompt: 'forged', REQUIRED_API_KEY: 'must-not-change' });
        assert.equal(response.status, 403, `${file}: ${response.body}`);
    }
    for (const file of ['.private/plugin-approval.key', 'configs/plugins.json', 'configs/config.json', 'configs/token-store.json', 'src/package.json']) {
        const response = await post('/api/config', { PROVIDER_POOLS_FILE_PATH: file });
        assert.equal(response.status, 403, `${file}: ${response.body}`);
    }
    assert.equal(await fs.readFile('configs/plugins.json', 'utf8'), savedPlugins);
    assert.equal(await fs.readFile('configs/pwd', 'utf8'), password);
    assert.equal(await fs.readFile(keyFile, 'utf8'), savedKey);
    assert.equal(await fs.readFile('src/plugins-user/review-user/index.js', 'utf8'), savedSource);
    assert.equal(CONFIG.REQUIRED_API_KEY, undefined);
    await assert.rejects(fs.stat('configs/UNAPPROVED_EXECUTED'), { code: 'ENOENT' });
});

test('an inherited unsafe prompt path cannot bypass validation and is not read through GET config', async () => {
    appConfig.SYSTEM_PROMPT_FILE_PATH = 'configs/plugins.json';
    try {
        assert.equal((await post('/api/config', { systemPrompt: 'forged' })).status, 403);
        const response = await request('/api/config', { headers: bearer(token) });
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).systemPrompt, '');
    } finally { appConfig.SYSTEM_PROMPT_FILE_PATH = 'configs/input_system_prompt.txt'; }
});

test('normal .txt and .md prompt edits still work, including nested directories', async () => {
    for (const file of ['configs/input_system_prompt.txt', 'prompts/nested/system.md']) {
        const response = await post('/api/config', { SYSTEM_PROMPT_FILE_PATH: file, systemPrompt: 'safe prompt contents' });
        assert.equal(response.status, 200, response.body);
        assert.equal(await fs.readFile(file, 'utf8'), 'safe prompt contents');
    }
});

test('hard-link aliases cannot expose or overwrite the signing key via prompt/config APIs or backup', async () => {
    const alias = 'configs/innocent-prompt.txt';
    const before = await fs.readFile(keyFile, 'utf8');
    await fs.link(keyFile, alias);
    try {
        assert.equal((await post('/api/config', { SYSTEM_PROMPT_FILE_PATH: alias, systemPrompt: 'replacement' })).status, 403);
        for (const endpoint of ['view', 'download']) {
            assert.equal((await request(`/api/upload-configs/${endpoint}/${encodeURIComponent(alias)}`, { headers: bearer(token) })).status, 403);
        }
        const response = await fetch(origin + '/api/upload-configs/download-all', { headers: bearer(token) });
        assert.equal(response.status, 200);
        const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
        assert.equal(zip.getEntry('innocent-prompt.txt'), null);
        assert.equal(await fs.readFile(keyFile, 'utf8'), before);
    } finally { await fs.unlink(alias); }
});

test('directory-link aliases cannot expose private signing state through config file APIs', async () => {
    const alias = 'configs/private-alias';
    await fs.symlink(path.join(root, '.private'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
        for (const endpoint of ['view', 'download']) {
            const response = await request(`/api/upload-configs/${endpoint}/${encodeURIComponent(alias + '/plugin-approval.key')}`, { headers: bearer(token) });
            assert.equal(response.status, 403);
        }
    } finally { await fs.unlink(alias); }
});

test('generic config APIs cannot read, delete or back up password/session stores', async () => {
    for (const file of ['configs/pwd', 'configs/pwd.', 'configs/pwd ', 'configs/token-store.json', 'configs/token-store.json.', '.private/plugin-approval.key']) {
        for (const endpoint of ['view', 'download', 'delete']) {
            const response = await request(`/api/upload-configs/${endpoint}/${encodeURIComponent(file)}`, {
                method: endpoint === 'delete' ? 'DELETE' : 'GET', headers: bearer(token)
            });
            assert.equal(response.status, 403, `${endpoint} ${file}: ${response.body}`);
        }
    }
    const response = await fetch(origin + '/api/upload-configs/download-all', { headers: bearer(token) });
    assert.equal(response.status, 200);
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    assert.equal(zip.getEntry('pwd'), null);
    assert.equal(zip.getEntry('token-store.json'), null);
    assert.equal(zip.getEntry('plugin-approval.key'), null);
    assert.ok(zip.getEntry('normal-credentials.json'));
    assert.equal(await fs.readFile('configs/pwd', 'utf8'), password);
});

test('legacy receipts, fabricated signatures and receipts copied from another plugin cannot authorize code', async () => {
    const before = await fs.readFile('configs/plugins.json', 'utf8');
    try {
        for (const receipt of [
            { version: 1, mode: 'admin-approved', sha256: packageHash, approvedAt: new Date().toISOString() },
            { ...unrelatedReceipt, signature: '0'.repeat(64) },
            unrelatedReceipt
        ]) {
            const config = JSON.parse(before);
            config.plugins['review-user'] = { enabled: true, approval: receipt };
            await fs.writeFile('configs/plugins.json', JSON.stringify(config));
            const fresh = new PluginManager();
            fresh.registerPlaceholder('review-user', '', path.join(root, 'src/plugins-user/review-user'));
            await fresh.initAll({});
            assert.equal(fresh.isEnabled('review-user'), false);
            assert.equal((await fresh.getPluginList())[0].requiresApproval, true);
            await assert.rejects(fs.stat('configs/UNAPPROVED_EXECUTED'), { code: 'ENOENT' });
        }
    } finally { await fs.writeFile('configs/plugins.json', before); }
});

test('changing the admin password requires its current value, rather than just the session', async () => {
    const replacement = 'replacement-review-password';
    for (const currentPassword of [undefined, 'incorrect']) {
        await wait();
        const response = await post('/api/admin-password', { password: replacement, currentPassword });
        assert.equal(response.status, 403, response.body);
        assert.equal(await fs.readFile('configs/pwd', 'utf8'), password);
    }
    await wait();
    const response = await post('/api/admin-password', { password: replacement, currentPassword: password });
    assert.equal(response.status, 200, response.body);
    const { validateCredentials } = await import('../../src/ui-modules/auth.js');
    assert.equal(await validateCredentials(replacement), true);
    assert.equal(await validateCredentials(password), false);
});
