# 自定义插件管理页面鉴权迁移指南

> [!WARNING]
> 这是安全修复带来的兼容性调整。旧版在鉴权之前执行插件路由，导致插件 API 可以被未登录访问；新版先验证管理员会话，再执行私有插件路由。**不要为了兼容旧页面重新放开全部插件接口。**

完整插件信任边界见 [PLUGIN_SECURITY.md](./PLUGIN_SECURITY.md)，从旧版本升级的总体步骤见 [UPGRADING_PLUGIN_TRUST.md](./UPGRADING_PLUGIN_TRUST.md)。

## 1. 为什么以前可用，现在返回 401

旧版请求顺序：

```text
请求 /api/my-plugin
→ 先执行插件路由
→ 之后才进入系统鉴权
```

因此下面的页面代码即使没有发送 token，也可能成功：

```js
const response = await fetch('/api/my-plugin');
```

这不是受支持的公开访问方式，而是此前“插件路由先于鉴权”的漏洞表现。新版顺序调整为：

```text
请求 /api/my-plugin
→ 管理员会话鉴权
→ 鉴权成功后执行私有插件路由
```

浏览器不会自动把管理后台保存在 `localStorage` 的 token 添加到普通 `fetch()`，所以旧页面会收到 `401 / UNAUTHORIZED`。

## 2. 哪些插件需要修改

需要修改：

- 插件包含独立 HTML/JavaScript 管理页面；
- 页面直接通过 `fetch('/api/...')`、XHR、Axios 等调用插件私有 API；
- 请求没有显式使用管理后台的认证客户端。

通常不需要修改：

- 只有后端中间件、钩子或路由，没有独立页面；
- 页面只展示静态内容，不调用插件 API；
- 插件页面已经为请求正确添加有效的管理员 Bearer token；
- 经主项目审查的内置公开业务接口，并在处理器中执行自己的身份验证。例如 Potluck 用户用量接口使用用户自己的 `maki_` Key；它不等于任意用户插件都能声明公开。

插件后端路由处理代码通常不需要为了这个 401 改动；应优先修改页面请求方式。

## 3. 推荐迁移方式

项目提供同源插件管理页面客户端：

```js
import { createPluginApi } from '/app/plugin-page-api.js';
```

页面主脚本必须是 ES module：

```html
<script type="module">
  import { createPluginApi } from '/app/plugin-page-api.js';

  const api = createPluginApi('/my-plugin');
  const result = await api.get();
</script>
```

`createPluginApi()` 的参数是不带 `/api` 的插件 API 根路径。客户端会请求 `/api/my-plugin`，从现有管理登录状态读取 token，并添加：

```http
Authorization: Bearer <admin-session-token>
```

token 不会被放进 URL、页面 HTML 或插件配置。没有有效登录状态时，客户端会转到登录页；服务端返回 401 时会清理失效会话并转到登录页。

### GET

旧代码：

```js
const response = await fetch('/api/my-plugin');
const payload = await response.json();
```

新代码：

```js
const api = createPluginApi('/my-plugin');
const payload = await api.get();
```

### PUT

旧代码：

```js
const response = await fetch('/api/my-plugin', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config })
});
const payload = await response.json();
```

新代码：

```js
const payload = await api.put({ config });
```

### POST

```js
const payload = await api.post({ action: 'refresh' });
```

### DELETE

```js
const payload = await api.delete();
```

### 子路径

```js
await api.get('/status');
await api.post({ action: 'refresh' }, '/actions');
await api.put({ enabled: true }, '/settings');
await api.delete('/items/item-1');
```

允许的端点与子路径只包含字母、数字、下划线、连字符和 `/`。查询参数建议由插件 API 设计为请求体或增加经过验证的专用调用；不要把管理员 token 放到查询参数。

客户端自动解析 JSON/文本；非 2xx 响应会抛出带 `status` 和 `data` 的错误。页面仍应捕获错误并给用户显示安全、清晰的信息：

