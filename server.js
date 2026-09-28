const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const CONFIG = require('./shared/config');

const app = express();
app.get('/health', (req, res) => res.status(200).type('text/plain').send('ok'));
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });

const TICK_MS = 1000 / CONFIG.TICK_RATE;
const LOOP_TICKS = Math.round(CONFIG.LOOP_SECONDS * CONFIG.TICK_RATE);
const INTERMISSION_TICKS = Math.round(CONFIG.INTERMISSION_SECONDS * CONFIG.TICK_RATE);
const SHIELD_TICKS = Math.round(CONFIG.SPAWN_SHIELD_SECONDS * CONFIG.TICK_RATE);
const LAST_ALIVE_DELAY_TICKS = Math.round(CONFIG.LAST_ALIVE_END_DELAY_SECONDS * CONFIG.TICK_RATE);
const HIT_DIST = CONFIG.PLAYER_RADIUS + CONFIG.GHOST_RADIUS;
const COIN_DIST = CONFIG.PLAYER_RADIUS + CONFIG.COIN_RADIUS;

// ---------------------------------------------------------------------------
// Room manager (§5.3)
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O
const rooms = new Map();         // code -> Room
const roomOfSocket = new Map();  // socket.id -> code
let joinCounter = 0;             // global join order, used for host migration

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  if (typeof name !== 'string') return { error: 'Enter a name' };
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { error: 'Enter a name' };
  if (trimmed.length > CONFIG.NAME_MAX_LENGTH) {
    return { error: `Name must be ${CONFIG.NAME_MAX_LENGTH} characters or fewer` };
  }
  return { name: trimmed };
}

function lowestFreeSeat(room) {
  const taken = new Set([...room.players.values()].map((p) => p.seat));
  for (let s = 0; s < CONFIG.MAX_PLAYERS; s++) if (!taken.has(s)) return s;
  return -1;
}

function createRoom(hostId) {
  const room = {
    code: generateCode(),
    hostId,
    state: 'lobby',
    loopIndex: 0,
    tick: 0,
    phaseTick: 0,         // ticks elapsed in countdown / intermission
    players: new Map(),
    ghosts: [],
    pendingGhosts: [],    // recordings of players who left mid-loop, added at loop end
    leftPlayers: [],      // final records of players who left mid-match (for results)
    coins: [],
    coinSeq: 0,
    events: [],
    startedCount: 0,      // players alive at loop start (last-alive rule)
    lastAliveDone: false,
    endAtTick: null,      // early loop end (last alive / everyone dead)
    rematchVotes: new Set(),
    timer: null,
    lastStepTime: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function freshStats() {
  return { coins: 0, haunts: 0, survivals: 0, deaths: 0 };
}

function addPlayer(room, socket, name) {
  const seat = lowestFreeSeat(room);
  const player = {
    id: socket.id,
    name,
    color: CONFIG.PLAYER_COLORS[seat],
    seat,
    joinOrder: joinCounter++,
    // Joining mid-match: spectate now, play next match (§3.9).
    spectator: isMatchRunning(room),
    connected: true,
    x: 0,
    y: 0,
    input: { up: false, down: false, left: false, right: false },
    alive: false,
    spawnShieldUntilTick: SHIELD_TICKS,
    score: 0,
    loopScore: 0,
    stats: freshStats(),
    recording: [],
  };
  room.players.set(socket.id, player);
  roomOfSocket.set(socket.id, room.code);
  socket.join(room.code);
  return player;
}

function lobbyState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    rematchVotes: [...room.rematchVotes],
    players: [...room.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, seat: p.seat, spectator: p.spectator })),
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby_state', lobbyState(room));
}

