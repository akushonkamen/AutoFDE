#!/usr/bin/env node
// AutomatedFDE bundle builder — zero npm dependencies, Node >= 18.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const DEFAULT_VERSIONS = {
  bundle: "0.1.0",
  pi: "0.84.2",
  screenpipe: "0.4.41",
};

function parseArgs(argv) {
  const args = { out: "dist" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) {
      args.out = argv[++i];
    } else {
      console.error(`未知参数: ${argv[i]}\n用法: node build.mjs [--out dist]`);
      process.exit(2);
    }
  }
  return args;
}

function loadVersions() {
  const file = path.join(ROOT, "versions.json");
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const k of ["bundle", "pi", "screenpipe"]) {
      if (typeof v[k] !== "string" || !v[k]) throw new Error(`缺少字段 ${k}`);
    }
    console.log(`读取 versions.json: bundle=${v.bundle} pi=${v.pi} screenpipe=${v.screenpipe}`);
    return v;
  } catch (e) {
    if (e.code === "ENOENT") {
      console.warn(`警告: versions.json 不存在 (${file})，使用内置默认版本`);
    } else {
      console.warn(`警告: versions.json 解析失败 (${e.message})，使用内置默认版本`);
    }
    return { ...DEFAULT_VERSIONS };
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", ...opts.spawn });
  if (r.status !== 0) {
    let stderr = "";
    if (r.stderr) stderr = r.stderr.toString().trim();
    console.error(`命令失败 (${cmd} ${args.join(" ")})${stderr ? `\n${stderr}` : ""}`);
    process.exit(1);
  }
  return r;
}

function systemProxy() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    return process.env.HTTPS_PROXY || process.env.https_proxy;
  }
  if (process.platform === "darwin") {
    const r = spawnSync("scutil", ["--proxy"], { encoding: "utf8" });
    if (r.status === 0 && /HTTPSEnable\s*:\s*1/.test(r.stdout)) {
      const host = r.stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = r.stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (host && port) return `http://${host}:${port}`;
    }
  }
  return null;
}

function download(url, dest, { token } = {}) {
  const proxy = systemProxy();
  const args = ["-sSL", "--fail", "-o", dest, "-w", "%{http_code} %{size_download} %{speed_download}"];
  if (proxy) args.push("-x", proxy);
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  args.push(url);
  const r = spawnSync("curl", args, { encoding: "utf8", timeout: 30 * 60 * 1000 });
  if (r.status !== 0) {
    throw new Error(`下载失败（curl 退出码 ${r.status}）: ${url}\n${r.stderr || ""}`);
  }
  const [code, size] = (r.stdout || "").trim().split(/\s+/);
  if (code !== "200") {
    throw new Error(`下载失败 HTTP ${code}: ${url}${code === "404" ? "（版本号或资产名可能不正确）" : ""}`);
  }
  const mb = Number(size) / 1024 / 1024;
  console.log(`已下载 ${path.basename(dest)}: ${mb.toFixed(1)} MB${proxy ? `（经代理 ${proxy}）` : ""}`);
  return Number(size);
}

