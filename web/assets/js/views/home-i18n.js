/* 官网首页中英文多语言字典与语言状态解析（零依赖）。 */

export const HOME_LANG_KEY = 'tounar.home.lang';

export function normalizeHomeLang(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'en' || v === 'zh') return v;
  return null;
}

export function resolveInitialHomeLang() {
  try {
    const fromQuery = normalizeHomeLang(new URLSearchParams(location.search).get('lang'));
    if (fromQuery) return fromQuery;
  } catch { /* ignore invalid URL */ }
  try {
    const fromStorage = normalizeHomeLang(localStorage.getItem(HOME_LANG_KEY));
    if (fromStorage) return fromStorage;
  } catch { /* ignore storage access error */ }
  return 'zh';
}

export function persistHomeLang(lang) {
  const normalized = normalizeHomeLang(lang) || 'zh';
  try {
    localStorage.setItem(HOME_LANG_KEY, normalized);
  } catch { /* ignore storage access error */ }
  return normalized;
}

export const HOME_COPY = {
  zh: {
    htmlLang: 'zh-CN',
    docTitle: 'Tounar 帮你理 — 让投递更省心',
    metaDescription: 'Tounar 帮你理：个人求职台账与 AI 助手。逛官网顺手记岗位，照 JD 改简历，招聘邮件自动推进状态。',
    brand: {
      ariaLabel: 'TOUNAR 帮你理 首页',
      name: 'TOUNAR',
      sub: '帮你理'
    },
    nav: {
      desktopAriaLabel: '核心功能',
      mobileAriaLabel: '核心功能（移动端）',
      tabs: {
        capture: '岗位抓取',
        resume: '简历改写',
        mail: '邮件追踪',
        assistant: 'AI 助手'
      },
      download: '下载插件',
      downloadTitle: '下载插件 ZIP，解压后用 Chrome 加载已解压的扩展程序',
      login: '登录 / 开始使用',
      enterApp: '进入工作台'
    },
    hero: {
      eyebrow: 'Tounar 帮你理 · 个人求职台账与 AI 助手',
      brand: 'Tounar 帮你理',
      slogan: '让投递更省心',
      copy: '逛官网时顺手记下岗位，改简历时照着 JD 逐条对齐，面试邮件来了自动推进状态。',
      emphasis: '你只管准备面试，琐碎的事交给我们理清楚。',
      ctaLogin: '立即登录，开始整理',
      ctaEnterApp: '进入工作台',
      ctaHow: '看看怎么用 ↓',
      stepsTag: '直接开始',
      stepsSmall: '3 步上手',
      steps: [
        '邮箱验证码登录',
        '装好插件或连上招聘邮箱',
        '照常逛官网、投简历，台账自动归位'
      ],
      shotPath: 'tounar · 投递台账',
      shotAlt: 'Tounar 投递台账：累计投递、进行中、面试中统计与多条不同状态的岗位记录',
      badge: 'AI 助手：已按目标 JD 拆解 3 处简历改写建议'
    },
    details: {
      main: '投到第 30 个岗位时，最累的往往不是面试，而是记不清自己投了谁、发了哪版简历、该不该去催进度。',
      sub: '不替你海投，也不瞎编经历。Tounar 帮你理只做四件实在的事：'
    },
    features: [
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
        },
        badges: {
          strong: '官网插件已捕获',
          toggleAriaLabel: '采集状态示例',
          viewed: '看过没投',
          applied: '已投递'
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
        },
        badges: {
          prompt: '已融入个性化要求',
          exportTag: 'DOCX',
          exportText: '按标准模板一键导出'
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
        },
        badges: {
          flowAriaLabel: '邮件自动推进示例',
          steps: ['一面', '二面', '三面'],
          due: '⏰ 7 天未推进定期回看'
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
        },
        badges: {
          pills: [
            { text: '意向：AI 产品', warn: false },
            { text: '城市：上海/杭州', warn: false },
            { text: '避雷：外包', warn: true }
          ]
        }
      }
    ],
    start: {
      eyebrow: '准备开始',
      title: '准备好把投递理清楚了吗？',
      sub: '无需复杂配置，邮箱验证码登录即可开始；支持随时下载浏览器插件或按需连接招聘邮箱。',
      login: '立即登录',
      enterApp: '进入工作台',
      download: '下载浏览器插件',
      help: '查看插件安装指引'
    },
    trust: [
      ['按需授权', '插件与邮箱独立开关，不开也能手动补录。'],
      ['不留敏感原文', '不读附件、不存正文、不传 Cookie。'],
      ['随时可撤回', '一键断开授权，或彻底删除全部数据。']
    ],
    footer: {
      brand: 'Tounar · 帮你理 — 让投递更省心',
      note: '内测说明：当前面向受邀用户开放，老账号可直接邮箱登录。'
    }
  },
  en: {
    htmlLang: 'en',
    docTitle: 'Tounar — Keep every job application in sync',
    metaDescription: 'Tounar: Personal job application tracker and AI copilot. Capture roles as you browse, tailor resumes to each JD, and auto-sync interview emails.',
    brand: {
      ariaLabel: 'Tounar Home',
      name: 'TOUNAR',
      sub: 'Job Tracker'
    },
    nav: {
      desktopAriaLabel: 'Core Features',
      mobileAriaLabel: 'Core Features (Mobile)',
      tabs: {
        capture: 'Auto-Capture',
        resume: 'Resume Tailor',
        mail: 'Email Sync',
        assistant: 'AI Copilot'
      },
      download: 'Get Extension',
      downloadTitle: 'Download extension ZIP, unzip, and load unpacked in Chrome',
      login: 'Sign In',
      enterApp: 'Open App'
    },
    hero: {
      eyebrow: 'Tounar · Job Tracker & AI Copilot',
      brand: 'Tounar',
      slogan: 'Apply smarter. Stay organized.',
      copy: 'Save roles as you browse. Tailor resumes to each JD. Let interview emails update your tracker automatically.',
      emphasis: 'Focus on interviews. Leave the tracking to us.',
      ctaLogin: 'Start Tracking',
      ctaEnterApp: 'Open Workspace',
      ctaHow: 'See how it works ↓',
      stepsTag: 'Quick Start',
      stepsSmall: '3 steps',
      steps: [
        'Sign in with your email',
        'Add the extension or link your inbox',
        'Browse & apply—your tracker updates itself'
      ],
      shotPath: 'tounar · application tracker',
      shotAlt: 'Tounar application tracker showing total applications, active roles, interviews, and status rows',
      badge: 'AI Copilot: 3 tailored resume edits ready for this JD'
    },
    details: {
      main: "After 30 applications, the hardest part isn't the interview. It's remembering where you applied, which resume you sent, and when to follow up.",
      sub: 'No mass-applying. No made-up experience. Just four tools that work:'
    },
    features: [
      {
        id: 'capture',
        index: '01',
        label: 'Auto-Capture',
        slogan: 'Save roles as you browse. Never lose track.',
        intro: 'Browse and apply on company career sites as usual. Log both Applied and Saved roles automatically—no more spreadsheets.',
        points: [
          ['Capture right on career sites', 'Browse as usual. The extension grabs the company, role, and full JD quietly.'],
          ['Bookmark before you apply', 'Save interesting roles for later. Move them to your tracker in one click.'],
          ['Only pages you visit', 'No background scraping. No passwords or cookies touched. Undo anytime.']
        ],
        image: {
          src: '/assets/img/home/feature-capture.webp',
          alt: 'Captured leads preview showing company, role, and full JD from the browser extension',
          path: 'tounar · inbox · captured leads',
          width: 960,
          height: 600
        },
        badges: {
          strong: 'Captured from site',
          toggleAriaLabel: 'Capture status demo',
          viewed: 'Saved',
          applied: 'Applied'
        }
      },
      {
        id: 'resume',
        index: '02',
        label: 'Resume Tailor',
        slogan: 'Tailor your resume to the JD. Stay honest. Export fast.',
        intro: 'Pick a target role from your tracker. Align your real experience to the JD, add custom instructions, and export cleanly.',
        points: [
          ['Check your fit first', 'Spot hard requirements, strengths, and gaps before you start editing.'],
          ['Guide edits your way', 'Highlight a project, trim length, or focus on metrics—zero fabricated facts.'],
          ['Review side by side & export', 'See every change highlighted next to your original text. Export DOCX in one click.']
        ],
        image: {
          src: '/assets/img/home/feature-resume.webp',
          alt: 'Side-by-side resume tailoring workspace highlighting tailored edits next to original text',
          path: 'tounar · resume studio',
          width: 960,
          height: 600
        },
        badges: {
          prompt: 'Custom prompt applied',
          exportTag: 'DOCX',
          exportText: 'One-click template export'
        }
      },
      {
        id: 'mail',
        index: '03',
        label: 'Email Sync',
        slogan: 'New interview email? Your status updates itself.',
        intro: 'Connect your recruiting inbox to catch assessments, interviews, and offers automatically. Get nudged when a role goes quiet.',
        points: [
          ['Update stages automatically', 'Move roles from Applied → OA → Round 1 → Round 2 → Offer as emails arrive.'],
          ['Follow up on time', 'Set a quiet-day threshold (like 7 days) and get a clean follow-up list.'],
          ['Built for privacy', 'Scans job updates only. Never reads attachments or stores raw emails. Disconnect anytime.']
        ],
        image: {
          src: '/assets/img/home/feature-mail.webp',
          alt: 'Application timeline showing automated email updates from Applied through interviews',
          path: 'tounar · tracker · status timeline',
          width: 960,
          height: 600
        },
        badges: {
          flowAriaLabel: 'Email auto-sync demo',
          steps: ['Round 1', 'Round 2', 'Round 3'],
          due: '⏰ 7-day quiet nudge'
        }
      },
      {
        id: 'assistant',
        index: '04',
        label: 'AI Copilot',
        slogan: 'Ask your tracker anything. Compare roles. Act faster.',
        intro: 'Your copilot knows your pipeline, resumes, and goals. Check schedules, compare roles, and save preferences in plain English.',
        points: [
          ['Manage your tracker by chat', 'Ask "What interviews do I have this week?" or "Mark Acme as Round 2"—confirm once to apply.'],
          ['Compare roles side by side', 'Weigh multiple openings against your resume to decide what to prep first.'],
          ['Remember your preferences', 'Save target roles, cities, pay floors, and deal-breakers so advice gets sharper.']
        ],
        image: {
          src: '/assets/img/home/feature-assistant.webp',
          alt: 'AI copilot drawer showing tracker summaries, role comparisons, and confirmation cards',
          path: 'tounar · ai copilot',
          width: 960,
          height: 620
        },
        badges: {
          pills: [
            { text: 'Role: AI Product', warn: false },
            { text: 'City: Shanghai / Remote', warn: false },
            { text: 'Avoid: Outsourcing', warn: true }
          ]
        }
      }
    ],
    start: {
      eyebrow: 'Get Started',
      title: 'Ready to organize your job search?',
      sub: "Sign in with an email code in seconds. Add the Chrome extension or connect your inbox whenever you're ready.",
      login: 'Sign In Now',
      enterApp: 'Open Workspace',
      download: 'Get Chrome Extension',
      help: 'Install Guide'
    },
    trust: [
      ['Authorize on your terms', 'Extension and email sync are optional. Add roles manually anytime.'],
      ['No raw data stored', 'No attachments read, no email bodies saved, no cookies shared.'],
      ['Revoke anytime', 'Disconnect access or wipe all your data in one click.']
    ],
    footer: {
      brand: 'Tounar — Keep every application in sync',
      note: 'Invite-only beta. Existing accounts can sign in directly with email.'
    }
  }
};
