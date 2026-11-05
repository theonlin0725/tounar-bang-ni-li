# 历史“自身页面误采集”识别报告（2026-11-01）

## 范围

只读审计 **4311 固定自测库** `data/mail-selftest/tounar.sqlite`，origin 为 `http://127.0.0.1:4311`。审计不修改任何数据；`--apply` 已在数据库副本上验证，未对运行库执行。

## 结果

| 项目 | 数量 |
|---|---:|
| 当前台账 | 42 |
| 当前事件 | 131 |
| 当前待确认 | 62（open 50） |
| 指向 4311 自身页面的事件 | **40** |
| 这些事件关联的待确认 | **28** |
| 其中仍 open | **27** |
| 这些事件关联的台账记录 | **2** |

关联的两条台账：

- `app_QAFP_I52ESH_4gkW`：公司“11”、岗位“22”，是 10-22 的既有记录；事件只是指向 4311，不能仅凭此证明整条记录都是误采集。
- `app_ac_3R0cQdSbhpk5o`：岗位“批次待补充 · 城市待补充”，`job_url` 为 `http://127.0.0.1:4311/`，明显是本项目自身页面误采集。

因此脚本**只列出台账、不删除/不归档任何应用**；是否清理这两条需要用户单独判断。

## 修复后的持续防漏

- 内容脚本在打开、停留、刷新、路由切换、主动采集、列表采集、表单/状态扫描、反馈等入口识别自身页面。
- Service worker 在入队和 flush 时逐条丢弃自身页面事件；不清空其他队列。
- 服务端按实际 Host/`APP_BASE_URL`/本机端口构造 origin，拒绝 `SELF_APP_EVENT`，不入库、不建待确认。
- 2026-10-31 修复后重启 4311，目标插件心跳恢复；截至 2026-11-01 00:27 没有新增自身页面事件。

## 历史数据处理（未自动执行）

只读报告：

```bash
npm run audit:self-captures -- \
  --db data/mail-selftest/tounar.sqlite \
  --origin http://127.0.0.1:4311
```

确认后的定向处理（只做两件事：事件标记 ignored；27 条 open 的自身页面待确认标记 dismissed）：

```bash
npm run audit:self-captures -- \
  --db data/mail-selftest/tounar.sqlite \
  --origin http://127.0.0.1:4311 \
  --apply --confirm
```

在副本上执行的结果：40 条事件 ignored、27 条 open 待确认 dismissed、42 条台账不变、`integrity_check=ok`。可以随时从 `data/recovery-backups/` 的备份恢复。

## 未做

- 没有自动删除/归档任何台账；
- 没有清空插件队列；
- 没有修改用户事件历史（只会在显式 `--apply` 时改 processing_state）。
