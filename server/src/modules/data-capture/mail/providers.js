// 邮箱服务商路由：收信统一走 IMAP + 客户端授权码；不从域名猜公司。
const PROVIDERS = {
  qq: {
    key: 'qq', label: 'QQ / Foxmail 邮箱', host: 'imap.qq.com',
    domains: ['qq.com', 'vip.qq.com', 'foxmail.com'], requiresImapId: false
  },
  netease_163: {
    key: 'netease_163', label: '网易 163 邮箱', host: 'imap.163.com',
    domains: ['163.com'], requiresImapId: true
  },
  netease_126: {
    key: 'netease_126', label: '网易 126 邮箱', host: 'imap.126.com',
    domains: ['126.com'], requiresImapId: true
  },
  netease_yeah: {
    key: 'netease_yeah', label: '网易 yeah.net 邮箱', host: 'imap.yeah.net',
    domains: ['yeah.net'], requiresImapId: true
  }
};
const BY_DOMAIN = new Map();
for (const provider of Object.values(PROVIDERS)) {
  for (const domain of provider.domains) BY_DOMAIN.set(domain, provider);
}

export function resolveMailProvider(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return BY_DOMAIN.get(value.slice(at + 1)) || null;
}

export function imapHostFor(email) {
  return resolveMailProvider(email)?.host || null;
}

export function isSupportedEmail(email) {
  return Boolean(resolveMailProvider(email));
}

export function supportedMailProviderLabels() {
  return [...new Set(Object.values(PROVIDERS).map((p) => p.label))];
}
