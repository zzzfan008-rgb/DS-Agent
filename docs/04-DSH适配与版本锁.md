# 04 · DSH 适配与版本锁

| 项 | 内容 |
|---|---|
| 编号 | 04（对应总纲 §3.2「DSH 的定位与复用边界」/ §19.4「DSH 版本与升级」/ §十五 M0「DSH 版本锁定」） |
| 用途 | 定义 DSH 作为 agent 内核的接入方式：哪些组件复用、从哪些公共扩展点接入、版本如何锁死、每月怎么升级、升级后回归什么、上游停更怎么办。目的只有一个：**DSH 的发布节奏不能变成业务停摆风险** |
| 读者 | 架构（主责）、后端（接入 `dsh-bundle` 与 Remote）、运维/管理员（升级窗口、镜像、凭据）、测试（回归清单）、决策人（停更兜底的取舍） |
| 依赖 | `docs/00-方案总纲.md` §3.2、§5.1、§19.1、§19.4、附录 A；npm 注册表与本地安装目录；`dsh-bundle/`（preset + MCP 配置 + Remote service）；`infra/`（持久卷） |
| 状态 | 草案 v0.1（2026-10-20）。**版本锁策略、四类扩展点、升级流程与回归清单已可执行**；具体版本号与 integrity 待首次锁定时回填；停更兜底为设计态，未演练 |
| 版本 | v0.1；首次锁定后升 v1.0 |

> **一句话原则**：**只从公开缝里接，只按精确版本跑，只在窗口里升，只有清单全绿才算升成功。** 三条红线：不 fork 内部包、不 import 未公开路径、不自动跟随 latest。

---

## 0. 事实基线与结论

### 0.1 版本事实（截至 2026-10-20，来源见总纲附录 A）

| # | 事实 | 值 | 来源 | 对我们的含义 |
|---|---|---|---|---|
| F1 | 当前内核版本 | `0.2.1-rc.2`（**预发布通道**） | npm 注册表与本地安装目录 | 预发布 = 允许破坏性变更，不能当稳定版用 |
| F2 | 累计发布版本数 | 36 | npm 注册表 | 迭代密度高，行为漂移是常态而非异常 |
| F3 | 2026-10-09 至 2026-10-17（9 天） | 5 个 alpha/rc | npm 版本时间线 | 平均 **1.8 天/版**（9÷5，推导值） |
| F4 | `@deepseek-ai/*` 包规模 | 311 个 | 本地 `node_modules` | 依赖面大，无法逐个审阅；只能靠版本锁 + 回归清单控风险 |
| F5 | 桌面端版本 | 2.0.18 | 本地安装目录 | 桌面端仅管理员调试用，不进业务流程（总纲 §5.1） |

### 0.2 由事实推出的三条结论

1. **必须精确锁定，禁止版本范围**。1.8 天/版的节奏下，「`^0.2.1`」这类范围会让任意一次 `npm install` 在两周内跨过 5–7 个版本，行为漂移无法归因。
2. **必须月度窗口 + 回归清单**。天天跟版会让回归成本吃掉全部开发产能；不跟版则累积到无法升级。折中是「每月一次、只升一档、清单全绿」。
3. **必须预设停更兜底**。预发布 + 快速迭代的上游，随时可能改语义或停止分发；总纲 §19.4 已定「核心链路不依赖 agent loop」，本文 §六 把它写成可演练的路径。

### 0.3 风险定级

| 风险 | 触发信号 | 现等级 | 处理 |
|---|---|---|---|
| 升级导致 preset 加载失败 | 启动报错、agent 无法创建 | 高 | 版本锁 + 回归 R1 |
| skill 发现失效（目录/格式变化） | 工作台技能列表为空 | 中 | 回归 R2 + 启动自检 |
| MCP 工具 schema 变化 | 工具调用参数被拒 | 中 | 回归 R3 + 契约用例 |
| Host 常驻/流式 Remote 退化 | 首 token 延迟暴涨、取消无效 | 高 | 回归 R4 + 压测 |
| 存储语义变化（`0o700`、root 必填） | 启动失败或数据不可写 | 中 | 回归 R5 + 卷权限检查 |
| Typert 调用/取消语义变化 | 取消后仍产生副作用 | 高 | 回归 R6 + 幂等兜底 |

---

## 一、复用清单与适配点

> 来自总纲 §3.2，这里补「扩展点类型 / 稳定性风险 / 失败影响 / 兜底」四列，作为升级时的重点观察对象。