function removePlayer(socket) {
  const code = roomOfSocket.get(socket.id);
  if (!code) return;
  roomOfSocket.delete(socket.id);
  socket.leave(code);

  const room = rooms.get(code);
  if (!room) return;
  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  room.rematchVotes.delete(socket.id);

  if (room.players.size === 0) {
    stopRoomTimer(room);
    rooms.delete(code);
    console.log(`room ${code} deleted (empty)`);
    return;
  }

  if (player && !player.spectator && isMatchRunning(room)) {
    // §3.9: their ghosts stay lethal. A mid-loop recording becomes a ghost at loop end.
    if (room.state === 'loop' && player.recording.length) {
      room.pendingGhosts.push(makeGhost(room, player));
    }
    player.connected = false;
    room.leftPlayers.push(player);
  }

  // Host migration: next oldest remaining player (§3.9).
  if (room.hostId === socket.id) {
    const oldest = [...room.players.values()].sort((a, b) => a.joinOrder - b.joinOrder)[0];
    room.hostId = oldest.id;
    console.log(`room ${code}: host passed to ${oldest.name}`);
  }

  // Fewer than 2 players left in a running match -> end it and show results (§3.9).
  if (isMatchRunning(room) && activePlayers(room).length < CONFIG.MIN_PLAYERS) {
    endMatch(room);
  } else if (room.state === 'results' && allVotedRematch(room)) {
    startMatch(room);
  }
  broadcastLobby(room);
}

// ---------------------------------------------------------------------------
// Match state machine (§3.1): countdown -> loop -> intermission -> ... -> results
// ---------------------------------------------------------------------------

function isMatchRunning(room) {
  return room.state === 'countdown' || room.state === 'loop' || room.state === 'intermission';
}

// Connected players taking part in the current match, in seat order.
function activePlayers(room) {
  return [...room.players.values()].filter((p) => !p.spectator).sort((a, b) => a.seat - b.seat);
}

function startMatch(room) {
  for (const p of room.players.values()) {
    p.spectator = false; // everyone present plays, including last match's spectators
    p.score = 0;
    p.loopScore = 0;
    p.stats = freshStats();
    p.recording = [];
    p.input = { up: false, down: false, left: false, right: false };
  }
  room.loopIndex = 1;
  room.tick = 0;
  room.ghosts = [];
  room.pendingGhosts = [];
  room.leftPlayers = [];
  room.coins = [];
  room.rematchVotes.clear();
  room.state = 'countdown';
  room.phaseTick = 0;
  placeAtSpawns(room);

  io.to(room.code).emit('countdown', { seconds: CONFIG.COUNTDOWN_SECONDS, loopIndex: room.loopIndex });
  io.to(room.code).emit('snapshot', snapshot(room)); // show spawn positions during countdown
  startRoomTimer(room);
  console.log(`room ${room.code}: match started (${activePlayers(room).length} players)`);
}

// §3.8: evenly spaced on a ring, assigned by seat, rotated one seat per loop.
function spawnPositions(room) {
  const players = activePlayers(room);
  const n = players.length;
  const cx = CONFIG.ARENA_W / 2;
  const cy = CONFIG.ARENA_H / 2;
  return players.map((p, i) => {
    const slot = (i + room.loopIndex - 1) % n;
    const angle = -Math.PI / 2 + (slot * 2 * Math.PI) / n;
    return {
      id: p.id,
      x: Math.round(cx + Math.cos(angle) * CONFIG.SPAWN_RING_RADIUS),
      y: Math.round(cy + Math.sin(angle) * CONFIG.SPAWN_RING_RADIUS),
    };
  });
}

function placeAtSpawns(room) {
  const spawns = spawnPositions(room);
  for (const s of spawns) {
    const p = room.players.get(s.id);
    p.x = s.x;
    p.y = s.y;
    p.alive = true;
  }
  return spawns;
}

