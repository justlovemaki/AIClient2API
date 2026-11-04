import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

// No browser automation dependency or real login: use a fresh headless browser
// profile and a loopback fixture serving the actual UI modules and styles.
const candidates = [
    process.env.BROWSER_EXECUTABLE,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const browser = candidates.find(candidate => candidate && existsSync(candidate));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient2api-dialog-ui-'));
const staticRoot = fileURLToPath(new URL('../../static/', import.meta.url));
const cases = [
    { name: 'desktop-light-user', width: 1280, height: 900, theme: 'light', builtin: false, lang: 'zh-CN' },
    { name: 'desktop-dark-user', width: 1280, height: 900, theme: 'dark', builtin: false, lang: 'zh-CN' },
    { name: 'desktop-light-builtin', width: 1280, height: 800, theme: 'light', builtin: true, lang: 'zh-CN' },
    { name: 'mobile-light-user', width: 390, height: 844, theme: 'light', builtin: false, lang: 'zh-CN', pluginName: 'plugin-' + 'x'.repeat(57) },
    { name: 'mobile-dark-builtin', width: 390, height: 700, theme: 'dark', builtin: true, lang: 'en-US' },
    { name: 'short-english-user', width: 375, height: 500, theme: 'light', builtin: false, lang: 'en-US', pluginName: '<img src=x onerror="window.injected=true">' }
];
const apiRequests = [];

function fixture(scenario) {
    const plugin = { name: scenario.pluginName || 'my-trusted-plugin', isBuiltin: scenario.builtin, packageHash: 'abcdef0123456789'.repeat(4) };
    return `<!doctype html><html lang="${scenario.lang}" data-theme="${scenario.theme}"><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/static/app/base.css">
        <link rel="stylesheet" href="/static/app/mobile.css">
        <link rel="stylesheet" href="/static/components/section-plugins.css">
        <style>body{overflow:hidden}main{padding:40px}main h1{font-size:24px;margin-bottom:12px}.preview-card{height:140px;margin-top:24px;border:1px solid var(--border-color);border-radius:16px;background:var(--bg-primary)}</style>
    </head><body><main><h1>Plugin settings</h1><p>AIClient2API</p><div class="preview-card"></div></main>
    <script type="module">
        import { renderSafePluginDescription, requestPluginPassword } from '/static/app/plugin-manager.js';
        import { createPluginApi } from '/static/app/plugin-page-api.js';
        import { setLanguage } from '/static/app/i18n.js';
        const plugin = ${JSON.stringify(plugin)};
        const check = (value, message) => { if (!value) throw new Error(message); };
        const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const report = document.createElement('pre'); report.id = 'plugin-ui-test-report'; report.hidden = true;
        report.textContent = JSON.stringify({ passed: false, phase: 'starting fixture' });
        document.body.appendChild(report);
        try {
            setLanguage(${JSON.stringify(scenario.lang)});
            localStorage.setItem('authToken', 'fixture-admin-token');
            const originalFetch = window.fetch;
            const calls = [];
            window.fetch = async (url, options = {}) => {
                calls.push({ url: String(url), method: options.method, authorization: new Headers(options.headers).get('Authorization'), body: options.body });
                return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            };
            const pluginApi = createPluginApi('/ip-node-proxy');
            await pluginApi.get();
            await pluginApi.put({ config: { bindings: {} } });
            window.fetch = originalFetch;
            localStorage.removeItem('authToken');
            check(calls.length === 2 && calls.every(call => call.authorization === 'Bearer fixture-admin-token'), 'plugin page API must attach the admin Bearer token');
            check(calls[0].url.endsWith('/api/ip-node-proxy') && calls[0].method === 'GET' && calls[1].method === 'PUT', 'plugin page API must preserve endpoint and methods');
            check(JSON.parse(calls[1].body).config.bindings && typeof JSON.parse(calls[1].body).config.bindings === 'object', 'plugin page API must serialize update data');
            const richDescription = document.createElement('div');
            renderSafePluginDescription(richDescription, 'Bind by IP<br>Page: <a href="ip-node-proxy.html" target="_blank">ip-node-proxy.html</a> <code>/api/test</code>');
            check(richDescription.querySelectorAll('br').length === 1, 'description must preserve line breaks');
            check(richDescription.querySelector('a')?.getAttribute('href') === '/ip-node-proxy.html', 'description must preserve safe relative links');
            check(richDescription.querySelector('a')?.rel === 'noopener noreferrer', 'description links must isolate opened pages');
            check(richDescription.querySelector('code')?.textContent === '/api/test', 'description must preserve safe inline code');
            const hostileDescription = document.createElement('div');
            window.descriptionInjected = false;
            renderSafePluginDescription(hostileDescription, '<img src=x onerror="window.descriptionInjected=true"><scr' + 'ipt>window.descriptionInjected=true</scr' + 'ipt><a href="javascript:window.descriptionInjected=true">bad</a><a href="https://example.com/docs">docs</a>');
            check(!hostileDescription.querySelector('img,script') && !window.descriptionInjected, 'description must discard executable markup');
            check(hostileDescription.querySelectorAll('a').length === 1 && hostileDescription.querySelector('a').href === 'https://example.com/docs', 'description must block executable URLs and retain safe https links');
            let pending = requestPluginPassword(plugin);
            await document.fonts.ready; await paint();
            let dialog = document.querySelector('.plugin-reauth-dialog');
            let input = dialog.querySelector('.plugin-reauth-input');
            let trust = dialog.querySelector('.plugin-reauth-trust');
            let submit = dialog.querySelector('.plugin-reauth-submit');
            const rect = dialog.getBoundingClientRect();
            const inputRect = input.getBoundingClientRect();
            const bodyRect = dialog.querySelector('.plugin-reauth-body').getBoundingClientRect();
            check(rect.left >= 8 && rect.right <= innerWidth - 8, 'dialog must fit viewport width');
            check(rect.top >= 7 && rect.bottom <= innerHeight - 7, 'dialog must fit viewport height');
            check(dialog.scrollWidth <= dialog.clientWidth + 1, 'dialog must not overflow horizontally');
            check(inputRect.height >= 46, 'password input needs a full-height styled field');
            check(inputRect.top >= bodyRect.top - 1 && inputRect.bottom <= bodyRect.bottom + 1, 'focused password field must be visible in the scrollable body');
            check(getComputedStyle(input).paddingLeft === '44px', 'input must have dedicated icon padding');
            check(getComputedStyle(input).borderRadius === '10px', 'password field must retain styled corners');
            check(submit.getBoundingClientRect().height >= 44, 'submit button needs a touch-sized target');
            check(document.activeElement === input, 'password field must receive focus');
            check(input.required && input.autocomplete === 'current-password', 'password validation must stay required');
            check(Boolean(trust) === !plugin.isBuiltin, 'trust checkbox only belongs to user plugins');
            check(!dialog.querySelector('img') && !window.injected, 'plugin metadata must render as text, not HTML');
            check(document.getElementById(dialog.getAttribute('aria-labelledby')), 'dialog requires an accessible title');
            check(input.labels.length === 1 && input.getAttribute('aria-describedby'), 'password label and help must be accessible');
            dialog.querySelector('form').requestSubmit(submit);
            check(dialog.open, 'empty password must not submit');
            input.value = 'ui-fixture-only';
            const visibility = dialog.querySelector('.plugin-reauth-visibility');
            visibility.click();
            check(input.type === 'text' && visibility.getAttribute('aria-pressed') === 'true', 'visibility control must reveal password accessibly');
            check(getComputedStyle(input).borderRadius === '10px', 'revealing password must not lose input styling');
            visibility.click();
            check(input.type === 'password', 'visibility control must mask password again');
            if (trust) {
                check(trust.required, 'explicit trust must remain required');
                dialog.querySelector('form').requestSubmit(submit);
                check(dialog.open, 'password alone must not bypass explicit consent');
                trust.click();
            }
            report.textContent = JSON.stringify({ passed: false, phase: 'awaiting confirmation close' });
            dialog.querySelector('form').requestSubmit(submit);
            await paint();
            const approval = await pending;
            check(approval.password === 'ui-fixture-only' && approval.trust === !plugin.isBuiltin, 'dialog must preserve the existing approval contract');
            check(input.value === '' && !input.isConnected, 'closing must clear and remove password input');
            for (const selector of ['.plugin-reauth-close', '.plugin-reauth-footer .btn-secondary']) {
                pending = requestPluginPassword(plugin);
                dialog = document.querySelector('.plugin-reauth-dialog'); input = dialog.querySelector('.plugin-reauth-input');
                input.value = 'ui-fixture-only'; dialog.querySelector('.plugin-reauth-visibility').click();
                dialog.querySelector(selector).click();
                await paint();
                check(await pending === null, 'cancel/close must never approve');
                check(input.value === '' && input.type === 'password' && !input.isConnected, 'cancel must clear visible password too');
            }
            // Leave a fresh, empty dialog visible for the browser screenshot.
            requestPluginPassword(plugin); await paint();
            report.textContent = JSON.stringify({ passed: true, viewport: [innerWidth, innerHeight], theme: ${JSON.stringify(scenario.theme)} });
        } catch (error) { report.textContent = JSON.stringify({ passed: false, error: error.message }); }
        document.body.appendChild(report);
    </script></body></html>`;
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
        if (url.pathname === '/') {
            const scenario = cases.find(item => item.name === url.searchParams.get('case'));
            if (!scenario) { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(fixture(scenario)); return;
        }
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(staticRoot, decodeURIComponent(url.pathname.slice(8)));
            const relative = path.relative(staticRoot, file);
            if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
            const content = await fs.readFile(file);
            res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'application/javascript', 'Cache-Control': 'no-store' });
            res.end(content); return;
        }
        res.writeHead(404).end();
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
});

