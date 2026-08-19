# AutoFDE Bundle 设计文档

- 日期：2026-08-19
- 状态：已与用户逐节确认，待实现
- 本地仓库：`~/projects/AutomatedFDE`（GitHub 仓库名：`AutoFDE`）

## 1. 背景与目标

AutoFDE 的整体愿景是"把过去的工作自动变成可执行的自动化"（screenpipe 捕获 → `automate-my-work` 发现 → pi skill 执行）。本仓库补上**分发层**：产出一个 macOS arm64 的离线 release 包，内含 pi（coding agent）与 screenpipe 引擎（headless），开箱即用，用户无需单独安装 screenpipe 桌面端。

**成功标准**：用户下载 tarball、解压、运行 `run.sh`，即可得到一个能查询屏幕历史的 pi agent，且与已安装的 screenpipe 桌面端安全共存。

## 2. 需求决策记录

| 问题 | 决定 |
|------|------|
| 目标 agent | pi（`earendil-works/pi`） |
| 集成形态 | 捆绑 screenpipe headless 引擎，pi 启动时自动拉起 |
| 发布形态 | 独立打包层仓库，不动 pi 源码 |
| 平台 | 第一期仅 macOS arm64 |
| 能力范围 | 引擎托管 + 工具 extension；AutoFDE pipes **二期收录**（见第 5 节） |
| 构建方式 | 方案 C：本地构建脚本 + GitHub Actions 自动发布（tag push） |
| 引擎来源 | 官方 npm 包 `@screenpipe/cli-darwin-arm64`（非 Rust fork 编译） |
| pipes 收录时机 | 二期：上游引擎发布含 `/work-history` 的版本后，随版本 bump 一并收录 |

## 3. 总体架构

### 3.1 仓库结构

```
AutomatedFDE/
├── build.mjs                    # 构建：拉 pi + 引擎 + 打包（本地/CI 同一脚本）
├── extension/screenpipe.ts      # pi extension 源码（单文件，零依赖）
├── pipes/                       # 预置 pipes（二期收录，v1 仅保留目录 + README 说明）
├── run.sh                       # 随包分发的安装+启动器
├── versions.json                # 版本唯一来源
└── .github/workflows/
    ├── release.yml              # tag push → 构建 → 冒烟 → 发布
    └── check-upstream.yml       # 每周检查上游 → bump PR
```

### 3.2 构建数据流

```
earendil-works/pi release (versions.json: pi) ──────┐
@screenpipe/cli-darwin-arm64 (versions.json: engine)├─→ build.mjs ─→ autofde-<ver>-darwin-arm64.tar.gz
extension/screenpipe.ts + pipes/（本仓库）──────────┘        └─→ SHA256SUMS → GitHub Release
```

### 3.3 产物结构（解压后）

```
autofde/
├── pi                        # 官方 pi 二进制（原样）
├── bin/screenpipe            # headless 引擎二进制
├── extensions/screenpipe.ts  # extension（run.sh 安装到 ~/.pi/agent/extensions/）
├── pipes/                    # 二期收录后才有内容（v1 为空）
├── run.sh
└── VERSION                   # bundle 版本 + pi 版本 + 引擎版本
```

## 4. Extension 设计（`extension/screenpipe.ts`）

### 4.1 引擎定位顺序

1. 环境变量 `PI_SCREENPIPE_BIN`（由 run.sh 设置，指向包内 `bin/screenpipe`）
2. `~/.screenpipe/cli/<最新版本>/screenpipe`（桌面端安装的引擎）
3. `PATH` 中的 `screenpipe`

### 4.2 生命周期状态机（`session_start` 时）

```
探测 localhost:3030 ──已运行──> 复用（标记 external；pi 退出时不杀）
        │未运行
        ▼
定位引擎二进制 → spawn 子进程 → 轮询端口就绪（≤15s）
        │失败/超时
        ▼
降级：不阻塞 pi 启动，工具仍注册，执行时返回可读错误与修复提示
```

- pi 退出时只 kill **自己 spawn 的**进程；外部引擎（如桌面端）绝不触碰
- 数据目录用默认 `~/.screenpipe`，与桌面端共享历史
- 引擎自身的内置 pi 执行器（`crates/screenpipe-core/src/agents/pi.rs`，引擎通过 bun 另装 pi）与本包互不干扰，属两套运行时

### 4.3 工具集（最小可用集）

| 工具 | 参数 | 实现 |
|------|------|------|
| `screenpipe_search` | query、时间窗、content_type(ocr/audio/all)、limit | `GET /search` |
| `screenpipe_recent` | minutes(默认30)、limit | 时间窗查询 `/search` |
| `screenpipe_status` | — | 引擎状态、版本、录制是否正常 |

### 4.4 本地 API 鉴权

引擎的 localhost:3030 需要 Bearer 鉴权。引擎已有成熟的密钥供给机制（`SCREENPIPE_LOCAL_API_KEY`，持久化于 `~/.screenpipe`，见 `bash_env.rs`）。实现时核实密钥的具体读取路径（secrets.sqlite 或密钥文件）；若我们自己 spawn 引擎，可从引擎启动产物/配置中捕获。**此项为实现期第一验证点**；若 headless 自建引擎可配置免鉴权则更简。