function mustExist(p, hint) {
  if (!fs.existsSync(p)) {
    console.error(`缺少必需文件: ${p}\n${hint || ""}`.trim());
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const versions = loadVersions();
  const outDir = path.resolve(args.out);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autofde-build-"));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  console.log(`步骤 1/6: 下载 pi v${versions.pi}`);
  const piUrl = `https://github.com/earendil-works/pi/releases/download/v${versions.pi}/pi-darwin-arm64.tar.gz`;
  const piTgz = path.join(tmp, "pi.tar.gz");
  let ghToken = process.env.GITHUB_TOKEN;
  try {
    await download(piUrl, piTgz, {});
  } catch (e) {
    if (!ghToken) {
      const t = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
      if (t.status === 0 && t.stdout.trim()) ghToken = t.stdout.trim();
    }
    if (ghToken) {
      console.log("匿名下载失败，改用 GitHub token 重试…");
      await download(piUrl, piTgz, { token: ghToken });
    } else {
      throw e;
    }
  }
  run("tar", ["-xzf", piTgz, "-C", tmp]);
  const piBin = (function findPi(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === "pi") return p;
      if (e.isDirectory()) { const f = findPi(p); if (f) return f; }
    }
    return null;
  })(tmp);
  if (!piBin) {
    console.error("错误: pi-darwin-arm64.tar.gz 中未找到 pi 可执行文件");
    process.exit(1);
  }

  console.log(`步骤 2/6: npm pack @screenpipe/cli-darwin-arm64@${versions.screenpipe}`);
  run("npm", ["pack", `@screenpipe/cli-darwin-arm64@${versions.screenpipe}`], { spawn: { cwd: tmp }, capture: true });
  const spTgz = fs.readdirSync(tmp).find((f) => f.startsWith("screenpipe-cli-darwin-arm64-") && f.endsWith(".tgz"));
  if (!spTgz) {
    console.error("错误: npm pack 未产出 tgz");
    process.exit(1);
  }
  const spDir = path.join(tmp, "sp-pkg");
  fs.mkdirSync(spDir);
  run("tar", ["-xzf", path.join(tmp, spTgz), "-C", spDir]);
  mustExist(path.join(spDir, "package", "bin", "screenpipe"), "npm 包结构异常：缺少 package/bin/screenpipe");

  console.log("步骤 3/6: 组装 staging");
  const srcExt = path.join(ROOT, "extension", "screenpipe.ts");
  const srcRun = path.join(ROOT, "run.sh");
  mustExist(srcExt, "并行任务未完成（extension/screenpipe.ts），稍后重试");
  mustExist(srcRun, "并行任务未完成（run.sh），稍后重试");
  const staging = path.join(tmp, "staging");
  const bundleRoot = path.join(staging, "autofde");
  fs.mkdirSync(path.join(bundleRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "pipes"), { recursive: true });
  fs.copyFileSync(piBin, path.join(bundleRoot, "pi"));
  fs.copyFileSync(path.join(spDir, "package", "bin", "screenpipe"), path.join(bundleRoot, "bin", "screenpipe"));
  fs.copyFileSync(srcExt, path.join(bundleRoot, "extensions", "screenpipe.ts"));
  fs.copyFileSync(srcRun, path.join(bundleRoot, "run.sh"));
  fs.writeFileSync(
    path.join(bundleRoot, "pipes", "README.md"),
    `# pipes\n\n此目录用于存放 AutofDE 运行时生成的 pipe 数据。\nAutofde bundle v${versions.bundle}\n`,
  );
  fs.writeFileSync(path.join(bundleRoot, "VERSION"), `${versions.bundle}\n${versions.pi}\n${versions.screenpipe}\n`);
  fs.chmodSync(path.join(bundleRoot, "pi"), 0o755);
  fs.chmodSync(path.join(bundleRoot, "bin", "screenpipe"), 0o755);
  fs.chmodSync(path.join(bundleRoot, "run.sh"), 0o755);

  console.log("步骤 4/6: 校验二进制可运行");
  if (process.env.AUTOFDE_SKIP_VALIDATE === "1") {
    console.log("跳过校验（AUTOFDE_SKIP_VALIDATE=1）");
  } else {
    const r = spawnSync(path.join(bundleRoot, "pi"), ["--version"], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`错误: staging 内 ./pi --version 失败\n${r.stderr || ""}`);
      process.exit(1);
    }
    console.log(`pi --version => ${(r.stdout || "").trim()}`);
    const s = spawnSync(path.join(bundleRoot, "bin", "screenpipe"), ["--version"], { encoding: "utf8" });
    if (s.status !== 0) {
      console.error(`错误: staging 内 ./bin/screenpipe --version 失败\n${s.stderr || ""}`);
      process.exit(1);
    }
    console.log(`screenpipe --version => ${(s.stdout || "").trim()}`);
  }

  console.log("步骤 5/6: 打包 tar.gz");
  fs.mkdirSync(outDir, { recursive: true });
  const tarName = `autofde-${versions.bundle}-darwin-arm64.tar.gz`;
  const tarPath = path.join(outDir, tarName);
  run("tar", ["-czf", tarPath, "-C", staging, "autofde"]);
  const size = fs.statSync(tarPath).size;
  console.log(`产物: ${tarPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);

  console.log("步骤 6/6: 生成 SHA256SUMS");
  const h = createHash("sha256");
  h.update(fs.readFileSync(tarPath));
  const sha = h.digest("hex");
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${sha}  ${tarName}\n`);
  console.log(`sha256: ${sha}`);
  console.log("构建完成。");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
