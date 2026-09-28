// Socket handling, input, UI state machine.
const socket = io();

const $ = (id) => document.getElementById(id);

const ui = {
  screens: { home: $('home'), lobby: $('lobby'), game: $('game') },
  nameInput: $('name-input'),
  codeInput: $('code-input'),
  createBtn: $('create-btn'),
  joinBtn: $('join-btn'),
  homeError: $('home-error'),
  roomCode: $('room-code'),
  inviteBtn: $('invite-btn'),
  copyStatus: $('copy-status'),
  playerList: $('player-list'),
  playerCount: $('player-count'),
  startBtn: $('start-btn'),
  waitingText: $('waiting-text'),
  canvas: $('arena'),
  results: $('results'),
  resultsTitle: $('results-title'),
  resultsSub: $('results-sub'),
  podium: $('podium'),
  awards: $('awards'),
  statsBody: $('stats-body'),
  rematchBtn: $('rematch-btn'),
  rematchStatus: $('rematch-status'),
  backLobbyBtn: $('back-lobby-btn'),
  rulesBtn: $('rules-btn'),
  rulesOverlay: $('rules-overlay'),
  rulesClose: $('rules-close'),
  muteBtn: $('mute-btn'),
  toast: $('toast'),
  viewport: $('viewport'),
};

const state = {
  playerId: null,
  code: null,
  name: null,
  lobby: null,
  screen: 'home',
  starting: false,     // Start pressed, waiting for the server (double-click guard)
};

// Everything the renderer needs for the current match.
const game = {
  meta: new Map(),          // id -> {name, color}
  phase: 'countdown',       // countdown | loop | intermission | results
  loopIndex: 1,
  countdown: null,          // {value, at}
  loopStartAt: 0,
  intermission: null,       // last loop_end payload
  inMatch: false,           // am I one of the players (vs spectator)?
  lastResults: null,
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const VIEWPORT_DEFAULT = 'width=device-width, initial-scale=1';
const VIEWPORT_LOCKED = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

function showScreen(name) {
  state.screen = name;
  for (const [key, el] of Object.entries(ui.screens)) el.classList.toggle('hidden', key !== name);

  // Lock scroll/zoom only while the arena is up (§10).
  const playing = name === 'game';
  document.body.classList.toggle('playing', playing);
  ui.viewport.setAttribute('content', playing ? VIEWPORT_LOCKED : VIEWPORT_DEFAULT);
  if (playing) {
    if (document.activeElement) document.activeElement.blur();
    Renderer.resize();
  } else {
    ui.results.classList.add('hidden');
    ui.rulesOverlay.classList.add('hidden');
    resetInput();
  }
}

// Fill every rules card from the single template (§4.1 rules text).
const rulesTemplate = $('rules-template');
document.querySelectorAll('[data-rules]').forEach((el) => el.appendChild(rulesTemplate.content.cloneNode(true)));

let toastTimer = null;
function showToast(msg, ms) {
  ui.toast.textContent = msg;
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  ui.toast.classList.add('hidden');
}

// Audio can only start after a user gesture (mobile requirement).
window.addEventListener('pointerdown', () => Sound.unlock(), { capture: true });
window.addEventListener('keydown', () => Sound.unlock(), { capture: true });

function renderMute() {
  ui.muteBtn.textContent = Sound.isMuted() ? '🔇' : '🔊';
  ui.muteBtn.setAttribute('aria-label', Sound.isMuted() ? 'Unmute' : 'Mute');
}
ui.muteBtn.addEventListener('click', () => {
  Sound.setMuted(!Sound.isMuted());
  renderMute();
  ui.muteBtn.blur();
});
renderMute();

ui.rulesBtn.addEventListener('click', () => {
  ui.rulesOverlay.classList.remove('hidden');
  resetInput();
});
ui.rulesClose.addEventListener('click', () => ui.rulesOverlay.classList.add('hidden'));

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const sharedCode = (params.get('room') || '').trim().toUpperCase().slice(0, 4);
if (sharedCode) {
  ui.codeInput.value = sharedCode;
}
ui.nameInput.value = safeStorageGet('dejaName') || '';
ui.nameInput.focus();

function setHomeError(msg) {
  ui.homeError.textContent = msg || '';
}

let busy = false;
function setBusy(value) {
  busy = value;
  ui.createBtn.disabled = value;
  ui.joinBtn.disabled = value;
}

function readName() {
  const name = ui.nameInput.value.trim();
  if (!name) {
    setHomeError('Enter a name first');
    ui.nameInput.focus();
    return null;
  }
  if (name.length > CONFIG.NAME_MAX_LENGTH) {
    setHomeError(`Name must be ${CONFIG.NAME_MAX_LENGTH} characters or fewer`);
    return null;
  }
  safeStorageSet('dejaName', name);
  return name;
}

function enterRoom(res, name) {
  state.playerId = res.playerId;
  state.code = res.code;
  state.name = name;
  history.replaceState(null, '', `?room=${res.code}`);
  setHomeError('');
  if (state.screen === 'home') showScreen('lobby');
}

function createRoom() {
  if (busy) return;
  const name = readName();
  if (!name) return;
  setBusy(true);
  socket.emit('create_room', { name }, (res) => {
    setBusy(false);
    if (!res || !res.ok) return setHomeError((res && res.error) || 'Could not create room');
    enterRoom(res, name);
  });
}

function joinRoom() {
  if (busy) return;
  const name = readName();
  if (!name) return;
  const code = ui.codeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    setHomeError('Enter the 4-letter room code');
    ui.codeInput.focus();
    return;
  }
  setBusy(true);
  socket.emit('join_room', { code, name }, (res) => {
    setBusy(false);
    if (!res || !res.ok) return setHomeError((res && res.error) || 'Could not join room');
    enterRoom(res, name);
  });
}

