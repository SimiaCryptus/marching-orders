---
transforms: (.*)\.idea\.md -> $1.json
---

Based on [level-builder-guide.md](../docs/level-builder-guide.md) and [level.d.ts](../src/world/level.d.ts) design a level for this idea.

Emit one strict `LevelInput` JSON object: no properties outside `level.d.ts`, modern sign kinds
(`blocker`, `arrow`, `fan`, `forward`), terrain as `fills` (never `voxels`), axis-aligned facings.
The current toolkit is: crates `rifle`, `pickaxe`, `ladder`, `bridge` (planks across gaps),
`medic`, `grenade`, `armor`, `parachute`; the `builder` role (pausable with a right-click, so its
12 planks can be split between obstacles); voxels including `mud` (a step onto it runs at
`rules.mudSpeed`) and `spikes`; enemy pods whose columns follow _enemy_ signs and crates
(`rules.enemyTroopHp`, `enemyTroopSpeed`, `enemyTroopScale`). Derive the budget from the
obstacles and hostiles you actually place (guide §7), name them in `description`, and keep the
vault reachable with the tools handed out.

Then check the result with `node scripts/level-tool.mjs <file>` and fix every error it reports
(entities in supported air cells, no shared cells, standable objective, reachability).
