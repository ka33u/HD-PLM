const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "title": "保存、留照，再提交来料记录",
  "image": "03-incoming-list.png",
  "points": [
    [
      "1",
      "保存草稿后上传标识与外观照片"
    ],
    [
      "2",
      "不合格或待确认须写跟进安排"
    ],
    [
      "3",
      "提交后在列表核对状态与异常"
    ]
  ],
  "tip": "列表可筛选草稿、已记录、异常待处理或已作废，快速找到尚未办结的事项。",
  "index": 6
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
