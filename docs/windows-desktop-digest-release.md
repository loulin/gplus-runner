# Windows Desktop 摘要签名发布

`build-windows-desktop.yml` 的 `delivery_mode=digest` 是 Gplus Bot Desktop
`win-x64` 的签名打包入口。发布分两步，默认只走第一步：

| 输入 | 效果 |
| --- | --- |
| 默认（`publish=false`） | 只验证签名和打包，不上传、不登记 |
| `publish=true` | 上传不可变对象并把该版本登记为 **draft 候选**（Release API `draft`，canonical 指针不变） |
| `publish=true` + `promote=true` | 在候选基础上**显式晋升上线**（Release API `published` 并切换 canonical 指针） |

`promote=true` 必须与 `publish=true` 同时使用。Staging 验收默认停在候选即可；
只有明确要上线时才加 `promote=true`。Gplus Runner 侧不隐式晋升，
应用发布器的默认值也是草稿。

## 执行边界

云端保留应用源码、完整 PE 和 `.p7u`，签名机只接收 `.dig` 和请求 manifest。
三轮交互依次处理应用 EXE、NSIS 卸载器、NSIS 安装器。本地 SimplySign
执行 `/ds /sha1`，通过单对象七牛 token 回传响应 ZIP。云端对同一轮原始 bytes
执行 `/di`、独立时间戳和 Authenticode 验证，不复用其他 Run 的签名。

云端验证 ZIP 内 PE、updater publisher 配置与签名前后记录一致，生成最终安装器的
blockmap 和 `latest.yml`。正式发布通过应用的
`release-gplus-desktop-update.mjs --skip-build`，不重建已签名产物。
发布器负责 immutable create-only、公开 HEAD 校验、Release API upsert/latest
回读，候选阶段到此为止；只有显式晋升才继续切换 target manifest。任一步失败都停止，
不切换 unsigned。

## 来源与版本

Staging 允许从任意分支或提交发行：来源由 canonical annotated tag 的
`source-ref: origin/<branch>` 和 peeled commit 记录，可回溯到具体源码，因此不限定分支；
发布前尽量与最新 `develop` 对齐（推荐，不强制）。Production 必须从 `master` 发布，稳定版
tag 创建在 `master` 的提交上；staging 与 production **不要求复用同一个提交**（推荐流程是
staging 验证通过后经 `develop` 合入 `master`，但不强制）。
`profile=staging` 对应 `channel=staging`，必须使用 `-rc.N` 版本；
`profile=production` 对应 `channel=prod`，必须使用稳定版本。应用版本、build number、
源码提交和 canonical annotated tag 必须一致。环境 URL 由现有应用发布器与
`scripts/publish-windows-digest-release.cjs` 的 profile 映射绑定。

发布时 runner 把内置摘要签名证书的 Subject CN 作为 `WIN_CSC_SUBJECT_NAME` 注入应用发布器，
使生产 Windows 的签名门禁按真实签名的安装包执行 Authenticode 校验；该值取自
`scripts/certum-code-signing-public.pem`，与 `/ds /sha1` 使用的证书指纹一致，缺失时在调用
发布器前直接失败，不跳过校验。

`profile=staging` 对应 `channel=staging`，必须使用 `-rc.N` 版本；
`profile=production` 对应 `channel=prod`，必须使用稳定版本。应用版本、build number、
源码提交和 canonical annotated tag 必须一致。环境 URL 由现有应用发布器与
`scripts/publish-windows-digest-release.cjs` 的 profile 映射绑定。

## 前置条件

- 对应 GitHub Environment 配置 `QINIU_ACCESS_KEY`、`QINIU_SECRET_KEY`；
  正式发布还需 `RELEASE_TOKEN`。这些凭据仅注入云端发布步骤。
- 私有源码 checkout 和 Hermes SSH 配置见 [runner 设置](../README.md)。
- 本地 Windows 已登录 SimplySign，具备目标证书、PowerShell 7、SignTool 和已认证的 `gh`。
- 本地不需要七牛长期凭据、Release token、age 或完整 handoff。

## 云端命令

候选（默认，登记 draft，不上线）：

```powershell
gh workflow run build-windows-desktop.yml --repo loulin/gplus-runner `
  --ref main `
  -f application=gplus-bot-desktop -f profile=staging -f target=win-x64 `
  -f source_ref=<完整应用提交SHA> -f handoff_encryption=none `
  -f delivery_mode=digest -f publish=true
```

晋升上线（在上面基础上显式加 `promote`）：

```powershell
gh workflow run build-windows-desktop.yml --repo loulin/gplus-runner `
  --ref main `
  -f application=gplus-bot-desktop -f profile=staging -f target=win-x64 `
  -f source_ref=<完整应用提交SHA> -f handoff_encryption=none `
  -f delivery_mode=digest -f publish=true -f promote=true
```

只做签名与打包验证使用 `publish=false`。`source_ref` 用 canonical tag 的 peeled
commit；tag 未推送时 `publish=true` 会因缺少 provenance 而失败。
`handoff_encryption` 仅影响 `delivery_mode=handoff`。
Libre Reader 使用 handoff 模式，命令见 [Windows handoff](windows-desktop-release-plan.md)。

## 本地签名

确认本次真实 artifact `digest-request-<run-id>-<attempt>-round-1` 出现后执行：

```powershell
pwsh -NoProfile -File .\scripts\sign-windows-digest.ps1 `
  -RunId <真实RunId> -Profile staging `
  -CertificateSha1 '<40位证书SHA-1指纹>' `
  -SignToolPath '<本机signtool.exe完整路径>' `
  -ExpectedRounds 3
```

脚本逐项校验 manifest 的身份和摘要，只签本轮列出的文件。三轮全部回传后退出。
`-SkipCallbackUpload` 仅用于本地排查，不会完成云端闭环。
响应 ZIP 与 receipt 默认保存在 `%USERPROFILE%\.gplus\gplus-desktop-digest-responses`。
不要将请求中的上传 token 或任何长期凭据写入日志、提交或报告。

## 传输与验收

请求内容是 `request-manifest.json` 和 `digests/<file-id>/<name>.dig`；响应是
`response-manifest.json` 和 `signed/<file-id>/<name>.dig.signed`。
请求及单对象上传 token 有效期一小时，每轮云端等待最多 40 分钟。
请求 artifact 保留一天，七牛响应对象一天后自动删除，响应上限 1 MiB。
过期或失败的 Run 必须重新构建，不能修改 manifest 绕过有效期。

验收报告 artifact 为 `digest-release-verification-<run-id>-<attempt>`，包含
`digest-release-receipt.json`，发布时另含 canonical `release-receipt.json` 和
`publish-result.json`。必须确认三轮每项为 Valid、证书指纹匹配、有 Certum 时间戳，
最终文件摘要与公开对象、feed 和 Release API 一致。

Staging 发布验收 [Run 34485941144](https://github.com/loulin/gplus-runner/actions/runs/34485941144)
验证了 21 个应用 EXE、1 个卸载器、1 个安装器，全部 Authenticode Valid 且带
Certum 时间戳。版本为 `0.2.6-rc.1 / 1055`，Release API 记录 `162` 为 `published`，
公开 receipt、feed 和 immutable HEAD 回读通过。请求 ZIP 合计 11,020 bytes，
响应 ZIP 合计 18,121 bytes。安装替换和自动更新需要匹配硬件的独立验收，不能用
云端发布成功代替；Production 也需要单独执行和验收。
