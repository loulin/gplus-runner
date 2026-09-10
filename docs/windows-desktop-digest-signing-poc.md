# Windows Desktop 摘要签名 POC

状态：实验性。`build-windows-desktop.yml` 的 `delivery_mode=digest` 生成摘要请求；
同时设置 `complete_digest_poc=true` 可运行 staging win-x64 三轮签名和打包验证。
该入口不上传安装包、不调用 Release API、不发布版本。

## 目标

验证 `signtool /dg -> /ds -> /di` 能够把已登录 Certum SimplySign 的本地 Windows
机器作为摘要签名端，而不是让它下载完整 Windows build workspace。目标闭环是：

```text
GitHub Windows Job 保留构建目录和 .p7u
  -> 小型 digest request artifact
  -> 本地 signtool /ds
  -> 单个 Qiniu callback ZIP
  -> GitHub Windows Job signtool /di、时间戳、打包和验签
```

完整 POC 使用三轮交互：应用 EXE、NSIS 卸载器、NSIS 安装器。NSIS 必须先把已签
卸载器嵌入安装器，才能生成安装器摘要，因此卸载器和安装器不能合并为同一轮。

## 前置条件

- Windows 签名机已登录 SimplySign Desktop，且能从证书管理器取得目标证书的 40 位 SHA-1 指纹。
- Windows SDK `signtool.exe`、PowerShell 7 (`pwsh`) 和 GitHub CLI `gh` 可用。
- GitHub CLI 已认证，或设置一个仅有 `Actions: Read` 的
  `GH_RELEASE_ARTIFACT_TOKEN`。令牌不写入脚本、收据或日志。
- 云端 workflow 已产生本轮 request artifact，且 request 内的 Qiniu upload token
  尚未过期。

本地脚本不需要 `age`、Qiniu Access Key、Qiniu Secret Key、Release API token 或
完整 handoff artifact。

## Request 和 Response

每轮 request artifact 名称固定为：

```text
digest-request-<run-id>-<run-attempt>-round-<round>
```

单轮本地 P1 request artifact 保留 7 天，manifest 的 `expiresAt` 设置为生成后 6 天。Windows
签名机可以延后处理，但必须在 `expiresAt` 之前运行；过期 request 必须重新触发云端
workflow，不能通过修改本地 manifest 绕过有效期校验。该单轮入口必须使用
`-SkipCallbackUpload`，其 callback 字段不提供可用上传 token。

`complete_digest_poc=true` 的请求和单对象上传 token 有效期均为一小时，每轮云端等待
最多 40 分钟。请求 artifact 保留一天，七牛响应对象设置一天后自动删除。云端只上传
摘要请求和 `digest-poc-verification-<run-id>-<attempt>` 验证报告 artifact。

它只包含：

```text
request-manifest.json
digests/<file-id>/file.dig
```

`.p7u` 必须由云端 Job 留在原 workspace；本地不能收到它，也不能下载
`win-unpacked`、installer 或完整 handoff。

`request-manifest.json` 必须包含 app/profile/channel/target、source SHA、run ID、
run attempt、round、过期时间、每个 `.dig` 的 file ID/path/SHA-256，以及 callback：

```json
{
  "uploadUrl": "https://upload-<region>.qiniup.com",
  "objectKey": "signing-callbacks/<channel>/<target>/<run-id>-<attempt>/round-<round>-<exchange-id>.zip",
  "uploadToken": "short-lived-single-object-token",
  "maxResponseBytes": 1048576
}
```

本地输出唯一 response object：

```text
signed-response-<exchange-id>.zip
  response-manifest.json
  signed/<file-id>/file.dig.signed
```

response manifest 回填 request manifest 的 SHA-256、exchange ID、证书 SHA-1、完成时间和
每个 signed digest 的 SHA-256。`/ds` 阶段不请求时间戳，云端必须在下载后再校验这些字段，
将 `.dig.signed` 与保留的同目录 `.p7u` 一起交给 `/di`，然后对最终 PE 单独执行
`signtool timestamp /tr http://time.certum.pl /td SHA256`。

## 本地运行

先用一个 round 验证本地 `/ds` 与 artifact 协议，不上传 callback：

```powershell
pwsh -NoProfile -File .\scripts\sign-windows-digest.ps1 `
  -RunId <run-id> `
  -Profile staging `
  -CertificateSha1 '<40 位证书 SHA-1 指纹>' `
  -ExpectedRounds 1 `
  -SkipCallbackUpload
```

`-SkipCallbackUpload` 会把 response ZIP 保留在：

```text
%USERPROFILE%\.gplus\gplus-desktop-digest-responses
```

完整验证先触发云端入口，再使用返回的真实 Run ID 启动签名机。staging environment
须配置 `QINIU_ACCESS_KEY` 和 `QINIU_SECRET_KEY`；本地只接收单对象上传 token。

```powershell
gh workflow run build-windows-desktop.yml --repo loulin/gplus-runner `
  --ref codex/windows-digest-signing-poc `
  -f application=gplus-bot-desktop -f profile=staging -f target=win-x64 `
  -f source_ref=<完整应用提交SHA> -f handoff_encryption=none `
  -f delivery_mode=digest -f complete_digest_poc=true
```

第一轮真实摘要 artifact 出现后执行以下命令；三轮响应均回传后脚本退出：

```powershell
pwsh -NoProfile -File .\scripts\sign-windows-digest.ps1 `
  -RunId <run-id> `
  -Profile staging `
  -CertificateSha1 '<40 位证书 SHA-1 指纹>' `
  -SignToolPath '<本机 signtool.exe 完整路径>' `
  -ExpectedRounds 3
```

本地脚本只按 request manifest 的 `files[]` 逐项签名，拒绝扫描任意 `.dig` 文件。它
在上传前检查回传 ZIP 大小，并检查 Qiniu 返回的 object key。失败时不会上传成功标记
或改走 unsigned 发布。

## POC 次序和停止条件

1. P0：使用不含应用代码的临时 unsigned PE，实测 `/dg -> /ds -> /di`；`/ds`
   使用 `/sha1`，`/di` 后单独执行 `signtool timestamp /tr http://time.certum.pl /td SHA256`，
   再用 `signtool verify` 与 `Get-AuthenticodeSignature` 确认 `Valid`。
2. P1：Gplus Bot Desktop staging `win-x64` 完成三轮摘要、已签 ZIP/NSIS、独立
   blockmap、`latest.yml` 和 release receipt，但不发布。
   ZIP 内应用 EXE 和 updater publisher 配置必须与打包前哈希一致。验证报告记录每轮
   PE 的 Authenticode 结果、证书指纹、Certum 时间戳和最终产物摘要。
3. P2：再接入云端的 Qiniu upload 和 Release API，完成一次 staging 发布后才讨论
   Production。

任一步失败必须停止并记录错误，不自动切换 unsigned。停止条件包括：SimplySign 不支持 `/ds`、时间戳或
Authenticode 验证失败、electron-builder 改写了第一轮已签的 `win-unpacked`，或最终
installer 签名后不能独立重新生成 blockmap。
