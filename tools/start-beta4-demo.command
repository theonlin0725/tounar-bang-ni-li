#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  print '未找到 Node，请在能运行 node -v 的终端里执行此文件。'
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("需要 Node 24 或以上"); process.exit(1); }'
if lsof -nP -iTCP:4312 -sTCP:LISTEN >/dev/null 2>&1; then
  print '4312 已有服务运行。若为本演示，请直接打开 http://127.0.0.1:4312；否则先检查占用情况。'
  exit 1
fi
demo_data="$PWD/data/beta4-local-demo"
if [[ ! -d "$demo_data" ]]; then
  node server/scripts/local-acceptance.js \
    --source-db "$PWD/data/mail-selftest/tounar.sqlite" \
    --data-dir "$demo_data" --port 4312 --no-start
fi
if [[ ! -f "$demo_data/tounar.sqlite" || ! -f "$demo_data/master.key" ]]; then
  print '演示副本不完整，请保留现场检查；不会覆盖已有目录。'
  exit 1
fi
print '\n本地演示：http://127.0.0.1:4312'
print '登录邮箱：1191240794@qq.com；获取验证码后自动填入。'
print '请保持终端打开。结束时按 Control+C；下次启动保留演示数据。'
print '邮件只写本地文件；AI 功能沿用项目配置，需要联网。\n'
exec env \
  DATA_DIR="$demo_data" DB_PATH="$demo_data/tounar.sqlite" \
  HOST=127.0.0.1 PORT=4312 APP_BASE_URL=http://127.0.0.1:4312 \
  APP_ENV=development APP_VERSION=20261102-beta4-local \
  CLOUD_PERSISTENCE_ENABLED=false CLOUD_LLM_ENABLED=false \
  MAIL_MODE=outbox SMTP_URL='' ENABLE_SCHEDULER=false \
  ENABLE_SELFTEST_LOGIN=true ENABLE_MAIL_BUSINESS_TEST=true \
  ADMIN_EMAILS=1191240794@qq.com ALLOWED_EMAILS=1191240794@qq.com \
  MASTER_KEY='' INTERNAL_TICK_TOKEN='' OTP_PEPPER='' SHARE_CODE='' \
  node --env-file=.env server/src/index.js
