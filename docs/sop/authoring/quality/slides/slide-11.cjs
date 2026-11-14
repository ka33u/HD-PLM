const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "layout": "flow",
  "title": "修订报告时保留原件与原因",
  "steps": [
    [
      "撤回编辑",
      "已提交记录先说明修改原因"
    ],
    [
      "维护资料",
      "旧版说明原因归档；上传新版"
    ],
    [
      "重新提交",
      "核对照片、报告分析与结论"
    ],
    [
      "追溯历史",
      "查看修改与上传记录及原附件"
    ]
  ],
  "tip": "重复或错误记录可说明原因作废，不直接删除。多人编辑冲突时读取最新版本并核对。",
  "index": 11
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
