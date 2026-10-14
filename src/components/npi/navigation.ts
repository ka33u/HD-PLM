// SPDX-License-Identifier: AGPL-3.0-or-later
export const moduleInfo = {
  trash: {
    label: '项目回收站',
    title: '项目回收站',
    description: '查看删除记录，恢复项目及原有资料。',
  },
  dashboard: {
    label: '首页',
    title: '新品驾驶舱',
    description: '查看项目进度、今日待办和齐套风险。',
  },
  projects: {
    label: '新品项目',
    title: '新品项目',
    description: '按阶段管理新品计划、负责人和样机目标。',
  },
  bom: {
    label: 'BOM管理',
    title: 'BOM管理',
    description: '按项目导入ERP BOM、查看完整结构与历史版本。',
  },
  manufacturing: {
    label: '生产任务',
    title: '生产任务',
    description:
      '按项目查看电机 BOM，回复本人或本部门负责的零部件、工装及整机。',
  },
  purchasing: {
    label: '采购管理',
    title: '采购管理',
    description: '先选择项目，再查看采购 BOM 和到货进展。',
  },
  reports: {
    label: '报表看板',
    title: '报表看板',
    description: '查看阶段分布、样机完成结果和承诺变更。',
  },
  data: {
    label: '基础数据',
    title: '基础数据',
    description: '维护电机类型、BOM导入模板，查看阶段和任务分配规则。',
  },
  settings: {
    label: '系统设置',
    title: '系统设置',
    description: '统一管理账号、业务岗位、密码和登录状态。',
  },
  procurement: {
    label: '采购管理',
    title: '采购管理',
    description: '按项目查看本人及同部门采购件，批量回复交期、确认到货。',
  },
} as const
export type ModuleId = keyof typeof moduleInfo
export function navigationFor(role: string): Array<ModuleId> {
  if (role === 'procurement') return ['procurement']
  return [
    'dashboard',
    'projects',
    'bom',
    'manufacturing',
    'purchasing',
    'reports',
    ...(role === 'admin' ? (['data', 'settings'] as const) : []),
  ]
}
export const stageLabels: Record<string, string> = {
  design: '设计中',
  manufacturing: '制造准备',
  prototype: '样机制作',
  test: '样机试验',
  completed: '完成',
}
export const stateLabels: Record<string, string> = {
  pending_reply: '待回复',
  normal: '正常',
  risk: '风险',
  overdue: '逾期',
  completed: '已完成',
}
