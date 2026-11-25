const {render}=require('../theme.cjs');
const slideConfig={
  "type": "content",
  "title": "先核实进度，再确认下一阶段",
  "layout": "flow",
  "steps": [
    [
      "进入项目",
      "选择新品项目\n打开项目流程"
    ],
    [
      "核实当前进度",
      "查看当前阶段\n核对实际完成情况"
    ],
    [
      "点击推进阶段",
      "核对弹窗中的目标\n按需填写图纸日期"
    ],
    [
      "确认并检查",
      "等待保存成功\n核对阶段与历史"
    ]
  ],
  "tip": "顺序：设计中 → 制造准备 → 样机制作 → 样机试验 → 客户试用 → 定型结项。",
  "index": 2
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