```js
try {
  const payload = await api.get();
  render(payload);
} catch (error) {
  showError(error.message);
}
```

## 4. 完整页面示例

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>My Plugin</title>
</head>
<body>
  <button id="save">保存</button>
  <pre id="output"></pre>

  <script type="module">
    import { createPluginApi } from '/app/plugin-page-api.js';

    const api = createPluginApi('/my-plugin');
    const output = document.getElementById('output');

    async function load() {
      const payload = await api.get();
      output.textContent = JSON.stringify(payload, null, 2);
    }

    document.getElementById('save').addEventListener('click', async () => {
      try {
        const payload = await api.put({ config: { enabled: true } });
        output.textContent = JSON.stringify(payload, null, 2);
      } catch (error) {
        output.textContent = error.message;
      }
    });

    load().catch(error => { output.textContent = error.message; });
  </script>
</body>
</html>
```

## 5. 不推荐的处理方式

不要：

- 将插件路由重新设为默认免认证；
- 仅因为请求来自插件 HTML，就在服务端跳过鉴权；
- 把 token 写死在插件源码、HTML、ZIP 或配置文件；
- 把 token 加到 URL 查询参数、链接或日志；
- 让用户插件通过 `public:true` 绕过管理员鉴权。用户插件的该字段不会自动获得免认证能力；
- 为了消除 401，改用主服务 API Key 冒充管理会话；管理会话与模型服务 Key 是不同权限域。

如果插件确实提供面向普通用户的公开业务页面，应设计独立、最小权限的认证协议，并提交主项目审查；不能复用管理页私有接口作为公开 API。

## 6. 打包、哈希与重新批准

HTML、JavaScript 和静态资源都属于插件包哈希的一部分。修改页面鉴权代码后：

1. 停止继续编辑插件包，确认最终文件内容；
2. 若当前进程已加载旧包，先重启服务；
3. 登录管理后台，刷新插件列表；
4. 检查新 SHA-256 和代码来源；
5. 输入当前管理员密码并重新批准；
6. 打开插件页面，验证读取和写入接口；
7. 再进行一次正常重启，确认批准记录和签名密钥已持久化。

若直接热改已加载插件，可能看到 `PLUGIN_RESTART_REQUIRED`。不要手工修改 `configs/plugins.json` 的哈希、签名或 `enabled` 来绕过流程。

## 7. 401 排查清单

1. **强制刷新页面**：更新页面脚本后使用 `Ctrl+F5`，避免浏览器继续运行旧 HTML/JS。
2. **确认同源**：插件页面应由同一 AIClient2API 服务提供，例如 `/my-plugin.html`；不要直接使用 `file://` 打开，也不要复制到另一个域名后期望共享 `localStorage`。
3. **确认已登录管理后台**：插件管理页面需要管理员会话，不是服务调用 API Key。
4. **检查请求头**：浏览器开发者工具 Network 中应有 `Authorization: Bearer ...`。不要公开或截图完整 token。
5. **确认使用新客户端**：页面应导入 `/app/plugin-page-api.js`，而不是裸 `fetch('/api/...')`。
6. **确认端点写法**：`createPluginApi('/my-plugin')` 不包含 `/api`；否则会形成错误路径。
7. **确认插件已启用且批准有效**：鉴权成功但插件禁用时通常返回 503，而不是 401。
8. **确认没有混淆公开业务 Key**：Potluck 的 `maki_` Key 只适用于它自己的用户接口，不能访问其他插件管理 API。
9. **仍然 401**：重新登录，查看会话是否过期；不要通过关闭服务端鉴权解决。

## 8. 验证与维护要求

项目 UI 浏览器测试会验证认证客户端为 GET/PUT 请求添加管理员 Bearer token，并覆盖密码弹窗、链接安全渲染、深浅主题和移动布局。运行：

```sh
npm run test:ui
npm run test:security
```

插件作者仍应在自己的页面测试 GET、写操作、会话过期和错误提示。安全测试通过不代表第三方插件代码可信；管理员批准的用户插件仍拥有服务进程权限。
