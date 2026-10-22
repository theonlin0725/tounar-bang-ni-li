/*
 * Site adapter registry (classic script; used by content scripts and popup).
 *
 * Honest scope: selector rules below are best-effort drafts. Only the generic
 * JSON-LD path and the explicitly documented `data-tounar-*` structured status
 * block can be verified locally; per-site accuracy awaits real logged-in
 * fixtures (G04 blocked). Every adapter carries a version that is attached to
 * each event so the server and reviews can reason about parsing provenance.
 */
(function () {
  const GENERIC = {
    key: 'generic',
    label: '通用页面（JSON-LD JobPosting）',
    version: '1.0.0',
    channel: '网页',
    hosts: [],
    jobUrlPatterns: [/\/job[s]?[/#-]/i, /\/position[s]?\//i, /\/apply/i, /\/career/i, /\/campus/i, /\/zhaopin/i],
    listUrlPatterns: [/\/job[s]?\/?(\?|$)/i, /\/search/i, /\/list/i],
    selectors: {
      title: ['h1', '[class*="job-title"]', '[class*="jobTitle"]', '[class*="position-title"]'],
      company: ['[class*="company-name"]', '[class*="companyName"]'],
      jd: ['[class*="job-detail"]', '[class*="jobDetail"]', '[class*="position-detail"]'],
      location: ['[class*="job-location"]', '[class*="location"]'],
      success: ['[class*="success"]', '[class*="result"]', '[class*="message"]']
    },
    statusPage: null,
    site_verified: false,
    notes: '只依赖结构化数据（JSON-LD）与显式 data-tounar-* 状态块；不猜测任意页面文本。'
  };

  const ADAPTERS = [
    {
      key: 'tencent',
      label: '腾讯招聘',
      version: '0.1.0-draft',
      channel: '企业官网',
      hosts: ['join.qq.com', 'careers.tencent.com', 'hr.tencent.com'],
      jobUrlPatterns: [/\/position\//i, /\/job\//i, /jobdesc/i],
      listUrlPatterns: [/\/position\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.job-title', '.position-title', 'h1[class*="title"]'],
        company: ['.company-name'],
        jd: ['.job-desc', '.position-desc', '[class*="detail-content"]'],
        location: ['.job-location', '.position-address'],
        success: ['.apply-success', '.submit-success', '[class*="applyResult"]']
      },
      statusPage: {
        urlPatterns: [/\/user\/apply/i, /\/my\/deliver/i, /\/apply\/record/i],
        rowSelector: '[class*="apply-item"], [class*="deliver-item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="position"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    },
    {
      key: 'bytedance',
      label: '字节跳动招聘',
      version: '1.0.0-verified-campus',
      channel: '企业官网',
      hosts: ['jobs.bytedance.com', 'job.bytedance.com'],
      jobUrlPatterns: [
        /\/campus\/position\/\d+\/detail/i,
        /\/experienced\/position\/\d+\/detail/i,
        /\/position\/\d+\/detail/i,
        /\/position\//i,
        /\/job\//i
      ],
      listUrlPatterns: [/\/campus\/position\/?(\?|$)/i, /\/experienced\/position\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['span.job-title', '.job-header .job-title', '.job-header', 'h1[class*="title"]'],
        company: [],
        jd: ['.block-content', '[class*="jobDetail"] .block-content'],
        location: ['.job-info'],
        success: ['.apply-success', '[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/application/i, /\/apply\/record/i, /\/my\//i],
        rowSelector: '[class*="application-item"], [class*="apply-item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="position"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      refine: function bytedanceRefine(job) {
        job.company_name = '字节跳动';
        const info = (() => {
          const el = document.querySelector('.job-info');
          return el ? String(el.innerText || '').replace(/\s+/g, ' ').trim() : '';
        })();
        const locMatch = info.match(/^([\u4e00-\u9fa5、·/ ]+?)\s*(正式|实习|兼职|全职|校招|社招)/);
        if (locMatch) job.location = locMatch[1].trim();
        const batchMatch = info.match(/(20\d{2})\s*届\s*([^\s]*?(校招|校园招聘|秋招|春招|实习))/);
        if (batchMatch) job.recruitment_batch = `${batchMatch[1]} ${batchMatch[3]}`;
        // URL 里的数字 ID 更稳定，已经取到就不覆盖
        const idMatch = info.match(/职位\s*ID\s*[:：]\s*([A-Za-z0-9-_]+)/);
        if (idMatch && !job.site_job_id) job.site_job_id = idMatch[1];
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-22',
      verified_paths: ['/campus/position/{id}/detail'],
      notes: '选择器已于 2026-10-22 用真实页面（jobs.bytedance.com/campus/position/7699119731313821957/detail，AI Agent产品经理 - 巨量AI工作台）验证：span.job-title 取标题、.job-info 取「城市 类型 职能 批次 职位 ID」、.block-content 取 JD 正文（职位描述/职位要求两段）。页面为纯前端渲染 SPA，服务端 HTML 无内容，依赖 content script 轮询重试。投递记录页需登录态，仍未验证。'
    },
    {
      key: 'alibaba',
      label: '阿里巴巴校园招聘',
      version: '0.1.0-draft',
      channel: '企业官网',
      hosts: ['talent.alibaba.com', 'campus.alibaba.com'],
      jobUrlPatterns: [/\/position\//i, /\/job\//i, /jobDetail/i],
      listUrlPatterns: [/\/position\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.position-title', '[class*="job-title"]', 'h1'],
        company: ['.company-name'],
        jd: ['.position-desc', '[class*="detail"]'],
        location: ['.position-address', '[class*="location"]'],
        success: ['[class*="success"]', '[class*="message"]']
      },
      statusPage: {
        urlPatterns: [/\/applied/i, /\/application/i, /\/my\//i],
        rowSelector: '[class*="application"], [class*="item"], table tbody tr',
        titleSelector: '[class*="title"], [class*="job"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    },
    {
      key: 'meituan',
      label: '美团招聘',
      version: '0.1.0-draft',
      channel: '企业官网',
      hosts: ['campus.meituan.com', 'zhaopin.meituan.com', 'hr.meituan.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['[class*="job-title"]', '.title', 'h1'],
        company: ['[class*="company"]'],
        jd: ['[class*="job-desc"]', '[class*="detail"]'],
        location: ['[class*="location"]'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i, /\/record/i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    },
    {
      key: 'jd',
      label: '京东招聘',
      version: '0.1.0-draft',
      channel: '企业官网',
      hosts: ['campus.jd.com', 'zhaopin.jd.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['[class*="job-title"]', '.title', 'h1'],
        company: ['[class*="company"]'],
        jd: ['[class*="job-desc"]', '[class*="detail"]'],
        location: ['[class*="location"]'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    },
    {
      key: 'xiaomi',
      label: '小米招聘',
      version: '0.1.0-draft',
      channel: '企业官网',
      hosts: ['campus.xiaomi.com', 'hr.xiaomi.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['[class*="job-title"]', '.title', 'h1'],
        company: ['[class*="company"]'],
        jd: ['[class*="job-desc"]', '[class*="detail"]'],
        location: ['[class*="location"]'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    },
    {
      key: 'baidu',
      label: '百度招聘',
      version: '0.1.0-draft',
      channel: '企业官网',
      hosts: ['talent.baidu.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i, /detail/i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['[class*="job-title"]', '.title', 'h1'],
        company: ['[class*="company"]'],
        jd: ['[class*="job-desc"]', '[class*="detail"]'],
        location: ['[class*="location"]'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    },
    {
      key: 'netease',
      label: '网易招聘',
      version: '0.1.0-draft',
      channel: '企业官网',
      hosts: ['campus.163.com', 'hr.163.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['[class*="job-title"]', '.title', 'h1'],
        company: ['[class*="company"]'],
        jd: ['[class*="job-desc"]', '[class*="detail"]'],
        location: ['[class*="location"]'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    },
    {
      key: 'boss',
      label: 'BOSS直聘（仅岗位详情）',
      version: '0.1.0-draft',
      channel: 'BOSS直聘',
      hosts: ['www.zhipin.com', 'zhipin.com'],
      jobUrlPatterns: [/\/job_detail\//i, /\/job\//i],
      listUrlPatterns: [/\/web\/geek\/jobs/i, /\/search/i],
      selectors: {
        title: ['.job-name', '.name h1', 'h1'],
        company: ['.company-info .name', '.company-name', '[class*="company-name"]'],
        jd: ['.job-sec .text', '.job-detail-section', '[class*="job-detail"]'],
        location: ['.job-area', '.location'],
        success: ['[class*="success"]', '.dialog-title']
      },
      statusPage: null,
      site_verified: false,
      notes: 'BOSS 聊天/沟通页面不采集；只处理岗位详情。选择器为草案（G04）。'
    },
    {
      key: 'nowcoder',
      label: '牛客网',
      version: '0.1.0-draft',
      channel: '牛客',
      hosts: ['www.nowcoder.com', 'nowcoder.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i, /\/detail\//i],
      listUrlPatterns: [/\/job\/center/i, /\/search/i],
      selectors: {
        title: ['.job-title', '.title', 'h1'],
        company: ['.company-name', '[class*="company"]'],
        jd: ['.job-desc', '.detail-content'],
        location: ['.job-location', '[class*="location"]'],
        success: ['[class*="success"]', '[class*="message"]']
      },
      statusPage: {
        urlPatterns: [/\/my\/apply/i, /\/apply\/record/i, /\/deliver/i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    },
    {
      key: 'shixiseng',
      label: '实习僧',
      version: '0.1.0-draft',
      channel: '实习僧',
      hosts: ['www.shixiseng.com', 'shixiseng.com'],
      jobUrlPatterns: [/\/intern\//i, /\/job\//i],
      listUrlPatterns: [/\/interns/i, /\/search/i],
      selectors: {
        title: ['.new_job_name', '.job-title', 'h1'],
        company: ['.com-name', '.company-name'],
        jd: ['.job_detail', '.job-detail'],
        location: ['.job_position', '[class*="location"]'],
        success: ['[class*="success"]', '[class*="message"]']
      },
      statusPage: {
        urlPatterns: [/\/resume\/apply/i, /\/applied/i, /\/my\//i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      site_verified: false,
      notes: '选择器为草案；未经真实登录态验证（G04）。'
    }
  ];

  const STATUS_TEXT_MAP = [
    [/已投递|投递成功|已申请|申请成功|已提交/, 'applied'],
    [/笔试|测评|在线考试|测试/, 'assessment'],
    [/面试|初试|复试|一面|二面|三面|终面|面谈/, 'interview'],
    [/offer|录用|待入职|意向书/i, 'offer'],
    [/已拒绝|拒绝|不合适|未通过|已淘汰|感谢信/, 'rejected'],
    [/已关闭|流程结束|已结束|岗位关闭/, 'closed']
  ];

  function statusTextToCanonical(text) {
    const value = String(text || '');
    for (const [pattern, status] of STATUS_TEXT_MAP) {
      if (pattern.test(value)) return status;
    }
    return null;
  }

  function hostMatches(hostname, adapter) {
    const host = String(hostname || '').toLowerCase();
    return adapter.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  function resolveAdapter(hostname) {
    for (const adapter of ADAPTERS) {
      if (hostMatches(hostname, adapter)) return adapter;
    }
    return GENERIC;
  }

  function supportedHosts() {
    const hosts = [];
    for (const adapter of ADAPTERS) hosts.push(...adapter.hosts);
    return Array.from(new Set(hosts));
  }

  globalThis.TounarAdapters = {
    GENERIC,
    ADAPTERS,
    resolveAdapter,
    supportedHosts,
    statusTextToCanonical,
    SOURCE_NOTE: 'adapter rules are drafts until per-site real-session verification (G04)'
  };
})();
