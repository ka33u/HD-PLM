// SPDX-License-Identifier: AGPL-3.0-or-later
import { moduleInfo } from './navigation'
import type { ModuleId } from './navigation'
export const projectTabs = [
  'overview',
  'manufacturing',
  'kit',
  'bom',
  'issues',
  'files',
  'history',
] as const
export type ProjectTab = (typeof projectTabs)[number]
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function readWorkspaceLocation(
  location: Pick<Location, 'pathname' | 'search'>,
) {
  const params = new URLSearchParams(location.search),
    view = params.get('view')
  const project = params.get('project'),
    item = params.get('item'),
    tab = params.get('tab')
  return {
    view:
      location.pathname === '/npi/trash'
        ? ('trash' as const)
        : view && Object.hasOwn(moduleInfo, view)
          ? (view as ModuleId)
          : null,
    projectId: project && uuid.test(project) ? project : null,
    itemId: item && uuid.test(item) ? item : undefined,
    tab: projectTabs.includes(tab as ProjectTab)
      ? (tab as ProjectTab)
      : ('overview' as const),
  }
}
export function projectLocation(
  projectId: string,
  tab: string,
  view: ModuleId,
  itemId?: string | null,
) {
  const params = new URLSearchParams({
    view,
    project: projectId,
    tab: projectTabs.includes(tab as ProjectTab) ? tab : 'overview',
  })
  if (itemId) params.set('item', itemId)
  return '/npi?' + params
}
