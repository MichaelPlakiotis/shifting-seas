/* Shifting Seas — UI + state machine for hotseat / CPU / online play */
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const ROWS = 'ABCDEFGHIJ';
const cellName = (r, c) => ROWS[r] + (c + 1);
const key = (r, c) => r + ',' + c;
const delay = ms => new Promise(res => setTimeout(res, ms));
const buzz = ms => { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (e) {} };

function newPlayer(name) {
  return {
    name,
    fleet: null,              // my ships (null for remote opponent)
    markers: new Map(),       // what I know about the enemy grid: key -> 'miss'|'hit'|'sunk'
    incoming: new Map(),      // enemy shots on my grid: key -> 'miss'|'hit'
    uavMarks: [],             // last UAV snapshot (may be stale — ships move!)
    uavCd: 0, tripleCd: 0,
    sunkEnemyShips: 0,
  };
}

const App = {
  mode: null,                 // 'hotseat' | 'cpu' | 'online'
  players: [null, null],
  current: 0,
  phase: 'move',              // 'move' | 'action' | 'wait' | 'over'
  targeting: 'shot',          // 'shot' | 'uav' | 'triple'
  selectedShip: null,
  moveOpts: [],
  movedThisTurn: false,
  busy: false,                // animation / resolution lock
  ai: null,
  online: { myIndex: 0, meReady: false, oppReady: false, started: false, rematchMe: false, rematchOpp: false },
  placing: { forPlayer: 0, fleet: [], selSpec: null, dir: 'h', queue: [] },
};

/* ---------- screens ---------- */

function show(screen) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#screen-' + screen).classList.add('active');
}

function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
}

function setStatus(html) { $('#status').innerHTML = html; }

/* ---------- grid construction ---------- */

function buildGrid(container, onTap) {
  container.innerHTML = '';
  for (let r = 0; r < Game.SIZE; r++) {
    for (let c = 0; c < Game.SIZE; c++) {
      const d = document.createElement('div');
      d.className = 'cell';
      d.dataset.r = r; d.dataset.c = c;
      container.appendChild(d);
    }
  }
  container.onclick = e => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    onTap(+cell.dataset.r, +cell.dataset.c);
  };
}

function gridCell(container, r, c) { return container.children[r * Game.SIZE + c]; }

/* ---------- rendering ---------- */

function renderOwn() {
  const grid = $('#ownGrid');
  const me = App.players[App.mode === 'online' ? App.online.myIndex : App.current];
  for (const el of grid.children) el.className = 'cell';
  if (!me || !me.fleet) return;
  for (const ship of me.fleet) {
    const cells = Game.shipCells(ship);
    const sunk = Game.isSunk(ship);
    cells.forEach((p, i) => {
      const el = gridCell(grid, p.r, p.c);
      el.classList.add('ship');
      if (sunk) el.classList.add('ship-sunk');
      else if (ship.hits[i]) el.classList.add('ship-hit');
      if (i === ship.size - 1 && ship.size >= 2) el.classList.add('tail');
      if (ship.immobile && !sunk) el.classList.add('immobile');
      if (App.selectedShip && App.selectedShip.id === ship.id) el.classList.add('sel');
    });
  }
  for (const [k, v] of me.incoming) {
    const [r, c] = k.split(',').map(Number);
    const el = gridCell(grid, r, c);
    if (v === 'miss' && !el.classList.contains('ship')) el.classList.add('miss');
  }
  for (const o of App.moveOpts) gridCell(grid, o.r, o.c).classList.add('moveopt');
}

function renderEnemy() {
  const grid = $('#enemyGrid');
  const me = App.players[App.mode === 'online' ? App.online.myIndex : App.current];
  for (const el of grid.children) el.className = 'cell';
  if (!me) return;
  for (const p of me.uavMarks) gridCell(grid, p.r, p.c).classList.add('uav-mark');
  for (const [k, v] of me.markers) {
    const [r, c] = k.split(',').map(Number);
    gridCell(grid, r, c).classList.add(v); // 'miss' | 'hit' | 'sunk'
  }
}

