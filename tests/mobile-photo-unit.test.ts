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
test('all six stages require an active evidence image; reports and archived photos cannot substitute', () => {
  const pdf = {
    category: 'report',
    conclusion: 'pass',
    archivedAt: null,
    mimeType: 'application/pdf',
  }
  const image = {
    category: 'evidence',
    conclusion: '',
    archivedAt: null,
    mimeType: 'image/jpeg',
  }
  for (const kind of lifecycleKinds) {
    const r = lifecyclePayload(kind)
    assert(submissionErrors(r, [pdf]).some((e) => e.includes('照片')))
    assert(
      submissionErrors(r, [pdf, { ...image, archivedAt: new Date() }]).some(
        (e) => e.includes('照片'),
      ),
    )
    assert(
      submissionErrors(r, [pdf, { ...image, category: 'report' }]).some((e) =>
        e.includes('照片'),
      ),
    )
    assert.equal(submissionErrors(r, [pdf, image]).length, 0, kind)
  }
  const trial = lifecyclePayload('trial', 'not_applicable')
  trial.data.fields.waiverReason = '合同明确不需要试用'
  trial.data.fields.customerConfirmation = '客户确认记录'
  assert.equal(submissionErrors(trial, [pdf]).length, 0)
  assert(submissionErrors(trial, []).some((e) => e.includes('依据')))
})
