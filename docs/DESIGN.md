# Console design

The console is a run log, not a chat thread. Deep-water ink at night, warm
paper by day, one ember accent. The CLI and the web share the same semantic
colours, so the console looks like the terminal it drives.

## Rules

1. **Structure is hairlines and alignment.** No card shadows, no gradients;
   dialogs and popovers are the only lifted surfaces.
2. **One rail per transcript.** Ordinal in the gutter, a 1px trace, a node per
   turn. No avatars, no message bubbles. A prompt is a command block marked by
   a 2px ember rule.
3. **Mono for anything machine-made:** paths, commands, model ids, counts,
   cost, ordinals, durations. Sans is for prose only.
4. **Ember is rationed** to the current session bar, focus, links, the send
   key and the brand fin. Everything else is ink on paper.
5. **Three weights:** 400 prose, 500 emphasis, 600 titles. Body 14px/1.7;
   prose measure 760px.
6. **Header is 40px:** title, spend, model, status, one overflow menu. Views
   are destinations in that menu, never four equal tabs. A back arrow returns
   to the conversation.
7. **Home is an eyebrow, one line, the composer, one way back.** No feature
   copy, no suggestion cards.
8. **Motion is state only** (stream cursor, tool spinner, running pulse), at
   120/200/300ms, and none under `prefers-reduced-motion`.

## Tokens

- Semantic colours live in `src/design/tokens.ts` and feed both the TUI themes
  and the web stylesheet; every foreground keeps text contrast ≥ 4.5:1.
- Surfaces, the trace rail, the type scale and radii are `:root` variables in
  `src/web/frontend/styles.css`; the web derives its surfaces as tints of the
  same ink/paper ground.
- Alternate TUI themes (`claude`, `minimal`, `nord`) keep their own palettes;
  `claude` uses ANSI names and is the documented exception in the contrast
  sweep.

## What this replaces

The earlier console was a cool-neutral chat surface with four tab destinations.
Palette swaps could not fix it because the composition — chat bubbles, a
repeating avatar, a control-dense toolbar over an empty canvas — carried no
product point of view. The log, the gutter and the single accent are that point
of view; keep them when adding features, or the console drifts back to a
generic chat client.
