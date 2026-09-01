# Gplus Bot Desktop Windows 构建与发布计划

本文是 `loulin/gplus-runner` 的操作真源。它记录已经验证的跨仓库构建过程、
当前安全边界，以及从 Staging 构建继续到本地 Windows 签名、七牛上传和
Production 发布所需的工作。公开 runner 只保存自动化脚本和文档，Gplus Bot
Desktop 源码仍在私有仓库 `loulin/gplus`。

## 1. 目标与边界

目标是利用 GitHub 的原生 Windows runner 处理网络和构建工作，再把受保护的
构建上下文交给可使用 Certum SimplySign 的 Windows 机器完成最终签名和发布。
当前流程只覆盖第一阶段：

```text
private loulin/gplus
        |
        | GitHub App: Contents read-only
        v
public gplus-runner workflow_dispatch(source_ref)
        |
        | windows-latest x64
        v
checkout -> Hermes -> filtered dependencies -> JS smoke -> unsigned package
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
- 当前 workflow：`.github/workflows/build-staging.yml`（`Staging Windows Desktop Build`）
- 当前 target：`win-x64`
- 当前 channel：`staging`
- App 名称：`gplus-source-reader`

### 2.2 GitHub App 权限

`gplus-source-reader` 只安装到私有仓库 `loulin/gplus`，权限为：

```text
Contents: Read-only
```

runner 仓库只保存以下两个 Secret 名称对应的值：

```text
GPLUS_SOURCE_READER_APP_ID
GPLUS_SOURCE_READER_PRIVATE_KEY
```

私钥不能从 GitHub 读回，也不能写入本文档、workflow 输出、artifact 或
提交记录。App 不需要 Issues、Pull requests、Actions、Deployments、Packages
或 Administration 权限。

## 3. 当前 Staging workflow

### 3.1 输入约定

workflow 只接受 `workflow_dispatch`，输入为：

```text
source_ref: private loulin/gplus branch name or full 40-character commit SHA
default: develop
```

`develop` 适合日常验证，但不是不可变输入。发布或问题复现应使用完整 SHA。
`--ref main` 是 public runner workflow 的分支，不是应用源码分支。

### 3.2 执行顺序

1. checkout `gplus-runner`，并关闭 credential persistence。
2. 使用 `actions/create-github-app-token` 创建只读、短生命周期的源码 token。
3. 将 `loulin/gplus` checkout 到临时 `source/` 目录，按 `source_ref` 固定版本，
   初始化 Hermes submodule，并关闭 credential persistence。
4. 在 `windows-latest` 上安装固定版本 `age`、Node.js 24、Python 3.13 x64 和 uv。
5. 校验 staging age recipient 已配置；没有公钥时在构建前失败。
6. 清理 hosted Python 的 `python3.exe` 重解析点，确认实际 Python 可执行文件，
   将路径传给 Desktop 的离线依赖准备逻辑。
7. 从私有仓库的 `hermes-source-lock.json` 读取锁定的 Hermes tag，并只 fetch 该 tag。
8. 校验源码 commit、Hermes submodule commit、Node architecture 和 submodule 状态。
9. 使用 frozen lockfile 安装 `gplus-bot-desktop...` filtered workspace，并构建
   `@gplus/bot-contracts`。
10. 运行 Desktop JavaScript contract smoke tests。
11. 调用私有仓库的 `run-desktop-release-target.mjs win-x64`，固定 staging feed/API，
    并设置 `DESKTOP_WIN_SKIP_SIGN_AND_EDIT=1` 生成 unsigned NSIS 和 ZIP package。
12. 对生成的 package、Electron runtime、`app.asar` 和应用脚本执行打包前置校验，
    包括 Windows nested asar path、应用身份和 ByteNode 禁止规则。
13. 使用 `scripts/package-windows-handoff.ps1` 只复制 allow-list 中的
    `win-unpacked`、Builder 配置/签名钩子、参考 metadata 和脱敏 manifest。
14. 使用固定 `age` 版本和 staging recipient 加密 handoff，检查 age header、大小和
    SHA-256 后上传 ciphertext artifact；不上传任何明文构建目录。
15. 上传结束后删除生成的明文 target workspace。

当前 workflow 的依赖准备使用：

```text
corepack pnpm install --filter 'gplus-bot-desktop...' --recursive \
  --frozen-lockfile --ignore-scripts
