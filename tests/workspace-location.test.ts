// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  projectLocation,
  readWorkspaceLocation,
} from '../src/components/npi/workspace-location'

const projectId = '198b288e-2e07-4b60-9734-00b4fda0c60e'
const itemId = '2f2e0e7f-173d-4ecf-8bcc-27a4a421af40'
const read = (path: string) =>
  readWorkspaceLocation(new URL(path, 'https://plm.example.invalid'))

test('a shared project link retains the selected task and return module after reloading', () => {
  const link = projectLocation(projectId, 'kit', 'manufacturing', itemId)
  const route = read(link)
  assert.deepEqual(route, {
    view: 'manufacturing',
    projectId,
    itemId,
    tab: 'kit',
  })
  const regenerated = projectLocation(
    route.projectId!,
    route.tab,
    route.view!,
    route.itemId,
  )
  assert.deepEqual(read(regenerated), route)
  assert.equal(new URL(link, 'https://plm.example.invalid').pathname, '/npi')
})

test('corrupted or appended project identities never become a project request', () => {
  const invalid = [
    '',
    'not-a-project',
    projectId.slice(0, -1),
    projectId + '/bom',
    projectId + "' OR 1=1",
    '00000000-0000-0000-0000-000000000000',
    '198b288e-2e07-4b60-0734-00b4fda0c60e',
  ]
  for (const value of invalid) {
    const route = read(
      '/npi?' + new URLSearchParams({ project: value, item: value }),
    )
    assert.equal(route.projectId, null, value)
    assert.equal(route.itemId, undefined, value)
  }
  // A broken focus must not make an otherwise valid project inaccessible.
  assert.deepEqual(
    read(`/npi?project=${projectId}&item=removed-or-corrupt&tab=kit`),
    { view: null, projectId, itemId: undefined, tab: 'kit' },
  )
})

test('unknown tabs fall back to the overview while preserving the valid project', () => {
  for (const tab of [
    'removed-panel',
    '__proto__',
    'constructor',
    '<script>',
    '',
  ]) {
    const route = read(
      '/npi?' + new URLSearchParams({ project: projectId, tab }),
    )
    assert.equal(route.projectId, projectId)
    assert.equal(route.tab, 'overview', tab)
  }
  assert.equal(
    read(projectLocation(projectId, 'outdated-tab', 'projects')).tab,
    'overview',
  )
})

test('unknown and inherited object names cannot select workspace modules', () => {
  for (const view of [
    'unknown',
    'project',
    '__proto__',
    'constructor',
    'toString',
  ])
    assert.equal(read('/npi?' + new URLSearchParams({ view })).view, null, view)
  // Module parsing must preserve a valid module; authorization is handled separately.
  assert.equal(read('/npi?view=settings').view, 'settings')
})

test('the dedicated recycle-bin address takes precedence over stale view parameters', () => {
  assert.deepEqual(read('/npi/trash?view=dashboard'), {
    view: 'trash',
    projectId: null,
    itemId: undefined,
    tab: 'overview',
  })
  assert.equal(read('/npi/trash?view=__proto__').view, 'trash')
})

test('ordinary module navigation does not invent a project or retain a focus', () => {
  assert.deepEqual(read('/npi'), {
    view: null,
    projectId: null,
    itemId: undefined,
    tab: 'overview',
  })
  const route = read(projectLocation(projectId, 'files', 'bom'))
  assert.equal(route.itemId, undefined)
  assert.equal(route.tab, 'files')
  assert.equal(route.view, 'bom')
})
