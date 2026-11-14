export const departmentCategories = {
  technical: '设计 / 技术',
  manufacturing: '生产 / 制造',
  procurement: '采购',
  quality: '质量',
} as const
export type DepartmentCategory = keyof typeof departmentCategories
export type RegistrationDepartment = {
  id: string
  name: string
  role: DepartmentCategory
}