| # | 能力需求 | 复用组件 | 扩展点类型（§二） | 稳定性风险 | 失败影响 | 兜底 |
|---|---|---|---|---|---|---|
| 1 | 文本模型多供应商路由 | `dsh-llm-pi-ai` | 配置（非代码） | 中：配置 schema 可能变 | 文案/客服生成全断 | 直连供应商 HTTP（§6.3） |
| 2 | 供应商密钥存储 | `dsh-credentials` | 配置 + 目录 | 高：**未声明静态加密**（附录 A） | 密钥丢失或泄露 | 加密表 + 轮换预案 |
| 3 | 内部 RPC 与授权 | `dsh-api-gateway` + `dsh-api-remote-access` | Remote service + 配置 | 高：流式/取消/principal 语义 | 工作台不可用 | 自建 HTTP+SSE 通道 |
| 4 | 沙箱与审批档位 | `dsh-permission-presets` + `dsh-user-approval` | 配置 | 中 | 越权或审批失效 | 写入门硬校验（已在业务侧） |
| 5 | Skill / MCP | `dsh-skill-filesystem`、`dsh-mcp-client`、`dsh-mcp-resources` | Skill 目录、MCP server | 中 | 品牌语气/尺码口径丢失 | 提示词内置 + 自建 MCP |
| 6 | Agent 工作台打包 | `dsh-agent-preset` | Preset（Cordis 组合） | 高：组合语法可能变 | preset 加载失败 | 最小 preset + 手工等价调用 |
| 7 | 平台回调触发 | `dsh-webhook` | 配置 | 中 | 回调丢失 | 轮询兜底 + 队列 |
| 8 | 批处理/定时/CI | `dsh-headless` | CLI（`--json`、`--session-id`） | 低：一次性任务语义简单 | 批处理失败 | worker 直接调模型 |
| 9 | 会话留痕 | `dsh-session-persistence-jsonl` | 目录（只读调试） | 低 | 无可调试轨迹 | 无（不影响业务） |
| 10 | 业务流程 | **不用** `dsh-workflow`（agent 扇出，非业务引擎） | — | — | — | BullMQ + Postgres（总纲 §四） |
| 11 | 业务数据 | **不用** `dsh-storage-json`（root 必填、`0o700`、官方建议大数据用 SQLite） | — | — | — | Postgres + MinIO |

**适配点小结**：真正需要写代码的只有三处——`dsh-bundle/` 里的 **preset 定义**、**Remote service 定义**、**MCP 配置**；其余全是配置与目录约定。这也是「只用公共缝」的可行性基础。

---

## 二、四类公共扩展点与禁止项

### 2.1 允许使用的四类扩展点

| # | 扩展点 | 允许的具体用法 | 产物位置（本项目） | 契约依据 | 升级影响面 | 验收方式 |
|---|---|---|---|---|---|---|
| 1 | **MCP server** | 自建 MCP server（stdio 或 HTTP），以 `dsh-mcp-client` 接入；只暴露工具与资源 | `packages/mcp-erp`、`packages/mcp-knowledge`；配置进 `dsh-bundle/` | MCP 协议 + 工具 JSON Schema | 中：工具 schema 与资源读取 | 回归 R3 |
| 2 | **Skill** | 目录形式 skill（含 frontmatter），由 `dsh-skill-filesystem` 发现 | `dsh-bundle/skills/{brand-tone,size-guide,care,return-policy}/` | skill 目录与元数据格式 | 低：发现失败会静默丢技能 | 回归 R2 |
| 3 | **Agent preset** | 一个「服装电商运营」preset，组合四组工具与技能；仅描述组合，不写业务逻辑 | `dsh-bundle/presets/clothing-ops/` | `dsh-agent-preset` 的组合语法 | 高：组合语法与挂载点变化 | 回归 R1 |
| 4 | **Plugin bundle** | Cordis bundle patch（insert/override/group/disabled），用于把上述产物装配成一个可发布单元 | `dsh-bundle/`（含 `cordis.yml` 或等价 bundle 描述） | Loader YAML 方言 | 中：patch 语义变化 | 回归 R1 + 启动自检 |

**使用规则**

| 编号 | 规则 |
|---|---|
| X1 | 四类扩展点之外，不新增任何对 DSH 内部结构的依赖 |
| X2 | preset 与 bundle 里只做「组合与配置」，不做业务判断（价格、库存、审批一律在 `apps/api`） |
| X3 | 每个 MCP server 必须有独立版本号与健康检查；工具列表变化视为契约变更 |
| X4 | skill 内容（语气、尺码口径、退换政策）必须与知识库同源同版本；skill 只是检索/表达方式，不是事实源 |
| X5 | 所有扩展点产物纳入 `dsh-lock.json` 的哈希清单（§3.3） |

### 2.2 禁止项（含检测方法）

