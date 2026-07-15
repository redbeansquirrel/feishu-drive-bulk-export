import fs from "node:fs";
import path from "node:path";

if (!process.argv[2] || !process.argv[3]) {
  throw new Error(
    "用法：node scripts/build-feishu-task-lists.mjs <源目录> <清单输出目录>",
  );
}

const sourceRoot = path.resolve(process.argv[2]);
const outputRoot = path.resolve(process.argv[3]);

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`源目录不存在：${sourceRoot}`);
}

function walk(directory) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...walk(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".url")) {
      results.push(fullPath);
    }
  }
  return results;
}

function cleanCell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function parseShortcut(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const url = text.match(/^URL=(.+)$/m)?.[1]?.trim();
  if (!url) return null;

  let type;
  try {
    type = new URL(url).pathname.split("/").filter(Boolean)[0] || "unknown";
  } catch {
    type = "invalid";
  }

  const relativeSource = path.relative(sourceRoot, filePath);
  const relativeDir = path.dirname(relativeSource) === "."
    ? ""
    : path.dirname(relativeSource);

  return {
    name: path.basename(filePath, path.extname(filePath)).trim(),
    relativeDir,
    relativeSource,
    type,
    url,
  };
}

function toTsv(rows) {
  const header = [
    "序号",
    "源链接文件",
    "名称",
    "类型",
    "URL",
    "相对目录",
    "状态",
    "输出文件",
    "消息",
  ];
  const body = rows.map((row, index) => [
    index + 1,
    row.relativeSource,
    row.name,
    row.type,
    row.url,
    row.relativeDir,
    "待下载",
    "",
    "",
  ].map(cleanCell).join("\t"));
  return `${header.join("\t")}\n${body.join("\n")}\n`;
}

const rows = walk(sourceRoot)
  .map(parseShortcut)
  .filter(Boolean)
  .sort((left, right) => (
    left.relativeDir.localeCompare(right.relativeDir, "zh-CN")
    || left.name.localeCompare(right.name, "zh-CN")
  ));

fs.mkdirSync(outputRoot, { recursive: true });
fs.writeFileSync(
  path.join(outputRoot, "下载任务清单_全目录.tsv"),
  toTsv(rows),
  "utf8",
);

const groups = new Map();
for (const row of rows) {
  const key = row.relativeDir || "_根目录";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

for (const [relativeDir, folderRows] of groups) {
  const targetDirectory = path.join(outputRoot, "按文件夹", relativeDir);
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(targetDirectory, "下载任务清单.tsv"),
    toTsv(folderRows),
    "utf8",
  );
}

const typeCounts = {};
for (const row of rows) typeCounts[row.type] = (typeCounts[row.type] || 0) + 1;
const summary = {
  folderLists: groups.size,
  generatedAt: new Date().toISOString(),
  sourceRoot,
  tasks: rows.length,
  typeCounts,
};
fs.writeFileSync(
  path.join(outputRoot, "清单汇总.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(summary));
