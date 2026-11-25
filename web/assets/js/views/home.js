/* 官网首页（登录引导落地页）。
   零依赖原生实现：吸顶导航 + ScrollSpy + 滚动渐显 + 邮件状态轮播。
   renderHome() 返回清理函数，路由切换时必须调用，避免 IntersectionObserver
   与定时器在已卸载的 DOM 上继续运行。 */

import { h, clear } from '../util.js';
import { pluginDownloadLink, openPluginHelp } from './plugin-help.js?v=20261125-1';

const NAV_ITEMS = [
  { id: 'capture', label: '岗位抓取' },
  { id: 'resume', label: '简历改写' },
  { id: 'mail', label: '邮件追踪' },
  { id: 'assistant', label: 'AI 助手' }
];

const MAIL_STEPS = ['一面', '二面', '三面'];

const FEATURES = [
  {
    id: 'capture',
    index: '01',
    label: '岗位抓取',
    slogan: '逛官网顺手记，投过看过不漏单。',
    intro: '直接去目标公司官网浏览和投递，随时随地自动记录你的「已投递」与「看过没投」状态，不用再手动复制粘贴 Excel。',
    points: [
      ['官网原生采集', '照常在各公司招聘官网浏览与投递，浏览器插件静默识别公司、岗位与完整 JD。'],
      ['看过也能留痕', '犹豫还没投的岗位自动归入「看过没投」，想投时一键转入投递台账。'],
      ['只采你访问的页面', '不替你后台爬虫，不碰账号密码与 Cookie，采集记录可控可撤销。']
    ],
    image: {
      src: '/assets/img/home/feature-capture.webp',
      alt: '待确认页中展示插件捕获的公司、岗位与 JD 预览卡片',
      path: 'tounar · 待确认 · 插件线索',
      width: 960,
      height: 600
    }
  },
  {
    id: 'resume',
    index: '02',
    label: '简历匹配与改写',
    slogan: '照着心仪岗位改简历，不瞎编、按模板直接出稿。',
    intro: '选中台账里的目标岗位，结合你的真实简历与个性化要求，逐条对齐 JD 重点进行改写，并按标准模板生成对应版本，方便多版本管理。',
    points: [
      ['先看匹配再动笔', '对照岗位硬门槛与能力维度给出清晰结论，短板与优势一目了然。'],
      ['支持个性化要求', '可补充「突出某段项目」「精简篇幅」「偏重数据分析」等定制指令，不凭空捏造经历。'],
      ['逐行对照 + 模板生成', '原文与改写稿左右对照高亮改动，一键保存为新简历版本并按模板导出。']
    ],
    image: {
      src: '/assets/img/home/feature-resume.webp',
      alt: '简历改写工作台，左侧原文与右侧浅绿高亮改写稿逐段对照',
      path: 'tounar · 简历改写工作台',
      width: 960,
      height: 600
    }
  },
  {
    id: 'mail',
    index: '03',
    label: '邮件状态更新与提醒',
    slogan: '一面变二面、二面变三面，邮件一来状态自己跳。',
    intro: '授权连接招聘邮箱后，自动识别笔试、面试邀约与结果邮件，实时更新对应岗位的投递阶段；长时间没回音的投递支持定期回看提醒。',
    points: [
      ['自动识别阶段流转', '收到新邮件自动将台账状态从「已投递 → 笔试 → 一面 → 二面 → 三面 / Offer」精准推进。'],
      ['定期回看不错过', '自定义静默天数阈值（如 7 天未更新），到期汇总提醒你复盘或跟进。'],
      ['隐私边界清晰', '仅筛选招聘相关邮件提取状态，不读取附件、不保存邮件原文，随时可一键断开。']
    ],
    image: {
      src: '/assets/img/home/feature-mail.webp',
      alt: '岗位详情抽屉中的状态流转时间线，展示已投递、一面、二面的邮件自动推进',
      path: 'tounar · 投递台账 · 状态时间线',
      width: 960,
      height: 600
    }
  },
  {
    id: 'assistant',
    index: '04',
    label: 'AI 助手全面打通',
    slogan: '懂你全盘台账的 AI，帮你查进度、挑岗位、记偏好。',
    intro: 'AI 助手直接打通你的台账、简历与历史互动，不仅能一句话整理进度、分析对比多个岗位，还能在对话中逐步沉淀你的个人求职偏好。',
    points: [
      ['一句话管理台账', '直接问「这周有哪些面试」「把某公司标成二面」，确认后直接写入真实台账。'],
      ['跨岗位分析与匹配', '结合简历帮你横向比较多个备选岗位，给出投递优先级与面试准备建议。'],
      ['沉淀个人求职偏好', '记录你的意向城市、岗位方向、避雷项与薪资底线，越用越懂你想找什么工作。']
    ],
    image: {
      src: '/assets/img/home/feature-assistant.webp',
      alt: '右侧 AI 投递助理抽屉，展示台账查询结论、岗位对比与待确认操作卡片',
      path: 'tounar · AI 投递助理',
      width: 960,
      height: 620
    }
  }
];

