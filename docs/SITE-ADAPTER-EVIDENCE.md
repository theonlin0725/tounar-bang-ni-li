# 真实站点适配证据（Site Adapter Evidence）

> 用途：把「≥8 家真实招聘站点」这条外部依赖（G04）拆成可逐站点关闭的清单。
> 规则：**只有在本文件留下真实页面 URL + 采集到的字段快照，才算该站点「已验证」**。
> 未验证的站点一律保持 `site_verified: false`，不允许改文案假装完成。

## 判定标准

| 项 | 已验证需要满足 |
|---|---|
| 页面 | 必须是真实站点 URL（非本地 fixture） |
| 字段 | 公司名 / 岗位名 / 岗位链接 / JD 摘要 四项至少三项自动取到 |
| 事件 | 页面停留 ≥3 秒后确实发出 `job_viewed`，且 `evidence_level` 为 strong |
| 证据 | 记录实际采集到的 payload 快照 |
| 投递 | 「投递成功」「投递记录页」需要登录态，另列一栏，不混入浏览态验证 |

## 已验证站点（1 / 8）

### 字节跳动校园招聘 — jobs.bytedance.com ✅

- **验证时间**：2026-10-22
- **适配器**：`bytedance`，版本 `1.0.0-verified-campus`
- **验证 URL**：`https://jobs.bytedance.com/campus/position/7699119731313821957/detail`
- **验证方式**：Playwright 驱动本机 Chrome 打开真实页面，注入 `extension/content/adapters.js`
  与 `extension/content/tracker.js`（生产代码原样注入，仅把 `chrome.runtime.sendMessage`
  换成桩函数捕获上报内容）
- **页面性质**：纯前端渲染 SPA。服务端返回的 HTML 几乎为空（可见正文仅 35 字），
  所有字段都在 JS 执行后才出现在 DOM 里 —— 这正好落在 content script 的轮询重试范围内
  （每 250ms 重新探测，SPA 渲染完成后即可命中）

**真实 DOM 选择器（实测）**

| 字段 | 选择器 | 页面实际文本 |
|---|---|---|
| 岗位名 | `span.job-title` | AI Agent产品经理 - 巨量AI工作台 |
| 信息行 | `.job-info` | 上海、北京 正式 产品 2027届校园招聘 职位 ID：A11955 |
| JD 正文 | `.block-content`（第一段＝职位描述，第二段＝职位要求） | 团队介绍：我们正在打造面向企业的巨量AI工作台…… |
| 城市 | 由 `.job-info` 拆分 | 上海、北京 |
| 招聘批次 | 由 `.job-info` 拆分 | 2027 校园招聘 |
| 公司名 | 站点常量 | 字节跳动 |

**实际采集到的事件（真实页面，未做任何人工填写）**

```json
{
  "event_type": "job_viewed",
  "site_key": "bytedance",
  "adapter_version": "1.0.0-verified-campus",
  "evidence_level": "strong",
  "evidence_code": "visible-dwell-3000ms",
  "payload": {
    "company_name": "字节跳动",
    "job_title": "AI Agent产品经理 - 巨量AI工作台",
    "site_job_id": "7699119731313821957",
    "job_url": "https://jobs.bytedance.com/campus/position/7699119731313821957/detail",
    "jd_summary": "团队介绍：我们正在打造面向企业的巨量AI工作台，从商家在字节跳动生态的经营与营销场景切入，通过主Agent与机会洞察、数据分析、创意制作、直播运营、广告投放等数",
    "location": "上海、北京",
    "recruitment_batch": "2027 校园招聘",
    "channel": "企业官网",
    "visible_dwell_ms": 3000
  }
}
```

**仍未验证的部分**

- 投递成功检测：需要真实登录并投递一次（当前只能验证「找不到成功标记时不上报」）
- 投递记录页（`site_status_observed`）：需要登录态，选择器仍是草案

## 依赖：外部条件闭合情况

| 外部依赖 | 状态 | 证据 |
|---|---|---|
| QQ 邮箱 IMAP 收信 | ✅ 已闭合 | 2026-10-22 用授权码连接 `imap.qq.com:993` 成功，读取到收件箱 2730 封邮件及最近 5 封信封 |
| SMTP 真实发信 | ✅ 已闭合 | 2026-10-22 经 `smtp.qq.com:465`（显式 TLS）真实发出邮件，服务端返回 `250 OK: queued as` |
| ≥8 家真实招聘站点 | 🟡 1 / 8 | 字节跳动校园招聘已验证，其余 7 家待补 |
| WorkBuddy 云环境 | ⬜ 未开始 | 本地替代方案仍在使用 |

## 已知坑：SMTP_URL 写法

`nodemailer.createTransport('smtp://user:pass@smtp.qq.com:465')` **不会**按端口自动启用 TLS，
表现为连接成功但收不到服务端问候语：

```
Greeting never received
```

已在 `server/src/mailer.js` 的 `buildTransportOptions()` 中修复：显式解析 URL，
465 强制 `secure: true`，587 强制 `requireTLS: true`。

## 复现验证脚本

```bash
# 在真实页面上试跑插件脚本（打印采集结果，截图到 .tmp/tryrun-<host>.png）
npm run plugin:tryrun -- "https://jobs.bytedance.com/campus/position/<职位ID>/detail"

# 抓取某站点渲染后的 DOM 结构，用于写新适配器
npm run probe:site -- "https://<站点>/<职位页>"
```

> 两个脚本都用 `channel: 'chrome'` 启动本机 Google Chrome（没装 Playwright 自带浏览器也能跑）。
> 需要 Playwright：`npm i -D playwright`（已在 devDependencies）。
