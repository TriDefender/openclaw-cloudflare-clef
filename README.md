# Cloudflare CLEF 决策适配器

OpenClaw decision-provider 插件，用 Cloudflare Workers AI CLEF 系列模型做决策评测，不替换聊天主模型。
提供 cloudflare-clef/clef-flash（默认建议）和 cloudflare-clef/clef。

## 费用与前置条件

- Cloudflare Account ID，32 位十六进制。
- 限定该账户、具备 Workers AI Run 权限的 API Token。
- 建议 Workers Free：10,000 Neurons/UTC 日免费，用尽后平台硬限制。
- Workers Paid 同样有免费量，但超额收费；本插件不改变账户套餐，不保证 Paid 账户零支出。
- 免费量与账户内其他 Workers AI 用量共享。
- 2026-10-20 官方价：CLEF Flash 3,455 Neurons / M input tokens；
  CLEF 21,818 Neurons / M input tokens。仅按输入计价。
- 凭据只接受已由主机准备的 SecretRef，不缓存 API Token，不读环境或明文回退。

## 配置（合并到现有配置，保留其余插件）

```json
{
  "plugins": {
    "allow": ["cloudflare-clef"],
    "load": {"paths": ["<插件安装目录>/cloudflare-clef"]},
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

缺少凭据时不设置 decisionModel，保留当前行为。配置凭据后建议直接重启网关，让插件以就绪凭据完成注册：若插件注册早于凭据入库，capability owner 会进入 degraded，secrets reload / plugins reload 均无法清除（实测）。
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
真实验证必须在配置后调用宿主决策运行时，并检查插件诊断中的 last success。

## 来源

- https://developers.cloudflare.com/workers-ai/models/clef-flash/
- https://developers.cloudflare.com/workers-ai/models/clef/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- OpenClaw 官方文档：docs/concepts/decision-models.md 与 docs/plugins/sdk-overview/capabilities.md
