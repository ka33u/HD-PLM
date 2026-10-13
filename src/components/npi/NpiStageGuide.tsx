// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowUpRight, CheckCircle2, Circle, AlertCircle } from 'lucide-react'
import { stages } from '../../lib/npi/domain'
import { stageLabels } from './navigation'
import type { NpiMetadata, ProjectDetail } from '../../lib/npi/service'
import './workflow.css'
const guidance = {
  design: {
    title: '确认设计基线，安排协同任务',
    detail:
      '技术负责人维护项目资料、导入 BOM；零部件默认分给制造负责人，需要采购的批量转交；图纸完成后进入制造准备。',
    role: '技术负责人',
    tab: 'bom',
    action: '打开BOM与任务分配',
  },
  manufacturing: {
    title: '收齐制造与采购回复，跟进实际进展',
    detail:
      '生产与采购逐项回复零部件、工装及整机的预计完成时间；实际完成后单独确认，同部门成员可协作办理。',
    role: '制造负责人及部件责任人',
    tab: 'manufacturing',
    action: '查看制造任务',
  },
  prototype: {
    title: '核对齐套与装配，记录样机结果',
    detail:
      '逐项核对所有零部件、工装和整机的实际完成；异常录入项目问题，过程资料上传到项目资料。',
    role: '制造负责人、技术负责人',
    tab: 'kit',
    action: '核对样机齐套',
  },
  test: {
    title: '跟进试验问题，核对结项资料',
    detail:
      '试验记录放入项目资料，问题逐项处理、验证与关闭；全部零部件、工装与整机完成后确认结项。',
    role: '技术负责人及问题责任人',
    tab: 'issues',
    action: '处理项目问题',
  },
  completed: {
    title: '项目已完成，资料与协同历史保留',
    detail:
      '当前项目为只读，可查看承诺、实际完成和处理记录；相似新品可从项目管理中继承创建。',
    role: '项目成员查阅',
    tab: 'history',
    action: '查看协同历史',
  },
} as const
export function NpiStageGuide({
  project,
  meta,
  onTab,
}: {
  project: ProjectDetail
  meta: NpiMetadata
  onTab: (tab: string) => void
}) {
  const stage = project.currentNpiStage,
    guide = guidance[stage]
  const nodes = project.items.filter((i) => i.sourceType === 'WHOLE_MACHINE'),
    materials = project.items.filter(
      (i) =>
        !['MANUFACTURING', 'LEGACY_NODE', 'WHOLE_MACHINE'].includes(
          i.sourceType,
        ) &&
        (i.affectsKit || i.trackingEnabled),
    )
  const pending = materials.filter(
    (i) => !i.actualCompleteDate && !i.currentCommittedDate,
  ).length
  const manufacturing =
    meta.users.find((u) => u.id === project.manufacturingOwnerId)?.name ||
    '制造负责人'
  const technical =
    meta.users.find((u) => u.id === project.technicalOwnerId)?.name ||
    '技术负责人'
  return (
    <section className="npi-stage-guide" aria-label="当前阶段协作指引">
      <ol className="npi-stage-progress" aria-label="项目五阶段">
        {stages.map((value, index) => (
          <li
            key={value}
            className={
              index < stages.indexOf(stage)
                ? 'done'
                : value === stage
                  ? 'current'
                  : ''
            }
            aria-current={value === stage ? 'step' : undefined}
          >
            {index < stages.indexOf(stage) ? (
              <CheckCircle2 size={17} />
            ) : (
              <Circle size={17} />
            )}
            <span>{stageLabels[value]}</span>
          </li>
        ))}
      </ol>
      <div className="npi-stage-main">
        <div>
          <span className="npi-stage-kicker">
            当前阶段 · {stageLabels[stage]}
          </span>
          <h2>{guide.title}</h2>
          <p>{guide.detail}</p>
          <small>
            协同责任：{guide.role} · 技术 {technical} / 制造 {manufacturing}
          </small>
          {meta.actor.role === 'supervisor' && (
            <small>
              当前为主管视角：可调整计划，日期承诺与实际完成由责任人回复。
            </small>
          )}
        </div>
        <button className="npi-button" onClick={() => onTab(guide.tab)}>
          {guide.action}
          <ArrowUpRight size={16} />
        </button>
      </div>
      {stage !== 'completed' && (
        <div className="npi-stage-checks">
          <button onClick={() => onTab('bom')}>
            <span>BOM基线</span>
            <strong>
              {project.bomReviewCount
                ? `${project.bomReviewCount} 项待复核`
                : project.activeBomImportId
                  ? '已导入'
                  : '尚未导入'}
            </strong>
            <small>{project.untrackedBomCount} 项待复核分配</small>
          </button>
          <button onClick={() => onTab('manufacturing')}>
            <span>整机完成</span>
            <strong>
              {nodes.filter((i) => i.actualCompleteDate).length} /{' '}
              {nodes.length} 已完成
            </strong>
            <small>承诺与实际分别记录</small>
          </button>
          <button onClick={() => onTab('kit')}>
            <span>零部件与工装</span>
            <strong>
              {materials.filter((i) => !i.actualCompleteDate).length} 项未完成
            </strong>
            <small>{pending} 项待日期回复</small>
          </button>
          <button onClick={() => onTab('issues')}>
            <span>问题闭环</span>
            <strong>{project.openIssueCount} 项未关闭</strong>
            <small>
              {project.criticalIssueCount
                ? `${project.criticalIssueCount} 项重大问题`
                : '处理后仍需验证关闭'}
            </small>
          </button>
        </div>
      )}
      {stage === 'test' && (
        <p className="npi-stage-note">
          <AlertCircle size={16} />
          结项后项目只读。请核对未结问题、待复核任务及资料完整性；这些提醒不替代业务验收。
        </p>
      )}
    </section>
  )
}
