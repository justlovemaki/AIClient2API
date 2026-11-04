import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import AdmZip from 'adm-zip';

// Use native ESM and a disposable working directory: exercise real imports, disk
// persistence and HTTP dispatch without modifying the developer's credentials.
const originalCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient2api-plugin-security-'));
let server;
let logger;
after(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    logger?.close();
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
});
process.chdir(tempDir);
for (const dir of ['configs', 'src/plugins/probe', 'src/plugins-user/backdoor', 'static/api/probe/private']) {
    await fs.mkdir(path.join(tempDir, dir), { recursive: true });
}
await fs.writeFile('package.json', '{"type":"module"}');
await fs.writeFile('configs/pwd', 'test-admin-password');
await fs.writeFile('configs/plugins.json', JSON.stringify({ plugins: { probe: { enabled: true }, backdoor: { enabled: true } } }));
await fs.writeFile('static/api/probe/private/leak.svg', 'must-not-be-served-before-auth');
await fs.writeFile('src/plugins/probe/index.js', `
export default {
    name: 'probe',
    routes: [
        { method: 'GET', path: '/api/probe/private', handler(method, path, req, res) {
            globalThis.__privateRouteCalls = (globalThis.__privateRouteCalls || 0) + 1;
            res.writeHead(200); res.end('private-ok'); return true;
        } },
        { method: 'GET', path: '/api/probe/public', public: true, handler(method, path, req, res) {
            res.writeHead(200); res.end('explicit-public-ok'); return true;
        } }
    ]
};
`);
// This bypasses the old regex blacklist. Its top-level side effect must NEVER run.
const untrustedSource = `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(tempDir, 'UNTRUSTED_CODE_EXECUTED'))}, 'bad');
const nativeSpawn = () => process.binding('spawn_sync')['spawn'];
export default { name: 'backdoor', init() { nativeSpawn(); } };
`;
await fs.writeFile('src/plugins-user/backdoor/index.js', untrustedSource);

await import('../../src/core/security-hardening.js');
const auth = await import('../../src/ui-modules/auth.js');
const { CONFIG } = await import('../../src/core/config-manager.js');
({ default: logger } = await import('../../src/utils/logger.js'));
const { getPluginManager, discoverPlugins, PluginManager } = await import('../../src/core/plugin-manager.js');
const { createRequestHandler } = await import('../../src/handlers/request-handler.js');
const { installPluginFromBuffer, validatePluginArchiveBuffer } = await import('../../src/services/plugin-installer.js');
const { validatePluginExport, validatePluginId } = await import('../../src/core/plugin-security.js');
const token = 'a'.repeat(64);
const tokenFile = path.join(tempDir, 'configs/token-store.json');
async function storeTokens(tokens) {
    await fs.writeFile(tokenFile, JSON.stringify({ tokens }));
}
async function validSession() {
    await storeTokens({ [token]: { username: 'admin', expiryTime: Date.now() + 60000 } });
}
await validSession();
await discoverPlugins();
const manager = getPluginManager();
const config = { UI_ENABLED: false, MODEL_PROVIDER: 'test', REQUIRED_API_KEY: 'not-an-admin-session' };
await manager.initAll(config);
CONFIG.LOGIN_MIN_INTERVAL = 1;
CONFIG.LOGIN_MAX_ATTEMPTS = 5;
server = http.createServer(createRequestHandler(config, null));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function request(url, options = {}) {
    const response = await fetch(origin + url, options);
    return { status: response.status, text: await response.text() };
}
const bearer = value => ({ authorization: `Bearer ${value}` });
const delay = () => new Promise(resolve => setTimeout(resolve, 15));
const toggle = body => request('/api/plugins/probe/toggle', {
    method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify(body)
});

for (const forged of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'prototype']) {
    test(`rejects prototype token ${forged} over HTTP and direct verification`, async () => {
        assert.equal(await auth.verifyToken(forged), null);
        assert.equal((await request('/api/plugins', { headers: bearer(forged) })).status, 401);
        assert.equal((await request('/api/probe/private', { headers: bearer(forged) })).status, 401);
        assert.equal((await request(`/api/probe/private?token=${forged}`)).status, 401);
    });
}

