// SPDX-License-Identifier: AGPL-3.0-or-later
import { NpiError, dateValue, textValue, today } from './domain'
export const lifecycleKinds = [
  'design',
  'manufacturing',
  'prototype',
  'test',
  'trial',
  'closure',
] as const
export type LifecycleKind = (typeof lifecycleKinds)[number]
export type LifecycleResult =
  'pass' | 'fail' | 'continue' | 'not_applicable' | ''
export interface Measurement {
  item: string
  requirement: string
  measured: string
  unit: string
  verdict: string
}
export interface LifecycleData {
  fields: Record<string, string>
  measurements: Measurement[]
}
export interface ProcessField {
  key: string
  label: string
  group: string
  hint: string
  short?: boolean
}
const field = (
  key: string,
  label: string,
  group: string,
  hint: string,
  short = false,
): ProcessField => ({ key, label, group, hint, short })
export const lifecycleDefinitions: Record<
  LifecycleKind,
  { label: string; purpose: string; fields: ProcessField[] }
> = {
  design: {
    label: '设计确认',
    purpose: '明确需求、验收指标和设计基线，识别风险，确认试验与客户试用安排。',
    fields: [
      field(
        'requirements',
        '需求与应用边界',
        '需求确认',
        '记录客户用途、负载、安装接口、环境、性能和交付范围。',
      ),
      field(
        'acceptance',
        '验收指标与依据',
        '需求确认',
        '写明客户协议、适用标准或技术条件及版本、指标和判定方法，不能仅写符合要求。',
      ),
      field(
        'baseline',
        '图纸与技术基线',
        '设计评审',
        '列明图纸、BOM、计算与技术文件版本；记录评审日期、参加人及意见处理。',
      ),
      field(
        'riskPlan',
        '风险与验证安排',
        '设计评审',
        '列明设计风险、重点验证项、试验计划、客户试用是否适用及判定依据。',
      ),
    ],
  },
  manufacturing: {
    label: '试制准备',
    purpose: '协调工艺、工装、关键物料与外协条件，落实试制安排。',
    fields: [
      field(
        'processPlan',
        '工艺与外协准备',
        '准备核对',
        '记录工艺文件版本、关键工序、外协能力、质量控制点与技术交底。',
      ),
      field(
        'toolingPlan',
        '工装与检具准备',
        '准备核对',
        '记录可用工装、检具、专用设备；新增工装在交付任务中维护，写明对应项。',
      ),
      field(
        'materialRisk',
        '物料风险与应对',
        '准备核对',
        '引用交付任务的未回复、延期和换版风险，明确替代方案和协调结果。',
      ),
      field(
        'buildPlan',
        '试制安排与检查要求',
        '准备核对',
        '记录试制台数、样机标识、计划、过程检查和停工升级条件。',
      ),
    ],
  },
  prototype: {
    label: '样机确认',
    purpose: '核实样机实物与基线一致，记录装配、检验和送试条件。',
    fields: [
      field(
        'sampleId',
        '样机编号与数量',
        '样机核对',
        '填写实际送试样机序列号和数量，不能只填电机型号。',
        true,
      ),
      field(
        'asBuilt',
        '实物配置与偏差',
        '样机核对',
        '记录实际图纸、BOM和软件版本；代用料、返修与临时更改逐项说明。',
      ),
      field(
        'inspection',
        '装配与出厂检查结果',
        '样机核对',
        '记录装配检查、关键尺寸、绝缘等项目的实际结果和记录编号。',
      ),
      field(
        'handover',
        '送试交接与注意事项',
        '样机核对',
        '写明接收人、日期、样机状态、试验限制和随附资料。',
      ),
    ],
  },
  test: {
    label: '试验跟踪',
    purpose:
      '项目负责人到现场记录实际条件，逐项分析结果；上传报告时同时填写分析和结论。',
    fields: [
      field(
        'sampleId',
        '受试样机及配置版本',
        '试验安排',
        '样机序列号、数量、图纸/BOM及控制器版本。',
        true,
      ),
      field(
        'basis',
        '试验项目及判定依据',
        '试验安排',
        '列明技术协议或标准版本、试验方法、目标指标和合格条件。',
      ),
      field(
        'location',
        '现场地点',
        '现场条件',
        '填写实验室或客户现场的实际地点。',
        true,
      ),
      field(
        'witnesses',
        '现场参加人员',
        '现场条件',
        '填写到场项目负责人、试验人员和见证人姓名。',
        true,
      ),
      field(
        'environment',
        '环境与安装条件',
        '现场条件',
        '实际温度、湿度、海拔或气压，安装方向、固定方式、冷却条件。',
      ),
      field(
        'powerLoad',
        '供电与负载条件',
        '现场条件',
        '实际电压、频率、波形或变频器设置、负载、转速、工作制、持续时间。',
      ),
      field(
        'instruments',
        '设备仪器与校准状态',
        '现场条件',
        '设备编号、量程、精度、校准有效期；无关项说明原因。',
      ),
      field(
        'observations',
        '现场过程与异常',
        '现场条件',
        '记录起止过程、关键现象、停机和条件变化；没有异常也需写明。',
      ),
    ],
  },
  trial: {
    label: '客户试用',
    purpose: '跟踪实际使用工况、客户反馈、问题处理及最终接受结论。',
    fields: [
      field(
        'customerContact',
        '试用客户与联系人',
        '试用安排',
        '客户、使用地点、对接人及反馈渠道。',
        true,
      ),
      field(
        'sampleId',
        '试用产品编号与版本',
        '试用安排',
        '产品序列号、数量、当前配置以及发出/安装日期。',
        true,
      ),
      field(
        'trialPlan',
        '试用周期与验收约定',
        '试用安排',
        '计划起止日期、目标累计时间、检查频率、成功标准和停止条件。',
      ),
      field(
        'conditions',
        '实际工况与累计使用',
        '客户反馈',
        '负载、供电、环境、工作制、累计小时数、启停次数或其他适用计量。',
      ),
      field(
        'feedback',
        '客户原始反馈',
        '客户反馈',
        '记录反馈日期、人员、原话或客观现象，关联邮件、照片或签字记录。',
      ),
      field(
        'assessment',
        '反馈分析与验证结果',
        '客户反馈',
        '区分客户描述与技术判断，说明原因、影响、整改和复核结果。',
      ),
      field(
        'customerConfirmation',
        '客户确认结果',
        '客户反馈',
        '接受、继续观察或不接受的确认人、日期及依据。',
      ),
    ],
  },
  closure: {
    label: '定型与结项',
    purpose: '核对问题闭环、最终技术资料和交接，沉淀经验后归档。',
    fields: [
      field(
        'finalBaseline',
        '最终定型基线',
        '结项核对',
        '最终图纸、BOM、工艺、软件版本与试验/试用结论对应关系。',
      ),
      field(
        'changeReview',
        '更改与遗留风险复核',
        '结项核对',
        '逐项说明更改验证、适用范围、遗留限制和使用注意事项；不能用此项豁免未关闭问题。',
      ),
      field(
        'transfer',
        '生产与服务交接',
        '结项核对',
        '接收部门和人员、交接日期、检验要求、服务要点和资料位置。',
      ),
      field(
        'lessons',
        '经验与后续改进',
        '结项核对',
        '总结设计、工艺、供应和试验经验，明确可复用内容与后续改进责任。',
      ),
    ],
  },
}
export const resultLabels: Record<string, string> = {
  pass: '通过',
  fail: '不通过',
  continue: '继续跟踪',
  not_applicable: '不适用',
  '': '待判定',
}
export const statusLabels: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  cancelled: '已取消',
}
export function parseLifecycleData(
  kind: LifecycleKind,
  value: unknown,
): LifecycleData {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const input =
    raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields)
      ? (raw.fields as Record<string, unknown>)
      : {}
  const keys = [
    ...lifecycleDefinitions[kind].fields.map((f) => f.key),
    'summary',
    'nextAction',
    'followUpDate',
    'waiverReason',
    'customerConfirmation',
  ]
  const fields: Record<string, string> = {}
  for (const key of new Set(keys))
    fields[key] = textValue(input[key], key, 8000, true)
  if (fields.followUpDate)
    fields.followUpDate = dateValue(fields.followUpDate, '下次跟进日期')!
  if (raw.measurements !== undefined && !Array.isArray(raw.measurements))
    throw new NpiError('VALIDATION_ERROR', '试验测项格式无效')
  if (Array.isArray(raw.measurements) && raw.measurements.length > 100)
    throw new NpiError('VALIDATION_ERROR', '单条记录最多100个测项')
  const measurements = (
    Array.isArray(raw.measurements) ? raw.measurements : []
  ).map((m: Record<string, unknown>) => {
    if (!m || typeof m !== 'object')
      throw new NpiError('VALIDATION_ERROR', '试验测项格式无效')
    const row = Object.fromEntries(
      ['item', 'requirement', 'measured', 'unit', 'verdict'].map((k) => [
        k,
        textValue(m[k], '试验测项', 1000, true),
      ]),
    ) as unknown as Measurement
    if (!['', 'pass', 'fail', 'pending'].includes(row.verdict))
      throw new NpiError('VALIDATION_ERROR', '测项判定无效')
    return row
  })
  return { fields, measurements }
}
export function submissionErrors(
  record: {
    kind: LifecycleKind
    result: string
    data: LifecycleData
    performedDate: string | null
  },
  files: Array<{ category: string; conclusion: string; archivedAt: unknown }>,
) {
  const errors: string[] = [],
    { fields, measurements } = record.data
  const active = files.filter((f) => !f.archivedAt)
  if (!record.performedDate) errors.push('请填写实际记录日期')
  else if (record.performedDate > today()) errors.push('实际记录日期不能在未来')
  if (!fields.summary) errors.push('请填写分析与最终结论说明')
  if (!record.result) errors.push('请选择结论')
  if (record.result === 'not_applicable') {
    if (record.kind !== 'trial') errors.push('只有客户试用可以登记不适用')
    if (!fields.waiverReason || !fields.customerConfirmation)
      errors.push('不适用须填写适用性说明及客户或合同确认依据')
    if (!active.length) errors.push('请上传客户或合同确认依据')
    return errors
  }
  for (const f of lifecycleDefinitions[record.kind].fields)
    if (!fields[f.key]) errors.push(`请填写${f.label}`)
  if (
    ['fail', 'continue'].includes(record.result) &&
    (!fields.nextAction || !fields.followUpDate)
  )
    errors.push('未通过或继续跟踪时，须填写后续措施与下次跟进日期')
  if (
    fields.followUpDate &&
    record.performedDate &&
    fields.followUpDate < record.performedDate
  )
    errors.push('下次跟进日期不能早于实际记录日期')
  if (record.kind === 'test') {
    if (!measurements.length) errors.push('至少记录一个实际试验测项')
    if (
      measurements.some(
        (m) =>
          !m.item ||
          !m.requirement ||
          !m.measured ||
          !['pass', 'fail'].includes(m.verdict),
      )
    )
      errors.push('每个测项须填写名称、判定要求、实测结果和判定')
    const reports = active.filter((f) => f.category === 'report')
    if (!reports.length) errors.push('请上传已填写分析和结论的试验报告')
    if (
      record.result === 'pass' &&
      (measurements.some((m) => m.verdict !== 'pass') ||
        reports.some((f) => f.conclusion !== 'pass'))
    )
      errors.push('存在未通过的测项或报告，不能给出通过结论')
  }
  if (record.kind === 'trial' && !active.length)
    errors.push('请上传客户反馈或确认依据')
  return errors
}