function renderHud() {
  const me = App.players[App.mode === 'online' ? App.online.myIndex : App.current];
  if (!me) return;
  const uavBtn = $('#btnUav'), tripBtn = $('#btnTriple');
  uavBtn.disabled = me.uavCd > 0 || App.phase !== 'action';
  tripBtn.disabled = me.tripleCd > 0 || App.phase !== 'action';
  uavBtn.textContent = me.uavCd > 0 ? `📡 UAV (${me.uavCd})` : '📡 UAV';
  tripBtn.textContent = me.tripleCd > 0 ? `💥 Triple (${me.tripleCd})` : '💥 Triple shot';
  uavBtn.classList.toggle('armed', App.targeting === 'uav');
  tripBtn.classList.toggle('armed', App.targeting === 'triple');
  $('#btnSkipMove').style.display = App.phase === 'move' ? '' : 'none';
  $('#powers').style.display = App.phase === 'action' ? '' : 'none';
  $('#fleetStatus').textContent = me.fleet
    ? me.fleet.filter(s => !Game.isSunk(s)).length + '/5 afloat · enemy ' + (5 - me.sunkEnemyShips) + '/5'
    : '';
}

function renderAll() { renderOwn(); renderEnemy(); renderHud(); }

/* ---------- placement ---------- */

function startPlacement(playerIdx) {
  App.placing = { forPlayer: playerIdx, fleet: [], selSpec: null, dir: 'h', queue: Game.FLEET_SPEC.map((s, i) => ({ spec: s, id: i })) };
  show('place');
  $('#placeTitle').textContent = App.players[playerIdx].name + ' — place your fleet';
  renderPlacement();
}

function renderPlacement() {
  const P = App.placing;
  const grid = $('#placeGrid');
  for (const el of grid.children) el.className = 'cell';
  for (const ship of P.fleet) {
    for (const p of Game.shipCells(ship)) gridCell(grid, p.r, p.c).classList.add('ship');
  }
  const dock = $('#dock');
  dock.innerHTML = '';
  for (const item of P.queue) {
    const b = document.createElement('button');
    b.className = 'dock-ship' + (P.selSpec === item ? ' sel' : '');
    b.innerHTML = item.spec.name + ' <span>' + '◼'.repeat(item.spec.size) + '</span>';
    b.onclick = () => { P.selSpec = item; renderPlacement(); };
    dock.appendChild(b);
  }
  $('#btnRotate').textContent = P.dir === 'h' ? '↔ Horizontal' : '↕ Vertical';
  $('#btnReady').disabled = P.queue.length > 0;
  $('#placeHint').textContent = P.queue.length
    ? (P.selSpec ? 'Tap the grid to place the ' + P.selSpec.spec.name : 'Select a ship below, then tap the grid')
    : 'Fleet deployed. Tap a ship to pick it back up, or Ready.';
}

function placementTap(r, c) {
  const P = App.placing;
  const found = Game.cellOwner(P.fleet, r, c);
  if (found) { // pick ship back up
    P.fleet = P.fleet.filter(s => s.id !== found.ship.id);
    P.queue.push({ spec: Game.FLEET_SPEC[found.ship.id], id: found.ship.id });
    P.queue.sort((a, b) => a.id - b.id);
    P.selSpec = null;
    renderPlacement();
    return;
  }
  if (!P.selSpec) return;
  if (!Game.canPlace(P.fleet, P.selSpec.spec.size, r, c, P.dir)) { toast('Doesn’t fit there'); return; }
  P.fleet.push(Game.makeShip(P.selSpec.id, P.selSpec.spec, r, c, P.dir));
  P.queue = P.queue.filter(q => q !== P.selSpec);
  P.selSpec = P.queue[0] || null;
  renderPlacement();
}

function placementRandom() {
  const P = App.placing;
  P.fleet = Game.randomFleet();
  P.queue = [];
  P.selSpec = null;
  renderPlacement();
}

function placementDone() {
  const P = App.placing;
  App.players[P.forPlayer].fleet = P.fleet;
  if (App.mode === 'hotseat') {
    if (P.forPlayer === 0) {
      handoff(App.players[1].name + ': place your fleet', () => startPlacement(1));
    } else {
      handoff(App.players[0].name + ' starts', () => beginTurn(0));
    }
  } else if (App.mode === 'cpu') {
    App.players[1].fleet = Game.randomFleet();
    show('game');
    beginTurn(0);
  } else { // online
    App.online.meReady = true;
    Net.send('ready');
    if (App.online.oppReady) onlineBothReady();
    else { show('game'); App.phase = 'wait'; setStatus('Waiting for opponent to place their fleet…'); renderAll(); }
  }
}

