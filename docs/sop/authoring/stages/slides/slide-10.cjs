const {render}=require('../theme.cjs');
const slideConfig={
  "type": "summary",
  "title": "练习：推进一次，再补一条记录",
  "points": [
    "用演示项目从设计中推进至制造准备。",
    "添加日期、标题和一句现场进展，保存后再编辑。",
    "不上传附件继续推进，观察交付或问题提示。",
    "处理业务检查后结项，核对阶段和操作历史。"
  ],
  "tip": "课件入口：流程与 SOP → 项目阶段推进操作 SOP，可在线查看或下载 PPT / PDF。",
  "index": 10
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
