import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
  throw new Error(
    "用法：node scripts/merge-feishu-archive.mjs <源目录> <云端导出目录> <归档输出目录>",
  );
}

const sourceRoot = path.resolve(process.argv[2]);
const exportedRoot = path.resolve(process.argv[3]);
const outputRoot = path.resolve(process.argv[4]);

if (!fs.existsSync(sourceRoot)) throw new Error(`原文件目录不存在：${sourceRoot}`);
if (!fs.existsSync(exportedRoot)) throw new Error(`云端导出目录不存在：${exportedRoot}`);

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

if (isInside(outputRoot, sourceRoot) || isInside(outputRoot, exportedRoot)) {
  throw new Error("归档输出目录不能位于任一输入目录内部");
}

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

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function filesEqual(left, right) {
  const [leftStat, rightStat] = await Promise.all([
    fs.promises.stat(left),
    fs.promises.stat(right),
  ]);
  if (leftStat.size !== rightStat.size) return false;
  const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
  return leftHash === rightHash;
}

async function copyPreservingTime(source, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination);
  const stat = await fs.promises.stat(source);
  await fs.promises.utimes(destination, stat.atime, stat.mtime);
}

function conflictPath(destination, label, index = 0) {
  const extension = path.extname(destination);
  const stem = extension ? destination.slice(0, -extension.length) : destination;
  const suffix = index === 0 ? ` (${label})` : ` (${label} ${index + 1})`;
  return `${stem}${suffix}${extension}`;
}

const summary = {
  copied: 0,
  duplicateSkipped: 0,
  exportedFilesFound: 0,
  exportedRoot,
  generatedAt: new Date().toISOString(),
  outputRoot,
  renamedOnConflict: 0,
  sourceFilesFound: 0,
  sourceRoot,
};

async function mergeFile(source, relativePath, conflictLabel) {
  const destination = path.join(outputRoot, relativePath);
  if (!fs.existsSync(destination)) {
    await copyPreservingTime(source, destination);
    summary.copied += 1;
    return;
  }
  if (await filesEqual(source, destination)) {
    summary.duplicateSkipped += 1;
    return;
  }

  for (let index = 0; ; index += 1) {
    const candidate = conflictPath(destination, conflictLabel, index);
    if (!fs.existsSync(candidate)) {
      await copyPreservingTime(source, candidate);
      summary.copied += 1;
      summary.renamedOnConflict += 1;
      return;
    }
    if (await filesEqual(source, candidate)) {
      summary.duplicateSkipped += 1;
      return;
    }
  }
}

await fs.promises.mkdir(outputRoot, { recursive: true });

const sourceFiles = walkFiles(sourceRoot)
  .filter((filePath) => path.extname(filePath).toLowerCase() !== ".url");
summary.sourceFilesFound = sourceFiles.length;
for (const filePath of sourceFiles) {
  await mergeFile(filePath, path.relative(sourceRoot, filePath), "实体文件");
}

const exportedFiles = walkFiles(exportedRoot).filter((filePath) => {
  const relative = path.relative(exportedRoot, filePath);
  const segments = relative.split(path.sep);
  const extension = path.extname(filePath).toLowerCase();
  return !segments.includes("_未下载记录")
    && ![".crdownload", ".tsv"].includes(extension);
});
summary.exportedFilesFound = exportedFiles.length;
for (const filePath of exportedFiles) {
  await mergeFile(filePath, path.relative(exportedRoot, filePath), "云端导出");
}

await fs.promises.writeFile(
  path.join(outputRoot, "归档合并汇总.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(summary));