/* ---------- hotseat handoff ---------- */

function handoff(text, cont) {
  $('#handoffText').textContent = text;
  show('handoff');
  $('#btnHandoff').onclick = () => { cont(); };
}

/* ---------- turns ---------- */

function beginTurn(idx) {
  App.current = idx;
  const me = App.players[idx];
  me.uavCd = Math.max(0, me.uavCd - 1);
  me.tripleCd = Math.max(0, me.tripleCd - 1);
  App.phase = 'move';
  App.targeting = 'shot';
  App.selectedShip = null;
  App.moveOpts = [];
  App.movedThisTurn = false;
  show('game');
  setStatus('<b>' + me.name + '</b> — move one ship (tap it on your fleet) or skip');
  renderAll();
  if (App.mode === 'cpu' && idx === 1) cpuTurn();
}

function enterActionPhase() {
  App.phase = 'action';
  App.selectedShip = null;
  App.moveOpts = [];
  const me = App.players[App.current];
  setStatus('<b>' + me.name + '</b> — tap the enemy grid to fire, or use a power');
  renderAll();
}

function ownGridTap(r, c) {
  if (App.busy) return;
  if (App.mode === 'online' && App.current !== App.online.myIndex) return;
  if (App.mode === 'cpu' && App.current === 1) return;
  if (App.phase !== 'move') return;
  const me = App.players[App.mode === 'online' ? App.online.myIndex : App.current];
  // destination tap?
  if (App.selectedShip) {
    const opt = App.moveOpts.find(o => o.r === r && o.c === c);
    if (opt) {
      Game.applyMove(App.selectedShip, opt.r, opt.c);
      App.selectedShip = null; App.moveOpts = []; App.movedThisTurn = true;
      buzz(15);
      enterActionPhase();
      return;
    }
  }
  const found = Game.cellOwner(me.fleet, r, c);
  if (found && !Game.isSunk(found.ship)) {
    if (found.ship.immobile) { toast('⚓ ' + found.ship.name + ' is immobilized (rear was hit)'); }
    const opts = Game.moveOptions(me.fleet, found.ship);
    if (!opts.length && !found.ship.immobile) toast('No room for the ' + found.ship.name + ' to move');
    App.selectedShip = opts.length ? found.ship : null;
    App.moveOpts = opts;
  } else {
    App.selectedShip = null; App.moveOpts = [];
  }
  renderOwn();
}

function enemyGridTap(r, c) {
  if (App.busy || App.phase !== 'action') return;
  if (App.mode === 'online' && App.current !== App.online.myIndex) return;
  if (App.mode === 'cpu' && App.current === 1) return;
  const me = App.players[App.mode === 'online' ? App.online.myIndex : App.current];
  if (App.targeting === 'uav') { askAxis('UAV sweep at ' + cellName(r, c), 'Row ' + ROWS[r], 'Column ' + (c + 1), axis => doUav(axis === 'row' ? r : c, axis)); return; }
  if (App.targeting === 'triple') { askAxis('Triple shot around ' + cellName(r, c), '↔ Horizontal', '↕ Vertical', axis => doTriple(r, c, axis)); return; }
  if (me.markers.get(key(r, c)) === 'sunk') { toast('That ship is already sunk'); return; }
  doShot(r, c);
}

function askAxis(title, rowLabel, colLabel, cb) {
  $('#axisTitle').textContent = title;
  $('#btnAxisRow').textContent = rowLabel;
  $('#btnAxisCol').textContent = colLabel;
  $('#axisModal').classList.add('show');
  $('#btnAxisRow').onclick = () => { $('#axisModal').classList.remove('show'); cb('row'); };
  $('#btnAxisCol').onclick = () => { $('#axisModal').classList.remove('show'); cb('col'); };
  $('#btnAxisCancel').onclick = () => { $('#axisModal').classList.remove('show'); };
}

/* ---------- actions ---------- */

function describeResult(res, prefix) {
  if (!res.hit) return prefix + cellName(res.r, res.c) + ': miss.';
  let s = prefix + cellName(res.r, res.c) + ': HIT!';
  if (res.immobilized) s += ' Rear strike — ship immobilized! ⚓';
  if (res.sunk) s += ' ' + (res.shipName || 'Ship') + ' SUNK! 🔥';
  return s;
}

