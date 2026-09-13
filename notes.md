# Notes

## Done

- **Bridge crate** (`bridge` equipment kind, `rules.bridgeCharges` / `bridgeExclusive`): a troop
  with planks lays a permanent plank over a gap (drop of two or more) and walks on — `nextStep`
  action `bridge`, `Troop` case `bridge`, budgets in the blank level, the tutorial and the siege
  generator (one per trench), reachability in `scripts/level-validate.mjs`.
- **Pausable builders**: right-click / shift-click a troop with a role pauses it (it keeps its
  planks); another right-click, or the Builder tool at no cost, resumes it with a fresh staircase
  (`Troop.suspendRole/resumeRole`, `Simulation.toggleRole`, role hook `resume` / `progress`).
- **Enemy speed and size**: `rules.enemyTroopSpeed`, `rules.enemyTroopScale` (instance scale in
  the renderer); exposed in the designer's Rules tab like every other rule.
- **Mud tiles**: voxel `mud` (solid, diggable, `slow`); a step onto a mud-floored cell runs at
  `rules.mudSpeed` (`Simulation.moveSpeed`, used by troops and fan/funnel steps); editor voxel
  tool, siege "mud flat" segment.
- **Spec / schema / prompts** updated: `level.d.ts`, `docs/level-builder-guide.md`,
  `docs/generators.md`, `levels/render.op.md`, README.
- **Level ideas**: twelve drafts in `docs/level-ideas.md` (not implemented).
- **Maze generator** (`src/world/generators/maze.js`): perfect maze with two-high walls, trapped
  dead ends (spikes / pits), mud on the route, enemy patrols programmed with enemy arrow signs,
  wall-top turrets and sentries; parameters seed, cells, corridor, difficulty, mud + auto counts.

## Open

- a bridge could also span a one-cell chasm sideways (currently only straight ahead)
- siege: a "swamp" segment mixing mud and spikes