function startLoop(room) {
  room.state = 'loop';
  room.tick = 0;
  room.endAtTick = null;
  room.lastAliveDone = false;
  const spawns = placeAtSpawns(room);
  const players = activePlayers(room);
  room.startedCount = players.length;
  for (const p of players) {
    p.loopScore = 0;
    p.spawnShieldUntilTick = SHIELD_TICKS;
    p.recording = [[p.x, p.y]]; // points[0] = position at tick 0
  }
  room.coins = [];
  while (room.coins.length < CONFIG.COINS_ON_FIELD) room.coins.push(spawnCoin(room));

  io.to(room.code).emit('loop_start', loopStartPayload(room, spawns));
  io.to(room.code).emit('snapshot', snapshot(room));
  broadcastLobby(room);
}

function loopStartPayload(room, spawns) {
  return {
    loopIndex: room.loopIndex,
    loopsPerMatch: CONFIG.LOOPS_PER_MATCH,
    ghosts: room.ghosts, // sent once per loop, clients replay locally (§5.2)
    spawnPositions: spawns || spawnPositions(room),
    serverTime: Date.now(),
  };
}

function endLoop(room) {
  const players = activePlayers(room);
  const survivors = [];
  for (const p of players) {
    if (p.alive) {
      award(p, CONFIG.POINTS_SURVIVE);
      p.stats.survivals++;
      survivors.push(p.id);
    }
  }

  // §3.4: every recording becomes a ghost, including partial ones (death / left mid-loop).
  const newGhosts = [...room.pendingGhosts];
  for (const p of players) if (p.recording.length) newGhosts.push(makeGhost(room, p));
  room.ghosts.push(...newGhosts);
  room.pendingGhosts = [];

  const loopScores = {};
  const totals = {};
  for (const p of players) {
    loopScores[p.id] = p.loopScore;
    totals[p.id] = p.score;
  }
  io.to(room.code).emit('loop_end', {
    loopIndex: room.loopIndex,
    loopScores,
    totals,
    survivors,
    newGhosts: newGhosts.length,
  });

  if (room.loopIndex >= CONFIG.LOOPS_PER_MATCH) {
    endMatch(room);
    return;
  }
  room.state = 'intermission';
  room.phaseTick = 0;
  room.loopIndex += 1;
}

function endMatch(room) {
  stopRoomTimer(room);
  room.state = 'results';
  room.rematchVotes.clear();
  io.to(room.code).emit('match_end', results(room));
  broadcastLobby(room);
  console.log(`room ${room.code}: match over`);
}

// ---------------------------------------------------------------------------
// Ghost engine (§3.4–§3.6, §5.5)
//
// OWNERSHIP RULE — the whole game hangs on this:
//   * Every loop, each live player's position is recorded every tick.
//   * At loop end the recording becomes a ghost that replays, tick for tick,
//     in every later loop of the match.
//   * A ghost is lethal to every player EXCEPT its owner (ghost.ownerId).
//     Your own ghosts pass through you; other players' ghosts kill you.
//   * A kill ("Haunt") scores for the ghost's owner, even if the owner is dead
//     this loop. Owners who left the match keep their ghosts but score nothing.
//   * Nobody can die during the spawn shield (first SPAWN_SHIELD_SECONDS).
// ---------------------------------------------------------------------------

function makeGhost(room, player) {
  return {
    ownerId: player.id,
    ownerName: player.name,
    color: player.color,
    loopIndex: room.loopIndex,
    points: player.recording,
  };
}