corepack pnpm --filter '@gplus/bot-contracts' run build
```

当前 unsigned package 的实际构建参数等价于：

```text
node apps/gplus-bot-desktop/scripts/run-desktop-release-target.mjs \
  win-x64 --channel staging \
  --base-url https://assets.imedpower.com/apps/gplus-bot-desktop \
  --api-base-url https://gplus.staging.imedpower.com
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

成功 run 带有 GitHub 的 Node.js 20 deprecation annotation：当前 pinned action
被 runner 强制使用 Node.js 24，未影响本次构建。后续维护应在升级 action 到
Node.js 24 原生版本后重新跑一次 build，并复核 action SHA。

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
gh workflow run build-staging.yml \
  --repo loulin/gplus-runner \
  --ref main \
  -f source_ref=develop
```

问题复现或候选版本使用完整 SHA：

```bash
gh workflow run build-staging.yml \
  --repo loulin/gplus-runner \
  --ref main \
  -f source_ref=<40-character-private-commit-sha>
```

查询并下载脱敏 manifest 与加密 handoff：

```bash
gh run list --repo loulin/gplus-runner --workflow build-staging.yml --limit 5
gh run watch <run-id> --repo loulin/gplus-runner --exit-status
gh run download <run-id> --repo loulin/gplus-runner \
  --name gplus-bot-desktop-staging-manifest-<run-id>
gh run download <run-id> --repo loulin/gplus-runner \
  --name gplus-bot-desktop-staging-handoff-<run-id>
