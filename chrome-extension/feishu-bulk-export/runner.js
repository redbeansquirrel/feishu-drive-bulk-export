import {
  EXPORT_FORMATS,
  EXPORT_TYPES,
  parseManifest,
  runPool,
  safeFilename,
  taskKey,
} from "./core.mjs";

const elements = {
  clearButton: document.querySelector("#clearButton"),
  concurrency: document.querySelector("#concurrency"),
  exportFormat: document.querySelector("#exportFormat"),
  failureButton: document.querySelector("#failureButton"),
  log: document.querySelector("#log"),
  manifestFile: document.querySelector("#manifestFile"),
  manifestSummary: document.querySelector("#manifestSummary"),
  outputFolder: document.querySelector("#outputFolder"),
  progress: document.querySelector("#progress"),
  progressBar: document.querySelector("#progressBar"),
  recordCountHint: document.querySelector("#recordCountHint"),
  recordSearch: document.querySelector("#recordSearch"),
  recordTableBody: document.querySelector("#recordTableBody"),
  refreshButton: document.querySelector("#refreshButton"),
  reportButton: document.querySelector("#reportButton"),
  reportHint: document.querySelector("#reportHint"),
  seedStatus: document.querySelector("#seedStatus"),
  startButton: document.querySelector("#startButton"),
  statusFilter: document.querySelector("#statusFilter"),
  stopButton: document.querySelector("#stopButton"),
  summaryFailed: document.querySelector("#summaryFailed"),
  summaryNoPermission: document.querySelector("#summaryNoPermission"),
  summaryPending: document.querySelector("#summaryPending"),
  summarySkipped: document.querySelector("#summarySkipped"),
  summarySuccess: document.querySelector("#summarySuccess"),
  summaryTotal: document.querySelector("#summaryTotal"),
  tabStatus: document.querySelector("#tabStatus"),
  taskLimit: document.querySelector("#taskLimit"),
  typeFilter: document.querySelector("#typeFilter"),
};

const STORAGE_KEYS = Object.freeze({
  completed: "feishuCompletedV1",
  lastNotDownloaded: "feishuLastNotDownloadedV2",
  ledger: "feishuTaskLedgerV3",
  terminalFailures: "feishuTerminalFailuresV3",
});