| # | 禁止项 | 为什么禁 | 检测方法（CI 可跑） | 违规后果 |
|---|---|---|---|---|
| Z1 | fork 内部包（复制 `@deepseek-ai/*` 源码改） | 上游一改即失同步；回归清单失效 | `git ls-files | grep -E '@deepseek-ai' ` 应为空；仓库内不得出现 `packages/dsh-*` 副本 | 升级时出现无法解释的行为差异 |
| Z2 | import 未公开路径（深路径、`dist/`、非 `exports` 导出） | 内部结构随时变，属于未承诺契约 | `grep -rnE "from ['\"]@deepseek-ai/[^'\"]+/(dist|lib|internal|src)/" --include=*.ts --include=*.mts .` 应为空 | 升级即崩 |
| Z3 | 修改 `node_modules`（`patch-package`、`postinstall` 打补丁） | 不可复现，镜像与本地不一致 | 检查 `package.json` 无 `patch-package`、无改依赖的 `postinstall`；`git ls-files | grep patches/` 为空 | 生产无法重建 |
| Z4 | 把 `.jsonl` 会话文件当业务读路径 | 总纲 §17 静态规则；格式随时变 | `grep -rn "\.jsonl" apps packages --include=*.ts` 只允许出现在调试脚本白名单 | 数据错乱，M9 验收不过 |
| Z5 | 依赖未文档化的事件名/字段 | 沉默失败 | 代码评审 + `grep -rnE "dsh(Event|Internal|Private)"` | 行为漂移无法发现 |
| Z6 | 把 `dsh-llm-pi-ai` 当库 import 直调 | 绕过凭据与路由，密钥扩散 | `grep -rn "dsh-llm-pi-ai" apps packages --include=*.ts` 只允许出现在配置/文档 | 密钥管理与计量失效 |
| Z7 | 读 DSH 存储根或凭据文件 | 越界；凭据不可读回显 | `grep -rn "storage-json\|credentials" apps --include=*.ts` 只允许引用「是否已配置」类型接口 | 安全事故 |
| Z8 | 用 `dsh-workflow` 当业务流程引擎 | 它没有持久化/幂等/人工节点 | `grep -rn "dsh-workflow" apps` 应为空 | 流程状态丢失 |
| Z9 | 用 `dsh-storage-json` 承载业务数据 | `root` 必填、`0o700`，官方建议大数据用 SQLite | `grep -rn "dsh-storage" apps` 应为空 | 数据不可迁移 |
| Z10 | 版本写范围（`^`/`~`/`*`/`latest`） | 直接破坏版本锁 | CI 检查 `package.json` 中 `@deepseek-ai/*` 必须精确版本（§3.5 R1） | 漂移不可控 |
| Z11 | 直改桌面端安装目录 / 全局 npm 目录 | 与交付物无关，不可备份 | 部署脚本不得出现 `Program Files`、`AppData` 写入 | 环境不可复现 |

**CI 静态检查（可直接粘进 `scripts/check-dsh-lock.mjs` 之外的独立步骤）**

```bash
# Z1/Z3：不得有内部包副本或补丁
! git ls-files | grep -qE '(^|/)packages/dsh-|(^|/)patches/'

# Z2：不得深路径 import
! grep -rnE "from ['\"]@deepseek-ai/[^'\"]+/(dist|lib|internal|src)/" --include='*.ts' --include='*.mts' apps packages dsh-bundle

# Z4：业务代码不得读 .jsonl
! grep -rn '\.jsonl' apps packages --include='*.ts'

# Z6/Z9：不得直连内部实现
! grep -rnE "dsh-llm-pi-ai|dsh-storage|dsh-workflow" apps packages --include='*.ts'

# Z10：@deepseek-ai 依赖必须精确版本
node -e '
const p=require("./package.json");
const bad=[];
for (const s of ["dependencies","devDependencies","optionalDependencies"]) {
  for (const [k,v] of Object.entries(p[s]||{})) {
    if (k.startsWith("@deepseek-ai/") && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) bad.push(`${s} ${k}@${v}`);
  }
}
if (bad.length) { console.error("非精确版本:", bad); process.exit(1); }
console.log("ok: 版本均为精确值");
'
```

---

## 三、版本锁的具体做法

### 3.1 锁定对象（六类，全部要锁）

