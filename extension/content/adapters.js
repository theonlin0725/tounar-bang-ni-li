/*
 * Site adapter registry (classic script; used by content scripts and popup).
 *
 * D02 已冻结（2026-10-22）：优先支持白名单 =
 *   腾讯 / 字节跳动 / 阿里巴巴 / 美团 / 京东 / 小米 / 百度 / 网易（priority: 1）。
 * BOSS直聘为扩展期草案（priority: 2）；牛客/实习僧的公开详情已验证，其他页面仍未验收。
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
    'talent-holding.alibaba.com': '阿里巴巴', 'talent.alibaba.com': '阿里巴巴', 'campus.alibaba.com': '阿里巴巴',
    'campus.meituan.com': '美团', 'zhaopin.meituan.com': '美团', 'hr.meituan.com': '美团',
    'campus.jd.com': '京东', 'zhaopin.jd.com': '京东',
    'campus.xiaomi.com': '小米', 'hr.xiaomi.com': '小米',
    'talent.baidu.com': '百度',
    'campus.163.com': '网易', 'hr.163.com': '网易',
    // 企业自建招聘站：域名即雇主，可以据此补公司（聚合站仍保持 null）
    'jobs.mihoyo.com': '米哈游',
    'job.xiaohongshu.com': '小红书',
    'careers.oppo.com': 'OPPO',
    'careers.pddglobalhr.com': '拼多多',
    'careers.pinduoduo.com': '拼多多',
    'zhaopin.kuaishou.cn': '快手', 'campus.kuaishou.cn': '快手',
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
      jobUrlPatterns: [/\/position\//i, /\/job\//i, /jobdesc/i, /\/post_detail\.html\?(?=[^#]*\bpostid=\d+)/i],
      listUrlPatterns: [/\/position\/?(\?|$)/i, /\/search/i],
      listCardSelector: '.recruit-list',
      listTitleSelector: '.job-recruit-title',
      listLocationSelector: '.job-recruit-location',
      // Tencent renders click handlers instead of hrefs. Replay only the public
      // Query request already used by this page, then match each visible card.
      async listIdentities() {
        if (location.hostname !== 'careers.tencent.com' || location.pathname !== '/search.html') return [];
        const requests = performance.getEntriesByType('resource').map(entry => entry.name).filter(raw => {
          try { const u = new URL(raw); return u.origin === location.origin && u.pathname === '/tencentcareer/api/post/Query'; } catch { return false; }
        });
        const url = requests.at(-1);
        if (!url) return [];
        const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
        if (!response.ok) return [];
        const data = await response.json();
        return (data?.Data?.Posts || []).filter(p => p.IsValid !== false && /^\d+$/.test(String(p.PostId))).map(p => {
          const url = new URL(p.PostURL, location.origin);
          if (url.hostname !== location.hostname || url.pathname !== '/jobdesc.html' || url.searchParams.get('postId') !== String(p.PostId)) return null;
          url.protocol = location.protocol;
          return { title: String(p.RecruitPostName || ''), location: String(p.LocationName || ''), url: url.href };
        }).filter(Boolean);
      },
      selectors: {
        title: ['.job-text-wrapper > .job-recruit-title', '.bannerTipLeft > .bannerItemText'],
        company: [],
        jd: ['.duty.work-module .duty-text', '.requirement.work-module .duty-text', '.post_detail > .detail_box .detail_text'],
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
      verified_paths: ['/jobdesc.html?postId={id}', '/post_detail.html?postid={id}'],
      verifiedUrlPatterns: [
        /^https:\/\/careers\.tencent\.com\/jobdesc\.html\?(?=[^#]*\bpostId=\d+)/i,
        /^https:\/\/join\.qq\.com\/post_detail\.html\?(?=[^#]*\bpostid=\d+)/i
      ],
      notes: '腾讯社招与校招公开详情的岗位字段；Workday 外跳和投递登录态未验证。'
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
      label: '阿里巴巴招聘',
      version: '1.0.0-verified-holding-detail',
      channel: '企业官网',
      hosts: ['talent-holding.alibaba.com', 'talent.alibaba.com', 'campus.alibaba.com'],
      jobUrlPatterns: [/\/off-campus\/position-detail/i, /\/position\//i, /\/job\//i, /jobDetail/i],
      listUrlPatterns: [/\/position\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.SQ8sqdO4BspxKg3a0aUzT .bXVhSIL-ovT-82dSXA2yw'],
        company: [],
        jd: ['.deep-campus-position-detail .content-block .main.block-info'],
        location: ['.SQ8sqdO4BspxKg3a0aUzT ._3fmnZBH2dYKBwZACjRtKEk > div:last-child'],
        success: ['[class*="success"]', '[class*="message"]']
      },
      statusPage: {
        urlPatterns: [/\/applied/i, /\/application/i, /\/my\//i],
        rowSelector: '[class*="application"], [class*="item"], table tbody tr',
        titleSelector: '[class*="title"], [class*="job"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      refine: function alibabaRefine(job) {
        job.location = String(document.querySelector('.SQ8sqdO4BspxKg3a0aUzT ._3fmnZBH2dYKBwZACjRtKEk > div:last-child')?.innerText || '').trim();
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-23',
      verified_paths: ['/off-campus/position-detail?positionId={id}'],
      verifiedUrlPatterns: [/^https:\/\/talent-holding\.alibaba\.com\/off-campus\/position-detail\?(?=[^#]*\bpositionId=\d+)/i],
      notes: '阿里集团官方社招两页公开详情校准；CSS 模块类名可能随部署变化。旧域名、校招、登录及投递未验证。'
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
      version: '1.0.0-verified-jobs-detail',
      channel: '牛客',
      hosts: ['www.nowcoder.com', 'nowcoder.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i, /\/detail\//i],
      listUrlPatterns: [/\/job\/center/i, /\/search/i],
      selectors: {
        title: ['.job-detail-wrap h1.title'],
        company: ['.job-detail-right-wrap .company-card > .fs-20'],
        jd: ['.job-detail-infos > .pre-line'],
        location: ['.job-detail-wrap .info .extra > .el-tooltip'],
        success: ['[class*="success"]', '[class*="message"]']
      },
      statusPage: {
        urlPatterns: [/\/my\/apply/i, /\/apply\/record/i, /\/deliver/i],
        rowSelector: '[class*="item"], table tbody tr',
        titleSelector: '[class*="job"], [class*="title"], td:nth-child(1)',
        statusSelector: '[class*="status"], [class*="state"], td:nth-child(3)',
        linkSelector: 'a[href]'
      },
      refine: function nowcoderRefine(job) {
        job.location = String(document.querySelector('.job-detail-wrap .info .extra > .el-tooltip')?.innerText || '').trim();
        // A graduation requirement is not an explicit recruitment batch.
        // Preserve the visible title; do not infer city from the company card.
        return job;
      },
      site_verified: true,
      verified_at: '2026-10-23',
      verified_paths: ['/jobs/detail/{id}'],
      verifiedUrlPatterns: [/^https:\/\/(?:www\.)?nowcoder\.com\/jobs\/detail\/\d+\/?(?:[?#]|$)/i],
      notes: '公开详情 453952、457913 已核验；只取公司卡片名称节点，排除行业/融资/岗位数。城市来自岗位信息，不取公司所在地。登录、投递与旧失效详情 470178 未验收。'
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

  // Current public navigation sampled 2026-10-25. A list API supplies identity
  // only: tracker still requires a unique match against an actually visible card.
  const readText = selector => String(document.querySelector(selector)?.innerText || '').trim();
  const pageNumber = () => Number(readText('.ant-pagination-item-active,.rocket-pagination-item-active,.el-pager .is-active')) || 1;
  async function publicPost(url, body) {
    const response = await fetch(url, {method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    return response.ok ? response.json() : null;
  }
  const xiaomi=ADAPTERS.find(a=>a.key==='xiaomi');
  xiaomi.hosts.push('xiaomi.jobs.f.mioffice.cn');
  HOST_COMPANY['xiaomi.jobs.f.mioffice.cn']='小米';
  xiaomi.listUrlPatterns.push(/\/website\/opportunities\.html/i);
  xiaomi.listTitleSelector='a.job-title';xiaomi.listLocationSelector='.job-tags';
  xiaomi.selectors.title.push('.job-header .job-title');xiaomi.selectors.jd.push('.block-content');
  xiaomi.verifiedUrlPatterns.push(/^https:\/\/xiaomi\.jobs\.f\.mioffice\.cn\/index\/position\/\d+\/detail/);
  const oldXiaomiRefine=xiaomi.refine;
  xiaomi.refine=job=>location.hostname==='xiaomi.jobs.f.mioffice.cn'?{...job,location:readText('.job-info > span:first-child')}:oldXiaomiRefine(job);
  xiaomi.version='1.1.0-current-mioffice';

  const netease=ADAPTERS.find(a=>a.key==='netease');
  netease.listUrlPatterns.push(/\/job-list\.html/);netease.listCardSelector='.posi-list-card';netease.listTitleSelector='.f-title';netease.listLocationSelector='.name > .tag[title]';
  netease.listIdentities=async()=>{
    if(location.pathname!=='/job-list.html')return [];
    const data=await publicPost('/api/hr163/position/queryPage',{currentPage:pageNumber(),pageSize:10});
    return (data?.data?.list||[]).map(p=>({title:p.name,location:p.workPlaceNameList.join('、'),url:`${location.origin}/job-detail.html?id=${p.id}&lang=zh`}));
  };
  const meituan=ADAPTERS.find(a=>a.key==='meituan');
  meituan.listUrlPatterns.push(/\/web\/social(?:[?#]|$)/);meituan.listCardSelector='.position_list_item[data-jobunionid]';meituan.listTitleSelector='.postion_name .title';meituan.listLocationSelector='.city';
  meituan.listIdentity=card=>({id:card.dataset.jobunionid,url:`${location.origin}/web/position/detail?jobUnionId=${card.dataset.jobunionid}&highlightType=social`});
  meituan.jdExcludeHeaders=['部门介绍'];
  const shixiseng=ADAPTERS.find(a=>a.key==='shixiseng');
  shixiseng.listUrlPatterns.push(/^https:\/\/(?:www\.)?shixiseng\.com\/?(?:[?#]|$)/);
  shixiseng.listCardSelector='.intern-content-href[point-id^="inn_"]';
  shixiseng.listTitleSelector='.job-title .title';
  shixiseng.listLocationSelector='.job-detail-style > .content:first-child';
  shixiseng.listIdentity=card=>({url:`${location.origin}/intern/${card.getAttribute('point-id')}`});

  ADAPTERS.push({
    ...GENERIC,key:'oppo',label:'OPPO 招聘',company_name:'OPPO',hosts:['career.oppo.com','careers.oppo.com'],version:'1.0.0-current-post',priority:2,channel:'企业官网',
    jobUrlPatterns:[/\/recruitment\/post\/\d+/],listUrlPatterns:[/\/recruitment\/post(?:\?|$)/],
    listCardSelector:'.job__item',listTitleSelector:'.job_code',listLocationSelector:'.city_name',
    selectors:{...GENERIC.selectors,title:['.job_duty_wrap .job_code'],company:[],jd:['.job_duty_wrap .duty_desc']},
    refine:job=>({...job,location:readText('.job_duty_wrap .city_name')}),
    site_verified:true,verified_at:'2026-10-25',verifiedUrlPatterns:[/^https:\/\/career\.oppo\.com\/official\/oppo\/recruitment\/post\/\d+/],
    async lookupIdentity(title){
      const type=new URL(location.href).searchParams.get('recruitType')||'SOCIAL-RECRUITMENT';
      const data=await publicPost('/ats-candidate-api/open-api/position/queryPositionList',{pageNum:1,pageSize:10,publishName:title,workCityCodeList:[],jobTypeList:[],recruitTypeList:[type],shareId:''});
      return (data?.data?.list||[]).map(p=>({title:p.publishName,location:p.workCityName,url:`${location.origin}/official/oppo/recruitment/post/${p.positionId}?recruitType=${encodeURIComponent(type)}`}));
    },
    async listIdentities(){
      if(!/^\/official\/oppo\/recruitment\/post$/.test(location.pathname))return [];
      const type=new URL(location.href).searchParams.get('recruitType')||'SOCIAL-RECRUITMENT';
      const data=await publicPost('/ats-candidate-api/open-api/position/queryPositionList',{pageNum:pageNumber(),pageSize:10,publishName:'',workCityCodeList:[],jobTypeList:[],recruitTypeList:[type],shareId:''});
      return (data?.data?.list||[]).map(p=>({title:p.publishName,location:p.workCityName,url:`${location.origin}/official/oppo/recruitment/post/${p.positionId}?recruitType=${encodeURIComponent(type)}`}));
    }
  },{
    ...GENERIC,key:'kuaishou',label:'快手招聘',company_name:'快手',hosts:['zhaopin.kuaishou.cn'],version:'1.0.0-current-social',priority:2,channel:'企业官网',
    jobUrlPatterns:[/\/job-info\/\d+/],listUrlPatterns:[/#\/official\/social\/(?:\?|$)/],
    listCardSelector:'.ant-table-tbody > tr',listTitleSelector:'td:first-child',listLocationSelector:'td:nth-child(3)',
    selectors:{...GENERIC.selectors,title:['.job-info-header-title-name'],company:[],jd:['.job-info-des-item-value']},
    refine:job=>({...job,location:[...document.querySelectorAll('.job-info-labels-item')].find(n=>n.querySelector('.job-info-labels-item-name')?.innerText==='工作地点：')?.querySelector('.job-info-labels-item-value')?.innerText.trim()}),
    site_verified:true,verified_at:'2026-10-25',verifiedUrlPatterns:[/^https:\/\/zhaopin\.kuaishou\.cn\/#\/official\/social\/job-info\/\d+/],
    async listIdentities(){
      if(!/^#\/official\/social\/(?:\?|$)/.test(location.hash))return [];
      return chrome.runtime.sendMessage({type:'read_visible_kuaishou_cards'});
    },
    listIdentitySource:'visible_card_component'
  },{
    ...GENERIC,key:'pinduoduo',label:'拼多多招聘',company_name:'拼多多',hosts:['careers.pddglobalhr.com','careers.pinduoduo.com'],version:'1.0.0-current-campus',priority:2,channel:'企业官网',
    jobUrlPatterns:[/\/campus\/(?:grad|intern)\/detail/],listUrlPatterns:[/\/campus\/(?:grad|intern)\/?(?:\?|$)/],
    listBatchSelector:'[class*="index_container"] > span:nth-child(4) [class*="index_text__"]',
    listCardSelector:'[class*="recruit-card_card"]',listTitleSelector:'[class*="recruit-card_title"] > span',listLocationSelector:'[class*="index_container"] > span:nth-child(3) [class*="index_text__"]',
    selectors:{...GENERIC.selectors,title:['[class*="job-detail-title__"]'],company:[],jd:['[class*="job-detail-item-desc__"]']},
    refine:job=>{const values=[...document.querySelectorAll('[class*="page-job-detail"] [class*="index_container"] [class*="index_text__"]')].map(n=>n.innerText.trim());return {...job,location:values[1],recruitment_batch:values.find(t=>/^20\d{2}届$/.test(t))||''};},
    site_verified:true,verified_at:'2026-10-25',verifiedUrlPatterns:[/^https:\/\/careers\.pddglobalhr\.com\/campus\/(?:grad|intern)\/detail\?positionId=/],
    async listIdentities(){
      if(!/^\/campus\/grad\/?$/.test(location.pathname))return [];
      const data=await publicPost('/api/careers/api/recruit/position/list',{page:pageNumber(),pageSize:10,t:null});
      return (data?.result?.list||[]).map(p=>({title:p.name,location:p.workLocationName,url:`${location.origin}/campus/grad/detail?positionId=${p.id}`}));
    }
  },{
    ...GENERIC,key:'mihoyo',label:'米哈游招聘',company_name:'米哈游',hosts:['jobs.mihoyo.com'],version:'1.0.0-current-position',priority:2,channel:'企业官网',
    jobUrlPatterns:[/#\/position\/\d+/],listUrlPatterns:[/#\/position\/?(?:\?|$)/],
    listCardSelector:'[class*="jobItem___"]',listTitleSelector:'[class*="jobName___"]',listLocationSelector:'[class*="subTitle___"] > span:first-child',
    selectors:{...GENERIC.selectors,title:['[class*="detailHeader___"] [class*="jobTitle___"]'],company:[],jd:['[class*="describeBlock___"] [class*="blockContent___"]']},
    refine:job=>({...job,location:readText('[class*="detailHeader___"] [class*="subTitle___"] > span:first-child')}),
    site_verified:true,verified_at:'2026-10-25',verifiedUrlPatterns:[/^https:\/\/jobs\.mihoyo\.com\/#\/position\/\d+/],
    async listIdentities(){
      if(!/^#\/position\/?(?:\?|$)/.test(location.hash))return [];
      const data=await publicPost('https://ats.openout.mihoyo.com/ats-portal/v1/job/list',{pageNo:pageNumber(),pageSize:10,channelDetailIds:[1],hireType:0});
      return (data?.data?.list||[]).map(p=>({title:p.title,location:p.addressDetailList.map(a=>a.addressDetail).join('、'),url:`${location.origin}/#/position/${p.id}`}));
    }
  });
  HOST_COMPANY['career.oppo.com']='OPPO';

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

  // Explicit recruitment entries from the 130-company source CSV. An entry is
  // eligible for authorization; detail support is verified separately.
  const RECRUITMENT_DIRECTORY = [
    [1, "字节跳动", "https://jobs.bytedance.com/campus", "bytedance", "https://jobs.bytedance.com/experienced", "https://jobs.bytedance.com/campus/position/7699119731313821957/detail"],
    [2, "腾讯", "https://join.qq.com/", "tencent", "https://careers.tencent.com/", "https://join.qq.com/post_detail.html?postid=1283126456553382912"],
    [3, "阿里巴巴", "https://campus-talent.alibaba.com/campus/index", "alibaba", "https://talent-holding.alibaba.com/off-campus", "https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100004023017"],
    [4, "京东", "https://campus.jd.com/home", "jd", "https://zhaopin.jd.com/", "https://zhaopin.jd.com/web/job-info-detail?requementId=227263"],
    [5, "百度", "https://talent.baidu.com/jobs/campus", "baidu", "https://talent.baidu.com/jobs/social"],
    [6, "美团", "https://zhaopin.meituan.com/web/campus", "meituan", "https://zhaopin.meituan.com/web/social", "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4798450784&highlightType=social"],
    [7, "拼多多", "https://careers.pddglobalhr.com/campus", "pinduoduo", "https://careers.pddglobalhr.com/", "https://careers.pddglobalhr.com/campus/grad/detail?positionId=43b706c2-9d86-47de-a99d-fcd35405799f"],
    [8, "小米", "https://hr.xiaomi.com/campus", "xiaomi", "https://hr.xiaomi.com/social", "https://xiaomi.jobs.f.mioffice.cn/index/position/7342833451802542188/detail"],
    [9, "米哈游", "https://campus.mihoyo.com/", "mihoyo", "https://jobs.mihoyo.com/", "https://jobs.mihoyo.com/#/position/6352"],
    [10, "网易", "https://campus.163.com/", null, "https://hr.163.com/"],
    [11, "SHEIN", "https://careers.shein.cn/Students-&-Graduates", null, "https://careers.shein.cn/Professionals"],
    [12, "华为", "https://career.huawei.com/reccampportal/", null, "https://career.huawei.com/"],
    [13, "哔哩哔哩", "https://jobs.bilibili.com/campus", null, "https://jobs.bilibili.com/social"],
    [14, "富途", "https://join.futunn.com/", null],
    [15, "小红书", "https://job.xiaohongshu.com/campus", null, "https://job.xiaohongshu.com/social", "https://job.xiaohongshu.com/campus/position/22013"],
    [16, "得物", "https://campus.dewu.com/", null, "https://careers.dewu.com/"],
    [17, "微博", "https://app.mokahr.com/campus-recruitment/sina/43536#/jobs", null, "https://app.mokahr.com/social-recruitment/sina/43535#/jobs", "https://app.mokahr.com/campus-recruitment/sina/43536#/job/5f97c970-b3cf-4805-a3d4-33dc14404854"],
    [18, "快手", "https://campus.kuaishou.cn/", "kuaishou", "https://zhaopin.kuaishou.cn/"],
    [19, "携程", "https://careers.ctrip.com/", null, "https://job.ctrip.com/"],
    [20, "滴滴", "https://talent.didiglobal.com/campus", null, "https://talent.didiglobal.com/social/"],
    [21, "百融云创", "https://www.brgroup.com/", null],
    [22, "网易游戏雷火", "https://leihuo.163.com/campus/", null, "https://hr.163.com/"],
    [23, "网易游戏（互娱）", "https://campus.game.163.com/", null, "https://hr.game.163.com/", "https://hr.163.com/job-detail.html?id=67248"],
    [24, "阿里云", "https://careers.aliyun.com/campus/home", null, "https://careers.aliyun.com/"],
    [25, "Amazon中国", "https://www.amazon.jobs/en/", null, "https://www.amazon.jobs/en/jobs/10594132"],
    [26, "Google中国", "https://www.google.com/about/careers/applications/jobs/results/", null, "https://www.google.com/about/careers/applications/jobs/results/123881012009542342-account-manager-retail-large-customer-sales-english-mandarin"],
    [27, "微软中国", "https://careers.microsoft.com/v2/global/en/students", null, "https://jobs.careers.microsoft.com/global/en/search", "https://apply.careers.microsoft.com/careers/job/1970393557074390?hl=en"],
    [28, "苹果中国", "https://jobs.apple.com/zh-cn/search", null],
    [29, "OPPO", "https://career.oppo.com/campus", "oppo", "https://career.oppo.com/", "https://career.oppo.com/official/oppo/recruitment/post/1563444621030670338?recruitType=SOCIAL-RECRUITMENT"],
    [30, "ZURU", "https://www.zururecruit.cn/", null],
    [31, "vivo", "https://hr-campus.vivo.com/", null, "https://hr.vivo.com/"],
    [32, "京东方", "https://boe.zhiye.com/campus", null, "https://boe.zhiye.com/"],
    [33, "传音控股", "https://transsion.zhiye.com/", null],
    [34, "商汤科技", "https://hr.sensetime.com/", null],
    [35, "影石Insta360", "https://www.insta360.com/cn/jobs", null],
    [36, "科大讯飞", "https://iflytek.zhiye.com/campus/jobs", null, "https://iflytek.zhiye.com/jobs"],
    [37, "荣耀", "https://career.honor.com/", null],
    [38, "货拉拉", "https://join.huolala.cn/", null, "https://huolala.zhiye.com/"],
    [39, "韶音科技", "https://campus.shokz.com.cn/", null, "https://hr.shokz.com.cn/"],
    [40, "中信银行", "https://job.citicbank.com/", null],
    [41, "兴业银行", "https://job.cib.com.cn/portal/", null],
    [42, "平安银行", "https://campus.pingan.com/pab/freshgraduates", null, "https://talent.pingan.com/recruit/social.html", "https://talent.pingan.com/recruit/position.html?positionId=1C7232146A0D4604B2C528ED2DA0859C"],
    [43, "招商银行", "https://career.cmbchina.com/", null],
    [44, "浦发银行", "https://job.spdb.com.cn/", null],
    [45, "中国银行", "https://www.boc.cn/aboutboc/bi4/", null, "https://chrcmp.chinahr.com/pages/boc-social/"],
    [46, "交通银行", "https://job.bankcomm.com/", null],
    [47, "农业银行", "https://career.abchina.com.cn/", null],
    [48, "宁波银行", "https://zhaopin.nbcb.com.cn/", null],
    [49, "工商银行", "https://job.icbc.com.cn/", null],
    [50, "广东华兴银行", "https://ghbank.zhiye.com/", null],
    [51, "建设银行", "https://job.ccb.com/", null],
    [52, "招商永隆银行（香港）", "https://www.cmbwinglungbank.com/wlb_corporate/cn/about-us/careers/index.html", null, "https://www.cmbwinglungbank.com/wlb_corporate/cn/about-us/careers/job-openings/index.html"],
    [53, "邮储银行", "https://psbc2027.zhaopin.com/", null, "https://www.psbc.com/cn/careers/"],
    [54, "东方证券", "https://www.dfzq.com.cn/osoa/views/main/companyinfodisclosure/companyrecruitment/index.shtml", null],
    [55, "中信期货", "https://citicsfzp.zhiye.com/", null],
    [56, "中信证券", "https://careers.citics.com/", null],
    [57, "中国银河", "https://chinastock.zhiye.com/", null],
    [58, "中金公司", "https://cicc.zhiye.com/", null],
    [59, "兴业证券", "https://xyzq.hotjob.cn/", null],
    [60, "华泰证券", "https://wecruit.hotjob.cn/SU6419745cbef57c635fe10142/pb/index.html", null, "https://wecruit.hotjob.cn/SU6013d14e5d83dc11e4a8ae4d/pb/index.html"],
    [61, "国信证券", "https://guosen.zhiye.com/", null],
    [62, "国泰海通", "https://www.gtht.com/", null],
    [63, "国盛证券", "https://gszq.hotjob.cn/", null],
    [64, "国金证券", "https://gjzq.zhiye.com/jobs", null],
    [65, "天风证券", "https://www.tfzq.com/job/campus.html", null, "https://www.tfzq.com/hr/hr.html", "https://www.tfzq.com/job/7671807013751357698.html"],
    [66, "平安证券", "https://campus.pingan.com/securities", null, "https://talent.pingan.com/recruit/social.html", "https://talent.pingan.com/recruit/position.html?positionId=AD71B2972A204F30B0CD1908D233A04D"],
    [67, "广发证券", "https://job.gf.com.cn/", null],
    [68, "招商证券", "https://wecruit.hotjob.cn/SU629dbc260dcad452299bc0fa/mc/index", null],
    [69, "民生证券", "https://mszq.hotjob.cn/", null],
    [70, "申万宏源", "https://www.swhysc.com/", null],
    [71, "西南证券", "https://wecruit.hotjob.cn/SU61d3efeabef57c13bcba2eea/pb/social.html", null],
    [72, "里昂证券", "https://www.clsa.com/careers/", null],
    [73, "长城证券", "https://cgws1.zhiye.com/", null],
    [74, "长江证券", "https://cjzq.zhiye.com/", null],
    [75, "中国人保", "https://picc.zhiye.com/", null],
    [76, "中国人寿", "https://chinalife.zhiye.com/", null],
    [77, "中国太保", "https://www.cpic.com.cn/aboutUs/rlzy/ygzp/", null],
    [78, "中国平安", "https://talent.pingan.com/recruit/index.html", null, "https://talent.pingan.com/recruit/social.html", "https://talent.pingan.com/recruit/position.html?positionId=C1F27CDDF37243ABA237C8387DA26443"],
    [79, "众安在线", "https://www.zhongan.com/", null],
    [80, "新华保险", "https://nci.zhiye.com/", null],
    [81, "泰康保险", "https://jobtaikang.zhiye.com/", null],
    [82, "华夏基金", "https://chinaamc.zhiye.com/", null],
    [83, "南方基金", "https://southernfund.hotjob.cn/", null],
    [84, "博时基金", "https://bosera.hotjob.cn/", null],
    [85, "嘉实基金", "https://www.jsfund.cn/", null],
    [86, "大成基金", "https://www.dcfund.com.cn/", null],
    [87, "天弘基金", "https://www.thfund.com.cn/", null],
    [88, "广发基金", "https://gffunds.jobs.feishu.cn/", null],
    [89, "招商基金", "https://cmfchina.zhiye.com/", null],
    [90, "易方达基金", "https://efunds.hotjob.cn/", null],
    [91, "景顺长城基金", "https://invescogreatwall.zhiye.com/", null],
    [92, "永赢基金", "https://maxwealthfund.hotjob.cn/", null],
    [93, "汇添富基金", "https://htffund.zhiye.com/", null],
    [94, "长城基金", "https://greatwallfund.zhiye.com/", null],
    [95, "鹏华基金", "https://job.phfund.com.cn/", null],
    [96, "蚂蚁集团", "https://talent.antgroup.com/", null],
    [97, "京东科技", "https://zhaopin.jd.com/", null],
    [98, "同花顺", "https://campus.10jqka.com.cn/job/list?type=school", null, "https://job.10jqka.com.cn/"],
    [99, "奇富科技", "https://app.mokahr.com/campus_apply/360jinrong/26697#/", null, "https://app.mokahr.com/apply/360jinrong#/"],
    [100, "平安科技", "https://talent.pingan.com/recruit/campus.html", null, "https://talent.pingan.com/recruit/social.html"],
    [101, "度小满", "https://campus.duxiaoman.com/", null, "https://talent.duxiaoman.com/"],
    [102, "微众银行", "https://campus.webank.com/", null, "https://hr.webank.com/"],
    [103, "陆金所", "https://talent.pingan.com/recruit/index.html", null],
    [104, "UBS", "https://www.ubs.com/global/en/careers.html", null],
    [105, "摩根士丹利", "https://www.morganstanleysecurities.com.cn/", null],
    [106, "摩根大通", "https://www.jpmorganchase.com/careers", null, "https://careers.jpmorgan.com/"],
    [107, "汇丰", "https://www.about.hsbc.com.cn/careers", null, "https://portal.careers.hsbc.com/"],
    [108, "花旗", "https://jobs.citi.com/", null],
    [109, "高盛", "https://www.goldmansachs.com/careers", null],
    [111, "国信资本", "https://www.guosen.com.cn/", null],
    [112, "国金资管", "https://gjzq.zhiye.com/jobs", null],
    [113, "泰康资产", "https://www.taikangasset.cn/", null, "https://jobtaikang.zhiye.com/"],
    [114, "红杉中国", "https://www.hongshan.com/", null, "https://hongshan.jobs.feishu.cn/"],
    [115, "财通资管", "https://www.ctzg.com/", null],
    [117, "埃森哲", "https://www.accenture.cn/cn-zh/careers", null, "https://www.accenture.com/cn-zh/careers/jobdetails?id=R00002228_zh-cn&title=Presales%2FImplementation+Expert"],
    [118, "安永", "https://careers.ey.com.cn/", null, "https://careers.ey.com.cn/campus-recruitment/ey/166374?locale=zh-CN/#/job/3f07f2cc-f41e-4a61-9203-7ff249953423"],
    [119, "德勤", "https://www.deloitte.com/cn/zh/cn-careers.html", null, "https://wecruit.hotjob.cn/SU64365a780dcad43c5ae82bab/pb/index.html"],
    [120, "欧莱雅", "https://www.lorealchina.com/", null],
    [121, "毕马威", "https://kpmg.com/cn/zh/home/careers.html", null],
    [122, "海天味业", "https://haitian.zhiye.com/campus", null, "https://haitian.zhiye.com/"],
    [123, "玛氏", "https://careers.mars.com/global/en", null, "https://careers.mars.com/global/en/job/R151971/Programa-Jovem-Aprendiz"],
    [124, "顺丰", "https://campus.sf-express.com/", null, "https://hr.sf-express.com/"],
    [125, "迈瑞", "https://mindray.zhiye.com/campus", null, "https://mindray.zhiye.com/"],
  ].map(([id, company, entryUrl, adapterKey, ...linkedUrls]) => ({id, company, entryUrl, adapterKey, linkedUrls}));

  const directoryPagesByHost = new Map();
  const directoryCompaniesByHost = new Map();
  for (const row of RECRUITMENT_DIRECTORY) {
    for (const entry of [row.entryUrl, ...row.linkedUrls]) {
      const url = new URL(entry);
      const pages = directoryPagesByHost.get(url.hostname) || [];
      pages.push(url);
      directoryPagesByHost.set(url.hostname, pages);
      const companies = directoryCompaniesByHost.get(url.hostname) || new Set();
      companies.add(row.company);
      directoryCompaniesByHost.set(url.hostname, companies);
    }
  }

  // Corporate sites often serve account or product pages on the same host.
  // Chrome grants by host, but the tracker only inspects recruitment paths.
  function outsideRecruitmentDirectory(rawUrl) {
    const url = new URL(rawUrl);
    if (resolveAdapter(url.hostname) !== GENERIC) return false;
    const entries = directoryPagesByHost.get(url.hostname) || [];
    if (!entries.length || entries.some(entry => entry.pathname === '/')) return false;
    if (url.pathname === '/' && entries.some(entry => entry.hash.startsWith('#/'))) return false;
    if (/(?:^|\/)(?:careers?|jobs?|recruits?|recruitment|campus|talent|cn-careers|jobdetails)(?:[/.\-]|$)/i.test(url.pathname)) return false;
    return !entries.some(entry => {
      const prefix = entry.pathname.replace(/\/$/, '');
      return url.pathname === prefix || url.pathname.startsWith(prefix + '/');
    });
  }

  function directoryEmployer(rawUrl) {
    const host = new URL(rawUrl).hostname;
    const companies = directoryCompaniesByHost.get(host);
    return companies?.size === 1 && !outsideRecruitmentDirectory(rawUrl) ? companies.values().next().value : '';
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
    RECRUITMENT_DIRECTORY,
    outsideRecruitmentDirectory,
    directoryEmployer,
    resolveAdapter,
    supportedHosts,
    whitelist,
    companyForHost,
    statusTextToCanonical,
    SOURCE_NOTE: 'adapter rules are drafts until per-site real-session verification (G04)'
  };
})();