function checkHaunts(room) {
  const t = room.tick;
  for (const p of activePlayers(room)) {
    if (!p.alive || t < p.spawnShieldUntilTick) continue;

    // If several ghosts overlap, the most recent one gets the credit.
    let killer = null;
    for (const g of room.ghosts) {
      if (g.ownerId === p.id) continue; // own ghosts are harmless
      const pt = g.points[t];
      if (!pt) continue;                // ghost already ended (owner died early)
      if (Math.hypot(p.x - pt[0], p.y - pt[1]) < HIT_DIST && (!killer || g.loopIndex > killer.loopIndex)) {
        killer = g;
      }
    }
    if (!killer) continue;

    p.alive = false;
    p.stats.deaths++;
    const owner = room.players.get(killer.ownerId);
    const scored = !!(owner && !owner.spectator);
    if (scored) {
      award(owner, CONFIG.POINTS_HAUNT);
      owner.stats.haunts++;
    }
    room.events.push({
      type: 'haunt',
      tick: t,
      ownerId: killer.ownerId,
      ownerName: killer.ownerName,
      victimId: p.id,
      victimName: p.name,
      ghostLoop: killer.loopIndex,
      color: killer.color,
      x: p.x,
      y: p.y,
      points: scored ? CONFIG.POINTS_HAUNT : 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Coins + scoring (§3.7)
// ---------------------------------------------------------------------------

function award(player, points) {
  player.score += points;
  player.loopScore += points;
}

function spawnCoin(room) {
  const m = CONFIG.COIN_EDGE_MARGIN;
  const live = activePlayers(room).filter((p) => p.alive);
  let x = 0, y = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    x = m + Math.random() * (CONFIG.ARENA_W - 2 * m);
    y = m + Math.random() * (CONFIG.ARENA_H - 2 * m);
    if (live.every((p) => Math.hypot(p.x - x, p.y - y) >= CONFIG.COIN_MIN_PLAYER_DIST)) break;
  }
  return { id: ++room.coinSeq, x: Math.round(x), y: Math.round(y) };
}

function checkCoins(room) {
  for (const p of activePlayers(room)) {
    if (!p.alive) continue;
    for (let i = 0; i < room.coins.length; i++) {
      const c = room.coins[i];
      if (Math.hypot(p.x - c.x, p.y - c.y) >= COIN_DIST) continue;
      award(p, CONFIG.POINTS_COIN);
      p.stats.coins++;
      room.events.push({ type: 'coin', tick: room.tick, playerId: p.id, x: c.x, y: c.y, points: CONFIG.POINTS_COIN });
      room.coins[i] = spawnCoin(room);
    }
  }
}

// Last player alive (with >=2 at loop start): +3, loop ends 1 s later.
// Everyone dead: loop also ends 1 s later, no bonus.
function checkLastAlive(room) {
  if (room.endAtTick !== null || room.startedCount < CONFIG.MIN_PLAYERS) return;
  const alive = activePlayers(room).filter((p) => p.alive);
  if (alive.length > 1) return;

  room.endAtTick = room.tick + LAST_ALIVE_DELAY_TICKS;
  if (alive.length === 1 && !room.lastAliveDone) {
    const p = alive[0];
    room.lastAliveDone = true;
    award(p, CONFIG.POINTS_LAST_ALIVE);
    room.events.push({ type: 'last_alive', tick: room.tick, playerId: p.id, x: p.x, y: p.y, points: CONFIG.POINTS_LAST_ALIVE });
  }
}

// ---------------------------------------------------------------------------
// Results (§3.7 tie-breaks, §4.3 awards)
// ---------------------------------------------------------------------------

const AWARDS = [
  { key: 'architect', title: 'Architect', desc: 'Most haunts', stat: 'haunts' },
  { key: 'survivor', title: 'Survivor', desc: 'Most loops survived', stat: 'survivals' },
  { key: 'greedy', title: 'Greedy', desc: 'Most coins', stat: 'coins' },
  { key: 'victim', title: 'Victim', desc: 'Died the most', stat: 'deaths' },
];

function results(room) {
  const everyone = [
    ...[...room.players.values()].filter((p) => !p.spectator),
    ...room.leftPlayers,
  ];
  const standings = everyone
    .map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      ...p.stats,
      left: !room.players.has(p.id),
    }))
    .sort((a, b) => b.score - a.score || b.haunts - a.haunts || b.coins - a.coins);

  const stats = {};
  for (const s of standings) {
    stats[s.id] = { coins: s.coins, haunts: s.haunts, survivals: s.survivals, deaths: s.deaths };
  }

  // Ties go to whoever ranks higher in the standings; skip an award nobody earned.
  const awards = [];
  for (const a of AWARDS) {
    let best = null;
    for (const s of standings) if (!best || s[a.stat] > best[a.stat]) best = s;
    if (best && best[a.stat] > 0) {
      awards.push({ key: a.key, title: a.title, desc: a.desc, playerId: best.id, name: best.name, color: best.color, value: best[a.stat] });
    }
  }
  return { standings, stats, awards };
}

