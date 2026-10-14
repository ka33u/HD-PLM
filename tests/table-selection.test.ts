import test from 'node:test'
import assert from 'node:assert/strict'
import { selectRange } from '../src/components/npi/table-selection'
test('range selection follows visible order and preserves other-page selections', () => {
  assert.deepEqual(
    selectRange(['elsewhere'], ['a', 'c', 'd', 'e'], 'e', true, 'c', true, 50),
    ['elsewhere', 'c', 'd', 'e'],
  )
  assert.deepEqual(
    selectRange([], ['a', 'c', 'd', 'e'], 'a', true, 'd', true, 50),
    ['a', 'c', 'd'],
  )
})
test('range deselection removes only the eligible visible interval', () => {
  assert.deepEqual(
    selectRange(
      ['outside', 'a', 'b', 'c', 'd'],
      ['a', 'b', 'c', 'd'],
      'b',
      false,
      'd',
      true,
      50,
    ),
    ['outside', 'a'],
  )
})
test('a filtered or off-page anchor selects only the clicked item and enforces the cap', () => {
  assert.deepEqual(
    selectRange(['outside'], ['b', 'c'], 'c', true, 'a', true, 50),
    ['outside', 'c'],
  )
  assert.deepEqual(
    selectRange(['outside'], ['a', 'b', 'c'], 'c', true, 'a', true, 3),
    ['outside', 'a', 'b'],
  )
  assert.deepEqual(selectRange(['a'], ['a'], 'missing', true, 'a', true, 50), [
    'a',
  ])
})