export function lifecycleSummary(
  records: Array<{
    kind: LifecycleKind
    title: string
    status: string
    result: string
    plannedDate: string | null
    data: LifecycleData
  }>,
  stage: string,
  day = today(),
) {
  if (stage === 'completed')
    return {
      pendingCount: 0,
      overdueCount: 0,
      failedCount: 0,
      nextDate: '',
      nextLabel: '',
    }
  const latest = new Map<LifecycleKind, (typeof records)[number]>()
  for (const r of records)
    if (r.status !== 'cancelled' && !latest.has(r.kind)) latest.set(r.kind, r)
  const pending = records.filter(
    (r) =>
      r.status === 'draft' ||
      (latest.get(r.kind) === r &&
        r.status === 'submitted' &&
        ['fail', 'continue'].includes(r.result)),
  )
  const dates = pending
    .map((r) => ({
      date: r.status === 'draft' ? r.plannedDate : r.data.fields.followUpDate,
      label: r.title,
    }))
    .filter((r) => !!r.date)
    .sort((a, b) => a.date!.localeCompare(b.date!))
  const current = latest.get(stage as LifecycleKind)
  return {
    pendingCount: pending.length + (!current ? 1 : 0),
    overdueCount: dates.filter((r) => r.date! < day).length,
    failedCount: [...latest.values()].filter(
      (r) => r.status === 'submitted' && r.result === 'fail',
    ).length,
    nextDate: dates[0]?.date || '',
    nextLabel:
      dates[0]?.label ||
      (!current && lifecycleDefinitions[stage as LifecycleKind]
        ? lifecycleDefinitions[stage as LifecycleKind].label
        : ''),
  }
}
