// SPDX-License-Identifier: AGPL-3.0-or-later
export const qualityKinds = {
  incoming: '来料检验',
  process: '过程检验',
  sample: '样机报告',
} as const
export type QualityKind = keyof typeof qualityKinds
export const qualityResults = {
  pass: '合格',
  fail: '不合格',
  conditional: '待确认',
} as const
export const qualityStatuses = {
  draft: '草稿',
  recorded: '已记录',
  voided: '已作废',
} as const
export const qualityFields: Record<
  QualityKind,
  Array<{ key: string; label: string; multiline?: boolean }>
> = {
  incoming: [
    { key: 'materialCode', label: '物料编码' },
    { key: 'materialName', label: '物料名称 / 规格' },
    { key: 'supplier', label: '供应商' },
    { key: 'batch', label: '来料批次' },
    { key: 'quantity', label: '来料数量' },
    { key: 'sampleQuantity', label: '检验数量' },
  ],
  process: [
    { key: 'materialCode', label: '零件 / 整机编码' },
    { key: 'materialName', label: '零件 / 整机名称' },
    { key: 'operation', label: '工序 / 检验点' },
    { key: 'batch', label: '生产批次 / 序列号' },
    { key: 'location', label: '检验地点' },
  ],
  sample: [
    { key: 'sampleId', label: '样机编号 / 序列号' },
    { key: 'motorCode', label: '电机编码' },
    { key: 'reportNo', label: '报告编号' },
    { key: 'location', label: '检验地点' },
  ],
}
export const qualityCommonFields = [
  { key: 'inspector', label: '现场检验人' },
  { key: 'basis', label: '检验依据 / 验收标准', multiline: true },
  { key: 'findings', label: '检验项目、实测值与判定', multiline: true },
  { key: 'action', label: '异常说明与跟进安排', multiline: true },
]
