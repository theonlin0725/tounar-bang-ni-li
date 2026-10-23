# 真实岗位快照

本轮浏览器证书取证受阻，当前没有已验收的真实快照；禁止把错误页或合成页放进来冒充真实岗位。

公开页面在正常 TLS 校验下成功渲染后，用 `probe:site` / `plugin:tryrun` 的 `--snapshot` 保存到 `<site>/<job>.html`，核查已删除表单、脚本状态、联系方式和个人信息。然后向 `cases.json` 加入条目：

```json
{"site":"example","url":"https://example.com/job/12345","file":"example/12345.html","expected":{"company_name":"真实公司","job_title":"真实岗位","location":"","recruitment_batch":"","jd_summary":"与80字截断口径一致的正文","site_job_id":"12345","job_url":"https://example.com/job/12345"}}
```

`npm run test:e2e` 会在完全拦截网络的上下文中回放这些快照，对全部预期字段逐项断言。`cases.json` 为空时，如实打印未运行，不计作真实站点回归通过。合成用例在相邻 `synthetic-capture/` 目录，单独标注。