function brandMark() {
  return h('span', { class: 'tn-brand-mark tn-home-brand-mark', 'aria-hidden': 'true', text: 'T' });
}

function tabLink({ id, label }, { mobile = false } = {}) {
  return h('a', {
    class: `tn-home-nav-tab${mobile ? ' tn-home-mobile-tab' : ''}`,
    href: `#${id}`,
    'data-home-tab': id,
    'data-test': mobile ? `home-mobile-tab-${id}` : `home-tab-${id}`,
    text: label
  });
}

function shotFrame({ image, badge = null, badges = null, test }) {
  const frame = h('div', {
    class: 'tn-home-shot-frame',
    'data-test': test
  });
  const img = h('img', {
    class: 'tn-home-shot-img',
    src: image.src,
    alt: image.alt,
    width: image.width,
    height: image.height,
    loading: test === 'home-hero-shot' ? 'eager' : 'lazy',
    fetchpriority: test === 'home-hero-shot' ? 'high' : 'auto',
    decoding: 'async'
  });
  // 图片缺失时退回纯 CSS 结构化预览，绝不出现破图图标。
  img.addEventListener('error', () => frame.classList.add('is-missing'), { once: true });
  const viewport = h('div', { class: 'tn-home-shot-viewport' },
    img,
    h('div', { class: 'tn-home-shot-fallback', 'aria-hidden': 'true' },
      h('div', { class: 'tn-home-fallback-head' }, h('span'), h('span'), h('span')),
      h('div', { class: 'tn-home-fallback-row' }, h('span', { class: 'is-title' }), h('span'), h('span', { class: 'is-pill' })),
      h('div', { class: 'tn-home-fallback-row' }, h('span', { class: 'is-title' }), h('span'), h('span', { class: 'is-pill' })),
      h('div', { class: 'tn-home-fallback-row' }, h('span', { class: 'is-title' }), h('span'), h('span', { class: 'is-pill' })),
      h('div', { class: 'tn-home-fallback-foot' }, h('span'), h('span'))
    )
  );
  frame.append(
    h('div', { class: 'tn-home-shot-bar' },
      h('span', { class: 'tn-home-shot-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', { class: 'tn-home-shot-path', text: image.path })
    ),
    viewport
  );
  const allBadges = badges || (badge ? [badge] : []);
  for (const item of allBadges) frame.append(item);
  return frame;
}

function featureBadges(feature) {
  if (feature.id === 'capture') {
    return [h('div', { class: 'tn-home-shot-badge tn-home-capture-badge', 'data-test': 'home-capture-badge' },
      h('span', { class: 'tn-home-badge-dot', 'aria-hidden': 'true' }),
      h('strong', { text: '官网插件已捕获' }),
      h('span', { class: 'tn-home-badge-divider', 'aria-hidden': 'true' }),
      h('div', { class: 'tn-home-toggle-group', role: 'group', 'aria-label': '采集状态示例' },
        h('button', { class: 'tn-home-toggle', type: 'button', 'data-test': 'home-capture-toggle-viewed', 'aria-pressed': 'true', text: '看过没投' }),
        h('button', { class: 'tn-home-toggle', type: 'button', 'data-test': 'home-capture-toggle-applied', 'aria-pressed': 'false', text: '已投递' })
      )
    )];
  }
  if (feature.id === 'resume') {
    return [
      h('div', { class: 'tn-home-shot-badge tn-home-resume-badge', 'data-test': 'home-resume-badge' },
        h('span', { class: 'tn-home-check', 'aria-hidden': 'true', text: '✓' }),
        h('strong', { text: '已融入个性化要求' })),
      h('div', { class: 'tn-home-shot-badge tn-home-export-badge' },
        h('span', { class: 'tn-home-mono-tag', text: 'DOCX' }),
        h('span', { text: '按标准模板一键导出' }))
    ];
  }
  if (feature.id === 'mail') {
    return [h('div', { class: 'tn-home-shot-badge tn-home-mail-badge', 'data-test': 'home-mail-badge' },
      h('div', { class: 'tn-home-mail-flow', 'aria-label': '邮件自动推进示例' },
        ...MAIL_STEPS.map((label, index) => h('span', {
          class: `tn-home-mail-step${index === 0 ? ' is-active' : ''}`,
          'data-home-mail-step': String(index),
          text: label
        })),
      h('span', { class: 'tn-home-badge-divider', 'aria-hidden': 'true' }),
      h('span', { class: 'tn-home-due-badge', text: '⏰ 7 天未推进定期回看' })))
    ];
  }
  return [h('div', { class: 'tn-home-shot-badge tn-home-assistant-badge', 'data-test': 'home-assistant-badge' },
    h('span', { class: 'tn-home-pref-pill', text: '意向：AI 产品' }),
    h('span', { class: 'tn-home-pref-pill', text: '城市：上海/杭州' }),
    h('span', { class: 'tn-home-pref-pill is-warn', text: '避雷：外包' })
  )];
}

function featureSection(feature) {
  const flip = feature.index === '02' || feature.index === '04';
  const frame = shotFrame({
    image: feature.image,
    badges: featureBadges(feature),
    test: `home-shot-${feature.id}`
  });
  const copy = h('div', { class: 'tn-home-feature-copy tn-home-reveal' },
    h('div', { class: 'tn-home-eyebrow' },
      h('span', { class: 'tn-home-eyebrow-num', text: feature.index }),
      h('span', { text: `· ${feature.label}` })),
    h('h2', { class: 'tn-home-feature-title', text: feature.slogan }),
    h('p', { class: 'tn-home-feature-intro', text: feature.intro }),
    h('ul', { class: 'tn-home-feature-points' },
      ...feature.points.map(([title, desc]) => h('li', {},
        h('span', { class: 'tn-home-point-check', 'aria-hidden': 'true', text: '✓' }),
        h('div', {}, h('strong', { text: title }), h('span', { text: desc })))))
  );
  const visual = h('div', { class: 'tn-home-feature-visual tn-home-reveal', 'data-reveal-delay': '1' }, frame);
  return h('section', {
    class: `tn-home-feature${flip ? ' is-flip' : ''}`,
    id: feature.id,
    'data-home-section': feature.id,
    'aria-labelledby': `home-${feature.id}-title`
  }, copy, visual);
}

export function renderHome(root, { loggedIn = false, onLogin = null, onEnterApp = null, loginHref = '/?view=login' } = {}) {
  clear(root);

  const cleanups = [];
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
  const primaryLabel = loggedIn ? '进入工作台' : '立即登录，开始整理';
  const navPrimaryLabel = loggedIn ? '进入工作台' : '登录 / 开始使用';

  function goPrimary(event) {
    event?.preventDefault?.();
    if (loggedIn && typeof onEnterApp === 'function') onEnterApp();
    else if (typeof onLogin === 'function') onLogin();
    else location.href = '/?view=login';
  }

  const desktopTabs = h('nav', { class: 'tn-home-nav-tabs tn-home-desktop-tabs', 'aria-label': '核心功能' });
  for (const item of NAV_ITEMS) desktopTabs.append(tabLink(item));
  const navPill = h('span', { class: 'tn-home-nav-pill', 'aria-hidden': 'true' });
  desktopTabs.append(navPill);

  const navBar = h('header', { class: 'tn-home-nav', 'data-test': 'home-nav' },
    h('div', { class: 'tn-home-nav-inner' },
      h('a', { class: 'tn-home-brand', href: '#top', 'aria-label': 'TOUNAR 帮你理 首页' },
        brandMark(),
        h('span', { class: 'tn-home-brand-word' }, h('strong', { text: 'TOUNAR' }), h('span', { text: '帮你理' }))),
      desktopTabs,
      h('div', { class: 'tn-home-nav-actions' },
        pluginDownloadLink({ class: 'tn-home-btn tn-home-btn-ghost tn-home-nav-download', label: '下载插件', test: 'home-download-plugin' }),
        h('a', {
          class: 'tn-home-btn tn-home-btn-primary', href: loggedIn ? '/' : loginHref,
          'data-test': 'home-nav-login', onclick: goPrimary
        }, h('span', { text: navPrimaryLabel }), h('span', { class: 'tn-home-btn-arrow', 'aria-hidden': 'true', text: '→' }))
      )
    ),
    (() => {
      const mobile = h('nav', { class: 'tn-home-mobile-tabs', 'aria-label': '核心功能（移动端）' });
      for (const item of NAV_ITEMS) mobile.append(tabLink(item, { mobile: true }));
      return mobile;
    })()
  );

  const heroShot = shotFrame({
    image: {
      src: '/assets/img/home/hero-ledger.webp',
      alt: 'Tounar 投递台账：累计投递、进行中、面试中统计与多条不同状态的岗位记录',
      path: 'tounar · 投递台账',
      width: 1020,
      height: 660
    },
    test: 'home-hero-shot',
    badge: h('div', { class: 'tn-home-shot-badge tn-home-hero-badge', 'data-test': 'home-hero-badge' },
      h('span', { class: 'tn-home-badge-dot', 'aria-hidden': 'true' }),
      h('span', { text: 'AI 助手：已按目标 JD 拆解 3 处简历改写建议' }))
  });

  const hero = h('section', { class: 'tn-home-hero', id: 'top', 'aria-labelledby': 'home-hero-title' },
    h('div', { class: 'tn-home-hero-copy' },
      h('div', { class: 'tn-home-hero-eyebrow tn-home-hero-in' },
        h('span', { class: 'tn-home-badge-dot', 'aria-hidden': 'true' }),
        h('span', { text: 'Tounar 帮你理 · 个人求职台账与 AI 助手' })),
      h('h1', { class: 'tn-home-hero-title tn-home-hero-in', id: 'home-hero-title' },
        h('span', { class: 'tn-home-hero-brand', text: 'Tounar 帮你理' }),
        h('span', { class: 'tn-home-hero-slogan', text: '让投递更省心' })),
      h('p', { class: 'tn-home-hero-copytext tn-home-hero-in', 'data-hero-delay': '1' },
        '逛官网时顺手记下岗位，改简历时照着 JD 逐条对齐，面试邮件来了自动推进状态。',
        h('span', { class: 'tn-home-hero-em', text: '你只管准备面试，琐碎的事交给我们理清楚。' })),
      h('div', { class: 'tn-home-hero-actions tn-home-hero-in', 'data-hero-delay': '2' },
        h('a', { class: 'tn-home-btn tn-home-btn-primary tn-home-btn-lg', href: loggedIn ? '/' : loginHref, 'data-test': 'home-cta-login', onclick: goPrimary },
          h('span', { text: primaryLabel }), h('span', { class: 'tn-home-btn-arrow', 'aria-hidden': 'true', text: '→' })),
        h('a', { class: 'tn-home-btn tn-home-btn-secondary tn-home-btn-lg', href: '#details', 'data-test': 'home-cta-how', text: '看看怎么用 ↓' })),
      h('div', { class: 'tn-home-steps tn-home-hero-in', 'data-hero-delay': '3', 'data-test': 'home-steps' },
        h('div', { class: 'tn-home-steps-label' }, h('span', { class: 'tn-home-mono-tag', text: '直接开始' }), h('span', { class: 'tn-home-small', text: '3 步上手' })),
        h('ol', { class: 'tn-home-steps-list' },
          h('li', {}, h('span', { class: 'tn-home-step-num', text: '①' }), h('span', { text: '邮箱验证码登录' })),
          h('li', {}, h('span', { class: 'tn-home-step-num', text: '②' }), h('span', { text: '装好插件或连上招聘邮箱' })),
          h('li', {}, h('span', { class: 'tn-home-step-num', text: '③' }), h('span', { text: '照常逛官网、投简历，台账自动归位' }))))
    ),
    h('div', { class: 'tn-home-hero-visual tn-home-hero-in', 'data-hero-delay': '2' }, heroShot)
  );

  const detailPills = h('div', { class: 'tn-home-detail-pills' });
  for (const item of FEATURES) {
    detailPills.append(h('a', {
      class: 'tn-home-detail-pill', href: `#${item.id}`, 'data-test': `home-detail-${item.id}`
    }, h('span', { class: 'tn-home-detail-num', text: item.index }), h('span', { text: item.label })));
  }
  const details = h('section', { class: 'tn-home-details', id: 'details', 'aria-labelledby': 'home-details-title' },
    h('div', { class: 'tn-home-detail-card tn-home-reveal' },
      h('p', { class: 'tn-home-detail-main', id: 'home-details-title' },
        '投到第 30 个岗位时，最累的往往不是面试，而是记不清自己投了谁、发了哪版简历、该不该去催进度。'),
      h('p', { class: 'tn-home-detail-sub', text: '不替你海投，也不瞎编经历。Tounar 帮你理只做四件实在的事：' }),
      detailPills)
  );

  const features = h('div', { class: 'tn-home-features' }, ...FEATURES.map(featureSection));

  const start = h('section', { class: 'tn-home-start', id: 'start', 'aria-labelledby': 'home-start-title' },
    h('div', { class: 'tn-home-start-card tn-home-reveal' },
      h('div', { class: 'tn-home-start-copy' },
        h('div', { class: 'tn-home-eyebrow is-light' }, h('span', { text: '准备开始' })),
        h('h2', { class: 'tn-home-start-title', id: 'home-start-title', text: '准备好把投递理清楚了吗？' }),
        h('p', { class: 'tn-home-start-sub', text: '无需复杂配置，邮箱验证码登录即可开始；支持随时下载浏览器插件或按需连接招聘邮箱。' })),
      h('div', { class: 'tn-home-start-actions' },
        h('a', { class: 'tn-home-btn tn-home-btn-light tn-home-btn-lg', href: loggedIn ? '/' : loginHref, 'data-test': 'home-footer-login', onclick: goPrimary },
          h('span', { text: loggedIn ? '进入工作台' : '立即登录' }), h('span', { class: 'tn-home-btn-arrow', 'aria-hidden': 'true', text: '→' })),
        pluginDownloadLink({ class: 'tn-home-btn tn-home-btn-outline-light tn-home-btn-lg', label: '下载浏览器插件', test: 'home-footer-download' }),
        h('button', { class: 'tn-home-btn tn-home-btn-ghost-light tn-home-btn-lg', type: 'button', 'data-test': 'home-plugin-help', text: '查看插件安装指引', onclick: () => openPluginHelp() }))),
    h('div', { class: 'tn-home-trust tn-home-reveal', 'data-reveal-delay': '1' },
      h('div', { class: 'tn-home-trust-item' }, h('strong', { text: '按需授权' }), h('span', { text: '插件与邮箱独立开关，不开也能手动补录。' })),
      h('div', { class: 'tn-home-trust-item' }, h('strong', { text: '不留敏感原文' }), h('span', { text: '不读附件、不存正文、不传 Cookie。' })),
      h('div', { class: 'tn-home-trust-item' }, h('strong', { text: '随时可撤回' }), h('span', { text: '一键断开授权，或彻底删除全部数据。' }))),
    h('footer', { class: 'tn-home-footer' },
      h('div', { class: 'tn-home-footer-brand' }, brandMark(), h('span', { text: 'Tounar · 帮你理 — 让投递更省心' })),
      h('p', { class: 'tn-home-footer-note', text: '内测说明：当前面向受邀用户开放，老账号可直接邮箱登录。' }))
  );

  const page = h('div', { class: 'tn-home', 'data-test': 'home-page' },
    h('div', { class: 'tn-home-sentinel', 'aria-hidden': 'true' }),
    navBar,
    h('main', { class: 'tn-home-main' }, hero, details, features, start)
  );
  root.append(page);

  /* ---------- 吸顶状态 ---------- */
  const onScroll = () => navBar.classList.toggle('is-scrolled', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  cleanups.push(() => window.removeEventListener('scroll', onScroll));
  onScroll();

  /* ---------- Tab 指示器 / ScrollSpy ---------- */
  let activeTab = 'capture';
  const desktopTabMap = new Map();
  for (const tab of desktopTabs.querySelectorAll('[data-home-tab]')) desktopTabMap.set(tab.dataset.homeTab, tab);

  function placePill() {
    const tab = desktopTabMap.get(activeTab);
    if (!tab) { navPill.style.opacity = '0'; return; }
    navPill.style.opacity = '1';
    navPill.style.width = `${tab.offsetWidth}px`;
    navPill.style.transform = `translateX(${tab.offsetLeft}px)`;
  }
  function setActiveTab(id, { scroll = false } = {}) {
    if (!id) return;
    activeTab = id;
    for (const tab of page.querySelectorAll('[data-home-tab]')) {
      const active = tab.dataset.homeTab === id;
      tab.classList.toggle('is-active', active);
      if (active) tab.setAttribute('aria-current', 'true');
      else tab.removeAttribute('aria-current');
    }
    placePill();
    if (scroll) {
      const target = document.getElementById(id);
      target?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      history.replaceState({}, '', `#${id}`);
    }
  }

  const onTabClick = (event) => {
    const tab = event.target.closest?.('[data-home-tab]');
    if (!tab) return;
    event.preventDefault();
    setActiveTab(tab.dataset.homeTab, { scroll: true });
  };
  page.addEventListener('click', onTabClick);
  cleanups.push(() => page.removeEventListener('click', onTabClick));

  const onResize = () => placePill();
  window.addEventListener('resize', onResize);
  cleanups.push(() => window.removeEventListener('resize', onResize));

  requestAnimationFrame(() => {
    if (!page.isConnected) return;
    setActiveTab(activeTab);
  });

  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target?.dataset.homeSection) setActiveTab(visible.target.dataset.homeSection);
    }, { rootMargin: '-25% 0px -55% 0px', threshold: [0.05, 0.2, 0.5] });
    for (const section of page.querySelectorAll('[data-home-section]')) spy.observe(section);
    cleanups.push(() => spy.disconnect());
  }

  /* ---------- Hero 入场 & 滚动渐显 ---------- */
  const readyRaf = requestAnimationFrame(() => page.classList.add('is-ready'));
  cleanups.push(() => cancelAnimationFrame(readyRaf));

  const reveals = [...page.querySelectorAll('.tn-home-reveal')];
  if (reduceMotion || !('IntersectionObserver' in window)) {
    for (const node of reveals) node.classList.add('is-visible');
  } else {
    const revealer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        revealer.unobserve(entry.target);
      }
    }, { threshold: 0.14 });
    for (const node of reveals) revealer.observe(node);
    cleanups.push(() => revealer.disconnect());
  }

  /* ---------- 采集状态切换示例 ---------- */
  const captureBadge = page.querySelector('[data-test="home-capture-badge"]');
  if (captureBadge) {
    const toggles = [...captureBadge.querySelectorAll('.tn-home-toggle')];
    const onToggle = (event) => {
      const button = event.target.closest?.('.tn-home-toggle');
      if (!button) return;
      for (const item of toggles) {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    };
    captureBadge.addEventListener('click', onToggle);
    cleanups.push(() => captureBadge.removeEventListener('click', onToggle));
  }

  /* ---------- 邮件状态柔和轮播 ---------- */
  const mailBadge = page.querySelector('[data-test="home-mail-badge"]');
  if (mailBadge) {
    const steps = [...mailBadge.querySelectorAll('[data-home-mail-step]')];
    let step = 0;
    let timer = null;
    let visible = false;
    let paused = false;
    const paint = () => {
      for (const node of steps) node.classList.toggle('is-active', Number(node.dataset.homeMailStep) === step);
    };
    const start = () => {
      if (timer || reduceMotion) return;
      timer = setInterval(() => { step = (step + 1) % steps.length; paint(); }, 2400);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    cleanups.push(() => clearInterval(timer));
    const sync = () => { if (visible && !paused) start(); else stop(); };

    const mailSection = document.getElementById('mail');
    let mailObserver = null;
    if (mailSection && 'IntersectionObserver' in window) {
      mailObserver = new IntersectionObserver((entries) => {
        visible = Boolean(entries[0]?.isIntersecting);
        sync();
      }, { threshold: 0.2 });
      mailObserver.observe(mailSection);
      cleanups.push(() => mailObserver.disconnect());
    } else {
      visible = true;
      sync();
    }
    const pause = () => { paused = true; sync(); };
    const resume = () => { paused = false; sync(); };
    mailBadge.addEventListener('mouseenter', pause);
    mailBadge.addEventListener('mouseleave', resume);
    mailBadge.addEventListener('focusin', pause);
    mailBadge.addEventListener('focusout', resume);
    cleanups.push(() => {
      mailBadge.removeEventListener('mouseenter', pause);
      mailBadge.removeEventListener('mouseleave', resume);
      mailBadge.removeEventListener('focusin', pause);
      mailBadge.removeEventListener('focusout', resume);
    });
  }

  return () => {
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup(); } catch { /* 视图已卸载，忽略清理异常 */ }
    }
  };
}