| # | 对象 | 锁在哪 | 为什么必须锁 |
|---|---|---|---|
| 1 | `@deepseek-ai/*` 包版本 | `package.json`（精确值）+ lockfile | 行为主体 |
| 2 | 传递依赖版本 | lockfile + `overrides`/`resolutions` | 上游可能放宽传递依赖范围 |
| 3 | Node 运行时 | `engines` + `.nvmrc` + 镜像基础镜像 tag | 不同 Node 行为差异 |
| 4 | preset / bundle 定义 | `dsh-lock.json` 记 sha256 | 组合语法与我们的定义都可能变 |
| 5 | skill 内容 | `dsh-lock.json` 记每个 skill 目录的 sha256 | 静默丢技能无法感知 |
| 6 | MCP server 版本与工具清单 | `dsh-lock.json` 记版本 + 工具名列表哈希 | 工具 schema 变化最易沉默失败 |

### 3.2 依赖声明：精确版本 + 覆盖（resolutions / overrides）

`package.json` 片段（本项目根，示意；首次锁定时把 `0.2.1-rc.2` 换成实测版本）：

```json
{
  "name": "dssaas",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20.11.0 <21" },
  "dependencies": {
    "@deepseek-ai/dsh": "0.2.1-rc.2"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-headless": "0.2.1-rc.2"
  },
  "overrides": {
    "@deepseek-ai/dsh": "0.2.1-rc.2",
    "@deepseek-ai/dsh-api-gateway": "0.2.1-rc.2",
    "@deepseek-ai/dsh-agent-preset": "0.2.1-rc.2",
    "@deepseek-ai/dsh-mcp-client": "0.2.1-rc.2",
    "@deepseek-ai/dsh-skill-filesystem": "0.2.1-rc.2"
  },
  "pnpm": {
    "overrides": {
      "@deepseek-ai/dsh": "0.2.1-rc.2"
    }
  }
}
```

| 用例 | 说明 |
|---|---|
| 术语对齐 | Yarn 叫 `resolutions`、npm 叫 `overrides`、pnpm 叫 `pnpm.overrides`，语义相同：强制整棵依赖树用同一版本。本项目以 pnpm 为主，同时写 `overrides` 兜底 npm；若改用 Yarn，`resolutions` 等价替换即可 |
| 双写 `overrides` 与 `pnpm.overrides` | 两种包管理器都覆盖；避免有人用 npm 装出另一棵树 |
| `overrides` 里也必须是精确版本 | **禁止**区间，否则覆盖形同虚设 |
| `engines` + `engine-strict` | 见 `.npmrc`：`engine-strict=true` |
| 不提交 `latest` | 镜像 tag、CI cache key、文档示例一律用精确版本 |

`.npmrc`（仓库根，强制精确与可复现）：

```ini
save-exact=true
engine-strict=true
package-lock=true
fund=false
audit=false
```

### 3.3 自有清单 `dsh-lock.json`（单一事实源）

> lockfile 只锁 npm 依赖；preset / skill / MCP 工具清单锁不住，所以要有这份自有清单。它是 CI 比对与升级评审的输入。

```json
{
  "schemaVersion": 1,
  "lockedAt": "2026-10-20T00:00:00+08:00",
  "lockedBy": "architect",
  "channel": "rc",
  "node": "20.11.0",
  "dsh": {
    "version": "0.2.1-rc.2",
    "integrity": "sha512-<从 lockfile 抄>",
    "resolved": "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.2.tgz"
  },
  "packages": {
    "@deepseek-ai/dsh-api-gateway": "0.2.1-rc.2",
    "@deepseek-ai/dsh-agent-preset": "0.2.1-rc.2",
    "@deepseek-ai/dsh-mcp-client": "0.2.1-rc.2",
    "@deepseek-ai/dsh-skill-filesystem": "0.2.1-rc.2"
  },
  "bundle": {
    "path": "dsh-bundle",
    "sha256": "<目录内容哈希>"
  },
  "skills": [
    { "name": "brand-tone", "path": "dsh-bundle/skills/brand-tone", "sha256": "<...>" }
  ],
  "mcp": [
    { "name": "erp-readonly", "version": "0.1.0", "transport": "stdio", "toolsHash": "<工具名列表哈希>" }
  ]
}
```

| 字段 | 用途 |
|---|---|
| `dsh.version` + `integrity` | 与 lockfile 对账，防「装了别的版本」 |
| `packages` | 我们显式依赖并可能 import 的包（其余靠 lockfile） |
| `bundle.sha256` | preset/bundle 被谁改过一目了然 |
| `skills[].sha256` | skill 静默丢失或改动的检测点 |
| `mcp[].toolsHash` | 工具 schema 变更的第一信号 |

### 3.4 CI 校验（锁闸门）

`.github/workflows/ci.yml` 片段（或等价 GitLab CI）：

