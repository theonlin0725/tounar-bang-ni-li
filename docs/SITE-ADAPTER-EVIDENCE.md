# 二期真实站点适配证据（2026-10-23）

当前完成 **8 站 × 2 岗位＝16/26 页**，其中优先八家完成 **6/8 家**，白名单外完成米哈游一家。公司/岗位双字段在已验收的六家白名单 12 页中为 24/24 正确；城市和 JD 各 12/12 正确。**这不是全部八家或全部 26 页达标**。

本轮真实页面均在 Chromium 156 正常 TLS 校验下运行 `npm run probe:site` 与 `npm run plugin:tryrun`，只本地捕获事件，没有登录、投递或发送到业务后台。浏览事件均达到可见停留 3 秒的 strong 证据。原始采集要点和日期见 [live-results.json](../tests/fixtures/sites/live-results.json)，七字段预期与人工核对的已知值见 [cases.json](../tests/fixtures/sites/cases.json)。时间戳采用 UTC。

## 覆盖与未完成项

| 站点 | 本轮有效详情 | 状态 / 范围 |
|---|---:|---|
| 腾讯 | 2/2 | 仅 careers.tencent.com 的 jobdesc 浏览态；Workday 外跳、校招及投递未验。 |
| 字节 | 2/2 | 校园详情；同一历史岗位已在本轮重验，不回归。 |
| 阿里 | 0/2（未测字段） | 校园列表显示 0 条，官网首页有 Network Error，未取得有效详情；未把 0 条当作真实无招聘。 |
| 美团 | 2/2 | 官网 web/position/detail 浏览态；登录及投递未验。 |
| 京东 | 2/2 | 新社会招聘 job-info-detail 可访问；旧列表需登录，校园入口未验。 |
| 小米 | 2/2 | 旧版 hr.xiaomi.com 招聘库（列表发布时间 2017）；不证明岗位仍开放。 |
| 百度 | 0/2（未测字段） | 公开列表曾返回 SSR 岗位，但浏览器详情进入 about:blank；wappass 等资源失败，未取得可验收的渲染详情。 |
| 网易 | 2/2 | 中文详情 lang=zh；登录、投递和英语入口未验。 |
| BOSS | 0/2（未测字段） | 入口停留“加载中，请稍候”，未发现可验收详情；未绕过访问限制。 |
| 牛客 | 0/2（未测字段） | 公开列表能加载，所选真实详情显示“访问链接出错”；gw-c.nowcoder.com API 请求被拦截。 |
| 实习僧 | 2/2 | 两条公开实习详情；乱码字段保守留空，未绕过字体反爬。 |
| 米哈游 | 2/2 | 白名单外通用识别；公司/城市保守留空，岗位、JD、ID、hash 链接正确。 |
| 拼多多 | 0/2（未测字段） | 入口 ERR_TUNNEL_CONNECTION_FAILED，未取得详情。 |

用户已选择暂不应用更多网络配置，先完成可访问部分。上述未取得详情的五站共 10 页仍未完成，未编造 URL、字段或快照；“未测”不等于采集字段为空。阿里、百度、BOSS、牛客的专属规则维持草案；拼多多仍未通过通用识别验收。

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

## 同一真实 DOM 的改造前基线

取证在代码改造之后恢复，因此本表是将 **main 88b7334 的原样 content 脚本**注入本轮真实渲染快照所得的离线重建基线，**不是事先完成的线上摸底**。该时间顺序限制保留在交付报告。两种算法回放同一 DOM，便于比较；原始结果见 [baseline-88b7334.json](../tests/fixtures/sites/baseline-88b7334.json)。对/错按人工核对的七字段口径判断；空值单列，不算正确。

### 改造前（88b7334）