function allVotedRematch(room) {
  return room.players.size >= CONFIG.MIN_PLAYERS &&
    [...room.players.keys()].every((id) => room.rematchVotes.has(id));
}

// ---------------------------------------------------------------------------
// Fixed 20 Hz tick
// ---------------------------------------------------------------------------

function startRoomTimer(room) {
  stopRoomTimer(room);
  room.lastStepTime = Date.now();
  room.timer = setInterval(() => {
    try {
      // Catch up if the interval fired late, so loops stay LOOP_SECONDS long in real time.
      const now = Date.now();
      let steps = Math.floor((now - room.lastStepTime) / TICK_MS);
      if (steps > CONFIG.MAX_CATCHUP_TICKS) {
        room.lastStepTime = now - CONFIG.MAX_CATCHUP_TICKS * TICK_MS;
        steps = CONFIG.MAX_CATCHUP_TICKS;
      }
      for (let i = 0; i < steps && room.timer; i++) {
        room.lastStepTime += TICK_MS;
        step(room);
      }
    } catch (err) {
      console.error(`room ${room.code}: tick error`, err);
    }
  }, TICK_MS);
}

function stopRoomTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
}

function step(room) {
  switch (room.state) {
    case 'countdown': {
      room.phaseTick++;
      if (room.phaseTick % CONFIG.TICK_RATE !== 0) break;
      const remaining = CONFIG.COUNTDOWN_SECONDS - room.phaseTick / CONFIG.TICK_RATE;
      if (remaining > 0) io.to(room.code).emit('countdown', { seconds: remaining, loopIndex: room.loopIndex });
      else startLoop(room);
      break;
    }
    case 'loop': {
      const players = activePlayers(room);
      for (const p of players) movePlayer(p);
      room.tick++;
      room.events = [];
      for (const p of players) if (p.alive) p.recording.push([p.x, p.y]); // points[tick]
      checkHaunts(room);
      checkCoins(room);
      checkLastAlive(room);
      io.to(room.code).emit('snapshot', snapshot(room));
      if (room.tick >= LOOP_TICKS || (room.endAtTick !== null && room.tick >= room.endAtTick)) endLoop(room);
      break;
    }
    case 'intermission': {
      room.phaseTick++;
      if (room.phaseTick >= INTERMISSION_TICKS) startLoop(room);
      break;
    }
  }
}

// §3.3: 8 directions, normalized diagonals, clamped to arena.
function movePlayer(p) {
  if (!p.alive) return;
  let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
  let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
  if (dx && dy) {
    dx *= Math.SQRT1_2;
    dy *= Math.SQRT1_2;
  }
  const dist = CONFIG.PLAYER_SPEED / CONFIG.TICK_RATE;
  const r = CONFIG.PLAYER_RADIUS;
  p.x = Math.round(Math.min(CONFIG.ARENA_W - r, Math.max(r, p.x + dx * dist)) * 10) / 10;
  p.y = Math.round(Math.min(CONFIG.ARENA_H - r, Math.max(r, p.y + dy * dist)) * 10) / 10;
}

function snapshot(room) {
  const players = activePlayers(room);
  const scores = {};
  for (const p of players) scores[p.id] = p.score;
  return {
    tick: room.tick,
    loopIndex: room.loopIndex,
    players: players.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      alive: p.alive,
      shield: room.state === 'loop' && room.tick < p.spawnShieldUntilTick,
    })),
    coins: room.coins,
    scores,
    events: room.state === 'loop' ? room.events : [],
  };
}

