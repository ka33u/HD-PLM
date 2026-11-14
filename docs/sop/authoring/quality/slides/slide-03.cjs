const { render } = require('../theme.cjs');
const slideConfig = {
  "type": "content",
  "layout": "roles",
  "title": "先开通质量岗位，再维护记录",
  "rows": [
    [
      "质量人员",
      "注册选择质量类部门；管理员审核后登录",
      "维护所有未结项项目的质量记录"
    ],
    [
      "管理员",
      "系统设置 → 账号与部门",
      "开通质量账号、维护部门与记录"
    ],
    [
      "项目负责人 / 生产 / 主管",
      "项目 → 质量记录",
      "在各自项目权限内查阅；阶段由项目负责人推进"
    ]
  ],
  "tip": "注册不能自行申请管理员。注册使用本人密码；管理员创建账号首次登录按提示改密。",
  "index": 3
};
function createSlide(pres,theme){return render(pres,theme,slideConfig)}
module.exports={slideConfig,createSlide};
