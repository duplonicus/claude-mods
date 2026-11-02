import { expect, test } from 'claude-code/testing'

import { flow, hueColor, ThoughtMeter } from './thinking'

test('the thinking speed is characters a second over the last 1.5 s, per agent', () => {
  const meter = new ThoughtMeter()
  meter.add('main', 300, 1000)
  meter.add('main', 300, 2000)
  meter.add('agent-1', 900, 2000)
  expect(meter.rate('main', 2000)).toBe(400)
  expect(meter.rate('main', 3000)).toBe(200) // the first arrival is past the window
  expect(meter.rate('main', 4000)).toBe(0)
  expect(meter.rate('agent-1', 2000)).toBe(600)
  expect(meter.has('agent-2')).toBe(false)
})

test('the rainbow crawls with nothing streaming, flows with the speed, and is capped', () => {
  expect(flow(0)).toBe(40)
  expect(flow(400)).toBe(360)
  expect(flow(10_000)).toBe(720)
})

test('hues are the engine rainbow\'s saturation and lightness, wrapping both ways', () => {
  expect(hueColor(0)).toBe('rgb(224,82,82)')
  expect(hueColor(120)).toBe('rgb(82,224,82)')
  expect(hueColor(240)).toBe('rgb(82,82,224)')
  expect(hueColor(-120)).toBe(hueColor(240))
  expect(hueColor(480)).toBe(hueColor(120))
})
