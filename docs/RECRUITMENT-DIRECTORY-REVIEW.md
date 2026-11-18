# 招聘目录与 JD 采集验收

> 2026-11-18 补充：本页记录的是原 CSV 85 个有网址公司的实测结果。逐类原因和修正后的校招/社招入口见 `docs/RECRUITMENT-URL-FIX-20261118.md` 与 `docs/recruitment-company-urls-20261118.csv`。

验收日期为 2026-11-18。浏览器插件为本地 0.2.8，分支为 `codex/model-gated-local-review`。

## 结果

| 本轮结果 | 公司数 |
| --- | ---: |
| 模型入账通过 | 12 |
| 入口未显示正文 | 11 |
| 无网址 | 45 |
| 未找到公开详情 | 29 |
| 未通过详情判定 | 1 |
| 入口无法打开 | 31 |
| 原文入账 | 1 |

原 CSV 有 130 行公司数据。85 行有具体招聘网站地址，这些公司均可在网页「数据与授权 → 招聘网站授权」搜索和选择。45 行没有网址。填写地址与通过模型是两项独立状态。

真实链路测试使用隔离的 Chrome 配置和台账。对候选详情域名预授权后，核对插件实际权限、真实 DeepSeek Flash 结果、后台入账和网页 JD 展示。测试核实每家公司至少一个样本，未覆盖同站每个岗位、登录态投递和状态变化。原生 Chrome 确认由用户操作，网页授权确认与取消另有浏览器测试。

入口探测先检查 HTTP 响应、跳转和渲染，再通过官网可见导航及仓库历史样本找单岗位。入口页、公司主页和列表页本身没有单岗位 JD。标记「未找到」表示本轮没有拿到可验证的公开详情。链接可能因招聘季或网络状态发生变化。

## 使用方式

