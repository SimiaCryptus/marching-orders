Implemented (see README):

* signs — the confusing turn signs are gone: an **Arrow** sign sends every soldier that steps
  on it the way it points (old `turn` / `turnLeft` / `turnRight` levels load as arrows). Placing
  any sign shows a ghost with a ground graphic for the chosen orientation — an arrow, side entries
  for the forward sign, a funnel for the fan sign — and placed signs keep the graphic.
* parametric builder — player troops, enemy pods, troops per pod, keep guards and enemy rifle
  crates are now parameters (auto-derived from difficulty / length unless typed in the designer;
  "Auto counts" hands them back). Segments are wider, the runway and keep bigger, corridors deeper
  and the campaign scales up accordingly.
* rules — per-level tunables (troop / enemy troop / guard hit points, pickaxe and ladder charges,
  rifle range and damage, crate capacity, guard damage and range scaling) in `rules.js`, editable
  in the designer's Rules section and saved with the level.

Ideas:

* let the generator drop a few player crates / signs as hints on low difficulties
* enemy pods with their own sign plans in generated levels