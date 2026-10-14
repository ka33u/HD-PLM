// SPDX-License-Identifier: AGPL-3.0-or-later
export interface TrackingBomReference {
  materialCode: string
  versionNo: number
  rowNo: number
  current: boolean
}

export function bomReferenceLabel(reference: TrackingBomReference) {
  return `ERP BOM V${reference.versionNo} · 原表第${reference.rowNo}行 · ${reference.current ? '当前版本' : '历史版本'}`
}

type CodedTask = {
  sourceType?: string
  motorCode?: string
  bomReference?: TrackingBomReference | null
}

// Whole-machine identity comes from the project; ERP parts retain their BOM code.
export function trackingMaterialCode(item?: CodedTask) {
  return item?.sourceType === 'WHOLE_MACHINE'
    ? item.motorCode || ''
    : item?.bomReference?.materialCode || ''
}

export function trackingIdentity(
  item: {
    name: string
  } & CodedTask,
) {
  return item.bomReference
    ? `${item.name} · ${item.bomReference.materialCode} · ${bomReferenceLabel(item.bomReference)}`
    : [item.name, trackingMaterialCode(item)].filter(Boolean).join(' · ')
}
