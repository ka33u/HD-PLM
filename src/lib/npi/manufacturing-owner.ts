// SPDX-License-Identifier: AGPL-3.0-or-later
export function isManufacturingOwner(person: {
  active?: boolean
  role?: string | null
  departmentId?: string | null
  departmentRole?: string | null
}) {
  return (
    person.active !== false &&
    person.role === 'manufacturing' &&
    !!person.departmentId &&
    person.departmentRole === 'manufacturing'
  )
}

export const manufacturingOwnerHint =
  '制造负责人仅限制造类部门的已启用生产岗位成员，管理员不可担任。'
