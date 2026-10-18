# 自定义额度适配器 / Custom quota adapters

额度适配器只读取当前模型供应商的余额或限额接口，不发送对话内容。预制供应商和用户添加的供应商使用完全相同的适配器结构、注册表、凭据读取、请求、字段映射和失败回退流程；预制项只是插件随包提供的配置。DeepSeek 和 Kimi API 是当前预制项。Kimi 预设匹配国内开放平台的 `moonshot-kimi` 快捷方式，显示人民币可用余额和代金券余额；国内站与国际站 Key 相互独立。其他供应商可在 VS Code 的 `zcode.quotaAdapters` 设置中添加配置。适配器的 `providerId` 必须与模型信息中的值完全一致；若用户配置与预制项冲突，预制项优先，冲突配置会被忽略。

当前配置协议为 v1。`schemaVersion` 可省略（按 v1 解析），也可显式写为 `1`。协议只接受 JSON 响应：单个适配器可发一个 GET/POST 请求，或并发发起最多 5 个同源请求；POST 请求体是固定 JSON（也可放固定的 GraphQL 查询）。字段通过 JSON Pointer 读取，支持数字、数字字符串、常见时间戳、百分比、金额和数量，以及受限的数值计算。它不执行脚本，也不支持 XML、动态请求参数或任意模板插值。每个响应最多 1 MiB，请求体最多 64 KiB；超出限制或映射失败时回退到 ZCode 套餐额度。一个 `providerId` 只允许一个适配器；预制项优先，重复或冲突的用户配置会被忽略。

v1 已随 1.4.7 发布。之后新增能力应使用可选字段，并保持现有字段的含义和行为稳定；若确实需要不兼容变化，应增加新的 `schemaVersion` 解析器，不得改变 v1 字段的含义。这样用户可自行维护的适配配置可以跨版本继续使用。

设置 schema 会提示当前版本尚不认识的字段；运行时会忽略未知字段，而不是因此丢弃其余有效映射。这样以后加入可选 v1 字段时，较早版本仍可使用它认识的部分。

## 配置示例

下面假设接口返回：

```json
{
  "data": {
    "limits": [
      { "name": "5 小时", "remaining_percent": 72, "remaining": 3600, "reset_at": 1790000000 },
      { "name": "每月", "remaining_percent": 35, "remaining": 17500, "reset_at": "2026-11-01T00:00:00Z" }
    ]
  }
}
```

对应设置：

```jsonc
"zcode.quotaAdapters": [
  {
    "schemaVersion": 1,
    "id": "my-provider-usage",
    "providerId": "my-provider",
    "displayName": "My provider quota",
    "endpoint": "https://api.example.com/v1/usage",
    "method": "GET",
    "auth": "bearer",
    "apiKeySource": "zcode",
    "itemsPath": "/data/limits",
    "percentScale": "0-100",
    "fields": [
      {
        "labelPath": "/name",
        "remainingPercentPath": "/remaining_percent",
        "remainingCountPath": "/remaining",
        "nextResetTimePath": "/reset_at",
        "resetTimeFormat": "auto"
      }
    ]
  }
]
```

保存后运行命令 **ZCode: Set quota API key**，选中适配器并输入 API Key。默认密钥存入 VS Code SecretStorage；留空可删除。若要复用 ZCode 中同一 `providerId` 已有的密钥，将 `apiKeySource` 设为 `zcode`。插件只读取完全匹配供应商 ID 的凭据，并要求额度接口使用该供应商配置的 HTTPS 主机；如果 ZCode 没有保存基础地址，可在适配器中填写 `providerBaseURL` 作为可信主机。对于快捷方式凭据，还可用 `providerTemplateId` 限定模板 ID。不会把密钥复制到插件设置或 webview。预制项也使用这些通用配置字段，例如 DeepSeek 和 Kimi 预设声明了可信主机和模板 ID，再按相同方式读取供应商密钥。面板可见时，扩展会在额度刷新时向配置的接口发出请求；面板隐藏后暂停刷新。接口不可用、返回值无法映射或没有配置时，继续显示原来的 ZCode 套餐额度。