```

本 Workflow 的构建输出发布到当前 Run 的 GitHub Actions Artifact，而不是
Git Tag 或 GitHub Release：

- `gplus-bot-desktop-staging-handoff-<run-id>`：age 加密 ZIP 和脱敏 ciphertext manifest，
  供 Windows 签名机下载。
- `gplus-bot-desktop-staging-manifest-<run-id>`：只含源码、版本、构建号和文件摘要的脱敏 manifest。

Artifact 目前保留 7 天，只是跨机器交接存储。Tag 不承担二进制存储职责；私有仓库的 annotated
release tag 只在正式 `release:local` 发布和 `release:verify` closeout 中用于固定版本身份、
tag object、peeled commit 和 source ref。使用本 Workflow 从任意 branch/SHA 做 staging 验证时，
不需要为了保存产物创建 Tag；但该 branch 构建不能直接冒充已有 release tag 的正式 target。

不要仅凭 runner 启动、checkout 成功或依赖安装成功判断构建完成；必须看到
`Build unsigned Windows package`、`Write sanitized build manifest`、
`Create encrypted Windows handoff` 和两个 upload steps 全部成功。

### 4.2 失败定位

按以下顺序读取 run：

1. `Create read-only source token`：检查 App installation 和两个 runner Secret 名称。
2. `Checkout private source at requested ref`：检查 branch/SHA 是否存在及 App 是否只读可见。
3. `Fetch locked Hermes release tag`：检查 submodule remote 和锁定 tag 是否仍可访问。
4. `Validate packaging Python layout`：检查 hosted runner 的 Python alias 变化。
5. `Install filtered workspace dependencies`：检查锁文件、npm registry 和网络下载。
6. `Run Desktop JavaScript contract smoke`：先修复契约或源码版本问题，再重跑。
7. `Build unsigned Windows package`：读取完整失败日志，重点检查 Electron builder binary、
   Hermes 离线依赖、路径长度、`app.asar` 和 NSIS。
8. handoff/upload：确认公开 artifact 只包含 `.zip.age` 和 ciphertext manifest，并检查
   allow-list、ciphertext header、SHA-256 和 artifact retention。

## 5. 加密 artifact 交接设计

### 5.1 当前方案

采用 `age` 公钥加密：

- Windows 签名机生成一次 staging 和一次 production 的 age keypair。
- 私钥只保存在签名机受 ACL 保护的本地目录，Never upload。
- runner 只配置对应的 age recipient 公钥（Actions variable，不是 Secret）。
- hosted workflow 将允许列表中的构建上下文加密后才上传 GitHub artifact；实现位于
  `scripts/package-windows-handoff.ps1`。
- 签名机下载 ciphertext，解密到临时目录，验证 manifest 后再进入签名流程。

公钥泄露不会解密 artifact；私钥泄露则会暴露该环境的历史和未来交接包，因此
staging、production 必须使用不同 keypair。私钥轮换时停用旧 recipient，保留已完成
发布所需的审计记录，不把私钥放进仓库 Secret。

### 5.2 加密包内容

加密包只允许包含当前 target 的最小交接材料。当前 payload 结构为：

```text
payload/
  handoff-manifest.json
  build/staging-build-manifest.json
  builder/package.json
  builder/scripts/notarize.cjs
  builder/scripts/notarize-artifact.cjs
  builder/scripts/notarize-artifact-hook.cjs
  builder/scripts/sign-win-retry.cjs
  prepackaged/win-unpacked/
  reference/latest.yml
  reference/*.blockmap
```

具体目录和格式必须由实现脚本固定 allow-list，不能直接把整个 checkout、
`.git`、`node_modules` 或未知文件打包。若当前 Electron Builder 需要完整生成
workspace 才能在本地完成签名，必须先评估 artifact 体积和临时磁盘空间；超出限制时
应交接最小 `win-unpacked` 和可重现的构建元数据，而不是退回明文上传。

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

因此后续实现必须二选一并用真实 Windows 验证证明：

1. **推荐**：hosted runner 交接经过校验的 `win-unpacked`/prepackaged build context，
   本地 Windows 用同一版本的 Electron Builder 重新执行签名打包，并重新生成
   blockmap、`latest.yml`、receipt；或
2. 实现一个明确的 post-package signing adapter，签署所有要求的嵌套 PE 文件，
   重新生成所有受 bytes 影响的 metadata，再运行现有 receipt/publish 校验。

在上述 adapter 和回归测试完成前，禁止把“下载 unsigned installer 后调用 signtool”
当作可发布流程。

### 5.4 hosted workflow 步骤

在 unsigned package 成功后执行独立的加密 handoff 阶段，失败应停止并不上传
任何明文安装包：

1. 固定并记录 `sourceSha`、Hermes SHA、channel、target、version、build number。
2. 只复制 allow-list 文件到临时 handoff 目录。
3. 用 environment 对应的 age recipient 加密整个 handoff 包。
4. 在 runner 上检查 ciphertext magic/header、非空、大小上限和 SHA-256。
5. 上传 `*.age` ciphertext 与脱敏 ciphertext manifest；不上传 plaintext。
6. 设置短 retention（当前为 7 天），并在 run summary 显示下载入口、摘要和过期时间。
7. job 结束时删除明文 handoff 目录；GitHub runner 是临时环境，但清理仍作为显式步骤保留。

当前变量名：

```text
GPLUS_DESKTOP_ARTIFACT_AGE_RECIPIENT_STAGING
GPLUS_DESKTOP_ARTIFACT_AGE_RECIPIENT_PROD
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

### 6.2 待实现的本地命令边界

应增加一个私有仓库脚本或受控 Windows wrapper，接受：

```text
encrypted_handoff
environment: staging | prod
expected sourceSha / target / version / buildNumber
```

它必须按以下顺序执行：

1. 下载 ciphertext，并在解密前校验 ciphertext SHA-256 和 expected run identity。
2. 解密到一次性目录，拒绝路径穿越、未知文件和不匹配的 source/target/version/build。
3. 使用同一 pinned Electron Builder 版本执行签名打包或 post-package signing adapter。
4. 对 installer、nested executables 和 update code signature 执行 Authenticode 校验，
   状态必须为 `Valid`，签名 subject 必须等于 `WIN_CSC_SUBJECT_NAME`。
5. 在最终 bytes 上重新计算 size、SHA-256、SHA-512、blockmap 和 `latest.yml`，生成
   canonical release receipt。
6. 先做 Qiniu immutable object inspect；同 key 同 bytes 才允许 reuse，不同 bytes 直接失败。
7. 上传并从公开 URL 校验 immutable objects 的 size/hash/ETag；不能只看 qshell 返回码。
8. 调用 Release API software `6` 的 upsert，`code` 使用 receipt 的 `buildNumber`，
   然后回读 latest 并校验 version、URL、hash、size。
9. 最后才覆盖 target manifest、刷新 CDN，并再次回读 manifest bytes。
10. 成功或失败都清理解密目录、临时 qshell 配置和临时 token 文件。

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

Production 必须是独立 workflow 或独立 job，不能通过修改 staging input 偷换环境：

- 默认源码分支为 `master`，但正式执行必须固定完整 SHA 或不可移动的 annotated release tag。
- 只接受稳定 SemVer，不接受 `rc`、`beta` 或其他 prerelease。
- 使用 Production age recipient 和受保护 GitHub Environment；需要人工批准。
- hosted Windows 只生成加密 handoff，不保存 SimplySign 私钥，不调用 Qiniu 或 Release API。
- 本地 Windows 完成 SimplySign Authenticode、最终 metadata、生产七牛和 Production
  Release API 登记。
- 只有五个 target 的公开对象、manifest、Release API latest 和安装替换全部 closeout
  后，才记为完整 Production release。

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

## 8. 后续任务清单

以下清单是后续实现的停止点和验收标准。未完成项不能在 README 或 run summary 中
描述为已发布能力。

### P0：保持当前构建可重复

- [x] 保留 `source_ref` 分支/SHA 输入，默认 `develop`。
- [x] 保留 App 只读权限和 `persist-credentials: false`。
- [x] 保留 Windows x64、Hermes lock、filtered install、contract smoke 和 package preflight。
- [x] 只上传 sanitized manifest 和 age ciphertext，不上传明文 installer。
- [x] 对 run、source SHA、version/build、target 和 artifact 保存可追溯证据。

验收：重复触发同一 SHA，workflow 成功，manifest source SHA 与输入一致，公开 artifact
中不存在源码、`source/`、`.git/` 或明文 EXE/ZIP。

### P1：完成 age 加密 handoff

- [ ] 生成并保存 staging/prod 独立 age keypair；只把 recipient 配到对应 environment。
- [x] 增加 allow-list handoff packager 和 ciphertext manifest。
- [x] 加入 ciphertext header、大小上限、SHA-256 和明文清理检查。
- [x] 将 plaintext artifact 上传步骤保持禁用。
- [ ] 在 Windows 签名机生成并配置 staging recipient，完成真实解密验收。

验收：公开 Actions 页面只能下载 `*.age` 和脱敏 manifest；没有 age private key 时无法
解密；签名机解密后能复核 source SHA、target、version、build number 和所有文件摘要。

### P2：实现本地 Windows signed packaging wrapper

- [ ] 在 Windows 上验证 `win-unpacked/prepackaged` 重打包方案，并确定 nested PE 的签名顺序。
- [ ] 固定 Electron Builder 版本，重建最终 blockmap、`latest.yml` 和 receipt。
- [ ] 集成 SimplySign subject preflight 和 `signtool` 重试脚本。
- [ ] 验证 installer 与所有 nested PE 的 Authenticode subject/status。
- [ ] 解密目录、qshell 配置和临时凭据实现 finally 清理。

验收：签名机断网或受限网络时仍能从 ciphertext 完成签名；最终 bytes 的 metadata
和 receipt 一致；签名状态为 `Valid`；没有 unsigned artifact 被发布。

### P3：实现 staging Qiniu/Release API relay

- [ ] 使用 `desktop-release/staging/gplus-bot-desktop` credentials identity 注入凭据。
- [ ] 复用 immutable create-only、公开 HEAD/readback、manifest-last 顺序。
- [ ] Release API software `6` upsert 后回读 latest，code 等于 receipt build number。
- [ ] 完成 `win-x64` RC1 -> RC2 auto-update 安装替换验收。

验收：中途失败不会覆盖 target manifest；重试同一 tag/target 只 reuse 相同 bytes；公开
feed、Release API、receipt 和本地最终文件的 version/hash/size 一致。

### P4：增加 Production handoff workflow

- [ ] 新增独立的 production workflow，channel 固定 `prod`，默认源分支 `master`。
- [ ] 要求稳定版本、完整 SHA/不可移动 annotated tag 和 Production Environment approval。
- [ ] 绑定 production age recipient，禁止 staging recipient 和 staging URL 混用。
- [ ] 保持 hosted runner 不接触 Qiniu、Release API token 和 SimplySign private material。

验收：`develop`、prerelease、staging recipient 或 staging feed 不能通过 workflow 参数
进入 production job；生产 job 只能产生加密 handoff。

### P5：完整 Production closeout

- [ ] 按 target 矩阵完成 `win-x64`、`win-arm64`、`win-ia32`，并与 macOS target 协调。
- [ ] 对每个 target 验证 Authenticode、公开 immutable objects、manifest 和 Release API。
- [ ] 执行私有仓库 `release:verify -- --tag <tag>`，记录全部 target 结果。
- [ ] 在匹配硬件上完成稳定版本 N-to-N+1 更新替换。

验收：五个 target 全部 `published`、build number/API code 一致、source provenance 一致，
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
