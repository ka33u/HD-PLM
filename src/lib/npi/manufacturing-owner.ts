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
    // Admin-created and legacy manufacturing accounts may not have a sharing
    // group yet. Their business role is sufficient; a conflicting group is not.
    (!person.departmentId || person.departmentRole === 'manufacturing')
  )
}

export const manufacturingOwnerHint =
  '制造负责人仅限已启用的生产／制造岗位账号，管理员不可担任；部门协作分组不影响未分组制造账号的选择。'