async function connectBrowser(url) {
    const socket = new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    socket.on('message', raw => {
        const message = JSON.parse(raw.toString());
        const command = pending.get(message.id);
        if (!command) return;
        clearTimeout(command.timer); pending.delete(message.id);
        if (message.error) command.reject(new Error(message.error.message));
        else command.resolve(message.result);
    });
    socket.on('close', () => {
        for (const command of pending.values()) { clearTimeout(command.timer); command.reject(new Error('Test browser disconnected')); }
        pending.clear();
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return {
        socket,
        send(method, params = {}, sessionId) {
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10000);
                pending.set(id, { resolve, reject, timer });
                socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            });
        }
    };
}

for (const scenario of cases) {
    test(`reauth dialog: ${scenario.name}`,  { skip: !browser && 'Set BROWSER_EXECUTABLE to a Chromium/Edge binary', timeout: 40000 }, async () => {
        const screenshotDir = process.env.UI_SCREENSHOT_DIR ? path.resolve(process.env.UI_SCREENSHOT_DIR) : root;
        await fs.mkdir(screenshotDir, { recursive: true });
        const screenshot = path.join(screenshotDir, scenario.name + '.png');
        const child = spawn(browser, [
            '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-component-update', '--disable-sync',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
            '--force-device-scale-factor=1', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
            '--user-data-dir=' + path.join(root, scenario.name), 'about:blank'
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let client;
        try {
            const endpoint = await new Promise((resolve, reject) => {
                let stderr = '';
                const timer = setTimeout(() => reject(new Error('Headless browser did not start')), 10000);
                child.once('error', error => { clearTimeout(timer); reject(error); });
                child.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited early (${code}): ${stderr.slice(-1000)}`)); });
                child.stderr.on('data', chunk => {
                    stderr += chunk;
                    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                    if (match) { clearTimeout(timer); resolve(match[1]); }
                });
            });
            client = await connectBrowser(endpoint);
            const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
            const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
            await client.send('Target.activateTarget', { targetId });
            await client.send('Page.enable', {}, sessionId);
            await client.send('Emulation.setDeviceMetricsOverride', { width: scenario.width, height: scenario.height, deviceScaleFactor: 1, mobile: false }, sessionId);
            await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
            await client.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?case=${scenario.name}` }, sessionId);
            let report = null;
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                const state = await client.send('Runtime.evaluate', {
                    expression: "document.getElementById('plugin-ui-test-report')?.textContent || null", returnByValue: true
                }, sessionId);
                if (state.result?.value) report = JSON.parse(state.result.value);
                if (report?.passed || report?.error) break;
                await delay(50);
            }
            assert.equal(report?.passed, true, JSON.stringify(report));
            assert.deepEqual(report.viewport, [scenario.width, scenario.height]);
            assert.equal(apiRequests.length, 0, 'UI fixture must not make authenticated API calls');
            const image = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
            await fs.writeFile(screenshot, Buffer.from(image.data, 'base64'));
            assert.ok((await fs.stat(screenshot)).size > 1000, 'Expected a rendered screenshot');
            await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
            await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
            let removed = false;
            const closeDeadline = Date.now() + 2000;
            while (Date.now() < closeDeadline) {
                const state = await client.send('Runtime.evaluate', { expression: "document.querySelector('.plugin-reauth-dialog') === null", returnByValue: true }, sessionId);
                if (state.result?.value === true) { removed = true; break; }
                await delay(50);
            }
            assert.equal(removed, true, 'Escape must cancel and remove the dialog');
        } finally {
            await client?.send('Browser.close').catch(() => {});
            client?.socket.close();
            if (child.exitCode === null) {
                await new Promise(resolve => {
                    const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
                    child.once('exit', () => { clearTimeout(timer); resolve(); });
                });
            }
        }
    });
}
