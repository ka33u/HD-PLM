import assert from 'node:assert/strict'
import test from 'node:test'
import { loginReturnTo, safeReturnTo } from '../src/lib/auth/return-to'
import { lifecycleKinds, submissionErrors } from '../src/lib/npi/lifecycle'
import { lifecyclePayload } from './helpers/lifecycle-fixture'

test('login preserves internal project targets and rejects external or ambiguous destinations', () => {
  const project = '/npi?view=projects&project=123&tab=overview'
  assert.equal(
    loginReturnTo({
      pathname: '/login',
      search: '?redirect=' + encodeURIComponent(project),
      hash: '',
    }),
    project,
  )
  assert.equal(
    loginReturnTo({
      pathname: '/npi',
      search: '?project=123&tab=history',
      hash: '',
    }),
    '/npi?project=123&tab=history',
  )
  for (const value of [
    '//evil.invalid',
    '/\\evil.invalid',
    'https://evil.invalid/npi',
    '/login',
    '/api/auth/me',
    '/npi/../login',
    '/npi\n',
    '/%2f%2fevil.invalid',
    '/npi/%2e%2e/login',
  ])
    assert.equal(safeReturnTo(value), '/npi')
})
test('all six stages accept minimal notes with optional attachments and no conclusion', () => {
  for (const kind of lifecycleKinds) {
    const r = {
      ...lifecyclePayload(kind),
      result: '',
      data: { fields: { summary: '现场进展已核实' }, measurements: [] },
    }
    assert.equal(submissionErrors(r, []).length, 0, kind)
    assert.equal(
      submissionErrors(r, [
        {
          category: 'report',
          conclusion: 'fail',
          archivedAt: null,
          mimeType: 'application/pdf',
        },
      ]).length,
      0,
      kind,
    )
    assert.equal(
      submissionErrors(
        { ...r, data: { fields: { summary: '' }, measurements: [] } },
        [],
      ).length,
      1,
    )
  }
})