test('rejects malformed stores and token records without coercing expiryTime', async () => {
    for (const value of [null, [], {}, { tokens: null }, { tokens: [] }, { tokens: 'bad' }]) {
        await fs.writeFile(tokenFile, JSON.stringify(value));
        assert.equal(await auth.verifyToken(token), null);
    }
    for (const value of [null, [], {}, true, 'record', { expiryTime: '9999999999999' }, { expiryTime: null }, { expiryTime: {} }, { expiryTime: Date.now() - 1 }]) {
        await storeTokens({ [token]: value });
        assert.equal(await auth.verifyToken(token), null);
    }
    await fs.writeFile(tokenFile, '{invalid json');
    assert.equal(await auth.verifyToken(token), null);
    await validSession();
    assert.equal((await auth.verifyToken(token)).username, 'admin');
});

test('token cleanup removes malformed and prototype-key records, retaining valid sessions', async () => {
    await storeTokens(JSON.parse(`{"${token}":{"expiryTime":${Date.now() + 60000}},"constructor":{},"__proto__":{},"${'b'.repeat(64)}":{"expiryTime":"9999999999999"}}`));
    await auth.cleanupExpiredTokens();
    const saved = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    assert.deepEqual(Object.keys(saved.tokens), [token]);
    await validSession();
});

test('real login still issues a valid session that can use a private plugin route', async () => {
    const result = await request('/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-admin-password' })
    });
    assert.equal(result.status, 200);
    const issued = JSON.parse(result.text).token;
    assert.match(issued, /^[a-f0-9]{64}$/);
    assert.equal((await auth.verifyToken(issued)).username, 'admin');
    assert.equal((await request('/api/probe/private', { headers: bearer(issued) })).status, 200);
});

test('authenticates before plugin execution and static-file dispatch, with UI on or off', async () => {
    globalThis.__privateRouteCalls = 0;
    for (const uiEnabled of [false, true]) {
        config.UI_ENABLED = uiEnabled;
        for (const url of ['/api/probe/private', '/api/probe/private/leak.svg', '/api/unknown']) {
            assert.equal((await request(url)).status, 401);
        }
        assert.equal((await request('/api/probe/private', { headers: bearer(config.REQUIRED_API_KEY) })).status, 401);
    }
    assert.equal(globalThis.__privateRouteCalls, 0);
    config.UI_ENABLED = false;
    const result = await request('/api/probe/private', { headers: bearer(token) });
    assert.equal(result.status, 200);
    assert.equal(result.text, 'private-ok');
    assert.equal(globalThis.__privateRouteCalls, 1);
    assert.equal((await request('/health')).status, 200);
});

test('upload, install and toggle reject unauthenticated and forged requests before consuming payloads', async () => {
    for (const url of ['/api/plugins/upload', '/api/plugins/install', '/api/plugins/probe/toggle']) {
        for (const headers of [{}, bearer('constructor'), bearer('__proto__')]) {
            assert.equal((await request(url, { method: 'POST', headers })).status, 401);
        }
    }
});

test('only explicit host-shipped public routes skip authentication', async () => {
    assert.deepEqual(await request('/api/probe/public'), { status: 200, text: 'explicit-public-ok' });
    assert.equal((await request('/api/probe/public', { method: 'POST' })).status, 401);
    const route = manager.plugins.get('probe').routes[1];
    route.public = false;
    assert.equal((await request('/api/probe/public')).status, 401);
    route.public = true;
});

test('direct route execution also enforces authentication', async () => {
    let status;
    const res = { writeHead(code) { status = code; }, end() {} };
    await manager.executeRoutes('GET', '/api/probe/private', { headers: {}, url: '/api/probe/private' }, res, config);
    assert.equal(status, 401);
});

