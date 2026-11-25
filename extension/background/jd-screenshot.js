/* Full-page capture; never capture the desktop or another tab. */
function jdScreenshotClip(size) {
  const width = Math.ceil(size?.width);
  const height = Math.ceil(size?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const scale = Math.min(1, 1800 / width, 5500 / height, Math.sqrt(7000000 / (width * height)));
  return scale >= 0.55 ? { x: 0, y: 0, width, height, scale } : null;
}

async function captureJdFullPage(sender, href) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || sender.tab.incognito || !sender.documentId) return null;
  const target = { tabId };
  const active = async () => {
    const tab = await chrome.tabs.get(tabId);
    return tab.active && !tab.incognito && tab.status === 'complete' && tab.url === href;
  };
  if (!await active()) return null;
  await chrome.debugger.attach(target, '1.3');
  try {
    const layout = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const clip = jdScreenshotClip(layout.cssContentSize);
    if (!clip || !await active()) return null;
    const screenshot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 72, fromSurface: true, captureBeyondViewport: true, clip
    });
    if (!screenshot?.data || screenshot.data.length > 2150000 || !await active()) return null;
    return 'data:image/jpeg;base64,' + screenshot.data;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}
