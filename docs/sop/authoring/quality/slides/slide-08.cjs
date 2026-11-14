const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "title": "样机报告必须有分析和结论",
  "image": "07-report-upload.png",
  "focus": true,
  "points": [
    [
      "1",
      "核对样机、报告编号和电机编码"
    ],
    [
      "2",
      "上传报告，填写数据对比分析"
    ],
    [
      "3",
      "选择报告结论，再提交记录"
    ]
  ],
  "tip": "样机提交须同时有现场照片和报告。存在未通过报告时，检验结论不能选“合格”。",
  "index": 8
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
