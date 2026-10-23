# 本机真实数据的隔离验收

用户已明确：唯一真实库在 Mac 的 `/Users/mingenlin/Desktop/opencode project/帮你理/data/tounar.sqlite`。用户报告台账 6、邮件 84、待确认 20、用户 2；这些是用户提供的数量，尚未经本云环境读取核实。云工作区 `/workspace` 没有挂载该 Mac 路径。

本轮验收一律使用 `MAIL_MODE=outbox`，禁止真实 SMTP 发信。无需上传 `.env`、`master.key`、`internal-tick.token` 或完整 `data/`；去除邮箱凭据的副本足够验证现有台账、待确认、迁移及回看。真实 IMAP 同步在该副本中不可用，这项限制保留在交付报告。

## 1. 在 Mac 导出去凭据副本

需要 Node ≥24。先停下原服务。导出工具是独立文件，只依赖 Node 内置模块，可以单独下载后运行，无需提前发布或推送二期代码。

```bash
cd "/Users/mingenlin/Desktop/opencode project/帮你理"
# 将下载的 export-acceptance-copy.js 放到下方路径，或改为实际下载位置。
node ~/Downloads/export-acceptance-copy.js \
  --db data/tounar.sqlite \
  --out /tmp/tounar-acceptance-export
```

输出目录必须尚不存在，已有目录会拒绝覆盖。工具以只读方式打开原库，使用 SQLite backup API 包含 WAL 中的已提交数据，在副本中清空邮箱密文/IV/tag 并断开邮箱连接，删除原会话、OTP、插件配对/设备及提醒确认令牌。随后清理副本的空闲页，检查完整性和外键。没有导入应用配置、迁移原库、读取密钥或发送邮件。

只产生两个文件：`tounar.sqlite` 和 `manifest.json`。目录权限 0700，文件权限 0600。若失败，删除本次新建的未完成导出目录。成功后核对 manifest 的四项业务数量与原库一致。

**这个副本仍含真实台账、邮箱地址和邮件摘要，不是匿名数据。** 如要在当前云环境验收，仅提供这两个文件，不要提供原库、整个 data 目录或密钥。也可保留在本机，待二期代码可用后按下节验收。

## 2. 在独立运行副本中启动

保留收到的导出库不动，再用同一工具复制到新的运行目录，作为迁移前基线；此处命令在二期仓库根目录执行。原库和第一次导出均不被迁移。

```bash
node server/scripts/export-acceptance-copy.js \
  --db /tmp/tounar-acceptance-export/tounar.sqlite \
  --out /tmp/tounar-acceptance-runtime

DATA_DIR=/tmp/tounar-acceptance-runtime \
DB_PATH=/tmp/tounar-acceptance-runtime/tounar.sqlite \
HOST=127.0.0.1 PORT=4311 APP_BASE_URL=http://127.0.0.1:4311 \
MAIL_MODE=outbox SMTP_URL= ENABLE_SCHEDULER=false CLOUD_LLM_ENABLED=false \
ALLOWED_EMAILS=1191240794@qq.com \
npm start
```

测试服务使用 4311，避开原来的 4310。新目录生成自己的测试密钥，不需要与原库同源，因为导出已移除所有依赖旧密钥的授权材料。关闭定时任务及云 LLM；需要测试某次回看批次时，在同样的环境变量下手动触发，产物只写测试 outbox。

登录时用测试服务申请 OTP，并在另一终端运行：

```bash
DATA_DIR=/tmp/tounar-acceptance-runtime \
MAIL_MODE=outbox SMTP_URL= npm run otp:latest
```

不要将 OTP、会话 cookie、数据库内容或邮件摘要贴进 Git、截图或交付报告。

## 3. 对实际数据逐条验收

- 迁移后核对四项业务数量及原信关联回填，确认原始导出未变；重复启动验证迁移幂等。
- 用测试账号登录，读取原有 20 条待确认；记录脱敏项编号、分类、原候选数、点击路径、API 状态码、前后版本。
- 对每一项在运行副本验证关联已有记录或按邮件新建；不能判断真实归属的项记录为需用户判断，不能伪造“正确归属”。验证提交后计数、台账变化与撤销。
- 验证收信日期、深链、阶段回看及 outbox 的 HTML/文本内容；这是本地邮件产物验收，不是 SMTP 送达验收。
- 运行旧字段修复脚本的默认 dry-run，只记录疑似错误字段的数量及原因。真实原库不执行 `--apply`。

这些步骤尚待取得真实副本后执行。完成并更新二期交付报告后，再申请发布；独立 GitHub 验收分支的 push 已获授权并完成；生产部署和真实台账修复仍未授权。
