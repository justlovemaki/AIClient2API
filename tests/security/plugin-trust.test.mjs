import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginApproval, getPluginPackageHash, isValidPluginApproval, verifyPluginApproval } from '../../src/core/plugin-trust.js';

let base, root, keyFile;
beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient2api-trust-'));
    root = path.join(base, 'plugin');
    keyFile = path.join(base, '.private', 'plugin-approval.key');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'index.js'), 'export default {};');
});
afterEach(async () => fs.rm(base, { recursive: true, force: true }));
const approval = sha256 => createPluginApproval('plugin', sha256, { keyFile });

test('content hashing is deterministic and ignores timestamp-only changes', async () => {
    const first = await getPluginPackageHash(root);
    assert.match(first, /^[a-f0-9]{64}$/);
    await fs.utimes(path.join(root, 'index.js'), new Date(0), new Date(0));
    assert.equal(await getPluginPackageHash(root), first);
    assert.equal(await verifyPluginApproval(root, await approval(first), { keyFile }), first);
});

test('same-size, same-timestamp dependency changes still invalidate approval', async () => {
    const helper = path.join(root, 'helper.js');
    await fs.writeFile(helper, 'export const value = 1;');
    const first = await getPluginPackageHash(root);
    const stat = await fs.stat(helper);
    await fs.writeFile(helper, 'export const value = 2;');
    await fs.utimes(helper, stat.atime, stat.mtime);
    assert.notEqual(await getPluginPackageHash(root), first);
    await assert.rejects(verifyPluginApproval(root, await approval(first), { keyFile }), { code: 'PLUGIN_PACKAGE_CHANGED' });
});

test('filenames, assets, additions and removals are covered by approval', async () => {
    const asset = path.join(root, 'page.html');
    const first = await getPluginPackageHash(root);
    await fs.writeFile(asset, '<p>page</p>');
    const second = await getPluginPackageHash(root);
    assert.notEqual(second, first);
    await fs.rename(asset, path.join(root, 'other.html'));
    assert.notEqual(await getPluginPackageHash(root), second);
    await fs.rm(path.join(root, 'other.html'));
    assert.equal(await getPluginPackageHash(root), first);
});

test('legacy or malformed approval records fail closed', async () => {
    const valid = await approval(await getPluginPackageHash(root));
    assert.equal(isValidPluginApproval(valid), true);
    for (const value of [null, [], {}, true, 'approved', { sha256: valid.sha256 },
        { ...valid, version: 1 }, { ...valid, mode: 'unrestricted' }, { ...valid, sha256: 'x'.repeat(64) },
        { ...valid, approvedAt: 'invalid date' }]) {
        assert.equal(isValidPluginApproval(value), false);
        await assert.rejects(verifyPluginApproval(root, value, { keyFile }), { code: 'PLUGIN_APPROVAL_REQUIRED' });
    }
});

test('hard-linked package files cannot hide dependencies outside the package', async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient2api-external-'));
    try {
        const source = path.join(external, 'outside.js');
        await fs.writeFile(source, 'export default {};');
        await fs.link(source, path.join(root, 'linked.js'));
        await assert.rejects(getPluginPackageHash(root), { code: 'PLUGIN_PACKAGE_INVALID' });
    } finally {
        await fs.rm(external, { recursive: true, force: true });
    }
});

test('directory links are rejected rather than approving code outside the package', async () => {
    await fs.mkdir(path.join(root, 'directory'));
    await fs.symlink(path.join(root, 'directory'), path.join(root, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(getPluginPackageHash(root), { code: 'PLUGIN_PACKAGE_INVALID' });
});

test('oversized packages fail before import or approval', async () => {
    await fs.writeFile(path.join(root, 'oversized.bin'), Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(getPluginPackageHash(root), { code: 'PLUGIN_PACKAGE_INVALID' });
});

test('approval signatures bind every approval field and the plugin identity', async () => {
    const hash = await getPluginPackageHash(root);
    const valid = await approval(hash);
    assert.equal(valid.version, 2);
    assert.match(valid.signature, /^[a-f0-9]{64}$/);
    for (const forged of [
        { ...valid, sha256: 'b'.repeat(64) },
        { ...valid, approvedAt: new Date(0).toISOString() },
        { ...valid, signature: '0'.repeat(64) }
    ]) {
        await assert.rejects(verifyPluginApproval(root, forged, { keyFile }), { code: 'PLUGIN_APPROVAL_REQUIRED' });
    }
    const copied = path.join(base, 'another-plugin');
    await fs.cp(root, copied, { recursive: true });
    assert.equal(await getPluginPackageHash(copied), hash);
    await assert.rejects(verifyPluginApproval(copied, valid, { keyFile }), { code: 'PLUGIN_APPROVAL_REQUIRED' });
});

test('a missing or corrupt key cannot validate receipts and is never silently regenerated during verification', async () => {
    const valid = await approval(await getPluginPackageHash(root));
    await fs.unlink(keyFile);
    await assert.rejects(verifyPluginApproval(root, valid, { keyFile }), { code: 'PLUGIN_APPROVAL_REQUIRED' });
    await assert.rejects(fs.stat(keyFile), { code: 'ENOENT' });
    await fs.writeFile(keyFile, JSON.stringify({ key: 'chosen-by-attacker' }));
    await assert.rejects(verifyPluginApproval(root, valid, { keyFile }), { code: 'PLUGIN_APPROVAL_REQUIRED' });
    await assert.rejects(approval(await getPluginPackageHash(root)));
    assert.equal(await fs.readFile(keyFile, 'utf8'), JSON.stringify({ key: 'chosen-by-attacker' }));
});
