# dsh-bundle · 服装电商运营 Agent 的 Host 侧资产（seed）

本目录是 docs/04 §2.1 四类公共扩展点的产物集合，M1 只交付 **seed 配置**；
Host 侧的 `business-bridge` 插件与真实模型链路按 docs/17 状态行在 **M3 前**完成。

```text
dsh-bundle/
├─ manifest.json                     # intent → bundle/skills/modelRoute；参与 manifestHash
├─ dsh-lock.json                     # 版本与哈希清单（docs/04 §3.3；integrity 首次锁定回填）
├─ presets/clothing-ops/1.0.0/
│  ├─ preset.yml                     # 目录发现元数据（name/description）
│  └─ agent.cordis.yml               # Cordis 组合：persona、skill、只读 MCP、工具
├─ skills/
│  ├─ brand-tone/2.1.0/SKILL.md
│  ├─ size-guide/3.0.1/SKILL.md
│  ├─ care/1.1.0/SKILL.md
│  └─ return-policy/1.3.0/SKILL.md
├─ config/
│  ├─ cordis.patch.yml               # business profile：权限预设 + 桥接插件参数（M3 启用）
│  ├─ mcp-policy.yaml                # 只读工具白名单（默认拒绝）
│  └─ mcp-servers.yaml               # MCP server 占位清单
└─ bridge/
   ├─ README.md                      # api ↔ Host 桥接契约（wire / 安全 / 失败行为）
   ├─ business-agent.ts              # Remote service 参考实现（M3）
   └─ business-bridge.ts             # Host 内精确路由 + 非 owner Peer 参考实现（M3）
```

## 安装

```bash
# 1) preset 目录发现（DSH 0.2.1-rc.2 已验证的方式）
mkdir -p "$DSH_HOME/.agent-presets"
cp -r dsh-bundle/presets/clothing-ops/1.0.0 "$DSH_HOME/.agent-presets/clothing-ops"

# 2) business profile 挂 patch（M3 起）
dsh --profile business --patch /opt/dssaas/dsh-bundle/config/cordis.patch.yml

# 3) 校验
curl -fsS -H "Authorization: Bearer $(cat /data/dsh/secrets/bridge-token)" \
  http://127.0.0.1:43180/internal/health | jq .
```

## 版本与变更

- **一个 preset**（`clothing-ops`）；intent 差异通过提示词变体 + skill 选择实现（docs/04 决策）。
- bundle 内容变更必须升版本（`1.0.0` 起），不允许原地改；`manifestHash` 进入 api 审计与
  Host `/internal/health` 对账。
- skill 与知识库同源同版本；skill 只规定表达方式，不是事实源（docs/04 X4）。
- 生产卷只读挂载；升级按 docs/04 月度窗口 + docs/17 §9 灰度。

## M1 的边界（重要）

- `apps/api` 已实现桥接 **客户端**（HTTP POST + SSE、AbortSignal、超时、重连、失败映射）；
  Host 侧 `business-bridge` 插件尚未实现，因此 M1 的流式验收使用
  `apps/api/test/support/dsh-host-stub.ts`（**协议桩**，严格实现同一 wire 契约）跑通。
- 真实 DSH Host 的接入验收（Owner→非 owner Peer、gateway stream、MCP 工具清单）在 M3
  按 `bridge/README.md` 的清单逐项回归；本目录不冒充已完成。
