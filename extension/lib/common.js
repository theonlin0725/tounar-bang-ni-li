/* Shared constants for service worker, popup and content scripts (classic scripts). */
(function () {
  const KEY = 'tounar.settings.v1';
  const DEFAULTS = {
    serverUrl: 'http://127.0.0.1:4310',
    deviceToken: null,
    deviceId: null,
    bindingVersion: null,
    pendingPairing: null,
    lastUploadAt: null,
    lastError: null,
    pairedOwnerHint: null,
    pageFeedback: true
  };
  async function getSettings() {
    const stored = await chrome.storage.local.get(KEY);
    return { ...DEFAULTS, ...(stored[KEY] || {}) };
  }
  let settingsWrite = Promise.resolve();
  function setSettings(patch) {
    settingsWrite = settingsWrite.catch(() => {}).then(() => writeSettings(patch));
    return settingsWrite;
  }
  async function writeSettings(patch) {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }
  async function clearPairing() {
    return setSettings({
      deviceToken: null, deviceId: null, bindingVersion: null, pendingPairing: null, pairedOwnerHint: null
    });
  }
  globalThis.TounarCommon = { KEY, DEFAULTS, getSettings, setSettings, clearPairing };
})();