ui.createBtn.addEventListener('click', createRoom);
ui.joinBtn.addEventListener('click', joinRoom);
ui.codeInput.addEventListener('input', () => {
  ui.codeInput.value = ui.codeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
});
ui.nameInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // With a code filled in (e.g. from a share link) Enter joins; otherwise it creates.
  ui.codeInput.value.trim().length === 4 ? joinRoom() : createRoom();
});
ui.codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

const MATCH_STATES = ['countdown', 'loop', 'intermission'];

function renderLobby(lobby) {
  state.lobby = lobby;
  ui.roomCode.textContent = lobby.code;

  game.meta = new Map(lobby.players.map((p) => [p.id, { name: p.name, color: p.color }]));
  const me = lobby.players.find((p) => p.id === state.playerId);
  const isHost = lobby.hostId === state.playerId;

  ui.playerList.innerHTML = '';
  for (const p of lobby.players) {
    const li = document.createElement('li');
    if (p.id === state.playerId) li.classList.add('me');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    dot.style.boxShadow = `0 0 10px ${p.color}`;

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;

    li.append(dot, name);
    if (p.id === state.playerId) li.append(tag('you'));
    if (p.spectator) li.append(tag('next match'));
    if (p.id === lobby.hostId) {
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.title = 'Host';
      crown.textContent = '👑';
      li.append(crown);
    }
    ui.playerList.append(li);
  }

  ui.playerCount.textContent = `${lobby.players.length}/${CONFIG.MAX_PLAYERS}`;

  const canStart = lobby.state === 'lobby' || lobby.state === 'results';
  if (!canStart) state.starting = false;
  ui.startBtn.classList.toggle('hidden', !isHost || !canStart);
  ui.startBtn.disabled = lobby.players.length < CONFIG.MIN_PLAYERS || state.starting;
  ui.startBtn.textContent = lobby.players.length < CONFIG.MIN_PLAYERS
    ? `Need ${CONFIG.MIN_PLAYERS} players to start`
    : 'Start';
  ui.waitingText.classList.toggle('hidden', isHost || !canStart);

  game.inMatch = !!me && !me.spectator && MATCH_STATES.includes(lobby.state);
  renderRematch();

  // A match is running and I'm still looking at the lobby: jump into the arena.
  if (MATCH_STATES.includes(lobby.state) && state.screen === 'lobby') showScreen('game');
}