function recordResult(me, res) {
  me.markers.set(key(res.r, res.c), res.hit ? 'hit' : 'miss');
  if (res.sunk) {
    me.sunkEnemyShips++;
    for (const p of res.shipCells || []) me.markers.set(key(p.r, p.c), 'sunk');
  }
}

async function doShot(r, c) {
  const me = App.players[App.mode === 'online' ? App.online.myIndex : App.current];
  if (App.mode === 'online') {
    App.busy = true;
    App.phase = 'wait';
    setStatus('Firing at ' + cellName(r, c) + '…');
    Net.send('shot', { r, c });
    return; // resolution continues in the 'result' handler
  }
  const foe = App.players[1 - App.current];
  App.busy = true;
  const res = Game.applyShot(foe.fleet, r, c);
  recordResult(me, res);
  if (res.hit) buzz(res.sunk ? [60, 40, 60] : 40);
  setStatus(describeResult(res, ''));
  renderAll();
  await delay(1100);
  finishTurn();
}

async function doUav(idx, axis) {
  const me = App.players[App.mode === 'online' ? App.online.myIndex : App.current];
  App.targeting = 'shot';
  me.uavCd = Game.UAV_COOLDOWN;
  if (App.mode === 'online') {
    App.busy = true;
    App.phase = 'wait';
    setStatus('UAV sweeping…');
    Net.send('uav', { axis, idx });
    return;
  }
  const foe = App.players[1 - App.current];
  App.busy = true;
  const cells = Game.scanLine(foe.fleet, axis, idx);
  me.uavMarks = cells;
  setStatus('📡 UAV sweep: ' + (cells.length ? cells.length + ' ship cell(s) spotted in red' : 'nothing in that line'));
  renderAll();
  await delay(1600);
  finishTurn();
}

async function doTriple(r, c, axis) {
  const me = App.players[App.mode === 'online' ? App.online.myIndex : App.current];
  App.targeting = 'shot';
  me.tripleCd = Game.TRIPLE_COOLDOWN;
  const cells = Game.tripleCells(r, c, axis);
  if (App.mode === 'online') {
    App.busy = true;
    App.phase = 'wait';
    setStatus('Triple shot incoming…');
    Net.send('triple', { cells });
    return;
  }
  const foe = App.players[1 - App.current];
  App.busy = true;
  let msg = '💥 Triple shot: ';
  const parts = [];
  for (const cell of cells) {
    const res = Game.applyShot(foe.fleet, cell.r, cell.c);
    recordResult(me, res);
    parts.push(cellName(cell.r, cell.c) + (res.hit ? (res.sunk ? ' SUNK' : ' hit') : ' miss'));
    if (res.hit) buzz(40);
  }
  setStatus(msg + parts.join(' · '));
  renderAll();
  await delay(1400);
  finishTurn();
}

function finishTurn() {
  App.busy = false;
  if (checkGameOver()) return;
  if (App.mode === 'hotseat') {
    const next = 1 - App.current;
    handoff('Pass the device to ' + App.players[next].name, () => beginTurn(next));
  } else if (App.mode === 'cpu') {
    beginTurn(1 - App.current);
  } else {
    // online: my action resolved; opponent's turn
    App.phase = 'wait';
    App.current = 1 - App.online.myIndex;
    setStatus('Opponent’s turn…');
    renderAll();
  }
}

function checkGameOver() {
  if (App.mode === 'online') {
    const me = App.players[App.online.myIndex];
    if (me.sunkEnemyShips >= 5) { gameOver(true); return true; }
    if (me.fleet && Game.fleetAllSunk(me.fleet)) { Net.send('defeat'); gameOver(false); return true; }
    return false;
  }
  for (let i = 0; i < 2; i++) {
    if (Game.fleetAllSunk(App.players[i].fleet)) {
      const winner = App.players[1 - i];
      App.phase = 'over';
      resetRematchBtn();
      $('#overTitle').textContent = App.mode === 'cpu'
        ? (i === 1 ? '🏆 Victory!' : '💀 Defeat')
        : '🏆 ' + winner.name + ' wins!';
      $('#overSub').textContent = 'All enemy ships destroyed.';
      show('over');
      return true;
    }
  }
  return false;
}

