# 招聘网址实测复盘与修正（2026-11-18）

本轮基于 85 个有网址公司的真实浏览器 / 模型链路实测，逐类定位“打不开”和“打开后没有岗位详情”的原因，并给出修正后的校招、社招入口和可核验的岗位详情样本。

## 结论

1. **31 个“入口无法打开”主要不是网络问题，而是网址本身失效或指错网站。**
   - 旧域名 / 子域已下线：`careers.kuaishou.com`、`join.didiglobal.com`、`career.iflytek.com`、`career.boc.cn`、`jobs.citics.com`、`jobs.citicsfutures.com`、`bairongyc.com`、`htffund.com`、`loreal.talent.com.cn`。
   - 公司把招聘迁到 ATS：`*.zhiye.com`、`*.hotjob.cn`、`*.mokahr.com`、`*.jobs.feishu.cn`、Workday、Beisen。
   - 基金 / 券商官网的 `/recruit`、`/careers` 是旧栏目，实际投递入口已迁到独立招聘站。
2. **11 个“有响应但无正文”主要是 SPA 壳、登录墙或反爬。**
   - SPA / JS 渲染：百度、华为、华泰、平安证券、微众、海天、京东方、商汤、荣耀等，首屏 HTML 只有壳，需要等待 JS 或直接进职位列表路由。
   - 403 / 安全验证：西南证券、财通资管、迈瑞、招商证券、智联、拉勾等。
3. **29 个“入口能开但找不到单岗位详情”是因为给的是校招落地页/职位列表，不是岗位详情。**
   - 例如招商银行、农行、工行、建行、邮储、中金、国泰海通等，入口只到招聘首页或列表；详情需要点击具体岗位，部分还要登录。
   - 这类网址不是坏链，但**不能把入口页当成岗位详情页**。
4. **小红书是“详情页存在，但本地判岗误拦”。**
   - `job.xiaohongshu.com/campus/position/22013` 能打开，但正文由前端渲染，当前本地规则没有把它识别为可靠单岗位，模型链路被拦下。
5. **45 个“无网址”已尽量补齐。**
   - 其中 43 家补到了官方校招/社招入口或 ATS；上海量派投资、进化论资产未检索到公开校招/社招页面，保留“未找到公开入口”。

## 典型修正

