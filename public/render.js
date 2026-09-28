// Canvas drawing, interpolation, effects, audio.
// Exposes globals `Renderer` and `Sound` used by client.js.
(function () {
  const TICK_MS = 1000 / CONFIG.TICK_RATE;
  const LOOP_TICKS = Math.round(CONFIG.LOOP_SECONDS * CONFIG.TICK_RATE);
  const DELAY_TICKS = CONFIG.RENDER_DELAY_MS / TICK_MS;
  const TELEGRAPH_TICKS = Math.round(CONFIG.TELEGRAPH_SECONDS * CONFIG.TICK_RATE);
  const W = CONFIG.ARENA_W, H = CONFIG.ARENA_H;

  let canvas, ctx;
  let dpr = 1;
  let cssW = 0, cssH = 0;
  // Letterbox: arena (1600x900) is drawn at `scale`, offset by (offX, offY) in CSS px.
  let scale = 1, offX = 0, offY = 0;

  // ---------------------------------------------------------------------------
  // Snapshot buffer + server-tick clock (§5.2, §10)
  //
  // The client clock is expressed in *server ticks*, not local time: each
  // snapshot tells us "server was at tick T". We keep a smoothed estimate of
  // when tick 0 arrived on our clock (`tickBase`) and render at
  // (now - tickBase) / TICK_MS - DELAY_TICKS. Live players are interpolated at
  // that fractional tick AND ghosts replay at the same tick, so what you see
  // lines up with what the server collides.
  // ---------------------------------------------------------------------------
  let snaps = [];          // sorted by tick, current loop only
  let tickBase = null;     // performance.now() at which server tick 0 "arrived"
  let pendingEvents = [];  // snapshot events waiting for the render clock to reach them
  let lastRenderTick = 0;

  // Current loop's ghosts (sent once in loop_start) and which ones already popped.
  let ghosts = [];
  let popped = new Set();

  // Effects
  let particles = [];
  let popups = [];         // floating score text
  let feed = [];           // kill feed lines
  let shakeUntil = 0;
  let lastFrame = performance.now();
  let lastPlayers = [];

  function resetMatch() {
    feed = [];
    popups = [];
    particles = [];
    shakeUntil = 0;
  }

  function resetLoop(loopGhosts) {
    // Anything the render clock hasn't reached yet (e.g. last tick of the previous loop) fires now.
    flushEvents(Infinity, true);
    snaps = [];
    tickBase = null;
    lastRenderTick = 0;
    ghosts = loopGhosts || [];
    popped = new Set();
  }

  function pushSnapshot(snap) {
    const now = performance.now();
    const candidate = now - snap.tick * TICK_MS;
    if (tickBase === null) tickBase = candidate;
    // Early arrivals mean less latency: adopt quickly. Late ones: drift slowly.
    else tickBase += (candidate - tickBase) * (candidate < tickBase ? 0.5 : 0.05);

    if (snaps.length && snap.tick <= snaps[snaps.length - 1].tick) {
      snaps = snaps.filter((s) => s.tick < snap.tick);
    }
    snaps.push(snap);
    if (snaps.length > 60) snaps.shift();
    if (snap.events && snap.events.length) pendingEvents.push(...snap.events);
  }

  // Fractional server tick currently being displayed.
  function renderTick() {
    if (!snaps.length) return 0;
    const first = snaps[0].tick;
    const last = snaps[snaps.length - 1].tick;
    const t = (performance.now() - tickBase) / TICK_MS - DELAY_TICKS;
    return Math.max(first, Math.min(last, t));
  }

  function latestSnap() {
    return snaps.length ? snaps[snaps.length - 1] : null;
  }

  // Interpolated players at tick t: [{id,x,y,alive,shield}]
  function playersAt(t) {
    if (!snaps.length) return [];
    let a = snaps[0], b = snaps[0];
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i].tick <= t) a = snaps[i];
      if (snaps[i].tick >= t) { b = snaps[i]; break; }
      b = snaps[i];
    }
    const span = b.tick - a.tick;
    const f = span > 0 ? (t - a.tick) / span : 0;
    const prev = new Map(a.players.map((p) => [p.id, p]));
    return b.players.map((pb) => {
      const pa = prev.get(pb.id) || pb;
      const src = f < 0.5 ? pa : pb;
      // A player who just died stays where they died instead of sliding.
      const frozen = !pb.alive;
      return {
        id: pb.id,
        x: frozen ? pb.x : pa.x + (pb.x - pa.x) * f,
        y: frozen ? pb.y : pa.y + (pb.y - pa.y) * f,
        alive: src.alive,
        shield: src.shield,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Canvas setup + letterboxing
  // ---------------------------------------------------------------------------
  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 150));
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    scale = Math.min(cssW / W, cssH / H);
    offX = (cssW - W * scale) / 2;
    offY = (cssH - H * scale) / 2;
  }

  let shakeX = 0, shakeY = 0;
  function arenaSpace() {
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (offX + shakeX), dpr * (offY + shakeY));
  }
  function screenSpace() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Events -> effects, fired when the render clock reaches their tick
  // ---------------------------------------------------------------------------
  let currentView = null;

  function flushEvents(t, silent) {
    if (!pendingEvents.length) return;
    const due = [];
    const later = [];
    for (const e of pendingEvents) (e.tick <= t ? due : later).push(e);
    pendingEvents = later;
    for (const e of due) {
      // Events far behind (tab was in background) only update the feed, no fireworks.
      const stale = silent || e.tick < t - CONFIG.TICK_RATE;
      fireEvent(e, stale);
    }
  }

  function fireEvent(e, stale) {
    const myId = currentView && currentView.myId;
    const now = performance.now();
    if (e.type === 'haunt') {
      feed.push({ text: `👻 ${e.ownerName}'s Loop-${e.ghostLoop} ghost haunted ${e.victimName}`, color: e.color, at: now, mine: e.ownerId === myId || e.victimId === myId });
      if (feed.length > CONFIG.KILL_FEED_MAX_LINES) feed.shift();
      if (stale) return;
      burst(e.x, e.y, e.color, CONFIG.DEATH_PARTICLES, 420);
      if (e.points) popup(e.x, e.y - 30, `+${e.points} HAUNT`, e.color);
      if (e.victimId === myId) {
        shakeUntil = now + CONFIG.SHAKE_MS;
        Sound.play('death');
      } else {
        Sound.play('death', 0.4);
      }
    } else if (e.type === 'coin') {
      if (stale) return;
      popup(e.x, e.y - 20, `+${e.points}`, '#ffd23f');
      burst(e.x, e.y, '#ffd23f', 8, 180);
      if (e.playerId === myId) Sound.play('coin');
    } else if (e.type === 'last_alive') {
      if (stale) return;
      popup(e.x, e.y - 40, `+${e.points} LAST ALIVE`, '#a3ff12');
    }
  }

  function loopEnd(payload) {
    flushEvents(Infinity, false);
    for (const id of payload.survivors || []) {
      const p = lastPlayers.find((q) => q.id === id);
      if (p) popup(p.x, p.y - 40, `+${CONFIG.POINTS_SURVIVE} SURVIVED`, '#00e5ff');
    }
  }

  function popup(x, y, text, color) {
    popups.push({ x, y, text, color, at: performance.now() });
  }

  function burst(x, y, color, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.4 + Math.random() * 0.4, color, size: 2 + Math.random() * 3 });
    }
  }

  // ---------------------------------------------------------------------------
  // Frame
  //
  // view = {
  //   myId, meta: Map<id,{name,color}>, phase: 'countdown'|'loop'|'intermission'|'results',
  //   loopIndex, countdown: {value, at}, loopStartAt, intermission: loop_end payload,
  //   spectating, joystick
  // }
  // ---------------------------------------------------------------------------
  function draw(view) {
    if (!ctx) return;
    currentView = view;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    const t = renderTick();
    lastRenderTick = t;
    flushEvents(t, false);

    if (now < shakeUntil) {
      const k = CONFIG.SHAKE_PX * ((shakeUntil - now) / CONFIG.SHAKE_MS);
      shakeX = (Math.random() * 2 - 1) * k;
      shakeY = (Math.random() * 2 - 1) * k;
    } else {
      shakeX = shakeY = 0;
    }

    screenSpace();
    ctx.fillStyle = '#05060c';
    ctx.fillRect(0, 0, cssW, cssH);

    arenaSpace();
    drawArena();

    const snap = latestSnap();
    if (snap && snap.coins) drawCoins(snap.coins, now);

    const showGhosts = view.phase === 'loop' || view.phase === 'intermission';
    if (showGhosts) drawGhosts(t, view.loopIndex, view.myId);

    const players = playersAt(t);
    lastPlayers = players;
    for (const p of players) drawPlayer(p, view.meta.get(p.id), p.id === view.myId, now);

    updateParticles(dt);
    drawPopups(now);

    drawHud(view, t, now);
    drawScoreboard(view, snap, players);
    drawFeed(now);

    const me = players.find((p) => p.id === view.myId);
    if (view.phase === 'countdown') drawCountdown(view.countdown, now);
    else if (view.phase === 'loop' && now - view.loopStartAt < 700) drawGo(now - view.loopStartAt);
    else if (view.phase === 'intermission') drawIntermission(view);

    if (view.phase === 'loop' && me && !me.alive) drawHaunted(now);
    if (view.spectating && view.phase !== 'results') drawBottomBanner('SPECTATING — you’ll play the next match');

    screenSpace();
    if (view.joystick && view.joystick.active) drawJoystick(view.joystick);
  }

  function drawArena() {
    ctx.fillStyle = CONFIG.BG_COLOR;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = CONFIG.GRID_SIZE; x < W; x += CONFIG.GRID_SIZE) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = CONFIG.GRID_SIZE; y < H; y += CONFIG.GRID_SIZE) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 12;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    ctx.shadowBlur = 0;
  }

  function drawCoins(coins, now) {
    ctx.save();
    for (const c of coins) {
      const pulse = 1 + 0.18 * Math.sin(now / 180 + c.id);
      const r = CONFIG.COIN_RADIUS * 1.3 * pulse;
      ctx.shadowColor = '#ffd23f';
      ctx.shadowBlur = 18 * pulse;
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - r);
      ctx.lineTo(c.x + r * 0.75, c.y);
      ctx.lineTo(c.x, c.y + r);
      ctx.lineTo(c.x - r * 0.75, c.y);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - r * 0.5);
      ctx.lineTo(c.x + r * 0.3, c.y);
      ctx.lineTo(c.x, c.y + r * 0.1);
      ctx.lineTo(c.x - r * 0.3, c.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Ghost replay (§3.5, §3.6)
  //
  // OWNERSHIP RULE: a ghost kills every player except its owner. The server
  // decides deaths; here we only make the rule readable:
  //   * other players' ghosts: solid outline (danger)
  //   * your own ghosts: DASHED white outline (harmless to you)
  // Ghosts replay by the server tick (renderTick), not local time, so they stay
  // in sync with the server's collision checks.
  // ---------------------------------------------------------------------------
  function ghostPos(g, t) {
    const last = g.points.length - 1;
    const i = Math.floor(t);
    const a = g.points[Math.min(i, last)];
    const b = g.points[Math.min(i + 1, last)];
    const f = t - i;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  function drawGhosts(t, loopIndex, myId) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let gi = 0; gi < ghosts.length; gi++) {
      const g = ghosts[gi];
      const last = g.points.length - 1;
      if (last < 0) continue;

      // Ghost ended early (owner died / loop ended early): vanish with a pop.
      if (t > last) {
        if (!popped.has(gi) && last < LOOP_TICKS) {
          popped.add(gi);
          const p = g.points[last];
          burst(p[0], p[1], g.color, 12, 160);
        }
        continue;
      }

      const age = loopIndex - g.loopIndex; // 1 = previous loop
      const fade = Math.max(CONFIG.GHOST_MIN_FADE, 1 - (age - 1) * CONFIG.GHOST_AGE_FADE);
      const alpha = CONFIG.GHOST_ALPHA * fade;
      const [x, y] = ghostPos(g, t);
      const own = g.ownerId === myId;
      const i = Math.floor(t);

      // Short fading trail
      ctx.strokeStyle = g.color;
      ctx.lineWidth = CONFIG.GHOST_RADIUS * 0.9;
      let px = x, py = y;
      for (let k = 0; k < CONFIG.GHOST_TRAIL_TICKS; k++) {
        const idx = i - k;
        if (idx < 0) break;
        const pt = g.points[idx];
        ctx.globalAlpha = alpha * 0.5 * (1 - k / CONFIG.GHOST_TRAIL_TICKS);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(pt[0], pt[1]);
        ctx.stroke();
        px = pt[0];
        py = pt[1];
      }

      // Telegraph: dotted line along the next TELEGRAPH_SECONDS of path
      const end = Math.min(last, i + TELEGRAPH_TICKS);
      if (end > i) {
        ctx.globalAlpha = Math.min(0.8, alpha * 1.6);
        ctx.lineWidth = 2.5;
        ctx.setLineDash([0.1, 9]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let k = i + 1; k <= end; k++) ctx.lineTo(g.points[k][0], g.points[k][1]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Body
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g.color;
      ctx.beginPath();
      ctx.arc(x, y, CONFIG.GHOST_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      // Outline: dashed = yours (harmless), solid = deadly
      ctx.globalAlpha = own ? 0.9 : Math.min(1, alpha * 1.8);
      ctx.lineWidth = 2;
      ctx.strokeStyle = own ? '#ffffff' : g.color;
      if (own) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(x, y, CONFIG.GHOST_RADIUS + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawPlayer(p, meta, isMe, now) {
    const color = (meta && meta.color) || '#ffffff';
    const r = CONFIG.PLAYER_RADIUS;
    ctx.save();

    if (!p.alive) {
      // Dead: faded X where they died
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - r, p.y - r); ctx.lineTo(p.x + r, p.y + r);
      ctx.moveTo(p.x + r, p.y - r); ctx.lineTo(p.x - r, p.y + r);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Spawn shield: blink
    if (p.shield && Math.floor(now / CONFIG.SHIELD_BLINK_MS) % 2 === 0) ctx.globalAlpha = 0.35;

    ctx.shadowColor = color;
    ctx.shadowBlur = 24;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.4, 0, Math.PI * 2);
    ctx.fill();

    if (isMe) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.font = `${isMe ? 800 : 600} 20px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = isMe ? '#ffffff' : color;
    ctx.fillText(isMe ? 'YOU' : (meta ? meta.name : ''), p.x, p.y - r - 10);
    ctx.restore();
  }

  function updateParticles(dt) {
    ctx.save();
    particles = particles.filter((pt) => (pt.life += dt) < pt.max);
    for (const pt of particles) {
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.9;
      pt.vy *= 0.9;
      ctx.globalAlpha = 1 - pt.life / pt.max;
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
    }
    ctx.restore();
  }

  function drawPopups(now) {
    const life = CONFIG.POPUP_SECONDS * 1000;
    popups = popups.filter((p) => now - p.at < life);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 26px system-ui, sans-serif';
    for (const p of popups) {
      const k = (now - p.at) / life;
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
      ctx.fillText(p.text, p.x, p.y - k * 50);
    }
    ctx.restore();
  }

  function drawHud(view, t, now) {
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '800 32px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 10;
    ctx.fillText(`LOOP ${view.loopIndex}/${CONFIG.LOOPS_PER_MATCH}`, 28, 40);
    ctx.shadowBlur = 0;

    // Timer bar (shrinks over the loop)
    let frac = 1;
    if (view.phase === 'loop') frac = 1 - t / LOOP_TICKS;
    else if (view.phase === 'intermission' || view.phase === 'results') frac = 0;
    frac = Math.max(0, Math.min(1, frac));

    const bx = 220, by = 32, bw = W - 560, bh = 14;
    const tension = view.phase === 'loop' && view.loopIndex >= CONFIG.TENSION_FROM_LOOP;
    if (tension) {
      // Loops 5–6: slow red pulse around the bar
      const pulse = 0.5 + 0.5 * Math.sin(now / 220);
      ctx.fillStyle = `rgba(255, 60, 90, ${0.12 + 0.25 * pulse})`;
      ctx.shadowColor = '#ff3c5a';
      ctx.shadowBlur = 20 * pulse;
      roundRect(bx - 4, by - 4, bw + 8, bh + 8, (bh + 8) / 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(bx, by, bw, bh, bh / 2);
    ctx.fill();
    if (frac > 0) {
      const secondsLeft = frac * CONFIG.LOOP_SECONDS;
      const color = secondsLeft <= 3 || tension ? '#ff5c7a' : '#00e5ff';
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      roundRect(bx, by, bw * frac, bh, bh / 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawScoreboard(view, snap, players) {
    if (!snap || !snap.scores) return;
    const rows = Object.entries(snap.scores)
      .map(([id, score]) => ({ id, score, meta: view.meta.get(id), p: players.find((q) => q.id === id) }))
      .filter((r) => r.meta)
      .sort((a, b) => b.score - a.score);
    if (!rows.length) return;

    const rowH = 32, pw = 290, x = W - pw - 20, y = 18;
    ctx.save();
    ctx.fillStyle = 'rgba(12, 14, 28, 0.75)';
    roundRect(x, y, pw, 12 + rows.length * rowH, 10);
    ctx.fill();
    ctx.textBaseline = 'middle';
    rows.forEach((r, i) => {
      const ry = y + 6 + i * rowH;
      const isMe = r.id === view.myId;
      if (isMe) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        roundRect(x + 4, ry, pw - 8, rowH - 2, 6);
        ctx.fill();
      }
      const dead = r.p && !r.p.alive && view.phase === 'loop';
      ctx.globalAlpha = dead ? 0.45 : 1;
      ctx.fillStyle = r.meta.color;
      ctx.beginPath();
      ctx.arc(x + 20, ry + rowH / 2, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.font = `${isMe ? 800 : 600} 21px system-ui, sans-serif`;
      ctx.fillStyle = isMe ? '#ffffff' : '#c9cdf0';
      const label = isMe ? `YOU (${r.meta.name})` : r.meta.name;
      ctx.fillText(truncate(label, 170), x + 36, ry + rowH / 2);
      ctx.textAlign = 'right';
      ctx.font = '800 22px system-ui, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(r.score), x + pw - 14, ry + rowH / 2);
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  function drawFeed(now) {
    const life = CONFIG.KILL_FEED_SECONDS * 1000;
    feed = feed.filter((f) => now - f.at < life);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 22px system-ui, sans-serif';
    feed.forEach((f, i) => {
      const age = now - f.at;
      ctx.globalAlpha = age > life - 1000 ? (life - age) / 1000 : 1;
      const y = 88 + i * 32;
      const text = f.text;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = f.mine ? 'rgba(255,255,255,0.14)' : 'rgba(12, 14, 28, 0.7)';
      roundRect(20, y - 14, tw + 20, 28, 8);
      ctx.fill();
      ctx.fillStyle = f.color;
      ctx.fillText(text, 30, y + 1);
    });
    ctx.restore();
  }

  function drawCountdown(cd, now) {
    if (!cd) return;
    const age = Math.min(1, (now - cd.at) / 1000);
    const size = 260 * (1.25 - 0.25 * age);
    ctx.save();
    ctx.fillStyle = 'rgba(5, 6, 12, 0.45)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 36px system-ui, sans-serif';
    ctx.fillStyle = '#8a90b8';
    ctx.fillText('GET READY', W / 2, H / 2 - 190);
    ctx.globalAlpha = 1 - age * 0.35;
    ctx.font = `900 ${size}px system-ui, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ff2bd6';
    ctx.shadowBlur = 40;
    ctx.fillText(String(cd.value), W / 2, H / 2 + 10);
    ctx.restore();
  }

  function drawGo(age) {
    ctx.save();
    ctx.globalAlpha = 1 - age / 700;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${200 + age * 0.15}px system-ui, sans-serif`;
    ctx.fillStyle = '#a3ff12';
    ctx.shadowColor = '#a3ff12';
    ctx.shadowBlur = 40;
    ctx.fillText('GO!', W / 2, H / 2);
    ctx.restore();
  }

  function drawIntermission(view) {
    const data = view.intermission;
    ctx.save();
    ctx.fillStyle = 'rgba(5, 6, 12, 0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 76px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 30;
    ctx.fillText(`LOOP ${data ? data.loopIndex : ''} COMPLETE`, W / 2, 210);
    ctx.shadowBlur = 0;

    if (data) {
      const rows = Object.entries(data.loopScores)
        .map(([id, pts]) => ({ id, pts, total: data.totals[id], meta: view.meta.get(id) }))
        .filter((r) => r.meta)
        .sort((a, b) => b.pts - a.pts || b.total - a.total);
      const rowH = 46, pw = 560, x = W / 2 - pw / 2;
      let y = 290;
      for (const r of rows) {
        const isMe = r.id === view.myId;
        ctx.fillStyle = isMe ? 'rgba(255,255,255,0.12)' : 'rgba(18, 21, 40, 0.85)';
        roundRect(x, y, pw, rowH - 6, 10);
        ctx.fill();
        ctx.fillStyle = r.meta.color;
        ctx.beginPath();
        ctx.arc(x + 26, y + (rowH - 6) / 2, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.font = `${isMe ? 800 : 600} 26px system-ui, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(isMe ? `${r.meta.name} (you)` : r.meta.name, x + 48, y + (rowH - 6) / 2);
        ctx.textAlign = 'right';
        ctx.font = '800 26px system-ui, sans-serif';
        ctx.fillStyle = r.pts > 0 ? '#a3ff12' : '#8a90b8';
        ctx.fillText(`+${r.pts}`, x + pw - 110, y + (rowH - 6) / 2);
        ctx.fillStyle = '#c9cdf0';
        ctx.font = '600 22px system-ui, sans-serif';
        ctx.fillText(`${r.total} pts`, x + pw - 18, y + (rowH - 6) / 2);
        y += rowH;
      }
      ctx.textAlign = 'center';
      ctx.font = '700 32px system-ui, sans-serif';
      ctx.fillStyle = '#ff2bd6';
      ctx.shadowColor = '#ff2bd6';
      ctx.shadowBlur = 14;
      ctx.fillText(`👻 +${data.newGhosts} new ghost${data.newGhosts === 1 ? '' : 's'} next loop`, W / 2, y + 40);
    }
    ctx.restore();
  }

  function drawHaunted(now) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.85 + 0.15 * Math.sin(now / 200);
    ctx.font = '900 64px system-ui, sans-serif';
    ctx.fillStyle = '#ff5c7a';
    ctx.shadowColor = '#ff5c7a';
    ctx.shadowBlur = 24;
    ctx.fillText('HAUNTED — back next loop', W / 2, 150);
    ctx.restore();
  }

  function drawBottomBanner(text) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 30px system-ui, sans-serif';
    ctx.fillStyle = '#ffd23f';
    ctx.fillText(text, W / 2, H - 40);
    ctx.restore();
  }

  function drawJoystick(js) {
    const R = CONFIG.JOYSTICK_RADIUS;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.arc(js.ox, js.oy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(0, 229, 255, 0.7)';
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(js.kx, js.ky, R * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function truncate(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }

  window.Renderer = { init, resize, draw, resetMatch, resetLoop, pushSnapshot, loopEnd, renderTick };
})();

// ---------------------------------------------------------------------------
// WebAudio sounds, synthesized (§4.3). No audio files.
// ---------------------------------------------------------------------------
window.Sound = (function () {
  let ac = null;
  let master = null;
  let muted = false;
  try { muted = localStorage.getItem('dejaMuted') === '1'; } catch { /* ignore */ }

  // Browsers (especially mobile) only allow audio after a user gesture.
  function unlock() {
    try {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC();
        master = ac.createGain();
        master.gain.value = CONFIG.MASTER_VOLUME;
        master.connect(ac.destination);
      }
      if (ac.state === 'suspended') ac.resume();
    } catch { /* audio unavailable */ }
  }

  function tone(freq, dur, type, vol, freqEnd, delay = 0) {
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol, filterType, fFrom, fTo) {
    const t0 = ac.currentTime;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const filter = ac.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(fFrom, t0);
    filter.frequency.exponentialRampToValueAtTime(fTo, t0 + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(master);
    src.start(t0);
  }

  function play(name, volume = 1) {
    if (muted || !ac || ac.state !== 'running') return;
    try {
      switch (name) {
        case 'coin':
          tone(988, 0.08, 'square', 0.12 * volume);
          tone(1319, 0.14, 'square', 0.12 * volume, null, 0.07);
          break;
        case 'death':
          tone(180, 0.35, 'sine', 0.5 * volume, 40);
          noise(0.25, 0.25 * volume, 'lowpass', 900, 120);
          break;
        case 'whoosh':
          noise(0.55, 0.22 * volume, 'bandpass', 300, 3200);
          break;
        case 'tick':
          tone(660, 0.08, 'square', 0.1 * volume);
          break;
        case 'go':
          tone(880, 0.25, 'sawtooth', 0.1 * volume, 1760);
          break;
      }
    } catch { /* ignore audio errors */ }
  }

  function setMuted(value) {
    muted = value;
    try { localStorage.setItem('dejaMuted', value ? '1' : '0'); } catch { /* ignore */ }
  }

  return { unlock, play, setMuted, isMuted: () => muted };
})();
