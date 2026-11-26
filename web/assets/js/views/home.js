/* 官网首页（登录引导落地页）。
   零依赖原生实现：吸顶导航 + ScrollSpy + 滚动渐显 + 邮件状态轮播 + 中英文切换。
   renderHome() 返回清理函数，路由切换时必须调用，避免 IntersectionObserver
   与定时器在已卸载的 DOM 上继续运行，并还原文档语言与标题元数据。 */

import { h, clear } from '../util.js';
import { pluginDownloadLink, openPluginHelp } from './plugin-help.js?v=20261125-1';
import { HOME_COPY, persistHomeLang, resolveInitialHomeLang } from './home-i18n.js?v=20261127-1';

const NAV_TAB_IDS = ['capture', 'resume', 'mail', 'assistant'];

function brandMark() {
  return h('span', { class: 'tn-brand-mark tn-home-brand-mark', 'aria-hidden': 'true', text: 'T' });
}

function setMetaDescription(content) {
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', content);
}

function tabLink(id, label, { mobile = false } = {}) {
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
  const pathEl = h('span', { class: 'tn-home-shot-path', text: image.path });
  frame.append(
    h('div', { class: 'tn-home-shot-bar' },
      h('span', { class: 'tn-home-shot-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      pathEl
    ),
    viewport
  );
  const allBadges = badges || (badge ? [badge] : []);
  for (const item of allBadges) frame.append(item);
  return { frame, img, pathEl };
}

function featureBadges(feature, featureIndex, bind) {
  if (feature.id === 'capture') {
    const strong = h('strong', { text: feature.badges.strong });
    const viewedBtn = h('button', {
      class: 'tn-home-toggle', type: 'button',
      'data-test': 'home-capture-toggle-viewed', 'aria-pressed': 'true',
      text: feature.badges.viewed
    });
    const appliedBtn = h('button', {
      class: 'tn-home-toggle', type: 'button',
      'data-test': 'home-capture-toggle-applied', 'aria-pressed': 'false',
      text: feature.badges.applied
    });
    const group = h('div', {
      class: 'tn-home-toggle-group', role: 'group',
      'aria-label': feature.badges.toggleAriaLabel
    }, viewedBtn, appliedBtn);

    bind((copy) => {
      const next = copy.features[featureIndex].badges;
      strong.textContent = next.strong;
      group.setAttribute('aria-label', next.toggleAriaLabel);
      viewedBtn.textContent = next.viewed;
      appliedBtn.textContent = next.applied;
    });

    return [h('div', { class: 'tn-home-shot-badge tn-home-capture-badge', 'data-test': 'home-capture-badge' },
      h('span', { class: 'tn-home-badge-dot', 'aria-hidden': 'true' }),
      strong,
      h('span', { class: 'tn-home-badge-divider', 'aria-hidden': 'true' }),
      group
    )];
  }
  if (feature.id === 'resume') {
    const promptStrong = h('strong', { text: feature.badges.prompt });
    const exportTag = h('span', { class: 'tn-home-mono-tag', text: feature.badges.exportTag });
    const exportText = h('span', { text: feature.badges.exportText });
    bind((copy) => {
      const next = copy.features[featureIndex].badges;
      promptStrong.textContent = next.prompt;
      exportTag.textContent = next.exportTag;
      exportText.textContent = next.exportText;
    });
    return [
      h('div', { class: 'tn-home-shot-badge tn-home-resume-badge', 'data-test': 'home-resume-badge' },
        h('span', { class: 'tn-home-check', 'aria-hidden': 'true', text: '✓' }),
        promptStrong),
      h('div', { class: 'tn-home-shot-badge tn-home-export-badge' },
        exportTag,
        exportText)
    ];
  }
  if (feature.id === 'mail') {
    const stepNodes = feature.badges.steps.map((label, index) => h('span', {
      class: `tn-home-mail-step${index === 0 ? ' is-active' : ''}`,
      'data-home-mail-step': String(index),
      text: label
    }));
    const dueEl = h('span', { class: 'tn-home-due-badge', text: feature.badges.due });
    const flowEl = h('div', { class: 'tn-home-mail-flow', 'aria-label': feature.badges.flowAriaLabel },
      ...stepNodes,
      h('span', { class: 'tn-home-badge-divider', 'aria-hidden': 'true' }),
      dueEl
    );
    bind((copy) => {
      const next = copy.features[featureIndex].badges;
      flowEl.setAttribute('aria-label', next.flowAriaLabel);
      stepNodes.forEach((node, idx) => { node.textContent = next.steps[idx]; });
      dueEl.textContent = next.due;
    });
    return [h('div', { class: 'tn-home-shot-badge tn-home-mail-badge', 'data-test': 'home-mail-badge' }, flowEl)];
  }
  const pillNodes = feature.badges.pills.map((pill) => h('span', {
    class: `tn-home-pref-pill${pill.warn ? ' is-warn' : ''}`,
    text: pill.text
  }));
  bind((copy) => {
    const nextPills = copy.features[featureIndex].badges.pills;
    pillNodes.forEach((node, idx) => { node.textContent = nextPills[idx].text; });
  });
  return [h('div', { class: 'tn-home-shot-badge tn-home-assistant-badge', 'data-test': 'home-assistant-badge' }, ...pillNodes)];
}

function featureSection(feature, featureIndex, bind) {
  const flip = feature.index === '02' || feature.index === '04';
  const shot = shotFrame({
    image: feature.image,
    badges: featureBadges(feature, featureIndex, bind),
    test: `home-shot-${feature.id}`
  });
  const eyebrowLabel = h('span', { text: `· ${feature.label}` });
  const titleEl = h('h2', { class: 'tn-home-feature-title', id: `home-${feature.id}-title`, text: feature.slogan });
  const introEl = h('p', { class: 'tn-home-feature-intro', text: feature.intro });
  const pointNodes = feature.points.map(([title, desc]) => {
    const strongEl = h('strong', { text: title });
    const descEl = h('span', { text: desc });
    const item = h('li', {},
      h('span', { class: 'tn-home-point-check', 'aria-hidden': 'true', text: '✓' }),
      h('div', {}, strongEl, descEl));
    return { item, strongEl, descEl };
  });

  bind((copy) => {
    const next = copy.features[featureIndex];
    eyebrowLabel.textContent = `· ${next.label}`;
    titleEl.textContent = next.slogan;
    introEl.textContent = next.intro;
    shot.img.alt = next.image.alt;
    shot.pathEl.textContent = next.image.path;
    pointNodes.forEach((p, idx) => {
      const [nextTitle, nextDesc] = next.points[idx];
      p.strongEl.textContent = nextTitle;
      p.descEl.textContent = nextDesc;
    });
  });

  const copyBlock = h('div', { class: 'tn-home-feature-copy tn-home-reveal' },
    h('div', { class: 'tn-home-eyebrow' },
      h('span', { class: 'tn-home-eyebrow-num', text: feature.index }),
      eyebrowLabel),
    titleEl,
    introEl,
    h('ul', { class: 'tn-home-feature-points' }, ...pointNodes.map((p) => p.item))
  );
  const visual = h('div', { class: 'tn-home-feature-visual tn-home-reveal', 'data-reveal-delay': '1' }, shot.frame);
  return h('section', {
    class: `tn-home-feature${flip ? ' is-flip' : ''}`,
    id: feature.id,
    'data-home-section': feature.id,
    'aria-labelledby': `home-${feature.id}-title`
  }, copyBlock, visual);
}

export function renderHome(root, { loggedIn = false, onLogin = null, onEnterApp = null, loginHref = '/?view=login' } = {}) {
  clear(root);

  const cleanups = [];
  const updaters = [];
  const bind = (fn) => updaters.push(fn);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
  let currentLang = resolveInitialHomeLang();
  const initCopy = HOME_COPY[currentLang];

  function goPrimary(event) {
    event?.preventDefault?.();
    if (loggedIn && typeof onEnterApp === 'function') onEnterApp();
    else if (typeof onLogin === 'function') onLogin();
    else location.href = '/?view=login';
  }

  /* ---------- 导航与语言切换 ---------- */
  const desktopTabs = h('nav', { class: 'tn-home-nav-tabs tn-home-desktop-tabs', 'aria-label': initCopy.nav.desktopAriaLabel });
  const desktopTabNodes = NAV_TAB_IDS.map((id) => tabLink(id, initCopy.nav.tabs[id]));
  for (const tab of desktopTabNodes) desktopTabs.append(tab);
  const navPill = h('span', { class: 'tn-home-nav-pill', 'aria-hidden': 'true' });
  desktopTabs.append(navPill);

  const mobileTabs = h('nav', { class: 'tn-home-mobile-tabs', 'aria-label': initCopy.nav.mobileAriaLabel });
  const mobileTabNodes = NAV_TAB_IDS.map((id) => tabLink(id, initCopy.nav.tabs[id], { mobile: true }));
  for (const tab of mobileTabNodes) mobileTabs.append(tab);

  const brandSub = h('span', { text: initCopy.brand.sub });
  const brandLink = h('a', { class: 'tn-home-brand', href: '#top', 'aria-label': initCopy.brand.ariaLabel },
    brandMark(),
    h('span', { class: 'tn-home-brand-word' },
      h('strong', { text: initCopy.brand.name }),
      brandSub
    )
  );
  bind((copy) => {
    brandLink.setAttribute('aria-label', copy.brand.ariaLabel);
    brandSub.textContent = copy.brand.sub;
  });

  const langZhBtn = h('button', {
    class: 'tn-home-lang-btn',
    type: 'button',
    'data-test': 'home-lang-zh',
    'aria-pressed': 'true',
    text: '中',
    onclick: () => switchLang('zh')
  });
  const langEnBtn = h('button', {
    class: 'tn-home-lang-btn',
    type: 'button',
    'data-test': 'home-lang-en',
    'aria-pressed': 'false',
    text: 'EN',
    onclick: () => switchLang('en')
  });
  const langSwitch = h('div', {
    class: 'tn-home-lang',
    'data-test': 'home-lang-switch',
    role: 'group',
    'aria-label': '切换语言 / Switch language'
  }, langZhBtn, langEnBtn);

  const navDownload = pluginDownloadLink({
    class: 'tn-home-btn tn-home-btn-ghost tn-home-nav-download',
    label: initCopy.nav.download,
    test: 'home-download-plugin'
  });
  const navPrimaryText = h('span', { text: loggedIn ? initCopy.nav.enterApp : initCopy.nav.login });

  bind((copy) => {
    desktopTabs.setAttribute('aria-label', copy.nav.desktopAriaLabel);
    mobileTabs.setAttribute('aria-label', copy.nav.mobileAriaLabel);
    NAV_TAB_IDS.forEach((id, idx) => {
      desktopTabNodes[idx].textContent = copy.nav.tabs[id];
      mobileTabNodes[idx].textContent = copy.nav.tabs[id];
    });
    navDownload.textContent = copy.nav.download;
    navDownload.title = copy.nav.downloadTitle;
    navPrimaryText.textContent = loggedIn ? copy.nav.enterApp : copy.nav.login;
  });

  const navBar = h('header', { class: 'tn-home-nav', 'data-test': 'home-nav' },
    h('div', { class: 'tn-home-nav-inner' },
      brandLink,
      desktopTabs,
      h('div', { class: 'tn-home-nav-actions' },
        langSwitch,
        navDownload,
        h('a', {
          class: 'tn-home-btn tn-home-btn-primary', href: loggedIn ? '/' : loginHref,
          'data-test': 'home-nav-login', onclick: goPrimary
        }, navPrimaryText, h('span', { class: 'tn-home-btn-arrow', 'aria-hidden': 'true', text: '→' }))
      )
    ),
    mobileTabs
  );

  /* ---------- Hero ---------- */
  const heroBadgeText = h('span', { text: initCopy.hero.badge });
  const heroShot = shotFrame({
    image: {
      src: '/assets/img/home/hero-ledger.webp',
      alt: initCopy.hero.shotAlt,
      path: initCopy.hero.shotPath,
      width: 1020,
      height: 660
    },
    test: 'home-hero-shot',
    badge: h('div', { class: 'tn-home-shot-badge tn-home-hero-badge', 'data-test': 'home-hero-badge' },
      h('span', { class: 'tn-home-badge-dot', 'aria-hidden': 'true' }),
      heroBadgeText)
  });

  const heroEyebrowText = h('span', { text: initCopy.hero.eyebrow });
  const heroBrandEl = h('span', { class: 'tn-home-hero-brand', text: initCopy.hero.brand });
  const heroSloganEl = h('span', { class: 'tn-home-hero-slogan', text: initCopy.hero.slogan });
  const heroLeadText = document.createTextNode(initCopy.hero.copy);
  const heroEmEl = h('span', { class: 'tn-home-hero-em', text: initCopy.hero.emphasis });
  const heroPrimaryText = h('span', { text: loggedIn ? initCopy.hero.ctaEnterApp : initCopy.hero.ctaLogin });
  const heroHowLink = h('a', { class: 'tn-home-btn tn-home-btn-secondary tn-home-btn-lg', href: '#details', 'data-test': 'home-cta-how', text: initCopy.hero.ctaHow });
  const stepsTagEl = h('span', { class: 'tn-home-mono-tag', text: initCopy.hero.stepsTag });
  const stepsSmallEl = h('span', { class: 'tn-home-small', text: initCopy.hero.stepsSmall });
  const stepNums = ['①', '②', '③'];
  const stepTextEls = initCopy.hero.steps.map((text) => h('span', { text }));

  bind((copy) => {
    heroEyebrowText.textContent = copy.hero.eyebrow;
    heroBrandEl.textContent = copy.hero.brand;
    heroSloganEl.textContent = copy.hero.slogan;
    heroLeadText.nodeValue = copy.hero.copy;
    heroEmEl.textContent = copy.hero.emphasis;
    heroPrimaryText.textContent = loggedIn ? copy.hero.ctaEnterApp : copy.hero.ctaLogin;
    heroHowLink.textContent = copy.hero.ctaHow;
    stepsTagEl.textContent = copy.hero.stepsTag;
    stepsSmallEl.textContent = copy.hero.stepsSmall;
    stepTextEls.forEach((node, idx) => { node.textContent = copy.hero.steps[idx]; });
    heroShot.img.alt = copy.hero.shotAlt;
    heroShot.pathEl.textContent = copy.hero.shotPath;
    heroBadgeText.textContent = copy.hero.badge;
  });

  const hero = h('section', { class: 'tn-home-hero', id: 'top', 'aria-labelledby': 'home-hero-title' },
    h('div', { class: 'tn-home-hero-copy' },
      h('div', { class: 'tn-home-hero-eyebrow tn-home-hero-in' },
        h('span', { class: 'tn-home-badge-dot', 'aria-hidden': 'true' }),
        heroEyebrowText),
      h('h1', { class: 'tn-home-hero-title tn-home-hero-in', id: 'home-hero-title' },
        heroBrandEl,
        heroSloganEl),
      h('p', { class: 'tn-home-hero-copytext tn-home-hero-in', 'data-hero-delay': '1' },
        heroLeadText,
        heroEmEl),
      h('div', { class: 'tn-home-hero-actions tn-home-hero-in', 'data-hero-delay': '2' },
        h('a', { class: 'tn-home-btn tn-home-btn-primary tn-home-btn-lg', href: loggedIn ? '/' : loginHref, 'data-test': 'home-cta-login', onclick: goPrimary },
          heroPrimaryText, h('span', { class: 'tn-home-btn-arrow', 'aria-hidden': 'true', text: '→' })),
        heroHowLink),
      h('div', { class: 'tn-home-steps tn-home-hero-in', 'data-hero-delay': '3', 'data-test': 'home-steps' },
        h('div', { class: 'tn-home-steps-label' }, stepsTagEl, stepsSmallEl),
        h('ol', { class: 'tn-home-steps-list' },
          ...stepNums.map((num, idx) => h('li', {}, h('span', { class: 'tn-home-step-num', text: num }), stepTextEls[idx]))))
    ),
    h('div', { class: 'tn-home-hero-visual tn-home-hero-in', 'data-hero-delay': '2' }, heroShot.frame)
  );

  /* ---------- Details ---------- */
  const detailPills = h('div', { class: 'tn-home-detail-pills' });
  const detailPillLabels = initCopy.features.map((item) => {
    const labelSpan = h('span', { text: item.label });
    detailPills.append(h('a', {
      class: 'tn-home-detail-pill', href: `#${item.id}`, 'data-test': `home-detail-${item.id}`
    }, h('span', { class: 'tn-home-detail-num', text: item.index }), labelSpan));
    return labelSpan;
  });
  const detailsMainEl = h('p', { class: 'tn-home-detail-main', id: 'home-details-title' }, initCopy.details.main);
  const detailsSubEl = h('p', { class: 'tn-home-detail-sub', text: initCopy.details.sub });
  bind((copy) => {
    detailsMainEl.textContent = copy.details.main;
    detailsSubEl.textContent = copy.details.sub;
    detailPillLabels.forEach((node, idx) => { node.textContent = copy.features[idx].label; });
  });
  const details = h('section', { class: 'tn-home-details', id: 'details', 'aria-labelledby': 'home-details-title' },
    h('div', { class: 'tn-home-detail-card tn-home-reveal' },
      detailsMainEl,
      detailsSubEl,
      detailPills)
  );

  /* ---------- Features ---------- */
  const features = h('div', { class: 'tn-home-features' },
    ...initCopy.features.map((feature, idx) => featureSection(feature, idx, bind)));

  /* ---------- Start / Trust / Footer ---------- */
  const startEyebrow = h('span', { text: initCopy.start.eyebrow });
  const startTitle = h('h2', { class: 'tn-home-start-title', id: 'home-start-title', text: initCopy.start.title });
  const startSub = h('p', { class: 'tn-home-start-sub', text: initCopy.start.sub });
  const footerPrimaryText = h('span', { text: loggedIn ? initCopy.start.enterApp : initCopy.start.login });
  const footerDownload = pluginDownloadLink({
    class: 'tn-home-btn tn-home-btn-outline-light tn-home-btn-lg',
    label: initCopy.start.download,
    test: 'home-footer-download'
  });
  const helpBtn = h('button', {
    class: 'tn-home-btn tn-home-btn-ghost-light tn-home-btn-lg',
    type: 'button',
    'data-test': 'home-plugin-help',
    text: initCopy.start.help,
    onclick: () => openPluginHelp()
  });
  const trustNodes = initCopy.trust.map(([title, desc]) => {
    const strongEl = h('strong', { text: title });
    const descEl = h('span', { text: desc });
    const item = h('div', { class: 'tn-home-trust-item' }, strongEl, descEl);
    return { item, strongEl, descEl };
  });
  const footerBrandText = h('span', { text: initCopy.footer.brand });
  const footerNoteEl = h('p', { class: 'tn-home-footer-note', text: initCopy.footer.note });

  bind((copy) => {
    startEyebrow.textContent = copy.start.eyebrow;
    startTitle.textContent = copy.start.title;
    startSub.textContent = copy.start.sub;
    footerPrimaryText.textContent = loggedIn ? copy.start.enterApp : copy.start.login;
    footerDownload.textContent = copy.start.download;
    footerDownload.title = copy.nav.downloadTitle;
    helpBtn.textContent = copy.start.help;
    trustNodes.forEach((node, idx) => {
      const [nextTitle, nextDesc] = copy.trust[idx];
      node.strongEl.textContent = nextTitle;
      node.descEl.textContent = nextDesc;
    });
    footerBrandText.textContent = copy.footer.brand;
    footerNoteEl.textContent = copy.footer.note;
  });

  const start = h('section', { class: 'tn-home-start', id: 'start', 'aria-labelledby': 'home-start-title' },
    h('div', { class: 'tn-home-start-card tn-home-reveal' },
      h('div', { class: 'tn-home-start-copy' },
        h('div', { class: 'tn-home-eyebrow is-light' }, startEyebrow),
        startTitle,
        startSub),
      h('div', { class: 'tn-home-start-actions' },
        h('a', { class: 'tn-home-btn tn-home-btn-light tn-home-btn-lg', href: loggedIn ? '/' : loginHref, 'data-test': 'home-footer-login', onclick: goPrimary },
          footerPrimaryText, h('span', { class: 'tn-home-btn-arrow', 'aria-hidden': 'true', text: '→' })),
        footerDownload,
        helpBtn)),
    h('div', { class: 'tn-home-trust tn-home-reveal', 'data-reveal-delay': '1' }, ...trustNodes.map((n) => n.item)),
    h('footer', { class: 'tn-home-footer' },
      h('div', { class: 'tn-home-footer-brand' }, brandMark(), footerBrandText),
      footerNoteEl)
  );

  const page = h('div', { class: 'tn-home', 'data-test': 'home-page', 'data-lang': currentLang },
    h('div', { class: 'tn-home-sentinel', 'aria-hidden': 'true' }),
    navBar,
    h('main', { class: 'tn-home-main' }, hero, details, features, start)
  );
  root.append(page);

  /* ---------- 语言应用与原地切换 ---------- */
  function applyLang(lang, { persist = false } = {}) {
    currentLang = lang === 'en' ? 'en' : 'zh';
    if (persist) persistHomeLang(currentLang);
    const copy = HOME_COPY[currentLang];
    page.dataset.lang = currentLang;
    document.documentElement.lang = copy.htmlLang;
    document.title = copy.docTitle;
    setMetaDescription(copy.metaDescription);
    const isEn = currentLang === 'en';
    langZhBtn.classList.toggle('is-active', !isEn);
    langZhBtn.setAttribute('aria-pressed', isEn ? 'false' : 'true');
    langEnBtn.classList.toggle('is-active', isEn);
    langEnBtn.setAttribute('aria-pressed', isEn ? 'true' : 'false');
    for (const update of updaters) update(copy);
  }

  function switchLang(nextLang) {
    if (nextLang === currentLang) return;
    const prevScrollY = window.scrollY;
    applyLang(nextLang, { persist: true });
    if (window.scrollY !== prevScrollY) {
      window.scrollTo({ top: prevScrollY, behavior: 'instant' });
    }
    requestAnimationFrame(() => {
      if (!page.isConnected) return;
      if (window.scrollY !== prevScrollY) {
        window.scrollTo({ top: prevScrollY, behavior: 'instant' });
      }
      placePill();
    });
    document.fonts?.ready?.then(() => {
      if (!page.isConnected) return;
      placePill();
    });
  }

  applyLang(currentLang, { persist: false });

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

  const initPillRaf = requestAnimationFrame(() => {
    if (!page.isConnected) return;
    setActiveTab(activeTab);
  });
  cleanups.push(() => cancelAnimationFrame(initPillRaf));
  document.fonts?.ready?.then(() => {
    if (!page.isConnected) return;
    placePill();
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
    cleanups.push(() => stop());
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
    document.documentElement.lang = HOME_COPY.zh.htmlLang;
    document.title = HOME_COPY.zh.docTitle;
    setMetaDescription(HOME_COPY.zh.metaDescription);
  };
}