```yaml
name: ci
on: [pull_request, push]
jobs:
  lock-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: 'pnpm' }
      - run: corepack enable && pnpm install --frozen-lockfile
      - name: 锁校验
        run: node scripts/check-dsh-lock.mjs
      - name: 锁文件是否被改（非升级 PR 必须无 diff）
        run: |
          if [ "${{ contains(github.event.pull_request.labels.*.name, 'dsh-upgrade') }}" != "true" ]; then
            git diff --exit-code -- pnpm-lock.yaml package.json dsh-lock.json
          else
            echo "升级 PR：允许 diff，但仍需 check-dsh-lock 通过"
          fi
      - name: 依赖范围静态检查
        run: node scripts/check-dsh-ranges.mjs
      - name: 禁项扫描
        run: bash scripts/check-dsh-forbidden.sh
```

`scripts/check-dsh-lock.mjs`（可执行骨架）：

```js
#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);

const lock = JSON.parse(readFileSync('dsh-lock.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// R1 精确版本
for (const s of ['dependencies', 'devDependencies']) {
  for (const [k, v] of Object.entries(pkg[s] || {})) {
    if (k.startsWith('@deepseek-ai/') && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) fail(`R1 非精确版本 ${k}@${v}`);
  }
}
// R2 overrides 精确
for (const k of Object.keys(pkg.overrides || {})) {
  const v = pkg.overrides[k];
  if (k.startsWith('@deepseek-ai/') && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) fail(`R2 overrides 区间 ${k}@${v}`);
}
// R3 实际安装版本 == 锁
try {
  const installed = JSON.parse(execSync('node -p "JSON.stringify(require(\'@deepseek-ai/dsh/package.json\').version)"').toString().trim());
  if (installed !== lock.dsh.version) fail(`R3 安装版本 ${installed} != 锁定 ${lock.dsh.version}`);
  else ok('R3 版本一致 ' + installed);
} catch { fail('R3 无法读取已安装的 @deepseek-ai/dsh'); }

// R4 bundle / skills 哈希
const hashDir = (p) => {
  const out = execSync(`git ls-files ${p} | sort | xargs sha256sum`).toString();
  return createHash('sha256').update(out).digest('hex');
};
if (existsSync(lock.bundle.path)) {
  const h = hashDir(lock.bundle.path);
  if (h !== lock.bundle.sha256) fail(`R4 bundle 哈希漂移（改 bundle 请同时更新 dsh-lock.json）`);
  else ok('R4 bundle 哈希一致');
}
for (const s of lock.skills || []) {
  if (!existsSync(s.path)) fail(`R4 skill 缺失 ${s.path}`);
}

// R5 禁项
const forbidden = [
  ['patches/', '存在 patches/ 目录（禁止打补丁）'],
  ['packages/dsh-', '存在内部包副本'],
];
for (const [needle, msg] of forbidden) {
  if (execSync('git ls-files', { encoding: 'utf8' }).includes(needle)) fail(`R5 ${msg}`);
}
process.exit(process.exitCode || 0);
```

### 3.5 校验规则清单（CI 必过）

| 编号 | 规则 | 失败含义 | 处置 |
|---|---|---|---|
| R1 | `@deepseek-ai/*` 依赖必须是精确版本 | 有人加了范围 | 改精确值 |
| R2 | `overrides`/`pnpm.overrides` 不得含区间 | 覆盖失效 | 改精确值 |
| R3 | 实际安装版本 == `dsh-lock.json` | 环境与锁不一致 | `pnpm install --frozen-lockfile` 重建 |
| R4 | bundle / skills / mcp 工具哈希一致 | 有人改了扩展点没更新锁 | 更新 `dsh-lock.json` 并在 PR 说明 |
| R5 | 无 `patches/`、无内部包副本、无深路径 import | 触碰禁止项 | 回退改法 |
| R6 | 非 `dsh-upgrade` PR 不得改 lockfile / `package.json` / `dsh-lock.json` | 暗改依赖 | 拆 PR 或打标签 |
| R7 | 生产镜像 digest 与升级 PR 合并后构建一致 | 用 tag 而非 digest 部署 | 部署脚本改 digest |
| R8 | 升级 PR 必须附回归报告链接（§五 清单） | 无证据升级 | 补跑回归 |

### 3.6 漂移处置

| 场景 | 处置 |
|---|---|
| CI 报 R1/R2 | 改回精确版本，不接受「临时放宽」 |
| CI 报 R3 | 清缓存重装；仍失败则查 lockfile 与 registry 一致性 |
| CI 报 R4 | 确认扩展点变更是本意 → 更新 `dsh-lock.json`；否则回退 |
| 本地能跑、CI 不能 | 99% 是 lockfile 未提交或 Node 版本不同 → 对 `.nvmrc` |
| 上游发布新版但未升级 | **正常状态**。`pnpm outdated` 只做信息提示，不进 CI 失败项 |

