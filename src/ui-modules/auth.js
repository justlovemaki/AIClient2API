import { atomicWriteFile, withFileLock } from '../utils/file-lock.js';
import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from '../core/config-manager.js';
import { getClientIp } from '../utils/common.js';
import { PASSWORD } from '../utils/constants.js';

// Token存储到本地文件中
const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');
const INITIAL_PASSWORD_BYTES = 24;

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await new Promise((resolve, reject) =>
        crypto.pbkdf2(password, salt, PASSWORD.PBKDF2_ITERATIONS, PASSWORD.PBKDF2_KEYLEN, PASSWORD.PBKDF2_DIGEST, (err, key) =>
            err ? reject(err) : resolve(key.toString('hex'))
        )
    );
    return `pbkdf2:${salt}:${hash}`;
}

/**
 * 确保管理员密码文件存在。首次启动时生成随机密码，只将哈希写入磁盘，
 * 并将明文初始密码输出到控制台/日志一次。
 */
export async function initializeAdminPassword(pwdFilePath = path.join(process.cwd(), 'configs', 'pwd')) {
    return withFileLock(pwdFilePath, async () => {
        try {
            const storedPassword = (await fs.readFile(pwdFilePath, 'utf8')).trim();
            if (storedPassword) {
                return storedPassword;
            }
            logger.warn('[Auth] Password file is empty; generating a new initial admin password.');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`Unable to read admin password file: ${error.message}`);
            }
        }

        await fs.mkdir(path.dirname(pwdFilePath), { recursive: true });
        const initialPassword = crypto.randomBytes(INITIAL_PASSWORD_BYTES).toString('base64url');
        const storedPassword = await hashPassword(initialPassword);
        await atomicWriteFile(pwdFilePath, storedPassword, { encoding: 'utf-8', mode: 0o600 });

        logger.warn('============================================================');
        logger.warn('[Auth] FIRST STARTUP: a random admin password was generated.');
        logger.warn('[Auth] Save it now. It is only emitted during this initialization.');
        const passwordMessage = `[Auth] Initial admin password: ${initialPassword}`;
        if (logger.shouldLog('warn')) {
            logger.warn(passwordMessage);
        } else {
            // 即使日志被禁用，也必须让管理员能够取得首次登录密码。
            console.warn(passwordMessage);
        }
        logger.warn('============================================================');
        return storedPassword;
    });
}

/**
 * 读取密码文件内容；文件不存在或为空时安全地初始化随机密码。
 */
export async function readPasswordFile(pwdFilePath = path.join(process.cwd(), 'configs', 'pwd')) {
    return initializeAdminPassword(pwdFilePath);
}

/**
 * 验证登录凭据
 */
export async function validateCredentials(password, pwdFilePath) {
    if (typeof password !== 'string' || !password.trim()) return false;
    const storedPassword = await readPasswordFile(pwdFilePath);
    if (!storedPassword) return false;

    // 新格式：pbkdf2:salt:hash
    if (storedPassword.startsWith('pbkdf2:')) {
        const parts = storedPassword.split(':');
        if (parts.length !== 3) return false;
        const [, salt, storedHash] = parts;
        if (!/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(storedHash)) return false;
        const inputHash = await new Promise((resolve, reject) =>
            crypto.pbkdf2(password.trim(), salt, PASSWORD.PBKDF2_ITERATIONS, PASSWORD.PBKDF2_KEYLEN, PASSWORD.PBKDF2_DIGEST, (err, key) =>
                err ? reject(err) : resolve(key.toString('hex'))
            )
        );
        return crypto.timingSafeEqual(Buffer.from(inputHash, 'hex'), Buffer.from(storedHash, 'hex'));
    }

    // 旧格式：明文（兼容迁移期，建议通过 UI 重新设置密码以升级为哈希格式）
    // 使用 timingSafeEqual 防止时序攻击
    const a = Buffer.from(password.trim());
    const b = Buffer.from(storedPassword);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * 解析请求体JSON，带大小限制防止 DoS
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes 最大允许字节数，默认 10KB（登录接口够用）
 */
function parseRequestBody(req, maxBytes = 10 * 1024) {
    return new Promise((resolve, reject) => {
        // 1. 先检查 Content-Length header，快速拒绝超大请求（零读取开销）
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
            req.resume(); // drain & discard，避免连接挂起
            return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
        }

        let body = '';
        let received = 0;

        req.on('data', chunk => {
            received += chunk.length;
            if (received > maxBytes) {
                // 超限：立即销毁连接，不再累积数据
                req.destroy();
                return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
            }
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                resolve(body.trim() ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error('Invalid JSON format'));
            }
        });

        req.on('error', reject);
    });
}

/**
 * 生成简单的token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

 /**
 * 生成token过期时间
 */
function getExpiryTime() {
    const now = Date.now();
    const expiry = (CONFIG.LOGIN_EXPIRY || 3600) * 1000; // 使用配置的过期时间，默认1小时
    return now + expiry;
}


/**
 * 读取token存储文件
 */
