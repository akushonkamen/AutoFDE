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
| 能力范围 | 引擎托管 + 工具 extension + 预置 AutoFDE pipes |
| 构建方式 | 方案 C：本地构建脚本 + GitHub Actions 自动发布（tag push） |
| 引擎来源 | 官方 npm 包 `@screenpipe/cli-darwin-arm64`（非 Rust fork 编译） |

## 3. 总体架构

### 3.1 仓库结构

```
AutomatedFDE/
├── build.mjs                    # 构建：拉 pi + 引擎 + 打包（本地/CI 同一脚本）
├── extension/screenpipe.ts      # pi extension 源码（单文件，零依赖）
├── pipes/                       # 预置 pipes（从 ~/.screenpipe/pipes 收录）
│   ├── work-history-memory/pipe.md
│   └── automate-my-work/pipe.md
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
├── pipes/                    # pipes（run.sh 安装到 ~/.screenpipe/pipes/）
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

## 5. run.sh 设计

幂等安装 + 启动，重复运行无副作用：

1. 对比 `~/.pi/agent/extensions/screenpipe.ts` 与包内文件内容（哈希），不同才覆盖拷贝
2. 对比 `~/.screenpipe/pipes/{work-history-memory,automate-my-work}/pipe.md` 与包内文件内容，不同才拷贝；只动 `pipe.md`，绝不触碰 pipe 目录下的用户本地状态（如 local-overrides 的启停配置）
3. `export PI_SCREENPIPE_BIN=<包路径>/bin/screenpipe`
4. `exec ./pi "$@"`

## 6. 版本策略

- `versions.json`：`{ "pi": "0.84.2", "screenpipe": "0.4.41" }`，是唯一版本来源
- `check-upstream.yml` 每周一查询上游新版本，有更新则开 bump PR；人工审核合并
- 合并后打 tag `v<bundle版本>` 即自动发布

## 7. CI/CD

| workflow | 触发 | 动作 |
|----------|------|------|
| `release.yml` | push tag `v*` | macOS runner → `build.mjs` → 冒烟测试 → 上传 Release（tarball + SHA256SUMS + 自动生成 notes） |
| `check-upstream.yml` | 每周一 | 对比上游最新版与 versions.json → 开 bump PR |

## 8. 测试策略

- **CI 冒烟**（每次构建）：解包校验文件齐全、可执行位、SHA 匹配；`./pi --version`；`./bin/screenpipe --version`
- **CI 引擎健康**（尽力而为）：spawn 引擎 → 轮询 3030 就绪即通过（CI 无屏幕录制权限，只验进程与 API 存活）
- **真机手测清单**（发版前，写入 README）：run.sh 首装幂等性；三个工具在 pi 内调用；`pipe run work-history-memory`；与桌面端共存（复用不互杀）

## 9. 非目标（v1 明确不做）

- macOS arm64 以外的平台（结构上预留，`--platform` 参数）
- 编译用户的 AutoFDE Rust fork（官方引擎已含 `/work-history` 端点，无需 fork）
- 替换引擎内置的 pi 执行器
- Windows/Linux 的权限处理差异

## 10. 风险与开放问题

| 风险/问题 | 应对 |
|-----------|------|
| npm 引擎 0.4.41 与主线代码的版本偏差（主线已含 `/work-history`，npm 版待核） | build.mjs 下载后自动探测 `/work-history` 端点；缺失则 fail fast 并提示升版本 |
| headless 引擎本地 API 密钥获取路径未最终确认 | 实现期第一个验证点（见 4.4） |
| CI 上 macOS 权限缺失导致引擎行为差异 | 冒烟只验进程/端口存活，数据采集验真机 |
| 官方 pi release 产物命名变更 | build.mjs 下载时校验 SHA 与文件存在，fail fast |
| 用户机器已有桌面端 → 双引擎数据目录竞争 | 复用优先策略（4.2）；文档说明先开桌面端或让 bundle 接管 |