| 岗位快照 | 公司 | 岗位 | 城市 | 批次 | JD | 岗位ID | 链接 |
|---|---|---|---|---|---|---|---|
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
| shixiseng/inn_bliwylwige4t.html | 对 | 对 | 对 | 空 | 对 | 空 | 对 |
| shixiseng/inn_lri5lbntavwi.html | 对 | 对 | 对 | 空 | 对 | 空 | 对 |
| tencent/1942052496046424064.html | 对 | 错：岗位详情 | 空 | 空 | 错：登录 社会招聘 校园招聘 生活在腾讯 产品和服务 工作地点 查看工作岗位 《三角洲行动》-系统策划（烽火地带模式）深圳 分享 分享岗位 方式1:复制岗位链接 点 | 空 | 对 |
| tencent/2099730961662128128.html | 对 | 错：岗位详情 | 空 | 空 | 错：登录 社会招聘 校园招聘 生活在腾讯 产品和服务 工作地点 查看工作岗位 在研UE5项目-战斗动画设计师上海 分享 分享岗位 方式1:复制岗位链接 点击复制 方 | 空 | 对 |
| xiaomi/714.html | 对 | 错：手机 \uE623 | 空 | 空 | 错：职位名称： 天线工程师 工作地点： Peking 职位类别： 研发工程师 招聘渠道： 社会招聘 工作职责： 1. 按时保量完成小米项目的天线设计及验证工作； 2 | 空 | 对 |
| xiaomi/800.html | 对 | 错：手机 \uE623 | 空 | 空 | 错：职位名称： Android Multimedia系统工程师（小米电视） 工作地点： Peking 职位类别： 研发工程师 招聘渠道： 社会招聘 工作职责： 1. | 空 | 对 |

本表 112 个字段：正确 50、错误 24、空 38。

### 改造后（本轮代码）

| 岗位快照 | 公司 | 岗位 | 城市 | 批次 | JD | 岗位ID | 链接 |
|---|---|---|---|---|---|---|---|
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
| shixiseng/inn_bliwylwige4t.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| shixiseng/inn_lri5lbntavwi.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| tencent/1942052496046424064.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| tencent/2099730961662128128.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| xiaomi/714.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |
| xiaomi/800.html | 对 | 对 | 对 | 空 | 对 | 对 | 对 |

本表 112 个字段：正确 96、错误 0、空 16。

改造后 16 个空字段包括：12 个页面没有明确招聘批次；米哈游两页的公司和城市虽可由人工核对，但通用规则缺少可靠字段来源，四项保守留空。没有把空值计作正确率。两页米哈游标题均正确，第二个白名单外站点拼多多仍未完成。

六家优先官网的 `site_verified` 附带日期、路径及运行时 URL 范围；实习僧另有实习详情验证。其他路径不获得已验证选择器的高分。米哈游继续使用 generic，没有新增专属适配器来冒充通用能力。字节两页七字段均正确，既有校园岗位未回归。

## 可复验方式

```bash
export PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/playwright-official
npm run probe:site -- '<真实详情URL>' --report .tmp/probe.json
npm run plugin:tryrun -- '<真实详情URL>' --report .tmp/tryrun.json --snapshot .tmp/job.html
node tools/replay-sites.mjs --ref 88b7334 --report .tmp/before.json
node tools/replay-sites.mjs --report .tmp/after.json
npm run test:e2e
```

试跑的“核心字段有值”只是采集烟测，不能替代人工核对；HTTP 失败、空壳页和无事件会失败退出，不再把 0 字段正常退出当作通过。`probe:site` 的快照仍须人工确认是岗位详情，不能直接计为真实样本。

系统提供的公开代理 CA 指纹与 NSS 中 `OpenAI-nebula-dns` 一致。用户授权后重复导入返回成功，但没有新增别名。实际问题是普通沙盒把 NSS 库设为只读（EROFS），Chromium 无法载入；使用获批的正常 NSS 执行上下文后，HTTPS 校验和页面渲染恢复。没有关闭 TLS 校验、修改 HOME 或使用忽略证书参数。

## 当前验收边界

全部真实登录、投递成功和账号投递记录页均未验证；没有操作用户线上待确认记录或真实邮件。main 中保留的 2026-10-22 QQ IMAP/SMTP 和字节单页证据属于前一轮历史，不证明本轮真实账号验收已通过。具体未完成项和发布限制见 [二期交付报告](PHASE2-DELIVERY.md)。