async function readTokenStore() {
    try {
        if (existsSync(TOKEN_STORE_FILE)) {
            const content = await fs.readFile(TOKEN_STORE_FILE, 'utf8');
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed.tokens !== 'object' || !parsed.tokens || Array.isArray(parsed.tokens)) {
                return { tokens: Object.create(null) };
            }
            return { tokens: Object.assign(Object.create(null), parsed.tokens) };
        } else {
            // 如果文件不存在，创建一个默认的token store
            await writeTokenStore({ tokens: {} });
            return { tokens: {} };
        }
    } catch (error) {
        logger.error('[Token Store] Failed to read token store file:', error);
        return { tokens: {} };
    }
}

/**
 * 写入token存储文件
 */
async function writeTokenStore(tokenStore) {
    try {
        await atomicWriteFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
        logger.error('[Token Store] Failed to write token store file:', error);
    }
}

/**
 * 验证简单token
 */
export async function verifyToken(token) {
    // Only accept tokens issued by generateToken(), never prototype property names.
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenStore = await readTokenStore();
    if (!Object.hasOwn(tokenStore.tokens, token)) return null;
    const tokenInfo = tokenStore.tokens[token];
    if (!isValidTokenInfo(tokenInfo)) return null;

    if (Date.now() >= tokenInfo.expiryTime) {
        await deleteToken(token);
        return null;
    }
    
    return tokenInfo;
}

function isValidTokenInfo(tokenInfo) {
    return tokenInfo !== null && typeof tokenInfo === 'object' && !Array.isArray(tokenInfo) &&
        Object.hasOwn(tokenInfo, 'expiryTime') &&
        typeof tokenInfo.expiryTime === 'number' && Number.isFinite(tokenInfo.expiryTime);
}

/**
 * 保存token到本地文件
 */
async function saveToken(token, tokenInfo) {
    const tokenStore = await readTokenStore();
    tokenStore.tokens[token] = tokenInfo;
    await writeTokenStore(tokenStore);
}

/**
 * 删除token
 */
async function deleteToken(token) {
    const tokenStore = await readTokenStore();
    if (Object.hasOwn(tokenStore.tokens, token)) {
        delete tokenStore.tokens[token];
        await writeTokenStore(tokenStore);
    }
}

/**
 * 管理登录尝试频率和锁定
 */
class LoginAttemptManager {
    constructor() {
        this.attempts = new Map(); // IP -> { count, lastAttempt, lockoutUntil }
    }

    /**
     * 获取 IP 的状态
     */
    getIpStatus(ip) {
        if (!this.attempts.has(ip)) {
            this.attempts.set(ip, { count: 0, lastAttempt: 0, lockoutUntil: 0 });
        }
        return this.attempts.get(ip);
    }

    /**
     * 检查是否被锁定
     */
    isLockedOut(ip) {
        const status = this.getIpStatus(ip);
        if (status.lockoutUntil > Date.now()) {
            return {
                locked: true,
                remainingTime: Math.ceil((status.lockoutUntil - Date.now()) / 1000)
            };
        }
        // 如果锁定时间已过，重置失败次数
        if (status.lockoutUntil > 0 && status.lockoutUntil <= Date.now()) {
            status.count = 0;
            status.lockoutUntil = 0;
        }
        return { locked: false };
    }

    /**
     * 检查是否请求过于频繁
     */
    isTooFrequent(ip) {
        const status = this.getIpStatus(ip);
        const minInterval = CONFIG.LOGIN_MIN_INTERVAL || 1000;
        const now = Date.now();
        if (now - status.lastAttempt < minInterval) {
            return true;
        }
        status.lastAttempt = now;
        return false;
    }

    /**
     * 记录一次失败
     */
    recordFailure(ip) {
        const status = this.getIpStatus(ip);
        status.count++;
        const maxAttempts = CONFIG.LOGIN_MAX_ATTEMPTS || 5;
        const lockoutDuration = (CONFIG.LOGIN_LOCKOUT_DURATION || 1800) * 1000;

        if (status.count >= maxAttempts) {
            status.lockoutUntil = Date.now() + lockoutDuration;
            logger.warn(`[Auth] IP ${ip} locked out due to too many failed login attempts (${status.count})`);
            return true;
        }
        return false;
    }

    /**
     * 成功后重置
     */
    reset(ip) {
        this.attempts.delete(ip);
    }
}

const loginAttemptManager = new LoginAttemptManager();

/**
 * 清理过期的token
 */
export async function cleanupExpiredTokens() {
    const tokenStore = await readTokenStore();
    const now = Date.now();
    let hasChanges = false;
    
    for (const [token, info] of Object.entries(tokenStore.tokens)) {
        if (!/^[a-f0-9]{64}$/.test(token) || !isValidTokenInfo(info) || now >= info.expiryTime) {
            delete tokenStore.tokens[token];
            hasChanges = true;
        }
    }
    
    if (hasChanges) {
        await writeTokenStore(tokenStore);
    }
}

/**
 * 检查token验证
 * 支持 Authorization Header 或 URL 参数 token (用于 SSE)
 */
