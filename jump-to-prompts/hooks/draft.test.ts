import { expect, test } from 'claude-code/testing'

import { commandOf, heldBack } from './draft'

test('a paste or image placeholder holds the draft back; plain text and brackets do not', () => {
  expect(heldBack('[Pasted text #1 +31 lines]')).toBeDefined()
  expect(heldBack('look at this [Pasted text #2] please')).toBeDefined()
  expect(heldBack('what is in [Image #1]?')).toBeDefined()
  expect(heldBack('fix the bug in rows.ts')).toBeUndefined()
  expect(heldBack('arrays like [1, 2] and [Image] links')).toBeUndefined()
})

test('a draft starting with a slash command splits into name and args; a path does not', () => {
  expect(commandOf('/cost')).toEqual({ command: 'cost', args: '' })
  expect(commandOf('  /effort high \n')).toEqual({ command: 'effort', args: 'high' })
  expect(commandOf('/review fix the\nlast bit')).toEqual({ command: 'review', args: 'fix the\nlast bit' })
  expect(commandOf('/home/me/x is missing')).toBeUndefined()
  expect(commandOf('what does /cost do')).toBeUndefined()
})
