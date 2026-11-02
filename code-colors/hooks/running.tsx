import type { ClientModule } from 'claude-code'

import { glyphAt, isLit, shimmerAt, SHIMMER_COLOR, SPINNER_COLOR, TICK_MS } from './spinner'

/** A piece of the command, in its palette color. */
export type Part = { text: string; color?: string }
export type RunningProps = { glyphs: string[]; name: string; parts: Part[] }

/**
 * A running Bash row's header, drawn on the terminal's own clock: the bullet
 * turns like the spinner's glyph, and `Bash(` `)` shimmer like the spinner's
 * word while the command between keeps its colors. Only this region redraws on
 * a tick, never the transcript's rows.
 */
const Running: ClientModule<RunningProps, { ms: number }> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ ms: 0 })
    surface.every(TICK_MS, () => surface.setState({ ms: (surface.state?.ms ?? 0) + TICK_MS }))
  }
  const ms = surface.state?.ms ?? 0
  // The shimmer runs over the name and both brackets as one word.
  const word = `${props.name}()`
  const middle = shimmerAt(ms, word.length)
  const lit = (index: number) => <Text color={isLit(index, middle) ? SHIMMER_COLOR : SPINNER_COLOR}>{word[index]}</Text>
  const name = [...props.name].map((_, i) => lit(i))
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={SPINNER_COLOR}>{glyphAt(ms, props.glyphs)}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        <Text>
          <Text bold>{name}</Text>
          {lit(word.length - 2)}
          {props.parts.map(part => (part.color ? <Text color={part.color}>{part.text}</Text> : part.text))}
          {lit(word.length - 1)}
        </Text>
      </Box>
    </Box>
  )
}

export default Running
