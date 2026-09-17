# Marching Orders — Notes

## Recent changes
- Added a persistent "← Home" link (top-left, above the HUD) on `index.html`
  that links back to the site root (`/`). Implemented as a plain anchor
  positioned fixed at `top: 12px; left: 12px;` with a z-index above the
  `#app` canvas and `#hud` overlay so it remains clickable in both play
  and level-editor modes.
- The link uses inline styling consistent with the existing `.panel` look
  (dark translucent background, subtle border, rounded corners) to match
  the HUD aesthetic without requiring changes to the shared stylesheet
  rules.

## Implementation details
- Placed the link markup directly after `#hud` and before `#editor` in the
  DOM so it renders above the game canvas but doesn't interfere with the
  `#hud` or `#editor` pointer-event containers (both of which use
  `pointer-events: none` at the container level with children opting back
  in).
- No JavaScript changes were required; this is a static navigational
  element independent of `src/main.js`.

## Potential impacts
- None expected on game logic, HUD, or the level editor since the link is
  an isolated, absolutely/fixed-positioned element with its own z-index.
- Verify the link doesn't visually overlap `#hud-top` stats panel on very
  small viewports; if needed, adjust `top`/`left` offsets or move the
  home link to avoid collision with `#hud-top`.

## Follow-up
- Consider extracting shared "Home" link styling into the main stylesheet
  if other games in the project adopt the same navigation pattern.