let tasks = [];
let seed = null;
let sourceTab = null;
let stopping = false;
let running = false;
let createGate = Promise.resolve();
let storageGate = Promise.resolve();
let nextCreateAt = 0;
let notDownloaded = [];
let dashboardRows = [];

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  elements.log.textContent += `[${timestamp}] ${message}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function updateStartButton() {
  const format = selectedFormat();
  const compatible = tasks.some((task) => isTaskSupportedByFormat(task, format));
  elements.startButton.textContent = `开始下载 ${format.label}（仅 ${format.sourceTypes.join("/").toUpperCase()}）`;
  elements.startButton.disabled = running || !seed || !sourceTab || !compatible;
}

async function refreshSession() {
  const stored = await chrome.storage.session.get("feishuExportSeed");
  seed = stored.feishuExportSeed || null;
  elements.seedStatus.textContent = seed
    ? `已取得临时授权（${new Date(seed.capturedAt).toLocaleTimeString()}）`
    : "未取得；请先正常导出任意一篇文档";

  sourceTab = await findSourceTab(seed?.origin);
  elements.tabStatus.textContent = sourceTab
    ? `${sourceTab.title || "飞书页面"}（标签页 ${sourceTab.id}）`
    : "未找到与授权同域的飞书文档页";
  updateStartButton();
}

async function findSourceTab(origin) {
  if (!origin) return null;
  const requestedId = Number(new URLSearchParams(location.search).get("sourceTabId"));

  if (Number.isInteger(requestedId) && requestedId > 0) {
    try {
      const requested = await chrome.tabs.get(requestedId);
      if (requested.url?.startsWith(`${origin}/`)) return requested;
    } catch {
      // The original tab may have been closed.
    }
  }

  const candidates = await chrome.tabs.query({ url: `${origin}/*` });
  return candidates.find((tab) => /\/(docx|docs|sheets|base|mindnotes|slides)\//.test(tab.url || "")) || null;
}

elements.manifestFile.addEventListener("change", async () => {
  const file = elements.manifestFile.files?.[0];
  tasks = file ? parseManifest(await file.text()) : [];
  const counts = tasks.reduce((groups, task) => {
    groups[task.type] ||= [];
    groups[task.type].push(task);
    return groups;
  }, {});
  elements.manifestSummary.textContent = tasks.length
    ? `共 ${tasks.length} 条；${Object.entries(counts).map(([type, rows]) => `${type} ${rows.length}`).join("，")}。Base ${counts.base?.length || 0} 条本期跳过并记入报告。`
    : "清单中没有可识别的任务。";
  elements.refreshButton.disabled = tasks.length === 0;
  elements.reportButton.disabled = tasks.length === 0;
  updateStartButton();
  await migrateLegacyNoPermissionRecords();
  await renderDashboard();
});

elements.exportFormat.addEventListener("change", updateStartButton);

elements.clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove([
    STORAGE_KEYS.completed,
    STORAGE_KEYS.lastNotDownloaded,
    STORAGE_KEYS.terminalFailures,
    STORAGE_KEYS.ledger,
    "feishuLastFailuresV1",
  ]);
  appendLog("成功、无权限和失败断点已全部清除；已下载文件不会被删除。");
  await renderDashboard();
});

elements.failureButton.addEventListener("click", async () => {
  const snapshot = tasks.length > 0 ? await buildStatusSnapshot() : null;
  const stored = snapshot ? null : await chrome.storage.local.get([STORAGE_KEYS.lastNotDownloaded, "feishuLastFailuresV1"]);
  const rows = snapshot
    ? snapshot.rows.filter((row) => row.status !== "success")
    : normalizeStoredRecords(stored[STORAGE_KEYS.lastNotDownloaded] || stored.feishuLastFailuresV1 || []);
  if (rows.length === 0) return;
  await downloadNotDownloadedReport(rows, "飞书批量下载/_未下载记录");
});

elements.reportButton.addEventListener("click", async () => {
  if (tasks.length === 0) return;
  const snapshot = await renderDashboard();
  await downloadFullReport(snapshot, `${safeRelativeFolder(elements.outputFolder.value)}/_下载简报`);
  appendLog("全目录下载简报已生成。");
});

elements.refreshButton.addEventListener("click", renderDashboard);
elements.recordSearch.addEventListener("input", renderDashboardRows);
elements.statusFilter.addEventListener("change", renderDashboardRows);
elements.typeFilter.addEventListener("change", renderDashboardRows);

elements.stopButton.addEventListener("click", () => {
  stopping = true;
  elements.stopButton.disabled = true;
  appendLog("将停止派发新任务，正在执行的任务会正常结束。");
});

elements.startButton.addEventListener("click", async () => {
  await refreshSession();
  if (!seed || !sourceTab) return;

  const requestedConcurrency = Math.min(8, Math.max(1, Number(elements.concurrency.value) || 2));
  const formatKey = elements.exportFormat.value;
  const format = selectedFormat();
  const concurrency = formatKey === "freemind" ? 1 : requestedConcurrency;
  const outputFolder = elements.outputFolder.value
    .split(/[\\/]+/)
    .map(safeFilename)
    .filter(Boolean)
    .join("/");
  const supported = tasks.filter((task) => isTaskSupportedByFormat(task, format));
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.completed,
    STORAGE_KEYS.terminalFailures,
    STORAGE_KEYS.ledger,
  ]);
  const completed = stored[STORAGE_KEYS.completed] || {};
  const terminalFailures = stored[STORAGE_KEYS.terminalFailures] || {};
  const ledger = stored[STORAGE_KEYS.ledger] || {};
  const allPending = supported.filter((task) => {
    const key = taskKey(task, format.extension);
    return !completed[key] && !terminalFailures[key];
  });
  const taskLimit = Math.max(0, Number(elements.taskLimit.value) || 0);
  const pending = taskLimit > 0 ? allPending.slice(0, taskLimit) : allPending;

  stopping = false;
  running = true;
  notDownloaded = buildStaticSkipRecords(tasks);
  await chrome.storage.local.set({ [STORAGE_KEYS.lastNotDownloaded]: notDownloaded });
  elements.failureButton.disabled = notDownloaded.length === 0;
  updateStartButton();
  elements.stopButton.disabled = false;
  elements.progressBar.max = Math.max(1, pending.length);
  elements.progressBar.value = 0;

  let finished = 0;
  let failed = 0;
  const completedSkips = supported.filter((task) => completed[taskKey(task, format.extension)]).length;
  const permissionSkips = supported.filter((task) => terminalFailures[taskKey(task, format.extension)]).length;
  appendLog(`开始：格式 ${format.label}，匹配 ${supported.length}，本轮 ${pending.length}，完成断点跳过 ${completedSkips}，无权限断点跳过 ${permissionSkips}，固定跳过/未启用 ${notDownloaded.length}，并发 ${concurrency}${formatKey === "freemind" && requestedConcurrency !== 1 ? "（FreeMind 自动限制为 1）" : ""}。`);

  await runPool(
    pending,
    concurrency,
    async (task) => {
      const config = taskExportConfig(task, formatKey);
      let temporaryBlobUrl = null;
      try {
        const relativeFolder = safeRelativeFolder(task.relativeDir);
        const filename = [
          outputFolder,
          relativeFolder,
          `${safeFilename(task.name)}.${config.extension}`,
        ].filter(Boolean).join("/");
        let downloadId;
        if (config.strategy === "page-freemind") {
          const freeMind = await exportMindnoteWithRetry(task, seed.origin);
          temporaryBlobUrl = URL.createObjectURL(new Blob([freeMind.content], {
            type: "application/x-freemind;charset=utf-8",
          }));
          downloadId = await chrome.downloads.download({
            conflictAction: "uniquify",
            filename,
            saveAs: false,
            url: temporaryBlobUrl,
          });
        } else {
          const result = await exportWithRetry(sourceTab.id, task, config, seed.headers);
          const downloadUrl = `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/all/${encodeURIComponent(result.file_token)}/`;
          downloadId = await chrome.downloads.download({
            conflictAction: "uniquify",
            filename,
            saveAs: false,
            url: downloadUrl,
          });
        }
        await waitForDownload(downloadId);
        const key = taskKey(task, config.extension);
        completed[key] = {
          completedAt: Date.now(),
          filename,
        };
        ledger[key] = buildLedgerRecord(task, format, {
          category: "已完成",
          filename,
          message: "",
          status: "success",
        });
        delete terminalFailures[key];
        await persistStorage({
          [STORAGE_KEYS.completed]: completed,
          [STORAGE_KEYS.ledger]: ledger,
          [STORAGE_KEYS.terminalFailures]: terminalFailures,
        });
        appendLog(`完成 ${task.id}: ${task.name}`);
      } catch (error) {
        failed += 1;
        const message = error.message || String(error);
        const failure = {
          attempts: error.attempts || 1,
          category: error.category || classifyError(message),
          recordedAt: new Date().toISOString(),
          format: format.label,
          id: task.id,
          message,
          name: task.name,
          relativeDir: task.relativeDir || "",
          type: task.type,
          url: task.url,
        };
        failure.status = failure.category === "无权限" ? "no_permission" : "failed";
        failure.statusLabel = statusLabel(failure.status);
        const key = taskKey(task, config.extension);
        ledger[key] = failure;
        if (failure.status === "no_permission") terminalFailures[key] = failure;
        notDownloaded.push(failure);
        await persistStorage({
          [STORAGE_KEYS.lastNotDownloaded]: notDownloaded,
          [STORAGE_KEYS.ledger]: ledger,
          [STORAGE_KEYS.terminalFailures]: terminalFailures,
        });
        elements.failureButton.disabled = false;
        appendLog(`失败 ${task.id}: ${task.name} — [${failure.category}] ${message}`);
      } finally {
        if (temporaryBlobUrl) URL.revokeObjectURL(temporaryBlobUrl);
        finished += 1;
        elements.progressBar.value = finished;
        elements.progress.textContent = `已处理 ${finished}/${pending.length}，失败 ${failed}`;
      }
    },
    () => stopping,
  );

  elements.stopButton.disabled = true;
  running = false;
  updateStartButton();
  appendLog(stopping ? "已停止派发新任务。" : `本轮结束：成功 ${finished - failed}，失败 ${failed}，固定跳过/未启用 ${notDownloaded.length - failed}。`);
  const snapshot = await renderDashboard();
  const aggregateNotDownloaded = snapshot.rows.filter((row) => row.status !== "success");
  if (aggregateNotDownloaded.length > 0) {
    await downloadNotDownloadedReport(aggregateNotDownloaded, `${outputFolder}/_未下载记录`);
    appendLog(`全目录未下载明细已导出：${aggregateNotDownloaded.length} 条。`);
  }
  if (!stopping && taskLimit === 0 && snapshot.summary.pending === 0) {
    await downloadFullReport(snapshot, `${outputFolder}/_下载简报`);
    appendLog("全目录已无待处理项，下载简报已自动生成。");
  } else if (!stopping && taskLimit === 0) {
    appendLog(`全目录仍有 ${snapshot.summary.pending} 个格式任务待处理；完成其余格式后可生成最终简报。`);
  }
});

async function createAndPollExport(tabId, task, config, headers) {
  const injections = await chrome.scripting.executeScript({
    args: [task, config, headers],
    func: async (pageTask, pageConfig, pageHeaders) => {
      try {
        const createResponse = await fetch("/space/api/export/create/", {
          body: JSON.stringify({
            event_source: "1",
            file_extension: pageConfig.extension,
            ...(typeof pageConfig.needComment === "boolean" ? { need_comment: pageConfig.needComment } : {}),
            ...(pageConfig.passback ? { passback: pageConfig.passback } : {}),
            token: pageTask.token,
            type: pageConfig.apiType,
          }),
          credentials: "include",
          headers: pageHeaders,
          method: "POST",
        });
        const createJson = await createResponse.json().catch(() => null);
        if (!createResponse.ok || createJson?.code !== 0 || !createJson.data?.ticket) {
          throw new Error(
            `创建导出失败：HTTP ${createResponse.status} / code ${createJson?.code ?? "?"} / ${createJson?.msg || "无错误说明"}`,
          );
        }

        const resultUrl = `/space/api/export/result/${encodeURIComponent(createJson.data.ticket)}?token=${encodeURIComponent(pageTask.token)}&type=${encodeURIComponent(pageConfig.apiType)}`;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const resultResponse = await fetch(resultUrl, {
            credentials: "include",
            headers: pageHeaders,
          });
          const resultJson = await resultResponse.json().catch(() => null);
          if (!resultResponse.ok || (resultJson?.code != null && resultJson.code !== 0)) {
            throw new Error(
              `查询导出失败：HTTP ${resultResponse.status} / code ${resultJson?.code ?? "?"} / ${resultJson?.msg || "无错误说明"}`,
            );
          }

          const result = resultJson?.data?.result;
          if (result?.file_token) return { ok: true, result };
          if (result?.job_error_msg) throw new Error(result.job_error_msg);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        throw new Error("导出任务在 60 秒内未完成");
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    },
    target: { tabId },
    world: "MAIN",
  });

  const injection = injections[0];
  if (injection?.error) {
    throw new Error(injection.error.message || String(injection.error));
  }
  const outcome = injection?.result;
  if (!outcome?.ok) throw new Error(outcome?.error || "飞书页面没有返回错误详情");
  if (!outcome.result?.file_token) throw new Error("飞书页面没有返回文件 token");
  return outcome.result;
}

async function exportMindnoteWithRetry(task, origin) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await exportMindnoteAsFreeMind(task, origin);
    } catch (error) {
      lastError = error;
      error.attempts = attempt;
      error.category = classifyError(error.message || String(error));
      if (attempt === 3) break;
      const delay = 1_000 * attempt;
      appendLog(`重试 ${task.id}（${attempt}/3）：[MindNotes 页面导出] ${error.message || error}；等待 ${delay / 1000} 秒`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

async function exportMindnoteAsFreeMind(task, origin) {
  const taskUrl = new URL(task.url);
  const pageUrl = `${origin}${taskUrl.pathname}${taskUrl.search}`;
  const [previousActiveTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageTab = await chrome.tabs.create({ active: true, url: pageUrl });

  try {
    await waitForTabComplete(pageTab.id, 45_000);
    const injections = await chrome.scripting.executeScript({
      func: async () => {
        const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
        const deadline = Date.now() + 45_000;
        let tree;
        let lastNodeCount = -1;
        let stablePolls = 0;
        while (Date.now() < deadline) {
          tree = document.querySelector(".mindnote-tree");
          const title = document.querySelector(".mindnote-title-content");
          const nodeCount = tree?.querySelectorAll(".node").length || 0;
          if (tree && title && nodeCount > 0) {
            stablePolls = nodeCount === lastNodeCount ? stablePolls + 1 : 0;
            lastNodeCount = nodeCount;
            if (stablePolls >= 5) break;
          }
          await sleep(100);
        }
        if (!tree || stablePolls < 5) return { ok: false, error: "等待 MindNotes 节点树稳定加载超时" };

        const directChild = (parent, className) => Array.from(parent?.children || [])
          .find((element) => element.classList?.contains(className));
        const parseNode = (node) => {
          const wrapper = directChild(node, "node-wrapper");
          const content = wrapper?.querySelector(".content[data-id]");
          const childrenBox = directChild(node, "children");
          return {
            children: Array.from(childrenBox?.children || [])
              .filter((element) => element.classList?.contains("node"))
              .map(parseNode),
            text: (content?.innerText || content?.textContent || "").trim() || "未命名节点",
          };
        };
        const nodes = Array.from(tree.children || [])
          .filter((element) => element.classList?.contains("node"))
          .map(parseNode);
        const countNodes = (items) => items.reduce(
          (count, item) => count + 1 + countNodes(item.children),
          0,
        );
        const maxDepth = (items) => items.length > 0
          ? 1 + Math.max(...items.map((item) => maxDepth(item.children)))
          : 0;
        return {
          depth: maxDepth(nodes),
          nodeCount: countNodes(nodes),
          nodes,
          ok: true,
          title: (document.querySelector(".mindnote-title-content")?.textContent || "").trim(),
        };
      },
      target: { tabId: pageTab.id },
      world: "MAIN",
    });
    const injection = injections[0];
    if (injection?.error) throw new Error(injection.error.message || String(injection.error));
    const tree = injection?.result;
    if (!tree?.ok) throw new Error(tree?.error || "MindNotes 页面没有返回节点结构");
    const content = buildFreeMindXml(tree.title || task.name, tree.nodes);
    if (!/<map(?:\s|>)/i.test(content)) throw new Error("生成内容不是有效的 FreeMind XML");
    appendLog(`已提取 MindNotes ${task.id}: ${tree.nodeCount} 个节点，${tree.depth} 层`);
    return { content };
  } finally {
    await chrome.tabs.remove(pageTab.id).catch(() => {});
    if (previousActiveTab?.id) {
      await chrome.tabs.update(previousActiveTab.id, { active: true }).catch(() => {});
    }
  }
}

function buildFreeMindXml(title, nodes) {
  const serializeNode = (node, indent) => {
    const padding = "  ".repeat(indent);
    const text = escapeXmlAttribute(node.text);
    if (!node.children?.length) return `${padding}<node TEXT="${text}"/>`;
    return [
      `${padding}<node TEXT="${text}">`,
      ...node.children.map((child) => serializeNode(child, indent + 1)),
      `${padding}</node>`,
    ].join("\n");
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<map version="1.0.1">',
    `  <node TEXT="${escapeXmlAttribute(title || "未命名思维笔记")}">`,
    ...nodes.map((node) => serializeNode(node, 2)),
    "  </node>",
    "</map>",
    "",
  ].join("\n");
}

function escapeXmlAttribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replace(/\r?\n/g, "&#10;");
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("MindNotes 页面加载超时")), timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve();
    }

    function onUpdated(updatedId, changeInfo) {
      if (updatedId === tabId && changeInfo.status === "complete") finish();
    }

    function onRemoved(removedId) {
      if (removedId === tabId) finish(new Error("MindNotes 页面在导出前被关闭"));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch((error) => finish(error));
  });
}

async function exportWithRetry(tabId, task, config, headers) {
  let lastError;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await waitForCreateSlot();
    try {
      return await createAndPollExport(tabId, task, config, headers);
    } catch (error) {
      lastError = error;
      const category = classifyError(error.message || String(error));
      error.attempts = attempt;
      error.category = category;
      if (category === "无权限" || category === "格式不支持" || attempt === 5) break;
      const delay = Math.min(16_000, 1_000 * (2 ** attempt)) + Math.floor(Math.random() * 500);
      appendLog(`重试 ${task.id}（${attempt}/5）：[${category}] ${error.message || error}；等待 ${Math.ceil(delay / 1000)} 秒`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

async function waitForCreateSlot() {
  let release;
  const previous = createGate;
  createGate = new Promise((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const delay = Math.max(0, nextCreateAt - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    nextCreateAt = Date.now() + 1_200;
  } finally {
    release();
  }
}

function persistStorage(values) {
  storageGate = storageGate
    .catch(() => {})
    .then(() => chrome.storage.local.set(values));
  return storageGate;
}

function classifyError(message) {
  if (/code 1002|no permission|无权限|permission denied/i.test(message)) return "无权限";
  if (/not support|unsupported|格式.*不支持/i.test(message)) return "格式不支持";
  if (/HTTP 429|rate.?limit|too many|频繁|限流/i.test(message)) return "限流";
  if (/超时|timeout|60 秒/i.test(message)) return "超时";
  if (/network|failed to fetch|ERR_|网络/i.test(message)) return "网络错误";
  return "其他";
}

function safeRelativeFolder(relativeDir) {
  return String(relativeDir || "")
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(safeFilename)
    .join("/");
}

function selectedFormat() {
  return EXPORT_FORMATS[elements.exportFormat.value] || EXPORT_FORMATS.word;
}

function isTaskSupportedByFormat(task, format) {
  return format.sourceTypes.includes(task.type) && EXPORT_TYPES[task.type]?.verified;
}

function taskExportConfig(task, formatKey) {
  const format = EXPORT_FORMATS[formatKey] || EXPORT_FORMATS.word;
  const type = EXPORT_TYPES[task.type] || {};
  const override = type.formatOverrides?.[formatKey] || {};
  const { formatOverrides, ...typeConfig } = type;
  return { ...typeConfig, ...format, ...override };
}

function buildStaticSkipRecords(allTasks) {
  const enabledTypes = new Set(
    Object.values(EXPORT_FORMATS).flatMap((format) => format.sourceTypes),
  );
  const recordedAt = new Date().toISOString();

  return allTasks.flatMap((task) => {
    if (task.type === "base") {
      return [{
        attempts: 0,
        category: "本期跳过",
        format: "Excel（Base）",
        id: task.id,
        message: "Base（含附件）导出本期暂不处理",
        name: task.name,
        recordedAt,
        relativeDir: task.relativeDir || "",
        status: "skipped",
        statusLabel: "本期跳过",
        type: task.type,
        url: task.url,
      }];
    }
    if (enabledTypes.has(task.type)) return [];
    return [{
      attempts: 0,
      category: "格式未启用",
      format: "",
      id: task.id,
      message: "当前扩展尚未验证此文档类型的导出参数",
      name: task.name,
      recordedAt,
      relativeDir: task.relativeDir || "",
      status: "skipped",
      statusLabel: "本期跳过",
      type: task.type,
      url: task.url,
    }];
  });
}

function buildLedgerRecord(task, format, extra) {
  return {
    attempts: 1,
    category: "",
    format: format.label,
    id: task.id,
    message: "",
    name: task.name,
    recordedAt: new Date().toISOString(),
    relativeDir: task.relativeDir || "",
    type: task.type,
    url: task.url,
    ...extra,
  };
}

async function migrateLegacyNoPermissionRecords() {
  if (tasks.length === 0) return;
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.lastNotDownloaded,
    STORAGE_KEYS.ledger,
    STORAGE_KEYS.terminalFailures,
    "feishuLastFailuresV1",
  ]);
  const legacyRows = normalizeStoredRecords(
    stored[STORAGE_KEYS.lastNotDownloaded] || stored.feishuLastFailuresV1 || [],
  ).filter((row) => row.status === "no_permission");
  if (legacyRows.length === 0) return;

  const extensionByFormat = {
    Excel: "xlsx",
    FreeMind: "mm",
    Markdown: "md",
    PowerPoint: "pptx",
    Word: "docx",
  };
  const terminalFailures = stored[STORAGE_KEYS.terminalFailures] || {};
  const ledger = stored[STORAGE_KEYS.ledger] || {};
  let migrated = 0;
  for (const row of legacyRows) {
    const task = tasks.find((candidate) => candidate.url === row.url)
      || tasks.find((candidate) => candidate.id === String(row.id) && candidate.type === row.type);
    const extension = extensionByFormat[row.format];
    if (!task || !extension) continue;
    const key = taskKey(task, extension);
    if (!terminalFailures[key]) migrated += 1;
    terminalFailures[key] = { ...row, status: "no_permission", statusLabel: "无权限" };
    ledger[key] = terminalFailures[key];
  }
  if (migrated > 0) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.ledger]: ledger,
      [STORAGE_KEYS.terminalFailures]: terminalFailures,
    });
    appendLog(`已将旧记录中的 ${migrated} 个无权限任务迁移为永久断点。`);
  }
}

function statusLabel(status) {
  return {
    failed: "失败",
    no_permission: "无权限",
    pending: "待处理",
    skipped: "本期跳过",
    success: "已完成",
  }[status] || "失败";
}

function buildExpectedEntries(allTasks) {
  const enabledTypes = new Set(
    Object.values(EXPORT_FORMATS).flatMap((format) => format.sourceTypes),
  );

  return allTasks.flatMap((task) => {
    if (task.type === "base") {
      return [{
        ...task,
        category: "本期跳过",
        expectedKey: taskKey(task, "base-skip"),
        format: "Excel（Base）",
        message: "Base（含附件）导出本期暂不处理",
        status: "skipped",
      }];
    }
    if (!enabledTypes.has(task.type)) {
      return [{
        ...task,
        category: "格式未启用",
        expectedKey: taskKey(task, "unsupported"),
        format: "",
        message: "当前扩展尚未验证此文档类型的导出参数",
        status: "skipped",
      }];
    }

    return Object.values(EXPORT_FORMATS)
      .filter((format) => isTaskSupportedByFormat(task, format))
      .map((format) => ({
        ...task,
        category: "",
        expectedKey: taskKey(task, format.extension),
        format: format.label,
        message: "",
        status: "pending",
      }));
  });
}

async function buildStatusSnapshot() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.completed,
    STORAGE_KEYS.terminalFailures,
    STORAGE_KEYS.ledger,
  ]);
  const completed = stored[STORAGE_KEYS.completed] || {};
  const terminalFailures = stored[STORAGE_KEYS.terminalFailures] || {};
  const ledger = stored[STORAGE_KEYS.ledger] || {};
  const rows = buildExpectedEntries(tasks).map((entry) => {
    let record = entry;
    if (entry.status !== "skipped" && completed[entry.expectedKey]) {
      record = {
        ...entry,
        ...ledger[entry.expectedKey],
        category: "已完成",
        completedAt: completed[entry.expectedKey].completedAt,
        filename: completed[entry.expectedKey].filename,
        message: "",
        status: "success",
      };
    } else if (entry.status !== "skipped" && terminalFailures[entry.expectedKey]) {
      record = { ...entry, ...terminalFailures[entry.expectedKey], status: "no_permission" };
    } else if (entry.status !== "skipped" && ledger[entry.expectedKey]) {
      const saved = ledger[entry.expectedKey];
      record = {
        ...entry,
        ...saved,
        status: saved.status || (saved.category === "无权限" ? "no_permission" : "failed"),
      };
    }
    return {
      ...record,
      recordedAt: record.recordedAt || "",
      statusLabel: statusLabel(record.status),
    };
  });
  const summary = {
    failed: rows.filter((row) => row.status === "failed").length,
    noPermission: rows.filter((row) => row.status === "no_permission").length,
    pending: rows.filter((row) => row.status === "pending").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    success: rows.filter((row) => row.status === "success").length,
    total: rows.length,
  };
  return { generatedAt: new Date().toISOString(), rows, summary };
}

async function renderDashboard() {
  if (tasks.length === 0) {
    dashboardRows = [];
    renderDashboardRows();
    return { generatedAt: new Date().toISOString(), rows: [], summary: emptySummary() };
  }
  const snapshot = await buildStatusSnapshot();
  dashboardRows = snapshot.rows;
  elements.summaryTotal.textContent = snapshot.summary.total;
  elements.summarySuccess.textContent = snapshot.summary.success;
  elements.summaryNoPermission.textContent = snapshot.summary.noPermission;
  elements.summaryFailed.textContent = snapshot.summary.failed;
  elements.summarySkipped.textContent = snapshot.summary.skipped;
  elements.summaryPending.textContent = snapshot.summary.pending;
  const actionableTotal = snapshot.summary.total - snapshot.summary.skipped;
  const completionRate = actionableTotal > 0
    ? Math.round((snapshot.summary.success / actionableTotal) * 1000) / 10
    : 100;
  elements.reportHint.textContent = `可下载项完成率 ${completionRate}% · 更新于 ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
  elements.failureButton.disabled = snapshot.rows.every((row) => row.status === "success");
  renderDashboardRows();
  return snapshot;
}

function emptySummary() {
  return { failed: 0, noPermission: 0, pending: 0, skipped: 0, success: 0, total: 0 };
}

function renderDashboardRows() {
  const query = elements.recordSearch.value.trim().toLocaleLowerCase();
  const status = elements.statusFilter.value;
  const type = elements.typeFilter.value;
  const filtered = dashboardRows.filter((row) => {
    const statusMatches = status === "all"
      || (status === "undownloaded" && row.status !== "success")
      || row.status === status;
    const typeMatches = !type || row.type === type;
    const haystack = [row.name, row.relativeDir, row.category, row.message, row.url]
      .join(" ")
      .toLocaleLowerCase();
    return statusMatches && typeMatches && (!query || haystack.includes(query));
  });

  elements.recordTableBody.replaceChildren();
  for (const row of filtered.slice(0, 300)) {
    const tr = document.createElement("tr");
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge status-badge--${row.status}`;
    badge.textContent = row.statusLabel;
    statusCell.append(badge);
    tr.append(statusCell);
    appendTextCell(tr, row.category || "—");
    appendTextCell(tr, row.type || "—");
    appendTextCell(tr, row.format || "—");
    const nameCell = document.createElement("td");
    const link = document.createElement("a");
    link.href = row.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = row.name || "未命名";
    nameCell.append(link);
    tr.append(nameCell);
    appendTextCell(tr, row.relativeDir || "（根目录）");
    appendTextCell(tr, row.message || "—");
    elements.recordTableBody.append(tr);
  }
  elements.recordCountHint.textContent = filtered.length > 300
    ? `符合条件 ${filtered.length} 条，页面显示前 300 条；完整内容请导出 TSV 或 HTML 简报。`
    : `符合条件 ${filtered.length} 条。`;
}

function appendTextCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.append(cell);
}

function normalizeStoredRecords(rows) {
  return rows.map((row) => ({
    ...row,
    recordedAt: row.recordedAt || row.failedAt || "",
    status: row.status || (row.category === "无权限" ? "no_permission" : row.category === "本期跳过" ? "skipped" : "failed"),
    statusLabel: row.statusLabel || statusLabel(row.status || (row.category === "无权限" ? "no_permission" : row.category === "本期跳过" ? "skipped" : "failed")),
  }));
}

async function downloadNotDownloadedReport(rows, outputFolder) {
  const columns = [
    ["序号", "id"],
    ["名称", "name"],
    ["相对目录", "relativeDir"],
    ["类型", "type"],
    ["URL", "url"],
    ["导出格式", "format"],
    ["状态", "statusLabel"],
    ["未下载分类", "category"],
    ["尝试次数", "attempts"],
    ["原因", "message"],
    ["记录时间", "recordedAt"],
  ];
  const clean = (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ");
  const lines = [
    columns.map(([label]) => label).join("\t"),
    ...rows.map((row) => columns.map(([, key]) => clean(row[key])).join("\t")),
  ];
  const blobUrl = URL.createObjectURL(new Blob([`\uFEFF${lines.join("\n")}\n`], {
    type: "text/tab-separated-values;charset=utf-8",
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    return await chrome.downloads.download({
      conflictAction: "uniquify",
      filename: `${safeRelativeFolder(outputFolder)}/未下载记录_${stamp}.tsv`,
      saveAs: false,
      url: blobUrl,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

async function downloadFullReport(snapshot, outputFolder) {
  const rows = snapshot.rows.filter((row) => row.status !== "success");
  const actionableTotal = snapshot.summary.total - snapshot.summary.skipped;
  const completionRate = actionableTotal > 0
    ? Math.round((snapshot.summary.success / actionableTotal) * 1000) / 10
    : 100;
  const types = [...new Set(snapshot.rows.map((row) => row.type))].sort();
  const typeRows = types.map((type) => {
    const matches = snapshot.rows.filter((row) => row.type === type);
    const count = (status) => matches.filter((row) => row.status === status).length;
    return `<tr><td>${escapeHtml(type)}</td><td>${matches.length}</td><td>${count("success")}</td><td>${count("no_permission")}</td><td>${count("failed")}</td><td>${count("skipped")}</td><td>${count("pending")}</td></tr>`;
  }).join("");
  const reasons = Object.entries(rows.reduce((groups, row) => {
    const key = row.category || row.statusLabel;
    groups[key] = (groups[key] || 0) + 1;
    return groups;
  }, {})).sort((a, b) => b[1] - a[1]);
  const reasonRows = reasons.map(([reason, count]) => `<tr><td>${escapeHtml(reason)}</td><td>${count}</td></tr>`).join("");
  const detailRows = rows
    .sort((a, b) => `${a.status}:${a.type}:${a.relativeDir}:${a.name}`.localeCompare(`${b.status}:${b.type}:${b.relativeDir}:${b.name}`, "zh-CN"))
    .map((row) => `<tr>
      <td><span class="badge badge--${escapeHtml(row.status)}">${escapeHtml(row.statusLabel)}</span></td>
      <td>${escapeHtml(row.category || "—")}</td>
      <td>${escapeHtml(row.type || "—")}</td>
      <td>${escapeHtml(row.format || "—")}</td>
      <td><a href="${escapeHtml(row.url)}">${escapeHtml(row.name)}</a></td>
      <td>${escapeHtml(row.relativeDir || "（根目录）")}</td>
      <td>${escapeHtml(row.message || "—")}</td>
    </tr>`).join("");
  const generatedAt = new Date(snapshot.generatedAt).toLocaleString("zh-CN");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>飞书全目录下载简报</title>
<style>
body{margin:0;background:#f5f7fa;color:#1f2329;font:14px/1.55 "Microsoft YaHei",system-ui,sans-serif}main{max-width:1260px;margin:32px auto;padding:0 20px 48px}h1{margin-bottom:4px}h2{margin-top:28px}.muted{color:#646a73}.cards{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:20px 0}.card{padding:14px;border:1px solid #dee0e3;border-top:4px solid #8f959e;border-radius:8px;background:#fff}.card strong{display:block;margin-top:4px;font-size:26px}.success{border-top-color:#34a853}.permission{border-top-color:#f5a623}.failed{border-top-color:#d93025}.pending{border-top-color:#3370ff}.panel{padding:18px;margin-top:16px;border:1px solid #dee0e3;border-radius:10px;background:#fff}.table{overflow:auto;max-height:720px}table{width:100%;border-collapse:collapse}th,td{padding:9px 10px;border-bottom:1px solid #eff0f1;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#f7f8fa;white-space:nowrap}.badge{display:inline-block;padding:2px 7px;border-radius:99px;background:#eff0f1;white-space:nowrap}.badge--no_permission{background:#fff2d8;color:#ad6800}.badge--failed{background:#fdebec;color:#c03532}.badge--pending{background:#e8f0ff;color:#245bdb}.badge--skipped{color:#646a73}a{color:#245bdb}@media(max-width:850px){.cards{grid-template-columns:repeat(2,1fr)}}
</style></head><body><main>
<h1>飞书全目录下载简报</h1><div class="muted">生成时间：${escapeHtml(generatedAt)} · 可下载项完成率：${completionRate}%</div>
<div class="cards">
<div class="card"><span>总任务</span><strong>${snapshot.summary.total}</strong></div>
<div class="card success"><span>已完成</span><strong>${snapshot.summary.success}</strong></div>
<div class="card permission"><span>无权限</span><strong>${snapshot.summary.noPermission}</strong></div>
<div class="card failed"><span>失败</span><strong>${snapshot.summary.failed}</strong></div>
<div class="card"><span>本期跳过</span><strong>${snapshot.summary.skipped}</strong></div>
<div class="card pending"><span>待处理</span><strong>${snapshot.summary.pending}</strong></div>
</div>
<section class="panel"><h2>按文档类型</h2><div class="table"><table><thead><tr><th>类型</th><th>总数</th><th>已完成</th><th>无权限</th><th>失败</th><th>本期跳过</th><th>待处理</th></tr></thead><tbody>${typeRows}</tbody></table></div></section>
<section class="panel"><h2>未下载原因汇总</h2><table><thead><tr><th>原因分类</th><th>数量</th></tr></thead><tbody>${reasonRows || "<tr><td>无</td><td>0</td></tr>"}</tbody></table></section>
<section class="panel"><h2>未下载明细（${rows.length} 条）</h2><p class="muted">点击文档名称可回到飞书源文件核对权限或重新处理。</p><div class="table"><table><thead><tr><th>状态</th><th>原因分类</th><th>类型</th><th>格式</th><th>名称</th><th>相对目录</th><th>具体原因</th></tr></thead><tbody>${detailRows || "<tr><td colspan=\"7\">全部可下载内容均已完成。</td></tr>"}</tbody></table></div></section>
</main></body></html>`;
  const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    return await chrome.downloads.download({
      conflictAction: "uniquify",
      filename: `${safeRelativeFolder(outputFolder)}/全目录下载简报_${stamp}.html`,
      saveAs: false,
      url: blobUrl,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("下载等待超过 3 分钟")), 180_000);

    function finish(error) {
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve();
    }

    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.error) finish(new Error(`Chrome 下载失败：${delta.error.current}`));
      else if (delta.state?.current === "complete") finish();
      else if (delta.state?.current === "interrupted") finish(new Error("Chrome 下载被中断"));
    }

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === "complete") finish();
      else if (item?.state === "interrupted") {
        finish(new Error(`Chrome 下载失败：${item.error || "下载被中断"}`));
      }
    }).catch((error) => finish(error));
  });
}

refreshSession();
chrome.storage.local.get([STORAGE_KEYS.lastNotDownloaded, "feishuLastFailuresV1"]).then((stored) => {
  const rows = stored[STORAGE_KEYS.lastNotDownloaded] || stored.feishuLastFailuresV1 || [];
  elements.failureButton.disabled = !(rows.length > 0);
});
setInterval(refreshSession, 3000);
