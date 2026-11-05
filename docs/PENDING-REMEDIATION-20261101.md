# 现有待确认清理与自动整理对账（2026-11-01）

## 后续状态（2026-11-01 15:30）

用户随后在真实页面确认了「数字广东」等线索；截至 18:57 当前 open=4、apps=55、events=137。该动作由用户完成，不计入本对账的自动修复数量；其余 5 条仍需确认/补录。

## 备份

处理前备份：

`data/recovery-backups/2026-11-01T05-42-54-724Z-pre-pending-remediation/`

备份完整性 `ok`；处理前 52 条台账、62 条复核项、28 条 open。

## 数量对账

| 项目 | 数量 |
|---|---:|
| 处理前待确认 | 28 |
| 自动忽略：自身页面/无有效信息 | 19 |
| 自动新建台账 | 1 |
| 自动更新已有台账 | 0 |
| 无需变更但已处理 | 0 |
| 自动忽略：邮件非进展/自身线程 | 2 |
| 恢复为有效待确认 | 2（见下） |
| 处理后仍需人工确认 | 6 |
| 处理失败 | 0 |
| 归档的历史无效台账 | 3 |

28 = 19 invalid + 1 created + 2 auto ignored + 6 remaining。恢复的 2 条是邮件头明确但无正文的网易游戏面试收集、招商银行笔试提醒；它们不应因没有正文被自动忽略。

## 自动忽略的 19 条

- 18 条来自本项目自身页面：首轮 18 条 open 自身页面复核全部关闭；0 条自身页面 open 复核。
- 1 条是真实拼多多页面的 form_started 无法归属，没有招聘进展证据，按“非进展”忽略。
- 关闭使用 `resolveReview(action=dismiss)`，保留 resolution/reason/event evidence，不删除事件。

## 三条归档历史台账

- `app_ac_3R0cQdSbhpk5o`：自身页面链接 `http://127.0.0.1:4311/`；归档并把 job_url/canonical_job_url 清空，避免“查看岗位”回到本系统。原链接证据仍在事件/审计中。
- 两条腾讯记录标题为“加分项或注意事项”，是页面 section/占位标题，归档但不删除：
  - `app_hWiL7xOBBRS_SI1X`
  - `app_mig_evt7BK3XgLp8oboOoG`
- 9 条 manual 主动补录的空白记录**保留**，不按机器误采处理。

## 自动新建的唯一台账

- 应用：`app_L-ZASXnJ8VkdjDWh`
- 来源：邮件 `evt_8mAtIlq-jTH_0Ong` / 招商银行 2027 校园招聘统一笔试
- 公司：招商银行；岗位：空（没有编造）
- 状态：笔试/测评；has_applied=1
- 投递时间：`2026-10-14T09:28:44.000Z`，precision=`inferred_before`（来自邮件收信上界，不是伪造精确时间）
- LLM 提取证据、Jev 判断、规则版本和前后状态见 `ai_ingest_runs` 对应记录（deepseek-flash / jev-1.14.0 / auto-intake-v1）。

## 处理后仍需人工确认的 6 条

1. `rev_OIoc2Sm63m_9zdrM`：网易游戏雷火事业群面试时间收集；只有邮件头，岗位/身份不唯一。
2. `rev_UBCAW-yL59fWGjgi`：小红书校招在线测评；同公司多个岗位，归属不唯一。
3. `rev_yNFkIcu-QYuYOVYO`：招商银行统一笔试提醒；只有公司/阶段，岗位不唯一。
4. `rev_51vT3CLP7nw2t4vT`：中国农业银行统一笔试；无岗位身份，证据只在邮件头。
5. `rev_54gEotjRfKigHlhC`：招商银行广州分行面试；候选不唯一。
6. `rev_oSZAFF7KNQQUNWCT`：数字广东在线笔试；公司/阶段明确，但岗位身份不足，且已有阶段拆分冲突。

这些卡片保留来源、主题、时间和忽略/确认入口；用户确认后直接入账，不再重复问同一问题。

## 重跑幂等

- 在真实库副本上运行两次：第二次不再关闭已关闭项、不再新建上一轮应用；重复事件由 source_event_id/UNIQUE 和状态 no-op 保护。
- 工具路径：`tools/remediate-pending.mjs`；单条失败被隔离，`ai_ingest_runs` 的 retry 状态可重试。
- 本次真实运行 `failures=0`。

## 当前状态

处理后：

- 台账 53（新建 1；归档 3）
- 事件 137（含 3 条归档 correction；历史自身事件保留）
- 复核项 62（历史保留）
- open 复核 6
- open 自身页面复核 0
- 台账中指向 127.0.0.1/localhost 的 job_url 0
- 9 条 manual 空白记录保留

## 注意

本次没有删除历史事件/复核项；无效项通过 dismissed/ignored/archived 保留审计。处理前备份可用于回滚。
