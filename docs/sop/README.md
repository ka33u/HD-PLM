# 部门 SOP 部署资源

系统入口：`/npi?view=guides`。所有已启用并分配 NPI 岗位的用户均可访问；目录、页面图、原课件及 PDF 都通过会话鉴权接口提供，不放在公共静态资源目录。

- `design.pptx`、`production.pptx`、`procurement.pptx`：2026 年 11 月已在 Microsoft PowerPoint 验证过的修复版原课件，分别为 17 / 12 / 11 页。
- 同名 PDF：离线查阅；各同名子目录中的 WebP：逐页在线查看，只加载当前页，支持手机放大阅读。
- `catalog.json`：页码、标题、文字以及文件大小和 SHA-256 校验信息。

替换课件后，在文档制作环境安装 LibreOffice、Poppler 和 Pillow，执行 `python3 scripts/prepare-sop.py`。命令支持 `--soffice`、`--pdftoppm` 指定工具路径；中文字体不全时使用 `FONTCONFIG_FILE` 指向本机字体配置。检查每份 PDF 的页数、文字、截图和排版后，连同目录与预览文件一并更新。

`npm run build` 会校验资源是否齐全以及内容是否与清单一致；不能只替换 PPT 而继续发布旧预览。容器构建也执行此检查，运行容器复制整个 `docs` 目录。普通 Node 部署需同时保留 `dist` 和 `docs`；无须在服务器安装 Office 或转换工具。

本目录为培训演示资料，不包含真实账号密码或生产项目数据。适用版本在课件目录显示；应用只增加文件入口时不改写课件内容版本。

质量部课件为 14 页，适用 HD-PLM 4.3.0。可编辑源稿位于 `authoring/quality/`，截图来自隔离测试环境的真实界面，均为演示数据。使用文档环境的 PptxGenJS 运行 `node docs/sop/authoring/quality/compile.cjs`，再执行 `python3 scripts/prepare-sop.py --only quality`，其余部门的已验证资源不会被重新生成。

课件需通过 OOXML 校验、逐页预览及 Microsoft PowerPoint 实际打开检查后再交付；圆形和矩形不可使用 `rectRadius`。质量课件与程序文件 A1 的第 5.10 条对应，质量异常只提醒、不拦截流程。
