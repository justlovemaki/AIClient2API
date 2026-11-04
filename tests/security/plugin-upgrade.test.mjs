import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import axios from 'axios';

// Exercise the real Git/tarball updater against disposable applications.
// Only HTTP is stubbed: archives are real tar.gz files and no remote repository,
// npm install, live service, production config or real signing key is touched.
const originalCwd = process.cwd();
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient2api-upgrade-'));
process.chdir(workspace);
const { performUpdate } = await import('../../src/ui-modules/update-api.js');
const { createPluginApproval, getPluginPackageHash, verifyPluginApproval } = await import('../../src/core/plugin-trust.js');
const { default: logger } = await import('../../src/utils/logger.js');
logger.close();
logger.initialize({ outputMode: 'console' });
const originalRequest = axios.request;
const originalCopyFile = fs.copyFile;
const packageJson = JSON.stringify({ name: 'upgrade-fixture', version: '1.0.0', type: 'module' }) + '\n';
const pluginName = 'upgrade-plugin';
const hasTar = spawnSync('tar', ['--version'], { encoding: 'utf8' }).status === 0;
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
let app, buildDir, requests;
beforeEach(async () => {
    app = await fs.mkdtemp(path.join(workspace, 'app-'));
    buildDir = await fs.mkdtemp(path.join(workspace, 'release-'));
    process.chdir(app);
    for (const dir of ['configs', 'src/plugins-user/' + pluginName, 'static']) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile('VERSION', '1.0.0');
    await fs.writeFile('package.json', packageJson);
    await fs.writeFile('.gitignore', 'configs/\n.private/\nsrc/plugins-user/\nlogs/\n.update_temp/\n');
    await fs.writeFile('src/server.js', '// original host code\n');
    await fs.writeFile('static/old.txt', 'old static');
    await fs.writeFile('configs/pwd', 'unchanged-admin-password');
    await fs.writeFile('src/plugins-user/' + pluginName + '/index.js', `
        import { writeFileSync } from 'node:fs';
        writeFileSync('configs/PLUGIN_LOADED_AFTER_UPGRADE', 'preserved-user-code');
        export default { name: '${pluginName}' };
    `);
    requests = [];
});
afterEach(async () => {
    axios.request = originalRequest;
    fs.copyFile = originalCopyFile;
    process.chdir(workspace);
    await fs.rm(app, { recursive: true, force: true });
    await fs.rm(buildDir, { recursive: true, force: true });
});
after(async () => {
    axios.request = originalRequest;
    fs.copyFile = originalCopyFile;
    logger.close();
    process.chdir(originalCwd);
    await fs.rm(workspace, { recursive: true, force: true });
});

async function approveCurrentPackage() {
    const dir = path.join(app, 'src/plugins-user', pluginName);
    const hash = await getPluginPackageHash(dir);
    const approval = await createPluginApproval(pluginName, hash);
    await fs.writeFile('configs/plugins.json', JSON.stringify({ plugins: { [pluginName]: { enabled: true, approval } } }));
    await fs.writeFile('.private/upgrade-sentinel.txt', 'private state must survive');
    return { hash, approval, key: await fs.readFile('.private/plugin-approval.key'), config: await fs.readFile('configs/plugins.json') };
}

async function makeArchive({ privateName = '.private', failCopy = false } = {}) {
    const name = 'AIClient2API-9.9.9';
    const release = path.join(buildDir, name);
    for (const dir of ['src', 'static', 'configs', privateName]) await fs.mkdir(path.join(release, dir), { recursive: true });
    await fs.writeFile(path.join(release, 'VERSION'), '9.9.9');
    await fs.writeFile(path.join(release, 'package.json'), packageJson); // never run npm install
    await fs.writeFile(path.join(release, 'src/server.js'), '// upgraded host code\n');
    await fs.writeFile(path.join(release, 'static/new.txt'), 'new static');
    await fs.writeFile(path.join(release, 'configs/pwd'), 'must-not-replace-local-password');
    await fs.writeFile(path.join(release, privateName, 'plugin-approval.key'), '0'.repeat(64));
    if (failCopy) await fs.writeFile(path.join(release, 'zzz-copy-failure.txt'), 'trigger controlled copy failure');
    const archive = path.join(buildDir, 'release.tar.gz');
    execFileSync('tar', ['-czf', 'release.tar.gz', name], { cwd: buildDir, encoding: 'utf8' });
    return fs.readFile(archive);
}

function mockDownloads(archive) {
    axios.request = async options => {
        requests.push(options.url);
        if (options.url.endsWith('.tar.gz')) {
            return { status: 200, statusText: 'OK', data: archive };
        }
        if (options.url.endsWith('/tags')) {
            return { status: 200, statusText: 'OK', data: Buffer.from(JSON.stringify([{ name: 'v9.9.9' }])) };
        }
        throw new Error('Unexpected network request in upgrade test: ' + options.url);
    };
}

