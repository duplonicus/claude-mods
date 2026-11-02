import { expect, mock, test, type TestBody } from 'claude-code/testing'

// Past the mod's wait for the box to empty (ENTER_SETTLE_MS, 1 s).
const SETTLED_MS = 2000

const PLUGIN = 'jump-to-prompts'
const DRAFT = 'run the tests'

// The engine beneath the mod: a prompt box holding DRAFT, and PowerShell's
// Enter landing in this box ('here'), in another window ('elsewhere', exit 0
// all the same), or here but too slowly, so the run times out ('late').
function world(on: Parameters<TestBody>[1], enter: 'here' | 'elsewhere' | 'late') {
  const box = { text: DRAFT }
  const sent: string[] = []
  const clock = mock.clock(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.text
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('process.run', () => {
    if (enter !== 'elsewhere') {
      sent.push(box.text)
      box.text = ''
    }
    if (enter === 'late') return { deny: 'timed out' }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { sent, clock }
}

const footer = { plugin: PLUGIN, component: 'SessionMode', requestId: 'modes', surface: 'terminal', props: { modes: [] } } as const

async function pressSend($: Parameters<TestBody>[0], clock: ReturnType<typeof mock.clock>) {
  const row = await $.ui.mount(footer)
  const pressed = $.ui.press({ plugin: PLUGIN, key: 'prompt-send' })
  await clock.advance(SETTLED_MS)
  await pressed
  await row.unmount()
}

test('↩: an Enter that lands here sends the draft once', async ($, on) => {
  const { sent, clock } = world(on, 'here')
  await pressSend($, clock)
  expect(sent).toEqual([DRAFT])
})

test('↩: an Enter that went to another window (PowerShell still exits 0) falls back to sending the draft', async ($, on) => {
  const { sent, clock } = world(on, 'elsewhere')
  await pressSend($, clock)
  expect(sent).toEqual([DRAFT])
})

test('↩: a PowerShell that fails after its Enter already sent the draft does not send it again', async ($, on) => {
  const { sent, clock } = world(on, 'late')
  await pressSend($, clock)
  expect(sent).toEqual([DRAFT])
})
