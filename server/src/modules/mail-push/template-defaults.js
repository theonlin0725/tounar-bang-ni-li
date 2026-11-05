// 代码只定义默认版本；管理员保存的版本存于当前 DATA_DIR 的 SQLite。
const rules = (required = []) => ({ required, missing: 'error', fallback: '待补充', max_subject: 180, max_text: 40000, max_html: 120000, variable_max: {}, fixed: [], forbidden: [] });
export const templateDefaults = {
  otp: {
    name: '登录验证码', purpose: '真实登录与敏感操作重验证；试发使用演示验证码，不具有登录效力。',
    variables: { code: '验证码', ttl_minutes: '有效分钟数' }, raw: [], essential: ['code', 'ttl_minutes'],
    subject: '【Tounar 帮你理】登录验证码',
    text: '你的帮你理登录验证码是 {{code}}，{{ttl_minutes}} 分钟内有效。\n如果不是你本人操作，请忽略这封邮件。',
    html: '<p>你的帮你理登录验证码是：</p><p style="font-size:28px;letter-spacing:6px;font-family:monospace"><strong>{{code}}</strong></p><p>{{ttl_minutes}} 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>',
    rules: rules(['code', 'ttl_minutes']), sample: { code: '123456', ttl_minutes: '10' }
  },
  reminder: {
    name: '提醒摘要（整封邮件）', purpose: '有进展、该回看、待确认三类内容共用一封摘要；body_* 由业务记录及下方卡片模板生成。',
    variables: { summary: '主题摘要', date_range: '收信／进展日期范围', body_text: '业务生成的纯文本内容', body_html: '业务生成的 HTML 内容', count_progress: '进展数', count_review: '回看数', count_digest: '待确认数', pushed_at: '实际推送时间（UTC）', settings_url: '提醒设置入口', reviews_url: '待确认入口', ledger_url: '台账入口' },
    raw: ['body_html'], essential: ['summary', 'date_range', 'body_text', 'body_html'],
    subject: '【帮你理】{{summary}}（{{date_range}}收到）',
    text: 'Tounar 帮你理 · 收信 / 进展日期 {{date_range}}\n{{body_text}}\n收信 / 进展日期：{{date_range}}\n推送时间：{{pushed_at}}（北京时间每日 08:00 触发，当天补发）\n提醒设置：{{settings_url}}',
    html: '<!doctype html><html lang="zh-CN"><body style="font-family:system-ui,sans-serif;line-height:1.8;color:#183c32"><main style="max-width:640px;margin:auto;padding:24px"><h1>Tounar · 帮你理</h1><p>收信 / 进展日期 {{date_range}}</p>{{{body_html}}}<footer><p>收信 / 进展日期：{{date_range}}</p><small>推送时间：{{pushed_at}}（北京时间每日 08:00 触发，当天补发）</small><p>只有明确确认状态无变化后，才重新计算回看时间。</p><a href="{{settings_url}}">提醒设置</a> · <a href="{{reviews_url}}">待确认队列</a> · <a href="{{ledger_url}}">打开台账</a></footer></main></body></html>',
    rules: rules(['summary', 'date_range', 'body_text', 'body_html']),
    sample: { summary: '自测科技·产品经理 有进展', date_range: '2026-10-30', body_text: '自测科技 · 产品经理\n手动补录\n这是模板示例，不证明业务触发成功。', body_html: '<h1>自测科技 · 产品经理</h1><p>这是模板示例，不证明业务触发成功。</p>', count_progress: '1', count_review: '0', count_digest: '0', pushed_at: '2026-10-30T00:00:00Z', settings_url: 'http://127.0.0.1:4311/?panel=settings', reviews_url: 'http://127.0.0.1:4311/?panel=reviews', ledger_url: 'http://127.0.0.1:4311/' }
  },
  progress_item: {
    name: '进展卡片', purpose: '摘要内每一条进展；修改这里可调整公司、岗位、JD、城市等字段与卡片排版。',
    variables: { company: '公司', job_title: '岗位', status: '当前状态', description: '进展说明', date: '发生／收信日期', date_label: '收到或发生', location: '城市（可选）', jd_summary: 'JD 摘要（可选）', applied_date: '投递日期（可选）', official_text: '官网链接文本', official_html: '安全的官网链接', detail_url: '台账详情链接' },
    raw: ['official_html'], essential: ['company', 'job_title', 'description', 'date', 'detail_url'],
    subject: '进展卡片',
    text: '{{company}} · {{job_title}}\n{{description}}\n—— {{date}} {{date_label}}\n{{official_text}}\n在台账里查看：{{detail_url}}',
    html: '<article><h3>{{company}} · {{job_title}}</h3><p>{{description}}</p><p>—— {{date}} {{date_label}}</p><p>{{{official_html}}}<a href="{{detail_url}}">在台账里查看</a></p></article>',
    rules: rules(['company', 'job_title', 'description', 'date', 'detail_url']),
    sample: { company: '自测科技', job_title: '产品经理', status: '已投递', description: '自测科技 · 产品经理：手动补录', date: '2026-10-30', date_label: '发生', location: '上海', jd_summary: '负责用户研究和产品方案，仅用于自测。', applied_date: '2026-10-30', official_text: '打开岗位/申请状态页：https://example.com/jobs/self-test', official_html: '<a href="https://example.com/jobs/self-test">打开岗位/申请状态页</a> · ', detail_url: 'http://127.0.0.1:4311/' }
  },
  review_item: {
    name: '回看卡片', purpose: '摘要内每一条到期回看，保留明确确认和详情入口。',
    variables: { company: '公司', job_title: '岗位', description: '回看标签', date_line: '邀请日期（可空）', official_text: '官网链接文本', official_html: '安全官网链接', confirm_url: '明确确认入口', detail_url: '详情入口' },
    raw: ['official_html'], essential: ['company', 'job_title', 'description', 'confirm_url', 'detail_url'],
    subject: '回看卡片', text: '{{company}} · {{job_title}}\n{{description}}\n{{date_line}}\n{{official_text}}\n我看过了，没变化：{{confirm_url}}\n结果出来了，去更新：{{detail_url}}',
    html: '<article><h3>{{company}} · {{job_title}}</h3><p>{{description}}</p><p>{{date_line}}</p><p>{{{official_html}}}<a href="{{confirm_url}}">我看过了，没变化</a> · <a href="{{detail_url}}">结果出来了，去更新</a></p></article>',
    rules: rules(['company', 'job_title', 'description', 'confirm_url', 'detail_url']),
    sample: { company: '自测科技', job_title: '产品经理', description: '已投 14 天', date_line: '', official_text: '', official_html: '', confirm_url: 'http://127.0.0.1:4311/', detail_url: 'http://127.0.0.1:4311/' }
  },
  digest_item: {
    name: '待确认卡片', purpose: '摘要中的待确认事项；处理入口由系统统一添加。', variables: { summary: '事项摘要', date_label: '邮件收到于或记录创建于', date: '原始日期' }, raw: [], essential: ['summary', 'date'],
    subject: '待确认卡片', text: '{{summary}}\n{{date_label}} {{date}}', html: '<p>{{summary}}<br>{{date_label}} {{date}}</p>', rules: rules(['summary', 'date']),
    sample: { summary: '自测科技面试邀请待确认', date_label: '邮件收到于', date: '2026-10-30' }
  }
};
