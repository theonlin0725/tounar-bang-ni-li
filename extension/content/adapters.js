/*
 * Site adapter registry (classic script; used by content scripts and popup).
 *
 * D02 已冻结（2026-10-22）：优先支持白名单 =
 *   腾讯 / 字节跳动 / 阿里巴巴 / 美团 / 京东 / 小米 / 百度 / 网易（priority: 1）。
 * BOSS直聘/牛客为扩展期草案（priority: 2）；实习僧的公开实习详情已验证，其他页面仍未验收。
 * 聊天/沟通页面一律不采集；只认 Web 岗位详情页 + 确证的成功提交。
 *
 * Honest scope: selector rules below are best-effort drafts unless site_verified
 * is true (see docs/SITE-ADAPTER-EVIDENCE.md). Every adapter carries a version
 * that is attached to each event so the server and reviews can reason about
 * parsing provenance.
 */
(function () {
  const GENERIC = {
    key: 'generic',
    label: '通用识别（任意已授权站点）',
    version: '1.2.0-scored',
    channel: '网页',
    hosts: [],
    // 覆盖面优先的详情页 URL 线索（只放「指向详情页」的形态；landing 页泛词如 /campus、/career
    // 不在此处，由 tracker 的「投递按钮信号」把关，避免把公司招聘首页误记为岗位）
    jobUrlPatterns: [
      /\/job[s]?[/#-]/i, /\/position[s]?[/#-]/i, /\/post[s]?[/#-]/i, /\/opening[s]?[/#-]/i,
      /\/vacancy|\/vacancies/i, /\/detail/i, /\/jobdetail/i, /\/jobinfo/i,
      /job_?id=/i, /position_?id=/i, /post_?id=/i
    ],
    listUrlPatterns: [/\/job[s]?\/?(\?|$)/i, /\/position[s]?\/?(\?|$)/i, /\/search/i, /\/list/i, /\/jobs\/?\?/i],
    selectors: {
      title: ['h1', '[class*="job-title"]', '[class*="jobTitle"]', '[class*="position-title"]', '[class*="post-title"]', '[class*="detail-title"]'],
      company: ['[class*="company-name"]', '[class*="companyName"]', '[class*="employer"]'],
      jd: ['[class*="job-detail"]', '[class*="jobDetail"]', '[class*="position-detail"]', '[class*="job-desc"]', '[class*="description"]'],
      location: ['[class*="job-location"]', '[class*="location"]', '[class*="address"]'],
      success: ['[class*="success"]', '[class*="result"]', '[class*="message"]']
    },
    statusPage: null,
    site_verified: false,
    notes: '多候选评分：显式钩子/JSON-LD/已验证适配器/岗位语义；低把握留空，不用域名猜公司或最长正文猜JD。真实页面覆盖仍需逐站验收。'
  };

  // 已知招聘官网域名 → 公司名（通用识别的公司字段兜底；聚合平台返回 null，不猜）
  const HOST_COMPANY = {
    'join.qq.com': '腾讯', 'careers.tencent.com': '腾讯', 'hr.tencent.com': '腾讯',
    'jobs.bytedance.com': '字节跳动', 'job.bytedance.com': '字节跳动',
    'talent.alibaba.com': '阿里巴巴', 'campus.alibaba.com': '阿里巴巴',
    'campus.meituan.com': '美团', 'zhaopin.meituan.com': '美团', 'hr.meituan.com': '美团',
    'campus.jd.com': '京东', 'zhaopin.jd.com': '京东',
    'campus.xiaomi.com': '小米', 'hr.xiaomi.com': '小米',
    'talent.baidu.com': '百度',
    'campus.163.com': '网易', 'hr.163.com': '网易',
    'www.zhipin.com': null, 'zhipin.com': null,
    'www.nowcoder.com': null, 'nowcoder.com': null,
    'www.shixiseng.com': null, 'shixiseng.com': null
  };

  function companyForHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    if (Object.prototype.hasOwnProperty.call(HOST_COMPANY, host)) return HOST_COMPANY[host];
    for (const [key, value] of Object.entries(HOST_COMPANY)) {
      if (host.endsWith(`.${key}`)) return value;
    }
    return undefined; // 未知站点：没有映射，也不反对
  }

  const ADAPTERS = [
    {
      key: 'tencent',
      company_name: '腾讯',
      priority: 1,
      label: '腾讯招聘',
      version: '1.0.0-verified-jobdesc',
      channel: '企业官网',
      hosts: ['join.qq.com', 'careers.tencent.com', 'hr.tencent.com'],
      jobUrlPatterns: [/\/position\//i, /\/job\//i, /jobdesc/i],
      listUrlPatterns: [/\/position\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.job-text-wrapper > .job-recruit-title'],
        company: [],
        jd: ['.duty.work-module .duty-text'],
        location: ['.job-text-wrapper > .job-recruit-location'],
        success: ['.apply-success', '.submit-success', '[class*="applyResult"]']
      },
      statusPage: {
        urlPatterns: [/\/user\/apply/i, /\/my\/deliver/i, /\/apply\/record/i],
        rowSelector: '[class*="apply-item"], [class*="deliver-item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="position"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      refine: function tencentRefine(job) {
        job.location = String(document.querySelector('.job-text-wrapper > .job-recruit-location')?.innerText || '').trim();
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-23',
      verified_paths: ['/jobdesc.html?postId={id}'],
      verifiedUrlPatterns: [/^https:\/\/careers\.tencent\.com\/jobdesc\.html\?(?=[^#]*\bpostId=\d+)/i],
      notes: '真实官网 jobdesc 两页的浏览字段见 tests/fixtures/sites/tencent；Workday 外跳、join.qq.com 和投递登录态未验证。'
    },
    {
      key: 'bytedance',
      company_name: '字节跳动',
      priority: 1,
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
      verifiedUrlPatterns: [/^https:\/\/jobs\.bytedance\.com\/campus\/position\/\d+\/detail(?:[?#]|$)/i],
      notes: '选择器已于 2026-10-22 用真实页面（jobs.bytedance.com/campus/position/7699119731313821957/detail，AI Agent产品经理 - 巨量AI工作台）验证：span.job-title 取标题、.job-info 取「城市 类型 职能 批次 职位 ID」、.block-content 取 JD 正文（职位描述/职位要求两段）。页面为纯前端渲染 SPA，服务端 HTML 无内容，依赖 content script 轮询重试。投递记录页需登录态，仍未验证。'
    },
    {
      key: 'alibaba',
      company_name: '阿里巴巴',
      priority: 1,
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
      company_name: '美团',
      priority: 1,
      label: '美团招聘',
      version: '1.0.0-verified-web-detail',
      channel: '企业官网',
      hosts: ['campus.meituan.com', 'zhaopin.meituan.com', 'hr.meituan.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.position_detail_sticky_left .postion_name > .title'],
        company: [],
        jd: ['.positin_detail_info_item'],
        location: ['.position_detail_sticky_left .split_line_box_item'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i, /\/record/i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      refine: function meituanRefine(job) {
        const place = String(document.querySelector('.position_detail_sticky_left .split_line_box_item')?.innerText || '').trim();
        const locationMatch = place.match(/^工作地点[:：]\s*(.+)$/);
        if (locationMatch) job.location = locationMatch[1];
        job.recruitment_batch = String(document.querySelector('.position_detail_sticky_left .postion_name > .tag')?.innerText || '').trim();
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-23',
      verified_paths: ['/web/position/detail?jobUnionId={id}'],
      verifiedUrlPatterns: [/^https:\/\/zhaopin\.meituan\.com\/web\/position\/detail\?(?=[^#]*\bjobUnionId=\d+)/i],
      notes: '真实官网两页浏览字段见 tests/fixtures/sites/meituan；其他招聘域名和投递登录态未验证。'
    },
    {
      key: 'jd',
      company_name: '京东',
      priority: 1,
      label: '京东招聘',
      version: '1.0.0-verified-job-info-detail',
      channel: '企业官网',
      hosts: ['campus.jd.com', 'zhaopin.jd.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i, /\/web\/job-info-detail/i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.post-top > h1.post-name'],
        company: [],
        jd: ['.main-content > h2.f-title + .part'],
        location: ['.post-top .post-info > span'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      refine: function jdRefine(job) {
        for (const node of document.querySelectorAll('.post-top .post-info > span')) {
          const place = String(node.innerText || '').match(/^工作地点[:：]\s*(.+)$/);
          if (place) job.location = place[1].trim();
        }
        const id = new URLSearchParams(location.search).get('requementId');
        if (id && /^\d+$/.test(id)) job.site_job_id = id;
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-23',
      verified_paths: ['/web/job-info-detail?requementId={id}'],
      verifiedUrlPatterns: [/^https:\/\/zhaopin\.jd\.com\/web\/job-info-detail\?(?=[^#]*\brequementId=\d+)/i],
      notes: '真实社会招聘详情 226996、225873 见 tests/fixtures/sites/jd；旧 job_list 入口需登录，campus.jd.com 与投递登录态未验证。'
    },
    {
      key: 'xiaomi',
      company_name: '小米',
      priority: 1,
      label: '小米招聘',
      version: '1.0.0-verified-legacy-detail',
      channel: '企业官网',
      hosts: ['campus.xiaomi.com', 'hr.xiaomi.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.job-information tr:first-child td:nth-child(2)'],
        company: [],
        jd: ['.job-information .details-list'],
        location: ['.job-information tr:first-child td:nth-child(4)'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      refine: function xiaomiRefine(job) {
        const cells = document.querySelectorAll('.job-information td');
        for (const cell of cells) {
          const label = String(cell.innerText || '').trim();
          const value = String(cell.nextElementSibling?.innerText || '').trim();
          if (/^工作地点[:：]$/.test(label)) job.location = value;
        }
        const id = location.pathname.match(/^\/job\/view\/(\d+)\/?$/);
        if (id) job.site_job_id = id[1];
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-23',
      verified_paths: ['/job/view/{id}'],
      verifiedUrlPatterns: [/^https:\/\/hr\.xiaomi\.com\/job\/view\/\d+\/?(?:[?#]|$)/i],
      notes: '真实公开页 /job/view/714、/800 的表格岗位字段已核验，快照见 tests/fixtures/sites/xiaomi。仅此旧版详情路径通过验证；页面来自旧招聘库，不代表岗位仍开放。campus.xiaomi.com、投递和登录态均未验证。'
    },
    {
      key: 'baidu',
      company_name: '百度',
      priority: 1,
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
      company_name: '网易',
      priority: 1,
      label: '网易招聘',
      version: '1.0.0-verified-job-detail',
      channel: '企业官网',
      hosts: ['campus.163.com', 'hr.163.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.job-detail-header-c .posi-name > span'],
        company: [],
        jd: ['.job-de-de-left > .content'],
        location: ['.job-detail-header-c .posi-sc-name'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      statusPage: {
        urlPatterns: [/\/apply/i, /\/my\//i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      refine: function neteaseRefine(job) {
        const parts = String(document.querySelector('.job-detail-header-c .posi-sc-name')?.innerText || '').split('|').map(part => part.trim());
        if (parts.length >= 2) job.location = parts[1];
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-23',
      verified_paths: ['/job-detail.html?id={id}&lang=zh'],
      verifiedUrlPatterns: [/^https:\/\/hr\.163\.com\/job-detail\.html\?(?=[^#]*\bid=\d+)/i],
      notes: '真实中文详情 79495、78226 见 tests/fixtures/sites/netease；英语入口、campus.163.com 和投递登录态未验证。'
    },
    {
      key: 'boss',
      priority: 2,
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
      priority: 2,
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
      priority: 2,
      label: '实习僧',
      version: '1.0.0-verified-intern',
      channel: '实习僧',
      hosts: ['www.shixiseng.com', 'shixiseng.com'],
      jobUrlPatterns: [/\/intern\//i, /\/job\//i],
      listUrlPatterns: [/\/interns/i, /\/search/i],
      applySelectors: ['.resume_apply'],
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
      refine: function shixisengRefine(job) {
        const id = location.pathname.match(/^\/intern\/(inn_[a-z0-9]+)\/?$/i);
        if (id) job.site_job_id = id[1];
        job.location = String(document.querySelector('.job_position')?.innerText || '').trim();
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-23',
      verified_paths: ['/intern/{inn_id}'],
      verifiedUrlPatterns: [/^https:\/\/(?:www\.)?shixiseng\.com\/intern\/inn_[a-z0-9]+\/?(?:[?#]|$)/i],
      notes: '公开实习详情 inn_lri5lbntavwi、inn_bliwylwige4t 已核验，快照见 tests/fixtures/sites/shixiseng。仅浏览态，投递/登录态未验证。字体反爬字符未解码，含乱码字段应留空。'
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

  // D02 冻结的白名单（priority 1）；其余为扩展期草案（priority 2）
  function whitelist() {
    return ADAPTERS.filter((a) => a.priority === 1).map((a) => ({ key: a.key, label: a.label, site_verified: !!a.site_verified }));
  }

  globalThis.TounarAdapters = {
    GENERIC,
    ADAPTERS,
    resolveAdapter,
    supportedHosts,
    whitelist,
    companyForHost,
    statusTextToCanonical,
    SOURCE_NOTE: 'adapter rules are drafts until per-site real-session verification (G04)'
  };
})();