---

## 四、月度升级流程

### 4.1 窗口与节奏

| 项 | 规定 |
|---|---|
| 频率 | 每月 1 次；固定「每月第一个周二 22:00–24:00」（业务低峰，避开上新与大促） |
| 幅度 | 只升一档（`rc.x → rc.y` 或 `rc → rc`）；跨多个版本时先升到中间版本再观察一周，不一次跳 |
| 冻结 | 窗口前 7 天冻结 `dsh-bundle/` 与依赖改动（只允许修 bug） |
| 责任人 | 升级执行：后端 1 人；回归：测试 1 人；值守：管理员 1 人 |
| 最长跳过 | 连续 2 个月不升级 → 触发 §六 的停更评估（不是自动切换，是正式评估） |

### 4.2 时间线（D = 窗口日）

| 时间 | 阶段 | 动作 | 产出 | 门禁 |
|---|---|---|---|---|
| D-7 | 情报 | 读 release notes / CHANGELOG，逐条分类（breaking / feature / fix） | 变更摘要（贴 PR） | 有 breaking 必须先评估影响面 |
| D-5 | 预演 | 在 `staging` 分支升级，跑 §五 全部回归 | 预演报告 | 任一 R 项失败 → 本月中止 |
| D-3 | 准备 | 打镜像 tag（`dsh:<当前版本>-<日期>`）、备份 Postgres 与 DSH 持久卷 | 镜像 + 备份 | 备份可恢复性抽查 |
| D0 22:00 | 执行 | 改 `package.json` + `dsh-lock.json` → `pnpm install` → 重建镜像 → 部署 staging → 冒烟 | 升级 PR | 冒烟通过 |
| D0 23:00 | 生产 | 灰度 1 个内部账号 30 分钟 → 全量 | 发布记录 | 错误率、首 token 延迟、取消成功率 |
| D+1 | 观察 | 看指标与告警；抽 3 个真实任务 | 观察记录 | 无异常 |
| D+3 | 收口 | 合并、更新文档、关闭变更工单 | 升级报告 | R1–R8 全绿 |
| 失败 | 回滚 | 用 D-3 的镜像 digest 回滚；`dsh-lock.json` 回退 | 回滚记录 + 复盘 | 24h 内出结论 |

### 4.3 升级执行命令（可复制）

```bash
# 0) 前置：确认当前锁定版本
node -p "require('./dsh-lock.json').dsh.version"

# 1) 升级（示例：0.2.1-rc.2 → 0.2.1-rc.3）
pnpm add -E @deepseek-ai/dsh@0.2.1-rc.3
pnpm add -E -D @deepseek-ai/dsh-headless@0.2.1-rc.3

# 2) 同步 overrides（保持与安装版本一致）
node -e '
const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));
const v=require("./node_modules/@deepseek-ai/dsh/package.json").version;
for (const k of Object.keys(p.overrides||{})) if (k.startsWith("@deepseek-ai/")) p.overrides[k]=v;
if (p.pnpm?.overrides) for (const k of Object.keys(p.pnpm.overrides)) if (k.startsWith("@deepseek-ai/")) p.pnpm.overrides[k]=v;
fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");
console.log("overrides →", v);
'

# 3) 冻结安装（验证可复现）
pnpm install --frozen-lockfile

# 4) 更新自有锁清单（版本 + integrity）
node scripts/update-dsh-lock.mjs --version 0.2.1-rc.3

# 5) 锁校验 + 回归
node scripts/check-dsh-lock.mjs
pnpm -w run test:regression:dsh

# 6) 记录证据
mkdir -p docs/evidence/dsh/$(date +%F) && cp dsh-lock.json docs/evidence/dsh/$(date +%F)/

# 7) 回滚（若失败）：恢复镜像 digest 与锁文件
git checkout -- package.json pnpm-lock.yaml dsh-lock.json
```

---

## 五、升级回归清单（逐项可勾选）

> 六项必跑（总纲 §19.4 指定），其余为补充。**任一项失败 = 本次升级不通过**，不得「先上再修」。

