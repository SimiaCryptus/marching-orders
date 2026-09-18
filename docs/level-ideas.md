# Level ideas (drafts — not implemented)

Twelve hand-authored level concepts for later, each sized for the house layout (lane at
`y = 3`) and written against the current toolkit: crates (rifle, pickaxe, ladder, bridge, medic,
grenade, armor, parachute), signs (blocker, arrow, fan, forward), the pausable builder, mud,
spikes, enemy pods with their own signs/crates, and the `maze` / `siege` / `arena` generators as
starting points. Nothing here has JSON yet; `levels/*.idea.md` + `render.op.md` is the route to
turn one into a level.

| #   | Name                     | Core lesson                                       | Size     |
| --- | ------------------------ | ------------------------------------------------- | -------- |
| 1   | Plank Bridge             | bridge crate over a trench too wide to build      | 36×12×12 |
| 2   | Two Bridges, One Builder | pausing / resuming the builder                    | 40×14×12 |
| 3   | The Bog                  | mud + turret timing, armor & medic                | 44×12×16 |
| 4   | Switchback               | fan / funnel to swap lanes around spikes          | 40×12×14 |
| 5   | Crossfire Yard           | two enemy pods with programmed enemy signs        | 40×12×20 |
| 6   | Parachute Drop           | vertical level, lethal fall as the puzzle         | 24×24×12 |
| 7   | Grenadier's Nest         | player grenades against a bunched garrison        | 40×14×14 |
| 8   | The Enemy Plan           | reading enemy signs to sabotage a patrol loop     | 42×12×18 |
| 9   | Pickaxe Economy          | exactly enough charges, dirt vs stone             | 44×12×12 |
| 10  | Tower of Ledges          | stepUp/stepDown geometry, ladder charges          | 30×20×12 |
| 11  | Split Column             | fan + blockers to run two detachments at once     | 44×12×18 |
| 12  | Mud Maze                 | maze generator output, hand-tuned patrols and mud | 41×8×41  |

## 1. Plank Bridge

A single 3-cell-wide trench (`air` y=1..2, x=14..16) cuts the yard; its floor is `spikes`, so
dropping in kills. A bridge crate (4 planks) sits on the lane at x=10. The column planks across
one cell at a time; the twist is a second, 1-cell gap at x=24 that the leftover plank must
cover. Budget: `bridge: 0` (the crate is the only kit), `arrow: 2`, `blocker: 1`. Teaches that
planks are permanent and shared by the whole column. Guards: none. Required 8 of 15.

## 2. Two Bridges, One Builder

Two 2-high dirt walls (x=12 and x=26) with a `stone` cap so pickaxes are useless; `budget.roles
= { builder: 1 }`, no ladders. One builder has 12 planks: a stair over a 2-high wall needs 3–4.
The intended solution is to pause the builder right after it tops the first wall (right-click),
let it march to the second wall, and resume it there. A sentry at the vault gate makes the
rifle crate on the lane matter. Required 6 of 14.

## 3. The Bog

The whole middle third of the yard (x=14..28) is `mud`; a turret on a stone pillar at x=21
covers it with LOS both ways. On mud the column crawls at half speed, so an unarmoured column
is shot to pieces. Tools: one armor crate (stackable), one medic crate, one rifle crate — rifles
to return fire from the edge of range, armor for the crossing, medic behind. `rules.mudSpeed
= 0.4`, `guardRangeScale = 1.1`. Required 7 of 20.

## 4. Switchback

Three spike rows at x=12, 18, 24 with gaps at z=2, z=11, z=6 in a corridor 14 deep — the gaps
alternate sides, so the column must zig-zag. Only `arrow: 2`, `forward: 2`, `fan: 1` are in the
budget: the fan's funnel (approach from behind it) is the cheap way to gather the three lanes
back onto one before the last gap. Required 10 of 20; no guards, no time limit — a pure
steering puzzle.

## 5. Crossfire Yard

An open yard 20 deep with two enemy pods on opposite walls at x=16 and x=24, each with an
_enemy_ `forward` sign one cell in front of it and an enemy `arrow` on the far side pointing
back, so both columns patrol north–south lanes for the whole level. The player has `blocker:
3` and `rifle: 2` — either hold the column with blockers while a patrol passes, or arm it and
push through. Enemy rifle crates (`team: "enemy"`, capacity 2) at difficulty > 6. Required
8 of 24.

## 6. Parachute Drop

A tall level (`h = 24`): the pod sits on a plateau at y=18, the vault at y=3. Every ledge down
is 5 or 6 cells — over `lethalFall = 4`. A parachute crate (stackable) is on the plateau lane;
each parachute has 3 charges and there are 4 drops, so the column has to find the one ledge
that can be laddered instead, or take one intended fatal drop to reach a second crate. Required
5 of 12.

## 7. Grenadier's Nest

A stone keep whose courtyard holds three sentries shoulder to shoulder and a grenadier behind
them. Rifles alone lose the DPS race; the grenade crate (3 grenades, splash 1.5) at the gate
approach lets the first troops through lob at the bunch from 2–6 cells. A `forward` sign is
needed to keep the column out of the grenadier's minimum range until the throwers have fired.
`rules.grenadeCharges = 4`. Required 6 of 20.

## 8. The Enemy Plan

The level ships with a visible enemy patrol loop: an enemy pod, two enemy `arrow` signs and an
enemy `blocker` that together make the enemy column march a rectangle around the vault. Player
signs cannot move enemy signs — but a **player** blocker placed on the enemy lane does nothing
to the enemy, while a rifle detachment parked at the loop's corner (arrow + forward) does. The
puzzle is reading the loop and picking the ambush corner. Required 7 of 22.

## 9. Pickaxe Economy

Four dirt walls of thickness 2, 3, 2 and 3 (10 voxels of dirt on the lane) and a single pickaxe
crate with `rules.pickaxeCharges = 8`. Two of the walls have a `stone` core except for a 1-wide
dirt seam at z=mid+2; the arrow budget (`arrow: 2`) is exactly what it takes to route the
digger onto the seam and back. `ladder: 1` in the budget is the safety valve. Required 8 of 18.

## 10. Tower of Ledges

A stair-stepped tower where every ledge is exactly 1 high (free stepUp) except two that are 2
high — one ladder kit (3 segments) covers both only if the player places the crate _after_ the
first ledge so the second climb still has a charge. Falling off the far side is 3 cells
(survivable); a `blocker` stops the column from walking straight off. A turret on the summit
watches the last flight. Required 6 of 16.

## 11. Split Column

A `fan` sign at the lane's first junction splits the column into three lanes; `blocker: 2`
turns the outer two back into the middle after a set distance, so the player can run a
"detachment" through a rifle crate off the lane and then merge. The vault has two gates
(z=4 and z=9) each held by a sentry; the enemy pod crosses between them. `arrow: 3`, `fan: 1`,
`blocker: 2`, `forward: 1`, `rifle: 1`. Required 9 of 24.

## 12. Mud Maze

Take `buildLevel('maze', { seed: 7, cells: 9, corridor: 2, difficulty: 6, mud: 40 })`, load it
into the designer and hand-tune: replace two spike dead ends with pits floored by a `bridge`
crate reward, add a second player rifle crate on the longest mud stretch, and move one enemy
patrol's arrow so the patrol lane overlaps the mud (`enemyTroopSpeed = 3` makes the patrol
faster than the bogged-down column). Keep `arrow = turns + 1` to force careful routing.
Required 10 of 38.