// ---------------------------------------------------------------------------
// Socket handlers (§5.4). Every handler is wrapped so a bad message can't crash the server.
// ---------------------------------------------------------------------------

function safeAck(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

function roomOf(socket) {
  return rooms.get(roomOfSocket.get(socket.id));
}

io.on('connection', (socket) => {
  console.log(`player connected ${socket.id}`);

  const on = (event, handler) => {
    socket.on(event, (...args) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`handler "${event}" failed for ${socket.id}`, err);
      }
    });
  };

  on('create_room', (payload, ack) => {
    ack = safeAck(ack);
    const { name, error } = cleanName(payload && payload.name);
    if (error) return ack({ ok: false, error });

    // Double-click guard: already alone in a fresh room I host -> reuse it.
    const current = roomOf(socket);
    if (current && current.hostId === socket.id && current.state === 'lobby' && current.players.size === 1) {
      return ack({ ok: true, code: current.code, playerId: socket.id });
    }

    removePlayer(socket); // leave any previous room
    const room = createRoom(socket.id);
    addPlayer(room, socket, name);
    console.log(`room ${room.code} created by ${name}`);
    ack({ ok: true, code: room.code, playerId: socket.id });
    broadcastLobby(room);
  });

  on('join_room', (payload, ack) => {
    ack = safeAck(ack);
    const { name, error } = cleanName(payload && payload.name);
    if (error) return ack({ ok: false, error });

    const code = String((payload && payload.code) || '').trim().toUpperCase().slice(0, 4);
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'Room not found' });
    if (roomOfSocket.get(socket.id) === code) {
      return ack({ ok: true, code, playerId: socket.id, spectator: room.players.get(socket.id).spectator });
    }
    if (room.players.size >= CONFIG.MAX_PLAYERS) return ack({ ok: false, error: 'Room is full' });

    removePlayer(socket);
    const player = addPlayer(room, socket, name);
    console.log(`${name} joined room ${code}${player.spectator ? ' as spectator' : ''}`);
    ack({ ok: true, code, playerId: socket.id, spectator: player.spectator });
    broadcastLobby(room);

    // Late joiner: bring their view up to date so they can spectate.
    if (room.state === 'loop' || room.state === 'intermission') {
      socket.emit('loop_start', loopStartPayload(room));
      socket.emit('snapshot', snapshot(room));
    } else if (room.state === 'results') {
      socket.emit('match_end', results(room));
    }
  });

  on('start_match', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.state !== 'lobby' && room.state !== 'results') return; // also ignores double-clicks
    if (room.players.size < CONFIG.MIN_PLAYERS) return;
    startMatch(room);
    broadcastLobby(room);
  });

  // Rematch: host's press starts it; otherwise it starts once every player has pressed.
  on('rematch', () => {
    const room = roomOf(socket);
    if (!room || room.state !== 'results' || !room.players.has(socket.id)) return;
    if (room.players.size < CONFIG.MIN_PLAYERS) return;
    room.rematchVotes.add(socket.id);
    if (room.hostId === socket.id || allVotedRematch(room)) startMatch(room);
    broadcastLobby(room);
  });

  on('input', (payload) => {
    const room = roomOf(socket);
    const player = room && room.players.get(socket.id);
    if (!player || !payload || typeof payload !== 'object') return;
    player.input = {
      up: payload.up === true,
      down: payload.down === true,
      left: payload.left === true,
      right: payload.right === true,
    };
  });

  on('disconnect', () => {
    console.log(`player disconnected ${socket.id}`);
    removePlayer(socket);
  });
});

process.on('uncaughtException', (err) => console.error('uncaught exception', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Déjà Brawl listening on http://localhost:${PORT} (tick ${CONFIG.TICK_RATE} Hz)`);
});
