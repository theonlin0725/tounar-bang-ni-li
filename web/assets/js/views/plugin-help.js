/* 插件下载与手动安装指引：只链接静态 ZIP，不读取或传递任何登录/设备/内部令牌。 */
import { h, clear } from '../util.js';

export const PLUGIN_VERSION = '0.2.5';
export const PLUGIN_ZIP = `/downloads/bangnili-extension-${PLUGIN_VERSION}.zip`;

export function currentShareCode() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('sharecode') || '';
    if (fromUrl) { sessionStorage.setItem('tounar.sharecode', fromUrl); return fromUrl; }
    return sessionStorage.getItem('tounar.sharecode') || '';
  } catch { return ''; }
}
export function pluginDownloadHref() {
  const share = currentShareCode();
  return pluginHrefWithShare(PLUGIN_ZIP, share);
}
function pluginHrefWithShare(path, share) {
  return share ? `${path}${path.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(share)}` : path;
}
export function pluginDownloadLink({ class: className = 'tn-btn tn-btn-sm', label = '下载插件', test = 'plugin-download' } = {}) {
  return h('a', {
    class: className, href: pluginDownloadHref(), download: `bangnili-extension-${PLUGIN_VERSION}.zip`,
    'data-test': test, title: '下载插件 ZIP，解压后用 Chrome 加载已解压的扩展程序'
  }, label);
}
export function openPluginHelp() {
  const layer = h('div', { class: 'tn-modal-layer', 'data-test': 'plugin-help-modal' });
  const close = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '关闭', 'data-test': 'plugin-help-close', onclick: () => layer.remove() });
  const download = pluginDownloadLink({ label: `下载插件 ZIP（v${PLUGIN_VERSION}）`, test: 'plugin-help-download' });
  layer.append(
    h('div', { class: 'tn-modal-mask', onclick: () => layer.remove() }),
    h('div', { class: 'tn-modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'tn-modal-head' }, h('div', { class: 'tn-grow' }, h('h2', { text: '安装浏览器插件' }), h('div', { class: 'tn-modal-sub', text: 'Chrome 优先；其他浏览器未验收，不承诺自动安装。' })), close),
      h('div', { class: 'tn-modal-body' },
        h('p', { class: 'tn-small tn-muted', text: '本轮使用下载 ZIP + 手动加载，不通过应用商店。安装后请保留解压目录，不要删除或移动。' }),
        h('div', { class: 'tn-action-row' }, download),
        h('ol', { class: 'tn-plugin-steps' },
          h('li', { text: '下载插件 ZIP，解压到固定文件夹（如「文档/帮你理插件」）；安装后保留该文件夹。' }),
          h('li', { text: '打开 Chrome 扩展管理页：地址栏输入 chrome://extensions。' }),
          h('li', { text: '打开右上角「开发者模式」。' }),
          h('li', { text: '点击「加载已解压的扩展程序」。' }),
          h('li', { text: `选择解压后直接包含 manifest.json 的目录；不要把 ZIP 本身或上一级目录选进去。当前版本 v${PLUGIN_VERSION}。` }),
          h('li', { text: '回到帮你理网页并刷新，登录后会自动弹出连接请求。点击「确认连接」，随后在网页选择授权网站，无需打开插件栏或输入配对码。' })
        ),
        h('p', { class: 'tn-small tn-muted', text: '平台分享码用于打开托管页面，应用邀请码用于首次激活账号；插件连接由网页弹窗确认，无需填写配对码。' }),
        h('p', { class: 'tn-small tn-muted', text: '插件只上传岗位字段与 JD；不会上传登录 Cookie、密码或设备令牌给其他账号。' })
      )
    )
  );
  document.body.append(layer);
}
