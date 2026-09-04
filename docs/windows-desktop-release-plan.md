# Windows Desktop 多应用构建与发布计划

本文是 `loulin/gplus-runner` 的操作真源。它记录已经验证的跨仓库构建过程、
当前安全边界，以及从 Staging 构建继续到本地 Windows 签名、七牛上传和
Production 发布所需的工作。公开 runner 只保存自动化脚本和文档，Gplus Bot
Desktop 与 Libre Reader 源码仍在私有仓库 `loulin/gplus`。

## 1. 目标与边界

目标是利用 GitHub 的原生 Windows runner 处理网络和构建工作，再把受保护的
构建上下文交给可使用 Certum SimplySign 的 Windows 机器完成最终签名和发布。
当前流程按单次 app/profile/target 覆盖第一阶段：

```text
private loulin/gplus
        |
        | GitHub App: Contents read-only
        v
public gplus-runner workflow_dispatch(source_ref)
        |
        | windows-latest x64
        v
resolve SHA -> checkout -> filtered dependencies -> application prepare adapter
        |
        v
allow-list package -> age-encrypted handoff
        |
        v
sanitized manifest + ciphertext artifact
```

下面这些事项目前不属于已完成能力：

- 把 EXE、ZIP、blockmap 或 `latest.yml` 以明文上传到公开仓库 artifact。
- 在 GitHub-hosted runner 上使用 SimplySign Desktop 或保存 Windows 私钥。
- 在公开 workflow 中放置 Qiniu Access Key、Secret Key、Release API token、
  PFX 或证书口令。
- 直接从 `master` 构建并宣称已完成 Production 发布。

公开仓库的 hosted runner 对 public repository 通常不收取标准 runner 计算费，
但这不等于 artifact 存储、保留时间、并发或 GitHub fair-use 限制无限。这个方案
只把计算放在 hosted Windows 上，并把 handoff artifact 设置为短 retention。

## 2. 已完成的设置

### 2.1 公共 runner 仓库

