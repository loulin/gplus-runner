# loulin/gplus-runner

本仓库是 **public** 的，只为借用 GitHub 免费的 macOS 构建额度，同时持有生产发布凭据
（`production` environment secrets）。因此按生产代码对待。

## 硬性规则

- 只接受仓库所有者 `loulin` 本人的提交；禁止合并外部贡献者的 PR。
- 禁止新增 `push` / `pull_request` / `pull_request_target` / `workflow_run` / `schedule`
  触发器；发布入口保持 `workflow_dispatch`。
- 禁止把凭据写进日志、artifact 或测试夹具，包括 base64/hex/URL 编码等变换形式：GitHub 的
  日志脱敏只匹配原始字面量，而 public 仓库的日志全世界可读。
- 禁止把 self-hosted runner 注册到本仓库。
- 改动 `.github/workflows/**`、environment 配置或 secret 作用域前，先说明对 production
  凭据可达性的影响。
- `production` environment 的保护只有"只允许 `main`"这一条 deployment branch policy；
  放宽前必须先取得用户确认。