function tag(text) {
  const el = document.createElement('span');
  el.className = 'tag';
  el.textContent = text;
  return el;
}

ui.startBtn.addEventListener('click', () => {
  if (state.starting) return;
  state.starting = true;
  ui.startBtn.disabled = true;
  socket.emit('start_match');
  setTimeout(() => { // server never answered (e.g. not enough players): allow another press
    if (state.starting) { state.starting = false; if (state.lobby) renderLobby(state.lobby); }
  }, 2000);
});

// Invite link: Web Share on phones, clipboard elsewhere, manual fallback on insecure origins.
ui.inviteBtn.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${state.code}`;
  const isTouch = window.matchMedia('(pointer: coarse)').matches;

  if (isTouch && navigator.share) {
    try {
      await navigator.share({ title: 'Déjà Brawl', text: `Join my Déjà Brawl room ${state.code}`, url });
      flashCopyStatus('Shared!');
    } catch (err) {
      if (err && err.name !== 'AbortError') copyText(url);
    }
    return;
  }
  copyText(url);
});

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('execCommand failed');
    }
    flashCopyStatus('Copied!');
  } catch {
    window.prompt('Copy this invite link:', text);
  }
}

let copyTimer = null;
function flashCopyStatus(msg) {
  ui.copyStatus.textContent = msg;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { ui.copyStatus.textContent = ''; }, 2000);
}

// ---------------------------------------------------------------------------
// Results (§4.1 screen 6, §4.3)
// ---------------------------------------------------------------------------

const AWARD_ICONS = { architect: '🏛️', survivor: '🛡️', greedy: '💰', victim: '💀' };

function renderResults(res) {
  game.lastResults = res;
  const { standings, awards } = res;
  const winner = standings[0];
  ui.resultsTitle.textContent = winner ? `${winner.name} wins!` : 'MATCH OVER';
  ui.resultsSub.textContent = winner ? `${winner.score} points` : '';

  // Podium: 2nd, 1st, 3rd
  ui.podium.innerHTML = '';
  const order = [1, 0, 2];
  for (const i of order) {
    const s = standings[i];
    if (!s) continue;
    const slot = document.createElement('div');
    slot.className = `podium-slot p${i + 1}`;
    const name = document.createElement('div');
    name.className = 'podium-name';
    name.textContent = s.name;
    name.style.color = s.color;
    const score = document.createElement('div');
    score.className = 'podium-score';
    score.textContent = `${s.score} pts`;
    const block = document.createElement('div');
    block.className = 'podium-block';
    block.style.background = s.color;
    block.style.boxShadow = `0 0 20px ${s.color}`;
    block.textContent = String(i + 1);
    slot.append(name, score, block);
    ui.podium.append(slot);
  }

  ui.awards.innerHTML = '';
  for (const a of awards) {
    const el = document.createElement('div');
    el.className = 'award';
    el.innerHTML = '<div class="award-icon"></div><div class="award-title"></div><div class="award-desc"></div><div class="award-who"></div>';
    el.querySelector('.award-icon').textContent = AWARD_ICONS[a.key] || '🏅';
    el.querySelector('.award-title').textContent = a.title;
    el.querySelector('.award-desc').textContent = `${a.desc} (${a.value})`;
    const who = el.querySelector('.award-who');
    who.textContent = a.name;
    who.style.color = a.color;
    ui.awards.append(el);
  }

  ui.statsBody.innerHTML = '';
  standings.forEach((s, i) => {
    const tr = document.createElement('tr');
    if (s.id === state.playerId) tr.classList.add('me');
    const nameTd = document.createElement('td');
    nameTd.textContent = `${i + 1}. ${s.name}`;
    nameTd.style.color = s.color;
    if (s.left) {
      const left = document.createElement('span');
      left.className = 'left';
      left.textContent = ' (left)';
      nameTd.append(left);
    }
    tr.append(nameTd);
    for (const v of [s.score, s.coins, s.haunts, s.survivals, s.deaths]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    }
    ui.statsBody.append(tr);
  });

  renderRematch();
}

function renderRematch() {
  const lobby = state.lobby;
  if (!lobby) return;
  const votes = lobby.rematchVotes || [];
  const voted = votes.includes(state.playerId);
  const isHost = lobby.hostId === state.playerId;
  const enough = lobby.players.length >= CONFIG.MIN_PLAYERS;

  ui.rematchBtn.disabled = voted || !enough || lobby.state !== 'results';
  ui.rematchBtn.textContent = isHost ? 'Rematch (R)' : voted ? 'Ready ✓' : 'Rematch (R)';
  if (!enough) ui.rematchStatus.textContent = 'Need at least 2 players for a rematch';
  else if (isHost) ui.rematchStatus.textContent = votes.length ? `${votes.length}/${lobby.players.length} ready — your press starts it` : 'Your press starts the rematch';
  else ui.rematchStatus.textContent = `${votes.length}/${lobby.players.length} ready — starts when the host presses or everyone is ready`;
}

function pressRematch() {
  if (ui.rematchBtn.disabled) return;
  ui.rematchBtn.disabled = true;
  socket.emit('rematch');
}

ui.rematchBtn.addEventListener('click', pressRematch);
ui.backLobbyBtn.addEventListener('click', () => showScreen('lobby'));

// ---------------------------------------------------------------------------
// Input: keyboard + touch joystick (§3.3). Only sent when it changes.
// ---------------------------------------------------------------------------

const KEY_MAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
const keys = { up: false, down: false, left: false, right: false };
const stick = { up: false, down: false, left: false, right: false };
let lastSent = '';

const joystick = { active: false, pointerId: null, ox: 0, oy: 0, kx: 0, ky: 0 };

function currentInput() {
  return {
    up: keys.up || stick.up,
    down: keys.down || stick.down,
    left: keys.left || stick.left,
    right: keys.right || stick.right,
  };
}

function sendInput(force) {
  const input = currentInput();
  const key = JSON.stringify(input);
  if (key === lastSent && !force) return;
  lastSent = key;
  if (socket.connected) socket.emit('input', input);
}

function resetInput() {
  for (const k in keys) keys[k] = false;
  for (const k in stick) stick[k] = false;
  joystick.active = false;
  joystick.pointerId = null;
  sendInput();
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
  if (state.screen !== 'game' || isTyping(e)) return;
  if (e.code === 'KeyR' && !ui.results.classList.contains('hidden')) {
    if (!e.repeat) pressRematch();
    return;
  }
  const dir = KEY_MAP[e.code];
  if (!dir) return;
  e.preventDefault();
  keys[dir] = true;
  sendInput();
});

window.addEventListener('keyup', (e) => {
  const dir = KEY_MAP[e.code];
  if (!dir) return;
  keys[dir] = false;
  sendInput();
});

window.addEventListener('blur', resetInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) resetInput();
  else Sound.unlock();
});

// Joystick appears wherever the thumb first touches the lower half of the screen.
ui.canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || joystick.active) return;
  if (e.clientY < window.innerHeight / 2) return;
  e.preventDefault();
  joystick.active = true;
  joystick.pointerId = e.pointerId;
  joystick.ox = joystick.kx = e.clientX;
  joystick.oy = joystick.ky = e.clientY;
  try { ui.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});

ui.canvas.addEventListener('pointermove', (e) => {
  if (!joystick.active || e.pointerId !== joystick.pointerId) return;
  e.preventDefault();
  const dx = e.clientX - joystick.ox;
  const dy = e.clientY - joystick.oy;
  const len = Math.hypot(dx, dy);
  const R = CONFIG.JOYSTICK_RADIUS;
  const k = len > R ? R / len : 1;
  joystick.kx = joystick.ox + dx * k;
  joystick.ky = joystick.oy + dy * k;

  for (const d in stick) stick[d] = false;
  if (len >= CONFIG.JOYSTICK_DEADZONE) {
    // Quantize to 8 directions: 0=right, 1=down-right, 2=down, ... 7=up-right.
    const octant = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    stick.right = octant === 7 || octant === 0 || octant === 1;
    stick.down = octant >= 1 && octant <= 3;
    stick.left = octant >= 3 && octant <= 5;
    stick.up = octant >= 5 && octant <= 7;
  }
  sendInput();
});

function endJoystick(e) {
  if (!joystick.active || e.pointerId !== joystick.pointerId) return;
  joystick.active = false;
  joystick.pointerId = null;
  for (const d in stick) stick[d] = false;
  sendInput();
}
ui.canvas.addEventListener('pointerup', endJoystick);
ui.canvas.addEventListener('pointercancel', endJoystick);

// Stop iOS pinch-zoom and long-press menus during play.
document.addEventListener('gesturestart', (e) => { if (state.screen === 'game') e.preventDefault(); });
ui.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

Renderer.init(ui.canvas);

function frame() {
  try {
    if (state.screen === 'game') {
      Renderer.draw({
        myId: state.playerId,
        meta: game.meta,
        phase: game.phase,
        loopIndex: game.loopIndex,
        countdown: game.countdown,
        loopStartAt: game.loopStartAt,
        intermission: game.intermission,
        spectating: !game.inMatch,
        joystick,
      });
    }
  } catch (err) {
    console.error('render error', err);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

socket.on('connect', () => {
  console.log('connected', socket.id);
  lastSent = '';
  // Came back after a drop (e.g. phone tab in background): rejoin the same room.
  if (state.code && state.name) {
    const code = state.code;
    socket.emit('join_room', { code, name: state.name }, (res) => {
      if (res && res.ok) {
        enterRoom(res, state.name);
        showToast(res.spectator ? 'Reconnected — spectating until the next match' : 'Reconnected', 2500);
      } else {
        state.code = null;
        ui.codeInput.value = code;
        setHomeError(`Could not rejoin: ${(res && res.error) || 'room closed'}`);
        showScreen('home');
        hideToast();
      }
    });
  }
});

socket.on('disconnect', () => {
  if (state.code) showToast('Connection lost — reconnecting…');
  resetInput();
});

socket.on('lobby_state', renderLobby);

socket.on('countdown', ({ seconds, loopIndex }) => {
  if (seconds === CONFIG.COUNTDOWN_SECONDS) {
    Renderer.resetMatch(); // fresh match
    Renderer.resetLoop([]);
    game.intermission = null;
  }
  game.phase = 'countdown';
  game.loopIndex = loopIndex;
  game.countdown = { value: seconds, at: performance.now() };
  Sound.play('tick');
  ui.results.classList.add('hidden');
  showScreen('game');
});

socket.on('loop_start', ({ loopIndex, ghosts }) => {
  Renderer.resetLoop(ghosts);
  game.phase = 'loop';
  game.loopIndex = loopIndex;
  game.loopStartAt = performance.now();
  ui.results.classList.add('hidden');
  sendInput(true); // make sure the server has our current keys
  Sound.play('go');
  Sound.play('whoosh');
  if (state.screen !== 'game') showScreen('game');
});

socket.on('snapshot', (snap) => {
  Renderer.pushSnapshot(snap);
});

socket.on('loop_end', (payload) => {
  game.phase = 'intermission';
  game.intermission = payload;
  Renderer.loopEnd(payload);
});

socket.on('match_end', (res) => {
  game.phase = 'results';
  resetInput();
  renderResults(res);
  if (state.screen === 'game') ui.results.classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
