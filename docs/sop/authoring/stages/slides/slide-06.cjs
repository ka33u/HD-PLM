const {render}=require('../theme.cjs');
const slideConfig={
  "type": "content",
  "title": "已保存记录可以继续补充",
  "image": "04-record-list.png",
  "focus": {
    "x": 260,
    "y": 680,
    "w": 1140,
    "h": 320
  },
  "points": [
    [
      "1",
      "按阶段筛选，点击记录标题打开"
    ],
    [
      "2",
      "补充或更正正文，再保存；修改留痕"
    ],
    [
      "3",
      "作废需说明原因；历史已提交记录保持只读"
    ]
  ],
  "tip": "多人编辑提示版本变化时，读取最新内容后核对。保存结果不明时先核对服务器记录。",
  "index": 6
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
