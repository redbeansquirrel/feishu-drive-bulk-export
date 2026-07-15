# 飞书一次性批量导出扩展

该 Manifest V3 扩展读取本项目生成的 TSV 清单，在已登录飞书的 Chrome 中批量导出有权限的云文档，并保留清单中的相对目录。

## 安装

1. 在 Chrome 打开 `chrome://extensions/`；
2. 开启右上角“开发者模式”；
3. 点击“加载已解压的扩展程序”；
4. 选择本仓库的 `chrome-extension/feishu-bulk-export/` 目录。

不需要关闭 Chrome 安全策略或开启远程调试端口。修改扩展代码后，请在扩展管理页点击“重新加载”，再重新打开运行页。

## 初始化本次会话

1. 保持扩展已启用；
2. 打开 `https://<你的企业租户>.feishu.cn/` 下任意一篇有下载权限的云文档；
3. 正常执行一次“更多 → 下载为/导出”；
4. 点击 Chrome 工具栏中的“飞书一次性批量导出”图标。

切换到 Word/Markdown、Excel 或 PowerPoint 前，分别用同类文档正常导出一次最稳妥。FreeMind 由扩展读取页面节点树生成，但仍需保持同域页面和登录状态有效。

扩展只在 Chrome session storage 中暂存这次正常导出请求的 CSRF 头和必要业务头，不读取 Cookie；Chrome 退出后临时授权失效。

## 生成任务清单

在仓库根目录运行：

```powershell
node scripts/build-feishu-task-lists.mjs "<源目录>" "<清单输出目录>"
```

然后在扩展运行页选择 `<清单输出目录>/下载任务清单_全目录.tsv`。清单含真实文档 URL 和 token，不要上传到 GitHub 或发给无关人员。

## 批量运行

1. 选择 TSV 清单并设置 Chrome 下载目录下的相对子文件夹；
2. 并发数建议保持 `2`。创建导出任务会限速，并对临时错误执行指数退避重试；
3. 将“本轮最多处理”设为 `3`，分别验证所需格式；
4. 抽查下载文件后，将上限改为 `0` 运行全部；
5. 执行期间保持作为执行页面的飞书文档标签页打开。

支持的运行模式：

- `Word`：`docx`、`docs` → `.docx`；
- `Markdown`：`docx`、`docs` → `.md` 或含附件压缩包，内容范围为“所有内容”；
- `Excel（仅 Sheet）`：`sheets` → `.xlsx`；
- `FreeMind（仅 MindNotes）`：`mindnotes` → `.mm`；
- `PowerPoint（仅 Slides）`：`slides` → `.pptx`。

五种格式使用独立断点，可以分轮完整下载。Base 当前固定跳过，不向飞书发起导出请求，并以“本期跳过”写入报告。

## 断点、重试与报告

扩展会把任务状态保存在 `chrome.storage.local`。再次选择同一清单运行时：

- 已完成任务自动跳过；
- `code 1002 / no permission` 保存为永久无权限断点，不再重复请求；
- 限流、网络错误和超时采用指数退避重试；
- 只有点击“清除全部断点”才会移除已有断点。

运行页的全目录概览可按状态、类型或关键词筛选，并可打开原始飞书链接。每轮结束会导出 TSV 未下载明细；“生成全目录下载简报（HTML）”会汇总完成率、类型分布、原因和完整未下载记录。

选择一种格式时，其他已支持格式显示为“待处理”，不会被误记为失败。浏览器台账被清理或手工补下载后，概览可能与磁盘不一致，最终应结合文件系统核对。

## MindNotes 实现说明

部分飞书页面版本中，原生“下载为 → FreeMind”会在点击后抛出前端异常，或没有向 Chrome 登记 `.mm` 下载任务。因此扩展不依赖菜单点击，也不做任意 Blob 拦截，而是在临时同域页面中读取 `.mindnote-tree` 的节点父子结构，生成标准 FreeMind XML。该模式固定单任务执行。

## 下载后核对与合并

Word 磁盘核对：

```powershell
node scripts/audit-feishu-downloads.mjs `
  "<任务清单>" "<Chrome 下载目录>" "<报告输出目录>"
```

合并实体文件和云端导出：

```powershell
node scripts/merge-feishu-archive.mjs `
  "<源目录>" "<Chrome 下载目录>" "<新的归档目录>"
```

合并脚本只复制、不移动；重复内容按哈希跳过，同名但内容不同的文件均会保留。脚本不会清理输出目录中的历史文件，制作干净归档时必须使用新的空输出目录。

## 维护提示

飞书网页内部接口和 DOM 结构可能变化。格式映射以 `core.mjs` 为代码来源；修改格式参数时同步更新本说明和 `docs/ARCHITECTURE.md`，并运行：

```powershell
node --check chrome-extension/feishu-bulk-export/runner.js
node --check chrome-extension/feishu-bulk-export/background.js
node --check chrome-extension/feishu-bulk-export/core.mjs
```
