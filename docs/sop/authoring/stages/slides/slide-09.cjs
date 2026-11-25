const {render}=require('../theme.cjs');
const slideConfig={
  "type": "content",
  "title": "确认结项后，项目资料转为只读",
  "image": "08-closure-confirm.png",
  "focus": {
    "x": 390,
    "y": 360,
    "w": 660,
    "h": 280
  },
  "points": [
    [
      "1",
      "核对交付、BOM、问题及交接情况"
    ],
    [
      "2",
      "点击“确认推进”，等阶段显示“定型结项”"
    ],
    [
      "3",
      "到“资料与记录”查操作历史，保留追溯"
    ]
  ],
  "tip": "结项不要求每阶段都有记录、结论、照片或附件。确认前完成必要的实际交接。",
  "index": 9
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
