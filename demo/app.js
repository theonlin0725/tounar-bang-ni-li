/* =========================================================
   帮你理 · 交互设计演示
   Vanilla JS. All data is local demo data; no network calls.
   Reviewer panel (bottom right) switches the states in the PRDs.
   ========================================================= */
(() => {
'use strict';

/* ---------------------------------------------------------
   0. Constants & icons
   --------------------------------------------------------- */

const AS_OF = '2026-10-21';
const NOW = '2026-10-21 10:42';
const ACCOUNT_EMAIL = 'ming@tounar.demo';

const STATUS = {
  pending:    { label: '待投递', cls: 'pending' },
  applied:    { label: '已投递', cls: 'applied' },
  assessment: { label: '笔试中', cls: 'assessment' },
  interview:  { label: '面试中', cls: 'interview' },
  offer:      { label: 'offer',  cls: 'offer' },
  rejected:   { label: '已拒',   cls: 'rejected' },
  closed:     { label: '已结束', cls: 'closed' }
};

const SOURCE_LABEL = { plugin: '插件采集', mail: '招聘邮件', manual: '用户补录' };
const CHANNELS = ['企业官网', 'BOSS Web', '牛客 Web', '内推表单', '手动补录'];
const TERMINAL = ['offer', 'rejected', 'closed'];

const I = {
  search: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="4.4"/><path d="m10.3 10.3 3.1 3.1"/></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  alert: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.4 14.1 13H1.9L8 2.4Z"/><path d="M8 6.1v3.2"/><path d="M8 11.4h.01"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="m5.2 8.2 1.9 1.9 3.8-4"/></svg>',
  info: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v3.4"/><path d="M8 5.2h.01"/></svg>',
  refresh: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.9v2.6h-2.6"/></svg>',
  external: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5H3.4v9.1h9.1V9.5"/><path d="M9.4 3.1h3.5v3.5"/><path d="m8.2 7.8 4.7-4.7"/></svg>',
  lock: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="3.2" y="7" width="9.6" height="6.4" rx="1.2"/><path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7"/></svg>',
  mail: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.4" width="12" height="9.2" rx="1.2"/><path d="m2.6 4.2 5.4 4.2 5.4-4.2"/></svg>',
  plug: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3.2M10 2v3.2"/><path d="M4.4 5.2h7.2v2.3A3.6 3.6 0 0 1 8 11.1a3.6 3.6 0 0 1-3.6-3.6V5.2Z"/><path d="M8 11.1V14"/></svg>',
  arrow: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8h8.6"/><path d="m8.8 4.5 3.5 3.5-3.5 3.5"/></svg>',
  chevron: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4.5 6.2 3.5 3.5 3.5-3.5"/></svg>'
};

/* ---------------------------------------------------------
   1. Demo data
   --------------------------------------------------------- */

const H = (at, from, to, by, note) => ({ at, from, to, by, note });

const A = (o) => Object.assign({
  city: '北京', batch: '2027 届秋招', jd: '', channel: '企业官网',
  status: 'applied', roundLabel: '', appliedAt: '', appliedTime: '',
  lastStatusChangedAt: '', updatedAt: '', jobUrl: '', statusUrl: '', statusScope: '',
  sources: ['plugin'], confidence: 0.9, archived: false, archivedReason: '',
  history: [], lastSiteObservedAt: '', lastReviewedAt: '', deadlineAt: ''
}, o);

const INITIAL_APPS = [
  A({
    id: 'app_01', company: '字节跳动', title: '产品经理（国际化）',
    city: '北京', batch: '2027 届秋招',
    jd: '负责国际化产品的需求梳理与版本推进，协同增长、设计与本地化团队，跟踪核心指标并输出迭代方案。',
    channel: '企业官网', status: 'interview', roundLabel: '一面',
    appliedAt: '2026-10-03', appliedTime: '2026-10-03 11:42',
    lastStatusChangedAt: '2026-10-18 14:20', updatedAt: '2026-10-18 14:20',
    jobUrl: 'https://jobs.bytedance.com/', statusUrl: 'https://jobs.bytedance.com/campus/applications', statusScope: 'application',
    sources: ['plugin', 'mail'], confidence: 0.96,
    lastSiteObservedAt: '2026-10-20 22:10',
    history: [
      H('2026-10-03 11:42', '待投递', '已投递', '插件采集', '提交成功页与岗位标识匹配'),
      H('2026-10-18 14:20', '已投递', '面试中', '招聘邮件', '面试邀请 · 一面')
    ]
  }),
  A({
    id: 'app_02', company: '腾讯', title: '产品策划（微信小游戏出海）',
    city: '深圳', batch: '2027 届秋招',
    jd: '参与微信小游戏出海产品的策略设计，负责需求分析、版本规划与跨团队推进，关注海外用户增长。',
    channel: '企业官网', status: 'assessment',
    appliedAt: '2026-10-09', appliedTime: '2026-10-09 09:12',
    lastStatusChangedAt: '2026-10-19 09:05', updatedAt: '2026-10-19 09:05',
    jobUrl: 'https://careers.tencent.com/', statusUrl: 'https://careers.tencent.com/', statusScope: 'company',
    sources: ['plugin', 'mail'], confidence: 0.92,
    lastSiteObservedAt: '2026-10-17 20:40',
    history: [
      H('2026-10-09 09:12', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-10-19 09:05', '已投递', '笔试中', '招聘邮件', '在线测评邀请')
    ]
  }),
  A({
    id: 'app_03', company: '美团', title: '产品运营（到店）',
    city: '北京', batch: '2027 届秋招',
    jd: '负责到店业务的产品运营，围绕商家与用户侧活动做策略落地、数据分析与复盘，推动跨团队协作。',
    channel: '企业官网', status: 'applied',
    appliedAt: '2026-09-30', appliedTime: '2026-09-30 11:22',
    lastStatusChangedAt: '2026-09-30 11:22', updatedAt: '2026-09-30 11:22',
    jobUrl: 'https://zhaopin.meituan.com/', statusUrl: '', statusScope: '',
    sources: ['plugin'], confidence: 0.94,
    lastSiteObservedAt: '',
    history: [H('2026-09-30 11:22', '待投递', '已投递', '插件采集', '提交成功页命中')]
  }),
  A({
    id: 'app_04', company: '携程', title: '国际业务产品运营',
    city: '上海', batch: '2027 届秋招',
    jd: '面向国际市场的产品运营，负责多语言内容、渠道活动与用户反馈闭环，支持海外业务增长。',
    channel: '企业官网', status: 'applied',
    appliedAt: '2026-10-03', appliedTime: '2026-10-03 16:40',
    lastStatusChangedAt: '2026-10-03 16:40', updatedAt: '2026-10-03 16:40',
    jobUrl: 'https://careers.trip.com/', statusUrl: 'https://careers.trip.com/', statusScope: 'company',
    sources: ['plugin'], confidence: 0.9,
    lastSiteObservedAt: '',
    history: [H('2026-10-03 16:40', '待投递', '已投递', '插件采集', '提交成功页命中')]
  }),
  A({
    id: 'app_05', company: '大疆', title: '产品运营（海外电商）',
    city: '深圳', batch: '2027 届秋招',
    jd: '负责海外电商平台的产品运营，协同内容、投放与区域团队，优化商品信息与转化路径。',
    channel: '企业官网', status: 'applied',
    appliedAt: '2026-10-07', appliedTime: '2026-10-07 10:15',
    lastStatusChangedAt: '2026-10-07 10:15', updatedAt: '2026-10-07 10:15',
    jobUrl: 'https://we.dji.com/', statusUrl: 'https://we.dji.com/status', statusScope: 'application',
    sources: ['plugin'], confidence: 0.93,
    lastSiteObservedAt: '2026-10-16 18:05',
    history: [H('2026-10-07 10:15', '待投递', '已投递', '插件采集', '提交成功页命中')]
  }),
  A({
    id: 'app_06', company: '阿里巴巴', title: '内容运营（淘天）',
    city: '杭州', batch: '2027 届秋招',
    jd: '负责淘天内容场域的运营策略，搭建内容供给与分发机制，结合数据优化用户消费体验。',
    channel: '企业官网', status: 'interview', roundLabel: '二面',
    appliedAt: '2026-09-28', appliedTime: '2026-09-28 19:02',
    lastStatusChangedAt: '2026-10-16 19:30', updatedAt: '2026-10-16 19:30',
    jobUrl: 'https://talent.alibaba.com/', statusUrl: 'https://talent.alibaba.com/application', statusScope: 'application',
    sources: ['plugin', 'mail'], confidence: 0.95,
    lastSiteObservedAt: '2026-10-18 12:20',
    history: [
      H('2026-09-28 19:02', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-10-09 10:10', '已投递', '面试中', '招聘邮件', '面试邀请 · 一面'),
      H('2026-10-16 19:30', '面试中', '面试中', '招聘邮件', '二面改期 · 面次更新')
    ]
  }),
  A({
    id: 'app_07', company: '小米', title: '产品经理（AIoT）',
    city: '北京', batch: '2027 届秋招',
    jd: '负责 AIoT 产品线的需求定义与体验设计，协调软硬件团队推进版本，跟踪关键指标。',
    channel: '企业官网', status: 'interview', roundLabel: '一面',
    appliedAt: '2026-10-12', appliedTime: '2026-10-12 14:08',
    lastStatusChangedAt: '2026-10-20 11:20', updatedAt: '2026-10-20 11:20',
    jobUrl: 'https://hr.xiaomi.com/', statusUrl: '', statusScope: '',
    sources: ['mail', 'plugin'], confidence: 0.93,
    lastSiteObservedAt: '',
    history: [
      H('2026-10-12 14:08', '待投递', '已投递', '插件采集', '提交成功页命中'),
      H('2026-10-20 11:20', '已投递', '面试中', '招聘邮件', '面试邀请 · 面次由邮件明确')
    ]
  }),
  A({
    id: 'app_08', company: '京东', title: '用户运营（零售）',
    city: '北京', batch: '2027 届秋招',
    jd: '负责零售业务的用户增长与分层运营，设计权益与触达策略，跟踪转化并持续优化。',
    channel: '企业官网', status: 'rejected',
    appliedAt: '2026-09-24', appliedTime: '2026-09-24 10:30',
    lastStatusChangedAt: '2026-10-11 10:02', updatedAt: '2026-10-11 10:02',
    jobUrl: 'https://zhaopin.jd.com/', statusUrl: 'https://zhaopin.jd.com/', statusScope: 'company',
    sources: ['plugin', 'mail'], confidence: 0.97,
    lastSiteObservedAt: '2026-10-12 09:40',
    history: [
      H('2026-09-24 10:30', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-10-11 10:02', '已投递', '已拒', '招聘邮件', '感谢信，置信度 0.97，自动更新')
    ]
  }),
  A({
    id: 'app_09', company: '快手', title: '产品运营（商业化）',
    city: '北京', batch: '2027 届秋招',
    jd: '面向商业化客户的产品运营，负责投放产品的问题定位、策略优化与行业解决方案沉淀。',
    channel: '企业官网', status: 'closed',
    appliedAt: '2026-09-20', appliedTime: '2026-09-20 15:10',
    lastStatusChangedAt: '2026-10-08 15:30', updatedAt: '2026-10-08 15:30',
    jobUrl: 'https://zhaopin.kuaishou.cn/', statusUrl: '', statusScope: '',
    sources: ['plugin', 'mail'], confidence: 0.95,
    lastSiteObservedAt: '2026-10-08 15:30',
    history: [
      H('2026-09-20 15:10', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-10-08 15:30', '已投递', '已结束', '招聘邮件', '岗位关闭通知')
    ]
  }),
  A({
    id: 'app_10', company: '小红书', title: '社区产品运营',
    city: '上海', batch: '2027 届秋招',
    jd: '负责社区内容与创作者运营，策划话题活动，分析内容供给与互动数据，推动产品改进。',
    channel: '企业官网', status: 'assessment',
    appliedAt: '2026-10-14', appliedTime: '2026-10-14 20:15',
    lastStatusChangedAt: '2026-10-20 09:40', updatedAt: '2026-10-20 09:40',
    jobUrl: 'https://job.xiaohongshu.com/', statusUrl: 'https://job.xiaohongshu.com/', statusScope: 'company',
    sources: ['mail', 'plugin'], confidence: 0.89,
    lastSiteObservedAt: '',
    history: [
      H('2026-10-14 20:15', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-10-20 09:40', '已投递', '笔试中', '招聘邮件', '在线测评邀请')
    ]
  }),
  A({
    id: 'app_11', company: '网易', title: '游戏运营（雷火）',
    city: '杭州', batch: '2027 届秋招',
    jd: '负责游戏产品的版本运营与玩家活动，协同研发与发行团队，跟踪留存与付费表现。',
    channel: '企业官网', status: 'applied',
    appliedAt: '2026-10-15', appliedTime: '2026-10-15 13:25',
    lastStatusChangedAt: '2026-10-15 13:25', updatedAt: '2026-10-15 13:25',
    jobUrl: 'https://hr.163.com/', statusUrl: '', statusScope: '',
    sources: ['plugin'], confidence: 0.91,
    lastSiteObservedAt: '',
    history: [H('2026-10-15 13:25', '待投递', '已投递', '插件采集', '提交成功页命中')]
  }),
  A({
    id: 'app_12', company: '得物', title: '产品运营（社区）',
    city: '上海', batch: '2027 届秋招',
    jd: '负责社区内容与话题运营，设计创作者激励机制，结合数据提升内容供给与互动。',
    channel: '企业官网', status: 'applied',
    appliedAt: '2026-10-17', appliedTime: '2026-10-17 11:05',
    lastStatusChangedAt: '2026-10-17 11:05', updatedAt: '2026-10-17 11:05',
    jobUrl: 'https://careers.dewu.com/', statusUrl: '', statusScope: '',
    sources: ['plugin'], confidence: 0.9,
    lastSiteObservedAt: '',
    history: [H('2026-10-17 11:05', '待投递', '已投递', '插件采集', '提交成功页命中')]
  }),
  A({
    id: 'app_13', company: '蔚来', title: '用户产品经理',
    city: '合肥', batch: '2027 届秋招',
    jd: '负责用户侧产品规划与体验设计，围绕社区、服务与车主权益，推进跨端产品落地。',
    channel: '内推表单', status: 'offer',
    appliedAt: '2026-10-01', appliedTime: '2026-10-01 09:50',
    lastStatusChangedAt: '2026-10-20 17:45', updatedAt: '2026-10-20 17:45',
    jobUrl: 'https://www.nio.com/careers', statusUrl: 'https://www.nio.com/careers', statusScope: 'company',
    sources: ['mail', 'plugin', 'manual'], confidence: 0.98,
    lastSiteObservedAt: '2026-10-19 10:30', lastReviewedAt: '2026-10-19 10:35',
    history: [
      H('2026-10-01 09:50', '待投递', '已投递', '插件采集', '内推表单提交成功'),
      H('2026-10-15 16:20', '已投递', '面试中', '招聘邮件', '面试邀请 · 二面'),
      H('2026-10-20 17:45', '面试中', 'offer', '招聘邮件', '录用意向，置信度 0.98')
    ]
  }),
  A({
    id: 'app_14', company: 'SHEIN', title: '商品运营（海外）',
    city: '广州', batch: '2027 届秋招',
    jd: '负责海外站点商品运营，围绕选品、定价与上新节奏做数据分析，协同供应链团队。',
    channel: '企业官网', status: 'applied',
    appliedAt: '2026-10-19', appliedTime: '2026-10-19 21:10',
    lastStatusChangedAt: '2026-10-19 21:10', updatedAt: '2026-10-19 21:10',
    jobUrl: 'https://careers.shein.com/', statusUrl: 'https://careers.shein.com/', statusScope: 'company',
    sources: ['plugin'], confidence: 0.92,
    lastSiteObservedAt: '',
    history: [H('2026-10-19 21:10', '待投递', '已投递', '插件采集', '提交成功页命中')]
  }),
  A({
    id: 'app_15', company: '拼多多', title: '运营管培生',
    city: '上海', batch: '2027 届秋招',
    jd: '面向运营方向的管培岗位，轮岗参与商品、活动与用户运营，完成阶段性项目。',
    channel: '企业官网', status: 'rejected',
    appliedAt: '2026-09-10', appliedTime: '2026-09-10 10:00',
    lastStatusChangedAt: '2026-09-28 16:12', updatedAt: '2026-09-28 16:12',
    jobUrl: 'https://careers.pinduoduo.com/', statusUrl: '', statusScope: '',
    sources: ['mail'], confidence: 0.96, archived: true, archivedReason: '用户归档 · 10-02',
    history: [
      H('2026-09-10 10:00', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-09-28 16:12', '已投递', '已拒', '招聘邮件', '感谢信')
    ]
  }),
  A({
    id: 'app_16', company: '哔哩哔哩', title: '内容运营（知识区）',
    city: '上海', batch: '2027 届秋招',
    jd: '负责知识区内容运营与创作者维护，策划专题活动，跟踪内容供给与消费数据。',
    channel: '企业官网', status: 'closed',
    appliedAt: '2026-09-05', appliedTime: '2026-09-05 14:20',
    lastStatusChangedAt: '2026-09-19 11:00', updatedAt: '2026-09-19 11:00',
    jobUrl: 'https://jobs.bilibili.com/', statusUrl: '', statusScope: '',
    sources: ['plugin'], confidence: 0.93, archived: true, archivedReason: '用户归档 · 09-25',
    history: [
      H('2026-09-05 14:20', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-09-19 11:00', '已投递', '已结束', '招聘邮件', '岗位关闭通知')
    ]
  }),
  A({
    id: 'app_17', company: '理想汽车', title: '产品运营（智能座舱）',
    city: '北京', batch: '2027 届秋招',
    jd: '负责智能座舱产品运营，收集用户反馈并推动版本优化，协同产品与研发团队。',
    channel: '企业官网', status: 'closed',
    appliedAt: '2026-09-12', appliedTime: '2026-09-12 09:30',
    lastStatusChangedAt: '2026-09-30 14:15', updatedAt: '2026-09-30 14:15',
    jobUrl: 'https://www.lixiang.com/careers', statusUrl: '', statusScope: '',
    sources: ['plugin'], confidence: 0.9, archived: true, archivedReason: '岗位关闭 · 09-30',
    history: [
      H('2026-09-12 09:30', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-09-30 14:15', '已投递', '已结束', '招聘邮件', '岗位关闭通知')
    ]
  }),
  A({
    id: 'app_18', company: '美团', title: '产品运营（外卖）',
    city: '上海', batch: '2027 届秋招',
    jd: '负责外卖业务的产品运营，围绕履约与商家侧体验做策略落地与数据复盘。',
    channel: '企业官网', status: 'closed',
    appliedAt: '2026-09-18', appliedTime: '2026-09-18 10:10',
    lastStatusChangedAt: '2026-09-26 10:05', updatedAt: '2026-09-26 10:05',
    jobUrl: 'https://zhaopin.meituan.com/', statusUrl: '', statusScope: '',
    sources: ['plugin'], confidence: 0.88, archived: true, archivedReason: '用户归档 · 10-01',
    history: [
      H('2026-09-18 10:10', '待投递', '已投递', '插件采集', '网申提交成功'),
      H('2026-09-26 10:05', '已投递', '已结束', '招聘邮件', '流程结束通知')
    ]
  })
];

const INITIAL_VIEWED = [
  {
    id: 'view_01', company: '阿里巴巴', title: '产品经理（本地生活）',
    city: '杭州', batch: '2027 届秋招',
    jd: '负责本地生活业务的产品规划与需求落地，协同运营、研发与商家团队推进项目。',
    channel: '企业官网', firstViewedAt: '2026-10-20 21:58', lastViewedAt: '2026-10-20 22:14',
    jobUrl: 'https://talent.alibaba.com/', archived: false, archivedReason: ''
  },
  {
    id: 'view_02', company: '拼多多', title: '产品管培生',
    city: '上海', batch: '2027 届秋招',
    jd: '面向产品方向的管培岗位，轮岗参与用户产品与增长项目，完成阶段性课题。',
    channel: '企业官网', firstViewedAt: '2026-10-19 10:12', lastViewedAt: '2026-10-19 10:31',
    jobUrl: 'https://careers.pinduoduo.com/', archived: false, archivedReason: ''
  },
  {
    id: 'view_03', company: '华为', title: '消费者产品经理',
    city: '深圳', batch: '2027 届秋招',
    jd: '负责消费者业务的产品定义与体验设计，跟踪市场与用户反馈，推动版本迭代。',
    channel: '企业官网', firstViewedAt: '2026-10-18 15:20', lastViewedAt: '2026-10-18 15:24',
    jobUrl: 'https://career.huawei.com/', archived: false, archivedReason: ''
  },
  {
    id: 'view_04', company: '招商银行', title: '金融科技管培生',
    city: '深圳', batch: '2027 届秋招',
    jd: '面向金融科技方向的管培岗位，参与数字化产品、数据与业务创新的轮岗项目。',
    channel: '企业官网', firstViewedAt: '2026-10-17 09:40', lastViewedAt: '2026-10-17 09:41',
    jobUrl: 'https://career.cmbchina.com/', archived: false, archivedReason: ''
  },
  {
    id: 'view_05', company: '中国移动', title: '产品经理（政企）',
    city: '北京', batch: '2027 届秋招',
    jd: '负责政企产品需求分析与方案设计，协同交付团队推进项目落地。',
    channel: '企业官网', firstViewedAt: '2026-09-15 16:10', lastViewedAt: '2026-09-15 16:18',
    jobUrl: 'https://job.10086.cn/', archived: true, archivedReason: '浏览 30 天未投 · 10-15 自动归档'
  }
];

const INITIAL_REVIEWS = [
  {
    id: 'rv_01', kind: '疑似提交', company: '百度', title: '产品运营（智能云）', city: '北京',
    reason: '页面出现「投递成功」文案，但未命中该站点的成功页模板；提交请求也没有成功响应体。',
    evidence: '“您的投递已提交成功” — 2026-10-20 21:36 / 百度校园招聘',
    suggestion: '确认已投递，并补充可信投递时间', confidence: 0.62,
    candidates: [], current: '无记录'
  },
  {
    id: 'rv_02', kind: '邮件多候选', company: '美团', title: '产品运营',
    city: '上海 / 北京',
    reason: '邮件只写了「产品运营」，你在美团有两条同名、不同城市的申请。不能默认选最近投递的一条。',
    evidence: '“恭喜你进入面试环节，具体安排将另行通知……” — 10-20 19:12 / 美团招聘',
    suggestion: '选择本人申请；无法匹配则建记录或忽略', confidence: 0.78,
    candidates: [
      { id: 'app_03', label: '美团 · 产品运营（到店）', meta: '北京 · 已投递 · 已投 21 天' },
      { id: 'app_18', label: '美团 · 产品运营（外卖）', meta: '上海 · 已结束 · 已归档' },
      { id: 'none', label: '无法匹配 — 保留待确认', meta: '不会自动认领，也不新增记录' }
    ],
    current: '未归属'
  },
  {
    id: 'rv_03', kind: '状态/字段冲突', company: '腾讯', title: '产品策划（微信小游戏出海）', city: '深圳',
    reason: '邮件建议进入面试，但没有写明面次；现有记录为「笔试中」。自动流程不覆盖冲突状态。',
    evidence: '“邀请你参加面试，具体时间另行通知” — 10-19 09:05 / 腾讯招聘',
    suggestion: '面试中（面次待确认）', confidence: 0.88,
    candidates: [], current: '笔试中'
  },
  {
    id: 'rv_04', kind: '终态候选', company: '得物', title: '产品运营（社区）', city: '上海',
    reason: '感谢信语义明确，但置信度未达到终态自动更新的阈值（0.90）。需要你确认，避免误关记录。',
    evidence: '“感谢你的关注，本次岗位已招满” — 10-18 16:40 / 得物招聘',
    suggestion: '已拒（终态）', confidence: 0.86,
    candidates: [], current: '已投递'
  },
  {
    id: 'rv_05', kind: '历史申请未知时间', company: '百度', title: '产品经理（ACG）', city: '北京',
    reason: '邮件可以证明申请存在，但没有可信投递时间。D12 未冻结，不能用收信日或今天补造投递日。',
    evidence: '“你的申请已进入筛选流程” — 2024-09-12 / 百度招聘',
    suggestion: '保留待确认（D12 未冻结）', confidence: 0.91,
    candidates: [], current: '无记录', blocked: true
  }
];

/* ---------------------------------------------------------
   2. State
   --------------------------------------------------------- */

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function freshState() {
  return {
    page: 'login',              // login | ledger | mail-preview | mail-landing
    authed: false,
    scenario: 'normal',
    view: 'applied',
    query: '', status: 'all', source: 'all', due: false,
    visibleCount: 20,
    apps: clone(INITIAL_APPS),
    viewed: clone(INITIAL_VIEWED),
    reviews: clone(INITIAL_REVIEWS),
    overlays: [],
    accountOpen: false,
    demoOpen: false,
    login: { step: 'email', email: '', error: '', countdown: 0, suspended: false },
    settings: { content: 'all', frequency: 'weekly', threshold: 14 },
    mail: { state: 'connected', address: 'm***@qq.com', mode: 'headline_body', lastSuccess: '2026-10-21 07:58', lastFailure: '' },
    plugin: {
      bound: true, device: 'MacBook Pro · Chrome 141',
      lastSeen: '2026-10-21 07:58', lastCollected: '2026-10-20 22:14',
      lastAccepted: '2026-10-20 22:14', revokedAt: '', cleanup: ''
    },
    landing: { phase: 'idle', at: '' },
    deletion: { outcome: 'partial', phase: 'idle', progress: 0, taskId: '' },
    logs: [],
    toast: null,
    lastFocus: null,
    hideTool: false
  };
}

const state = freshState();
let toastTimer = null;
let loginTimer = null;
let overlayFocusCount = 0;

/* ---------------------------------------------------------
   3. Utilities
   --------------------------------------------------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const p = dateStr.split('-').map(Number);
  if (p.length < 3 || p.some(isNaN)) return null;
  const a = Date.UTC(p[0], p[1] - 1, p[2]);
  const [y, m, d] = AS_OF.split('-').map(Number);
  const b = Date.UTC(y, m - 1, d);
  const n = Math.round((b - a) / 86400000);
  return n < 0 ? null : n;
}

function dayLabel(n) {
  if (n === null) return '投递时间待补';
  return n === 0 ? '今天投递' : '已投 ' + n + ' 天';
}

function shortAt(s) {
  if (!s) return '';
  return s.slice(5, 10) + ' ' + s.slice(11, 16);
}

function clock() {
  try {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) { return NOW.slice(11); }
}

function log(msg, key) {
  state.logs.unshift({ t: clock(), msg, key: !!key });
  if (state.logs.length > 40) state.logs.length = 40;
  renderDemo();
}

function toast(msg, kind) {
  state.toast = { msg, kind: kind || 'ok' };
  renderToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = null; renderToast(); }, 3800);
}

function scenarioConf() {
  const s = state.scenario;
  return {
    empty: s === 'empty',
    firstSync: s === 'first_sync',
    mailExpired: s === 'mail_expired',
    mailDegraded: s === 'mail_degraded',
    pluginStale: s === 'plugin_stale',
    stale: s === 'stale',
    unavailable: s === 'unavailable',
    asOf: s === 'stale' ? '2026-10-20 08:00' : '2026-10-21 08:00'
  };
}

function visibleApps() {
  const c = scenarioConf();
  if (c.empty || c.firstSync) return [];
  return state.apps;
}
function visibleViewed() {
  const c = scenarioConf();
  if (c.empty || c.firstSync) return [];
  return state.viewed;
}
function visibleReviews() {
  const c = scenarioConf();
  if (c.empty || c.firstSync) return [];
  return state.reviews;
}

function isDue(a) {
  if (!a || a.archived || a.status !== 'applied') return false;
  const n = daysSince(a.appliedAt);
  return n !== null && n >= Number(state.settings.threshold);
}

function dueCount() {
  return visibleApps().filter(isDue).length;
}
function activeAppliedCount() {
  return visibleApps().filter(a => !a.archived).length;
}
function archivedCount() {
  return visibleApps().filter(a => a.archived).length + visibleViewed().filter(v => v.archived).length;
}
function reviewCount() { return visibleReviews().length; }

function computeStats() {
  const c = scenarioConf();
  if (c.unavailable || c.firstSync) return null;
  const apps = visibleApps();
  const total = apps.length;
  const inProgress = apps.filter(a => ['applied', 'assessment', 'interview'].includes(a.status)).length;
  const inInterview = apps.filter(a => a.status === 'interview').length;
  return { total, inProgress, inInterview };
}

function statusPill(status, round) {
  const m = STATUS[status] || STATUS.pending;
  const roundText = round ? '<span class="pill__round">· ' + esc(round) + '</span>' : '';
  return '<span class="pill pill--' + m.cls + '"><span class="pill__dot"></span>' + m.label + roundText + '</span>';
}

function sourceChip(src) {
  return '<span class="tag tag--plain">' + esc(SOURCE_LABEL[src] || src) + '</span>';
}

function extBtn(label, url, extra) {
  if (!url) {
    return '<button class="linkbtn" disabled title="没有可用的安全链接，不会拼接推断 URL">' + esc(label) + '</button>';
  }
  return '<button class="linkbtn" data-action="external" data-url="' + esc(url) + '">' + esc(label) + (extra || '') + '</button>';
}

function dayCell(a) {
  const n = daysSince(a.appliedAt);
  const due = isDue(a);
  const threshold = Number(state.settings.threshold);
  const pct = n === null ? 0 : Math.min(n, 30) / 30 * 100;
  const tick = Math.min(threshold, 30) / 30 * 100;
  const over = n === null ? 0 : n - threshold;
  const meta = due
    ? '<span class="days__flag">' + (over > 0 ? '该回看 · 超线 ' + over + ' 天' : '该回看 · 刚到线') + '</span>'
    : (n === null ? '<span>D12 待冻结</span>' : '');
  return '<div class="days' + (due ? ' is-due' : '') + '" title="已投天数按北京时间计算；' + threshold + ' 天为回看线">' +
    '<span class="days__label">' + (n === null ? '' : '已投 <strong>' + n + '</strong> 天') + '</span>' +
    '<span class="days__track">' +
      '<span class="days__fill" style="width:' + pct + '%"></span>' +
      '<span class="days__tick" style="left:' + tick + '%"></span>' +
      '<span class="days__dot" style="left:' + pct + '%"></span>' +
    '</span>' +
    '<span class="days__meta">' + meta + '</span>' +
  '</div>';
}

/* ---------------------------------------------------------
   4. Root render
   --------------------------------------------------------- */

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  if (state.page === 'login') {
    app.innerHTML = loginHTML();
  } else if (state.page === 'mail-preview') {
    app.innerHTML = mailPreviewHTML();
  } else if (state.page === 'mail-landing') {
    app.innerHTML = mailLandingHTML();
  } else {
    app.innerHTML = ledgerHTML();
  }

  renderOverlays();
  renderDemo();
  renderToast();
  document.body.classList.toggle('is-locked', state.overlays.length > 0);
}

function renderLedgerBody() {
  const el = document.getElementById('ledger-body');
  if (!el) return;
  el.innerHTML = ledgerBodyHTML();
}

function renderToast() {
  const root = document.getElementById('toast-root');
  if (!root) return;
  if (!state.toast) { root.innerHTML = ''; return; }
  const icon = state.toast.kind === 'warn' ? I.alert : I.check;
  root.innerHTML = '<div class="toast' + (state.toast.kind === 'warn' ? ' toast--warn' : '') + '" role="status">' +
    icon + '<span>' + esc(state.toast.msg) + '</span></div>';
}

/* ---------------------------------------------------------
   5. Login
   --------------------------------------------------------- */

function loginHTML() {
  return '<div class="login">' +
    '<div class="login__left">' +
      '<div>' +
        '<div class="brandline hero-brand">' +
          '<span class="mark">T</span>' +
          '<span class="wordmark">Tounar <small>帮你理</small></span>' +
        '</div>' +
        '<div class="login__hero">' +
          '<h1 class="hero-title">Tounar.</h1>' +
          '<p class="hero-slogan">Your application tracker.</p>' +
          '<p class="hero-cn">你的投递线索整理助手</p>' +
          '<p class="hero-copy">浏览和投递时，插件替你记下；招聘邮件帮你更新状态；官网只在你访问时采集。<em>没有变化的日子，它不打扰你。</em></p>' +
        '</div>' +
        specimenHTML() +
      '</div>' +
      '<p class="login__foot"><strong>我们只处理你的投递线索。</strong> 插件仅在你授权的招聘站点读取岗位与投递状态；QQ 邮箱只按约定模式读取命中招聘候选的邮件，默认不保留正文、不读附件，可随时断开。</p>' +
    '</div>' +
    '<div class="login__right">' +
      '<span class="demo-flag">设计演示 · 非生产</span>' +
      '<div class="login-card">' + loginCardHTML() + '</div>' +
    '</div>' +
  '</div>';
}

function specimenHTML() {
  return '<div class="specimen" aria-label="台账样张">' +
    '<div class="specimen__head"><span>台账，一页看完</span><span>示意 · 非真实数据</span></div>' +
    '<div class="specimen__row">' +
      '<span class="specimen__company">字节跳动</span>' +
      '<span class="specimen__job">产品经理（国际化）</span>' +
      '<span class="specimen__status">' + statusPill('interview', '一面') + '</span>' +
      '<span class="specimen__days">已投 18 天</span>' +
    '</div>' +
    '<div class="specimen__row">' +
      '<span class="specimen__company">美团</span>' +
      '<span class="specimen__job">产品运营（到店）</span>' +
      '<span class="specimen__status">' + statusPill('applied', '') + '</span>' +
      '<span class="specimen__days is-due">已投 21 天 · 该回看</span>' +
    '</div>' +
    '<div class="specimen__row">' +
      '<span class="specimen__company">腾讯</span>' +
      '<span class="specimen__job">产品策划（微信小游戏出海）</span>' +
      '<span class="specimen__status">' + statusPill('assessment', '') + '</span>' +
      '<span class="specimen__days">已投 12 天</span>' +
    '</div>' +
    '<p class="specimen__caption"><strong>第 14 天</strong>，它提醒你回看一眼；其余日子保持安静。看过没投的岗位单独收着，不冒充投递。</p>' +
  '</div>';
}

function loginCardHTML() {
  const l = state.login;
  const hint = '<div class="demo-hint"><b>评审提示</b> · 输入任意邮箱 + 任意 6 位数字即可登录；<b>000000</b> 查看验证码错误，<b>demo@blocked.com</b> 查看内测准入拒绝。验证码长度以 G01 实测为准。</div>';
  const legal = '<p class="login-legal">内测仅开放给受邀用户。登录不创建密码；会话失效会回到本页，不保留上次台账。继续即表示你同意仅将数据用于生成你的投递台账。</p>';

  if (l.step === 'blocked') {
    return '<div class="login-blocked">' +
      '<p class="login-card__eyebrow">登录</p>' +
      '<h2>当前账号暂未获得内测资格</h2>' +
      '<p>平台登录可能已经成功，但业务台账不会因此开放。请联系内测邀请人，或换一个受邀邮箱。</p>' +
      '<button class="btn btn--primary btn--lg btn--block" data-action="login-reset">换一个邮箱</button>' +
      '<p class="login-legal">不会为未获准入的账号创建业务记录。</p>' +
    '</div>';
  }

  if (l.step === 'code') {
    const countdownText = l.countdown > 0 ? '重新发送（' + l.countdown + 's）' : '重新发送';
    return '<p class="login-card__eyebrow">登录</p>' +
      '<h2>输入验证码</h2>' +
      '<p class="login-card__lead">验证码已发送，请查收。仅开放给受邀内测用户。</p>' +
      '<div class="login-sent">' + I.mail + '<span>验证码已发送，请查收</span></div>' +
      '<div class="login-mail"><span>发送至 <strong>' + esc(l.email) + '</strong></span><button class="linkbtn" data-action="login-change-email">换一个邮箱</button></div>' +
      '<form data-form="login-code" novalidate>' +
        '<div class="field">' +
          '<label for="login-code">6 位验证码</label>' +
          '<input class="input code-input" id="login-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" data-autofocus />' +
          (l.error ? '<span class="field-error">' + esc(l.error) + '</span>' : '') +
        '</div>' +
        '<button class="btn btn--primary btn--lg btn--block" type="submit">登录</button>' +
      '</form>' +
      '<div class="login-actions">' +
        '<span>没有收到？检查垃圾邮件，或稍后重试。</span>' +
        '<button class="linkbtn" data-action="login-resend" id="login-resend"' + (l.countdown > 0 ? ' disabled' : '') + '>' + countdownText + '</button>' +
      '</div>' +
      hint + legal;
  }

  return '<p class="login-card__eyebrow">登录</p>' +
    '<h2>用邮箱验证码进入</h2>' +
    '<p class="login-card__lead">无密码，也不提供匿名演示账号。</p>' +
    '<form data-form="login-email" novalidate>' +
      '<div class="field">' +
        '<label for="login-email">邮箱</label>' +
        '<input class="input" id="login-email" name="email" type="email" autocomplete="email" placeholder="name@example.com" value="' + esc(l.email) + '" data-autofocus />' +
        '<span class="field-hint">仅用于接收验证码，不会提示该邮箱是否已注册。</span>' +
        (l.error ? '<span class="field-error">' + esc(l.error) + '</span>' : '') +
      '</div>' +
      '<button class="btn btn--primary btn--lg btn--block" type="submit">获取验证码</button>' +
    '</form>' +
    hint + legal;
}

function startLoginCountdown() {
  clearInterval(loginTimer);
  state.login.countdown = 60;
  updateCountdownEl();
  loginTimer = setInterval(() => {
    state.login.countdown = Math.max(0, state.login.countdown - 1);
    updateCountdownEl();
    if (state.login.countdown === 0) {
      clearInterval(loginTimer);
      loginTimer = null;
    }
  }, 1000);
}

function updateCountdownEl() {
  const el = document.getElementById('login-resend');
  if (!el) return;
  const c = state.login.countdown;
  el.textContent = c > 0 ? '重新发送（' + c + 's）' : '重新发送';
  el.disabled = c > 0;
}

/* ---------------------------------------------------------
   6. Ledger shell
   --------------------------------------------------------- */

function accountMenuHTML() {
  if (!state.accountOpen) return '';
  return '<div class="account__menu" role="menu">' +
    '<div class="account__id"><strong>' + esc(ACCOUNT_EMAIL) + '</strong><span>内测用户 · 数据按账号隔离</span></div>' +
    '<button class="account__item" data-action="open-settings" role="menuitem">' + I.mail + '提醒设置</button>' +
    '<button class="account__item" data-action="open-auth" role="menuitem">' + I.lock + '数据与授权</button>' +
    '<button class="account__item account__item--sep" data-action="logout" role="menuitem">退出登录</button>' +
  '</div>';
}

function appHeaderHTML() {
  const c = scenarioConf();
  const mailText = (c.mailExpired || state.mail.state === 'reauth_required')
    ? '邮箱待重新授权'
    : '邮箱同步 ' + shortAt(state.mail.lastSuccess);
  return '<header class="app-header">' +
    '<div class="app-header__inner">' +
      '<div class="app-header__left">' +
        '<span class="brandline"><span class="mark">T</span><span class="wordmark">Tounar <small>帮你理</small></span></span>' +
        '<span class="slash" style="width:1px;height:14px;background:var(--line-strong)"></span>' +
        '<span class="app-header__module"><strong>投递台账</strong><span class="demo-flag">演示数据</span></span>' +
      '</div>' +
      '<div class="app-header__right">' +
        '<span class="sync-note"><span class="sync-dot" style="background:' + ((c.mailExpired || state.mail.state === 'reauth_required') ? '#b98122' : '#5a8f6c') + '"></span>' + esc(mailText) + '</span>' +
        '<div class="account">' +
          '<button class="account__btn" data-action="toggle-account" aria-haspopup="menu" aria-expanded="' + state.accountOpen + '" aria-label="账号菜单">M</button>' +
          accountMenuHTML() +
        '</div>' +
      '</div>' +
    '</div>' +
  '</header>';
}

function bannersHTML() {
  const c = scenarioConf();
  const out = [];

  if (c.mailExpired || state.mail.state === 'reauth_required') {
    out.push('<div class="banner banner--warn">' +
      '<span class="banner__icon">' + I.alert + '</span>' +
      '<div class="banner__body"><strong>邮箱授权已失效，招聘邮件已暂停同步。</strong> 最后一次成功同步为 10-19 09:05。台账不会因此被删除，重新授权后继续增量同步。</div>' +
      '<div class="banner__actions"><button class="btn btn--sm" data-action="open-auth">查看授权</button><button class="btn btn--sm btn--primary" data-action="auth-reconnect">重新授权</button></div>' +
    '</div>');
  }

  if (c.mailDegraded) {
    out.push('<div class="banner banner--warn">' +
      '<span class="banner__icon">' + I.alert + '</span>' +
      '<div class="banner__body"><strong>邮箱同步暂受阻。</strong> 上次成功同步 10-21 06:12；服务端会退避重试，不会把失败显示成「已同步」。</div>' +
      '<div class="banner__actions"><button class="btn btn--sm" data-action="open-auth">查看状态</button></div>' +
    '</div>');
  }

  if (c.pluginStale) {
    out.push('<div class="banner banner--warn">' +
      '<span class="banner__icon">' + I.alert + '</span>' +
      '<div class="banner__body"><strong>插件最近未联系，已 6 天没有新的采集。</strong> 常见原因是浏览器未打开或扩展被停用；这只说明「最近没联系」，不能据此断言插件已卸载。</div>' +
      '<div class="banner__actions"><button class="btn btn--sm" data-action="open-auth">查看设备</button></div>' +
    '</div>');
  }

  if (c.firstSync) {
    out.push('<div class="banner banner--info">' +
      '<span class="banner__icon">' + I.info + '</span>' +
      '<div class="banner__body"><strong>QQ 邮箱首次同步中：收件箱 · 近 30 天。</strong> 已处理 126 / 约 400 封；结果会逐条归入台账，未完成前不宣称「已同步全部」。</div>' +
      '<div class="banner__actions"><button class="btn btn--sm" data-action="demo-noop" data-msg="首次同步任务 demo_sync_01 正在处理（演示）">查看进度</button></div>' +
    '</div>');
  }

  if (c.stale) {
    out.push('<div class="banner banner--warn">' +
      '<span class="banner__icon">' + I.alert + '</span>' +
      '<div class="banner__body"><strong>本次刷新失败，当前显示的是 10-20 08:00 的快照。</strong> 已投天数按该时间计算；不是实时数据。</div>' +
      '<div class="banner__actions"><button class="btn btn--sm" data-action="retry-load">重试刷新</button></div>' +
    '</div>');
  }

  return out.length ? '<div class="banners">' + out.join('') + '</div>' : '';
}

function statsHTML() {
  const s = computeStats();
  const c = scenarioConf();
  const ph = c.firstSync ? '同步中' : '暂不可用';
  const value = (n) => s === null
    ? '<div class="stat__value is-placeholder">—</div>'
    : '<div class="stat__value">' + n + '</div>';

  const subs = c.firstSync
    ? ['首次同步完成后计入', '首次同步完成后计入', '首次同步完成后计入']
    : c.unavailable
      ? ['数据暂不可用', '数据暂不可用', '数据暂不可用']
      : ['含归档与终态 · 全部申请', '已投递 / 笔试中 / 面试中', '进行中的子集'];

  return '<section class="stats" aria-label="台账统计">' +
    '<div class="stat"><div class="stat__label">累计投递</div>' + value(s ? s.total : 0) + '<div class="stat__sub">' + subs[0] + '</div></div>' +
    '<div class="stat"><div class="stat__label">进行中</div>' + value(s ? s.inProgress : 0) + '<div class="stat__sub">' + subs[1] + '</div></div>' +
    '<div class="stat"><div class="stat__label">面试中</div>' + value(s ? s.inInterview : 0) + '<div class="stat__sub">' + subs[2] + '</div></div>' +
    '<div class="stats__meta">' +
      '<div class="stats__time"><span>' + (c.firstSync ? '同步开始' : (c.unavailable ? '请求时间' : '数据截至')) + '</span><strong>' + scenarioConf().asOf + '</strong><span>北京时间</span></div>' +
      '<div class="stats__actions">' +
        '<span class="small muted">三指标为全台账口径，不随筛选变化</span>' +
        '<button class="btn btn--sm btn--ghost" data-action="retry-load">' + I.refresh + '刷新</button>' +
      '</div>' +
    '</div>' +
  '</section>';
}

function toolbarHTML() {
  const statusOptions = [
    ['all', '全部状态'],
    ['applied', '已投递'], ['assessment', '笔试中'], ['interview', '面试中'],
    ['offer', 'offer'], ['rejected', '已拒'], ['closed', '已结束']
  ].map(([v, label]) => '<option value="' + v + '"' + (state.status === v ? ' selected' : '') + '>' + label + '</option>').join('');

  const sourceOptions = [
    ['all', '全部来源'], ['plugin', '插件采集'], ['mail', '招聘邮件'], ['manual', '用户补录']
  ].map(([v, label]) => '<option value="' + v + '"' + (state.source === v ? ' selected' : '') + '>' + label + '</option>').join('');

  const filtersDisabled = state.view === 'review';
  const dueDisabled = state.view !== 'applied';
  const due = (scenarioConf().firstSync || scenarioConf().unavailable) ? '—' : dueCount();

  return '<div class="toolbar">' +
    '<div class="toolbar__filters">' +
      '<label class="search">' + I.search + '<span class="sr-only">搜索公司或岗位</span>' +
        '<input class="input" id="search-input" type="search" placeholder="搜索公司或岗位" value="' + esc(state.query) + '" autocomplete="off" /></label>' +
      '<select class="select select--status" id="filter-status" aria-label="按状态筛选"' + (filtersDisabled ? ' disabled' : '') + '>' + statusOptions + '</select>' +
      '<select class="select" id="filter-source" aria-label="按来源方式筛选"' + (filtersDisabled ? ' disabled' : '') + '>' + sourceOptions + '</select>' +
      '<button class="chip-toggle' + (state.due ? ' is-on' : '') + '" data-action="toggle-due"' + (dueDisabled ? ' disabled' : '') + ' title="已投 ≥' + state.settings.threshold + ' 天且状态无变化">' +
        '待回看 <span class="count">' + due + '</span></button>' +
    '</div>' +
    '<div class="toolbar__actions">' +
      '<button class="btn btn--ghost" data-action="open-manual">+ 归档线索</button>' +
      '<button class="btn btn--ghost" data-action="open-settings">提醒设置</button>' +
    '</div>' +
  '</div>';
}

function tabsHTML() {
  const sync = scenarioConf().firstSync || scenarioConf().unavailable;
  const tabs = [
    ['applied', '已投递明细', activeAppliedCount()],
    ['viewed', '看过没投', visibleViewed().filter(v => !v.archived).length],
    ['review', '待确认', reviewCount()],
    ['archived', '已归档', archivedCount()]
  ];
  return '<nav class="tabs" aria-label="台账入口">' + tabs.map(([v, label, n]) =>
    '<button class="tab' + (state.view === v ? ' is-active' : '') + '" data-action="set-view" data-view="' + v + '" aria-current="' + (state.view === v ? 'page' : 'false') + '">' +
      esc(label) + '<span class="tab__count">' + (sync ? '—' : n) + '</span></button>'
  ).join('') + '</nav>';
}

function ledgerHTML() {
  return appHeaderHTML() +
    '<main class="page">' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>投递台账</h1>' +
          '<div class="page-head__sub"><span>只显示你的记录</span><span class="sep"></span><span>官网状态仅在你访问时采集</span><span class="sep"></span><span>已投天数按北京时间计算</span></div>' +
        '</div>' +
      '</div>' +
      bannersHTML() +
      statsHTML() +
      toolbarHTML() +
      tabsHTML() +
      '<div id="ledger-body">' + ledgerBodyHTML() + '</div>' +
    '</main>';
}

function ledgerBodyHTML() {
  const c = scenarioConf();
  if (c.unavailable) {
    return '<div class="resultline"><strong>数据暂不可用</strong><span class="sep"></span><span>会话仍然有效</span></div>' +
      '<div class="error-panel">' +
        '<h2>数据暂不可用</h2>' +
        '<p>台账服务暂时没有返回结果（503）。页面不会把失败显示成 0，也不会塞入演示数据。会话仍然有效，恢复后可以继续查看。</p>' +
        '<div class="error-panel__meta">request_id: req_demo_8f31 · GET /api/v1/ledger</div>' +
        '<button class="btn btn--primary" data-action="retry-load">' + I.refresh + '重新加载</button>' +
      '</div>' +
      '<p class="table-foot">旧数据不会被改写；刷新成功后会重新显示三统计与明细。</p>';
  }

  if (c.firstSync) {
    return '<div class="resultline"><strong>首次同步中</strong><span class="sep"></span><span>结果会逐条归入台账</span></div>' +
      '<div class="skeleton" aria-label="加载中">' +
        Array.from({ length: 4 }).map((_, i) =>
          '<div class="skeleton__row">' +
            '<span class="sk sk--short"></span><span class="sk"></span><span class="sk sk--short"></span>' +
            '<span class="sk sk--shorter"></span><span class="sk"></span><span class="sk sk--shorter"></span>' +
          '</div>'
        ).join('') +
        '<div class="skeleton__note">' + I.info + ' 首次同步完成前，不显示 0，也不宣称「没有更新」。</div>' +
      '</div>';
  }

  if (state.view === 'review') return reviewListHTML();
  if (state.view === 'viewed') return viewedBodyHTML();
  if (state.view === 'archived') return archivedBodyHTML();
  return appliedBodyHTML();
}

function resultLineHTML(main, note, showClear) {
  const hasFilters = state.query || state.status !== 'all' || state.source !== 'all' || state.due;
  return '<div class="resultline">' +
    '<strong>' + main + '</strong>' +
    (note ? '<span class="sep"></span><span>' + note + '</span>' : '') +
    (showClear && hasFilters ? '<button class="linkbtn" data-action="clear-filters">清空筛选</button>' : '') +
  '</div>';
}

function filterApps(list) {
  const q = state.query.trim().toLowerCase();
  return list.filter(a => {
    if (!a.archived && state.view === 'applied' && a.archived) return false;
    if (q && !(a.company + ' ' + a.title + ' ' + a.city).toLowerCase().includes(q)) return false;
    if (state.status !== 'all' && a.status !== state.status) return false;
    if (state.source !== 'all' && !(a.sources || []).includes(state.source)) return false;
    if (state.due && !isDue(a)) return false;
    return true;
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function emptyOnboardingHTML() {
  return '<div class="empty">' +
    '<div class="empty__grid">' +
      '<div>' +
        '<h2>还没有投递记录</h2>' +
        '<p>装上插件并在招聘站点授权后，停留 3 秒的岗位详情会被记入「看过没投」；提交成功才会成为投递。不需要每投一次回来粘贴 JD。</p>' +
        '<div class="empty__steps">' +
          '<div class="empty__step"><span class="empty__num">01</span><div><b>安装插件，授权招聘站点</b>插件只读取已适配页面的岗位与投递状态；未授权域名不注入。</div></div>' +
          '<div class="empty__step"><span class="empty__num">02</span><div><b>授权 QQ 邮箱（可选）</b>只按约定模式读取命中招聘候选的邮件，默认不保留正文，可随时断开。</div></div>' +
          '<div class="empty__step"><span class="empty__num">03</span><div><b>开始投递</b>提交成功后，台账自动出现一行；官网状态只在你访问时采集。</div></div>' +
        '</div>' +
        '<div class="empty__actions">' +
          '<button class="btn btn--primary" data-action="demo-install">安装浏览器插件</button>' +
          '<button class="btn" data-action="auth-reconnect">连接 QQ 邮箱</button>' +
          '<button class="linkbtn linkbtn--muted" data-action="open-manual">手动补录（兜底）</button>' +
        '</div>' +
      '</div>' +
      '<aside class="empty__aside">' +
        '<h3>你会看到什么</h3>' +
        '<ul>' +
          '<li>三统计只统计全台账，不跟筛选变化。</li>' +
          '<li>看过没投单独成清单，不计入累计投递。</li>' +
          '<li>已投 ≥' + state.settings.threshold + ' 天没有变化，才会进入「待回看」。</li>' +
          '<li>没有进展、也没到回看节点，不发提醒邮件。</li>' +
        '</ul>' +
        '<p style="margin-top:14px"><button class="linkbtn" data-action="goto-mail-preview">看看提醒邮件长什么样</button></p>' +
      '</aside>' +
    '</div>' +
  '</div>' +
  tableFootnoteHTML();
}

function tableFootnoteHTML() {
  return '<p class="table-foot"><span>更新时间是台账更新时间，不是官网刚查过<span class="dot-sep">·</span>官网状态仅在你访问时采集<span class="dot-sep">·</span>颜色配合文字，不只靠颜色判断</span><span>归档不等于拒绝；归档记录仍计入累计投递</span></p>';
}

function appliedBodyHTML() {
  const all = visibleApps().filter(a => !a.archived);
  const list = filterApps(all);
  const total = all.length;
  const shown = list.slice(0, state.visibleCount);
  const hasFilters = !!(state.query || state.status !== 'all' || state.source !== 'all' || state.due);

  if (total === 0 && !hasFilters) return emptyOnboardingHTML();

  if (list.length === 0) {
    return resultLineHTML('筛选结果 0 条', '全部申请 ' + total + ' 条', true) +
      '<div class="empty empty--simple">' +
        '<h2>没有符合筛选的记录</h2>' +
        '<p>换一个关键词，或清空状态与来源筛选。搜索只影响当前列表，不会改变上方三统计。</p>' +
        '<div class="empty__actions"><button class="btn" data-action="clear-filters">清空筛选</button></div>' +
      '</div>' + tableFootnoteHTML();
  }

  const rows = shown.map(a => appliedRowHTML(a)).join('');
  return resultLineHTML('筛选结果 ' + list.length + ' 条', '全部申请 ' + total + ' 条', true) +
    '<div class="table-wrap"><table class="table">' +
      '<thead><tr>' +
        '<th class="c-company">公司</th><th class="c-job">岗位</th><th class="c-jd">JD 摘要</th>' +
        '<th class="c-channel">投递渠道</th><th class="c-status">状态</th><th class="c-days">已投天数</th>' +
        '<th class="c-link">投递链接</th><th class="c-statuslink">查看状态</th><th class="c-updated">更新时间</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table></div>' +
    '<div class="table-foot"><span>官网状态仅在你访问时采集<span class="dot-sep">·</span>已投天数按北京时间计算，刻度 30 天、竖线为 ' + state.settings.threshold + ' 天回看线<span class="dot-sep">·</span>更新时间为台账时间</span><span>已显示 ' + shown.length + ' / ' + list.length + ' 条' + (state.due ? ' · 是否发邮件还受提醒设置影响' : '') + '</span></div>' +
    (list.length > shown.length ? '<div class="loadmore"><button class="btn" data-action="load-more">加载更多</button></div>' : '');
}

function appliedRowHTML(a) {
  const n = daysSince(a.appliedAt);
  const statusUrlNote = a.statusUrl
    ? (a.statusScope === 'company' ? '公司入口 · 需登录' : '申请记录')
    : '未采集到状态入口';
  const statusAction = a.statusUrl
    ? extBtn('申请状态', a.statusUrl)
    : extBtn('岗位页（回退）', a.jobUrl);
  return '<tr data-action="open-app" data-id="' + esc(a.id) + '" tabindex="0" aria-label="打开 ' + esc(a.company + a.title) + ' 详情">' +
    '<td class="c-company"><span class="company">' + esc(a.company) + '</span>' + (TERMINAL.includes(a.status) ? '<span class="company-sub">终态 · 不再自动更新</span>' : '') + '</td>' +
    '<td class="c-job"><span class="job-title">' + esc(a.title) + '</span><span class="job-meta">' + esc(a.city) + ' · ' + esc(a.batch) + '</span></td>' +
    '<td class="c-jd"><span class="jd-summary">' + (a.jd ? esc(a.jd) : '<span class="cell-missing">摘要待补充</span>') + '</span></td>' +
    '<td class="c-channel"><span class="channel">' + esc(a.channel) + '</span></td>' +
    '<td class="c-status">' + statusPill(a.status, a.roundLabel) + '</td>' +
    '<td class="c-days">' + dayCell(a) + '</td>' +
    '<td class="c-link">' + extBtn('查看岗位', a.jobUrl) + '</td>' +
    '<td class="c-statuslink">' + statusAction + '<span class="link-note">' + statusUrlNote + '</span></td>' +
    '<td class="c-updated"><span class="updated">' + esc(shortAt(a.updatedAt)) + '</span></td>' +
  '</tr>';
}

function viewedBodyHTML() {
  const all = visibleViewed().filter(v => !v.archived);
  const q = state.query.trim().toLowerCase();
  const list = all.filter(v => !q || (v.company + ' ' + v.title + ' ' + v.city).toLowerCase().includes(q))
    .sort((a, b) => String(b.lastViewedAt).localeCompare(String(a.lastViewedAt)));

  if (all.length === 0 && !q) {
    return '<div class="empty empty--simple">' +
      '<h2>还没有浏览线索</h2>' +
      '<p>插件会在你停留 ≥3 秒的岗位详情页记下一条。它不会计入累计投递，也不会出现在「已投递明细」里。同一岗位重复浏览只更新时间，不新增行。</p>' +
      '<div class="empty__actions"><button class="btn" data-action="demo-install">检查插件授权</button><button class="linkbtn linkbtn--muted" data-action="open-manual">补录一条漏采线索</button></div>' +
    '</div>';
  }

  if (list.length === 0) {
    return resultLineHTML('筛选结果 0 条', '看过没投 ' + all.length + ' 条', true) +
      '<div class="empty empty--simple"><h2>没有符合的浏览线索</h2><p>清空搜索后可以查看全部。</p><div class="empty__actions"><button class="btn" data-action="clear-filters">清空筛选</button></div></div>';
  }

  return resultLineHTML('看过没投 ' + list.length + ' 条', '不计入累计投递', true) +
    '<div class="table-wrap"><table class="table">' +
      '<thead><tr><th class="c-company">公司</th><th class="c-job">岗位</th><th class="c-jd">JD 摘要</th><th class="c-channel">投递渠道</th><th class="c-status">状态</th><th class="c-days">最近浏览</th><th class="c-link">岗位链接</th><th class="c-updated">首次发现</th></tr></thead>' +
      '<tbody>' + list.map(v =>
        '<tr data-action="open-viewed" data-id="' + esc(v.id) + '" tabindex="0">' +
          '<td><span class="company">' + esc(v.company) + '</span><span class="company-sub">未投递</span></td>' +
          '<td><span class="job-title">' + esc(v.title) + '</span><span class="job-meta">' + esc(v.city) + ' · ' + esc(v.batch) + '</span></td>' +
          '<td><span class="jd-summary">' + esc(v.jd || '摘要待补充') + '</span></td>' +
          '<td><span class="channel">' + esc(v.channel) + '</span></td>' +
          '<td>' + statusPill('pending', '') + '</td>' +
          '<td><span class="days__label">' + esc(shortAt(v.lastViewedAt)) + '</span><span class="link-note">停留 ≥3 秒</span></td>' +
          '<td>' + extBtn('查看岗位', v.jobUrl) + '</td>' +
          '<td><span class="updated">' + esc(shortAt(v.firstViewedAt)) + '</span></td>' +
        '</tr>'
      ).join('') +
    '</table></div>' +
    '<div class="table-foot"><span>浏览线索不进入任何漏斗与累计投递统计<span class="dot-sep">·</span>30 天未投递会自动归档，不删除</span><span>共 ' + all.length + ' 条</span></div>';
}

function archivedBodyHTML() {
  const apps = visibleApps().filter(a => a.archived).map(a => ({ type: 'app', data: a, at: a.updatedAt }));
  const views = visibleViewed().filter(v => v.archived).map(v => ({ type: 'view', data: v, at: v.lastViewedAt }));
  let list = apps.concat(views).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter(x => (x.data.company + ' ' + x.data.title).toLowerCase().includes(q));

  if (!apps.length && !views.length) {
    return '<div class="empty empty--simple"><h2>还没有已归档记录</h2><p>归档不等于拒绝；归档后仍计入累计投递。浏览线索 30 天未投递也会自动收进这里，但不会冒充已投。</p></div>';
  }

  return resultLineHTML('已归档 ' + list.length + ' 条', '归档不等于拒绝；累计投递不因此减少', true) +
    '<div class="table-wrap"><table class="table">' +
      '<thead><tr><th class="c-company">公司</th><th class="c-job">岗位</th><th class="c-channel">类型</th><th class="c-status">状态</th><th class="c-jd">归档说明</th><th class="c-updated">更新时间</th><th class="c-link">链接</th></tr></thead>' +
      '<tbody>' + list.map(x => {
        const d = x.data;
        if (x.type === 'view') {
          return '<tr data-action="open-viewed" data-id="' + esc(d.id) + '" tabindex="0" class="is-archived">' +
            '<td><span class="company">' + esc(d.company) + '</span><span class="company-sub">仅浏览</span></td>' +
            '<td><span class="job-title">' + esc(d.title) + '</span><span class="job-meta">' + esc(d.city) + '</span></td>' +
            '<td><span class="tag tag--plain">未投递线索</span></td>' +
            '<td>' + statusPill('pending', '') + '</td>' +
            '<td><span class="cell-missing">' + esc(d.archivedReason || '浏览线索已归档') + '</span></td>' +
            '<td><span class="updated">' + esc(shortAt(d.lastViewedAt)) + '</span></td>' +
            '<td>' + extBtn('查看岗位', d.jobUrl) + '</td>' +
          '</tr>';
        }
        return '<tr data-action="open-app" data-id="' + esc(d.id) + '" tabindex="0" class="is-archived">' +
          '<td><span class="company">' + esc(d.company) + '</span><span class="company-sub">' + (TERMINAL.includes(d.status) ? '终态' : '曾投递') + '</span></td>' +
          '<td><span class="job-title">' + esc(d.title) + '</span><span class="job-meta">' + esc(d.city) + '</span></td>' +
          '<td><span class="tag tag--plain">已投递</span></td>' +
          '<td>' + statusPill(d.status, d.roundLabel) + '</td>' +
          '<td><span class="cell-missing">' + esc(d.archivedReason || '已归档') + '</span></td>' +
          '<td><span class="updated">' + esc(shortAt(d.updatedAt)) + '</span></td>' +
          '<td>' + extBtn('查看岗位', d.jobUrl) + '</td>' +
        '</tr>';
      }).join('') +
    '</table></div>' +
    '<div class="table-foot"><span>归档记录仍计入累计投递；恢复是显式动作，不会静默改状态</span><span>共 ' + list.length + ' 条</span></div>';
}

/* ---------------------------------------------------------
   7. Review list
   --------------------------------------------------------- */

function reviewListHTML() {
  const all = visibleReviews();
  const q = state.query.trim().toLowerCase();
  const list = all.filter(r => !q || (r.company + ' ' + r.title).toLowerCase().includes(q));

  if (all.length === 0) {
    return '<div class="empty empty--simple">' +
      '<h2>没有待确认项</h2>' +
      '<p>只有在证据冲突、归属不清或终态候选时，才会请你决定。平时台账会自己更新，不要求你每天校对。</p>' +
      '<div class="empty__actions"><button class="btn" data-action="goto-mail-preview">看看提醒邮件</button></div>' +
    '</div>';
  }

  if (list.length === 0) {
    return resultLineHTML('筛选结果 0 条', '待确认 ' + all.length + ' 项', true) +
      '<div class="empty empty--simple"><h2>没有符合的待确认项</h2><div class="empty__actions"><button class="btn" data-action="clear-filters">清空筛选</button></div></div>';
  }

  return resultLineHTML('待确认 ' + list.length + ' 项', '不改变投递统计；确认后才写台账', true) +
    '<div class="review-list">' + list.map(r =>
      '<article class="review-card' + (r.blocked ? ' review-card--blocked' : '') + '" data-action="open-review" data-id="' + esc(r.id) + '" tabindex="0" role="button">' +
        '<div class="review-card__kind">' +
          '<span class="tag ' + (r.blocked ? 'tag--plain' : 'tag--amber') + '">' + esc(r.kind) + '</span>' +
          '<span class="review-card__conf">置信度 ' + r.confidence.toFixed(2) + (r.blocked ? ' · 待冻结' : '') + '</span>' +
        '</div>' +
        '<div class="review-card__main">' +
          '<div class="review-card__who"><strong>' + esc(r.company) + '</strong><span>' + esc(r.title) + '</span><span class="muted">' + esc(r.city) + '</span></div>' +
          '<p class="review-card__reason">' + esc(r.reason) + '</p>' +
          '<div class="review-card__evidence">' + esc(r.evidence) + '</div>' +
          '<div class="review-card__suggest"><span class="muted">建议</span><b>' + esc(r.suggestion) + '</b>' + (r.blocked ? '<span class="tag tag--plain">D12 未冻结</span>' : '') + '</div>' +
        '</div>' +
        '<div class="review-card__side">' +
          (r.blocked ? '<span class="tag tag--plain">保留待确认</span>' : '<span class="tag tag--pine">打开复核</span>') +
          '<span class="small muted">' + (r.candidates.length ? '需选择归属' : '需你决定') + '</span>' +
        '</div>' +
      '</article>'
    ).join('') + '</div>' +
    '<div class="table-foot"><span>复核项不是第八种状态；它只表示「有一个建议还没被采纳」</span><span>进入复核不覆盖正式字段</span></div>';
}

/* ---------------------------------------------------------
   8. Overlays
   --------------------------------------------------------- */

function renderOverlays() {
  const root = document.getElementById('overlay-root');
  if (!root) return;
  if (!state.overlays.length) {
    root.innerHTML = '';
    overlayFocusCount = 0;
    document.body.classList.remove('is-locked');
    return;
  }

  root.innerHTML = state.overlays.map((o, i) => {
    const z = 50 + i * 2;
    return overlayHTML(o, i, z);
  }).join('');
  document.body.classList.add('is-locked');

  if (state.overlays.length > overlayFocusCount) {
    overlayFocusCount = state.overlays.length;
    setTimeout(() => {
      const top = root.lastElementChild;
      if (!top) return;
      const target = top.querySelector('[data-autofocus]') || top.querySelector('.drawer, .modal');
      if (target) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }, 40);
  } else {
    overlayFocusCount = state.overlays.length;
  }
}

function overlayHTML(o, index, z) {
  const isCenter = !['detail', 'review', 'manual'].includes(o.kind);
  const wrap = '<div class="overlay' + (isCenter ? ' overlay--center' : '') + '" style="z-index:' + z + '" data-overlay-index="' + index + '">';
  if (o.kind === 'detail') return wrap + (o.viewed ? viewedDetailHTML(o) : detailOverlayHTML(o)) + '</div>';
  if (o.kind === 'review') return wrap + reviewOverlayHTML(o) + '</div>';
  if (o.kind === 'manual') return wrap + manualOverlayHTML(o) + '</div>';
  if (o.kind === 'settings') return wrap + settingsOverlayHTML(o) + '</div>';
  if (o.kind === 'auth') return wrap + authOverlayHTML(o) + '</div>';
  if (o.kind === 'wizard') return wrap + wizardOverlayHTML(o) + '</div>';
  if (o.kind === 'confirm') return wrap + confirmOverlayHTML(o) + '</div>';
  if (o.kind === 'delete-confirm') return wrap + deleteConfirmHTML(o) + '</div>';
  if (o.kind === 'delete-progress') return wrap + deleteProgressHTML(o) + '</div>';
  return wrap + '</div>';
}

function closeBtn() {
  return '<button class="icon-btn" data-action="close-overlay" aria-label="关闭">' + I.close + '</button>';
}

function headHTML(eyebrow, title) {
  return '<header class="panel-head"><div><p class="panel-head__eyebrow">' + esc(eyebrow) + '</p><h2>' + esc(title) + '</h2></div>' + closeBtn() + '</header>';
}

function findApp(id) { return state.apps.find(a => a.id === id); }
function findViewed(id) { return state.viewed.find(v => v.id === id); }

function detailOverlayHTML(o) {
  const a = findApp(o.id);
  if (!a) return '';
  const n = daysSince(a.appliedAt);
  const daysBlock = '<div class="detail-days">' +
    '<div><div class="detail-days__num">' + (n === null ? '—' : n) + '<small>天</small></div><div class="detail-days__label">' + (n === null ? '投递时间待补' : '自 ' + esc(a.appliedAt) + ' 起 · 按北京时间') + '</div></div>' +
    '<div class="days' + (isDue(a) ? ' is-due' : '') + '"><span class="days__track"><span class="days__fill" style="width:' + (n === null ? 0 : Math.min(n, 30) / 30 * 100) + '%"></span><span class="days__tick" style="left:' + (Number(state.settings.threshold) / 30 * 100) + '%"></span><span class="days__dot" style="left:' + (n === null ? 0 : Math.min(n, 30) / 30 * 100) + '%"></span></span>' +
      '<span class="days__meta"><span>回看线 ' + state.settings.threshold + ' 天</span><span>' + (isDue(a) ? '该回看' : '') + '</span></span></div>' +
  '</div>';

  const timeline = (a.history || []).slice().reverse().map(h =>
    '<li><div class="timeline__top"><span class="timeline__date">' + esc(h.at) + '</span>' +
      (h.from === h.to ? '<span class="timeline__change">' + esc(h.to) + '</span><span class="timeline__by">属性更新</span>' : '<span class="timeline__change">' + esc(h.from) + ' → ' + esc(h.to) + '</span><span class="timeline__by">来自' + esc(h.by) + '</span>') +
    '</div><div class="timeline__note">' + esc(h.note || '') + '</div></li>'
  ).join('') || '<li><span class="timeline__note">还没有状态历史。</span></li>';

  const correction = o.editing ? '<div class="correction">' +
    '<h4>纠错这条记录</h4><p>纠错会留痕，不会伪装成自动识别；终态纠错需额外确认（D05 待冻结）。</p>' +
    '<form data-form="correction" data-app="' + esc(a.id) + '">' +
      '<div class="field"><label>改为</label><select class="select" name="status">' +
        Object.keys(STATUS).filter(k => k !== 'pending').map(k => '<option value="' + k + '"' + (k === a.status ? ' selected' : '') + '>' + STATUS[k].label + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>原因（必填）</label><input class="input" name="reason" placeholder="例如：官网显示已进入面试" data-autofocus /></div>' +
      '<div class="correction__actions"><button type="button" class="btn btn--sm btn--quiet" data-action="detail-cancel-edit">取消</button><button type="submit" class="btn btn--sm btn--primary">保存纠错</button></div>' +
    '</form>' +
  '</div>' : '';

  const terminalNote = TERMINAL.includes(a.status) && !a.archived
    ? '<div class="terminal-note">终态已锁定：自动流程不会再把这条记录改成其他状态。如果官网或邮件显示不同结果，请用「纠错」并保留原因（D05 待冻结）。</div>' : '';
  const archivedNote = a.archived
    ? '<div class="terminal-note">已归档 · ' + esc(a.archivedReason || '已归档') + '。归档不等于拒绝；累计投递不会因此减少。</div>' : '';

  let actions = '';
  if (a.archived) {
    actions = '<button class="btn btn--primary" data-action="unarchive" data-id="' + esc(a.id) + '">恢复记录</button>' +
      '<button class="btn btn--ghost" data-action="close-overlay">关闭</button>';
  } else if (TERMINAL.includes(a.status)) {
    actions = '<button class="btn btn--primary" data-action="detail-edit">纠错状态</button>' +
      '<button class="btn btn--ghost" data-action="request-archive" data-id="' + esc(a.id) + '">归档</button>';
  } else {
    actions = '<button class="btn btn--primary" data-action="mark-reviewed" data-id="' + esc(a.id) + '">确认状态无变化</button>' +
      '<button class="btn btn--ghost" data-action="request-archive" data-id="' + esc(a.id) + '">归档</button>' +
      '<button class="btn btn--quiet" data-action="detail-edit">纠错</button>';
  }

  const correctedNote = a.lastReviewedAt
    ? '<div class="terminal-note">最近确认：' + esc(a.lastReviewedAt) + '。重复点击同一天不会重复计时。</div>' : '';

  return '<div class="drawer" role="dialog" aria-modal="true" aria-label="记录详情">' +
    headHTML('记录详情', a.company) +
    '<div class="panel-body">' +
      '<div class="detail-company"><div><div class="detail-role">' + esc(a.title) + '</div>' +
        '<div class="detail-meta"><span>' + esc(a.city) + '</span><span class="sep">·</span><span>' + esc(a.batch) + '</span><span class="sep">·</span><span>' + esc(a.channel) + '</span></div></div>' +
        statusPill(a.status, a.roundLabel) + '</div>' +
      daysBlock +
      '<section class="detail-section"><div class="detail-section__head"><h4>来源与时间</h4><span>最近有效进展不是刷新时间</span></div>' +
        '<dl class="kv">' +
          '<dt>投递时间</dt><dd><strong>' + (a.appliedTime ? esc(a.appliedTime) : '待补') + '</strong><br>' + (a.appliedTime ? '日期级记录 · 不补造具体时刻' : 'D12 未冻结，不补造日期') + '</dd>' +
          '<dt>来源方式</dt><dd><div class="source-chips">' + (a.sources || []).map(sourceChip).join('') + '<span class="tag tag--plain">置信度 ' + a.confidence.toFixed(2) + '</span></div></dd>' +
          '<dt>最近进展</dt><dd>' + esc(a.lastStatusChangedAt || '暂无') + '</dd>' +
          '<dt>官网采集</dt><dd>' + (a.lastSiteObservedAt ? esc(a.lastSiteObservedAt) : '<span class="cell-missing">尚未采集到状态页</span>') + '</dd>' +
          '<dt>人工确认</dt><dd>' + (a.lastReviewedAt ? esc(a.lastReviewedAt) : '<span class="cell-missing">尚未确认</span>') + '</dd>' +
        '</dl>' +
      '</section>' +
      '<section class="detail-section"><div class="detail-section__head"><h4>JD 摘要</h4><span>≤80 字 · 纯文本</span></div>' +
        '<div class="jd-block">' + (a.jd ? esc(a.jd) : '<span class="missing">摘要待补充</span>') + '</div>' +
      '</section>' +
      '<section class="detail-section"><div class="detail-section__head"><h4>链接</h4><span>安全外链才可点击</span></div>' +
        '<div class="link-rows">' +
          '<div class="link-row"><div><div class="link-row__label">岗位页</div><div class="link-row__note">' + (a.jobUrl ? '用于重看 JD，不是状态入口' : '没有安全链接，不会拼接推断 URL') + '</div></div><div class="link-row__action">' + extBtn('查看岗位', a.jobUrl, ' ' + I.external) + '</div></div>' +
          '<div class="link-row"><div><div class="link-row__label">申请状态页</div><div class="link-row__note">' + (a.statusUrl ? (a.statusScope === 'company' ? '公司申请入口 · 需登录官网查看' : '岗位专属申请记录') : '未采集到状态入口，回退到岗位页') + '</div></div><div class="link-row__action">' + (a.statusUrl ? extBtn('查看状态', a.statusUrl, ' ' + I.external) : extBtn('岗位页（回退）', a.jobUrl, ' ' + I.external)) + '</div></div>' +
        '</div>' +
      '</section>' +
      '<section class="detail-section"><div class="detail-section__head"><h4>状态时间线</h4><span>每次流转都留痕</span></div>' +
        '<ul class="timeline">' + timeline + '</ul>' +
      '</section>' +
      terminalNote + archivedNote + correctedNote + correction +
    '</div>' +
    '<footer class="panel-foot"><span class="panel-foot__note">更新时间是台账更新时间，不是官网刚查过。</span><div class="panel-foot__actions">' + actions + '</div></footer>' +
  '</div>';
}

function viewedDetailHTML(o) {
  const v = findViewed(o.id);
  if (!v) return '';
  const archived = v.archived;
  return '<div class="drawer" role="dialog" aria-modal="true" aria-label="浏览线索详情">' +
    headHTML('浏览线索', v.company) +
    '<div class="panel-body">' +
      '<div class="detail-company"><div><div class="detail-role">' + esc(v.title) + '</div><div class="detail-meta"><span>' + esc(v.city) + '</span><span class="sep">·</span><span>' + esc(v.batch) + '</span><span class="sep">·</span><span>' + esc(v.channel) + '</span></div></div>' + statusPill('pending', '') + '</div>' +
      '<div class="terminal-note" style="margin-top:18px">看过 ≠ 投递。这条线索没有计入累计投递，也不会进入面试等统计。</div>' +
      '<section class="detail-section"><div class="detail-section__head"><h4>浏览记录</h4><span>同一 URL 只保留一行</span></div>' +
        '<dl class="kv">' +
          '<dt>首次发现</dt><dd>' + esc(v.firstViewedAt) + '</dd>' +
          '<dt>最近浏览</dt><dd>' + esc(v.lastViewedAt) + '</dd>' +
          '<dt>停留判定</dt><dd>详情页可见累计 ≥3 秒；列表页不记录</dd>' +
          '<dt>归档</dt><dd>' + (archived ? esc(v.archivedReason || '已归档') : '未归档') + '</dd>' +
        '</dl>' +
      '</section>' +
      '<section class="detail-section"><div class="detail-section__head"><h4>JD 摘要</h4><span>纯文本</span></div><div class="jd-block">' + esc(v.jd || '摘要待补充') + '</div></section>' +
      '<section class="detail-section"><div class="detail-section__head"><h4>岗位链接</h4><span>不拼接虚构 URL</span></div>' +
        '<div class="link-rows"><div class="link-row"><div><div class="link-row__label">岗位页</div><div class="link-row__note">用于回看 JD；打开官网不会自动变成已投</div></div><div class="link-row__action">' + extBtn('查看岗位', v.jobUrl, ' ' + I.external) + '</div></div></div>' +
      '</section>' +
    '</div>' +
    '<footer class="panel-foot"><span class="panel-foot__note">浏览 30 天未投递会自动归档，不删除。</span><div class="panel-foot__actions">' +
      (archived
        ? '<button class="btn btn--primary" data-action="unarchive-viewed" data-id="' + esc(v.id) + '">恢复线索</button>'
        : '<button class="btn btn--primary" data-action="viewed-to-manual" data-id="' + esc(v.id) + '">补录投递</button>') +
      '<button class="btn btn--ghost" data-action="close-overlay">关闭</button>' +
    '</div></footer>' +
  '</div>';
}

function reviewOverlayHTML(o) {
  const r = state.reviews.find(x => x.id === o.id);
  if (!r) return '';
  const blocked = !!r.blocked;

  const candidateHTML = r.candidates.length
    ? '<div class="candidates"><div class="field-label">选择本人申请<span class="opt">不会默认选择最近一条</span></div>' +
      r.candidates.map(c =>
        '<label class="candidate"><input type="radio" name="candidate" value="' + esc(c.id) + '">' +
          '<span class="candidate__main"><strong>' + esc(c.label) + '</strong><span>' + esc(c.meta) + '</span></span></label>'
      ).join('') + '</div>'
    : '';

  const dateField = r.kind === '疑似提交'
    ? '<div class="field" style="margin-top:16px"><label for="review-date">可信投递时间<span class="opt">必填；不能用今天代替</span></label><input class="input" id="review-date" name="appliedAt" type="date" max="2026-10-21" form="review-form" /><span class="field-hint">没有可信时间时，请忽略本项；不要为了入库补造日期。</span></div>'
    : '';

  const compare = r.kind === '疑似提交' ? '' : '<div class="compare">' +
      '<div class="compare__cell"><span>当前台账</span><strong>' + esc(r.current) + '</strong></div>' +
      '<div class="compare__arrow">' + I.arrow + '</div>' +
      '<div class="compare__cell compare__cell--suggest"><span>建议变化</span><strong>' + esc(r.suggestion) + '</strong></div>' +
    '</div>';

  const locked = blocked
    ? '<div class="review-locked"><strong>这一项先不自动处理。</strong> 源稿必填字段与真实缺失的冲突（D12）尚未冻结；补造投递日或降低必填要求都会污染统计。这里只保留待确认，不写入正式台账。</div>'
    : '';

  let primary = '';
  if (!blocked) {
    const label = r.kind === '疑似提交' ? '确认已投递并创建记录'
      : r.kind === '终态候选' ? '确认已拒（终态）'
      : r.kind === '邮件多候选' ? '按所选归属更新'
      : '采纳建议';
    primary = '<button class="btn btn--primary" type="submit" form="review-form">' + label + '</button>';
  }

  const impactText = {
    '疑似提交': '新建 1 条已投记录，累计投递 +1；已投天数按你填写的日期计算，不使用今天。',
    '邮件多候选': '只更新你选中的那条记录，不新建记录；其他候选保持原样，不会被合并或删除。',
    '状态冲突': '把当前状态改为建议值并写入时间线；若变为终态会立即锁定，自动流程不再改写。',
    '终态候选': '状态改为「已拒」并锁定终态；累计投递不变，之后仍可用纠错修改并留痕。'
  }[r.kind] || '只改这一条记录，并写入时间线与来源；其他记录不受影响。';
  const impact = blocked ? '' : '<div class="review-impact"><b>采纳后会发生什么</b><p>' + esc(impactText) + '</p></div>';

  return '<div class="drawer drawer--wide" role="dialog" aria-modal="true" aria-label="复核">' +
    headHTML('待确认 · ' + r.kind, '复核建议') +
    '<div class="panel-body">' +
      '<div class="review-head"><span class="tag ' + (blocked ? 'tag--plain' : 'tag--amber') + '">' + esc(r.kind) + '</span><span class="tag tag--plain">置信度 ' + r.confidence.toFixed(2) + '</span>' + (blocked ? '<span class="tag tag--plain">D12 未冻结</span>' : '') + '</div>' +
      '<div class="review-company">' + esc(r.company) + '</div>' +
      '<div class="review-role">' + esc(r.title) + ' · ' + esc(r.city) + '</div>' +
      '<div class="review-reason"><strong>为什么要你确认：</strong> ' + esc(r.reason) + '</div>' +
      '<div class="evidence-quote">' + esc(r.evidence) + '<cite>最短证据 · 外部文本已转义，不作为 HTML 渲染</cite></div>' +
      compare + dateField + impact +
      '<form id="review-form" data-form="review-resolve" data-review="' + esc(r.id) + '">' + candidateHTML + '</form>' +
      locked +
      '<div class="review-demo-link">评审用：<button class="linkbtn" data-action="review-conflict">模拟版本冲突（409）</button> · 处理时需同时校验复核项与申请两份版本。</div>' +
      (o.conflict ? '<div class="login-error" style="margin-top:12px">' + I.alert + '<span>复核项或目标申请已被更新（409）。已重取最新版本，请重新做出决定，页面不会自动覆盖。</span></div>' : '') +
    '</div>' +
    '<footer class="panel-foot"><span class="panel-foot__note">复核项不是第八种状态；只有明确确认后才写台账。</span><div class="panel-foot__actions">' +
      primary +
      (blocked
        ? '<button class="btn" type="button" data-action="close-overlay">保留待确认</button>'
        : '<button class="btn btn--ghost" type="button" data-action="review-dismiss" data-id="' + esc(r.id) + '">忽略此项</button><button class="btn btn--ghost" type="button" data-action="close-overlay">关闭</button>') +
    '</div></footer>' +
  '</div>';
}

/* ---------------- manual backfill ---------------- */

function manualOverlayHTML(o) {
  const tab = o.tab || 'manual';
  const pre = o.prefill || {};
  const tabs = '<div class="seg" style="margin-bottom:18px">' +
    [['manual', '手动录入'], ['paste', '粘贴链接 / JD'], ['ocr', '截图识别']].map(([v, label]) =>
      '<label><input type="radio" name="manual-tab" value="' + v + '"' + (tab === v ? ' checked' : '') + ' data-manual-tab>' + label + '</label>'
    ).join('') + '</div>';

  let body = '';
  let foot = '';
  if (tab === 'manual') {
    body = '<form id="manual-form" data-form="manual">' +
      (o.draftNotice ? '<div class="login-sent" style="margin-bottom:16px">' + I.info + '<span>' + esc(o.draftNotice) + '</span></div>' : '') +
      '<div class="field-row">' +
        '<div class="field"><label for="m-company">公司 <span class="opt">必填</span></label><input class="input" id="m-company" name="company" value="' + esc(pre.company || '') + '" placeholder="例如：某公司" data-autofocus /></div>' +
        '<div class="field"><label for="m-title">岗位 <span class="opt">必填</span></label><input class="input" id="m-title" name="jobTitle" value="' + esc(pre.title || '') + '" placeholder="例如：产品运营" /></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label for="m-channel">投递渠道</label><select class="select" id="m-channel" name="channel">' + CHANNELS.map(c => '<option' + ((pre.channel || '手动补录') === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="m-status">状态</label><select class="select" id="m-status" name="status">' +
          ['applied', 'assessment', 'interview', 'offer', 'rejected', 'closed'].map(k => '<option value="' + k + '"' + (k === 'applied' ? ' selected' : '') + '>' + STATUS[k].label + '</option>').join('') +
        '</select></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label for="m-date">投递日期 <span class="opt">不默认今天</span></label><input class="input" id="m-date" name="appliedAt" type="date" max="2026-10-21" /></div>' +
        '<div class="field"><label for="m-precision">时间精度</label><select class="select" id="m-precision" name="precision"><option value="date">仅日期</option><option value="unknown">未知</option></select><span class="field-hint">选「未知」会转待确认（D12）。</span></div>' +
      '</div>' +
      '<div class="field"><label for="m-jd">JD 摘要 <span class="opt">≤80 字，可空</span></label><textarea class="textarea" id="m-jd" name="jd" maxlength="120" placeholder="粘贴或概括岗位职责；不要填不存在的薪资、门槛">' + esc(pre.jd || '') + '</textarea></div>' +
      '<div class="field"><label for="m-url">岗位链接 <span class="opt">安全 http(s)</span></label><input class="input" id="m-url" name="jobUrl" type="url" placeholder="https://" value="' + esc(pre.jobUrl || '') + '" /></div>' +
      '<div class="form-note">提交带幂等键；重复点击不会新增两条。公司 + 岗位命中已有记录时会进入复核，不会强行合并。缺失的 JD / 链接 / 时间不会被假值填充。</div>' +
    '</form>';
    foot = '<footer class="panel-foot"><span class="panel-foot__note">补录是兜底路径，不要求每次投递后回来填写。</span><div class="panel-foot__actions"><button type="button" class="btn btn--ghost" data-action="close-overlay">取消</button><button class="btn btn--primary" type="submit" form="manual-form">提交补录</button></div></footer>';
  } else if (tab === 'paste') {
    body = '<form id="paste-form" data-form="paste">' +
      '<div class="field"><label for="p-text">粘贴岗位链接或 JD 文本</label><textarea class="textarea" id="p-text" name="text" rows="6" placeholder="https://… 或 JD 正文"></textarea><span class="field-hint">只会形成「待检查字段」。粘贴 URL 不代表后台能绕过登录去抓取页面。</span></div>' +
      '<div class="form-note">解析只在本页做演示性提取；不会发起对外请求，也不保证字段正确。</div>' +
      (o.parsed ? '<div class="review-reason" style="background:var(--pine-tint);border-color:#d3e3da;color:var(--ink-2)"><strong>已提取 3 个待检查字段（演示）：</strong><br>公司：待核对公司 · 岗位：待核对岗位 · 摘要：' + esc(o.parsed.jd) + '<br><button type="button" class="linkbtn" data-action="use-parsed" style="margin-top:6px">带入手动录入并核对</button></div>' : '') +
    '</form>';
    foot = '<footer class="panel-foot"><span class="panel-foot__note">字段未验证，提交前必须核对。</span><div class="panel-foot__actions"><button type="button" class="btn btn--ghost" data-action="close-overlay">取消</button><button class="btn btn--primary" type="submit" form="paste-form">解析为待检查字段</button></div></footer>';
  } else {
    body = '<div class="empty--simple" style="border:0;padding:0">' +
      '<h2 style="font-size:20px">截图识别暂未开放</h2>' +
      '<p>截图可能包含个人信息；选区、外发告知与供应商保留策略（D09）尚未冻结。这里不做「识别成功」的假演示。</p>' +
      '<div class="review-locked">目前的兜底路径：手动录入，或粘贴链接 / JD 形成待检查字段。两者都不会绕过字段校验。</div>' +
      '<div class="empty__actions"><button class="btn" data-action="set-manual-tab" data-tab="manual">转手动录入</button><button class="btn btn--ghost" data-action="close-overlay">关闭</button></div>' +
    '</div>';
  }

  return '<div class="drawer drawer--wide" role="dialog" aria-modal="true" aria-label="补录投递">' +
    headHTML('兜底补录 · 不是日常流程', '补录投递') +
    '<div class="panel-body">' +
      '<p class="field-hint" style="margin-bottom:14px">把漏采的线索补进台账。它与「已归档」入口不是同一个动作；正式投递请尽量由插件或邮件确证。</p>' +
      tabs + body +
    '</div>' +
    foot +
  '</div>';
}

/* ---------------- settings ---------------- */

function settingsOverlayHTML(o) {
  const s = state.settings;
  const contentOptions = [
    ['all', '全部', 'A 类状态变化 + B 类待回看，合并成一封'],
    ['changes_only', '只要状态变化', '仅在有状态跃迁、48h 截止或新线索时发信'],
    ['review_only', '只要待回看', '仅在已投 ≥' + s.threshold + ' 天且无变化时发信'],
    ['off', '关闭', '停止摘要邮件；邮箱同步与台账更新继续']
  ];
  return '<div class="modal" role="dialog" aria-modal="true" aria-label="提醒设置">' +
    headHTML('账号设置', '提醒设置') +
    '<div class="panel-body">' +
      '<form id="settings-form" data-form="settings">' +
        '<div class="group"><div class="group__title"><h3>发什么</h3><span>无内容时 0 封</span></div>' +
          '<div class="radio-list">' + contentOptions.map(([v, label, desc]) =>
            '<label class="radio-card"><input type="radio" name="content" value="' + v + '"' + (s.content === v ? ' checked' : '') + '>' +
              '<span><b>' + label + '</b><span>' + desc + '</span></span></label>'
          ).join('') + '</div>' +
          '<p class="field-hint" style="margin-top:9px">A 类每日 08:00 评估；B 类按下方频率评估。A、B 都为空时不发送任何邮件。</p>' +
        '</div>' +
        '<div class="group"><div class="group__title"><h3>待回看频率</h3><span>D06 待冻结</span></div>' +
          '<div class="setting-row"><div class="setting-row__main"><b>检查频率</b><span>「每日」代表每天评估新到期记录；同一岗位仍最多 7 天出现一次。</span></div>' +
            '<div class="setting-row__control"><div class="seg">' +
              '<label><input type="radio" name="frequency" value="weekly"' + (s.frequency === 'weekly' ? ' checked' : '') + '>每周一</label>' +
              '<label><input type="radio" name="frequency" value="daily"' + (s.frequency === 'daily' ? ' checked' : '') + '>每日</label>' +
            '</div></div>' +
          '</div>' +
          '<div class="setting-row"><div class="setting-row__main"><b>回看阈值</b><span>已投满 N 天且状态无变化，才进入待回看；不影响「该记录是否已投」。</span></div>' +
            '<div class="setting-row__control"><select class="select" name="threshold">' +
              [7, 14, 21, 30].map(n => '<option value="' + n + '"' + (Number(s.threshold) === n ? ' selected' : '') + '>' + n + ' 天' + (n === 14 ? '（默认）' : '') + '</option>').join('') +
            '</select></div>' +
          '</div>' +
          '<div class="setting-row"><div class="setting-row__main"><b>发送时间</b><span>北京时间 08:00 批次；准点送达承诺以 D11 为准。</span></div><div class="setting-row__control"><span class="tag tag--plain">每日 08:00</span></div></div>' +
        '</div>' +
        '<div class="group"><div class="group__title"><h3>不发什么</h3><span>静默原则</span></div>' +
          '<p class="field-hint">不做日报，不发「今日无更新」，不发安慰性内容。关闭提醒只停止摘要邮件，不停止邮箱同步；断开邮箱请在「数据与授权」操作。</p>' +
          '<div class="section-actions"><button type="button" class="btn btn--sm" data-action="preview-mail">预览提醒邮件</button></div>' +
        '</div>' +
      '</form>' +
    '</div>' +
    '<footer class="panel-foot">' +
      '<span class="panel-foot__note">保存失败会保留旧值并提示，不会假装已保存。</span>' +
      '<div class="panel-foot__actions"><button type="button" class="btn" data-action="close-overlay">取消</button><button class="btn btn--primary" type="submit" form="settings-form">保存设置</button></div>' +
    '</footer>' +
  '</div>';
}

/* ---------------- auth & data ---------------- */

function authOverlayHTML() {
  const c = scenarioConf();
  const mailState = c.mailExpired ? 'reauth_required' : c.mailDegraded ? 'degraded' : state.mail.state;
  const mailMap = {
    connected: ['已连接', 'dot-state--ok'],
    syncing: ['同步中', 'dot-state--warn'],
    degraded: ['同步暂受阻', 'dot-state--warn'],
    reauth_required: ['授权已失效', 'dot-state--bad'],
    disconnected: ['已断开', 'dot-state--idle']
  };
  const ms = mailMap[mailState] || mailMap.disconnected;
  const mailTag = {
    connected: '标题 + 命中正文',
    syncing: '首次同步中',
    degraded: '退避重试中',
    reauth_required: '需重新授权',
    disconnected: '已断开'
  }[mailState] || '已断开';

  const pluginStale = c.pluginStale;
  let pluginChip, pluginDot;
  if (!state.plugin.bound) { pluginChip = state.plugin.revokedAt ? '服务端已撤销' : '尚无绑定设备'; pluginDot = 'dot-state--idle'; }
  else if (pluginStale) { pluginChip = '最近未联系'; pluginDot = 'dot-state--warn'; }
  else { pluginChip = '已绑定'; pluginDot = 'dot-state--ok'; }

  const cleanupText = state.plugin.cleanup === 'acknowledged'
    ? '已回执（' + esc(state.plugin.revokedAt) + ' 后由设备确认停采并清队列）'
    : '待确认（离线或未运行扩展无法保证瞬时清理）';

  return '<div class="modal modal--wide" role="dialog" aria-modal="true" aria-label="数据与授权">' +
    headHTML('账号', '数据与授权') +
    '<div class="panel-body">' +
      '<p class="field-hint" style="margin-bottom:16px">插件与邮箱是两项独立授权。这里显示后台最近受理状态，不用网页按钮假装能直接修改 Chrome 权限。</p>' +

      '<div class="group"><div class="group__title"><h3>浏览器插件</h3><span>' + esc(pluginChip) + '</span></div>' +
        '<div class="health"><div class="health__main">' +
          '<div class="health__title"><span class="dot-state ' + pluginDot + '"></span>' + esc(pluginChip) + (state.plugin.bound ? '<span class="tag tag--plain">' + esc(state.plugin.device) + '</span>' : '') + '</div>' +
          '<div class="health__sub">' + (pluginStale ? '最近一次联系在 6 天前。心跳不能证明扩展已卸载，也不代表 Chrome 权限仍开启。' : state.plugin.bound ? '只对已授权的招聘站点生效；未授权域名不注入。' : '网页无法替你读取扩展状态；安装检测、主机权限与设备绑定是不同层。') + '</div>' +
        '</div><div class="health__action"><button class="btn btn--sm" data-action="plugin-scope">支持范围</button></div></div>' +
        '<dl class="kv-list">' +
          '<div class="kv-list__row"><dt>最近心跳</dt><dd>' + (pluginStale ? '2026-10-15 09:20（6 天前）' : esc(state.plugin.lastSeen)) + '</dd></div>' +
          '<div class="kv-list__row"><dt>最近采集</dt><dd>' + esc(state.plugin.lastCollected) + '</dd></div>' +
          '<div class="kv-list__row"><dt>后台受理</dt><dd>' + esc(state.plugin.lastAccepted) + ' <span class="muted">（上传重试 ≠ 新采集）</span></dd></div>' +
          '<div class="kv-list__row"><dt>逐站授权</dt><dd>在扩展内逐站授予 / 撤销；网页只展示可确认状态</dd></div>' +
        '</dl>' +
        (state.plugin.revokedAt ? '<div class="banner banner--warn" style="margin-top:12px"><span class="banner__icon">' + I.alert + '</span><div class="banner__body"><strong>服务端已撤销：' + esc(state.plugin.revokedAt) + '</strong><br>设备清理：' + esc(cleanupText) + '</div></div>' : '') +
        '<div class="section-actions">' +
          (state.plugin.bound ? '<button class="btn btn--sm btn--danger" data-action="request-unbind">解绑此设备</button>' : '') +
          '<button class="btn btn--sm btn--ghost" data-action="demo-noop" data-msg="逐站授权在扩展内完成；网页不直接修改 Chrome 权限（演示）">逐站授权说明</button>' +
        '</div>' +
      '</div>' +

      '<div class="group"><div class="group__title"><h3>QQ 邮箱</h3><span>' + esc(ms[0]) + '</span></div>' +
        '<div class="health"><div class="health__main">' +
          '<div class="health__title"><span class="dot-state ' + ms[1] + '"></span>' + esc(ms[0]) + '<span class="tag tag--plain">' + esc(mailTag) + '</span></div>' +
          '<div class="health__sub">' + (mailState === 'reauth_required'
            ? '授权码可能已失效或服务端连接失败。同步失败不会静默吞掉；重新授权前不会继续读取邮件。'
            : mailState === 'degraded'
              ? 'IMAP 访问暂受阻，按退避策略重试；上次成功同步时间保持不变。'
              : mailState === 'disconnected'
                ? '已停止后续同步。历史台账保留，不代表已删除历史数据。'
                : '只读取命中招聘候选的必要邮件头部；正文仅按所选模式处理；不读附件，默认不保留正文。') + '</div>' +
        '</div><div class="health__action">' +
          (mailState === 'disconnected'
            ? '<button class="btn btn--sm btn--primary" data-action="auth-reconnect">连接邮箱</button>'
            : '<button class="btn btn--sm" data-action="auth-reconnect">重新授权</button>') +
        '</div></div>' +
        '<dl class="kv-list">' +
          '<div class="kv-list__row"><dt>登录邮箱</dt><dd>' + (mailState === 'disconnected' ? '未连接' : esc(state.mail.address)) + '</dd></div>' +
          '<div class="kv-list__row"><dt>提醒收件人</dt><dd>' + (mailState === 'disconnected' ? '未设置' : esc(state.mail.address) + ' <span class="muted">（按后台已验证规则）</span>') + '</dd></div>' +
          '<div class="kv-list__row"><dt>读取模式</dt><dd>' + (mailState === 'disconnected' ? '—' : '主题 + 命中候选的正文；不读附件') + '</dd></div>' +
          '<div class="kv-list__row"><dt>最近成功同步</dt><dd>' + (mailState === 'disconnected' ? '—' : esc(state.mail.lastSuccess)) + '</dd></div>' +
          '<div class="kv-list__row"><dt>正文保留</dt><dd>默认不保留；可选保留尚未验证，故不开放控件</dd></div>' +
        '</dl>' +
        '<div class="section-actions">' +
          (mailState !== 'disconnected' ? '<button class="btn btn--sm btn--danger" data-action="request-disconnect-mail">断开邮箱</button>' : '') +
          '<button class="btn btn--sm btn--ghost" data-action="demo-noop" data-msg="首扫范围：收件箱 · 近 30 天；文件夹与日期以 D09 冻结为准（演示）">查看首扫范围</button>' +
        '</div>' +
      '</div>' +

      '<div class="danger-zone"><h3>删除全部业务数据</h3>' +
        '<p>删除申请、状态历史、事件、复核项、邮箱凭证、提醒记录与设备数据，不可恢复。它不等于注销登录账号；已交给邮件服务商的邮件无法召回。</p>' +
        '<div class="section-actions"><button class="btn btn--sm btn--danger" data-action="request-delete">删除全部业务数据</button></div>' +
      '</div>' +
      '<p class="field-hint" style="margin-top:14px">删除是异步任务：202 只代表已受理。云端 / 备份完成不代表离线设备已清理；范围会分别回执。</p>' +
    '</div>' +
  '</div>';
}

/* ---------------- mail wizard ---------------- */

function wizardOverlayHTML(o) {
  const steps = ['scope', 'info', 'confirm', 'connecting', 'done'];
  const idx = steps.indexOf(o.step);
  const stepLabels = [['1', '授权范围'], ['2', '连接信息'], ['3', '再次确认'], ['4', '连接']];
  const stepper = '<div class="steps">' + stepLabels.map((s, i) => {
    const stateCls = i < idx ? ' is-done' : i === Math.min(idx, 3) ? ' is-active' : '';
    return (i ? '<span class="step__line"></span>' : '') + '<span class="step' + stateCls + '"><span class="step__num">' + (i < idx ? '✓' : s[0]) + '</span>' + s[1] + '</span>';
  }).join('') + '</div>';

  let body = '';
  if (o.step === 'scope') {
    body = '<div class="wizard-copy"><strong>在连接之前，先说明会读什么。</strong> QQ 邮箱使用 IMAP + 16 位授权码，不是 QQ 登录密码。</div>' +
      '<ul class="wizard-list">' +
        '<li>先按发件域名与主题筛选，只读取命中招聘候选的邮件头部。</li>' +
        '<li>正文仅在下一步选择的模式内处理；不读附件，不做发送 / 删除 / 标记。</li>' +
        '<li>默认不保留正文，只落结构化事件；可随时断开，断开后停止后续同步。</li>' +
        '<li>提醒邮件发到后台已验证的收件人，不提供任意收件地址输入。</li>' +
      '</ul>' +
      '<div class="scope-box"><h4>已知限制</h4><p>QQ / 163 的 IMAP 服务端要求客户端先发送 ID 命令；未发送会被断开。首扫范围默认收件箱近 30 天，具体以 D09 冻结为准。</p></div>' +
      '<label class="checkline"><input type="checkbox" id="wiz-ack" /> 我已了解上述读取范围与限制，并确认这是本人邮箱。</label>';
  } else if (o.step === 'info') {
    body = '<form id="wizard-info-form" data-form="wizard-info">' +
      '<div class="field"><label>读取模式</label>' +
        '<label class="radio-card" style="border-bottom:1px solid var(--line)"><input type="radio" name="mode" value="headline"' + (o.mode === 'headline' ? ' checked' : '') + '><span><b>只读标题（更安全）</b><span>覆盖率较低；正文类通知可能识别不到。</span></span></label>' +
        '<label class="radio-card"><input type="radio" name="mode" value="headline_body"' + (o.mode === 'headline_body' ? ' checked' : '') + '><span><b>标题 + 命中候选的正文（推荐）</b><span>只处理招聘候选；默认不保留原文。</span></span></label>' +
      '</div>' +
      '<div class="field"><label for="wiz-email">QQ 邮箱</label><input class="input" id="wiz-email" name="email" type="email" placeholder="name@qq.com" value="' + esc(o.email || '') + '" data-autofocus /></div>' +
      '<div class="field"><label for="wiz-code">16 位授权码</label><input class="input" id="wiz-code" name="code" type="password" autocomplete="off" placeholder="不是 QQ 登录密码" /><span class="field-hint">授权码只随本次提交发送，不写入本地缓存、日志或埋点；提交后清空。</span></div>' +
      '<div class="form-note">需要先在 QQ 邮箱设置中开启 IMAP/SMTP 服务。连接中返回 202 只代表已受理，成功与否以状态查询为准。</div>' +
    '</form>';
  } else if (o.step === 'confirm') {
    body = '<div class="wizard-copy"><strong>再确认一次。</strong> 连接后服务端会先验证 IMAP 登录，再开始增量同步；不会声称「已同步全部历史邮件」。</div>' +
      '<div class="scope-box"><h4>本次连接</h4><p>邮箱：' + esc(o.email) + '<br>模式：' + (o.mode === 'headline' ? '只读标题' : '标题 + 命中候选的正文') + '<br>首扫：收件箱 · 近 30 天（以 D09 冻结为准）<br>提醒收件人：与登录邮箱一致（后台已验证规则）</p></div>' +
      '<div class="delete-warning" style="margin-top:14px">授权码权限较广。我们不会读取附件、不会发送或删除邮件；默认不保留正文。若你不再需要，可随时在此面板断开。</div>' +
      '<label class="checkline"><input type="checkbox" id="wiz-final" /> 我确认连接，并理解同步可能受频率限制而延迟。</label>';
  } else if (o.step === 'connecting') {
    body = '<div class="connecting"><div class="spinner"></div><p>正在连接 QQ 邮箱…</p><span>服务端已受理（202），正在验证 IMAP 与 ID 命令。不会用固定计时伪造成功。</span></div>';
  } else {
    body = '<div style="padding:6px 0 4px"><div class="result-mark">' + I.check + '</div>' +
      '<div class="wizard-copy" style="text-align:center"><strong>已连接，首次同步开始</strong><br><span class="muted">首扫：收件箱 · 近 30 天。同步结果会逐条归入台账，未完成前不宣称已同步全部。</span></div>' +
      '<div class="scope-box"><h4>接下来</h4><p>共 126 / 约 400 封待处理。命中招聘候选的邮件会进入归属与事件判定；归属不清的进入待确认，不自动改状态。</p></div></div>';
  }

  return '<div class="modal" role="dialog" aria-modal="true" aria-label="连接 QQ 邮箱">' +
    headHTML('QQ 邮箱 · 独立授权', o.step === 'done' ? '连接结果' : '连接邮箱') +
    '<div class="panel-body">' + (o.step === 'done' ? '' : stepper) + body + '</div>' +
    '<footer class="panel-foot"><span class="panel-foot__note">授权码不会写入 URL、日志或本地持久缓存。</span><div class="panel-foot__actions">' +
      (o.step === 'scope' ? '<button class="btn btn--ghost" data-action="close-overlay">取消</button><button class="btn btn--primary" data-action="wizard-next">继续</button>' : '') +
      (o.step === 'info' ? '<button class="btn btn--ghost" type="button" data-action="wizard-prev">上一步</button><button class="btn btn--primary" type="submit" form="wizard-info-form">连接</button>' : '') +
      (o.step === 'confirm' ? '<button class="btn btn--ghost" data-action="wizard-prev">上一步</button><button class="btn btn--primary" data-action="wizard-connect">确认连接</button>' : '') +
      (o.step === 'done' ? '<button class="btn btn--primary" data-action="wizard-finish">完成</button>' : '') +
      (o.step === 'connecting' ? '<button class="btn" data-action="close-overlay">稍后查看</button>' : '') +
    '</div></footer>' +
  '</div>';
}

/* ---------------- confirm / delete ---------------- */

function confirmOverlayHTML(o) {
  let title = '', text = '', label = '确认', danger = false;
  if (o.intent === 'archive') {
    title = '归档这条记录？';
    text = '归档后会从「已投递明细」移到「已归档」。归档不等于拒绝，累计投递不会减少；恢复是显式动作。';
    label = '归档记录';
  } else if (o.intent === 'unarchive') {
    title = '恢复这条记录？';
    text = '恢复后会回到「已投递明细」；已投天数按原投递时间继续计算，不会重置。';
    label = '恢复记录';
  } else if (o.intent === 'unbind') {
    title = '解绑这台设备？';
    text = '服务端会立即撤销旧绑定并拒绝该设备后续上传；历史台账保留。离线或未运行的扩展无法保证即时获知撤销，设备清理状态会单独显示。';
    label = '解绑设备';
    danger = true;
  } else if (o.intent === 'disconnect-mail') {
    title = '断开 QQ 邮箱？';
    text = '断开后停止后续同步，已有台账保留；它不等于删除历史数据。重新连接需要再次提供授权码。';
    label = '断开邮箱';
    danger = true;
  }
  return '<div class="modal modal--narrow" role="dialog" aria-modal="true" aria-label="确认操作">' +
    headHTML('确认', title) +
    '<div class="panel-body"><p class="wizard-copy">' + esc(text) + '</p>' +
      (o.intent === 'unbind' ? '<div class="terminal-note">普通心跳不算清理回执；只有设备实际停采、清队列并返回验证过的回执，才显示「设备已清理」。</div>' : '') +
      (o.intent === 'disconnect-mail' ? '<div class="terminal-note">提醒邮件会停止；账号与台账不受影响。</div>' : '') +
    '</div>' +
    '<footer class="panel-foot"><span class="panel-foot__note">演示操作只作用于本页内存。</span><div class="panel-foot__actions">' +
      '<button class="btn btn--ghost" data-action="close-overlay">取消</button>' +
      '<button class="btn ' + (danger ? 'btn--danger' : 'btn--primary') + '" data-action="confirm-intent" data-intent="' + esc(o.intent) + '" data-id="' + esc(o.id || '') + '">' + label + '</button>' +
    '</div></footer>' +
  '</div>';
}

function deleteConfirmHTML() {
  return '<div class="modal modal--narrow" role="dialog" aria-modal="true" aria-label="删除全部业务数据">' +
    headHTML('危险操作 · 需要重新鉴权', '删除全部业务数据') +
    '<div class="panel-body">' +
      '<div class="delete-warning">此操作不可恢复。删除范围包括：申请与状态历史、采集事件、复核项、邮箱凭证与游标、提醒记录与批次、设备绑定。它不注销登录账号，也不能召回已交给邮件服务商的邮件。</div>' +
      '<ul class="delete-scope">' +
        ['申请 / 历史 / 事件', '复核项与提醒', 'QQ 邮箱凭证与游标', '插件设备绑定'].map(t => '<li>' + I.check + t + '</li>').join('') +
      '</ul>' +
      '<div class="delete-verify"><div class="field"><label for="delete-confirm-input">输入 <code>删除</code> 以确认</label><input class="input" id="delete-confirm-input" autocomplete="off" placeholder="删除" data-autofocus /></div>' +
      '<p class="field-hint">正式环境会重新验证登录身份，而不是只靠这个输入框。</p></div>' +
    '</div>' +
    '<footer class="panel-foot"><span class="panel-foot__note">删除会阻止后续发信；已发出的邮件无法撤回。</span><div class="panel-foot__actions">' +
      '<button class="btn btn--ghost" data-action="close-overlay">取消</button>' +
      '<button class="btn btn--danger" id="delete-confirm-btn" data-action="start-deletion" disabled>确认删除</button>' +
    '</div></footer>' +
  '</div>';
}

function deleteProgressHTML(o) {
  const d = state.deletion;
  const phase = o.phase;
  const progress = o.progress || 0;
  const title = phase === 'running' ? '正在删除…' : phase === 'failed' ? '删除任务失败' : phase === 'done' ? '删除任务已完成' : '云端已完成，备份与设备待确认';
  const scopeRows = phase === 'running' ? [
    ['云端业务数据', '删除中…', 'is-wait'],
    ['备份数据', '未开始', 'is-wait'],
    ['离线设备清理', '待确认', 'is-unknown']
  ] : [
    ['云端业务数据', phase === 'done' ? '已验证删除' : phase === 'failed' ? '未完成' : '已完成', phase === 'done' ? 'is-ok' : phase === 'failed' ? 'is-unknown' : 'is-ok'],
    ['备份数据', phase === 'done' ? '已到期清除' : phase === 'failed' ? '未开始' : '等待备份到期', phase === 'done' ? 'is-ok' : 'is-wait'],
    ['离线设备清理', phase === 'done' ? '已验证回执' : '待确认', phase === 'done' ? 'is-ok' : 'is-unknown']
  ];

  return '<div class="modal" role="dialog" aria-modal="true" aria-label="删除任务">' +
    headHTML('任务 ' + (o.taskId || d.taskId || 'del_demo_7c2a'), title) +
    '<div class="panel-body">' +
      '<div class="delete-task">' +
        '<div class="delete-task__head"><span>删除全部业务数据</span><span class="delete-task__id">' + esc(o.taskId || d.taskId || 'del_demo_7c2a') + '</span></div>' +
        '<div class="progress' + (phase === 'failed' ? ' progress--danger' : '') + '"><span class="progress__bar" style="width:' + progress + '%"></span></div>' +
        '<div class="small muted" style="margin-top:7px">' + (phase === 'running' ? '202 已受理 · 状态来自任务查询，不靠前端动画推进' : phase === 'failed' ? '阻写状态保持，可安全重试；不会假装完成' : phase === 'done' ? '仅代表已验证的 scope' : '云端范围已完成；备份未到期、设备未回执，不等于全部清除') + '</div>' +
      '</div>' +
      (phase === 'failed' ? '<div class="login-error" style="margin-top:14px">' + I.alert + '<span>删除任务在 38% 处失败。数据仍处于阻写状态；请重试或联系处理。request_id: req_del_9f2</span></div>' : '') +
      '<ul class="scope-result">' + scopeRows.map(([k, v, cls]) => '<li><span>' + k + '</span><span class="' + cls + '">' + v + '</span></li>').join('') + '</ul>' +
      (phase === 'partial' ? '<div class="terminal-note">页面不会写「所有数据已彻底清除」。备份到期与设备清理未知时，只能确认云端范围完成。</div>' : '') +
      (phase === 'done' ? '<div class="terminal-note">全部 scope 已验证，包括设备清理回执。已交给供应商的邮件仍不可召回。</div>' : '') +
      '<p class="field-hint" style="margin-top:12px">进度来自 GET 删除任务状态；最小撤销 / 清理回执的保留范围以后台验证为准。</p>' +
    '</div>' +
    '<footer class="panel-foot"><span class="panel-foot__note">删除后不会静默恢复旧数据。</span><div class="panel-foot__actions">' +
      (phase === 'failed' ? '<button class="btn btn--danger" data-action="retry-deletion">重试删除</button><button class="btn btn--ghost" data-action="close-overlay">稍后处理</button>' : '') +
      (phase === 'running' ? '<button class="btn" data-action="close-overlay">后台继续</button>' : '') +
      (phase === 'partial' || phase === 'done' ? '<button class="btn" data-action="close-overlay">知道了</button>' : '') +
    '</div></footer>' +
  '</div>';
}

/* ---------------------------------------------------------
   9. Mail preview & landing
   --------------------------------------------------------- */

function mailDocHTML() {
  const due = visibleApps().filter(isDue).slice(0, 3);
  const progress = visibleApps().filter(a => !a.archived && ['interview', 'assessment'].includes(a.status)).slice(0, 2);
  const dueText = due.map(a => {
    const n = daysSince(a.appliedAt);
    return '<div class="mail-item">' +
      '<div class="mail-item__top"><span class="mail-item__company">' + esc(a.company) + '</span><span class="mail-item__role">· ' + esc(a.title) + '</span><span class="mail-days">已投 ' + n + ' 天</span></div>' +
      '<div class="mail-item__actions">' +
        '<button class="mail-btn mail-btn--primary" data-action="goto-mail-landing">查看状态</button>' +
        '<button class="mail-btn" data-action="external" data-url="' + esc(a.jobUrl) + '">查看岗位</button>' +
      '</div>' +
    '</div>';
  }).join('');

  const progressText = progress.map(a =>
    '<div class="mail-item"><div class="mail-item__top"><span class="mail-item__company">' + esc(a.company) + '</span><span class="mail-item__role">· ' + esc(a.title) + '</span></div>' +
      '<div class="mail-item__change">' + (a.status === 'interview' ? '已投递 → 面试中' : '已投递 → 笔试中') + (a.roundLabel ? ' · ' + esc(a.roundLabel) : '') + '</div>' +
      '<div class="mail-item__from">来自邮件 ' + esc(shortAt(a.lastStatusChangedAt)) + '</div></div>'
  ).join('');

  return '<div class="mail-doc">' +
    '<div class="mail-doc__head"><div class="mail-doc__brand"><span class="mark" style="width:22px;height:22px;font-size:13px;flex-basis:22px">T</span>Tounar <span>帮你理</span></div>' +
      '<div class="mail-doc__meta">发送至 m***@qq.com<br>2026-10-21 08:00（北京时间）</div></div>' +
    '<div class="mail-doc__body">' +
      '<h1 class="mail-subject">【Tounar】' + (progress.length || 2) + ' 个岗位有进展 · ' + (due.length || 3) + ' 个岗位已投 14 天以上</h1>' +
      '<p class="mail-lead">只列出有变化、或到了回看节点的岗位。其余记录不在这封邮件里。</p>' +
      '<section class="mail-section"><div class="mail-section__title">一、有进展 <span>' + (progress.length || 2) + '</span></div>' +
        (progressText || '<div class="mail-item"><span class="muted">本批次没有状态变化。</span></div>') + '</section>' +
      '<section class="mail-section"><div class="mail-section__title">二、等待回看 <span>' + (due.length || 3) + '</span></div>' +
        (dueText || '<div class="mail-item"><span class="muted">还没有到回看节点的岗位。</span></div>') + '</section>' +
    '</div>' +
    '<div class="mail-doc__foot">—— 没有进展、也没到回看节点的岗位，不出现在这封邮件里。链接先到安全落地页；打开页面不会自动标记已确认。<br>' +
      '<div class="mail-foot-links"><button class="linkbtn" data-action="goto-settings">提醒设置</button><button class="linkbtn" data-action="goto-ledger">打开台账</button></div>' +
    '</div>' +
  '</div>';
}

function mailPreviewHTML() {
  return '<div class="mail-page">' +
    '<div class="mail-chrome"><div class="mail-chrome__left"><span class="brandline"><span class="mark" style="width:22px;height:22px;font-size:13px;flex-basis:22px">T</span><span class="wordmark">Tounar <small>帮你理</small></span></span><span class="demo-flag">演示数据 · 邮件预览</span></div>' +
      '<div style="display:flex;gap:8px"><button class="btn btn--ghost" data-action="goto-ledger">返回台账</button></div></div>' +
    mailDocHTML() +
    '<p class="mail-doc__meta" style="max-width:640px;margin:14px auto 0;text-align:left;font-size:10px;color:var(--ink-3)">这是将发送到提醒收件人的邮件。A、B 两类都为空时，产品不发任何邮件；同一天所有内容合并成一封。</p>' +
  '</div>';
}

function mailLandingHTML() {
  const a = findApp('app_01');
  const n = a ? daysSince(a.appliedAt) : 18;
  const phase = state.landing.phase;

  let confirmBlock = '';
  if (phase === 'done') {
    confirmBlock = '<div class="landing-confirm"><div class="landing-done"><div class="result-mark">' + I.check + '</div>' +
      '<h2>已确认 · 状态无变化</h2>' +
      '<p>本次确认已写入台账。下一次回看从今天重新计时；重复打开本页不会重复计时。</p>' +
      '<div class="landing-done__meta">' + NOW + ' · 已重取当前详情与列表 · 演示任务已记录</div></div></div>';
  } else {
    let btn = '<button class="btn btn--primary" data-action="landing-confirm">已确认，状态无变化</button>';
    if (phase === 'preparing') btn = '<button class="btn btn--primary" disabled>正在准备确认资格…</button>';
    if (phase === 'ready') btn = '<button class="btn btn--primary" data-action="landing-submit">提交确认</button>';
    if (phase === 'submitting') btn = '<button class="btn btn--primary" disabled>正在提交…</button>';
    confirmBlock = '<div class="landing-confirm"><h2>看完了？确认状态没有变化</h2>' +
      '<p>确认后会记录本次查看时间，并从今天重新计算回看间隔。只有你明确点击按钮才会生效；打开本页或邮件预取都不会标记。</p>' +
      (phase === 'ready' ? '<div class="landing-confirm__state" style="margin-bottom:10px">' + I.lock + '<span>一次性确认资格已就绪，只保存在本页内存。刷新后需要重新点击。</span></div>' : '') +
      btn +
      '<p class="field-hint" style="margin-top:10px">若状态已经变化，请先打开官网确认；回到台账后可用纠错更新。</p></div>';
  }

  return '<div class="landing">' +
    '<div class="landing__chrome"><div class="brandline"><span class="mark" style="width:22px;height:22px;font-size:13px;flex-basis:22px">T</span><span class="wordmark">Tounar <small>帮你理</small></span></div>' +
      '<div style="display:flex;align-items:center;gap:10px"><span class="demo-flag">邮件落地页 · 演示</span><button class="btn btn--sm btn--ghost" data-action="goto-ledger">返回台账</button></div></div>' +
    '<main class="landing__card">' +
      '<div class="landing__head">' +
        '<div class="landing__eyebrow">来自提醒邮件 · 安全定位</div>' +
        '<h1 class="landing__company">' + esc(a ? a.company : '字节跳动') + '</h1>' +
        '<div class="landing__role">' + esc(a ? a.title : '产品经理（国际化）') + '</div>' +
        '<div class="landing__facts">' +
          '<div class="landing__fact"><span>已投</span><strong>' + n + ' 天</strong></div>' +
          '<div class="landing__fact"><span>最近官网采集</span><strong>' + (a && a.lastSiteObservedAt ? esc(shortAt(a.lastSiteObservedAt)) : '未采集') + '</strong></div>' +
          '<div class="landing__fact"><span>最近确认</span><strong>' + (phase === 'done' ? '刚刚' : (a && a.lastReviewedAt ? esc(shortAt(a.lastReviewedAt)) : '尚未确认')) + '</strong></div>' +
        '</div>' +
      '</div>' +
      '<div class="landing__body">' +
        '<div class="landing-note">' + I.info + '<span>打开这个页面不会改变任何记录。邮件客户端与安全网关可能预取链接；预取不会标记已确认，也不会创建一次性资格。</span></div>' +
        '<div class="landing-links">' +
          '<button class="btn" data-action="external" data-url="' + esc(a ? a.statusUrl || a.jobUrl : 'https://jobs.bytedance.com/') + '">' + I.external + '打开官网状态</button>' +
          '<button class="btn btn--ghost" data-action="external" data-url="' + esc(a ? a.jobUrl : 'https://jobs.bytedance.com/') + '">' + I.external + '查看岗位</button>' +
        '</div>' +
        confirmBlock +
      '</div>' +
    '</main>' +
    '<p class="landing__foot">定位 token 只用于找到这条本人记录，不是确认凭据。确认需要你明确点击；页面不加载第三方资源，地址不做日志明文记录（演示）。</p>' +
  '</div>';
}

/* ---------------------------------------------------------
   10. Demo control panel
   --------------------------------------------------------- */

function renderDemo() {
  const root = document.getElementById('demo-root');
  if (!root) return;
  if (state.hideTool) { root.innerHTML = ''; return; }
  if (!state.demoOpen) {
    root.innerHTML = '<button class="demo-launcher" data-action="toggle-demo"><span class="demo-launcher__dot"></span>演示控制 · 评审用</button>';
    return;
  }

  const scenarios = [
    ['normal', '正常台账', '18 条记录'],
    ['empty', '新用户空台账', '0 条'],
    ['first_sync', '首次同步中', '骨架'],
    ['mail_expired', '邮箱授权失效', '顶部提醒'],
    ['mail_degraded', '邮箱同步受阻', '退避重试'],
    ['plugin_stale', '插件最近未联系', '6 天'],
    ['stale', '旧数据刷新失败', '快照'],
    ['unavailable', '数据暂不可用', '503']
  ];

  const pages = [
    ['login', '登录页'], ['ledger', '投递台账'], ['mail-preview', '提醒邮件'], ['mail-landing', '邮件落地页']
  ];

  root.innerHTML = '<aside class="demo-panel" aria-label="演示控制">' +
    '<div class="demo-panel__head"><div><div class="demo-panel__eyebrow">REVIEW TOOL · 非产品界面</div><h2>演示控制</h2></div><button class="icon-btn" data-action="toggle-demo" aria-label="关闭演示控制">' + I.close + '</button></div>' +
    '<div class="demo-panel__body">' +
      '<section class="demo-sec"><div class="demo-sec__title">页面 <span>路由切换</span></div>' +
        '<div class="demo-grid">' + pages.map(([v, label]) =>
          '<button class="demo-opt' + (state.page === v ? ' is-active' : '') + '" data-action="demo-page" data-page="' + v + '">' + label + '</button>'
        ).join('') + '</div></section>' +
      '<section class="demo-sec"><div class="demo-sec__title">台账状态 <span>对应 PRD 7.2</span></div>' +
        '<div class="demo-grid">' + scenarios.map(([v, label, note]) =>
          '<button class="demo-opt' + (state.scenario === v ? ' is-active' : '') + '" data-action="demo-scenario" data-scenario="' + v + '">' + label + '<small>' + note + '</small></button>'
        ).join('') + '</div></section>' +
      '<section class="demo-sec"><div class="demo-sec__title">删除任务结果 <span>异步范围</span></div>' +
        '<select class="demo-select" data-demo-select="deletion">' +
          '<option value="partial"' + (state.deletion.outcome === 'partial' ? ' selected' : '') + '>部分完成 · 设备待确认（默认）</option>' +
          '<option value="failed"' + (state.deletion.outcome === 'failed' ? ' selected' : '') + '>失败 · 阻写可重试</option>' +
          '<option value="full"' + (state.deletion.outcome === 'full' ? ' selected' : '') + '>全部 scope 已验证</option>' +
        '</select>' +
        '<div class="demo-row" style="margin-top:6px"><span>打开删除流程</span><button class="demo-btn" data-action="open-auth">数据与授权</button></div>' +
      '</section>' +
      '<section class="demo-sec"><div class="demo-sec__title">模拟邮件预取 <span>风险 R8</span></div>' +
        '<button class="demo-btn demo-btn--wide" data-action="demo-prefetch">HEAD 预取落地页（写入 0 条）</button>' +
        '<div class="demo-row"><span>确认资格</span><strong>' + (state.landing.phase === 'done' ? '已完成' : state.landing.phase === 'ready' ? '已就绪（内存）' : '未创建') + '</strong></div>' +
      '</section>' +
      '<section class="demo-sec"><div class="demo-sec__title">设备清理回执 <span>G03</span></div>' +
        '<div class="demo-row"><span>服务端撤销</span><strong>' + esc(state.plugin.revokedAt || '未撤销') + '</strong></div>' +
        '<div class="demo-row"><span>设备清理</span><strong>' + (state.plugin.cleanup === 'acknowledged' ? '已有回执' : state.plugin.revokedAt ? '待确认' : '—') + '</strong></div>' +
        '<button class="demo-btn demo-btn--wide" data-action="demo-device-ack" style="margin-top:6px"' + (!state.plugin.revokedAt || state.plugin.cleanup === 'acknowledged' ? ' disabled' : '') + '>模拟设备清理回执</button>' +
      '</section>' +
      '<section class="demo-sec"><div class="demo-sec__title">动作日志 <span>用于评审链路</span></div>' +
        '<div class="demo-log">' + (state.logs.length
          ? state.logs.slice(0, 8).map(l => '<div><time>' + esc(l.t) + '</time><span class="' + (l.key ? 'is-key' : '') + '">' + esc(l.msg) + '</span></div>').join('')
          : '<div class="is-empty">在落地页点击确认，或模拟预取，这里会记录只读 / 写入动作。</div>') + '</div>' +
      '</section>' +
    '</div>' +
    '<div class="demo-foot"><button class="demo-btn demo-btn--wide" data-action="demo-reset">重置演示（恢复初始数据）</button>' +
      '所有数据只在本页内存，刷新即还原；不代表真实用户记录。</div>' +
  '</aside>';
}

/* ---------------------------------------------------------
   11. Actions
   --------------------------------------------------------- */

function pushOverlay(o) {
  state.lastFocus = document.activeElement;
  state.overlays.push(o);
  renderOverlays();
  document.body.classList.add('is-locked');
}

function popOverlay() {
  state.overlays.pop();
  renderOverlays();
  if (!state.overlays.length) {
    document.body.classList.remove('is-locked');
    if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
      try { state.lastFocus.focus({ preventScroll: true }); } catch (e) {}
    }
  }
}

function closeAllOverlays() {
  state.overlays = [];
  renderOverlays();
  document.body.classList.remove('is-locked');
}

function topOverlay() { return state.overlays[state.overlays.length - 1]; }

function resetFilters() {
  state.query = '';
  state.status = 'all';
  state.source = 'all';
  state.due = false;
  state.visibleCount = 20;
}

function switchScenario(s) {
  state.scenario = s;
  state.view = 'applied';
  resetFilters();
  closeAllOverlays();
  if (state.page === 'login') { state.authed = true; state.page = 'ledger'; }
  log('场景切换 · ' + s, true);
  render();
}

function openApp(id) {
  const a = findApp(id);
  if (!a) return;
  pushOverlay({ kind: 'detail', id });
}

function openViewed(id) {
  const v = findViewed(id);
  if (!v) return;
  pushOverlay({ kind: 'detail', id, viewed: true });
}

function updateApp(id, patch) {
  const a = findApp(id);
  if (!a) return null;
  Object.assign(a, patch);
  return a;
}

function addHistory(a, from, to, by, note) {
  a.history = a.history || [];
  a.history.push(H(NOW, from, to, by, note));
}

function refreshLoginView() {
  render();
}

function handleWizardNext() {
  const o = topOverlay();
  if (!o || o.kind !== 'wizard') return;
  if (o.step === 'scope') {
    const ack = document.getElementById('wiz-ack');
    if (!ack || !ack.checked) { toast('请先确认读取范围与已知限制。', 'warn'); return; }
    o.step = 'info';
    renderOverlays();
    return;
  }
  if (o.step === 'confirm') {
    const final = document.getElementById('wiz-final');
    if (!final || !final.checked) { toast('请确认本次连接。', 'warn'); return; }
    o.step = 'connecting';
    renderOverlays();
    log('mail-connections POST → 202（已受理）', true);
    setTimeout(() => {
      state.mail.state = 'connected';
      state.mail.lastSuccess = '2026-10-21 10:44';
      state.mail.address = (o.email || 'name@qq.com').replace(/^(.{1,2}).*(@.*)$/, '$1***$2');
      if (state.scenario === 'mail_expired' || state.scenario === 'mail_degraded') state.scenario = 'normal';
      o.step = 'done';
      log('mail-connections GET → connected · 首次同步中', true);
      render();
    }, 1500);
  }
}

function startDeletion() {
  const o = topOverlay();
  state.overlays.pop();
  const task = { kind: 'delete-progress', phase: 'running', progress: 8, taskId: 'del_demo_7c2a' };
  state.deletion = { ...state.deletion, phase: 'running', progress: 8, taskId: 'del_demo_7c2a' };
  state.overlays.push(task);
  renderOverlays();
  log('data-deletions POST → 202 · del_demo_7c2a（阻写已开启）', true);

  const outcome = state.deletion.outcome;
  const steps = outcome === 'failed' ? [22, 38] : [22, 48, 71, 92, 100];
  let i = 0;
  const tick = () => {
    if (!state.overlays.includes(task)) return; // user navigated away; demo task ends
    i++;
    if (i < steps.length) {
      task.progress = steps[i];
      state.deletion.progress = steps[i];
      renderOverlays();
      setTimeout(tick, 520);
    } else {
      task.progress = outcome === 'failed' ? 38 : 100;
      task.phase = outcome === 'failed' ? 'failed' : outcome === 'full' ? 'done' : 'partial';
      state.deletion.phase = task.phase;
      state.deletion.progress = task.progress;
      log('deletion GET → ' + task.phase + ' · scope 分项回执', true);
      renderOverlays();
    }
  };
  setTimeout(tick, 600);
}

/* event: click */
function onClick(e) {
  const actEl = e.target.closest('[data-action]');

  // account menu dismissal
  if (state.accountOpen && !e.target.closest('.account') && !(actEl && actEl.dataset.action === 'toggle-account')) {
    state.accountOpen = false;
    if (!actEl) render();
  }

  if (!actEl) {
    if (e.target.classList && e.target.classList.contains('overlay')) {
      popOverlay();
    }
    return;
  }

  const action = actEl.dataset.action;
  const id = actEl.dataset.id;

  switch (action) {
    /* demo panel */
    case 'toggle-demo':
      state.demoOpen = !state.demoOpen;
      renderDemo();
      break;
    case 'demo-page': {
      const page = actEl.dataset.page;
      state.page = page;
      state.authed = page !== 'login';
      if (page === 'mail-landing') {
        state.landing = { phase: 'idle', at: '' };
        log('GET reminder-link → 只读定位 · 未写入', true);
      }
      if (page === 'mail-preview') log('打开提醒邮件预览（A + B 合并 1 封）', false);
      closeAllOverlays();
      if (state.accountOpen) state.accountOpen = false;
      render();
      break;
    }
    case 'demo-scenario':
      switchScenario(actEl.dataset.scenario);
      break;
    case 'demo-prefetch':
      log('模拟预取 · HEAD 落地页 · 写入 0 条 · 未消费确认资格', true);
      toast('预取不会标记已确认，也不会创建一次性资格。');
      break;
    case 'demo-device-ack':
      if (state.plugin.revokedAt) {
        state.plugin.cleanup = 'acknowledged';
        log('设备清理回执 → acknowledged · device_cleanup_ack_at 已记录', true);
        toast('设备已回执：已停采并清理本地队列。');
        render();
      }
      break;
    case 'demo-reset': {
      const panelOpen = state.demoOpen;
      Object.assign(state, freshState());
      state.demoOpen = panelOpen;
      clearInterval(loginTimer);
      closeAllOverlays();
      render();
      break;
    }
    case 'demo-noop':
      toast(actEl.dataset.msg || '演示环境：该动作未连接真实服务。');
      break;
    case 'demo-install':
      toast('演示环境：插件安装流程未接入；评审时请关注授权与支持范围说明。', 'warn');
      break;

    /* login */
    case 'login-change-email':
    case 'login-reset':
      state.login.email = '';
      state.login.step = 'email';
      state.login.error = '';
      state.login.countdown = 0;
      clearInterval(loginTimer);
      render();
      break;
    case 'login-resend':
      if (state.login.countdown === 0) {
        state.login.error = '';
        startLoginCountdown();
        toast('验证码已重新发送，请查收。');
        render();
      }
      break;

    /* ledger */
    case 'toggle-account':
      state.accountOpen = !state.accountOpen;
      render();
      break;
    case 'set-view':
      state.view = actEl.dataset.view;
      resetFilters();
      render();
      break;
    case 'toggle-due':
      if (state.view !== 'applied') return;
      state.due = !state.due;
      render();
      break;
    case 'clear-filters':
      resetFilters();
      render();
      break;
    case 'load-more':
      state.visibleCount += 20;
      renderLedgerBody();
      break;
    case 'retry-load':
      if (state.scenario === 'unavailable' || state.scenario === 'stale') {
        state.scenario = 'normal';
        log('GET /api/v1/ledger → 200 · 三统计与明细同一次响应', true);
        toast('已恢复：数据为 10-21 08:00 的同一份快照。');
        render();
      } else {
        log('手动刷新 · GET /api/v1/ledger → 200', false);
        toast('已刷新。三统计与明细来自同一份快照。');
        render();
      }
      break;

    /* overlays */
    case 'close-overlay':
      popOverlay();
      break;
    case 'open-app':
      openApp(id);
      break;
    case 'open-viewed':
      openViewed(id);
      break;
    case 'open-settings':
      state.accountOpen = false;
      closeAllOverlays();
      pushOverlay({ kind: 'settings' });
      break;
    case 'open-auth':
      state.accountOpen = false;
      closeAllOverlays();
      pushOverlay({ kind: 'auth' });
      break;
    case 'open-manual':
      state.accountOpen = false;
      closeAllOverlays();
      pushOverlay({ kind: 'manual', tab: 'manual' });
      break;
    case 'open-review': {
      const r = state.reviews.find(x => x.id === id);
      if (!r) return;
      pushOverlay({ kind: 'review', id });
      break;
    }
    case 'logout':
      state.accountOpen = false;
      clearInterval(loginTimer);
      closeAllOverlays();
      Object.assign(state, freshState());
      state.page = 'login';
      render();
      break;

    /* external */
    case 'external':
      log('外链点击 · ' + (actEl.dataset.url || '') + '（演示不打开外站）', false);
      toast('演示环境：这里只展示链接状态，不打开真实官网。实际会先校验安全外链。');
      break;

    /* detail */
    case 'detail-edit': {
      const o = topOverlay();
      if (o) { o.editing = true; renderOverlays(); }
      break;
    }
    case 'detail-cancel-edit': {
      const o = topOverlay();
      if (o) { o.editing = false; renderOverlays(); }
      break;
    }
    case 'mark-reviewed': {
      const a = findApp(id);
      if (!a) return;
      a.lastReviewedAt = NOW;
      addHistory(a, STATUS[a.status].label, STATUS[a.status].label, '用户确认', '确认状态无变化（context=ledger）');
      log('reviewed POST → 200 · context=ledger · last_reviewed_at 更新', true);
      toast('已记录「状态无变化」。下一次回看从今天重新计时。');
      renderOverlays();
      renderLedgerBody();
      break;
    }
    case 'request-archive': {
      const a = findApp(id);
      if (!a) return;
      pushOverlay({ kind: 'confirm', intent: 'archive', id });
      break;
    }
    case 'unarchive': {
      const a = findApp(id);
      if (!a) return;
      a.archived = false;
      a.archivedReason = '';
      log('archive DELETE → 显式恢复 · 不重置已投天数', true);
      toast('已恢复记录。已投天数按原投递时间继续计算。');
      closeAllOverlays();
      render();
      break;
    }
    case 'unarchive-viewed': {
      const v = findViewed(id);
      if (!v) return;
      v.archived = false;
      v.archivedReason = '';
      toast('已恢复线索；它仍然不计入累计投递。');
      closeAllOverlays();
      render();
      break;
    }
    case 'viewed-to-manual': {
      const v = findViewed(id);
      if (!v) return;
      closeAllOverlays();
      pushOverlay({ kind: 'manual', tab: 'manual', prefill: { company: v.company, title: v.title, jd: v.jd, jobUrl: v.jobUrl, channel: v.channel } });
      break;
    }
    case 'confirm-intent': {
      const intent = actEl.dataset.intent;
      const targetId = actEl.dataset.id;
      if (intent === 'archive') {
        const a = findApp(targetId);
        if (a) {
          a.archived = true;
          a.archivedReason = '用户归档 · 10-21';
          log('archive POST → 200 · 累计投递不变', true);
          toast('已归档。累计投递仍为 ' + visibleApps().length + ' 条。');
        }
      } else if (intent === 'unarchive') {
        const a = findApp(targetId);
        if (a) { a.archived = false; a.archivedReason = ''; toast('已恢复记录。'); }
      } else if (intent === 'unbind') {
        state.plugin.bound = false;
        state.plugin.revokedAt = NOW;
        state.plugin.cleanup = 'unknown';
        log('plugin-devices revoke → 服务端已撤销 · device_cleanup_state=unknown', true);
        toast('服务端已撤销该设备。设备清理状态待确认。');
      } else if (intent === 'disconnect-mail') {
        state.mail.state = 'disconnected';
        if (state.scenario === 'mail_expired' || state.scenario === 'mail_degraded') state.scenario = 'normal';
        log('mail-connections DELETE → 停止同步 · 历史保留', true);
        toast('已断开邮箱。已有台账保留，历史不会因此被删除。');
      }
      closeAllOverlays();
      render();
      break;
    }

    /* review */
    case 'review-dismiss': {
      const r = state.reviews.find(x => x.id === id);
      if (!r) return;
      state.reviews = state.reviews.filter(x => x.id !== id);
      log('review-items resolve → dismissed · 不修改申请', true);
      toast('已忽略本复核项；申请状态未改变。');
      closeAllOverlays();
      render();
      break;
    }
    case 'review-conflict': {
      const o = topOverlay();
      if (o) { o.conflict = true; renderOverlays(); }
      toast('检测到版本冲突（409）：已重取复核项与目标申请，请重新决定。', 'warn');
      log('resolve POST → 409 · 已重取两份 version', true);
      break;
    }

    /* manual */
    case 'set-manual-tab': {
      const o = topOverlay();
      if (o && o.kind === 'manual') { o.tab = actEl.dataset.tab; renderOverlays(); }
      break;
    }
    case 'use-parsed': {
      const o = topOverlay();
      if (o && o.kind === 'manual' && o.parsed) {
        o.tab = 'manual';
        o.prefill = o.parsed;
        o.draftNotice = '以下字段来自粘贴文本，尚未验证；请核对公司和岗位后再提交。';
        renderOverlays();
      }
      break;
    }

    /* settings */
    case 'preview-mail':
      closeAllOverlays();
      state.page = 'mail-preview';
      render();
      break;

    /* auth */
    case 'auth-reconnect': {
      closeAllOverlays();
      pushOverlay({ kind: 'wizard', step: 'scope', mode: 'headline_body', email: '' });
      break;
    }
    case 'request-disconnect-mail':
      pushOverlay({ kind: 'confirm', intent: 'disconnect-mail' });
      break;
    case 'request-unbind':
      pushOverlay({ kind: 'confirm', intent: 'unbind' });
      break;
    case 'plugin-scope':
      toast('支持范围以站点适配矩阵为准（G04）；未列出的站点不会声称支持。', 'warn');
      break;
    case 'request-delete':
      pushOverlay({ kind: 'delete-confirm' });
      break;
    case 'start-deletion':
      startDeletion();
      break;
    case 'retry-deletion': {
      state.deletion.outcome = 'partial';
      startDeletion();
      break;
    }

    /* wizard */
    case 'wizard-next':
      handleWizardNext();
      break;
    case 'wizard-prev': {
      const o = topOverlay();
      if (o && o.kind === 'wizard') {
        o.step = o.step === 'confirm' ? 'info' : 'scope';
        renderOverlays();
      }
      break;
    }
    case 'wizard-connect':
      handleWizardNext();
      break;
    case 'wizard-finish':
      closeAllOverlays();
      render();
      break;

    /* mail */
    case 'goto-mail-preview':
    case 'goto-mail':
      closeAllOverlays();
      state.page = 'mail-preview';
      render();
      break;
    case 'goto-ledger':
      closeAllOverlays();
      state.page = 'ledger';
      state.authed = true;
      render();
      break;
    case 'goto-mail-landing':
      closeAllOverlays();
      state.page = 'mail-landing';
      state.landing = { phase: 'idle', at: '' };
      log('GET reminder-link → 只读定位 · 未写入 · 未创建资格', true);
      render();
      break;
    case 'goto-settings':
      closeAllOverlays();
      state.page = 'ledger';
      state.authed = true;
      render();
      setTimeout(() => pushOverlay({ kind: 'settings' }), 30);
      break;

    /* landing */
    case 'landing-confirm': {
      if (state.landing.phase !== 'idle') return;
      state.landing.phase = 'preparing';
      log('confirmations POST → preparing · 尚未更新确认时间', true);
      render();
      setTimeout(() => {
        state.landing.phase = 'ready';
        const a = findApp('app_01');
        log('confirmations POST → ready · 一次性资格仅存本页内存', true);
        toast('一次性确认资格已就绪，请点击「提交确认」。');
        render();
      }, 650);
      break;
    }
    case 'landing-submit': {
      if (state.landing.phase !== 'ready') return;
      state.landing.phase = 'submitting';
      render();
      setTimeout(() => {
        const a = findApp('app_01');
        if (a) {
          a.lastReviewedAt = NOW;
          addHistory(a, STATUS[a.status].label, STATUS[a.status].label, '用户确认', '邮件落地页确认状态无变化');
        }
        state.landing.phase = 'done';
        log('applications/app_01/reviewed POST → 200 · context=reminder · 原子消费', true);
        toast('已确认。下一次回看从今天重新计时。');
        render();
      }, 800);
      break;
    }

    default:
      break;
  }
}

/* event: change */
function onChange(e) {
  const t = e.target;

  if (t.id === 'search-input') return;
  if (t.id === 'filter-status') { state.status = t.value; state.visibleCount = 20; renderLedgerBody(); return; }
  if (t.id === 'filter-source') { state.source = t.value; state.visibleCount = 20; renderLedgerBody(); return; }

  if (t.matches('[data-manual-tab]')) {
    const o = topOverlay();
    if (o && o.kind === 'manual') { o.tab = t.value; renderOverlays(); }
    return;
  }

  if (t.matches('[data-demo-select="deletion"]')) {
    state.deletion.outcome = t.value;
    renderDemo();
    return;
  }

  if (t.id === 'delete-confirm-input') {
    const btn = document.getElementById('delete-confirm-btn');
    if (btn) btn.disabled = t.value.trim() !== '删除';
    return;
  }
}

/* event: input */
function onInput(e) {
  const t = e.target;
  if (t.id === 'search-input') {
    state.query = t.value;
    state.visibleCount = 20;
    renderLedgerBody();
    return;
  }
  if (t.id === 'delete-confirm-input') {
    const btn = document.getElementById('delete-confirm-btn');
    if (btn) btn.disabled = t.value.trim() !== '删除';
  }
}

/* event: submit */
function onSubmit(e) {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const type = f.dataset.form;
  const fd = new FormData(f);

  if (type === 'login-email') {
    const email = String(fd.get('email') || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      state.login.error = '请输入有效的邮箱地址。';
      render();
      return;
    }
    state.login.email = email;
    state.login.error = '';
    state.login.step = 'code';
    startLoginCountdown();
    log('OTP 已发送（演示）· 不提示邮箱是否注册', false);
    render();
    return;
  }

  if (type === 'login-code') {
    const code = String(fd.get('code') || '').trim();
    if (code.length < 6) {
      state.login.error = '请输入完整的验证码。';
      render();
      return;
    }
    if (code === '000000') {
      state.login.error = '验证码不正确或已过期，请重新输入。';
      render();
      return;
    }
    if (state.login.email === 'demo@blocked.com') {
      state.login.step = 'blocked';
      state.login.error = '';
      clearInterval(loginTimer);
      log('业务准入拒绝 · 不展示台账', false);
      render();
      return;
    }
    clearInterval(loginTimer);
    state.authed = true;
    state.page = 'ledger';
    state.view = 'applied';
    resetFilters();
    log('OTP 验证成功 · 先取 /me，再拉取台账（演示）', false);
    render();
    return;
  }

  if (type === 'settings') {
    const content = String(fd.get('content') || 'all');
    const frequency = String(fd.get('frequency') || 'weekly');
    const threshold = Number(fd.get('threshold') || 14);
    const submit = f.querySelector('button[type="submit"]') || (f.id ? document.querySelector('button[form="' + f.id + '"]') : null);
    if (submit) { submit.disabled = true; submit.textContent = '保存中…'; }
    setTimeout(() => {
      state.settings = { content, frequency, threshold };
      log('notification-preferences PUT → 200 · threshold=' + threshold, true);
      closeAllOverlays();
      render();
      toast('提醒设置已保存。是否发信仍以有内容为前提。');
    }, 550);
    return;
  }

  if (type === 'correction') {
    const status = String(fd.get('status') || '');
    const reason = String(fd.get('reason') || '').trim();
    const appId = f.dataset.app;
    if (!reason) { toast('请填写纠错原因，纠错会留痕。', 'warn'); return; }
    const a = findApp(appId);
    if (!a) return;
    const from = STATUS[a.status].label;
    const to = STATUS[status] ? STATUS[status].label : status;
    a.status = status;
    if (status === 'interview' && !a.roundLabel) a.roundLabel = '轮次待确认';
    a.lastStatusChangedAt = NOW;
    a.updatedAt = NOW;
    addHistory(a, from, to, '用户确认', reason);
    const o = topOverlay();
    if (o) o.editing = false;
    log('corrections POST → 200 · 留痕，不伪装自动识别', true);
    toast('已保存纠错。原状态与原因已写入历史。');
    renderOverlays();
    renderLedgerBody();
    return;
  }

  if (type === 'review-resolve') {
    const reviewId = f.dataset.review;
    const r = state.reviews.find(x => x.id === reviewId);
    if (!r) return;
    if (r.blocked) return;

    if (r.kind === '疑似提交') {
      const date = String(fd.get('appliedAt') || '');
      if (!date) { toast('请补充可信投递时间；不能默认用今天。', 'warn'); return; }
      if (date > AS_OF) { toast('投递时间不能晚于今天，请核对。', 'warn'); return; }
      const newApp = A({
        id: 'app_' + Date.now(), company: r.company, title: r.title, city: r.city,
        batch: '2027 届秋招', jd: '待补充：采集时未获得可靠摘要。',
        channel: '企业官网', status: 'applied',
        appliedAt: date, appliedTime: date + ' 时间待补',
        lastStatusChangedAt: NOW, updatedAt: NOW,
        jobUrl: 'https://talent.baidu.com/', statusUrl: '', statusScope: '',
        sources: ['plugin', 'manual'], confidence: 0.97,
        history: [H(NOW, '待投递', '已投递', '用户确认', '复核确认疑似提交；投递日由用户补充')]
      });
      if (state.scenario === 'empty') state.scenario = 'normal';
      state.apps.unshift(newApp);
      state.reviews = state.reviews.filter(x => x.id !== reviewId);
      state.view = 'applied';
      log('review resolve → confirm/create · has_applied=true · history 写入', true);
      closeAllOverlays();
      render();
      toast('已确认并创建记录。累计投递已按服务端结果重取。');
      return;
    }

    if (r.kind === '邮件多候选') {
      const candidate = String(fd.get('candidate') || '');
      if (!candidate) { toast('请选择本人申请；系统不会默认选最近一条。', 'warn'); return; }
      if (candidate === 'none') { toast('未匹配：复核项保留，不会自动认领或新增记录。', 'warn'); return; }
      const a = findApp(candidate);
      if (!a) { toast('目标记录已变化，请重新选择。', 'warn'); return; }
      if (a.archived) {
        toast('该记录已归档且为终态，需先显式恢复并确认，不能直接改状态。', 'warn');
        return;
      }
      const from = STATUS[a.status].label;
      a.status = 'interview';
      a.roundLabel = '轮次待确认';
      a.lastStatusChangedAt = NOW;
      a.updatedAt = NOW;
      addHistory(a, from, '面试中', '用户确认', '邮件多候选复核：明确选择该申请');
      state.reviews = state.reviews.filter(x => x.id !== reviewId);
      log('review resolve → link app_03 · 面次未编造，标记待确认', true);
      closeAllOverlays();
      render();
      toast('已更新归属记录；面次未明确，显示「面试中 · 轮次待确认」。');
      return;
    }

    if (r.kind === '状态/字段冲突') {
      const a = state.apps.find(x => x.company === r.company && x.title === r.title && !x.archived);
      if (!a) { toast('目标记录已变化，请重新打开复核。', 'warn'); return; }
      const from = STATUS[a.status].label;
      a.status = 'interview';
      a.roundLabel = '轮次待确认';
      a.lastStatusChangedAt = NOW;
      a.updatedAt = NOW;
      addHistory(a, from, '面试中', '用户确认', '采纳邮件建议；邮件未写面次');
      state.reviews = state.reviews.filter(x => x.id !== reviewId);
      log('review resolve → confirm · 双版本校验通过 · 面次待确认', true);
      closeAllOverlays();
      render();
      toast('已采纳。面次未明确，不自动编造一轮 / 二轮。');
      return;
    }

    if (r.kind === '终态候选') {
      const a = state.apps.find(x => x.company === r.company && x.title === r.title && !x.archived);
      if (!a) { toast('目标记录已变化，请重新打开复核。', 'warn'); return; }
      const from = STATUS[a.status].label;
      a.status = 'rejected';
      a.lastStatusChangedAt = NOW;
      a.updatedAt = NOW;
      addHistory(a, from, '已拒', '用户确认', '终态候选：用户确认感谢信语义');
      state.reviews = state.reviews.filter(x => x.id !== reviewId);
      log('review resolve → 终态写入 · 留痕 · 不静默', true);
      closeAllOverlays();
      render();
      toast('已确认终态。原值与确认原因已留痕。');
      return;
    }
    return;
  }

  if (type === 'manual') {
    const company = String(fd.get('company') || '').trim();
    const title = String(fd.get('jobTitle') || '').trim();
    const channel = String(fd.get('channel') || '手动补录');
    const status = String(fd.get('status') || 'applied');
    const appliedAt = String(fd.get('appliedAt') || '');
    const precision = String(fd.get('precision') || 'date');
    const jd = String(fd.get('jd') || '').trim().slice(0, 80);
    const jobUrl = String(fd.get('jobUrl') || '').trim();

    if (!company || !title) { toast('公司和岗位是正式入账的最低条件。', 'warn'); return; }
    if (jobUrl && !/^https?:\/\//i.test(jobUrl)) { toast('岗位链接必须是安全的 http(s) 地址。', 'warn'); return; }
    if (precision === 'unknown' || !appliedAt) {
      state.reviews.unshift({
        id: 'rv_' + Date.now(), kind: '历史申请未知时间', company, title, city: '待核对',
        reason: '用户补录时没有可信投递时间。D12 未冻结，不能直接用今天或入库时间补造。',
        evidence: '手动补录 · ' + NOW, suggestion: '保留待确认（D12 未冻结）',
        confidence: 0.6, candidates: [], current: '无记录', blocked: true
      });
      log('applications/manual → 保留待确认 · applied_at=null（D12）', true);
      closeAllOverlays();
      render();
      toast('已转入待确认：投递时间未知，未写入正式台账。');
      return;
    }

    const dup = state.apps.find(a => a.company === company && a.title === title && !a.archived);
    if (dup) {
      state.reviews.unshift({
        id: 'rv_' + Date.now(), kind: '字段/状态冲突', company, title, city: dup.city,
        reason: '补录的公司 + 岗位与一条已有申请相同。不能由前端强行合并，需要你确认字段差异。',
        evidence: '手动补录 · ' + NOW + ' / 已有记录 ' + dup.id,
        suggestion: '比较字段差异后决定是否更新已有记录', confidence: 0.7,
        candidates: [], current: dup.status === 'applied' ? '已投递' : STATUS[dup.status].label
      });
      log('applications/manual → 疑似重复 · 进入复核，不新增', true);
      closeAllOverlays();
      render();
      toast('检测到可能重复：未新增记录，已进入待确认。');
      return;
    }

    const newApp = A({
      id: 'app_' + Date.now(), company, title, city: '待核对', batch: '手动补录',
      jd: jd || '', channel, status,
      appliedAt, appliedTime: appliedAt + '（日期级记录）',
      lastStatusChangedAt: NOW, updatedAt: NOW,
      jobUrl, statusUrl: '', statusScope: '',
      sources: ['manual'], confidence: 0.99,
      history: [H(NOW, '待投递', STATUS[status].label, '用户确认', '手动补录 · 漏采兜底')]
    });
    if (state.scenario === 'empty') state.scenario = 'normal';
    state.apps.unshift(newApp);
    state.view = 'applied';
    resetFilters();
    log('applications/manual → 201 · 幂等键已使用 · 三统计重取', true);
    closeAllOverlays();
    render();
    toast('已补录 1 条。累计投递已按服务端结果更新。');
    return;
  }

  if (type === 'paste') {
    const text = String(fd.get('text') || '').trim();
    if (!text) { toast('请先粘贴链接或 JD 文本。', 'warn'); return; }
    const o = topOverlay();
    if (!o) return;
    const jd = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || '未提取到可用摘要';
    o.parsed = { company: '待核对公司', title: '待核对岗位', jd, jobUrl: /^https?:\/\//.test(text) ? text.split(/\s/)[0] : '', channel: '手动补录' };
    log('粘贴解析 · 仅生成待检查字段 · 无外发请求', false);
    renderOverlays();
    toast('已生成待检查字段，未写入台账。');
    return;
  }

  if (type === 'wizard-info') {
    const o = topOverlay();
    if (!o) return;
    const email = String(fd.get('email') || '').trim();
    const code = String(fd.get('code') || '').trim();
    const mode = String(fd.get('mode') || 'headline_body');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('请输入有效的 QQ 邮箱地址。', 'warn'); return; }
    if (code.length < 8) { toast('请输入 16 位授权码（不是 QQ 登录密码）。', 'warn'); return; }
    o.email = email;
    o.mode = mode;
    o.step = 'confirm';
    log('授权码已提交到内存并清空输入（演示）', false);
    renderOverlays();
    return;
  }
}

/* event: keyboard */
function onKeydown(e) {
  if (e.key === 'Escape') {
    if (state.overlays.length) { popOverlay(); return; }
    if (state.demoOpen) { state.demoOpen = false; renderDemo(); return; }
    if (state.accountOpen) { state.accountOpen = false; render(); return; }
  }

  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-action], .review-card[data-action]')) {
    if (e.target.tagName === 'TR' && e.key === ' ') e.preventDefault();
    e.target.click();
  }

  if (e.key === 'Tab' && state.overlays.length) {
    const top = document.getElementById('overlay-root').lastElementChild;
    if (!top) return;
    const focusables = top.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

/* ---------------------------------------------------------
   12. Boot
   --------------------------------------------------------- */

document.addEventListener('click', onClick);
document.addEventListener('change', onChange);
document.addEventListener('input', onInput);
document.addEventListener('submit', onSubmit);
document.addEventListener('keydown', onKeydown);

/* Optional deep links for review: index.html?page=ledger&open=settings */
(function bootFromQuery() {
  try {
    const qs = new URLSearchParams(window.location.search);
    const page = qs.get('page');
    if (['login', 'ledger', 'mail-preview', 'mail-landing'].includes(page)) {
      state.page = page;
      state.authed = page !== 'login';
    }
    const scenario = qs.get('scenario');
    if (['normal', 'empty', 'first_sync', 'mail_expired', 'mail_degraded', 'plugin_stale', 'stale', 'unavailable'].includes(scenario)) {
      state.scenario = scenario;
    }
    const view = qs.get('view');
    if (['applied', 'viewed', 'review', 'archived'].includes(view)) state.view = view;
    if (qs.get('tool') === 'off') state.hideTool = true;
    if (qs.get('due') === '1') state.due = true;
    if (qs.get('q')) state.query = qs.get('q');
    if (['idle', 'ready', 'done'].includes(qs.get('landing'))) {
      state.page = 'mail-landing';
      state.authed = true;
      state.landing = { phase: qs.get('landing'), at: NOW };
    }

    const open = qs.get('open');
    const id = qs.get('id') || 'app_01';
    if (open === 'detail') state.overlays.push({ kind: 'detail', id });
    if (open === 'viewed') state.overlays.push({ kind: 'detail', id, viewed: true });
    if (open === 'review') state.overlays.push({ kind: 'review', id: qs.get('id') || 'rv_01' });
    if (open === 'settings') state.overlays.push({ kind: 'settings' });
    if (open === 'auth') state.overlays.push({ kind: 'auth' });
    if (open === 'manual') state.overlays.push({ kind: 'manual', tab: qs.get('tab') || 'manual' });
    if (open === 'wizard') state.overlays.push({ kind: 'wizard', step: qs.get('step') || 'scope', mode: 'headline_body', email: '' });
    if (open === 'delete') state.overlays.push({ kind: 'delete-confirm' });
    if (open === 'delete-progress') {
      const phase = ['running', 'partial', 'failed', 'done'].includes(qs.get('phase')) ? qs.get('phase') : 'partial';
      const progress = phase === 'running' ? 48 : phase === 'failed' ? 38 : 100;
      state.deletion = { ...state.deletion, phase, progress, taskId: 'del_demo_7c2a' };
      state.overlays.push({ kind: 'delete-progress', phase, progress, taskId: 'del_demo_7c2a' });
    }

    if (state.page === 'mail-landing') log('GET reminder-link → 只读定位 · 未写入 · 未创建资格', true);
  } catch (e) {}
})();

render();

})();