export async function checkAuth(req) {
    let token = null;
    
    // 1. 检查 Authorization header
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }
    
    // 2. 检查 URL 参数 (用于 EventSource/SSE)
    if (!token && req.url) {
        try {
            const url = new URL(req.url, 'http://localhost');
            token = url.searchParams.get('token');
        } catch (e) {
            // 解析失败忽略
        }
    }
    
    if (!token) {
        return false;
    }

    const tokenInfo = await verifyToken(token);
    
    return tokenInfo !== null;
}

/** Shared management-API gate. Must run before dispatching plugin code. */
export async function requireManagementAuth(req, res) {
    if (await checkAuth(req)) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unauthorized access, please login first', code: 'UNAUTHORIZED' } }));
    return false;
}

/** Require fresh credential confirmation on executable extension changes. */
export async function requireAdminReauthentication(req, res, password) {
    const ip = getClientIp(req, CONFIG);
    const lockout = loginAttemptManager.isLockedOut(ip);
    if (lockout.locked || loginAttemptManager.isTooFrequent(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'REAUTH_RATE_LIMITED', message: 'Too many authentication attempts' } }));
        return false;
    }
    if (!await validateCredentials(password)) {
        loginAttemptManager.recordFailure(ip);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'REAUTH_REQUIRED', message: 'Current admin password is required for this operation' } }));
        return false;
    }
    loginAttemptManager.reset(ip);
    return true;
}

/**
 * 处理登录请求
 */
export async function handleLoginRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            success: false, 
            message: 'Only POST requests are supported',
            messageCode: 'login.error.postOnly'
        }));
        return true;
    }

    const ip = getClientIp(req, CONFIG);
    
    // 1. 检查锁定状态
    const lockout = loginAttemptManager.isLockedOut(ip);
    if (lockout.locked) {
        logger.warn(`[Auth] Login attempt from locked IP: ${ip}, reason: account_locked, remaining: ${lockout.remainingTime}s`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            success: false, 
            message: `Account temporarily locked due to too many failed attempts. Please try again in ${lockout.remainingTime} seconds.`,
            messageCode: 'login.error.locked',
            messageParams: { time: lockout.remainingTime }
        }));
        return true;
    }

    // 2. 频率限制
    if (loginAttemptManager.isTooFrequent(ip)) {
        logger.warn(`[Auth] Login attempt too frequent from IP: ${ip}, reason: rate_limit`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            success: false, 
            message: 'Too many requests, please slow down.',
            messageCode: 'login.error.tooFrequent'
        }));
        return true;
    }

    try {
        const requestData = await parseRequestBody(req);
        const { password } = requestData;
        
        if (!password) {
            logger.warn(`[Auth] Login failed from IP: ${ip}, reason: empty_password`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: false, 
                message: 'Password cannot be empty',
                messageCode: 'login.error.empty'
            }));
            return true;
        }

        const isValid = await validateCredentials(password);
        
        if (isValid) {
            logger.info(`[Auth] Login successful from IP: ${ip}`);
            // 登录成功，重置计数
            loginAttemptManager.reset(ip);

            // Generate simple token
            const token = generateToken();
            const loginExpiry = CONFIG.LOGIN_EXPIRY || 3600;
            const expiryTime = Date.now() + (loginExpiry * 1000);
            
            // Store token info to local file
            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime
            });

             res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Login successful',
                token,
                expiresIn: `${loginExpiry} seconds`
            }));
        } else {
            // 登录失败，记录
            const isLocked = loginAttemptManager.recordFailure(ip);
            const status = loginAttemptManager.getIpStatus(ip);
            const maxAttempts = CONFIG.LOGIN_MAX_ATTEMPTS || 5;
            const remaining = maxAttempts - status.count;
            const lockoutDuration = CONFIG.LOGIN_LOCKOUT_DURATION || 1800;

            logger.warn(`[Auth] Login failed from IP: ${ip}, reason: incorrect_password, remaining_attempts: ${Math.max(0, remaining)}${isLocked ? ', result: locked' : ''}`);

            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: isLocked 
                    ? `Incorrect password. Account locked for ${Math.ceil(lockoutDuration / 60)} minutes.` 
                    : `Incorrect password. ${remaining} attempts remaining.`,
                messageCode: isLocked ? 'login.error.incorrectWithLock' : 'login.error.incorrectWithRemaining',
                messageParams: isLocked ? { time: Math.ceil(lockoutDuration / 60) } : { count: remaining }
            }));
        }

    } catch (error) {
        logger.error('[Auth] Login processing error:', error);
        const isJsonError = error.message === 'Invalid JSON format';
        const isBodyTooLarge = error.code === 'BODY_TOO_LARGE';

        if (isBodyTooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Request body too large',
                messageCode: 'login.error.bodyTooLarge'
            }));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: error.message || 'Server error',
                messageCode: isJsonError ? 'login.error.invalidJson' : undefined
            }));
        }
    }
    return true;
}

// 定时清理过期token；不阻止仅导入该模块的进程正常退出
setInterval(cleanupExpiredTokens, 5 * 60 * 1000).unref(); // 每5分钟清理一次


