// Adapted from chromectl: address Chrome tabs by Apple Events ID and correlate
// window bounds with CoreGraphics for capture. No dependency on the skill.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function chromeInstance() {
  const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.google.Chrome');
  if (running.count !== 1) return null;
  const app = running.objectAtIndex(0);
  return { pid: Number(app.processIdentifier), started: Number(app.launchDate.timeIntervalSince1970) };
}

function screenAccess() {
  try {
    ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
    return !!$.CGPreflightScreenCaptureAccess();
  } catch (_) { return false; }
}

function locate(chrome, matches) {
  for (const windowId of chrome.windows.id()) {
    const win = chrome.windows.byId(windowId);
    for (const rawId of win.tabs.id()) {
      const id = Number(rawId);
      const tab = win.tabs.byId(String(rawId));
      if (matches(id, tab)) return { win, tab, id };
    }
  }
  return null;
}

function captureWindowId(win, pid) {
  if (win.minimized()) return null;
  const b = win.bounds();
  const near = (a, c) => Math.abs(a - c) <= 1;
  // An off-screen twin must count as ambiguous, even if only its twin is visible.
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))) || [];
  const matches = windows.filter((w) => {
    const r = w.kCGWindowBounds;
    return w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && r &&
      near(r.X, b.x) && near(r.Y, b.y) && near(r.Width, b.width) && near(r.Height, b.height);
  });
  const [match] = matches;
  if (matches.length !== 1 || !match.kCGWindowIsOnscreen || !match.kCGWindowName || match.kCGWindowName !== win.name()) return null;
  return Number.isSafeInteger(match.kCGWindowNumber) ? match.kCGWindowNumber : null;
}

function capture(owned, pid, file, verify) {
  if (!screenAccess()) return { code: 'screen-permission' };
  const { win, id } = owned;
  if (win.minimized()) return { code: 'window-unavailable' };
  const activeTabId = () => Number(win.activeTab.id());
  const previousId = activeTabId();
  try {
    if (previousId !== id) {
      const index = win.tabs.id().map(Number).indexOf(id);
      if (index === -1 || activeTabId() !== previousId) return { code: 'window-unavailable' };
      win.activeTabIndex = index + 1;
    }
    // Let Chrome paint the selected tab, then verify both sides of capture.
    if (previousId !== id) delay(0.4);
    if (activeTabId() !== id || !verify()) return { code: 'window-unavailable' };
    const windowId = captureWindowId(win, pid);
    if (windowId === null) return { code: 'window-unavailable' };
    const task = $.NSTask.launchedTaskWithLaunchPathArguments('/usr/sbin/screencapture',
      $(['-x', '-o', '-t', 'png', '-l' + windowId, file]));
    task.waitUntilExit;
    if (task.terminationStatus !== 0 || activeTabId() !== id || !verify() || captureWindowId(win, pid) !== windowId) {
      return { code: 'window-unavailable' };
    }
    return { code: 'ok' };
  } finally {
    try {
      if (previousId !== id && activeTabId() === id) {
        const i = win.tabs.id().map(Number).indexOf(previousId);
        if (i !== -1) win.activeTabIndex = i + 1;
      }
    } catch (_) { /* window or tab disappeared */ }
  }
}

function execute(q) {
  const instance = chromeInstance();
  if (!instance || (q.instance && (instance.pid !== q.instance.pid || instance.started !== q.instance.started))) {
    return { code: 'chrome-not-running' };
  }
  const chrome = Application('com.google.Chrome');
  if (q.command === 'probe') {
    if (!chrome.windows.id().length) return { code: 'no-window' };
    return { code: 'ok', instance, screenshot: screenAccess() };
  }
  if (!q.instance) return { code: 'no-tab' };
  if (q.command === 'open') {
    const [windowId] = chrome.windows.id();
    if (windowId === undefined) return { code: 'no-window' };
    const win = chrome.windows.byId(windowId);
    const previous = Number(win.activeTab.id());
    win.tabs.push(chrome.Tab({ url: q.marker }));
    const match = (_, ref) => ref.url() === q.marker;
    let tab = locate(chrome, match);
    for (let attempt = 0; !tab && attempt < 5; attempt++) {
      delay(0.1);
      tab = locate(chrome, match);
    }
    if (!tab) return { code: 'no-tab' };
    if (Number(win.activeTab.id()) === tab.id) {
      const i = win.tabs.id().map(Number).indexOf(previous);
      if (i !== -1) win.activeTabIndex = i + 1;
    }
    return { code: 'ok', tabId: tab.id };
  }
  // The unique blank URL also permits recovery if open returned no receipt.
  const owned = locate(chrome, q.tabId != null
    ? (id) => id === q.tabId
    : (_, ref) => q.command === 'close' && ref.url() === q.marker);
  if (!owned) return { code: 'no-tab' };
  if (q.command === 'close') { owned.tab.close(); return { code: 'ok' }; }
  if (q.command === 'navigate' || q.command === 'reload') {
    if (q.source) {
      const code = pageStatus(owned, q.source);
      if (code !== 'ok') return { code };
    } else if (q.command !== 'navigate' || owned.tab.url() !== q.marker) {
      return { code: 'no-tab' };
    }
    if (q.command === 'reload') owned.tab.reload();
    else owned.tab.url = q.url;
    return { code: 'ok' };
  }
  if (q.command === 'screenshot') {
    return capture(owned, instance.pid, q.file, () => pageStatus(owned, q.source) === 'ok');
  }
  if (q.command === 'page') {
    return { code: 'ok', value: pageStatus(owned, q.source, q.interaction) };
  }
  return { code: 'driver-error' };
}

function pageStatus(owned, source, interaction) {
  if (owned.tab.loading()) return 'not-ready';
  const result = owned.tab.execute({ javascript: source });
  if (typeof result === 'string') return result;
  return interaction ? 'unconfirmed-interaction' : 'not-ready';
}

function run(argv) {
  try { return JSON.stringify(execute(JSON.parse(argv[0]))); }
  catch (e) {
    // Don't forward Apple Events errors: they may include a URL or script args.
    const n = e.errorNumber;
    const detail = String(e.message || '');
    let code = 'driver-error';
    if (n === -1743 || /-1743/.test(detail)) code = 'automation-permission';
    else if (n === -600) code = 'chrome-not-running';
    else if (/javascript/i.test(detail) && /apple events|turned off|disabled|not allowed|отключ/i.test(detail)) code = 'javascript-permission';
    else if (n === -1719) code = 'no-window';
    else if (n === -1728) code = 'no-tab';
    else if (n === -1712) code = 'timeout';
    return JSON.stringify({ code });
  }
}
