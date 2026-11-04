import { promises as fs, constants } from 'fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import path from 'path';
import { assertPathInside, validatePluginId } from './plugin-security.js';
import { withFileLock } from '../utils/file-lock.js';

export const PLUGIN_TRUST_MODE = 'admin-approved';
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_FILES = 1000;

export function pluginTrustError(code, message, status = 403) {
    return Object.assign(new Error(message), { code, status });
}

export function isValidPluginApproval(approval) {
    return approval !== null && typeof approval === 'object' && !Array.isArray(approval) &&
        ['version', 'mode', 'sha256', 'approvedAt', 'signature'].every(key => Object.hasOwn(approval, key)) &&
        approval.version === 2 && approval.mode === PLUGIN_TRUST_MODE &&
        typeof approval.sha256 === 'string' && /^[a-f0-9]{64}$/.test(approval.sha256) &&
        typeof approval.approvedAt === 'string' && Number.isFinite(Date.parse(approval.approvedAt)) &&
        typeof approval.signature === 'string' && /^[a-f0-9]{64}$/.test(approval.signature);
}

// Keep the signing key OUTSIDE configs/: that directory can be exported through
// management APIs. No env/config request field can select or replace this key.
// keyFile is an internal dependency-injection option for isolated unit tests.
async function readApprovalKey(keyFile, create) {
    return withFileLock(keyFile, async () => {
        const keyDir = path.dirname(keyFile);
        if (create) await fs.mkdir(keyDir, { recursive: true, mode: 0o700 });
        const directory = await fs.lstat(keyDir);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid plugin approval key directory');
        if (create) {
            let handle;
            try {
                handle = await fs.open(keyFile, 'wx', 0o600);
                await handle.writeFile(randomBytes(32).toString('hex'), 'utf8');
                await handle.sync();
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            } finally {
                await handle?.close();
            }
        }
        const handle = await fs.open(keyFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const stat = await handle.stat();
            const linkInfo = await fs.lstat(keyFile);
            if (!stat.isFile() || linkInfo.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 64) throw new Error('Invalid plugin approval key file');
            const key = await handle.readFile('utf8');
            if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid plugin approval key format');
            return Buffer.from(key, 'hex');
        } finally {
            await handle.close();
        }
    });
}

function defaultKeyFile() {
    return path.join(process.cwd(), '.private', 'plugin-approval.key');
}

function signApproval(pluginId, approval, key) {
    return createHmac('sha256', key).update(JSON.stringify([
        approval.version, approval.mode, pluginId, approval.sha256, approval.approvedAt
    ])).digest('hex');
}

export async function createPluginApproval(pluginId, sha256, { keyFile = defaultKeyFile() } = {}) {
    validatePluginId(pluginId);
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid package digest');
    const key = await readApprovalKey(keyFile, true);
    const approval = { version: 2, mode: PLUGIN_TRUST_MODE, sha256, approvedAt: new Date().toISOString() };
    approval.signature = signApproval(pluginId, approval, key);
    return approval;
}

/** Fingerprint the whole package, not just index.js. This is an approval check,
 * not a sandbox, code signature, or protection against an already-trusted plugin.
 * Local dependencies outside this directory remain part of the trusted host.
 */
export async function getPluginPackageHash(pluginDir) {
    const root = path.resolve(pluginDir);
    const rootInfo = await fs.lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw pluginTrustError('PLUGIN_PACKAGE_INVALID', 'Plugin package must be a real directory', 400);
    }
    const physicalRoot = await fs.realpath(root);
    const files = [];
    let totalBytes = 0;
    async function walk(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            const file = path.join(directory, entry.name);
            const info = await fs.lstat(file);
            if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || info.nlink > 1 && info.isFile()) {
                throw pluginTrustError('PLUGIN_PACKAGE_INVALID', 'Plugin packages cannot contain links or special files', 400);
            }
            assertPathInside(physicalRoot, await fs.realpath(file));
            if (info.isDirectory()) {
                await walk(file);
            } else {
                if (files.length >= MAX_PACKAGE_FILES || (totalBytes += info.size) > MAX_PACKAGE_BYTES) {
                    throw pluginTrustError('PLUGIN_PACKAGE_INVALID', 'Plugin package exceeds approval size limits', 400);
                }
                files.push({ file, size: info.size, mtimeMs: info.mtimeMs });
            }
        }
    }
    await walk(root);
    const hash = createHash('sha256');
    for (const { file, size, mtimeMs } of files) {
        const content = await fs.readFile(file);
        const after = await fs.lstat(file);
        if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 || content.length !== size || after.size !== size || after.mtimeMs !== mtimeMs) {
            throw pluginTrustError('PLUGIN_PACKAGE_CHANGED', 'Plugin package changed while being checked; refresh and approve again', 409);
        }
        const relative = path.relative(root, file).split(path.sep).join('/');
        hash.update(JSON.stringify([relative, content.length]) + '\n');
        hash.update(content);
    }
    return hash.digest('hex');
}

export async function verifyPluginApprovalSignature(pluginId, approval, { keyFile = defaultKeyFile() } = {}) {
    if (!isValidPluginApproval(approval)) {
        throw pluginTrustError('PLUGIN_APPROVAL_REQUIRED', 'Explicit administrator approval is required before loading this plugin');
    }
    let key;
    try {
        key = await readApprovalKey(keyFile, false);
    } catch {
        throw pluginTrustError('PLUGIN_APPROVAL_REQUIRED', 'Approval signing key is unavailable; approve this package again');
    }
    const expected = signApproval(pluginId, approval, key);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(approval.signature, 'hex'))) {
        throw pluginTrustError('PLUGIN_APPROVAL_REQUIRED', 'Plugin approval signature is invalid; approve this package again');
    }
    return true;
}

export async function verifyPluginApproval(pluginDir, approval, options) {
    await verifyPluginApprovalSignature(path.basename(path.resolve(pluginDir)), approval, options);
    const sha256 = await getPluginPackageHash(pluginDir);
    if (sha256 !== approval.sha256) {
        throw pluginTrustError('PLUGIN_PACKAGE_CHANGED', 'Plugin files changed; refresh the plugin list and approve the new package', 409);
    }
    return sha256;
}