- 仓库：[loulin/gplus-runner](https://github.com/loulin/gplus-runner)
- 默认分支：`main`
- 可见性：Public
- 当前 workflow：`.github/workflows/build-windows-desktop.yml`（`Windows Desktop Build Handoff`）
- 支持输入：`gplus-bot-desktop`、`libre-reader`，`staging`、`production`，以及三个 Windows target
- 当前 hosted runner 已启用：`win-x64`；arm64/ia32 在匹配 runner 配置前显式失败
- App 名称：`gplus-source-reader`

### 2.2 GitHub App 权限

`gplus-source-reader` 只安装到私有仓库 `loulin/gplus`，权限为：

```text
Contents: Read-only
```

runner 仓库的源码访问使用以下两个 Secret；Gplus Bot Desktop 的 Windows
任务还需要在所选 Environment 配置 `HERMES_SOURCE_SSH_KEY`：

```text
GPLUS_SOURCE_READER_APP_ID
GPLUS_SOURCE_READER_PRIVATE_KEY
HERMES_SOURCE_SSH_KEY
```

`HERMES_SOURCE_SSH_KEY` 是只读访问公开 Hermes 仓库的临时 SSH 私钥。workflow
通过固定的 `ssh.github.com:443` ED25519 host key 读取锁定的 Hermes
submodule，以避开 GitHub HTTPS 429 限流；只写入 runner 临时目录，并在
`always()` cleanup 中删除。私钥不能从 GitHub 读回，也不能写入本文档、
workflow 输出、artifact 或提交记录。App 不需要 Issues、Pull requests、Actions、Deployments、Packages
或 Administration 权限。

## 3. 当前统一 Workflow

### 3.1 输入约定

Workflow 只接受 `workflow_dispatch`，每次只构建一个组合：

```text
application: gplus-bot-desktop | libre-reader
profile: staging | production
target: win-x64 | win-arm64 | win-ia32
source_ref: private loulin/gplus branch, tag, or full 40-character commit SHA
```

`source_ref` 会先通过 GitHub API 解析成完整 SHA，checkout 只使用解析后的 SHA。
`staging` 可选择分支、Tag 或 SHA；正式发布仍由应用 adapter 要求既有 release
identity。`production` 输入只允许 `master`、release Tag 或完整 SHA，应用 adapter
还会验证版本对应的 annotated Tag、tag object 和 peeled commit。`--ref main` 是
public runner workflow 的分支，不是应用源码分支。

### 3.2 执行顺序

1. checkout `gplus-runner`，并关闭 credential persistence。
2. 使用 `actions/create-github-app-token` 创建只读、短生命周期的源码 token。
3. 通过 GitHub API 把 `source_ref` 解析为完整 `source_sha`，再按 SHA checkout
   `loulin/gplus`，通过独立的 SSH 重试步骤初始化 Hermes submodule，获取全部
   Tag，并关闭 credential persistence。
4. 检查 target 与当前 Windows/Node 架构匹配；当前 hosted runner 只启用 `win-x64`，
   arm64/ia32 明确失败，不做交叉构建。
5. 配置 npm、uv、Electron 和 Electron Builder 下载缓存，安装固定版本的 Node、Python、
   uv；age 模式再安装固定版本的 age。Gplus Bot Desktop 额外验证锁定的 Hermes Tag identity。
6. 使用 frozen root lockfile 安装所选应用的 filtered dependencies；Gplus Bot Desktop
   额外构建 `@gplus/bot-contracts`。
7. 调用所选应用的 `release:prepare-handoff` adapter。adapter 根据 profile/target 选择
   channel、公共路径、Release API 配置和应用构建方式，生成 unsigned build workspace、
   filtered `node_modules`、Electron/Builder cache 和完整 handoff manifest。
8. `scripts/package-windows-handoff.ps1` 校验 payload 文件清单与 SHA-256/SHA-512，
   将 `payload/` 和完整 manifest 打成 ZIP，再按 `handoff_encryption` 选择用 profile 专属
   age recipient 加密，或保留为 `handoff.zip`。
9. 默认只上传 `encrypted-handoff.age` 与脱敏 `ciphertext-manifest.json`，保留 7 天；
   显式选择 `handoff_encryption=none` 时上传同一 ZIP 的明文 `handoff.zip` 与带摘要的
   `ciphertext-manifest.json`，保留 GitHub 允许的最短 1 天；
   Workflow summary 记录 source SHA、版本、build number 和 ciphertext SHA-256。
10. `always()` 清理明文 handoff，并保存四类下载缓存。

### 3.2.1 缓存与加速边界

Workflow 在每次 hosted Windows job 开始时都是全新 runner，因此缓存只能减少
依赖下载，不能保留源码 checkout、生成 workspace 或上一次构建目录。当前启用
的缓存如下：

- `uv` 的 PyPI 下载缓存，按 Hermes lock 和 Desktop Python dependency profile
  复用。
- 生成 Hermes Desktop workspace 使用的 npm registry cache。
- Electron runtime 下载缓存，以及 electron-builder 使用的 7-Zip/NSIS 工具缓存。

这些目录都位于 `$RUNNER_TEMP`，只通过 GitHub Actions cache 恢复和保存。缓存 key
按 Windows runner 和相关锁定/overlay 输入隔离；输入发生变化时使用同一平台的
前缀 cache 作为候选恢复值。第一次运行或缓存未命中时耗时不会降低，后续运行才会
减少网络下载。

pnpm store 不纳入公共 runner 缓存。filtered install 仍会在每次 job 中重新准备；
`node_modules`、源码、`win-unpacked`、安装包和 handoff 也不进入 Actions cache。

当前 Workflow 按应用选择 filtered install：

```text
corepack pnpm install --filter 'gplus-bot-desktop...' --recursive \
  --frozen-lockfile --ignore-scripts --prefer-offline
corepack pnpm --filter '@gplus/bot-contracts' run build
corepack pnpm install --filter 'libre-reader...' --recursive \
  --frozen-lockfile --ignore-scripts --prefer-offline
```

### 3.3 已验证证据

最近一次成功的 hosted Windows package validation（handoff 改造前）：

| 字段 | 值 |
| --- | --- |
| Run | [33460720703](https://github.com/loulin/gplus-runner/actions/runs/33460720703) |
| Source ref/SHA | `73f01ae959d48277543e2c9506465247a72ddce2` |
| Hermes SHA | `f80f453ae0679347e38abc917c7f94f717bf96c5` |
| Channel/target | `staging` / `win-x64` |
| Version/build | `0.2.0-rc.38` / `1042` |
| Runner | `windows-latest`, Node `x64` |
| Duration | `11m21s` |
| Result | success |
| Uploaded artifact | `gplus-bot-desktop-staging-manifest-33460720703` |
| Artifact content | sanitized `staging-build-manifest.json`; no handoff artifact existed in this historical run |

本次验证的迭代记录：

| Run | 结果或发现 |
| --- | --- |
| [33414582946](https://github.com/loulin/gplus-runner/actions/runs/33414582946) | hosted Python 的 `python3.exe` 路径异常 |
| [33416783817](https://github.com/loulin/gplus-runner/actions/runs/33416783817) | 确认 Python 重解析点并修正 workflow |
| [33417112333](https://github.com/loulin/gplus-runner/actions/runs/33417112333) | Python、Electron、ZIP、NSIS 通过；Windows `app.asar` 路径校验失败 |
| [33419353095](https://github.com/loulin/gplus-runner/actions/runs/33419353095) | 第一层路径归一化后，确认 nested `extractFile()` 仍需 Windows 分隔符 |
| [33460720703](https://github.com/loulin/gplus-runner/actions/runs/33460720703) | `win-x64` unsigned package 成功；当时尚未上传 handoff |

历史成功 run 带有 GitHub 的 Node.js 20 deprecation annotation；该提示来自 Action
自身的运行时，不是构建使用的 Node.js 版本。当前 workflow 已将 checkout、GitHub App
token、setup-node、setup-python、setup-uv 和 upload-artifact 更新到 Node.js 24 原生版本，
cache 保持现有的 Node.js 24 版本。合并后应重新跑一次 build，确认新 Action 与当前
Windows handoff 流程兼容。

manifest 中记录的构建文件及 SHA-256 是：

```text
gplus-bot-staging-0.2.0-rc.38-win-x64.exe
gplus-bot-staging-0.2.0-rc.38-win-x64.exe.blockmap
gplus-bot-staging-0.2.0-rc.38-win-x64.zip
latest.yml
```

这些文件只在 hosted runner 的临时目录中存在；上表只记录其名称、大小和摘要，
历史 run 未上传它们的明文副本。新 workflow 只把 `win-unpacked` 和必要 metadata
放入 age ciphertext，供本地 Windows 下载后继续处理。

### 3.4 已处理的 Windows 兼容问题

构建验证过程中发现 Windows `@electron/asar` 对嵌套路径使用反斜杠时会导致
`extractFile()` 读取失败。私有仓库已在 `codex/windows-desktop-asar-path-fix` 中
固定路径归一化和平台分隔符转换，最终构建使用提交：

```text
312b7df68092754c09483dab4b988f23eba706c7
```

该修复同时有 Windows nested extraction path 回归测试，并通过私有仓库的
`pnpm run check:changed`（187/187）和定向测试（4/4）。

## 4. 日常操作

### 4.1 Staging build and handoff

日常验证使用 `develop`：

```bash
gh workflow run build-windows-desktop.yml \
  --repo loulin/gplus-runner \
  --ref main \
  -f application=gplus-bot-desktop -f profile=staging -f target=win-x64 \
  -f source_ref=develop
```

问题复现或候选版本使用完整 SHA：

```bash
gh workflow run build-windows-desktop.yml \
  --repo loulin/gplus-runner \
  --ref main \
  -f application=gplus-bot-desktop -f profile=staging -f target=win-x64 \
  -f source_ref=<40-character-private-commit-sha>
```

查询并下载脱敏 manifest 与加密 handoff：

```bash
gh run list --repo loulin/gplus-runner --workflow build-windows-desktop.yml --limit 5
gh run watch <run-id> --repo loulin/gplus-runner --exit-status
gh run download <run-id> --repo loulin/gplus-runner \
  --name gplus-bot-desktop-staging-win-x64-handoff-<run-id>
```

本 Workflow 的构建输出发布到当前 Run 的 GitHub Actions Artifact，而不是
Git Tag 或 GitHub Release：

- handoff artifact 只含 `encrypted-handoff.age` 和脱敏 `ciphertext-manifest.json`；完整 manifest 位于加密内容中。

Artifact 目前保留 7 天，只是跨机器交接存储。Tag 不承担二进制存储职责；私有仓库的 annotated
release tag 只在正式 `release:local` 发布和 `release:verify` closeout 中用于固定版本身份、
tag object、peeled commit 和 source ref。使用本 Workflow 从任意 branch/SHA 做 staging 验证时，
不需要为了保存产物创建 Tag；但该 branch 构建不能直接冒充已有 release tag 的正式 target。

不要仅凭 runner 启动、checkout 成功或依赖安装成功判断构建完成；必须看到
`Prepare application handoff`、`Create encrypted handoff` 和
`Upload encrypted handoff artifact` 全部成功。

### 4.2 失败定位

按以下顺序读取 run：

1. `Create read-only source token`：检查 App installation 和两个 runner Secret 名称。
2. `Checkout private source at requested ref`：检查 branch/SHA 是否存在及 App 是否只读可见。
3. `Fetch locked Hermes release tag`：检查 submodule remote 和锁定 tag 是否仍可访问。
4. `Install filtered dependencies`：检查锁文件、npm registry 和网络下载。
5. `Prepare application handoff`：读取完整失败日志，重点检查 Electron builder binary、
   Hermes/bytecode 依赖、路径长度、`app.asar` 和 NSIS。
6. handoff/upload：确认公开 artifact 只包含 `encrypted-handoff.age` 和 ciphertext manifest，并检查
   allow-list、ciphertext header、SHA-256 和 artifact retention。

## 5. 加密 artifact 交接设计

### 5.1 当前方案

默认采用 `age` 公钥加密。为处理 age 在超大 handoff 上耗时过长的情况，Workflow
也提供显式的 `handoff_encryption=none` 旁路：

- Windows 签名机生成一次 staging 和一次 production 的 age keypair。
- 私钥只保存在签名机受 ACL 保护的本地目录，Never upload。
- runner 只配置对应的 age recipient 公钥（Actions variable，不是 Secret）。
- hosted workflow 默认将允许列表中的构建上下文加密后才上传 GitHub artifact；实现位于
  `scripts/package-windows-handoff.ps1`。
- `none` 模式仍执行相同的 allow-list、reparse point、payload 文件清单和 SHA-256/SHA-512
  校验，只跳过 age 加密并上传 `handoff.zip`。GitHub Artifact 最短保留期是 1 天，不能配置
  3 小时；签名机下载并验证摘要后，应立即用 `scripts/download-windows-handoff.ps1` 删除远端 artifact。
- 签名机下载 handoff，按模式解密或直接解包到临时目录，验证 manifest 后再进入签名流程。

公钥泄露不会解密 artifact；私钥泄露则会暴露该环境的历史和未来交接包，因此
staging、production 必须使用不同 keypair。私钥轮换时停用旧 recipient，保留已完成
发布所需的审计记录，不把私钥放进仓库 Secret。

Windows 签名机使用固定的本机私钥路径，按 handoff 的 `profile` 一一对应：

```text
staging    -> %USERPROFILE%\.gplus\gplus-desktop-staging-age-key.txt
production -> %USERPROFILE%\.gplus\gplus-desktop-production-age-key.txt
```

后续会话和操作员应从上述路径读取 key，不从 `tmp/`、仓库 checkout 或 runner
workspace 猜测或回退。两个文件的目录和文件 ACL 只允许当前用户、`SYSTEM` 与
`Administrators`；私钥不得复制到 GitHub、Actions artifact、日志、聊天或发布 receipt。

### 5.2 加密包内容

加密包只允许包含当前 app/target 的构建上下文。应用 adapter 负责生成并记录
完整 `handoff-manifest.json`，公共 runner 只把该目录封装后加密。当前 payload
结构按应用分别为：

```text
gplus-bot-desktop: payload/generated/ (generated Electron workspace, including win-unpacked)
libre-reader:     payload/workspace/ (apps/libre-reader plus repository-root scripts/lib)
```

prepare adapter 不复制 checkout 的 `.git` 或其他应用目录；handoff packager
会拒绝 reparse point，并只复制 `payload/` 与 `handoff-manifest.json`。当前优先保证
可用性，payload 可能包含较大的 filtered `node_modules`；超出 artifact/磁盘限制时
再按应用 adapter 缩减，而不是退回明文上传。

加密前必须生成并校验：

```text
sourceRepository
sourceRef
sourceSha
hermesSha
channel
target
version
buildNumber
plaintext files: name, size, sha256
ciphertext: size, sha256
```

### 5.3 签名时机的硬约束

当前 `run-desktop-release-target.mjs` 的正式 Windows 路径由 Electron Builder
在打包阶段签名，并在最终 bytes 上生成 update metadata。不能把 unsigned `exe`
签完后直接复用原来的 `latest.yml`、blockmap 或 Release receipt，因为签名会改变
文件 bytes，可能使 blockmap、SHA-512、size 和 update verification 失效。

当前 adapter 交接经过校验的完整构建 workspace，包含 `win-unpacked`、filtered
dependencies 和 Electron/Builder cache。本地 Windows 使用同一版本的 Electron Builder
离线重跑最终 packaging/signing：先执行一次不带 `--prepackaged` 的完整 ZIP 构建，让
app-builder-lib 对应用和嵌套 PE 签名；再把同一个已签 `win-unpacked` 作为 `--prepackaged`
输入生成 NSIS。不能把 `--prepackaged` 作为唯一打包步骤，因为该模式会跳过应用签名。
最终流程重新生成 blockmap、`latest.yml` 和 receipt，也禁止把“下载 unsigned installer
后调用 signtool”当作可发布流程。

### 5.4 hosted workflow 步骤

在 unsigned package 成功后执行独立的加密 handoff 阶段，失败应停止并不上传
任何明文安装包：

1. 固定并记录 `sourceSha`、Hermes SHA、channel、target、version、build number。
2. 只复制 allow-list 文件到临时 handoff 目录。
3. age 模式用 environment 对应的 age recipient 加密整个 handoff 包；none 模式保留 ZIP。
4. 在 runner 上检查对应文件的 magic/header（age）、非空、大小上限和 SHA-256。
5. age 模式上传 `*.age` ciphertext；none 模式上传 `handoff.zip`；两者都只附带脱敏 manifest。
6. 设置短 retention（age 为 7 天，none 为 GitHub 最短 1 天），并在 run summary 显示下载入口、摘要和过期时间。
7. job 结束时删除明文 handoff 目录；GitHub runner 是临时环境，但清理仍作为显式步骤保留。

当前变量名：

```text
GPLUS_DESKTOP_ARTIFACT_AGE_RECIPIENT_STAGING
GPLUS_DESKTOP_ARTIFACT_AGE_RECIPIENT_PRODUCTION
```

正式执行 staging 前必须配置 `GPLUS_DESKTOP_ARTIFACT_AGE_RECIPIENT_STAGING`。
私钥只保留在 Windows 签名机；workflow 在变量缺失或格式不正确时于构建前失败。

这两个值是公钥，可以是 repository/environment variable；对应私钥不得出现在
GitHub。Production recipient 应使用 GitHub Environment 的受保护配置，并要求
人工批准后才允许生成 handoff。

## 6. 本地 Windows 接力签名与上传

### 6.1 签名机前置条件

签名机必须具备：

- 与 target 匹配的 Windows 架构和 Node 架构；`win-x64` 至少使用 Windows x64 + Node x64。
- age 解密私钥，且文件 ACL 仅允许当前用户、SYSTEM 和 Administrators。
- Certum SimplySign Desktop 已登录，代码签名证书出现在当前用户证书库。
- 通过 `WIN_CSC_SUBJECT_NAME` 固定 signer subject；不能在脚本中猜测证书。
- `signtool.exe`、Node、pnpm、`qshell` 和仓库发布脚本。
- Git Bash (`bash.exe`) 在 `PATH` 中；Gplus Desktop 的现有发布器通过 Bash
  调用 Qiniu/Release 发布脚本。
- 仅通过 credentials helper 注入的 `desktop-release/<environment>/gplus-bot-desktop`
  identity；不在仓库保存 `secrets.env`、PFX 或 token。

Windows 凭据入口以私有仓库的 [developer credentials 文档](https://github.com/loulin/gplus/blob/develop/docs/development/developer-credentials.md)
和 `scripts/dev/credentials.sh` 为准。当前支持：

```text
WIN_CSC_SUBJECT_NAME
WIN_CSC_FILE + WIN_CSC_KEY_PASSWORD  (仅在选择 PFX 模式时)
QINIU_ACCESS_KEY / QINIU_SECRET_KEY
RELEASE_TOKEN
```

本文不记录这些值。

### 6.2 当前本地命令边界

签名机先校验公开 manifest 中 payload 的 SHA-256，再按 handoff 模式处理：age 使用与
handoff `profile` 对应的本地 age 私钥解密，none 直接解包 `handoff.zip`。解密 key 路径固定为上节列出的 profile 路径。
解包目录必须包含 `handoff-manifest.json` 和对应 `payload/`，然后从同一私有仓库
checkout 执行应用 adapter：

```powershell
$profile = 'staging' # production handoff 使用 'production'
$ageKey = Join-Path $env:USERPROFILE ".gplus\gplus-desktop-$profile-age-key.txt"
if (-not (Test-Path -LiteralPath $ageKey -PathType Leaf)) { throw "Missing age key: $ageKey" }
age.exe -d -i $ageKey `
  -o "$env:TEMP\gplus-handoff.zip" .\encrypted-handoff.age
Expand-Archive -LiteralPath "$env:TEMP\gplus-handoff.zip" `
  -DestinationPath "$env:TEMP\gplus-handoff" -Force
corepack pnpm --filter gplus-bot-desktop run release:finalize-handoff -- `
  --handoff "$env:TEMP\gplus-handoff" --profile $profile --target win-x64 `
  --expected-source-sha <full-source-sha> --publish
```

将 filter、profile 和 target 替换为本次唯一构建组合；Libre Reader 使用
`--filter libre-reader`。带 `--publish` 的 handoff 必须来自应用 canonical annotated
release Tag 的 peeled commit；普通分支/SHA handoff 应去掉 `--publish`，只做签名验证。
finalize 会校验 source/run identity、payload 摘要、版本、
构建号和 channel，在临时副本中重新执行 Electron Builder 签名打包，验证 installer
及 ZIP 内主程序的 Authenticode，然后复用现有发布器完成七牛 immutable object、公开 URL
回读、Release API upsert/latest 回读、target manifest 和 receipt。`--unsigned` 只能显式
用于诊断，receipt 会写入 `packageMode: unsigned` 且禁止 `--publish`；签名失败不会自动
切换到 unsigned。失败时临时 finalize workspace 会清理，handoff payload 不会被改写；
成功时只在 handoff 根目录保存 receipt 和发布结果。使用完全相同的 app/profile/target、
source SHA、签名模式和 publish 模式重跑时直接复用成功 receipt，不再次签名生成不同字节。

不要绕过应用 adapter 直接调用 `publish-gplus-desktop-updates.sh`。handoff 已包含对应
channel 的公开七牛配置，`release:finalize-handoff` 会从 handoff workspace 加载 bucket、
domain 和 prefix；Access Key、Secret Key 与 Release token 仍由签名机 credentials helper
注入。直接调用底层 publisher 时，这些公开配置不会自动补齐。

### 6.3 七牛续传、Tag 与版本排查

Gplus Bot Desktop 的七牛分片上传默认使用 4 个 worker。网络仍不稳定时，可以在执行
finalize 前人工降低并发；取值仍允许 1 到 32：

```powershell
$env:GPLUS_DESKTOP_QINIU_UPLOAD_WORKERS = '2'
```

上传中断后保留解密后的 handoff 目录，不要删除 `publish-work/qshell-workspace`。在凭据和
网络恢复后使用完全相同的 finalize 命令重跑；已生成的 signed release 会从
`finalized/signed/release` 复用，qshell 则继续使用原 resumable workspace。publisher 会先
检查公开对象的 size、SHA-512 和七牛 ETag：相同 bytes 记为 `reuse`，同 key 不同 bytes
直接失败，mutable target manifest 仍只在 immutable objects 和 Release API 校验完成后更新。

canonical annotated Tag 必须在 hosted prepare 之前已经指向本次 source SHA。Tag 缺失或
peeled commit 不匹配时，普通 staging handoff 仍可用于不带 `--publish` 的签名验证，但不能
发布；production prepare 会直接失败。Tag 修复属于人工审核操作，release 脚本不会自动移动
或强推 Tag。修复后必须重新运行 hosted prepare，使新 handoff 记录新的 tag object 和 peeled
commit，不能继续发布旧 handoff。

handoff manifest 中的 Electron 和 Electron Builder 版本来自 prepare workspace 实际解析到的
package，而不是版本范围声明；finalize 使用 handoff 内同一份 `node_modules` 和工具缓存，不使用
签名机全局安装的 Electron Builder。排查版本差异时以完整 handoff manifest 和 payload 为准。

当前私有仓库已有的发布入口可作为实现基础：

```text
apps/gplus-bot-desktop/scripts/release-gplus-desktop-local.mjs
apps/gplus-bot-desktop/scripts/run-desktop-release-target.mjs
apps/gplus-bot-desktop/scripts/publish-gplus-desktop-updates.sh
apps/gplus-bot-desktop/scripts/verify-gplus-desktop-release.mjs
```

发布器必须继续保持 immutable version path、manifest-last、Release API latest
回读和 fail-fast；不能为了适应交接而增加静默 fallback。

## 7. Staging 与 Production 发布规划

### 7.1 Staging

推荐顺序：

1. 在私有 `develop` 上按私有仓库版本脚本生成 RC version/build number 和 annotated tag。
2. 使用完整 tag commit SHA 触发 hosted Windows handoff。
3. 本地 Windows 解密、签名、重新生成 metadata、上传 staging 七牛并登记 staging Release API。
4. 在匹配的 Windows 机器上验证 RC1 -> RC2 的 auto-update 安装替换。
5. 所有 target 完成后运行私有仓库 `release:verify -- --tag <tag>` closeout。

Staging 公共配置：

```text
channel: staging
update base: https://assets.imedpower.com/apps/gplus-bot-desktop
Release API: https://gplus.staging.imedpower.com
Qiniu bucket: assets-development
```

### 7.2 Production

Production 使用同一个统一 workflow 的 `profile=production` 输入，不能通过修改 staging
参数偷换环境；应用 adapter 仍会执行稳定版本和 release identity 门禁：

- 默认源码分支为 `master`，但正式执行必须固定完整 SHA 或不可移动的 annotated release tag。
- 只接受稳定 SemVer，不接受 `rc`、`beta` 或其他 prerelease。
- 使用 Production age recipient 和受保护 GitHub Environment；需要人工批准。
- hosted Windows 只生成加密 handoff，不保存 SimplySign 私钥，不调用 Qiniu 或 Release API。
- 本地 Windows 完成 SimplySign Authenticode、最终 metadata、生产七牛和 Production
  Release API 登记。
- 只有三个 Windows target（`win-x64`、`win-arm64`、`win-ia32`）的公开对象、manifest、
  Release API latest 和安装替换全部 closeout 后，才记为本轮完整 Production release；
  macOS、Android、iOS 不属于本轮验收范围。

Production 公共配置：

```text
channel: prod
update base: https://assets.ourdrs.com/apps/gplus-bot-desktop
Release API: https://ptt.plus
Qiniu bucket: assets
```

Production 禁止事项：

- 以 `develop` 或任意未审计 feature branch 作为默认生产来源。
- 使用 unsigned package 作为生产安装包。
- 跳过 Authenticode、公开对象 readback、Release API latest readback 或 target closeout。
- 把生产 token、SimplySign session、PFX、age private key 写到 public runner。

## 8. 剩余验收清单

以下清单区分已实现的代码路径和仍需在真实 Windows/外部服务完成的验收项。
未完成的现场验收不能在 README 或 run summary 中描述为已发布能力。

### P0：保持当前构建可重复

- [x] 保留 `source_ref` 分支/SHA 输入，默认 `develop`。
- [x] 保留 App 只读权限和 `persist-credentials: false`。
- [x] 保留 Windows x64、Hermes lock、filtered install、contract smoke 和 package preflight。
- [x] age 模式只上传 sanitized manifest 和 ciphertext；none 模式仅作为显式的短期明文 ZIP 旁路。
- [x] 对 run、source SHA、version/build、target 和 artifact 保存可追溯证据。

验收：重复触发同一 SHA，workflow 成功，manifest source SHA 与输入一致；age 模式公开
artifact 中不存在源码、`source/`、`.git/` 或明文 EXE/ZIP。none 模式的明文 ZIP 必须在
Windows 下载并完成摘要校验后立即删除远端 artifact。

### P1：完成 age/短期明文 handoff

- [ ] 生成并保存 staging/prod 独立 age keypair；只把 recipient 配到对应 environment。
- [x] 增加 allow-list handoff packager 和 ciphertext manifest。
- [x] 加入 ciphertext header、大小上限、SHA-256 和明文清理检查。
- [x] 默认保持 plaintext artifact 上传禁用；`handoff_encryption=none` 是显式例外。
- [ ] 在 Windows 签名机生成并配置 staging recipient，完成真实解密验收。

验收：age 模式下公开 Actions 页面只能下载 `*.age` 和脱敏 manifest；none 模式允许下载明文
ZIP，但必须在 Windows 下载并完成摘要校验后立即删除远端 artifact；签名机能复核 source SHA、
target、version、build number 和所有文件摘要。

### P2：实现本地 Windows signed packaging wrapper

- [x] 在 adapter 中实现基于完整 handoff workspace 的离线重打包入口，并固定 Electron Builder 版本。
- [x] 在最终签名打包中重建 blockmap、`latest.yml` 和 receipt。
- [x] 集成 SimplySign subject preflight、签名重试脚本和 Authenticode 校验。
- [ ] 验证 installer 与所有 nested PE 的 Authenticode subject/status。
- [x] finalize 使用临时工作区并在 finally 清理；发布器继续清理临时 qshell 配置。

验收：签名机断网或受限网络时仍能从 ciphertext 完成签名；最终 bytes 的 metadata
和 receipt 一致；签名状态为 `Valid`；没有 unsigned artifact 被发布。

### P3：实现 staging Qiniu/Release API relay

- [ ] 使用 `desktop-release/staging/gplus-bot-desktop` credentials identity 注入凭据。
- [ ] 复用 immutable create-only、公开 HEAD/readback、manifest-last 顺序。
- [ ] Release API software `6` upsert 后回读 latest，code 等于 receipt build number。
- [ ] 完成 `win-x64` RC1 -> RC2 auto-update 安装替换验收。

验收：中途失败不会覆盖 target manifest；重试同一 tag/target 只 reuse 相同 bytes；公开
feed、Release API、receipt 和本地最终文件的 version/hash/size 一致。

### P4：启用统一 workflow 的 Production handoff

- [x] 统一 workflow 接受 `profile=production`，channel 固定 `prod`，默认源分支 `master`。
- [ ] 要求稳定版本、完整 SHA/不可移动 annotated tag 和 Production Environment approval。
- [x] 绑定独立的 production age recipient，禁止 staging recipient 和 staging URL 混用。
- [ ] 保持 hosted runner 不接触 Qiniu、Release API token 和 SimplySign private material。

验收：`develop`、prerelease、staging recipient 或 staging feed 不能通过 workflow 参数
进入 production job；生产 job 只能产生加密 handoff。

### P5：完整 Production closeout

- [ ] 按 target 矩阵完成 `win-x64`、`win-arm64`、`win-ia32`；本轮不纳入 macOS target。
- [ ] 对每个 target 验证 Authenticode、公开 immutable objects、manifest 和 Release API。
- [ ] 执行私有仓库 `release:verify -- --tag <tag>`，记录全部 target 结果。
- [ ] 在匹配硬件上完成稳定版本 N-to-N+1 更新替换。

验收：三个 Windows target 全部 `published`、build number/API code 一致、source provenance 一致，
且没有仅凭 hosted build 成功就关闭发布的情况。

## 9. 安全与停止条件

出现以下任一情况时，停止发布，不使用 fallback：

- App 权限超出 `Contents: Read-only`，或 checkout token 被持久化。
- source SHA、Hermes SHA、target、version、build number 任一不一致。
- ciphertext 无法用签名机私钥解密，或解密后出现未知文件/路径穿越。
- SimplySign 证书不存在、subject 不匹配、Authenticode 不是 `Valid`。
- 最终 metadata、blockmap、receipt、公开对象或 Release API latest 任一摘要不一致。
- 目标 feed 与 channel 不一致，尤其是 staging 写入 production URL 或反之。
- 需要把 token、证书口令、私钥写入 public repo、日志、artifact 或临时持久目录。

失败的 run、manifest、ciphertext 摘要和 release receipt 可以作为审计证据保留；
凭据值、完整环境变量和解密后的源码/安装包不能进入本仓库。
