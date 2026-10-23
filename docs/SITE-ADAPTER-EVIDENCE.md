# 二期真实站点适配证据（2026-10-23）

当前完成 **11 站 × 2 岗位＝22/26 页**，其中优先八家完成 **7/8 家**，白名单外完成米哈游、Airbnb 两家。公司/岗位双字段在已验收的七家白名单 14 页中为 28/28 正确；城市和 JD 各 14/14 正确。**这不是全部八家或全部 26 页达标**。

本轮真实页面均在 Chromium 156 正常 TLS 校验下运行 `npm run probe:site` 与 `npm run plugin:tryrun`，只本地捕获事件，没有登录、投递或发送到业务后台。浏览事件均达到可见停留 3 秒的 strong 证据。原始采集要点和日期见 [live-results.json](../tests/fixtures/sites/live-results.json)，七字段预期与人工核对的已知值见 [cases.json](../tests/fixtures/sites/cases.json)。时间戳采用 UTC。

## 覆盖与未完成项

| 站点 | 本轮有效详情 | 状态 / 范围 |
|---|---:|---|
| 腾讯 | 2/2 | 仅 careers.tencent.com 的 jobdesc 浏览态；Workday 外跳、校招及投递未验。 |
| 字节 | 2/2 | 校园详情；同一历史岗位已在本轮重验，不回归。 |
| 阿里 | 2/2 | 阿里集团新社招入口两页；标题/城市/JD 已按真实 DOM 校准，旧域名及登录投递未验。 |
| 美团 | 2/2 | 官网 web/position/detail 浏览态；登录及投递未验。 |
| 京东 | 2/2 | 新社会招聘 job-info-detail 可访问；旧列表需登录，校园入口未验。 |
| 小米 | 2/2 | 旧版 hr.xiaomi.com 招聘库（列表发布时间 2017）；不证明岗位仍开放。 |
| 百度 | 0/2（未测字段） | 所需 wappass 脚本已恢复；普通有界面和 headless Chromium 仍进入 about:blank，未取得可验收的详情。 |
| 网易 | 2/2 | 中文详情 lang=zh；登录、投递和英语入口未验。 |
| BOSS | 0/2（未测字段） | 首页已发现有效详情链接，但两个详情均转入安全验证页；未绕过验证。 |
| 牛客 | 2/2 | 两条当前公开详情；公司只取名称节点、城市取岗位信息。旧详情失败不代表全站不可访问，部分附属 API 仍受限。 |
| 实习僧 | 2/2 | 两条公开实习详情；乱码字段保守留空，未绕过字体反爬。 |
| 米哈游 | 2/2 | 白名单外通用识别；公司/城市保守留空，岗位、JD、ID、hash 链接正确。 |
| Airbnb | 2/2 | 第二家白名单外官网，使用 generic；两页标题/JD/ID/链接正确，公司及城市四字段留空。 |

用户已授权补齐开发环境网络；保留原 41 项并新增 fc.alibaba.com、wappass.baidu.com、talent-holding.alibaba.com、careers.airbnb.com，共 45 项。工具只保存草稿，不能据此声称已发布开发环境；四个所需域名此后均已实际访问，阿里和 Airbnb 的详情已完成取证。剩余百度/BOSS 共 4 页未完成，两站适配器仍为草案。百度普通有界面 Chromium 仍跳 about:blank；BOSS 仍进入安全验证或账号入口，未尝试绕过。详情见 [失败证据](../tests/fixtures/sites/blocked-results.json)。拼多多入口失败，按任务书“白名单外公司任选”改用 Airbnb。

## 真实岗位与快照

快照保留真实渲染后的 DOM、可见性和字号，清除表单、可执行脚本、嵌入状态、CSS/字体/图片、注释、联系方式和敏感 URL 参数。离线回放完全拦截网络；快照用于采集回归，不用于还原视觉设计。小米旧库只能证明该版本页面结构。

