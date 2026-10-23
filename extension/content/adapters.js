/*
 * Site adapter registry (classic script; used by content scripts and popup).
 *
 * D02 已冻结（2026-10-22）：优先支持白名单 =
 *   腾讯 / 字节跳动 / 阿里巴巴 / 美团 / 京东 / 小米 / 百度 / 网易（priority: 1）。
 * BOSS直聘/牛客/实习僧 为扩展期草案（priority: 2），待「全招聘站点」迭代再验证启用。
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
    version: '1.1.0-universal',
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
    notes: '通用识别链：结构化数据(JSON-LD/data-tounar) → URL 线索 + 投递按钮信号 → og:title/h1/标题 → meta/og 公司名 → 主机映射。不猜测任意页面正文。'
  };

  // 已知招聘官网域名 → 公司名（通用识别的公司字段兜底；聚合平台返回 null，不猜）
  const HOST_COMPANY = {
    'join.qq.com': '腾讯', 'careers.tencent.com': '腾讯', 'hr.tencent.com': '腾讯',
    'jobs.bytedance.com': '字节跳动', 'job.bytedance.com': '字节跳动',
    'talent.alibaba.com': '阿里巴巴', 'campus.alibaba.com': '阿里巴巴', 'campus-talent.alibaba.com': '阿里巴巴',
    'campus.meituan.com': '美团', 'zhaopin.meituan.com': '美团', 'hr.meituan.com': '美团',
    'campus.jd.com': '京东', 'zhaopin.jd.com': '京东',
    'campus.xiaomi.com': '小米', 'hr.xiaomi.com': '小米',
    'talent.baidu.com': '百度',
    'campus.163.com': '网易', 'hr.163.com': '网易',
    'www.zhipin.com': null, 'zhipin.com': null,
    'www.nowcoder.com': null, 'nowcoder.com': null,
    'www.shixiseng.com': null, 'shixiseng.com': null
  };

  function textOfFirst(selector) {
    try {
      const node = document.querySelector(selector);
      return node ? String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim() : '';
    } catch {
      return '';
    }
  }

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
      priority: 1,
      label: '腾讯招聘',
      version: '0.2.0-draft',
      channel: '企业官网',
      company: '腾讯',
      hosts: ['join.qq.com', 'careers.tencent.com', 'hr.tencent.com'],
      jobUrlPatterns: [/post_detail\.html/i, /post\.html\?.*postid=/i, /\/position\//i, /\/job\//i, /jobdesc/i],
      listUrlPatterns: [/\/post\.html\/?(\?|$)/i, /\/position\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.detailBanner .bannerItemText', '.job-title', '.position-title', 'h1[class*="title"]'],
        company: ['.company-name'],
        jd: ['.post_detail .detail_text', '.detail_text', '.job-desc', '.position-desc'],
        location: ['.job-location', '.position-address', '.detailBanner .site'],
        info: ['.detailBanner'],
        success: ['.apply-success', '.submit-success', '[class*="applyResult"]']
      },
      refine: function tencentRefine(job) {
        const banner = textOfFirst('.detailBanner');
        const batch = banner.match(/(20\d{2})\s*届?\s*(校园招聘|校招|应届毕业生)/);
        if (batch) job.recruitment_batch = `${batch[1]} ${/校园招聘|校招/.test(batch[2]) ? '校园招聘' : '应届生'}`;
        return job;
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
      priority: 1,
      label: '字节跳动招聘',
      version: '1.1.0-verified-campus',
      channel: '企业官网',
      company: '字节跳动',
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
      priority: 1,
      label: '阿里巴巴校园招聘',
      version: '1.0.0-verified-campus',
      channel: '企业官网',
      company: '阿里巴巴',
      hosts: ['talent.alibaba.com', 'campus.alibaba.com', 'campus-talent.alibaba.com'],
      jobUrlPatterns: [/\/campus\/position\/\d+/i, /\/position\/\d+/i, /jobDetail/i],
      listUrlPatterns: [/\/campus\/position\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['div[class*="CampusPositionDetail--name--"]', '[class*="PositionDetail--name"]', 'h1'],
        company: ['.company-name'],
        jd: ['[class*="CampusPositionDetail--bodyContent"] [class*="CampusPositionDetail--content--"]', '[class*="CampusPositionDetail--bodyContent"]', '[class*="CampusPositionDetail--jobDescription"]', '[class*="jobDescription"]'],
        location: ['[class*="CampusPositionDetail--basicInfo"]', '[class*="basicInfo"]'],
        info: ['[class*="CampusPositionDetail--basicInfo"]', '[class*="basicInfo"]'],
        success: ['[class*="success"]', '[class*="message"]']
      },
      refine: function alibabaRefine(job) {
        job.company_name = '阿里巴巴';
        const info = textOfFirst('[class*="CampusPositionDetail--basicInfo"]') || '';
        const loc = info.replace(/^.*?更新于\s*[\d-]+\s*/, '').split(/\s+(?:分享职位|加入意向单|基础信息)/)[0].trim();
        if (loc && /\//.test(loc)) job.location = loc;
        const batch = info.match(/(20\d{2})\s*届\s*([^\s]{1,10})/);
        if (batch) job.recruitment_batch = `${batch[1]}届${batch[2].replace(/^(校园招聘|校招).*/, '应届生')}`;
        /* 详情页有多个 bodyContent：第一个是「基础信息」，第二个才是「职位描述」。
           只选正文含「职位描述」的那块，避免把毕业时间/笔试方向当成 JD。 */
        const descriptionBlock = Array.from(document.querySelectorAll('[class*="CampusPositionDetail--bodyContent"]'))
          .find((node) => /职位描述/.test(String(node.innerText || node.textContent || '').slice(0, 80)));
        const descriptionText = descriptionBlock
          ? String(descriptionBlock.innerText || descriptionBlock.textContent || '').replace(/\s+/g, ' ').trim().replace(/^职位描述\s*/, '')
          : '';
        if (descriptionText) {
          job.jd_summary = descriptionText;
          job.field_confidence = { ...(job.field_confidence || {}), jd_summary: 0.92 };
        }
        job.field_confidence = { ...(job.field_confidence || {}), company_name: 0.96 };
        if (job.location) job.field_confidence.location = 0.9;
        if (job.recruitment_batch) job.field_confidence.recruitment_batch = 0.86;
        return job;
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
      priority: 1,
      label: '美团招聘',
      version: '0.2.0-draft',
      channel: '企业官网',
      company: '美团',
      hosts: ['campus.meituan.com', 'zhaopin.meituan.com', 'hr.meituan.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.position_detail_sticky .title', '.positin_detail_wrapper_t .title', '[class*="job-title"]', '.title', 'h1'],
        company: ['[class*="company"]'],
        jd: ['.positin_detail_wrapper_b', '.positin_detail_info', '[class*="job-desc"]'],
        location: ['.position_detail_sticky', '.positin_detail_wrapper_t', '[class*="location"]'],
        info: ['.position_detail_sticky', '.positin_detail_wrapper_t'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      refine: function meituanRefine(job) {
        const info = textOfFirst('.position_detail_sticky') || textOfFirst('.positin_detail_wrapper_t');
        const loc = info.match(/工作地点[:：]\s*([^\s]+(?:、[^\s]+)*)/);
        if (loc) { job.location = loc[1]; job.field_confidence.location = 0.9; }
        if (/校园招聘/.test(info)) { job.recruitment_batch = '校园招聘'; job.field_confidence.recruitment_batch = 0.8; }
        return job;
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
      priority: 1,
      label: '京东招聘',
      version: '0.2.0-draft',
      channel: '企业官网',
      company: '京东',
      hosts: ['campus.jd.com', 'zhaopin.jd.com'],
      jobUrlPatterns: [/details\?id=/i, /\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['[class*="positionTop"] p:first-child span', '[class*="job-title"]', '.title', 'h1'],
        company: ['[class*="company"]'],
        jd: ['[class*="contentBox"]', '[class*="job-desc"]', '[class*="detail"]'],
        location: ['[class*="itemContent"]', '[class*="location"]'],
        info: ['[class*="positionTop"]'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      refine: function jdRefine(job) {
        if (job.location) {
          job.location = job.location.split('/')[0].trim();
          job.field_confidence.location = 0.88;
        }
        return job;
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
      priority: 1,
      label: '小米招聘',
      version: '0.2.0-draft',
      channel: '企业官网',
      company: '小米',
      hosts: ['campus.xiaomi.com', 'hr.xiaomi.com', 'xiaomi.jobs.f.mioffice.cn'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['.job-title', '.job-header .job-title', '[class*="job-title"]', 'h1'],
        company: ['[class*="company"]'],
        jd: ['.block-content', '[class*="job-desc"]', '[class*="detail"]'],
        location: ['.job-info', '[class*="location"]'],
        info: ['.job-info'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      refine: function xiaomiRefine(job) {
        const info = textOfFirst('.job-info');
        const loc = info.match(/^([^\s]+?)(?:校招|社招|正式|实习)/);
        if (loc) { job.location = loc[1]; job.field_confidence.location = 0.86; }
        return job;
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
      priority: 1,
      label: '百度招聘',
      version: '0.2.0-draft',
      channel: '企业官网',
      company: '百度',
      hosts: ['talent.baidu.com'],
      jobUrlPatterns: [/\/jobs\/detail\//i, /\/job\//i, /\/position\//i, /detail/i],
      listUrlPatterns: [/\/jobs\/(?:list|social-list)/i, /\/job\/?(\?|$)/i, /\/search/i],
      selectors: {
        title: ['[class*="detail-title"] span', '[class*="detail-title"]', '[class*="job-title"]', 'h1'],
        company: ['[class*="company"]'],
        jd: ['[class*="post-content-desc"]', '[class*="job-desc"]'],
        location: ['[class*="post-subtitle-item"]', '[class*="location"]'],
        info: ['[class*="post-subtitle"]'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      refine: function baiduRefine(job) {
        const info = textOfFirst('[class*="post-subtitle__"]') || textOfFirst('[class*="post-subtitle"]');
        const city = info.match(/(北京|上海|广州|深圳|杭州|南京|苏州|成都|武汉|西安|长沙|天津|重庆|合肥|厦门|福州|济南|青岛|郑州|大连|珠海|东莞|佛山|宁波|无锡|香港)(?:市)?/);
        if (city) { job.location = city[1]; job.field_confidence.location = 0.88; }
        return job;
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
      priority: 1,
      label: '网易招聘',
      version: '0.2.0-draft',
      channel: '企业官网',
      company: '网易',
      hosts: ['campus.163.com', 'hr.163.com'],
      jobUrlPatterns: [/\/job\//i, /\/position\//i, /job-detail/i],
      listUrlPatterns: [/\/job\/?(\?|$)/i, /job-list/i, /\/search/i],
      selectors: {
        title: ['.job-detail-header-c .posi-name .f-toe', '.posi-name .f-toe', '.f-title .f-toe', '.f-title', 'h1'],
        company: ['[class*="company"]'],
        jd: ['.job-de-de-left .content', '.content-more-left', '[class*="job-desc"]'],
        location: ['.posi-sc-name', '.tag[title]', '[class*="location"]'],
        info: ['.posi-sc-name'],
        success: ['[class*="success"]', '[class*="result"]']
      },
      refine: function neteaseRefine(job) {
        const info = textOfFirst('.posi-sc-name');
        const city = info.match(/(北京|上海|广州|深圳|杭州|南京|苏州|成都|武汉|西安|长沙|天津|重庆|合肥|厦门|福州|济南|青岛|郑州|大连|珠海|东莞|佛山|宁波|无锡|香港)/);
        if (city) { job.location = city[1]; job.field_confidence.location = 0.86; }
        return job;
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
      priority: 2,
      label: 'BOSS直聘（仅岗位详情）',
      version: '0.2.0-draft',
      channel: 'BOSS直聘',
      platform: true,
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
      version: '0.2.0-draft',
      channel: '牛客',
      platform: true,
      hosts: ['www.nowcoder.com', 'nowcoder.com'],
      jobUrlPatterns: [/\/jobs\/detail\/\d+/i, /\/job\//i, /\/position\//i],
      listUrlPatterns: [/\/jobs\/(?:school|intern|fulltime|recommend)/i, /\/job\/center/i, /\/search/i],
      selectors: {
        title: ['h1', '.job-title', '.title'],
        company: ['a[href*="/jobs/hr/"] .tw-whitespace-pre-wrap', '.company-name', '[class*="company"]'],
        jd: ['.job-detail-infos .ptb-2.pre-line', '.job-detail-word .ptb-2.pre-line', '.job-detail-infos', '.job-detail-word', '.job-desc', '.detail-content'],
        location: ['.extra', '.job-location', '[class*="location"]'],
        info: ['.extra', '.job-detail-infos'],
        success: ['[class*="success"]', '[class*="message"]']
      },
      refine: function nowcoderRefine(job) {
        const companyEl = document.querySelector('a[href*="/jobs/hr/"] .tw-whitespace-pre-wrap');
        if (companyEl) {
          const company = String(companyEl.innerText || companyEl.textContent || '').replace(/\s+/g, ' ').split(/[·•|｜]/)[0].trim();
          if (company) { job.company_name = company; job.field_confidence.company_name = 0.9; }
        }
        const info = textOfFirst('.extra');
        const city = info.match(/(北京|上海|广州|深圳|杭州|南京|苏州|成都|武汉|西安|长沙|天津|重庆|合肥|厦门|福州|济南|青岛|郑州|大连|珠海|东莞|佛山|宁波|无锡|香港)/);
        if (city) { job.location = city[1]; job.field_confidence.location = 0.86; }
        return job;
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
      version: '0.2.0-draft',
      channel: '实习僧',
      platform: true,
      hosts: ['www.shixiseng.com', 'shixiseng.com'],
      jobUrlPatterns: [/\/intern\/[A-Za-z0-9_-]+/i, /\/job\//i],
      listUrlPatterns: [/\/interns/i, /\/search/i],
      selectors: {
        title: ['.new_job_name', '.job-title', 'h1'],
        company: ['.com-name', '.company-name'],
        jd: ['.con-job', '.job_detail', '.job-detail'],
        location: ['.job_position', '[class*="location"]'],
        info: ['.job-header', '.job_msg'],
        success: ['[class*="success"]', '[class*="message"]']
      },
      refine: function shixisengRefine(job) {
        const info = textOfFirst('.job-header');
        const city = info.match(/(北京|上海|广州|深圳|杭州|南京|苏州|成都|武汉|西安|长沙|天津|重庆|合肥|厦门|福州|济南|青岛|郑州|大连|珠海|东莞|佛山|宁波|无锡|香港)/);
        if (city) { job.location = city[1]; job.field_confidence.location = 0.84; }
        return job;
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
