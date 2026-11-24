# Tounar · 帮你理 v1.1.4 实现结果

- **基线**：`tounar-1.1.3` / commit `56d20a8`
- **实现分支**：`tounar-1.1.4`
- **主应用版本**：`1.1.4`
- **插件版本**：`0.2.12`
- **交付范围**：本地开发、回归和插件 ZIP；未部署线上（按本轮确认的交付边界）
- **完成日期**：2026-11-24

## 1. 范围与实现

| 模块 | 结果 |
|---|---|
| M0 生产域名与插件 | manifest、background/site-access、lib/site-access 同时兼容 `bangnili.theonlin.top` 与旧域名；打包默认服务器切换新域名；插件升级 `0.2.12`；后端自身 URL 判断读取 `APP_BASE_URL` hostname。 |
| M1 首次引导 | 默认仍落投递明细；新增按用户 email 隔离的 localStorage 渐进引导：探测插件 → 插件包/授权 → 浏览入库动画 → 邮箱同步动画；2.5s 轮询、支持稍后跳过；已有数据账号首次登录也会看到一次就绪/下一步卡片。 |
| M2 改写质量 | 额外要求 placeholder 改为 `改写需求：`；JD 解析新增 `core_keywords` / `target_persona`；改写 Prompt 强制“痛点/目标 → 动作/方法 → 量化结果”，禁止只改标点；按块计算编辑距离，>70% 业务块近似原文时自动纠偏重试一次。 |
| M3 对照布局 | 左右仍逐块同 Grid 行；`已优化` / `待补事实` 改为正文句尾行内标签；`未改动` 默认隐藏、hover 轻提示；编辑聚焦隐藏标签、失焦恢复。 |
| M4 管理员边界 | 普通用户不再渲染“邮件测试与模板”页签和“下一批摘要预览”整块；直接访问 `?panel=mail-admin` 回退提醒设置；预览 API 增加服务端管理员 403 校验；清理两处冗余提醒文案。 |
| M5 后台任务 | 新增 `GET /api/v1/career-ai/rewrite-drafts/active`（运行中及近 10 分钟完成草稿，轻量投影）；全局任务条轮询改写和邮箱同步，显示右下角胶囊、完成 Toast、去查看/刷新台账；刷新或切回改写页可接管运行中/刚完成的草稿。 |
| M6 提醒邮件 | 移除缺少 `status_url`/`job_url` 就跳过 B 类的硬过滤；无外链岗位仍进入“该回看了”，邮件保留站内详情和确认无变化入口，外链仅在有安全链接时显示。 |
| M7 看过没投推荐 | 卡片和按钮更名；删除两段冗余说明；新增选择简历弹窗（名称、来源/改写目标、字数、更新时间）；`POST /api/v1/ai/recommend` 支持并校验 `resume_id`。 |
| M8 单岗位选择 | 移除原生 `<select>` 和搜索框，改为已选岗位摘要 + `选择岗位`；复用两级岗位弹窗，增加直接切换 Tab、搜索、城市/批次、有 JD/缺 JD 标记；缺 JD 岗位给出清晰提示并禁用分析。 |
| M9 AI Drawer | 左侧导航改为打开右侧 Drawer，保留全屏 `/?panel=assistant` 兼容路由；悬浮 AI 按钮；默认 440px、宽屏 680px、移动全屏、关闭/遮罩/Esc；欢迎卡与画像卡在 Drawer 内 2 列滚动；详情抽屉打开时自动带当前岗位上下文。 |
| M10 缺 JD 卡片 | 工具在缺 JD 时返回 `missing_jd` 结构化 `cards`；前端在回复下渲染补录 textarea，保存到岗位 JD 后卡片变只读“JD 已保存 ✓”，并自动重新发送原分析请求；支持对比多个缺 JD 岗位分卡。 |

## 2. 验证结果

### 自动化回归

| 套件 | 结果 |
|---|---|
| `npm test` | 263 项，261 通过；仅 `cloud-persistence` 与 `cloud-persistence-http` 两条既有云快照环境用例失败 |
| `npm run test:agent` | 34 项服务端 + 38 项 Playwright 全部通过 |
| `npm run test:web` | 76/76 |
| `npm run test:career-ai` | 52/52 |
| `npm run test:e2e` | 67/67 插件采集 |
| `npm run test:panel` | 8/8 |
| `npm run test:netease-game` | 60/60 |
| `npm run test:self-page` | 6/6 |
| `npm run test:intake` | 通过 |
| `npm run test:mail-progress` | 6/6 |
| `npm run test:mail-admin` | 通过（管理员模板、业务通路、非管理员回退） |
| `server/test/reminders.test.js` | 7/7（含无外链 B 类、管理员预览 403） |
| `server/test/resume-rewrite-module.test.js` | 5/5（含 active 草稿、Word、Delta） |

### 真实模型冒烟

`node --env-file=.env tools/smoke-agent-v114.mjs`：**12/12 通过**，未打印/写入 API Key。

- 5 类真实对话：本周投递、长期无反馈、完整简历读取、岗位字段确认卡、求职画像确认卡。
- 真实缺 JD 场景返回 `missing_jd` 卡片。
- 2 次真实简历改写均到达 100%，`core_keywords` / `target_persona` 非空，业务块改写比例 1.00 / 0.50，无半句残块，Word 导出均为合法 ZIP。
- 报告：`.tmp/agent-v114-smoke.md`（本地测试产物，不提交真实数据）。

### 本地 4326 实例真实长简历

在 `20261124-v1.1.4-selftest` 数据副本（真实长 PDF 简历 2049 字、目标岗位 JD 464 字）上跑真实模型改写：

- 28 个完整 block，24 个业务块中 20 个实质改写，质量比例 0.83；
- `core_keywords` 与 `target_persona` 均生成，半句残块 0；
- 进度观测值 `15 → 40 → 73 → 100`；
- 确认后生成新简历 2297 字，Word `.docx` 为合法 ZIP（14,952 bytes）。

### 插件产物

```text
web/downloads/bangnili-extension-0.2.12.zip
version: 0.2.12
serverUrl: https://bangnili.theonlin.top
top_level: bangnili-extension
sha256: fbb1de3e43c4adb63c271b524500e4cf9c4d702997a3d3be42a1a9e0bb216a65
```

## 3. 边界与说明

- 本轮未操作线上 `https://bangnili.theonlin.top/`，也未修改 `tounar-1.0.0` 分支或 `v1.0.0` tag。
- 首次引导状态按登录 email 保存在 localStorage；清除浏览器存储或换设备会重新出现，不做跨设备同步。
- 全屏 AI 助手路由保留，侧栏入口改为 Drawer；两种入口共享同一套助手会话与工具能力。
- 缺 JD 补录通过岗位纠错接口写入 `jd_text`（至少 20 字符）并标记 JD 完整；人工补录会受既有 JD 人工保护规则约束。
- `cloud-persistence` / `cloud-persistence-http` 是既有测试环境波动，不是 v1.1.4 业务回归；邮件 IMAP 真实三家邮箱仍需用户凭据验收。
- Word 导出保持 ATS 友好的标准 OOXML，不承诺任意 PDF 的像素级还原。
