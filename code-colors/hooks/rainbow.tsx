import type { ClientModule } from 'claude-code'

import { TICK_MS } from './spinner'
import { flow, HUE_SPREAD, hueColor } from './thinking'

export type RainbowProps = { word: string; rate: number }

/**
 * The spinner's word as a rainbow, laid over the engine's own word while
 * Claude is thinking. Each tick it moves the hues on by the thinking speed and
 * asks the hooks for a fresh one (`post`, answered with new props), so nothing
 * but this region redraws.
 */
const Rainbow: ClientModule<RainbowProps, { hue: number; live: { rate: number } }> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    // The tick reads the latest rate from `live`: its closure would keep the first props.
    const live = { rate: props.rate }
    surface.setState({ hue: 0, live })
    surface.every(TICK_MS, () => {
      surface.post({ tick: true })
      surface.setState({ hue: (surface.state?.hue ?? 0) + (flow(live.rate) * TICK_MS) / 1000, live })
    })
  } else {
    surface.state.live.rate = props.rate
  }
  const hue = surface.state?.hue ?? 0
  return (
    <Text>
      {[...props.word].map((char, i) => (
        <Text color={hueColor(hue - i * HUE_SPREAD)}>{char}</Text>
      ))}
    </Text>
  )
}

export default Rainbow
