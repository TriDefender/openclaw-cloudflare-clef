# Cloudflare CLEF 决策适配器

OpenClaw decision-provider 插件，用 Cloudflare Workers AI CLEF 系列模型做决策评测，不替换聊天主模型。
提供 cloudflare-clef/clef-flash（默认建议）和 cloudflare-clef/clef。

## 安装

```bash
openclaw plugins install clawhub:openclaw-cloudflare-clef
```

从源码手动安装：把插件目录放到任意路径，并在下方配置中加 `"load": {"paths": ["<插件目录>"]}`（用 `plugins install` 安装则无需 `load.paths`）。

## 配置前置（Cloudflare 侧）

1. **Account ID**：Cloudflare 仪表盘 → Workers & Pages 概览页右侧，32 位十六进制。
2. **创建 API Token**：仪表盘右上角用户头像 → My Profile → API Tokens → Create Token，权限选 **Workers AI → Run**（作用域限定到你的账户）。
3. **Token 入库**（插件只接受 SecretRef：不缓存 API Token，不读环境变量，无明文回退；值走 stdin 避免进 shell 历史）：

```bash
openclaw secrets store set CLOUDFLARE_API_TOKEN --kind secret \
  --allow-host api.cloudflare.com --value-file -
```

## 费用

- 建议 Workers Free：10,000 Neurons/UTC 日免费，用尽后平台硬限制。
- Workers Paid 同样有免费量，但超额收费；本插件不改变账户套餐，不保证 Paid 账户零支出。
- 免费量与账户内其他 Workers AI 用量共享。
- 2026-10-20 官方价：CLEF Flash 3,455 Neurons / M input tokens；
  CLEF 21,818 Neurons / M input tokens。仅按输入计价。

## 配置（合并到现有配置，保留其余插件）

```json
{
  "plugins": {
    "allow": ["cloudflare-clef"],
    "entries": {
      "cloudflare-clef": {
        "enabled": true,
        "config": {
          "accountId": "<Cloudflare Account ID>",
          "apiToken": {"source":"store","provider":"default","id":"CLOUDFLARE_API_TOKEN"}
        }
      }
    }
  },
  "agents": {"defaults": {"decisionModel":"cloudflare-clef/clef-flash"}}
}
```

缺少凭据时不设置 decisionModel，保留当前行为。

## 模型切换（clef / clef-flash）

两个模型均已注册，切换只改一处。默认跟随 `agents.defaults.decisionModel`（推荐 clef-flash）：

```bash
# 用大模型 CLEF（更强，21,818 Neurons / M input tokens）
openclaw config set plugins.entries.cloudflare-clef.config.model clef

# 用 CLEF Flash（更快更便宜，3,455 Neurons / M input tokens）
openclaw config set plugins.entries.cloudflare-clef.config.model clef-flash

# 取消固定，恢复跟随 decisionModel 的模型选择
openclaw config unset plugins.entries.cloudflare-clef.config.model
```

`config.model` 设置后对本 provider 的所有评测生效，优先级高于 decisionModel 里的模型选择；改动需 `openclaw plugins reload cloudflare-clef` 后生效。评测结果中的 `model` 字段始终回报实际调用的模型（API 回显校验，不会错报）。

**激活**：配置完成后重启网关，让插件以就绪凭据完成注册。若插件注册早于凭据入库，capability owner 会进入 degraded，`secrets reload` / `plugins reload` 均无法清除（实测），必须重启网关。

依赖宿主运行时提供的 openclaw/plugin-sdk，无需随包安装依赖。

## 翻译与边界

- boolean -> noul -> probabilityTrue；choice 保留全部概率；score 的索引对象转数组。
- 重新映射问题与选项 ID，允许中文、斜杠等 OpenClaw 标识，恢复结果原 ID。
- 使用主机 guarded fetch、取消信号、剩余 deadline 和最终同步 isAdmissible 检查。
- 无重试、无后台轮询、无收费模型自动回退；429 返回 unavailable。
- 仅支持文本/JSON 决策证据。当前主机 DecisionBatch 无图像字段，不宣称支持视觉。
- 保守输入预算：请求 UTF-8 字节数 + 1,024 + 每候选 128 不得超过 24,000；
  这是接入侧近似保护，不是厂商 tokenizer 的精确计算。
- 当前内置自动工具预筛选预算为 500ms；远程网络调用可能超时并走原有回退。
- Codex 运行时不使用该内置自动筛选；是否暴露显式 decision_evaluate 取决于活动 harness。

## 验证

`node --test protocol.test.mjs` 仅验证协议转换和拒绝异常响应；不等于已通过线上鉴权。

端到端验证：配好并重启网关后，在会话中调用 `decision_evaluate` 工具发一条真实评测——返回 `status: "ok"` 且带 `answers` 即打通；返回 `unavailable / credentials-unavailable` 说明凭据未就绪（多为插件注册早于凭据入库的 degraded，见上文激活一节）。

## 来源

- https://developers.cloudflare.com/workers-ai/models/clef-flash/
- https://developers.cloudflare.com/workers-ai/models/clef/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- OpenClaw 官方文档：docs/concepts/decision-models.md 与 docs/plugins/sdk-overview/capabilities.md