`itemsPath` 和各个字段路径使用 [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)，路径以 `/` 开始。可映射剩余/已用百分比、剩余数量、重置时间和货币余额；金额需要提供三字母货币代码（如 `CNY`、`USD`），可设置固定 `currency` 或从响应读取 `currencyPath`。百分比可用 `remainingPercentPath` 或 `usedPercentPath`。`resetTimeFormat` 支持 `auto`、`unix-seconds`、`unix-milliseconds`、`iso`。

如果接口用分、毫 token 等最小单位返回数值，可配置正数除数进行显示换算：`amountDivisor` 同时应用于余额、赠金和充值金额；`countDivisor` 应用于剩余数量；单个指标使用 `valueDivisor`。预算计算和数量计算里的 `limitDivisor`、`usedDivisor` 分别换算总量与已用量。

如果接口返回的是不带上限的普通数值，例如“今日消费”“本月请求数”，可在额度行的 `metrics` 中映射，不必伪造成百分比。普通数值支持 `number` 格式和自定义单位；金额使用 `currency` 格式并提供固定 `currency` 或 `currencyPath`。`period` 会与名称一起显示；周期随响应行变化时使用 `periodPath`。带余额的行仍将余额放在主值位置，并把首个指标放在旁边；只有指标的行会把首个指标作为主值。悬停详情显示全部指标。每个指标可以直接映射一个 `valuePath`（需要换算时配 `valueDivisor`），也可以用受限算术 `calculation` 组合 2–20 个返回字段；支持 `sum`、`subtract`、`multiply`、`divide`、`min` 和 `max`，可用 `divisor` 做单位换算。计算只读取数字字段，不执行配置中的代码。示例：

```jsonc
"fields": [{
  "label": "Kimi API",
  "remainingAmountPath": "/data/available_balance",
  "currency": "CNY",
  "metrics": [
    {
      "label": "消费",
      "period": "今日",
      "valuePath": "/usage/today_cost",
      "format": "currency",
      "currency": "CNY"
    },
    {
      "label": "请求数",
      "period": "今日",
      "valuePath": "/usage/today_requests",
      "format": "number",
      "unit": "次"
    },
    {
      "label": "总消费",
      "period": "今日",
      "format": "currency",
      "currency": "CNY",
      "calculation": {
        "operation": "sum",
        "paths": ["/usage/input_cost", "/usage/output_cost"]
      }
    }
  ]
}]
```

多接口时，指标路径以请求 ID 开头，例如 `/usage/today_cost`。指标值可为有限数值或数字字符串；货币格式需要有效的 ISO 4217 代码。`metrics` 每行最多 20 项。普通余额、额度等路径仍要求非负数。

若金额上限和已用金额来自两个只读接口，可用 `requests` 最多并发查询 5 个端点，并用 `budgetCalculation` 计算剩余额度。所有端点必须处于同一 HTTPS 来源（协议、主机和端口都相同）；同一个 SecretStorage 密钥只会发到该来源。金额计算示例：

```jsonc
"zcode.quotaAdapters": [{
  "id": "monthly-budget",
  "providerId": "custom-provider-id",
  "displayName": "Monthly API budget",
  "auth": "bearer",
  "requests": [
    { "id": "usage", "endpoint": "https://api.example.com/v1/usage" },
    { "id": "plan", "endpoint": "https://api.example.com/v1/plan" }
  ],
  "fields": [{
    "label": "Monthly budget",
    "currency": "USD",
    "budgetCalculation": {
      "limitPath": "/plan/limit_usd",
      "usedPath": "/usage/used_cents",
      "usedDivisor": 100
    }
  }]
}]
```

