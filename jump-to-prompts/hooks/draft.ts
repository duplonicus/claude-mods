// The prompt box shows a big paste or an image as a placeholder, and a
// plugin's submit sends the box's text as it reads: the placeholder, never
// what it stands for (seen live: the model got "[Pasted text #1 +31 lines]").
const PLACEHOLDER = /\[(Pasted text|Image|Pasted image) #\d+[^\]]*\]/

/** Why ↩ leaves this draft for Enter, or undefined when ↩ can send it. */
export const heldBack = (text: string): string | undefined =>
  PLACEHOLDER.test(text) ? 'a paste or image in the box only goes through Enter' : undefined

// A plugin's submit refuses text that starts with "/" (seen live: HooksError,
// "a text beginning…"); a slash command goes through $.command.run instead.
const COMMAND = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/

/** The slash command a draft runs, as `$.command.run` takes it, or undefined. */
export const commandOf = (text: string): { command: string; args: string } | undefined => {
  const match = COMMAND.exec(text.trim())
  return match ? { command: match[1]!, args: match[2]?.trim() ?? '' } : undefined
}