| # | 检查项 | 具体操作 | 通过判据 | 结果 | 证据 |
|---|---|---|---|---|---|
| **R1** | **preset 加载** | 启动 Host，加载 `dsh-bundle` 的「服装电商运营」preset；创建 1 个 agent 会话 | 无报错；会话可用；四组工具与四类 skill 均挂载；`GET /health` 报告 preset 名与版本 | ☐ | 启动日志 + 截图 |
| **R2** | **skill 发现** | 在工作台触发「品牌语气」「尺码建议」「洗护」「退换货」四个 skill；统计发现数量 | 4/4 被发现且可调用；内容与 `dsh-lock.json` 哈希一致 | ☐ | skill 列表截图 |
| **R3** | **MCP 工具** | 分别调用 `mcp-erp`（只读商品/库存）与 `mcp-knowledge`（检索）各 2 个工具；校验入参 schema | 工具列表与 `toolsHash` 一致；调用成功；非法入参被正确拒绝 | ☐ | 调用日志 + 工具清单 diff |
| **R4** | **Host 常驻与流式调用** | 常驻 Host 连续运行 2 小时；`@Remote({mode:'stream'})` 拉 5 次流式响应；中途取消 2 次 | 首 token P95 ≤ 基线；流式分片连续无乱序；`AbortSignal` 取消后 1 秒内停止产出；常驻无内存持续增长 | ☐ | 延迟表 + 取消日志 |
| **R5** | **存储读写** | 对 DSH 持久卷做：配置读、凭据「是否已配置」查询、会话落盘、重启后恢复 | 目录权限仍为 `0o700`；重启后配置与凭据引用仍可用；`.jsonl` 只作调试、业务不读 | ☐ | 卷权限 `ls -l` + 重启记录 |
| **R6** | **Typert 调用与取消** | 经 Remote 发起 3 次有界任务（文案/尺寸问答/客服草稿）；2 次成功、1 次中途取消；取消后检查副作用 | 调用鉴权按 peer principal 生效；取消后无后续工具调用与写入；失败返回结构化错误 | ☐ | 调用记录 + 副作用检查 |
| R7 | webhook 回调 | 模拟平台回调 2 次（含重复回调） | 工作流被触发 1 次（去重生效） | ☐ | 回调日志 |
| R8 | headless 批处理 | `dsh-headless --json` 跑 1 个批任务；再跑一次带 `--session-id` 续接 | 事件流为合法 JSON Lines；任务退出码 0；续接生效 | ☐ | 事件流文件 |
| R9 | 权限三档 | 以 viewer / operator / admin 各调 1 次越权动作 | 越权被拒且留审计；无「界面隐藏但接口可调」 | ☐ | 审计记录 |
| R10 | 并发与长上下文 | 10 并发流式会话；1 个长上下文任务（接近窗口上限） | 无串话；无超时雪崩；长上下文不丢引用 | ☐ | 压测摘要 |
| R11 | 中文与编码 | 生成含中文、emoji、全角符号的文案并落库 | 无乱码；数据库与页面一致 | ☐ | 抽样截图 |
| R12 | 回滚可行性 | 用 D-3 镜像 digest 在 staging 回滚一次 | 5 分钟内回到可用；数据无丢失 | ☐ | 回滚记录 |

**回归执行命令（示例入口，具体用例名随实现调整）**

```bash
# 全量回归（CI 与本地同源）
pnpm -w run test:regression:dsh

# 单跑六项
pnpm -w run test:dsh:preset      # R1
pnpm -w run test:dsh:skills      # R2
pnpm -w run test:dsh:mcp         # R3
pnpm -w run test:dsh:stream      # R4
pnpm -w run test:dsh:storage     # R5
pnpm -w run test:dsh:typert      # R6

# 保存本次回归证据
mkdir -p docs/evidence/dsh/$(date +%F) && pnpm -w run test:regression:dsh | tee docs/evidence/dsh/$(date +%F)/regression.log
```

**判定规则 T1（升级放行）**：R1–R6 全绿 + 其余项无「失败」+ 冒烟通过 + 无新增 P0 缺陷 → 放行；任一 R1–R6 失败 → 中止并回滚，记录在升级报告。
**判定规则 T2（连续失败）**：同一版本连续两次升级失败 → 跳过该版本，等下个版本；连续两个版本失败 → 触发 §六 评估。

---

## 六、停更兜底路径

### 6.1 触发条件（客观、可判）

| # | 条件 | 判据 |
|---|---|---|
| S1 | 上游连续 2 个月无新版本，或新版本无法升级（回归不过） | 版本时间线 + 升级报告 |
| S2 | 上游宣布停止维护 / 改变分发方式 / 许可证变化 | 官方公告 |
| S3 | 关键能力连续两版回归失败（流式 RPC、preset 加载、Typert 取消） | 回归记录 |
| S4 | 升级成本（回归 + 修复）连续 3 个月 > 阈值（阈值在 `docs/05` 定义） | 工时统计 |

### 6.2 兜底架构（核心链路不依赖 agent loop）