这里的路径从请求 ID 开始，指向各自接口的 JSON Pointer。适配器按 `max(0, limit / limitDivisor - used / usedDivisor)` 显示剩余金额，并按剩余金额占换算后上限的比例显示百分比。只有接口文档明确说明单位时才填写除数；两个除数默认值均为 `1`。任一请求失败或字段无法解析时，整个适配结果会失败并沿用 ZCode 套餐额度。

如果上限是 token、请求次数等数量而不是金额，可使用 `quotaCalculation`，不需要设置 currency：

```jsonc
"fields": [{
  "label": "Monthly tokens",
  "quotaCalculation": {
    "limitPath": "/data/limit_millitokens",
    "usedPath": "/data/used_millitokens",
    "limitDivisor": 1000,
    "usedDivisor": 1000
  }
}]
```

该映射会生成剩余数量和百分比；`limitDivisor`、`usedDivisor` 分别在相减前换算两个字段。一个额度行只能使用 `quotaCalculation` 或 `budgetCalculation` 其中一种。

若余额接口返回 `{"currency":"USD","balance":"18.40","granted":"3.40","recharged":"15.00"}`，字段可写为：

```jsonc
"fields": [{
  "labelPath": "/currency",
  "remainingAmountPath": "/balance",
  "currencyPath": "/currency",
  "grantedAmountPath": "/granted",
  "toppedUpAmountPath": "/recharged"
}]
```

认证方式为 `none`、`bearer` 或 `header`；`header` 使用 `authHeaderName` 指定密钥请求头，可选的 `authHeaderPrefix` 会加在密钥前（例如 `Authorization` + `Token `）。`apiKeySource` 默认为 `secretStorage`，也可设为 `zcode` 复用 ZCode 中同一供应商的密钥；复用时只允许访问该供应商配置的 HTTPS 主机，或显式配置的 `providerBaseURL` 主机（HTTP 基础地址可升级到 HTTPS 默认端口）。`providerTemplateId` 可进一步限定 ZCode 快捷方式的模板 ID。可用 GET 或 POST，POST 只能配置固定 JSON 请求体，不支持在 URL、请求体或普通请求头中插入密钥。仅接受 HTTPS；无认证的本机 `localhost` HTTP 可用于本地服务。接口跳转不会跟随，响应上限为 1 MiB。

## English

Quota adapters make read-only requests to the active model provider's balance or limit endpoint. They never send chat content. Packaged presets and user-added providers use the same adapter structure, registry, credential lookup, request, field mapping, and fallback path; a preset is simply configuration shipped with the extension. DeepSeek and Kimi API are currently packaged presets. The Kimi preset matches the domestic Open Platform `moonshot-kimi` shortcut and displays the available and voucher balances in CNY; domestic and international Kimi keys are separate. Other providers can be added in VS Code's `zcode.quotaAdapters` setting. `providerId` must exactly match the active model's provider ID. A preset wins if a user setting conflicts with its ID or provider ID; the conflicting setting is ignored.

The configuration protocol is currently v1. `schemaVersion` is optional (omission means v1) and may be set to `1`. It accepts JSON responses and supports one GET/POST request or up to five concurrent requests to the same origin. POST bodies are fixed JSON and may contain a static GraphQL query. Fields use JSON Pointer and support numeric values, numeric strings, common timestamps, percentages, balances, counts, and bounded arithmetic. The adapter does not execute scripts or support XML, dynamic request parameters, or arbitrary template interpolation. Each response is limited to 1 MiB and each request body to 64 KiB. A failed request or mapping falls back to the ZCode plan quota. Only one adapter may match a `providerId`; packaged presets take precedence, and duplicate or conflicting user entries are ignored.

After release, prefer optional fields for additions and keep existing field meanings stable. An incompatible change should add a new `schemaVersion` parser instead of changing v1 semantics. The current protocol can still be adjusted before release.