function resetRematchBtn() {
  const b = $('#btnRematch');
  b.textContent = '🔁 Rematch';
  b.disabled = false;
}

function gameOver(won) {
  App.phase = 'over';
  resetRematchBtn();
  $('#overTitle').textContent = won ? '🏆 Victory!' : '💀 Defeat';
  $('#overSub').textContent = won ? 'You sank the entire enemy fleet.' : 'Your fleet was destroyed.';
  show('over');
}

/* ---------- CPU turn ---------- */

async function cpuTurn() {
  const cpu = App.players[1], human = App.players[0];
  App.busy = true;
  setStatus('Enemy is thinking…');
  renderAll();
  await delay(900);
  const mv = aiPickMove(App.ai, cpu.fleet);
  if (mv) Game.applyMove(mv.ship, mv.to.r, mv.to.c);
  const action = aiPickAction(App.ai, { uavReady: cpu.uavCd === 0, tripleReady: cpu.tripleCd === 0 });
  if (action.type === 'uav') {
    cpu.uavCd = Game.UAV_COOLDOWN;
    const cells = Game.scanLine(human.fleet, action.axis, action.idx);
    aiRecordScan(App.ai, cells);
    setStatus('📡 Enemy UAV sweeps ' + (action.axis === 'row' ? 'row ' + ROWS[action.idx] : 'column ' + (action.idx + 1)) + '…');
    renderAll();
    await delay(1300);
  } else if (action.type === 'triple') {
    cpu.tripleCd = Game.TRIPLE_COOLDOWN;
    const cells = Game.tripleCells(action.r, action.c, action.axis);
    const parts = [];
    for (const cell of cells) {
      const res = Game.applyShot(human.fleet, cell.r, cell.c);
      aiRecordShot(App.ai, cell, res);
      human.incoming.set(key(cell.r, cell.c), res.hit ? 'hit' : 'miss');
      parts.push(cellName(cell.r, cell.c) + (res.hit ? ' HIT' : ' miss'));
      if (res.hit) buzz(40);
    }
    setStatus('💥 Enemy triple shot: ' + parts.join(' · '));
    renderAll();
    await delay(1500);
  } else {
    const cell = action.cell;
    const res = Game.applyShot(human.fleet, cell.r, cell.c);
    aiRecordShot(App.ai, cell, res);
    human.incoming.set(key(cell.r, cell.c), res.hit ? 'hit' : 'miss');
    if (res.hit) buzz(40);
    setStatus(describeResult(res, 'Enemy fires at '));
    renderAll();
    await delay(1300);
  }
  App.busy = false;
  if (checkGameOver()) return;
  beginTurn(0);
}

/* ---------- online ---------- */

