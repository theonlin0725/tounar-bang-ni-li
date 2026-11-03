# 02 前端页面

## 入口

[前端说明](../../web/README.md)。无构建 Vanilla SPA，由同一 Node 服务托管；不要双击 index.html，也不要另起静态服务替代后端。

| 文件 | 重点 |
|---|---|
| web/assets/js/app.js、api.js | 路由、Cookie 会话、请求错误和账号切换后的旧请求失效 |
| views/ledger.js、detail.js、manual.js | 台账统计/筛选、状态直改、来源证据与手动补录 |
| views/reviews.js | 确认入账/忽略、模型失败、缺字段补录、取消保持待确认 |
| views/career.js | 简历上传、画像、2–6 岗位对比、未投递推荐、失败重试 |
| views/settings.js、login.js | 授权/设备、邀请码与本机自测登录边界 |
| views/mail-admin.js、plugin-help.js | 管理员模板/测试与插件安装指引 |
| web/assets/app.css | 表格、弹层、窄屏和信息层级 |

重点检查：接口错误不得当作空数据；切账号不能展示旧账号内容；状态修改/复核的并发失败要保持真实状态；本地验证码不能在生产回显；AI 报告不能暗示录用概率或擅自修改投递状态。

```bash
npm run test:web
npm run test:career-ai
npm run test:mail-admin
```

第一条本次已执行，其他专项执行情况见 VALIDATION.md。源码中的 demo/ 是旧内存原型，不是 beta4 的运行入口。新增个人验收截图和成品 ZIP 不包含在本 PR。
