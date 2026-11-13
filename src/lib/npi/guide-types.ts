// SPDX-License-Identifier: AGPL-3.0-or-later
export type SopGuide = {
  id: string
  title: string
  department: string
  role: string
  description: string
  edition: string
  appliesTo: string
  pages: Array<{ title: string; text: string }>
}
export type GuideCatalog = { guides: SopGuide[] }