1. 从 [本地验收页](http://127.0.0.1:4310/) 下载并加载 0.2.8，回网页确认插件连接。
2. 在「数据与授权」搜索公司名，展开域名，确认授权。详情跳到另一个域名时，需授权最终详情域名。已配置的部分跳转域名会显示在同一公司下。
3. 打开具体岗位，点插件「采集当前页」。模型整理成功时在网页分栏展示。模型整理失败时，已有可靠的本地提取结果会入账并显示原文。

## 逐站记录

| 序号 | 公司 | CSV 链接 | 实测进度 | 证据或原因 |
| ---: | --- | --- | --- | --- |
| 1 | 字节跳动 | [表内入口](https://job.bytedance.com/campus) | 模型入账通过 | AI Agent产品经理 - 巨量AI工作台 · 前端显示 团队介绍 / 岗位职责 / 任职要求 [岗位样本](https://jobs.bytedance.com/campus/position/7699119731313821957/detail) |
| 2 | 腾讯 | [表内入口](https://join.qq.com/) | 模型入账通过 | AI产品经理 · 前端显示 岗位职责 / 任职要求 / 其他信息 [岗位样本](https://join.qq.com/post_detail.html?postid=1283126456553382912) |
| 3 | 阿里巴巴 | [表内入口](https://campus.alibaba.com) | 模型入账通过 | ATH-AI创新事业部-Qoder 产品经理-AI Coding 方向 · 前端显示 岗位职责 / 任职要求 [岗位样本](https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100004023017) |
| 4 | 京东 | [表内入口](https://zhaopin.jd.com/) | 模型入账通过 | 解决方案岗 · 前端显示 岗位职责 / 任职要求 [岗位样本](https://zhaopin.jd.com/web/job-info-detail?requementId=227263) |
| 5 | 百度 | [表内入口](https://talent.baidu.com/) | 入口未显示正文 | 服务返回 HTTP 200，浏览器未停留在正常网页。  |
| 6 | 美团 | [表内入口](https://zhaopin.meituan.com/web/campus) | 模型入账通过 | 业务分析目标管理专家 · 前端显示 岗位职责 / 任职要求 / 其他信息 [岗位样本](https://zhaopin.meituan.com/web/position/detail?jobUnionId=4798450784&highlightType=social) |
| 7 | 拼多多 | [表内入口](https://careers.pinduoduo.com/campus) | 模型入账通过 | AI Infra研发工程师 · 前端显示 岗位职责 / 任职要求 [岗位样本](https://careers.pddglobalhr.com/campus/grad/detail?positionId=43b706c2-9d86-47de-a99d-fcd35405799f) |
| 8 | 小米 | [表内入口](https://hr.xiaomi.com/campus) | 模型入账通过 | 服务产品及市场 · 前端显示 岗位职责 / 任职要求 [岗位样本](https://xiaomi.jobs.f.mioffice.cn/index/position/7342833451802542188/detail) |
| 9 | 米哈游 | [表内入口](https://jobs.mihoyo.com/#/campus) | 模型入账通过 | 3D动画-3D风格化MOBA预研 · 前端显示 岗位职责 / 任职要求 [岗位样本](https://jobs.mihoyo.com/#/position/6352) |
| 10 | 网易 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 11 | SHEIN | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 12 | 华为 | [表内入口](https://career.huawei.com/reccampportal/) | 入口未显示正文 | HTTP 200，但浏览器未渲染可读内容。  |
| 13 | 哔哩哔哩 | [表内入口](https://jobs.bilibili.com/campus) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 14 | 富途 | [表内入口](https://join.futunn.com/) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 15 | 小红书 | [表内入口](https://xiaohongshu.zhiye.com) | 未通过详情判定 | 表内入口跳到 /404。另测小红书自己的详情域名，首次未通过本地判岗，复测连接被关闭。 |
| 16 | 得物 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 17 | 微博 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 18 | 快手 | [表内入口](https://careers.kuaishou.com) | 入口无法打开 | DNS 未能解析表内域名。  |
| 19 | 携程 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 20 | 滴滴 | [表内入口](https://join.didiglobal.com) | 入口无法打开 | DNS 未能解析表内域名。  |
| 21 | 百融云创 | [表内入口](https://www.bairongyc.com/careers) | 入口无法打开 | DNS 未能解析表内域名。  |
| 22 | 网易游戏雷火 | [表内入口](https://leihuo.163.com/campus/) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 23 | 网易游戏（互娱） | [表内入口](https://campus.game.163.com/) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 24 | 阿里云 | [表内入口](https://careers.aliyun.com/campus/home) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 25 | Amazon中国 | [表内入口](https://www.amazon.jobs) | 模型入账通过 | Data Center Technical Support Engineering Operations Engineer, BJS - DCEO · 前端显示 团队介绍 / 岗位职责 / 任职要求 / 其他信息 [岗位样本](https://www.amazon.jobs/en/jobs/10594132) |
| 26 | Google中国 | [表内入口](https://careers.google.com) | 未找到公开详情 | 入口跳转到 www.google.com，本次未找到可读取的单岗位详情。  |
| 27 | 微软中国 | [表内入口](https://careers.microsoft.com) | 模型入账通过 | Senior Software Engineer(CACore team) · 前端显示 岗位职责 / 任职要求 [岗位样本](https://apply.careers.microsoft.com/careers/job/1970393557074390?hl=en) |
| 28 | 苹果中国 | [表内入口](https://www.apple.com/jobs) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 29 | OPPO | [表内入口](https://career.oppo.com/campus) | 模型入账通过 | 高级热设计工程师 · 前端显示 岗位职责 / 任职要求 [岗位样本](https://career.oppo.com/official/oppo/recruitment/post/1563444621030670338?recruitType=SOCIAL-RECRUITMENT) |
| 30 | ZURU | [表内入口](https://www.zururecruit.cn/) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 31 | vivo | [表内入口](https://vivo.zhaopin.com/campus) | 入口无法打开 | 入口返回 HTTP 404。  |
| 32 | 京东方 | [表内入口](https://boe.zhiye.com/campus) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 33 | 传音控股 | [表内入口](https://www.transsion.com/careers) | 入口无法打开 | 入口返回 HTTP 404。  |
| 34 | 商汤科技 | [表内入口](https://www.sensetime.com/careers) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 35 | 影石Insta360 | [表内入口](https://insta360.zhiye.com/) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 36 | 科大讯飞 | [表内入口](https://career.iflytek.com/) | 入口无法打开 | DNS 未能解析表内域名。  |
| 37 | 荣耀 | [表内入口](https://www.honor.cn/careers/) | 未找到公开详情 | 入口跳转到 www.honor.com，本次未找到可读取的单岗位详情。  |
| 38 | 货拉拉 | [表内入口](https://lalamove.zhiye.com) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 39 | 韶音科技 | [表内入口](https://www.shokz.com/careers) | 入口无法打开 | 入口返回 HTTP 404。  |
| 40 | 中信银行 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 41 | 兴业银行 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 42 | 平安银行 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 43 | 招商银行 | [表内入口](https://career.cmbchina.com) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 44 | 浦发银行 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 45 | 中国银行 | [表内入口](https://career.boc.cn) | 入口无法打开 | DNS 未能解析表内域名。  |
| 46 | 交通银行 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 47 | 农业银行 | [表内入口](https://career.abchina.com) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 48 | 宁波银行 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 49 | 工商银行 | [表内入口](https://job.icbc.com.cn) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 50 | 广东华兴银行 | [表内入口](https://www.ghbank.com.cn/career) | 入口无法打开 | 入口返回 HTTP 404。  |
| 51 | 建设银行 | [表内入口](https://job.ccb.com) | 未找到公开详情 | 入口跳转到 wealth.ccb.com，本次未找到可读取的单岗位详情。  |
| 52 | 招商永隆银行（香港） | [表内入口](https://www.cmbwinglungbank.com/careers) | 入口无法打开 | 入口返回 HTTP 404。  |
| 53 | 邮储银行 | [表内入口](https://www.psbc.com/cn/careers/) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 54 | 东方证券 | [表内入口](https://orientsec.zhiye.com/campus) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 55 | 中信期货 | [表内入口](https://jobs.citicsfutures.com/) | 入口无法打开 | DNS 未能解析表内域名。  |
| 56 | 中信证券 | [表内入口](https://jobs.citics.com/campus) | 入口无法打开 | DNS 未能解析表内域名。  |
| 57 | 中国银河 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 58 | 中金公司 | [表内入口](https://cicc.zhiye.com/campus) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 59 | 兴业证券 | [表内入口](https://xyzq.zhiye.com/campus) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 60 | 华泰证券 | [表内入口](https://htsc.zhiye.com/campus) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 61 | 国信证券 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 62 | 国泰海通 | [表内入口](https://www.htsec.com/campus) | 未找到公开详情 | 入口跳转到 www.gtht.com，本次未找到可读取的单岗位详情。  |
| 63 | 国盛证券 | [表内入口](https://www.gssec.com/campus) | 入口无法打开 | 页面继续跳转，未取得稳定 DOM。  |
| 64 | 国金证券 | [表内入口](https://www.gjzq.com/campus) | 入口无法打开 | 浏览器请求超过 16 秒，未取得稳定页面。  |
| 65 | 天风证券 | [表内入口](https://www.tfsec.com.cn/campus) | 入口无法打开 | DNS 未能解析表内域名。  |
| 66 | 平安证券 | [表内入口](https://pingansec.zhiye.com/campus) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 67 | 广发证券 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 68 | 招商证券 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 69 | 民生证券 | [表内入口](https://www.mszq.com/campus) | 未找到公开详情 | 入口跳转到 www.glms.com.cn，本次未找到可读取的单岗位详情。  |
| 70 | 申万宏源 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 71 | 西南证券 | [表内入口](https://www.swsc.com.cn/campus) | 入口无法打开 | 入口返回 HTTP 403。  |
| 72 | 里昂证券 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 73 | 长城证券 | [表内入口](https://www.cgws.com/campus) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 74 | 长江证券 | [表内入口](https://www.95579.com/campus) | 入口无法打开 | 入口返回 HTTP 404。  |
| 75 | 中国人保 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 76 | 中国人寿 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 77 | 中国太保 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 78 | 中国平安 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 79 | 众安在线 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 80 | 新华保险 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 81 | 泰康保险 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 82 | 华夏基金 | [表内入口](https://www.chinaamc.com/recruit) | 入口无法打开 | 入口返回 HTTP 404。  |
| 83 | 南方基金 | [表内入口](https://www.nffund.com/recruit/) | 入口无法打开 | 入口返回 HTTP 404。  |
| 84 | 博时基金 | [表内入口](https://www.bosera.com/recruit) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 85 | 嘉实基金 | [表内入口](https://www.jsfund.cn/recruit) | 入口无法打开 | 入口返回 HTTP 404。  |
| 86 | 大成基金 | [表内入口](https://www.dcfund.com.cn/recruit) | 入口无法打开 | 入口返回 HTTP 404。  |
| 87 | 天弘基金 | [表内入口](https://www.thfund.com.cn/recruit) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 88 | 广发基金 | [表内入口](https://www.gffunds.com.cn/recruit) | 入口无法打开 | 入口返回 HTTP 404。  |
| 89 | 招商基金 | [表内入口](https://www.cmfchina.com/recruit) | 入口无法打开 | 入口返回 HTTP 404。  |
| 90 | 易方达基金 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 91 | 景顺长城基金 | [表内入口](https://invescogreatwall.zhiye.com/) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 92 | 永赢基金 | [表内入口](https://www.yongyingfund.com/recruit) | 入口无法打开 | 浏览器请求超过 16 秒，未取得稳定页面。  |
| 93 | 汇添富基金 | [表内入口](https://www.htffund.com/recruit) | 入口无法打开 | DNS 未能解析表内域名。  |
| 94 | 长城基金 | [表内入口](https://www.ccfund.com.cn/recruit) | 入口无法打开 | 入口返回 HTTP 404。  |
| 95 | 鹏华基金 | [表内入口](https://www.phfund.com.cn/recruit) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 96 | 蚂蚁集团 | [表内入口](https://talent.antgroup.com) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 97 | 京东科技 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 98 | 同花顺 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 99 | 奇富科技 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 100 | 平安科技 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 101 | 度小满 | [表内入口](https://duxiaoman.zhiye.com/campus) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 102 | 微众银行 | [表内入口](https://webank.zhiye.com/campus) | 入口未显示正文 | HTTP 200，但正文出现不可用或页面不存在的提示。  |
| 103 | 陆金所 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 104 | UBS | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 105 | 摩根士丹利 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 106 | 摩根大通 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 107 | 汇丰 | [表内入口](https://www.hsbc.com/careers) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 108 | 花旗 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 109 | 高盛 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 110 | 上海量派投资 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 111 | 国信资本 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 112 | 国金资管 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 113 | 泰康资产 | [表内入口](https://www.taikangasset.com/recruit) | 入口无法打开 | DNS 未能解析表内域名。  |
| 114 | 红杉中国 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 115 | 财通资管 | [表内入口](https://www.ctscapital.com/recruit) | 入口无法打开 | 入口返回 HTTP 403。  |
| 116 | 进化论资产 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 117 | 埃森哲 | [表内入口](https://www.accenture.com/cn-zh/careers) | 模型入账通过 | Presales/Implementation Expert · 前端显示 岗位职责 / 任职要求 [岗位样本](https://www.accenture.com/cn-zh/careers/jobdetails?id=R00002228_zh-cn&title=Presales%2FImplementation+Expert) |
| 118 | 安永 | [表内入口](https://www.ey.com/zh_cn/careers) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 119 | 德勤 | [表内入口](https://www2.deloitte.com/cn/zh/careers.html) | 未找到公开详情 | 入口跳转到 www.deloitte.com，本次未找到可读取的单岗位详情。  |
| 120 | 欧莱雅 | [表内入口](https://loreal.talent.com.cn/) | 入口无法打开 | DNS 未能解析表内域名。  |
| 121 | 毕马威 | [表内入口](https://home.kpmg/cn/zh/home/careers.html) | 未找到公开详情 | 入口跳转到 kpmg.com，本次未找到可读取的单岗位详情。  |
| 122 | 海天味业 | [表内入口](https://haitian.zhiye.com/campus) | 未找到公开详情 | 入口可打开，本次未找到带完整正文的公开单岗位详情。  |
| 123 | 玛氏 | [表内入口](https://www.mars.com/careers) | 原文入账 | 网页识别成功，模型整理未通过，前端显示本地提取的原文。 [岗位样本](https://careers.mars.com/global/en/job/R151971/Programa-Jovem-Aprendiz) |
| 124 | 顺丰 | [表内入口](https://hr.sf-express.com/campus) | 入口无法打开 | 浏览器请求超过 16 秒，未取得稳定页面。  |
| 125 | 迈瑞 | [表内入口](https://www.mindray.com/careers) | 入口无法打开 | 入口返回 HTTP 403。  |
| 126 | BOSS直聘 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 127 | 前程无忧 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 128 | 拉勾 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 129 | 智联招聘 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
| 130 | 猎聘 | — | 无网址 | 招聘入口列为空或只有占位文字。  |