function setupOnlineHandlers() {
  Net.on('ready', () => {
    App.online.oppReady = true;
    if (App.online.meReady) onlineBothReady();
  });
  Net.on('start', msg => beginOnlineGame(msg.youStart));
  Net.on('shot', msg => {
    const me = App.players[App.online.myIndex];
    const res = Game.applyShot(me.fleet, msg.r, msg.c);
    me.incoming.set(key(msg.r, msg.c), res.hit ? 'hit' : 'miss');
    if (res.hit) buzz(50);
    Net.send('result', res);
    setStatus(describeResult(res, 'Enemy fires at '));
    renderAll();
    afterDefend();
  });
  Net.on('uav', msg => {
    const me = App.players[App.online.myIndex];
    const cells = Game.scanLine(me.fleet, msg.axis, msg.idx);
    Net.send('uavResult', { cells });
    setStatus('📡 Enemy UAV swept ' + (msg.axis === 'row' ? 'row ' + ROWS[msg.idx] : 'column ' + (msg.idx + 1)) + '!');
    afterDefend();
  });
  Net.on('triple', msg => {
    const me = App.players[App.online.myIndex];
    const results = [];
    const parts = [];
    for (const cell of msg.cells) {
      const res = Game.applyShot(me.fleet, cell.r, cell.c);
      me.incoming.set(key(cell.r, cell.c), res.hit ? 'hit' : 'miss');
      results.push(res);
      parts.push(cellName(cell.r, cell.c) + (res.hit ? ' HIT' : ' miss'));
    }
    Net.send('tripleResult', { results });
    setStatus('💥 Enemy triple shot: ' + parts.join(' · '));
    renderAll();
    afterDefend();
  });
  Net.on('result', msg => {
    const me = App.players[App.online.myIndex];
    recordResult(me, msg);
    if (msg.hit) buzz(msg.sunk ? [60, 40, 60] : 40);
    setStatus(describeResult(msg, ''));
    renderAll();
    setTimeout(() => { App.busy = false; if (!checkGameOver()) finishTurn(); }, 1100);
  });
  Net.on('uavResult', msg => {
    const me = App.players[App.online.myIndex];
    me.uavMarks = msg.cells;
    setStatus('📡 UAV sweep: ' + (msg.cells.length ? msg.cells.length + ' ship cell(s) spotted in red' : 'nothing in that line'));
    renderAll();
    setTimeout(() => { App.busy = false; finishTurn(); }, 1500);
  });
  Net.on('tripleResult', msg => {
    const me = App.players[App.online.myIndex];
    const parts = [];
    for (const res of msg.results) {
      recordResult(me, res);
      parts.push(cellName(res.r, res.c) + (res.hit ? (res.sunk ? ' SUNK' : ' hit') : ' miss'));
    }
    setStatus('💥 Triple shot: ' + parts.join(' · '));
    renderAll();
    setTimeout(() => { App.busy = false; if (!checkGameOver()) finishTurn(); }, 1400);
  });
  Net.on('defeat', () => gameOver(true));
  Net.on('rematch', () => {
    App.online.rematchOpp = true;
    toast('Opponent wants a rematch!');
    if (App.online.rematchMe) onlineRematchStart();
  });
  Net.onClose = () => {
    if (App.phase !== 'over') { toast('⚠️ Opponent disconnected'); setTimeout(goMenu, 1500); }
  };
}

function afterDefend() {
  // an enemy action ends their turn; after a short beat it's my move
  setTimeout(() => {
    if (App.phase === 'over') return;
    const me = App.players[App.online.myIndex];
    if (me.fleet && Game.fleetAllSunk(me.fleet)) { Net.send('defeat'); gameOver(false); return; }
    beginTurn(App.online.myIndex);
  }, 1500);
}

function onlineBothReady() {
  if (Net.isHost) {
    const hostStarts = Math.random() < 0.5;
    Net.send('start', { youStart: !hostStarts });
    beginOnlineGame(hostStarts);
  }
  // guest waits for 'start'
}

function beginOnlineGame(iStart) {
  App.online.started = true;
  show('game');
  if (iStart) beginTurn(App.online.myIndex);
  else {
    App.current = 1 - App.online.myIndex;
    App.phase = 'wait';
    setStatus('Opponent goes first…');
    renderAll();
  }
}

function onlineRematchStart() {
  const idx = App.online.myIndex;
  App.players[idx] = newPlayer('You');
  App.players[1 - idx] = newPlayer('Opponent');
  App.online.meReady = App.online.oppReady = false;
  App.online.rematchMe = App.online.rematchOpp = false;
  App.phase = 'move';
  startPlacement(idx);
}

function startOnline(asHost) {
  App.mode = 'online';
  App.online = { myIndex: 0, meReady: false, oppReady: false, started: false, rematchMe: false, rematchOpp: false };
  App.players[0] = newPlayer('You');
  App.players[1] = newPlayer('Opponent');
  setupOnlineHandlers();
  Net.onOpen = () => {
    toast('✅ Opponent connected!');
    $('#roomWaiting').textContent = 'Opponent connected — place your fleet!';
    startPlacement(0);
  };
}

/* ---------- online lobby UI ---------- */

function uiHostRoom() {
  show('room');
  $('#roomCodeBox').style.display = 'none';
  $('#roomWaiting').textContent = 'Creating room…';
  startOnline(true);
  Net.host((err, code) => {
    if (err) { toast('Could not create room: ' + (err.message || err.type || err)); goMenu(); return; }
    $('#roomCodeBox').style.display = '';
    $('#roomCode').textContent = code;
    $('#roomWaiting').textContent = 'Waiting for opponent to join…';
    const url = Net.joinUrl();
    $('#roomLink').value = url;
    const qrBox = $('#qr');
    qrBox.innerHTML = '';
    const canvas = document.createElement('canvas');
    qrBox.appendChild(canvas);
    if (window.QRCode) QRCode.toCanvas(canvas, url, { width: 220, margin: 1, color: { dark: '#0b1220', light: '#e8f1ff' } }, () => {});
  });
}

