# Antigravity 免费账号模型策略与别名兼容

核对日期：2026-10-20。

## 当前行为

本项目对明确识别为 `free-tier` 的账号采用以下本地兼容策略：

| 列表 / Playground 展示的客户端 ID | 上游请求模型 | thinkingLevel |
| --- | --- | --- |
| `gemini-3.8-flash-high` | `gemini-3.8-flash-high` | `high` |
| `gemini-3.8-flash-medium` | `gemini-3.8-flash-low` | `medium` |
| `gemini-3.8-flash-low` | `gemini-3.8-flash-low` | `low` |

**列表展示与请求权限是两项不同的判断。** 请求先去除 `models/` 前缀及已有的括号后缀、解析模型别名，再按实际的上游目标检查权限；构造请求时仍保留客户端模型对应的思考等级，不能把 Medium 请求的思考等级一起降成 Low。

旧客户端使用的 `gemini-3.8-flash` 仍映射到 `gemini-3.8-flash-low`，包括 `models/gemini-3.8-flash` 写法。它不额外占用列表中的一个选项，但允许路由到免费账号，非流式及流式请求均继续兼容，**无需迁移**。

其他上游目标在免费账号上仍返回不重试、不计入账号健康错误次数的本地 404。付费账号以及尚未识别 tier 的账号保持原有行为；混合账号池继续按各账号的 tier 路由和合并展示模型。

**手动注册的自定义模型是显式目录条目，不是自动发现结果。** 它们按配置的列表提供商保留展示，不再与账号上游返回的模型名单取交集；这包括自定义 ID 与内置模型同名、或自定义 ID 映射到其他实际模型的情况。只有显式注册的 ID 得到展示豁免，其他内置模型仍按上述策略过滤。展示不代表已获得上游授权，实际请求仍校验最终路由的账号和模型权限。新增、编辑、删除自定义模型后，会刷新当前页面的首页模型缓存。

实现位置：

- `src/providers/gemini/antigravity-core.js`：别名映射、请求权限、原生模型列表与思考等级。
- `src/providers/provider-pool-manager.js`：账号选择与聚合模型列表。

## 界面全量目录与状态后缀

首页、Playground 和账号模型选择器保留展示 Antigravity 的内置及自定义目录。相对于账号池最近一次模型发现结果，名称后缀含义如下：

- 无后缀：至少一个套餐允许的账号实际返回过该模型（按上游目标匹配别名）。这不是对请求成功或剩余额度的保证。
- `（上游未返回）`：套餐允许，但已取得的账号模型列表里没有该模型。
- `（当前套餐不可用）`：账号池中所有已识别的套餐都被当前请求策略限制。
- `（上游未确认）`：发现失败、仅使用静态后备目录、没有配置账号，或自定义模型实际路由到另一个提供商。

有一个账号确认返回模型即可去掉后缀；如果仍有账号发现失败，不把“未确认”误报成确定的“未返回”。显示和可选择不代表获得调用授权，实际请求权限校验保持不变。

后缀只用于显示，不进入复制内容、下拉选项值、请求模型 ID 或 `notSupportedModels` 配置。

Web UI 通过 `GET /api/provider-models?includeUnavailable=true` 获取 `{ models: { provider: [id] }, modelStatus: { provider: { id: status } } }`；单提供商接口 `/api/provider-models/{provider}?includeUnavailable=true` 保留 `models` 数组，另外返回该提供商的 `modelStatus`。状态值为 `returned`、`not_returned`、`tier_restricted`、`unknown`。

不带参数的原有 UI API 和对外模型列表 API 保持既有的筛选行为与数据结构，避免影响旧客户端。

## 上游依据及适用范围

