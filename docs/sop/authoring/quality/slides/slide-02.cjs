const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "layout": "flow",
  "title": "一条记录的完整办理顺序",
  "steps": [
    [
      "选择项目",
      "核对项目编号、型号与实物"
    ],
    [
      "保存草稿",
      "填写检验依据、实测值和判定"
    ],
    [
      "上传依据",
      "现场照片；样机还需分析报告"
    ],
    [
      "提交与跟进",
      "异常处理后记录复验结论"
    ]
  ],
  "tip": "质量异常只作提醒，不拦截项目阶段；项目负责人继续按原流程推进。",
  "index": 2
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
