const {render}=require('../theme.cjs');
const slideConfig={
  "type": "content",
  "title": "需要留痕时，保存一条简要记录",
  "image": "03-simple-record.png",
  "focus": {
    "x": 335,
    "y": 178,
    "w": 770,
    "h": 645
  },
  "points": [
    [
      "1",
      "新增记录，选择所属阶段及日期"
    ],
    [
      "2",
      "填标题，正文简述事实与后续安排"
    ],
    [
      "3",
      "点“保存记录”，无需选择结论或上传文件"
    ]
  ],
  "tip": "保存记录不会推进阶段；记录内容和历史结论均不参与阶段推进检查。",
  "index": 5
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