1. [Google Antigravity 官方模型表](https://antigravity.google/docs/models/)：Gemini 3.8 Flash 支持 Free / Google AI Plus，思考等级支持 Low / Medium / High；Gemini 3.7 Flash、3.6 Flash 和 3.1 Pro 当前不支持 Free / Plus。
2. [官方 CLI headless 文档](https://antigravity.google/docs/cli/headless/#select-a-model-effort-or-agent)：示例使用 `gemini-3.8-flash-medium`，并说明通过 `agy models` 查询可用模型及通过 `--effort` 选择思考等级。
3. [官方套餐页](https://antigravity.google/pricing)：个人免费套餐有基础每周限额，具体模型引用官方模型表。这里指 Antigravity 产品账号，不是 Gemini Developer API 的免费配额。
4. [PR #744](https://github.com/justlovemaki/AIClient2API/pull/744)（2026-10-16）：贡献者报告免费账号旧模型 ID 会收到上游 404，并附带[客户端选择器截图](../.github/pr-assets/antigravity-free-tier-models-2026-10-16.png)。这是本项目采取“三档”保守策略的账户观察依据，不是 Google 官方完整授权名单。

### 已知的文档与账户观察差异

截至核对日期，官方模型表仍将 Claude Sonnet 4.6、Claude Opus 4.6、GPT-OSS-120b 列为免费可用，并注明 **2026-11-02 移除**。因此，官方资料不能证明“2026-10-16 起所有免费账号只能用 Gemini 3.8 Flash”。本项目保留 #744 已合入的保守限制；不要把它描述成已经在所有账户验证的上游统一规则，也不要把代码中的三个客户端 ID 当成三个独立的上游模型。

若需要放开这些过渡期模型，应结合该账号的 `loadCodeAssist` tier、`fetchAvailableModels` 结果及实际请求结果重新验证，再更新名单及对应测试。本次没有可用的真实账号凭据，未进行上游实测。

## Gemini 4 Argon / Carbon / Hydrogen

Antigravity 提供以下六个客户端模型入口，但不加入免费账号白名单：

| 客户端 ID | 上游请求模型 | thinkingLevel |
| --- | --- | --- |
| `gemini-4-argon` | `gemini-4-argon-medium` | `medium` |
| `gemini-4-argon-high` | `gemini-4-argon-high` | `high` |
| `gemini-4-carbon` | `gemini-4-carbon-medium` | `medium` |
| `gemini-4-carbon-high` | `gemini-4-carbon-high` | `high` |
| `gemini-4-hydrogen` | `gemini-4-hydrogen-medium` | `medium` |
| `gemini-4-hydrogen-high` | `gemini-4-hydrogen-high` | `high` |

Carbon、Hydrogen 沿用既有 Argon 的 Medium 别名、High 上游 ID、思考等级及 CLI User-Agent 处理方式；这是本地兼容实现，尚未使用真实账号核实其上游 ID 和套餐授权。

模型发现时把上游 Medium ID 展示为基础入口；High ID 保持不变。基础入口及 High 都参与静态后备目录、原生模型列表、自动模式和 Playground 的账号池模型筛选。

[官方模型表](https://antigravity.google/docs/models/)注明 Argon 面向非试用 Google AI Pro、Ultra 和 Enterprise，不支持 Free / Plus，也不支持 Antigravity IDE；另见[官方发布说明](https://antigravity.google/blog/gemini-4-argon-in-google-antigravity/)。因此模型目录请求和上述 Gemini 4 模型的流式/非流式请求使用 CLI User-Agent，其他模型请求和账号元数据请求保持原有标识。基础别名到 Medium 的映射参考[社区 Cloud Code 适配](https://github.com/1jehuang/jcode/pull/1834)，不把基础别名直接作为未经规范化的上游 ID 发送。

本地不会判定付费账号是否仍处于试用或是否具备具体的 Argon 授权，最终可用性由上游决定。本次仅通过模拟传输验证，尚未使用真实账号联调。

## Gemini 4 回归验证

```bash
npm test -- --runInBand tests/antigravity-gemini4.test.js tests/antigravity-quota-family.test.js tests/claude-thinking-config.test.js
```

覆盖六个入口的模型注册、别名规范化、思考等级、流式/非流式请求与 CLI 标识、模型发现和静态后备目录，以及免费账号限制。全部使用模拟传输，不代表真实上游调用验证。

## 原策略回归验证（历史测试命令）

```bash
npm test -- --runInBand tests/antigravity-models.test.js tests/antigravity-argon.test.js tests/antigravity-custom-models.test.js tests/model-availability-ui.test.js
```

覆盖旧别名及前缀/后缀规范化、Medium 思考等级、流式/非流式上游目标、免费/付费/未知 tier 列表、混合池路由、自动模式与 Playground 模型 API，以及禁止模型的 404 和账号健康状态。
