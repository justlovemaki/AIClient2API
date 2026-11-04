import { promises as fs } from 'fs';
import path from 'path';

function denied(message, code = 'CONFIG_PATH_FORBIDDEN') {
    return Object.assign(new Error(message), { status: 403, code });
}

function inside(base, target) {
    const relative = path.relative(base, target);
    return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

/** Resolve user-selected files without following directory/file links or aliases.
 * Missing parents are allowed for a subsequent controlled mkdir/write.
 */
async function assertNoLinks(base, target) {
    try {
        const baseInfo = await fs.lstat(base);
        if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw denied('Configuration root must be a real directory');
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    const segments = path.relative(base, target).split(path.sep);
    let current = base;
    for (let index = 0; index < segments.length; index++) {
        current = path.join(current, segments[index]);
        let info;
        try { info = await fs.lstat(current); }
        catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) ||
            (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
            throw denied('Linked, aliased or non-regular configuration files are not allowed');
        }
    }
}

function resolveIn(base, filePath) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) throw denied('Invalid file path');
    const target = path.resolve(process.cwd(), filePath.replace(/\\/g, '/'));
    if (!inside(base, target)) throw denied('File must stay inside the allowed directory');
    const segments = path.relative(base, target).split(path.sep);
    if (segments.some(part => part.includes(':') || part.startsWith('.') || /[.\s]$|[\x00-\x1f]/.test(part))) {
        throw denied('Hidden files, ambiguous path segments and alternate streams are not allowed');
    }
    return { target, segments };
}

/** Prompt editors are TEXT editors, not a generic server-file write API. */
export async function resolveSystemPromptPath(filePath) {
    const base = process.cwd();
    const { target, segments } = resolveIn(base, filePath);
    const protectedTrees = new Set(['src', 'static', 'node_modules', 'docker', 'tls-sidecar']);
    if (protectedTrees.has(segments[0].toLowerCase()) || !['.txt', '.md'].includes(path.extname(target).toLowerCase())) {
        throw denied('System prompts must be .txt or .md files outside application-code and private directories', 'INVALID_SYSTEM_PROMPT_PATH');
    }
    await assertNoLinks(base, target);
    return target;
}

/** Provider-pool selectors must not turn JSON parsing/writing into a private-key
 * disclosure or a second way to overwrite control files.
 */
export async function resolveProviderPoolsPath(filePath) {
    const { target, segments } = resolveIn(process.cwd(), filePath);
    const relative = segments.map(part => part.toLowerCase()).join('/');
    const protectedTrees = new Set(['src', 'static', 'node_modules', 'docker', 'tls-sidecar']);
    const protectedFiles = new Set(['package.json', 'package-lock.json', 'configs/plugins.json', 'configs/config.json', 'configs/token-store.json']);
    if (path.extname(target).toLowerCase() !== '.json' || protectedTrees.has(segments[0].toLowerCase()) || protectedFiles.has(relative)) {
        throw denied('Provider pools must use a dedicated JSON data file', 'INVALID_PROVIDER_POOLS_PATH');
    }
    await assertNoLinks(process.cwd(), target);
    return target;
}

/** Password and session stores are not downloadable/editable credential uploads. */
export async function resolveUploadedConfigPath(filePath) {
    const base = path.join(process.cwd(), 'configs');
    const { target, segments } = resolveIn(base, filePath);
    const isAuthStore = parts => parts.length === 1 && ['pwd', 'token-store.json'].includes(parts[0].toLowerCase());
    if (isAuthStore(segments)) throw denied('Authentication stores are managed through dedicated endpoints', 'CONFIG_FILE_PROTECTED');
    await assertNoLinks(base, target);
    try {
        // Resolve native aliases too (for example Windows short filenames).
        const physicalBase = await fs.realpath(base);
        const physicalFile = await fs.realpath(target);
        if (!inside(physicalBase, physicalFile) || isAuthStore(path.relative(physicalBase, physicalFile).split(path.sep))) {
            throw denied('Authentication stores and external file aliases are protected', 'CONFIG_FILE_PROTECTED');
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return target;
}