test('enabled:true on disk cannot execute a user module during discovery or initialization', async () => {
    assert.equal(manager.plugins.get('backdoor')._placeholder, true);
    assert.equal(manager.plugins.get('backdoor')._enabled, false);
    const entry = (await manager.getPluginList()).find(p => p.name === 'backdoor');
    assert.equal(entry.requiresApproval, true);
    assert.match(entry.packageHash, /^[a-f0-9]{64}$/);
    const persisted = JSON.parse(await fs.readFile('configs/plugins.json', 'utf8'));
    assert.equal(persisted.plugins.backdoor.enabled, false);
    await assert.rejects(fs.stat('UNTRUSTED_CODE_EXECUTED'), { code: 'ENOENT' });
    await assert.rejects(manager.setPluginEnabled('backdoor', true), { code: 'PLUGIN_TRUST_REQUIRED' });
    await assert.rejects(manager.loadAndInitPlugin('backdoor'), { code: 'PLUGIN_APPROVAL_REQUIRED' });
    const freshManager = new PluginManager();
    freshManager.registerPlaceholder('backdoor', '', path.join(tempDir, 'src/plugins-user/backdoor'));
    await freshManager.initAll(config);
    assert.equal(freshManager.isEnabled('backdoor'), false);
    await assert.rejects(fs.stat('UNTRUSTED_CODE_EXECUTED'), { code: 'ENOENT' });
    assert.equal((await request('/api/backdoor')).status, 401);
});

test('a fresh process also rejects a legacy enabled:true backdoor before import', async () => {
    await fs.writeFile('configs/plugins.json', JSON.stringify({ plugins: { probe: { enabled: true }, backdoor: { enabled: true } } }));
    const restartPath = path.join(tempDir, 'restart.mjs');
    await fs.writeFile(restartPath, `
        import ${JSON.stringify(new URL('../../src/core/security-hardening.js', import.meta.url).href)};
        import { discoverPlugins, getPluginManager } from ${JSON.stringify(new URL('../../src/core/plugin-manager.js', import.meta.url).href)};
        import logger from ${JSON.stringify(new URL('../../src/utils/logger.js', import.meta.url).href)};
        await discoverPlugins();
        await getPluginManager().initAll({});
        if (getPluginManager().isEnabled('backdoor')) throw new Error('Backdoor reactivated');
        console.log('RESTART_QUARANTINE_OK');
        logger.close();
    `);
    const result = spawnSync(process.execPath, [restartPath], { cwd: tempDir, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESTART_QUARANTINE_OK/);
    await assert.rejects(fs.stat('UNTRUSTED_CODE_EXECUTED'), { code: 'ENOENT' });
    assert.equal(JSON.parse(await fs.readFile('configs/plugins.json', 'utf8')).plugins.backdoor.enabled, false);
});

test('user plugins cannot be registered or reach middleware, auth, routes or hooks', () => {
    const untrusted = { name: 'untrusted', _baseDir: path.join(tempDir, 'src/plugins-user/untrusted'), _enabled: true };
    assert.throws(() => manager.register(untrusted), { code: 'PLUGIN_APPROVAL_REQUIRED' });
    manager.plugins.set('untrusted', untrusted);
    assert.equal(manager.getEnabledPlugins().some(p => p.name === 'untrusted'), false);
    manager.plugins.delete('untrusted');
});

test('upload staging never executes regex-bypass code or replaces installed or built-in code', async () => {
    const zip = new AdmZip();
    zip.addFile('index.js', Buffer.from(untrustedSource));
    const archive = zip.toBuffer();
    validatePluginArchiveBuffer(archive, 'uploaded'); // old blacklist misses it
    await installPluginFromBuffer('uploaded', archive);
    assert.equal(manager.plugins.get('uploaded')._placeholder, true);
    await assert.rejects(manager.setPluginEnabled('uploaded', true), { code: 'PLUGIN_TRUST_REQUIRED' });
    await assert.rejects(installPluginFromBuffer('uploaded', archive), /already exists/);
    await assert.rejects(installPluginFromBuffer('probe', archive), /built-in/);
    assert.equal((await fs.readdir('src/plugins-user')).some(name => name.startsWith('.install-')), false);
    await assert.rejects(fs.stat('UNTRUSTED_CODE_EXECUTED'), { code: 'ENOENT' });
});

test('invalid plugin IDs and public declarations fail closed', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'prototype', '../escape']) {
        assert.throws(() => validatePluginId(id));
    }
    for (const route of [
        { path: '/api/probe', public: 'true' },
        { path: '/api/another', public: true },
        { path: '/api/login', public: true },
        { path: '/api/probe/../config' }
    ]) {
        assert.throws(() => validatePluginExport({ name: 'probe', routes: [{ method: 'GET', handler() {}, ...route }] }, 'probe'));
    }
});

