/**
 * Sides in a level. Troops, signs, crates and drop pods belong to a team; guards are always on
 * the enemy side. Signs and crates only ever affect troops of their own team, so a level designer
 * can lay out an enemy "plan" next to the player's toolkit without the two interfering.
 */
export const TEAM = Object.freeze({ PLAYER: 'player', ENEMY: 'enemy' });

export const TEAM_LABELS = Object.freeze({ player: 'Player', enemy: 'Enemy' });

/** Base body colours for troops of each team. */
export const TEAM_COLORS = Object.freeze({ player: 0x5fcf6a, enemy: 0xd2553c });

export function normalizeTeam(t) {
  return t === TEAM.ENEMY ? TEAM.ENEMY : TEAM.PLAYER;
}

export function otherTeam(t) {
  return t === TEAM.ENEMY ? TEAM.PLAYER : TEAM.ENEMY;
}
