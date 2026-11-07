// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NpiMetadata, ProjectDetail } from '../../lib/npi/service'
export const dateGap = (actual: string | null, required: string) =>
  actual
    ? Math.round((Date.parse(actual) - Date.parse(required)) / 86400000)
    : null
export function NpiProjectOverview({
  project,
  meta,
  onEdit,
}: {
  project: ProjectDetail
  meta: NpiMetadata
  onEdit?: () => void
  api: <T>(path: string, method?: string, data?: unknown) => Promise<T>
  onTab: (tab: string) => void
  onLocate: (id: string, type: 'manufacturing_node' | 'tracking_item') => void
}) {
  const latest = project.imports.find((i) => i.id === project.activeBomImportId)
  const owner = (id: string) =>
    meta.users.find((u) => u.id === id)?.name || '未命名'
  return (
    <section className="npi-panel" aria-label="项目信息">
      <div className="npi-panel-title">
        <h2>项目信息</h2>
        {onEdit && (
          <button
            className="npi-project-link"
            onClick={onEdit}
            aria-label="编辑概览项目信息"
          >
            编辑
          </button>
        )}
      </div>
      <dl className="npi-info-grid">
        {[
          ['项目编号', project.code],
          ['电机型号', project.motorModel],
          ['电机类型', project.profile.motorType || '未分类'],
          [
            '订单台数',
            project.profile.orderQuantity
              ? `${project.profile.orderQuantity} 台`
              : '未填写',
          ],
          ...(!project.profile.motorType ? [['历史名称', project.name]] : []),
          ['电机编码', project.profile.motorCode || '未填写'],
          ['客户', project.profile.customer || '未填写'],
          ['用途 / 应用场景', project.profile.application || '未填写'],
          [
            '额定功率',
            project.profile.ratedPowerKw
              ? `${project.profile.ratedPowerKw} kW`
              : '未填写',
          ],
          [
            '额定电压',
            project.profile.ratedVoltageV
              ? `${project.profile.ratedVoltageV} V`
              : '未填写',
          ],
          ['极数', project.profile.poles || '未填写'],
          ['创建人', project.createdBy ? owner(project.createdBy) : '未记录'],
          [
            '创建日期',
            new Date(project.createdAt).toLocaleDateString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            }),
          ],
          ['技术负责人', owner(project.technicalOwnerId)],
          ['制造负责人', owner(project.manufacturingOwnerId)],
          ['要求齐套日期', project.requiredKitDate],
          [
            '整机承诺完成',
            project.kit.manufacturingCommittedKitDate || '待回复',
          ],
          [
            '当前BOM版本',
            latest
              ? `V${latest.versionNo} · ${latest.rowCount} 项`
              : '尚未导入',
          ],
          ['未关闭问题', `${project.openIssueCount} 个`],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
