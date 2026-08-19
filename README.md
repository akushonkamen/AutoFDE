# AutoFDE Bundle

AutoFDE bundle：**pi + screenpipe 引擎的 macOS arm64 离线一体化包**。下载解压后运行 `run.sh`，即可得到一个能查询屏幕历史的 pi coding agent，无需单独安装 screenpipe 桌面端。

- `pi`：官方 coding agent 二进制（原样捆绑）
- `bin/screenpipe`：headless 屏幕捕获引擎（来自官方 npm 包 `@screenpipe/cli-darwin-arm64`）
- `extensions/screenpipe.ts`：pi extension，随包分发并由 `run.sh` 安装；为 pi 注册 `screenpipe_search` / `screenpipe_recent` / `screenpipe_status` 三个工具

版本以 [`versions.json`](versions.json) 为唯一来源（含 `bundle` / `pi` / `screenpipe` 三个键），Release 产物名为 `autofde-<bundle版本>-darwin-arm64.tar.gz`。

## 本地构建

```bash
node build.mjs [--out dist]
```

构建脚本会按 `versions.json` 拉取对应版本的 pi 与 screenpipe 引擎、打包 extension 并产出 tarball 与 SHA256SUMS。CI（tag push `v*`）使用同一脚本自动发布。

## 从 Release 安装使用

```bash
# 1. 下载最新 Release 的 autofde-<版本>-darwin-arm64.tar.gz
# 2. 解压
tar xzf autofde-*-darwin-arm64.tar.gz
cd autofde
# 3. 启动
./run.sh
```

`run.sh` 会：

1. 幂等安装 extension 到 `~/.pi/agent/extensions/screenpipe.ts`（对比哈希，内容相同则不覆盖，重复运行无副作用）
2. 设置 `PI_SCREENPIPE_BIN` 指向包内 `bin/screenpipe`
3. 启动 pi

**首次运行 macOS 权限说明**：engine 首次启动时 macOS 会弹出「屏幕录制」（必需）与「麦克风」（如需音频捕获）权限请求，请在「系统设置 → 隐私与安全性」中授予对应目录下的 screenpipe 二进制；未授予屏幕录制权限时引擎无法捕获画面，`screenpipe_status` 工具会给出提示。

## 与 screenpipe 桌面端共存

- 若本机 3030 端口已有引擎在运行（通常是桌面端），bundle 会**直接复用**该实例，不重复拉起，pi 退出时也**不会杀掉**外部引擎
- 数据目录统一为默认的 `~/.screenpipe`，桌面端与 bundle 共享同一份屏幕历史
- 若 bundle 先启动、桌面端后启动，两个进程可能竞争数据目录；建议先开桌面端再运行 bundle（bundle 自动接管复用）

## 真机手测清单（发版前）

来自设计文档第 9 节：

- [ ] `run.sh` 首装幂等性：连续运行两次，第二次无拷贝输出
- [ ] pi 内调用 `screenpipe_search` / `screenpipe_recent` / `screenpipe_status` 三个工具
- [ ] 与桌面端共存：桌面端已运行时启动 bundle，确认复用 3030 且 bundle 退出后桌面端存活
- [ ] 首次运行 macOS 权限弹窗（屏幕录制 / 麦克风）正常触发并可授予
- [ ] （二期追加）`pipe run work-history-memory`

## 二期 pipes 计划

`work-history-memory` 与 `automate-my-work` 两个 pipes 依赖引擎的 `GET /work-history/sessions` 端点，该端点尚未在上游引擎发布版本中提供，因此 v1 不收录，`pipes/` 仅保留目录占位。上游发布含该端点的版本后，将随版本 bump 一并收录，安装时只同步 `pipe.md`、不触碰用户本地 pipe 状态。

## 隐私

所有屏幕捕获数据均保存在本机 `~/.screenpipe` 目录，不发生任何外部上传；bundle 不引入额外的遥测或联网数据传输。
