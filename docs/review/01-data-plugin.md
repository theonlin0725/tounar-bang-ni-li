# 01 数据插件层

## 入口

- [浏览器扩展](../../extension/README.md)：manifest、content/adapters.js、content/tracker.js、background/service-worker.js、popup/。
- [服务端采集模块](../../server/src/modules/data-capture/README.md)：插件事件、邮箱来源采集和云模型解析兜底。
- [事件契约](../C1-A1-CONTRACT.md)：请求、鉴权、幂等和回执。

## 建议 review 顺序

1. tracker/adapters：岗位字段来源、前台停留门槛、SPA 切换、防止把帮你理自身页面当岗位、用户输入的采集边界。
2. service-worker/popup：离线队列、后台地址规范化、切换后台清除旧身份、非空队列阻止跨后台迁移、回执与提示一致。
3. server/src/modules/data-capture/plugin.js：设备权限、事件去重、字段校验与台账入口；mail/ 下检查邮件解析、游标及匹配。
4. tools/build-beta-plugin.mjs：只打包运行文件，平台分享码通过环境变量显式提供。

## 验证

```bash
npm run test:e2e
npm run test:self-page
node tests/e2e/backend-switch.mjs
```

后两条是推荐的专项复核命令；本轮是否执行见 VALIDATION.md。测试使用独立浏览器/数据库，不代表全部真实招聘网站已验收。后台采集产物交给公共 domain/ledger/reviews 和 recruitment-intake 工作流，避免评审时把它们误认为插件内部逻辑。
