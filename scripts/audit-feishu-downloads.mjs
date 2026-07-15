import fs from "node:fs";
import path from "node:path";

import {
  EXPORT_FORMATS,
  parseManifest,
  safeFilename,
} from "../chrome-extension/feishu-bulk-export/core.mjs";

if (!process.argv[2]) {
  throw new Error(
    "用法：node scripts/audit-feishu-downloads.mjs <任务清单> [下载目录或 -] [报告输出目录]",
  );
}

const manifestPath = path.resolve(process.argv[2]);
const downloadArgument = process.argv[3] || "-";
const outputRoot = path.resolve(process.argv[4] || path.dirname(manifestPath));

if (!fs.existsSync(manifestPath)) {
  throw new Error(`清单不存在：${manifestPath}`);
}

const tasks = parseManifest(fs.readFileSync(manifestPath, "utf8"));
const enabledTypes = new Set(
  Object.values(EXPORT_FORMATS).flatMap((format) => format.sourceTypes),
);
fs.mkdirSync(outputRoot, { recursive: true });

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(fullPath));
    else if (entry.isFile()) results.push(fullPath);
  }
  return results;
}

function cleanCell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function safeRelativeFolder(relativeDir) {
  return String(relativeDir || "")
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(safeFilename)
    .join(path.sep);
}

function toTsv(rows) {
  const columns = [
    ["序号", "id"],
    ["名称", "name"],
    ["相对目录", "relativeDir"],
    ["类型", "type"],
    ["URL", "url"],
    ["导出格式", "format"],
    ["未下载分类", "category"],
    ["尝试次数", "attempts"],
    ["原因", "message"],
    ["记录时间", "recordedAt"],
  ];
  const lines = [
    columns.map(([label]) => label).join("\t"),
    ...rows.map((row) => columns.map(([, key]) => cleanCell(row[key])).join("\t")),
  ];
  return `\uFEFF${lines.join("\n")}\n`;
}

function staticSkipRecord(task, recordedAt) {
  if (task.type === "base") {
    return {
      ...task,
      attempts: 0,
      category: "本期跳过",
      format: "Excel（Base）",
      message: "Base（含附件）导出本期暂不处理",
      recordedAt,
    };
  }
  if (enabledTypes.has(task.type)) return null;
  return {
    ...task,
    attempts: 0,
    category: "格式未启用",
    format: "",
    message: "当前扩展尚未验证此文档类型的导出参数",
    recordedAt,
  };
}

const recordedAt = new Date().toISOString();
const staticRows = tasks
  .map((task) => staticSkipRecord(task, recordedAt))
  .filter(Boolean);
fs.writeFileSync(
  path.join(outputRoot, "本期跳过与未启用记录.tsv"),
  toTsv(staticRows),
  "utf8",
);

let missingWordRows = [];
let actualDocx = null;
let auditedDownloadRoot = null;
if (downloadArgument !== "-") {
  const downloadRoot = path.resolve(downloadArgument);
  auditedDownloadRoot = downloadRoot;
  if (!fs.existsSync(downloadRoot)) {
    throw new Error(`下载文件夹不存在：${downloadRoot}`);
  }
  const available = new Map();
  for (const filePath of walkFiles(downloadRoot)) {
    if (path.extname(filePath).toLowerCase() !== ".docx") continue;
    const key = path.relative(downloadRoot, filePath).toLowerCase();
    available.set(key, filePath);
  }
  actualDocx = available.size;

  const unresolved = [];
  for (const task of tasks.filter((row) => ["docx", "docs"].includes(row.type))) {
    const expectedRelative = path.join(
      safeRelativeFolder(task.relativeDir),
      `${safeFilename(task.name)}.docx`,
    ).toLowerCase();
    if (available.delete(expectedRelative)) continue;
    unresolved.push({ task, expectedRelative });
  }

  for (const { task, expectedRelative } of unresolved) {
    const directory = path.dirname(expectedRelative);
    const stem = path.basename(expectedRelative, ".docx");
    const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const conflictPattern = new RegExp(`^${escapedStem} \\(\\d+\\)\\.docx$`, "i");
    const conflictKey = [...available.keys()].find((key) => (
      path.dirname(key) === directory && conflictPattern.test(path.basename(key))
    ));
    if (conflictKey) {
      available.delete(conflictKey);
      continue;
    }
    missingWordRows.push({
      ...task,
      attempts: "",
      category: "本地未发现文件",
      format: "Word",
      message: "本地下载目录未发现对应 DOCX；精确接口错误请查看扩展导出的全目录未下载明细",
      recordedAt,
    });
  }

  fs.writeFileSync(
    path.join(outputRoot, "未下载记录_Word_本地核对.tsv"),
    toTsv(missingWordRows),
    "utf8",
  );
}

console.log(JSON.stringify({
  actualDocx,
  downloadRoot: auditedDownloadRoot,
  manifest: manifestPath,
  missingWord: missingWordRows.length,
  staticSkippedOrDisabled: staticRows.length,
  tasks: tasks.length,
}));
