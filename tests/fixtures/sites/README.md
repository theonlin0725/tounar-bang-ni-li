# 真实岗位快照

本轮已取得 11 站 22 个真实岗位快照，均在正常 TLS 下完成 probe / 生产脚本试跑，详见 `live-results.json`。新增牛客、阿里、Airbnb 各两页；牛客/阿里校准，Airbnb 使用通用规则；快照删除招聘者姓名/在线状态卡片。完整 13 站 26 页仍未完成；失败入口记录在 `blocked-results.json`，禁止把错误页或合成页冒充真实岗位。

公开页面在正常 TLS 校验下成功渲染后，用 `probe:site` / `plugin:tryrun` 的 `--snapshot` 保存到 `<site>/<job>.html`，核查已删除表单、脚本状态、联系方式和个人信息。然后向 `cases.json` 加入条目：

```json
{"site":"example","url":"https://example.com/job/12345","file":"example/12345.html","expected":{"company_name":"真实公司","job_title":"真实岗位","location":"","recruitment_batch":"","jd_summary":"与80字截断口径一致的正文","site_job_id":"12345","job_url":"https://example.com/job/12345"}}
```

`npm run test:e2e` 会在完全拦截网络的上下文中回放这些快照，对全部预期字段逐项断言。`cases.json` 为空时，如实打印未运行，不计作真实站点回归通过。合成用例在相邻 `synthetic-capture/` 目录，单独标注。

`expected` 表示当前规则应输出的值。已知真实值与保守空值不同的字段，放在可选 `truth` 中覆盖，以便准确率表将其计为空而不是正确。`captured_at` 是真实取证 UTC 时间；每条应包含七个预期字段。

快照冻结真实可见性和字号，清除外部资源、执行脚本、表单、注释、联系方式及会话 URL。它用于字段回归，不是页面视觉复制。`baseline-88b7334.json` 是对同一真实 DOM 使用原 main 脚本重建的基线，不能冒充改造前事先完成的线上摸底。`replay-results.json` 是当前算法回放结果；`tools/replay-sites.mjs` 可重新生成两者。
