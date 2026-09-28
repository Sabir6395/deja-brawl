// Single source of truth for every tunable number (PRD §3.2, §4.2).
// UMD: require('./shared/config') in Node, global CONFIG in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CONFIG = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return Object.freeze({
    // §3.2 constants
    ARENA_W: 1600,
    ARENA_H: 900,
    TICK_RATE: 20,              // Hz
    LOOP_SECONDS: 12,
    LOOPS_PER_MATCH: 6,
    INTERMISSION_SECONDS: 3,
    PLAYER_RADIUS: 14,
    GHOST_RADIUS: 11,
    PLAYER_SPEED: 280,          // px/s
    SPAWN_SHIELD_SECONDS: 1.0,
    COINS_ON_FIELD: 5,
    MAX_PLAYERS: 6,

    // Lobby (§1 header, Phase 1)
    MIN_PLAYERS: 2,
    NAME_MAX_LENGTH: 12,

    // Numbers stated elsewhere in the PRD (§3.1, §3.5, §3.7, §3.8, §5.2)
    COUNTDOWN_SECONDS: 3,
    SPAWN_RING_RADIUS: 320,
    COIN_RADIUS: 10,
    COIN_MIN_PLAYER_DIST: 60,
    COIN_EDGE_MARGIN: 40,       // coins never spawn closer than this to a wall
    LAST_ALIVE_END_DELAY_SECONDS: 1,
    TELEGRAPH_SECONDS: 1.0,
    RENDER_DELAY_MS: 100,
    MAX_CATCHUP_TICKS: 5,       // server: max ticks simulated at once after a stall

    // §3.7 scoring
    POINTS_COIN: 1,
    POINTS_HAUNT: 3,
    POINTS_SURVIVE: 2,
    POINTS_LAST_ALIVE: 3,

    // §4.2 visuals — player colors by seat: cyan, magenta, lime, amber, violet, coral
    BG_COLOR: '#0b0d17',
    PLAYER_COLORS: ['#00e5ff', '#ff2bd6', '#a3ff12', '#ffb000', '#9d6bff', '#ff6b5e'],
    GHOST_ALPHA: 0.45,
    GHOST_AGE_FADE: 0.15,       // alpha lost per extra loop of ghost age
    GHOST_MIN_FADE: 0.35,       // oldest ghosts keep at least this fraction of GHOST_ALPHA
    GHOST_TRAIL_TICKS: 6,       // short fading trail behind each ghost
    SHIELD_BLINK_MS: 100,
    GRID_SIZE: 50,              // arena px between grid lines
    KILL_FEED_SECONDS: 4,
    KILL_FEED_MAX_LINES: 5,
    POPUP_SECONDS: 1.2,         // floating "+1" / "+3 HAUNT" text

    // §4.2–§4.3 juice
    DEATH_PARTICLES: 28,
    SHAKE_MS: 150,              // local player only
    SHAKE_PX: 8,
    TENSION_FROM_LOOP: 5,       // timer bar pulses red from this loop on
    MASTER_VOLUME: 0.6,

    // §3.3 touch joystick (CSS px)
    JOYSTICK_RADIUS: 60,
    JOYSTICK_DEADZONE: 12,
  });
});