| 站点 | 真实详情（页面实际标题） | 脱敏 HTML |
|---|---|---|
| 小米 | [天线工程师](https://hr.xiaomi.com/job/view/714) | [xiaomi/714.html](../tests/fixtures/sites/xiaomi/714.html) |
| 小米 | [Android Multimedia系统工程师（小米电视）](https://hr.xiaomi.com/job/view/800) | [xiaomi/800.html](../tests/fixtures/sites/xiaomi/800.html) |
| 实习僧 | [企业用户运营/项目运营](https://www.shixiseng.com/intern/inn_lri5lbntavwi) | [shixiseng/inn_lri5lbntavwi.html](../tests/fixtures/sites/shixiseng/inn_lri5lbntavwi.html) |
| 实习僧 | [数据采集](https://www.shixiseng.com/intern/inn_bliwylwige4t) | [shixiseng/inn_bliwylwige4t.html](../tests/fixtures/sites/shixiseng/inn_bliwylwige4t.html) |
| 字节 | [AI Agent产品经理 - 巨量AI工作台](https://jobs.bytedance.com/campus/position/7699119731313821957/detail) | [bytedance/7699119731313821957.html](../tests/fixtures/sites/bytedance/7699119731313821957.html) |
| 字节 | [营销激励产品经理（广告策略方向） - 抖音生活服务](https://jobs.bytedance.com/campus/position/7694918252576835845/detail) | [bytedance/7694918252576835845.html](../tests/fixtures/sites/bytedance/7694918252576835845.html) |
| 腾讯 | [在研UE5项目-战斗动画设计师](https://careers.tencent.com/jobdesc.html?postId=2099730961662128128) | [tencent/2099730961662128128.html](../tests/fixtures/sites/tencent/2099730961662128128.html) |
| 腾讯 | [《三角洲行动》-系统策划（烽火地带模式）](https://careers.tencent.com/jobdesc.html?postId=1942052496046424064) | [tencent/1942052496046424064.html](../tests/fixtures/sites/tencent/1942052496046424064.html) |
| 美团 | [AI全栈工程师](https://zhaopin.meituan.com/web/position/detail?jobUnionId=4697320043&highlightType=campus) | [meituan/4697320043.html](../tests/fixtures/sites/meituan/4697320043.html) |
| 美团 | [AI后端开发工程师](https://zhaopin.meituan.com/web/position/detail?jobUnionId=4697280304&highlightType=campus) | [meituan/4697280304.html](../tests/fixtures/sites/meituan/4697280304.html) |
| 米哈游 | [资深Unreal工具开发（关卡PCG方向）](https://jobs.mihoyo.com/#/position/9707) | [mihoyo/9707.html](../tests/fixtures/sites/mihoyo/9707.html) |
| 米哈游 | [资深Unreal工具开发（构建方向）-预研项目](https://jobs.mihoyo.com/#/position/9705) | [mihoyo/9705.html](../tests/fixtures/sites/mihoyo/9705.html) |
| 网易 | [法务实习生（维权诉讼）](https://hr.163.com/job-detail.html?id=79495&lang=zh) | [netease/79495.html](../tests/fixtures/sites/netease/79495.html) |
| 网易 | [海外产品运营实习生（网易画加）](https://hr.163.com/job-detail.html?id=78226&lang=zh) | [netease/78226.html](../tests/fixtures/sites/netease/78226.html) |
| 京东 | [产品运营](https://zhaopin.jd.com/web/job-info-detail?requementId=226996) | [jd/226996.html](../tests/fixtures/sites/jd/226996.html) |
| 京东 | [解决方案](https://zhaopin.jd.com/web/job-info-detail?requementId=225873) | [jd/225873.html](../tests/fixtures/sites/jd/225873.html) |
| 牛客 | [服务端开发工程师](https://www.nowcoder.com/jobs/detail/453952) | [nowcoder/453952.html](../tests/fixtures/sites/nowcoder/453952.html) |
| 牛客 | [【27届校招】通用软件工程师 北京南京上海](https://www.nowcoder.com/jobs/detail/457913) | [nowcoder/457913.html](../tests/fixtures/sites/nowcoder/457913.html) |
| 阿里 | [ATH-AI创新事业部-Qoder 产品经理-AI Coding 方向](https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100004023017) | [alibaba/100004023017.html](../tests/fixtures/sites/alibaba/100004023017.html) |
| 阿里 | [晓天衡宇-大模型标注评测工程师-金融/法律/医疗](https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100025060002) | [alibaba/100025060002.html](../tests/fixtures/sites/alibaba/100025060002.html) |
| Airbnb | [Associate Legal Counsel, Japan](https://careers.airbnb.com/positions/7789554/) | [airbnb/7789554.html](../tests/fixtures/sites/airbnb/7789554.html) |
| Airbnb | [Business Development Manager](https://careers.airbnb.com/positions/7995153/) | [airbnb/7995153.html](../tests/fixtures/sites/airbnb/7995153.html) |

## 同一真实 DOM 的改造前基线

取证在代码改造之后恢复，因此本表是将 **main 88b7334 的原样 content 脚本**注入本轮真实渲染快照所得的离线重建基线，**不是事先完成的线上摸底**。该时间顺序限制保留在交付报告。两种算法回放同一 DOM，便于比较；原始结果见 [baseline-88b7334.json](../tests/fixtures/sites/baseline-88b7334.json)。对/错按人工核对的七字段口径判断；空值单列，不算正确。

### 改造前（88b7334）

| 岗位快照 | 公司 | 岗位 | 城市 | 批次 | JD | 岗位ID | 链接 |
|---|---|---|---|---|---|---|---|
| airbnb/7789554.html | 错：Careers at Airbnb | 对 | 空 | 空 | 错：Airbnb was born in 2007 when two hosts welcomed three guests to their San Franci | 对 | 对 |
| airbnb/7995153.html | 错：Careers at Airbnb | 对 | 空 | 空 | 错：Airbnb was born in 2007 when two hosts welcomed three guests to their San Franci | 对 | 对 |
| alibaba/100004023017.html | 错：Talent-holding | 对 | 空 | 空 | 错：基础信息 所属部门: 阿里集团 学历: 本科 工作年限: 2 年 职位描述 1、商业化方向：负责 AI Coding 及智能体产品的商业化体系建设，包括产品版本 | 对 | 对 |
| alibaba/100025060002.html | 错：Talent-holding | 对 | 空 | 空 | 错：基础信息 所属部门: 晓天衡宇 学历: 本科 工作年限: 3 年 职位描述 1. 负责金融 / 法律 / 医疗方向 AI 训练数据（SFT / RL 阶段）的标 | 对 | 对 |
| bytedance/7694918252576835845.html | 对 | 对 | 对 | 对 | 对 | 对 | 对 |
| bytedance/7699119731313821957.html | 对 | 对 | 对 | 对 | 对 | 对 | 对 |
| jd/225873.html | 对 | 对 | 空 | 空 | 错：解决方案 职位类型：运营类 工作地点：上海市 所属部门： 家电家居方案组 招聘人数：1 发布时间：2026-09-28 收藏 岗位描述 1. 研究家电家居客户需 | 空 | 对 |
| jd/226996.html | 对 | 对 | 空 | 空 | 错：产品运营 职位类型：采销类 工作地点：北京市 所属部门： 营销运营组 招聘人数：1 发布时间：2026-10-22 收藏 岗位描述 1. 制定搜索商详交易链路运 | 空 | 对 |
| meituan/4697280304.html | 对 | 对 | 空 | 空 | 错：AI后端开发工程师 应届-校园招聘 工作地点：北京市、上海市、成都市 最多可投递3个职位，但同一时间仅有1个职位流程处于进行中，第一志愿将被优先考虑。 分享 立 | 空 | 对 |
| meituan/4697320043.html | 对 | 对 | 空 | 空 | 错：AI全栈工程师 应届-校园招聘 工作地点：北京市、上海市、成都市、深圳市 最多可投递3个职位，但同一时间仅有1个职位流程处于进行中，第一志愿将被优先考虑。 分享 | 空 | 对 |
| mihoyo/9705.html | 错：Jobs | 错：资深Unreal工具开发（构建方向）-预研项目全职 | 空 | 空 | 错：米哈游致力于为用户提供美好的、超出预期的产品与内容，并希望打造出全球十亿人愿意生活在其中的虚拟世界 | 空 | 错：https://jobs.mihoyo.com/ |
| mihoyo/9707.html | 错：Jobs | 错：资深Unreal工具开发（关卡PCG方向）全职 | 空 | 空 | 错：米哈游致力于为用户提供美好的、超出预期的产品与内容，并希望打造出全球十亿人愿意生活在其中的虚拟世界 | 空 | 错：https://jobs.mihoyo.com/ |
| netease/78226.html | 对 | 错：招贤纳士 | 空 | 空 | 错：海外产品运营实习生（网易画加） 实习 \| 广州市 \| 2026-10-23 更新 所属产品 网易游戏（互娱） 职位类别 市场 招聘人数 1 学历 不限 工作年限 | 对 | 对 |
| netease/79495.html | 对 | 错：招贤纳士 | 空 | 空 | 错：法务实习生（维权诉讼） 实习 \| 杭州市 \| 2026-10-23 更新 所属产品 网易云音乐 职位类别 职能支持 招聘人数 1 学历 本科 工作年限 不限 微 | 对 | 对 |
| nowcoder/453952.html | 错：拼多多集团-PDD 电商 已上市 上海 查看其他 65 个职位 | 对 | 空 | 空 | 错：拼多多集团-PDD校招 服务端开发工程师 2026最新招聘求职信息，薪资：25-35，地点：上海，点击查看更多拼多多集团-PDD招聘岗位、岗位职责要求、工作内容 | 对 | 对 |
| nowcoder/457913.html | 错：华为南京研究所 零售 未融资 南京市 查看其他 15 个职位 | 对 | 空 | 空 | 错：华为南京研究所校招 【27届校招】通用软件工程师 北京南京上海 2026最新招聘求职信息，薪资：18-22，地点：北京，点击查看更多华为南京研究所招聘岗位、岗位 | 对 | 对 |
| shixiseng/inn_bliwylwige4t.html | 对 | 对 | 对 | 空 | 对 | 空 | 对 |
| shixiseng/inn_lri5lbntavwi.html | 对 | 对 | 对 | 空 | 对 | 空 | 对 |
| tencent/1942052496046424064.html | 对 | 错：岗位详情 | 空 | 空 | 错：登录 社会招聘 校园招聘 生活在腾讯 产品和服务 工作地点 查看工作岗位 《三角洲行动》-系统策划（烽火地带模式）深圳 分享 分享岗位 方式1:复制岗位链接 点 | 空 | 对 |
| tencent/2099730961662128128.html | 对 | 错：岗位详情 | 空 | 空 | 错：登录 社会招聘 校园招聘 生活在腾讯 产品和服务 工作地点 查看工作岗位 在研UE5项目-战斗动画设计师上海 分享 分享岗位 方式1:复制岗位链接 点击复制 方 | 空 | 对 |
| xiaomi/714.html | 对 | 错：手机 \uE623 | 空 | 空 | 错：职位名称： 天线工程师 工作地点： Peking 职位类别： 研发工程师 招聘渠道： 社会招聘 工作职责： 1. 按时保量完成小米项目的天线设计及验证工作； 2 | 空 | 对 |
| xiaomi/800.html | 对 | 错：手机 \uE623 | 空 | 空 | 错：职位名称： Android Multimedia系统工程师（小米电视） 工作地点： Peking 职位类别： 研发工程师 招聘渠道： 社会招聘 工作职责： 1. | 空 | 对 |

本表 154 个字段：正确 68、错误 36、空 50。

### 改造后（本轮代码）

| 岗位快照 | 公司 | 岗位 | 城市 | 批次 | JD | 岗位ID | 链接 |
|---|---|---|---|---|---|---|---|
| airbnb/7789554.html | 空 | 对 | 空 | 空 | 对 | 对 | 对 |
| airbnb/7995153.html | 空 | 对 | 空 | 空 | 对 | 对 | 对 |
| alibaba/100004023017.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| alibaba/100025060002.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| bytedance/7694918252576835845.html | 对 | 对 | 对 | 对 | 对 | 对 | 对 |
| bytedance/7699119731313821957.html | 对 | 对 | 对 | 对 | 对 | 对 | 对 |
| jd/225873.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| jd/226996.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| meituan/4697280304.html | 对 | 对 | 对 | 对 | 对 | 对 | 对 |
| meituan/4697320043.html | 对 | 对 | 对 | 对 | 对 | 对 | 对 |
| mihoyo/9705.html | 空 | 对 | 空 | 空 | 对 | 对 | 对 |
| mihoyo/9707.html | 空 | 对 | 空 | 空 | 对 | 对 | 对 |
| netease/78226.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| netease/79495.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| nowcoder/453952.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| nowcoder/457913.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| shixiseng/inn_bliwylwige4t.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| shixiseng/inn_lri5lbntavwi.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| tencent/1942052496046424064.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| tencent/2099730961662128128.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| xiaomi/714.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| xiaomi/800.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |

本表 154 个字段：正确 128、错误 0、空 26。

改造后 26 个空字段包括：18 个页面没有明确招聘批次；米哈游、Airbnb 各两页的公司和城市缺少可靠通用字段来源，八项保守留空。没有把空值计作正确率。两个白名单外官网各两页标题正确。Airbnb 另一个 61 字符标题仍被任务书要求的 2–60 字上限排除，实测无事件；该失败样本单列，不计入 22 个成功样本。

七家优先官网的 `site_verified` 附带日期、路径及运行时 URL 范围；实习僧、牛客另有详情校准。其他路径不获得已验证选择器的高分。米哈游与 Airbnb 继续使用 generic，没有新增专属适配器。新增 Application 标签仅在详情 URL 上构成申请信号，并支持 A Typical Day 等英文职责标题；账户页同名标签不会触发。字节两页七字段均正确，既有校园岗位未回归。

## 可复验方式

```bash
export PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/playwright-official
npm run probe:site -- '<真实详情URL>' --report .tmp/probe.json
npm run plugin:tryrun -- '<真实详情URL>' --report .tmp/tryrun.json --snapshot .tmp/job.html
node tools/replay-sites.mjs --ref 88b7334 --report .tmp/before.json
node tools/replay-sites.mjs --report .tmp/after.json
npm run test:e2e
```

试跑的“核心字段有值”只是采集烟测，不能替代人工核对；HTTP 失败、空壳页、HTTP 200 错误壳、安全验证页和无事件会失败退出，不再把 0 字段正常退出当作通过。`probe:site` 的快照仍须人工确认是岗位详情，不能直接计为真实样本。

系统提供的公开代理 CA 指纹与 NSS 中 `OpenAI-nebula-dns` 一致。用户授权后重复导入返回成功，但没有新增别名。实际问题是普通沙盒把 NSS 库设为只读（EROFS），Chromium 无法载入；使用获批的正常 NSS 执行上下文后，HTTPS 校验和页面渲染恢复。没有关闭 TLS 校验、修改 HOME 或使用忽略证书参数。

## 当前验收边界

全部真实登录、投递成功和账号投递记录页均未验证；没有操作用户真实待确认记录或真实邮件。用户已说明唯一真实数据库位于其 Mac；验收禁止真实发信。main 中保留的 2026-10-22 QQ IMAP/SMTP 和字节单页证据属于前一轮历史，不证明本轮真实账号验收已通过。具体未完成项和发布限制见 [二期交付报告](PHASE2-DELIVERY.md)。
