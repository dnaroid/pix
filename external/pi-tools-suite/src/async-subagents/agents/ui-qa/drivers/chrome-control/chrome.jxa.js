// Adapted from chromectl: address Chrome tabs by Apple Events ID and correlate
// window bounds with CoreGraphics for capture. No dependency on the skill.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function chromeInstances() {
  const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.google.Chrome');
  const instances = [];
  for (let i = 0; i < Number(running.count); i++) {
    const app = running.objectAtIndex(i);
    const pid = Number(app.processIdentifier);
    const started = Number(app.launchDate.timeIntervalSince1970);
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(started) && started > 0) {
      // Same-bundle background processes (for example a silent updater) are not browser instances.
      instances.push({ pid, started, regular: Number(app.activationPolicy) === 0 });
    }
  }
  return instances;
}

function sameInstance(a, b) {
  return a.pid === b.pid && a.started === b.started;
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
  if (q.command !== 'probe' && !q.instance) return { code: 'no-tab' };
  const running = chromeInstances();
  const candidates = q.instance
    ? running.filter((app) => sameInstance(app, q.instance))
    : running.filter((app) => app.regular);
  if (candidates.length === 0) return { code: 'chrome-not-running' };
  if (candidates.length !== 1) return { code: 'chrome-instance-ambiguous' };
  const { pid, started } = candidates[0];
  const instance = { pid, started };
  // JXA accepts a numeric PID. A bundle-ID target can route to another process.
  let chrome;
  try { chrome = Application(pid); }
  catch (error) {
    if (!chromeInstances().some((app) => sameInstance(app, instance))) return { code: 'chrome-not-running' };
    throw error;
  }
  if (!chromeInstances().some((app) => sameInstance(app, instance))) return { code: 'chrome-not-running' };
  if (q.command === 'probe') {
    if (!chrome.windows.id().length) return { code: 'no-window' };
    return { code: 'ok', instance, screenshot: screenAccess() };
  }
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
