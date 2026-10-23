# 线上实例验收记录（2026-10-23 发布后）

| 项 | 值 |
|---|---|
| 域名 | `https://bangnili.app.workbuddy.host` |
| 分享链接 | `https://bangnili.app.workbuddy.host/?sharecode=SMDT7CDZYS` |
| 沙箱 | `e51f4e64fb634d1a85a63d0846af11a8`，http-service，verified |
| 部署目录 | 主工作区 `/Users/mingenlin/Desktop/opencode project/帮你理`（`main`） |

## 1. 我这个 agent 实测到的

用 `curl`（不带代理）和真实邮箱 OTP 完成了一轮登录验收：

| 检查 | 结果 |
|---|---|
| `GET /api/v1/health`（裸） | **403** 「链接不完整」 |
| `GET /api/v1/health?sharecode=…` | **200** `{"ok":true,...}` |
| `GET /api/v1/me?sharecode=…`（未登录） | **401**（鉴权生效） |
| `GET /?sharecode=…` | **200**，返回 SPA |
| 带码访问后，同一 cookie jar 再访问裸地址 | **200**（平台种了 `__wb_rsc` cookie） |
| `POST /auth/request-otp` 真实邮箱 | **200**，且**邮箱在 16:00:36 真的收到了验证码邮件** |
| 用邮件里的验证码登录 | **200**，`owner_id = usr_XXiHSmOWycML2ca2`（和真实库里的用户一致） |
| 台账数量 | applied `total 0 / stats 1` + viewed `4` + archived `1` = **6 条** |
| 待确认 | **22 条 open**（本地库是 20，说明线上真的跑过一次 IMAP 同步，多出的是 10-23 的两封数字广东笔试）|

结论：**真实库确实上线了、真实 SMTP 确实在发信、IMAP 同步确实在跑**。不是空库，也不是假发信。

## 2. 两个必须知道的限制

### 2.1 分享码（sharecode）

- 新浏览器/新网络直接开裸域名会 403；先带 `?sharecode=` 访问一次后，平台会种 `__wb_rsc` cookie，后续才放行。
- 所以**邮件里的链接如果只有裸域名，收件人点开就是 403**（除非他之前访问过）。
- 代码侧已支持（本分支）：设置 `SHARE_CODE` 环境变量后，
  - 提醒邮件里的所有链接自动附加 `sharecode`（`util.appendShareCode`）；
  - 插件后台地址可以写成 `https://域名/?sharecode=XXX`，`api.js` 会拆出来并对每个请求自动带上。
- 主工作区 `.env` 已加入 `SHARE_CODE=SMDT7CDZYS`（该文件被 gitignore，不会进仓库）。
  **要下次重新发布才生效。**
- 代价：分享码会随邮件链接扩散。目前白名单只有你一个邮箱、提醒只发给你自己，风险可控；
  如果平台以后支持「公开访问」，应优先改成公开并去掉 sharecode。

### 2.2 没有持久卷

平台已明确：沙箱无数据库、无持久卷。实测也印证——线上数据来自**上传时带上去的 `data/` 快照**，
之后写入的新数据（比如这次同步出来的 2 条待确认、登录会话）只存在当前容器里。

**重建/重新发布会回到上传时的快照**，不是回到空库，也不会保留发布后的新写入。

所以「重启存活测试」现在的含义是：接受「回到发布快照」，还是必须上云数据库。这是产品决策，不是修 bug。

## 3. 下次重新发布后要再验一遍的清单

```bash
B=https://bangnili.app.workbuddy.host
C=<SHARE_CODE>
curl -sS -o /dev/null -w "%{http_code}\n" "$B/api/v1/health?sharecode=$C"        # 200
curl -sS -o /dev/null -w "%{http_code}\n" "$B/api/v1/me?sharecode=$C"            # 401
curl -sS "$B/api/v1/health?sharecode=$C"                                          # ok:true
```

然后再用真实邮箱收一次验证码登录，确认：

- [ ] 台账还是 6 条、待确认数量合理（不是 0）
- [ ] 设置页能看到邮箱连接 `connected`
- [ ] 手动点一次「立即同步邮箱」，确认不报 reauth
- [ ] 待确认里点「不对，我来改」，公司/岗位能改、能提交
- [ ] （触发一次提醒后）邮件里的链接带 `sharecode`，手机 4G 网络点开不是 403

## 4. 发布版本说明

本次发布的是**主工作区旧代码**（phase1），phase3 的修复不在里面。之后已把
`phase3-local-fix-20261023` fast-forward 合并进 `main` 并推送（`f250e5c`），
所以**下一次重新发布**会带上：阶段规则、轮次规则、人工修改、拒信分类、分享码支持等。
