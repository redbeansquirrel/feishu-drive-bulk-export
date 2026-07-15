const HEADER_ALLOWLIST = new Set([
  "content-type",
  "context",
  "doc-biz",
  "doc-os",
  "doc-platform",
  "f-version",
  "x-lgw-app-id",
  "x-lgw-os-type",
  "x-lgw-terminal-type",
  "x-lsc-bizid",
  "x-lsc-terminal",
  "x-lsc-version",
]);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = {};
    let hasCsrf = false;

    for (const header of details.requestHeaders || []) {
      const lowerName = header.name.toLowerCase();
      const isCsrf = lowerName.includes("csrf");
      if (!HEADER_ALLOWLIST.has(lowerName) && !isCsrf) continue;
      if (typeof header.value !== "string") continue;

      headers[header.name] = header.value;
      hasCsrf ||= isCsrf;
    }

    if (!hasCsrf) return;

    chrome.storage.session.set({
      feishuExportSeed: {
        capturedAt: Date.now(),
        headers,
        origin: new URL(details.url).origin,
      },
    });
  },
  { urls: ["https://*.feishu.cn/space/api/export/create/*"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.action.onClicked.addListener((tab) => {
  const query = Number.isInteger(tab.id) ? `?sourceTabId=${tab.id}` : "";
  chrome.tabs.create({ url: chrome.runtime.getURL(`runner.html${query}`) });
});