The settings schema flags fields unknown to the current extension version. At runtime, unknown fields are ignored instead of invalidating the rest of an adapter, so older versions can keep using mappings they understand when optional v1 fields are added later.

The example above maps rows from `/data/limits`. Run **ZCode: Set quota API key** to select the adapter and store its API key in VS Code SecretStorage (the default). Set `apiKeySource` to `zcode` to reuse a key already stored for the exact same provider ID; requests are restricted to that provider's configured HTTPS host, or the explicitly configured `providerBaseURL` host when ZCode has no base URL. `providerTemplateId` can further restrict which ZCode shortcut template supplies the key. The key is not copied into extension settings or the webview. Packaged presets use the same options; for example, the DeepSeek and Kimi presets declare their trusted hosts and shortcut templates, then read the provider key through this path. While the chat panel is visible, the adapter is queried during quota refreshes; refresh pauses while hidden. If no adapter matches, or the request or mapping fails, the existing ZCode plan quota remains the fallback.

`itemsPath` and field paths use [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901). Map remaining or used percentage, remaining count, reset time, and monetary balances. Amounts need a three-letter currency code. Reset times accept ISO text or Unix seconds/milliseconds. Authentication can be `none`, `bearer`, or a custom `header`; `authHeaderName` selects the header and optional `authHeaderPrefix` is prepended to the stored key (for example, `Authorization` with `Token `). `apiKeySource` can use VS Code SecretStorage (default) or reuse the key for the exact ZCode provider ID, restricted to that provider's configured HTTPS host or the explicit `providerBaseURL`. `providerTemplateId` optionally limits the shortcut template. Requests use GET or POST with a fixed JSON body. Secrets cannot be interpolated into URLs, bodies, or ordinary headers. HTTPS is required, except unauthenticated HTTP on localhost. Redirects are not followed, and responses are limited to 1 MiB.

When an API reports minor units such as cents or milli-tokens, positive divisors normalize values before display: `amountDivisor` applies to mapped balance amounts, `countDivisor` to the remaining count, and `valueDivisor` to one directly mapped metric. `limitDivisor` and `usedDivisor` independently normalize calculated limits and usage.

For standalone readings with no quota ceiling, such as today's spend or this month's request count, add `metrics` to a field. Metrics support localized number or currency formatting, an optional unit, a display label, and an optional period. Use `periodPath` when the period is supplied by each response row. They appear as ordinary values rather than invented percentages. A balance row keeps its balance as the main value and shows the first metric beside it; a metrics-only row uses its first metric as the main value. Hover details include every mapped metric. Each row supports up to 20 metrics. A metric can use one `valuePath` or a restricted `calculation` over 2–20 response paths. Supported operations are `sum`, `subtract`, `multiply`, `divide`, `min`, and `max`; `subtract` and `divide` take exactly two paths. An optional positive `divisor` scales the result, for example to convert cents. Calculations read numeric fields only and never evaluate code. For multiple requests, prefix paths with the request ID, such as `/usage/today_cost`.

```jsonc
{
  "label": "Total spend",
  "period": "Today",
  "format": "currency",
  "currency": "CNY",
  "calculation": {
    "operation": "sum",
    "paths": ["/usage/input_cost", "/usage/output_cost"]
  }
}
```

When the budget and usage come from separate read-only endpoints, configure up to five `requests` and a `budgetCalculation`. Every request must use the same HTTPS origin, and the saved key is sent only to that origin. Calculation paths start with the request ID. The adapter displays `max(0, limit / limitDivisor - used / usedDivisor)` as the remaining balance and derives its percentage from the normalized limit. Set a divisor only when the API documentation confirms the units differ; both divisors default to `1`. A failed request or unmappable value falls back to the existing ZCode plan quota.

For non-monetary limits such as tokens or requests, use `quotaCalculation` instead. It derives a remaining count and percentage from `limitPath` and `usedPath` without requiring a currency. One quota row can use either `budgetCalculation` or `quotaCalculation`, not both.