function uiJoinRoom(code) {
  if (!code || code.trim().length < 4) { toast('Enter the 5-letter room code'); return; }
  show('room');
  $('#roomCodeBox').style.display = 'none';
  $('#roomWaiting').textContent = 'Joining room ' + code.toUpperCase().trim() + '…';
  startOnline(false);
  Net.join(code, err => {
    if (err) { toast('❌ ' + (err.message || 'Could not join')); Net.reset(); goMenu(); }
    // success path handled by Net.onOpen
  });
}

/* ---------- navigation ---------- */

function goMenu() {
  Net.reset();
  App.mode = null;
  App.phase = 'move';
  App.busy = false;
  history.replaceState(null, '', location.pathname);
  show('menu');
}

function startHotseat() {
  App.mode = 'hotseat';
  App.players[0] = newPlayer('Player 1');
  App.players[1] = newPlayer('Player 2');
  startPlacement(0);
}

function startCpu() {
  App.mode = 'cpu';
  App.players[0] = newPlayer('You');
  App.players[1] = newPlayer('Enemy fleet');
  App.ai = makeAI();
  startPlacement(0);
}

/* ---------- init ---------- */

function init() {
  buildGrid($('#placeGrid'), placementTap);
  buildGrid($('#enemyGrid'), enemyGridTap);
  buildGrid($('#ownGrid'), ownGridTap);

  $('#btnHotseat').onclick = startHotseat;
  $('#btnCpu').onclick = startCpu;
  $('#btnOnline').onclick = () => show('online');
  $('#btnHowTo').onclick = () => show('howto');
  $('#btnHowToBack').onclick = goMenu;

  $('#btnHost').onclick = uiHostRoom;
  $('#btnJoin').onclick = () => uiJoinRoom($('#joinCode').value);
  $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') uiJoinRoom(e.target.value); });
  $('#btnOnlineBack').onclick = goMenu;
  $('#btnRoomCancel').onclick = goMenu;
  $('#btnCopyLink').onclick = async () => {
    try { await navigator.clipboard.writeText($('#roomLink').value); toast('Link copied!'); }
    catch (e) { $('#roomLink').select(); document.execCommand('copy'); toast('Link copied!'); }
  };

  $('#btnRotate').onclick = () => { App.placing.dir = App.placing.dir === 'h' ? 'v' : 'h'; renderPlacement(); };
  $('#btnRandomPlace').onclick = placementRandom;
  $('#btnClearPlace').onclick = () => startPlacement(App.placing.forPlayer);
  $('#btnReady').onclick = placementDone;

  $('#btnSkipMove').onclick = () => { if (App.phase === 'move' && !App.busy) enterActionPhase(); };
  $('#btnUav').onclick = () => {
    App.targeting = App.targeting === 'uav' ? 'shot' : 'uav';
    if (App.targeting === 'uav') setStatus('📡 Tap any enemy cell, then choose its row or column to sweep');
    renderHud();
  };
  $('#btnTriple').onclick = () => {
    App.targeting = App.targeting === 'triple' ? 'shot' : 'triple';
    if (App.targeting === 'triple') setStatus('💥 Tap the centre cell, then choose horizontal or vertical');
    renderHud();
  };
  $('#btnQuit').onclick = () => { if (confirm('Leave the game?')) goMenu(); };

  $('#btnRematch').onclick = () => {
    if (App.mode === 'online') {
      App.online.rematchMe = true;
      Net.send('rematch');
      if (App.online.rematchOpp) onlineRematchStart();
      else { $('#btnRematch').textContent = 'Waiting for opponent…'; $('#btnRematch').disabled = true; }
    } else if (App.mode === 'cpu') {
      startCpu();
    } else {
      startHotseat();
    }
  };
  $('#btnOverMenu').onclick = goMenu;

  // deep link: ?room=CODE
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    show('online');
    $('#joinCode').value = room.toUpperCase();
    uiJoinRoom(room);
  } else {
    show('menu');
  }
}

document.addEventListener('DOMContentLoaded', init);
