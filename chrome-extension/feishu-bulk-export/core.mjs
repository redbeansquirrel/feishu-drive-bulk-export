export const EXPORT_TYPES = Object.freeze({
  docx: Object.freeze({ apiType: "docx", needComment: false, verified: true }),
  docs: Object.freeze({
    apiType: "doc",
    formatOverrides: Object.freeze({
      markdown: Object.freeze({ passback: null }),
    }),
    verified: true,
  }),
  mindnotes: Object.freeze({ strategy: "page-freemind", verified: true }),
  sheets: Object.freeze({ apiType: "sheet", verified: true }),
  slides: Object.freeze({ apiType: "slides", verified: true }),
});

export const EXPORT_FORMATS = Object.freeze({
  word: Object.freeze({
    extension: "docx",
    label: "Word",
    passback: null,
    sourceTypes: Object.freeze(["docx", "docs"]),
  }),
  markdown: Object.freeze({
    extension: "md",
    label: "Markdown",
    passback: JSON.stringify({ include_file: true }),
    sourceTypes: Object.freeze(["docx", "docs"]),
  }),
  excel: Object.freeze({
    extension: "xlsx",
    label: "Excel",
    passback: null,
    sourceTypes: Object.freeze(["sheets"]),
  }),
  freemind: Object.freeze({
    extension: "mm",
    label: "FreeMind",
    passback: null,
    sourceTypes: Object.freeze(["mindnotes"]),
  }),
  powerpoint: Object.freeze({
    extension: "pptx",
    label: "PowerPoint",
    passback: null,
    sourceTypes: Object.freeze(["slides"]),
  }),
});

export function parseManifest(text) {
  const tasks = [];
  let indexes = { id: 0, name: 2, relativeDir: -1, type: 3, url: 4 };

  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const columns = line.split("\t");
    if (columns.length < 5) continue;

    if (columns.includes("URL") && columns.includes("名称")) {
      indexes = {
        id: columns.indexOf("序号"),
        name: columns.indexOf("名称"),
        relativeDir: columns.indexOf("相对目录"),
        type: columns.indexOf("类型"),
        url: columns.indexOf("URL"),
      };
      continue;
    }

    const id = (columns[indexes.id] || "").trim();
    const name = (columns[indexes.name] || "").trim();
    const relativeDir = indexes.relativeDir >= 0
      ? (columns[indexes.relativeDir] || "").trim()
      : "";
    const type = (columns[indexes.type] || "").trim().toLowerCase();
    const url = (columns[indexes.url] || "").trim();
    let token = "";

    try {
      const parsedUrl = new URL(url);
      token = parsedUrl.pathname.split("/").filter(Boolean).at(-1) || "";
    } catch {
      continue;
    }

    if (!id || !name || !type || !token) continue;
    tasks.push({ id, name, relativeDir, token, type, url });
  }

  return tasks;
}

export function safeFilename(value) {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return (cleaned || "未命名文档").slice(0, 180);
}

export function taskKey(task, extension) {
  const location = task.relativeDir ? `${task.relativeDir}:` : "";
  return `${location}${task.type}:${task.token}.${extension}`;
}

export async function runPool(items, concurrency, worker, shouldStop) {
  let nextIndex = 0;

  async function runWorker() {
    while (!shouldStop() && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }

  const size = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: size }, runWorker));
}