### 4.5 错误处理

- 引擎未就绪：工具返回错误文本 + 修复提示（跑 run.sh / 检查 macOS 权限）
- API 调用 5s 超时
- macOS 权限（屏幕录制/麦克风）未授予：首次由引擎触发系统弹窗；`screenpipe_status` 识别并提示

## 5. Pipes 预置（二期）

`work-history-memory` 与 `automate-my-work` 两个 pipe 依赖 `GET /work-history/sessions` 端点。**该端点目前是 `~/projects/screenpipe` 工作树中未提交的开发中代码**（computer-history port），任何已发布二进制（npm 引擎 0.4.41、桌面端 2.6.x、cli 0.4.40）均未包含（已逐一验证）。因此：

- v1 bundle 不收录这两个 pipes，`pipes/` 目录仅保留结构占位
- `check-upstream.yml` 每周检查上游时，同时探测新版引擎二进制是否含 `/work-history`（对下载产物做字符串探测，同本设计的验证方法）
- 探测到含该端点的版本发布后：开 PR 同时 bump 引擎版本 + 收录两个 pipes（pipe.md 从用户 `~/.screenpipe/pipes/` 收录进仓库），合并打 tag 即发布
- 收录后 run.sh 的安装规则：对比 `~/.screenpipe/pipes/<name>/pipe.md` 与包内文件内容，不同才拷贝；只动 `pipe.md`，绝不触碰 pipe 目录下的用户本地状态（如 local-overrides 的启停配置）
- 用户开发期在本机用桌面端跑 pipes 不受影响（bundle 不覆盖已有 pipes 的引擎端，二者共存）

## 6. run.sh 设计

幂等安装 + 启动，重复运行无副作用：

1. 对比 `~/.pi/agent/extensions/screenpipe.ts` 与包内文件内容（哈希），不同才覆盖拷贝
2. （二期启用）pipes 收录后：对比 `~/.screenpipe/pipes/<name>/pipe.md` 与包内文件内容，不同才拷贝；只动 `pipe.md`，绝不触碰 pipe 目录下的用户本地状态
3. `export PI_SCREENPIPE_BIN=<包路径>/bin/screenpipe`
4. `exec ./pi "$@"`

## 7. 版本策略

- `versions.json`：`{ "pi": "0.84.2", "screenpipe": "0.4.41" }`，是唯一版本来源
- `check-upstream.yml` 每周一查询上游新版本（含引擎 `/work-history` 端点探测，见第 5 节），有更新则开 bump PR；人工审核合并
- 合并后打 tag `v<bundle版本>` 即自动发布

## 8. CI/CD

| workflow | 触发 | 动作 |
|----------|------|------|
| `release.yml` | push tag `v*` | macOS runner → `build.mjs` → 冒烟测试 → 上传 Release（tarball + SHA256SUMS + 自动生成 notes） |
| `check-upstream.yml` | 每周一 | 对比上游最新版与 versions.json，探测新版引擎是否含 `/work-history` → 开 bump PR（含端点时连带收录 pipes） |

## 9. 测试策略

- **CI 冒烟**（每次构建）：解包校验文件齐全、可执行位、SHA 匹配；`./pi --version`；`./bin/screenpipe --version`
- **CI 引擎健康**（尽力而为）：spawn 引擎 → 轮询 3030 就绪即通过（CI 无屏幕录制权限，只验进程与 API 存活）
- **真机手测清单**（发版前，写入 README）：run.sh 首装幂等性；三个工具在 pi 内调用；与桌面端共存（复用不互杀）；（二期追加）`pipe run work-history-memory`

## 10. 非目标（v1 明确不做）

- macOS arm64 以外的平台（结构上预留，`--platform` 参数）
- 收录依赖 `/work-history` 的 pipes（该端点为未上游化的本地开发代码，见第 5 节；二期随上游发布收录）
- 编译用户的 AutoFDE Rust fork（若二期上游迟迟不发布，再评估作为备选路径）
- 替换引擎内置的 pi 执行器
- Windows/Linux 的权限处理差异

## 11. 风险与开放问题

| 风险/问题 | 应对 |
|-----------|------|
| npm 引擎与主线偏差（已证实：npm 0.4.41、桌面端 2.6.x、cli 0.4.40 均不含 `/work-history`，该端点为未提交的本地开发代码） | v1 无功能依赖该端点；二期由 check-upstream 探测新版引擎并同步收录 pipes（见第 5 节） |
| headless 引擎本地 API 密钥获取路径未最终确认 | 实现期第一个验证点（见 4.4） |
| CI 上 macOS 权限缺失导致引擎行为差异 | 冒烟只验进程/端口存活，数据采集验真机 |
| 官方 pi release 产物命名变更 | build.mjs 下载时校验 SHA 与文件存在，fail fast |
| 用户机器已有桌面端 → 双引擎数据目录竞争 | 复用优先策略（4.2）；文档说明先开桌面端或让 bundle 接管 |