async function assertStatePreserved(before) {
    assert.deepEqual(await fs.readFile('.private/plugin-approval.key'), before.key);
    assert.equal(await fs.readFile('.private/upgrade-sentinel.txt', 'utf8'), 'private state must survive');
    assert.deepEqual(await fs.readFile('configs/plugins.json'), before.config);
    assert.equal(await fs.readFile('configs/pwd', 'utf8'), 'unchanged-admin-password');
    assert.equal(await verifyPluginApproval(path.join(app, 'src/plugins-user', pluginName), before.approval), before.hash);
}

async function restartAndCheck({ legacy = false } = {}) {
    const entry = path.join(buildDir, 'restart-check.mjs');
    await fs.writeFile(entry, `
        import assert from 'node:assert/strict';
        import { promises as fs } from 'node:fs';
        import path from 'node:path';
        import { PluginManager } from ${JSON.stringify(new URL('../../src/core/plugin-manager.js', import.meta.url).href)};
        import { getPluginPackageHash } from ${JSON.stringify(new URL('../../src/core/plugin-trust.js', import.meta.url).href)};
        import logger from ${JSON.stringify(new URL('../../src/utils/logger.js', import.meta.url).href)};
        const manager = new PluginManager();
        const dir = path.join(process.cwd(), 'src/plugins-user/${pluginName}');
        manager.registerPlaceholder('${pluginName}', '', dir);
        await manager.initAll({});
        assert.equal(manager.isEnabled('${pluginName}'), ${!legacy});
        if (${legacy}) {
            await assert.rejects(fs.stat('.private'), {code:'ENOENT'});
            await assert.rejects(fs.stat('configs/PLUGIN_LOADED_AFTER_UPGRADE'), {code:'ENOENT'});
            // Manager call made only after password + consent verification by the API.
            await manager.setPluginEnabled('${pluginName}', true, {trust:true, packageHash:await getPluginPackageHash(dir)});
            assert.equal(manager.isEnabled('${pluginName}'), true);
        }
        assert.equal(await fs.readFile('configs/PLUGIN_LOADED_AFTER_UPGRADE','utf8'), 'preserved-user-code');
        logger.close();
        console.log('UPGRADE_RESTART_OK');
    `);
    const result = spawnSync(process.execPath, [entry], { cwd: app, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /UPGRADE_RESTART_OK/);
}

for (const privateName of ['.private', '.PRIVATE']) {
    test(`tarball upgrade preserves signing state even if the archive contains ${privateName}`, { skip: !hasTar && 'tar executable is required' }, async () => {
        const before = await approveCurrentPackage();
        mockDownloads(await makeArchive({ privateName }));
        const result = await performUpdate('v9.9.9');
        assert.equal(result.success, true);
        assert.equal(result.updateMethod, 'tarball');
        assert.equal(result.needsNpmInstall, false);
        assert.equal(requests.length, 2); // mocked tag list + archive, never real network
        await assertStatePreserved(before);
        assert.deepEqual((await fs.readdir(app)).filter(name => name.toLowerCase() === '.private'), ['.private']);
        assert.equal(await fs.readFile('src/server.js', 'utf8'), '// upgraded host code\n');
        await assert.rejects(fs.stat('static/old.txt'), { code: 'ENOENT' });
        assert.equal(await fs.readFile('static/new.txt', 'utf8'), 'new static');
        await assert.rejects(fs.stat('.update_temp'), { code: 'ENOENT' });
        await restartAndCheck();
    });
}

test('first upgrade never installs a packaged key or silently approves legacy enabled plugins', { skip: !hasTar && 'tar executable is required' }, async () => {
    await fs.writeFile('configs/plugins.json', JSON.stringify({ plugins: { [pluginName]: { enabled: true } } }));
    mockDownloads(await makeArchive());
    await performUpdate('v9.9.9');
    await assert.rejects(fs.stat('.private'), { code: 'ENOENT' });
    await restartAndCheck({ legacy: true });
    assert.notEqual(await fs.readFile('.private/plugin-approval.key', 'utf8'), '0'.repeat(64));
});

test('failed tarball copy leaves private state intact and restores the backed-up user package', { skip: !hasTar && 'tar executable is required' }, async () => {
    const before = await approveCurrentPackage();
    mockDownloads(await makeArchive({ failCopy: true }));
    fs.copyFile = async (source, destination, ...args) => {
        if (path.basename(source) === 'zzz-copy-failure.txt') throw Object.assign(new Error('simulated copy failure'), { code: 'EACCES' });
        return originalCopyFile(source, destination, ...args);
    };
    await assert.rejects(performUpdate('v9.9.9'), /simulated copy failure/);
    await assertStatePreserved(before);
    await assert.rejects(fs.stat('.update_temp'), { code: 'ENOENT' });
});

async function prepareGitFixture() {
    const git = args => execFileSync('git', args, { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init']);
    git(['config', 'user.name', 'Upgrade test']);
    git(['config', 'user.email', 'upgrade-test@example.invalid']);
    git(['config', 'commit.gpgSign', 'false']);
    git(['config', 'core.autocrlf', 'false']);
    const hooks = path.join(buildDir, 'empty-hooks');
    await fs.mkdir(hooks);
    git(['config', 'core.hooksPath', hooks]);
    git(['add', '.gitignore', 'package.json', 'VERSION', 'src/server.js']);
    git(['commit', '-m', 'fixture v1']);
    git(['tag', 'v1.0.0']);
    await fs.writeFile('VERSION', '2.0.0');
    await fs.writeFile('src/server.js', '// git-upgraded host code\n');
    git(['add', 'VERSION', 'src/server.js']);
    git(['commit', '-m', 'fixture v2']);
    git(['tag', 'v2.0.0']);
    git(['checkout', 'v1.0.0']);
    git(['remote', 'add', 'origin', app]); // fetch only from this disposable local repository
    axios.request = async () => { throw new Error('Git upgrade must not access HTTP'); };
    return git;
}

test('Git checkout upgrade preserves ignored signing state and existing approvals without network access', { skip: !hasGit && 'git executable is required' }, async () => {
    const before = await approveCurrentPackage();
    const git = await prepareGitFixture();
    assert.equal(git(['ls-files', '.private']).trim(), '');
    const result = await performUpdate('v2.0.0');
    assert.equal(result.success, true);
    assert.equal(result.updateMethod, 'git');
    await assertStatePreserved(before);
    assert.equal(await fs.readFile('VERSION', 'utf8'), '2.0.0');
    assert.equal(await fs.readFile('src/server.js', 'utf8'), '// git-upgraded host code\n');
});

test('Git updater rejects tags that track private state before checkout can overwrite the local key', { skip: !hasGit && 'git executable is required' }, async () => {
    const before = await approveCurrentPackage();
    const git = await prepareGitFixture();
    git(['checkout', 'v2.0.0']);
    await fs.writeFile('.private/plugin-approval.key', '0'.repeat(64));
    git(['add', '-f', '.private/plugin-approval.key']);
    git(['commit', '-m', 'fixture release accidentally containing private state']);
    git(['tag', 'v3.0.0']);
    git(['checkout', 'v1.0.0']);
    await fs.mkdir('.private', { recursive: true });
    await fs.writeFile('.private/plugin-approval.key', before.key, { mode: 0o600 });
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    await assert.rejects(performUpdate('v3.0.0'), /target version contains instance-private state/);
    assert.equal(git(['rev-parse', 'HEAD']).trim(), headBefore);
    await assertStatePreserved(before);
    assert.equal(await fs.readFile('VERSION', 'utf8'), '1.0.0');
});

test('public quickstarts and Compose examples include private-state persistence and a migration notice', async () => {
    for (const name of ['README.md', 'README-ZH.md', 'README-JA.md']) {
        const content = await fs.readFile(new URL('../../' + name, import.meta.url), 'utf8');
        assert.match(content, /UPGRADING_PLUGIN_TRUST\.md/);
        assert.match(content, /PLUGIN_PAGE_AUTH_MIGRATION\.md/);
        assert.match(content, /2026\.11\.04 \(v3\.6\.5/);
        assert.doesNotMatch(content, /待发布|Unreleased|次回リリース/);
        assert.match(content, /docker run [^\r\n]*-v "[^"\r\n]+\/\.private:\/app\/\.private"/);
    }
    for (const name of ['docker-compose.yml', 'docker-compose.build.yml', 'docker-compose.dev.yml']) {
        const content = await fs.readFile(new URL('../../docker/' + name, import.meta.url), 'utf8');
        assert.match(content, /\/\.private:\/app\/\.private/);
    }
    const guide = await fs.readFile(new URL('../../docs/UPGRADING_PLUGIN_TRUST.md', import.meta.url), 'utf8');
    assert.match(guide, /v3\.6\.5 已发布/);
    assert.doesNotMatch(guide, /版本发布时/);
    assert.match(guide, /\.private\/plugin-approval\.key/);
    assert.match(guide, /docker cp/);
    assert.match(guide, /enabled:false/);
    assert.match(guide, /PLUGIN_PAGE_AUTH_MIGRATION\.md/);
    const pageGuide = await fs.readFile(new URL('../../docs/PLUGIN_PAGE_AUTH_MIGRATION.md', import.meta.url), 'utf8');
    assert.match(pageGuide, /createPluginApi/);
    assert.match(pageGuide, /fetch\('\/api\/my-plugin'\)/);
    assert.match(pageGuide, /401/);
    assert.match(pageGuide, /PLUGIN_RESTART_REQUIRED/);
});
