# 03 后台接口与大模型服务

## 入口与职责

- [公共服务说明](../../server/README.md)：index.js、http.js、routes/index.js、auth.js、db.js、schema.sql、domain/。
- [简历与岗位 AI](../../server/src/modules/career-ai/README.md)：resume-parser.js、llm.js、service.js。
- [招聘进展工作流](../../server/src/modules/recruitment-intake/README.md)：LLM 提取 → Jev 判断 → 服务端校验；Dify 云端兜底。
- [邮件推送](../../server/src/modules/mail-push/README.md)：模板、管理员测试、SMTP/outbox、提醒批次。
- beta/invite.js：邀请码及使用次数；cloud/persistence.js：加密 SQLite 一致性快照和失败处理。

## 重点 review

1. 所有台账、简历、报告、复核和设备查询按 owner_id 隔离；管理员权限与邀请码名额分离。
2. API 密钥仅在服务端配置，缺失/超时/失败明确返回错误；用户内容不能突破结构化输出和服务端字段校验。
3. Jev/LLM 判断不能覆盖人工确定字段或绕过终态、并发版本、去重规则；缺证据进入补录/待确认。
4. 邮件同步与提醒分离；重复批次、授权失效、SMTP 受理/实际送达和 outbox 的区分。
5. 云持久化：WAL 一致性、密文完整性、revision 冲突、失败响应、关闭刷盘；只支持单写入实例。

## 本轮发现的必查项

`server/test/cloud-persistence.test.js:101`：模拟上传失败后，预期 `cloudPersistenceStatus().pending === true`，实际为 false；完整测试和单独重跑均复现。请重点检查 `cloud/persistence.js` 的 dirty 状态、串行上传链与后台自动 flush 的时序。这里只记录观察和排查方向，尚未认定根因，未修改运行时代码。

## 验证

```bash
npm test
node --test server/test/cloud-persistence.test.js server/test/cloud-persistence-http.test.js
npm run test:intake
```

PDF 测试需要 Python 3 的 pypdf；可用 `PYTHON_BIN=/你的/python` 指定。单元测试中的 LLM/Jev 是隔离假模型，不证明真实模型服务质量或线上恢复已验收。本地 4312 演示显式关闭云持久化，云端发布需要独立完成部署后验证。