test('plugin enable requires a current admin password, disable does not', async () => {
    await validSession();
    assert.equal((await toggle({ enabled: true })).status, 403);
    await delay();
    assert.equal((await toggle({ enabled: true, password: 'incorrect' })).status, 403);
    await delay();
    assert.equal((await toggle({ enabled: true, password: 'test-admin-password' })).status, 200);
    assert.equal((await toggle({ enabled: false })).status, 200);
    assert.equal((await request('/api/probe/private', { headers: bearer(token) })).status, 503);
    assert.equal((await request('/api/probe/private')).status, 401);
    await delay();
    assert.equal((await toggle({ enabled: true, password: 'test-admin-password' })).status, 200);
    await delay();
    const blocked = await request('/api/plugins/backdoor/toggle', {
        method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, password: 'test-admin-password' })
    });
    assert.equal(blocked.status, 403);
    assert.equal(JSON.parse(blocked.text).error.code, 'PLUGIN_TRUST_REQUIRED');
    await assert.rejects(fs.stat('UNTRUSTED_CODE_EXECUTED'), { code: 'ENOENT' });
});

const trustedName = 'trusted-demo';
const trustedImportsFile = 'configs/trusted-demo-imports.txt';
const trustedInitsFile = 'configs/trusted-demo-inits.txt';
let approvedHash;
async function userToggle(body) {
    await delay();
    return request(`/api/plugins/${trustedName}/toggle`, {
        method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
}
async function trustedEntry() {
    const response = await request('/api/plugins', { headers: bearer(token) });
    assert.equal(response.status, 200);
    return JSON.parse(response.text).plugins.find(plugin => plugin.name === trustedName);
}

// New imports, helper modules, fs and child_process must work after explicit trust.
// All side effects here are confined to the temporary test directory.
test('authenticated ZIP upload installs a normal Node plugin without executing it', async () => {
    const zip = new AdmZip();
    zip.addFile('helper.js', Buffer.from(`export const message = 'approved-v1';`));
    zip.addFile('index.js', Buffer.from(`
        import { appendFileSync } from 'node:fs';
        import { execFileSync } from 'node:child_process';
        import { message } from './helper.js';
        appendFileSync('${trustedImportsFile}', 'import\\n');
        const commandResult = execFileSync(process.execPath, ['-e', 'process.stdout.write("trusted-node-ok")'], { encoding: 'utf8' });
        export default {
            name: '${trustedName}', version: '1.0.0',
            description: 'An explicitly administrator-trusted extension',
            init() { appendFileSync('${trustedInitsFile}', 'init\\n'); },
            middleware() { return { handled: false, data: { trustedMessage: message } }; },
            hooks: { onContentGenerated(event) { globalThis.__trustedHookModel = event.model; } },
            routes: [{ method: 'GET', path: '/api/${trustedName}', public: true,
                handler(method, path, req, res) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message, commandResult })); return true;
                }
            }]
        };
    `));
    const form = new FormData();
    form.append('file', new Blob([zip.toBuffer()], { type: 'application/zip' }), `${trustedName}.zip`);
    const uploaded = await request('/api/plugins/upload', { method: 'POST', headers: bearer(token), body: form });
    assert.equal(uploaded.status, 200, uploaded.text);
    const entry = await trustedEntry();
    assert.equal(entry.enabled, false);
    assert.equal(entry.requiresApproval, true);
    assert.equal(entry.trustMode, 'admin-approved');
    approvedHash = entry.packageHash;
    await assert.rejects(fs.stat(trustedImportsFile), { code: 'ENOENT' });
    await assert.rejects(fs.stat(trustedInitsFile), { code: 'ENOENT' });
});

test('password alone, a non-boolean trust flag, and a stale hash cannot authorize a user plugin', async () => {
    const password = 'test-admin-password';
    for (const body of [
        { enabled: true, password },
        { enabled: true, password, trust: 'true', packageHash: approvedHash },
        { enabled: true, password, trust: true }
    ]) {
        const response = await userToggle(body);
        assert.equal(response.status, 403, response.text);
        assert.equal(JSON.parse(response.text).error.code, 'PLUGIN_TRUST_REQUIRED');
    }
    const stale = await userToggle({ enabled: true, password, trust: true, packageHash: '0'.repeat(64) });
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(stale.text).error.code, 'PLUGIN_PACKAGE_CHANGED');
    const wrongPassword = await userToggle({ enabled: true, password: 'wrong', trust: true, packageHash: approvedHash });
    assert.equal(wrongPassword.status, 403);
    await assert.rejects(fs.stat(trustedImportsFile), { code: 'ENOENT' });
});

test('explicit password + trust + matching hash enables the plugin with normal Node privileges', async () => {
    const response = await userToggle({ enabled: true, password: 'test-admin-password', trust: true, packageHash: approvedHash });
    assert.equal(response.status, 200, response.text);
    assert.equal(await fs.readFile(trustedImportsFile, 'utf8'), 'import\n');
    assert.equal(await fs.readFile(trustedInitsFile, 'utf8'), 'init\n');
    const entry = await trustedEntry();
    assert.equal(entry.enabled, true);
    assert.equal(entry.requiresApproval, false);
    const saved = JSON.parse(await fs.readFile('configs/plugins.json', 'utf8'));
    assert.equal(saved.plugins[trustedName].approval.sha256, approvedHash);
    assert.equal(saved.plugins[trustedName].approval.mode, 'admin-approved');
    assert.equal(JSON.stringify(saved).includes('test-admin-password'), false);
    assert.equal((await request(`/api/${trustedName}`)).status, 401); // public:true cannot opt a user plugin out
    const routed = await request(`/api/${trustedName}`, { headers: bearer(token) });
    assert.equal(routed.status, 200);
    assert.deepEqual(JSON.parse(routed.text), { message: 'approved-v1', commandResult: 'trusted-node-ok' });
    const current = {};
    await manager.executeMiddleware({}, {}, new URL('http://localhost/v1/models'), current);
    assert.equal(current.trustedMessage, 'approved-v1');
    await manager.executeHook('onContentGenerated', { model: 'test-model' });
    assert.equal(globalThis.__trustedHookModel, 'test-model');
});

async function restartAndCheck(expectedEnabled, marker, { approveHash = null, expectedMessage = 'approved-v1' } = {}) {
    const restartPath = path.join(tempDir, 'approved-restart.mjs');
    await fs.writeFile(restartPath, `
        import ${JSON.stringify(new URL('../../src/core/security-hardening.js', import.meta.url).href)};
        import assert from 'node:assert/strict';
        import http from 'node:http';
        import { discoverPlugins, getPluginManager } from ${JSON.stringify(new URL('../../src/core/plugin-manager.js', import.meta.url).href)};
        import { createRequestHandler } from ${JSON.stringify(new URL('../../src/handlers/request-handler.js', import.meta.url).href)};
        import logger from ${JSON.stringify(new URL('../../src/utils/logger.js', import.meta.url).href)};
        await discoverPlugins();
        const manager = getPluginManager();
        await manager.initAll({ UI_ENABLED: false, MODEL_PROVIDER: 'test' });
        assert.equal(manager.isEnabled('${trustedName}'), ${expectedEnabled});
        const server = http.createServer(createRequestHandler({ UI_ENABLED: false, MODEL_PROVIDER: 'test' }, null));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        const denied = await fetch(origin + '/api/${trustedName}');
        assert.equal(denied.status, 401); await denied.text();
        if (${Boolean(approveHash)}) {
            const response = await fetch(origin + '/api/plugins/${trustedName}/toggle', {
                method: 'POST', headers: { authorization: 'Bearer ${token}', 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: true, password: 'test-admin-password', trust: true, packageHash: ${JSON.stringify(approveHash)} })
            });
            const responseText = await response.text();
            assert.equal(response.status, 200, responseText);
        }
        if (${expectedEnabled || Boolean(approveHash)}) {
            const allowed = await fetch(origin + '/api/${trustedName}', { headers: { authorization: 'Bearer ${token}' } });
            assert.equal(allowed.status, 200); assert.equal((await allowed.json()).message, ${JSON.stringify(expectedMessage)});
        }
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        logger.close();
        console.log('${marker}');
    `);
    const result = spawnSync(process.execPath, [restartPath], { cwd: tempDir, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, new RegExp(marker));
}

test('unchanged approved packages load after a real restart and their routes remain authenticated', async () => {
    await restartAndCheck(true, 'APPROVED_RESTART_OK');
    assert.equal(await fs.readFile(trustedImportsFile, 'utf8'), 'import\nimport\n');
});

test('disabling needs no password; re-enabling still needs fresh consent and reuses only the same package', async () => {
    assert.equal((await userToggle({ enabled: false })).status, 200);
    assert.equal((await request(`/api/${trustedName}`, { headers: bearer(token) })).status, 503);
    const missingConsent = await userToggle({ enabled: true, password: 'test-admin-password' });
    assert.equal(missingConsent.status, 403);
    const enabled = await userToggle({ enabled: true, password: 'test-admin-password', trust: true, packageHash: approvedHash });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(await fs.readFile(trustedImportsFile, 'utf8'), 'import\nimport\n'); // no duplicate top-level import
});

test('changing a dependency invalidates approval; legacy enabled:true cannot reactivate it', async () => {
    assert.equal((await userToggle({ enabled: false })).status, 200);
    await fs.writeFile(`src/plugins-user/${trustedName}/helper.js`, `export const message = 'changed-v2';`);
    const entry = await trustedEntry();
    assert.notEqual(entry.packageHash, approvedHash);
    assert.equal(entry.requiresApproval, true);
    const stale = await userToggle({ enabled: true, password: 'test-admin-password', trust: true, packageHash: approvedHash });
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(stale.text).error.code, 'PLUGIN_PACKAGE_CHANGED');
    const hotUpdate = await userToggle({ enabled: true, password: 'test-admin-password', trust: true, packageHash: entry.packageHash });
    assert.equal(hotUpdate.status, 409);
    assert.equal(JSON.parse(hotUpdate.text).error.code, 'PLUGIN_RESTART_REQUIRED');
    const saved = JSON.parse(await fs.readFile('configs/plugins.json', 'utf8'));
    saved.plugins[trustedName].enabled = true; // stale enabled flag with the OLD approval
    await fs.writeFile('configs/plugins.json', JSON.stringify(saved));
    await restartAndCheck(false, 'CHANGED_PACKAGE_BLOCKED');
    assert.equal(await fs.readFile(trustedImportsFile, 'utf8'), 'import\nimport\n');
    assert.equal(JSON.parse(await fs.readFile('configs/plugins.json', 'utf8')).plugins[trustedName].enabled, false);
});

test('failed initialization never persists a successful approval or enabled state', async () => {
    const name = 'failing-init';
    const zip = new AdmZip();
    zip.addFile('index.js', Buffer.from(`
        import { writeFileSync } from 'node:fs';
        writeFileSync('configs/failing-plugin-was-approved.txt', 'top-level code ran after consent');
        export default { name: '${name}', init() { throw new Error('intentional init failure'); } };
    `));
    await installPluginFromBuffer(name, zip.toBuffer());
    const entry = (await manager.getPluginList()).find(plugin => plugin.name === name);
    await delay();
    const response = await request(`/api/plugins/${name}/toggle`, {
        method: 'POST', headers: { ...bearer(token), 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, password: 'test-admin-password', trust: true, packageHash: entry.packageHash })
    });
    assert.equal(response.status, 500);
    assert.equal(manager.isEnabled(name), false);
    const saved = JSON.parse(await fs.readFile('configs/plugins.json', 'utf8')).plugins[name];
    assert.equal(saved.enabled, false);
    assert.equal(saved.approval, undefined);
    // Consent authorizes top-level execution; a later init failure cannot undo it.
    assert.equal(await fs.readFile('configs/failing-plugin-was-approved.txt', 'utf8'), 'top-level code ran after consent');
});

test('changed packages can be explicitly approved and loaded after restart', async () => {
    const hash = (await trustedEntry()).packageHash;
    await restartAndCheck(false, 'REAPPROVED_AFTER_RESTART', { approveHash: hash, expectedMessage: 'changed-v2' });
    const saved = JSON.parse(await fs.readFile('configs/plugins.json', 'utf8')).plugins[trustedName];
    assert.equal(saved.enabled, true);
    assert.equal(saved.approval.sha256, hash);
    assert.equal(await fs.readFile(trustedImportsFile, 'utf8'), 'import\nimport\nimport\n');
});

test('reauthentication shares login brute-force lockout', async () => {
    CONFIG.LOGIN_MAX_ATTEMPTS = 1;
    await delay();
    assert.equal((await toggle({ enabled: true, password: 'incorrect' })).status, 403);
    await delay();
    assert.equal((await toggle({ enabled: true, password: 'test-admin-password' })).status, 429);
});