```
现状：apps/api ──Remote──► 中心 DSH Host ──► 模型供应商
兜底：apps/api ──HTTP───► apps/api 内置 model-gateway ──► 模型供应商
                        └► 自建 MCP server（业务工具直接暴露 HTTP）
      apps/worker ──HTTP──► model-gateway（批处理不再走 headless）
```

| 依赖 | 现状 | 兜底后 |
|---|---|---|
| 模型调用 | `dsh-llm-pi-ai` 路由 | 自建 `packages/registry` 直调供应商 HTTP（总纲 §7 的三层表已就绪） |
| 工具调用 | MCP via `dsh-mcp-client` | 工具直接暴露为 `apps/api` 内部 HTTP 端点，签名与审计不变 |
| 流式输出 | Remote `mode:'stream'` | SSE（`text/event-stream`），前端协议已按 SSE 设计（总纲 §3） |
| 取消 | `AbortSignal` | HTTP 请求中断 + 服务端 `cancel` 信号 + 幂等键兜底 |
| 多步编排 | agent loop | 显式状态机（BullMQ + Postgres，总纲 §9.1）——**本来就该这样做**，agent 只做有界任务 |
| skill / 提示词 | `dsh-skill-filesystem` | 提示词模板进 `packages/judge-rules`，按版本管理 |
| 会话留痕 | `.jsonl` | 已有 `model_call_log` + `audit_log`，不依赖 `.jsonl` |
| 凭据 | `dsh-credentials` | 加密表 + KMS/本地密钥文件；引用方式不变 |

**关键结论**：兜底**不需要数据迁移**——业务数据本来就不在 DSH（总纲 §19.1），`.jsonl` 只是调试黑匣子。切换的是「调用通道」，不是「事实源」。

### 6.3 切换成本与前置条件

| # | 项 | 说明 | 是否已有基础 |
|---|---|---|---|
| 1 | model-gateway 直调 | 供应商 HTTP + 重试 + 计量 | 有（M2 的 `packages/registry`） |
| 2 | 工具 HTTP 化 | 把 MCP 工具定义映射为内部 REST | 部分（工具逻辑在 `apps/api`） |
| 3 | SSE 通道 | 前端已按 SSE 设计 | 有 |
| 4 | 显式状态机 | BullMQ + Postgres | 有（M1/M4） |
| 5 | 提示词外置 | 从 skill 目录搬到 `judge-rules` | 需新增 |
| 6 | 凭据迁移 | 从 DSH 目录导出到加密表 | 需新增（一次性） |

### 6.4 演练要求

| 项 | 规定 |
|---|---|
| 频率 | 每半年 1 次，或每次大版本升级后 |
| 方式 | 在 staging 关闭 DSH Host（`docker compose stop dsh-host`），验证：文案生成、客服草稿、批处理三条链路仍可用 |
| 判据 | 三条链路可用；延迟增幅 ≤ 50%；错误率 ≤ 1%；审计与幂等不丢 |
| 记录 | 演练报告进 `docs/evidence/dsh/drill-<date>/`；失败项进风险登记（总纲 §十八） |

**判定规则 T3（演练门禁）**：M9 验收前必须完成 1 次断供演练；未演练则「DSH 升级破坏」风险不得标为已缓解。

---

## 附录 A：本文件待填空白项

| # | 空白 | 阻塞什么 | 谁去补 |
|---|---|---|---|
| 1 | 首次锁定时的真实版本号、integrity、传递依赖树 | `dsh-lock.json` 落地 | 后端（M1 首日） |
| 2 | `dsh-bundle` 的 Cordis 组合方言与挂载点细节 | preset/bundle 能否加载 | 后端（M1） |
| 3 | MCP server 的传输方式选择（stdio vs HTTP）与工具清单 | R3 基线 | 后端（M2） |
| 4 | 首 token 延迟与取消成功率的基线值 | R4 判据 | 测试（M2 压测） |
| 5 | 升级成本阈值（触发 S4 的工时） | 停更评估 | `docs/05` 回填后确定 |
| 6 | 凭据落盘是否加密的最终确认（附录 A 称「未声明静态加密」） | 备份策略（总纲 §19.2） | 管理员（M1） |
| 7 | 断供演练的具体脚本与降级开关 | T3 门禁 | 后端（M8） |
| 8 | 桌面端 2.0.18 与内核 0.2.1-rc.2 的兼容矩阵 | 管理员调试环境 | 管理员 |
| 9 | `dsh-headless` 的 `--json` 事件 schema 稳定性 | R8 基线 | 后端 |
| 10 | 上游发布节奏变化的监控方式（是否订阅 registry webhook） | 月度升级的情报来源 | 运维 |
