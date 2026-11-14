const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "layout": "cards",
  "title": "常见情况这样处理",
  "cards": [
    [
      "上传失败 / 登录过期",
      "保留当前页与原照片，在照片区恢复登录并重试未确认项；成功项不会重复保存。"
    ],
    [
      "资料填错 / 报告换版",
      "先撤回编辑，说明原因；旧附件归档，新附件上传。提交前核对最终依据。"
    ],
    [
      "项目找不到 / 已结项",
      "核对项目编号与账号岗位；回收站项目不可见。已结项项目只读，未尽事项按交接安排跟进。"
    ],
    [
      "文件太大 / 格式不符",
      "普通附件单个 ≤ 5 MB。支持 PDF、图片、DOCX、XLSX；HEIC 照片先转 JPG。"
    ]
  ],
  "tip": "课件与流程文件在“流程与 SOP”统一查看，可下载本部门 PPT / PDF。",
  "index": 13
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
