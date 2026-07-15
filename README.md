# Feishu Drive Bulk Export

一个面向一次性归档的飞书云盘批量导出工具：从本地 `.url` 快捷方式生成任务清单，通过已登录的 Chrome 批量导出云文档，最后把导出物与 PDF、Office、图片等实体文件合并为保留原目录层级的本地归档。

> 本项目不是飞书官方工具。它使用飞书网页当前采用的内部导出接口和页面结构，飞书更新后可能需要适配。请只处理自己拥有访问及下载权限的数据，并遵守组织政策和适用法律；本项目不会绕过权限控制。

## 能做什么

- 递归扫描 `.url` 文件，生成全目录及逐文件夹 TSV 下载清单；
- 批量导出 Word、Markdown、Excel、PowerPoint 和 FreeMind；
- 保留云盘相对目录，支持断点续跑、限速、重试和无权限终止断点；
- 生成未下载明细和 HTML 下载简报；
- 将原有实体文件与云端导出物只增不删地合并，按 SHA-256 去重并保留冲突版本。

Base 暂不导出，只会在报告中标记为跳过。

## 环境要求

- Node.js 20 或更高版本；
- Chrome，且已登录需要归档的飞书企业账号；
- 一个包含飞书 `.url` 快捷方式及可选实体文件的本地源目录。

不需要读取 Cookie、关闭 Chrome 安全策略或开启远程调试端口。

## 完整流程

### 1. 准备源目录

先从飞书云盘取得保持目录结构的本地目录。云文档应表现为 `.url` 快捷方式，已经落地的 PDF、表格、图片等实体文件可保留在同一目录中。

任务清单包含文档 URL 和 token，属于敏感数据，不要提交到 Git 仓库或公开分享。

### 2. 生成下载任务清单

在仓库根目录运行：

```powershell
node scripts/build-feishu-task-lists.mjs "<源目录>" "<清单输出目录>"
```

脚本生成：

- `下载任务清单_全目录.tsv`：扩展的主输入；
- `按文件夹/**/下载任务清单.tsv`：逐文件夹清单；
- `清单汇总.json`：任务数、目录数及类型统计。

### 3. 加载 Chrome 扩展

1. 打开 `chrome://extensions/`；
2. 开启“开发者模式”；
3. 选择“加载已解压的扩展程序”；
4. 选择 `chrome-extension/feishu-bulk-export/`。

详细操作见[扩展使用说明](chrome-extension/feishu-bulk-export/README.md)。

### 4. 初始化临时导出授权

打开企业飞书域名下任意一篇有下载权限的云文档，手动完成一次正常导出。扩展从这次请求中暂存 CSRF 头和必要业务请求头；它不读取 Cookie，Chrome 退出后临时授权失效。

### 5. 分格式批量导出

打开扩展运行页，选择 `下载任务清单_全目录.tsv`，先把“本轮最多处理”设为 `3` 做小样验证。确认文件格式和目录正确后改为 `0`，分别运行需要的格式：

| 飞书类型 | 输出 | 运行模式 |
|---|---|---|
| `docx` / `docs` | `.docx` | Word |
| `docx` / `docs` | `.md` 或含附件压缩包 | Markdown（所有内容） |
| `sheets` | `.xlsx` | Excel |
| `slides` | `.pptx` | PowerPoint |
| `mindnotes` | `.mm` | FreeMind |
| `base` | 无 | 本期跳过并记录 |

建议保持默认并发数 `2`。`code 1002 / no permission` 会成为终止断点，不再反复请求；网络、限流和超时等临时错误按指数退避重试。

### 6. 检查未下载项

运行页可以按状态、类型和关键词筛选任务，并导出全目录未下载明细或 HTML 简报。需要用磁盘上的 Word 文件做补充核对时运行：

```powershell
node scripts/audit-feishu-downloads.mjs `
  "<下载任务清单_全目录.tsv>" `
  "<Chrome 下载输出目录>" `
  "<报告输出目录>"
```

磁盘核对只能判断预期文件是否存在；准确的飞书接口错误原因仍以扩展台账为准。

### 7. 合并完整归档

```powershell
node scripts/merge-feishu-archive.mjs `
  "<源目录>" `
  "<Chrome 下载输出目录>" `
  "<新的归档输出目录>"
```

脚本复制而不移动文件，忽略 `.url`、`.tsv`、`.crdownload` 和 `_未下载记录`。同路径、同内容的文件按 SHA-256 跳过；同路径、不同内容的文件重命名后都保留。

合并采用只增不删策略，不会清理输出目录中的旧文件。制作干净交付物时必须使用新的空输出目录，并查看生成的 `归档合并汇总.json`。

## 项目结构

| 路径 | 用途 |
|---|---|
| `chrome-extension/feishu-bulk-export/` | Manifest V3 批量导出扩展 |
| `scripts/build-feishu-task-lists.mjs` | 生成递归任务清单 |
| `scripts/audit-feishu-downloads.mjs` | 核对 Word 缺失项和固定跳过项 |
| `scripts/merge-feishu-archive.mjs` | 合并实体文件与云端导出物 |
| `docs/ARCHITECTURE.md` | 数据流、导出策略和状态模型 |
| `docs/OPERATIONS.md` | 运行检查表与常见故障 |

## 隐私与安全

- 不要提交任务清单、`.url`、下载报告、导出文件或包含真实租户域名的截图；
- 扩展仅复用当前已登录页面，不保存账号密码，不读取 Cookie；
- 权限错误不会被绕过；
- 发布问题日志前，请先删除文档标题、URL、token、租户域名和本地用户名；
- 详见[安全说明](SECURITY.md)。

## 已知限制

- 飞书内部接口和 DOM 结构没有稳定性保证；
- MindNotes 通过读取页面已渲染的节点树生成 FreeMind XML，超大或未完整渲染的脑图应抽样检查；
- 浏览器断点台账与磁盘文件可能因清理浏览器数据或手工补下载而不一致；最终验收应同时检查台账、简报和文件系统；
- 当前没有实现 Base 导出。

## 许可证

[MIT](LICENSE)