| 公司 | 原网址问题 | 修正后 |
| --- | --- | --- |
| 快手 | `careers.kuaishou.com` DNS 失败 | 校招 `campus.kuaishou.cn`、社招 `zhaopin.kuaishou.cn` |
| 滴滴 | `join.didiglobal.com` DNS 失败 | `talent.didiglobal.com` |
| 科大讯飞 | `career.iflytek.com` DNS 失败 | `iflytek.zhiye.com` |
| 中国银行 | `career.boc.cn` DNS 失败 | 校招公告 `boc.cn/aboutboc/bi4/`、社招中华英才网 |
| 中信证券 | `jobs.citics.com` DNS 失败 | `careers.citics.com` |
| 中信期货 | `jobs.citicsfutures.com` DNS 失败 | `citicsfzp.zhiye.com` |
| 天风证券 | `tfsec.com.cn` DNS 失败 | `tfzq.com/job/campus.html` |
| 百融云创 | `bairongyc.com` DNS 失败 | `brgroup.com` |
| 泰康资产 | `taikangasset.com` DNS 失败 | `taikangasset.cn`、`jobtaikang.zhiye.com` |
| 汇添富 | `htffund.com` DNS 失败 | `htffund.zhiye.com` |
| 欧莱雅 | `loreal.talent.com.cn` DNS 失败 | `lorealchina.com`、`careers.loreal.com` |
| 华夏基金 | `/recruit` 404 | `chinaamc.zhiye.com` |
| 南方基金 | `/recruit` 404 | `southernfund.hotjob.cn` |
| 嘉实基金 | `/recruit` 404 | `jsfund.cn` 官网“加入我们” |
| 大成基金 | `/recruit` 404 | `dcfund.com.cn` 官网“人才招聘” |
| 广发基金 | `/recruit` 404 | `gffunds.jobs.feishu.cn` |
| 招商基金 | `/recruit` 404 | `cmfchina.zhiye.com` |
| 永赢基金 | `/recruit` 超时 | `maxwealthfund.hotjob.cn` |
| 长城基金 | `/recruit` 404 | `greatwallfund.zhiye.com` |
| 鹏华基金 | `/recruit` 200 但无正文 | `job.phfund.com.cn` |
| 国金证券 | `/campus` 超时 | `gjzq.zhiye.com/jobs` |
| 国盛证券 | `/campus` 重定向循环 | `gszq.hotjob.cn` |
| 兴业证券 | `xyzq.zhiye.com` 不可用 | `xyzq.hotjob.cn` |
| 华泰证券 | `htsc.zhiye.com` 证书错误 | `wecruit.hotjob.cn` 华泰租户 / `htsc.com.cn/recruit/` |
| 招商证券 | 官网无投递入口 | `wecruit.hotjob.cn/SU629dbc260dcad452299bc0fa/mc/index` |
| 迈瑞 | `/careers` 403 | `mindray.zhiye.com/campus` |
| 影石 Insta360 | `insta360.zhiye.com` 不可用 | `insta360.com/cn/jobs` |
| 中国太保 | `/careers` 404 | `cpic.com.cn/aboutUs/rlzy/ygzp/` |
| 同花顺 | 官网首页不是招聘 | 校招 `campus.10jqka.com.cn`、社招 `job.10jqka.com.cn` |
| 奇富科技 | 招聘子域不存在 | Moka 校招/社招租户 |
| 陆金所 | 独立招聘站 404 | 官网 Join Us 指向平安招聘 |

## 交付

- **更新后的网址表**：`docs/recruitment-company-urls-20261118.csv`
  - 130 家公司。
  - 128 家填了校招入口、128 家填了社招入口。
  - 22 家附了本轮实测或可从官网核验的岗位详情样本。
  - 2 家（上海量派投资、进化论资产）没有公开校招/社招页面。
  - 每家附“入口状态”和具体说明，区分：可用、SPA 需渲染、需登录/反爬、仅列表、判岗未通过、未找到公开入口。
- **插件公司目录**：`extension/content/adapters.js` 的 `RECRUITMENT_DIRECTORY` 已同步为 123 家（不含 BOSS直聘、前程无忧、拉勾、智联、猎聘这 5 个招聘平台自身），网页「数据与授权」可以搜索并授权这些公司的新域名。
- **原有实测报告**：`docs/RECRUITMENT-DIRECTORY-REVIEW.md` 保留 85 家逐站结果，作为本轮修正的依据。

## 使用说明

1. 用新表里的“校招入口/社招入口”打开公司招聘页。
2. 如果入口跳到另一个域名（如 `zhiye.com`、`hotjob.cn`、`mokahr.com`、Workday、飞书招聘），在「数据与授权」里**同时授权最终详情域名**，否则插件只能打开入口、不能采集详情。
3. 入口页是列表时，先点进具体岗位再采集；列表页本身没有完整 JD。
4. 遇到 403/安全验证/登录墙，先在普通 Chrome 完成验证或登录，再点插件「采集当前页」；自动化浏览器无法代替这一步。
5. SPA 页面（百度、华为、华泰、平安证券、微众、海天、京东方、商汤、荣耀等）打开后等 2–3 秒，或直接进职位列表路由，再采集。

## 仍存在的边界

- 招聘网址会随招聘季、组织调整和 ATS 迁移变化，本表是 2026-11-18 的核验结果。
- “入口可打开”不等于“每个岗位都有公开详情”：部分公司只公开列表，详情需要登录或投递后可见。
- 外企中国岗位需要按 location/country 筛选，全球站不会默认展示中国岗位。
- 22 个详情样本只证明该岗位当次可打开；同站其他岗位仍需逐条采集。
