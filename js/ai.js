/* Shifting Seas — CPU opponent */
'use strict';

function makeAI() {
  return {
    targets: [],            // hit cells to chase
    intel: [],              // cells UAV reported occupied, not yet shot
    tried: new Set(),       // "r,c" of cells already shot (markers can go stale, but avoid repeats)
    key(r, c) { return r + ',' + c; },
  };
}

function aiPickMove(ai, fleet) {
  // Move a damaged-but-mobile ship out of danger sometimes; otherwise occasionally reposition.
  const movable = fleet.filter(s => Game.moveOptions(fleet, s).length > 0);
  if (!movable.length) return null;
  const damaged = movable.filter(s => s.hits.some(h => h) && !Game.isSunk(s));
  let ship = null;
  if (damaged.length && Math.random() < 0.85) ship = damaged[Math.floor(Math.random() * damaged.length)];
  else if (Math.random() < 0.35) ship = movable[Math.floor(Math.random() * movable.length)];
  if (!ship) return null;
  const opts = Game.moveOptions(fleet, ship);
  const to = opts[Math.floor(Math.random() * opts.length)];
  return { ship, to };
}

function aiPickAction(ai, state) {
  // state: { uavReady, tripleReady, turnCount }
  if (state.uavReady && ai.targets.length === 0 && ai.intel.length === 0 && Math.random() < 0.45) {
    const axis = Math.random() < 0.5 ? 'row' : 'col';
    return { type: 'uav', axis, idx: Math.floor(Math.random() * Game.SIZE) };
  }
  if (state.tripleReady && ai.targets.length === 0 && ai.intel.length === 0 && Math.random() < 0.3) {
    const axis = Math.random() < 0.5 ? 'row' : 'col';
    const r = Math.floor(Math.random() * Game.SIZE);
    const c = Math.floor(Math.random() * Game.SIZE);
    return { type: 'triple', r, c, axis };
  }
  return { type: 'shot', cell: aiPickShot(ai) };
}

function aiPickShot(ai) {
  // 1) chase confirmed hits
  while (ai.targets.length) {
    const t = ai.targets[ai.targets.length - 1];
    const neighbors = [
      { r: t.r - 1, c: t.c }, { r: t.r + 1, c: t.c },
      { r: t.r, c: t.c - 1 }, { r: t.r, c: t.c + 1 },
    ].filter(n => Game.inBounds(n.r, n.c) && !ai.tried.has(ai.key(n.r, n.c)));
    if (neighbors.length) return neighbors[Math.floor(Math.random() * neighbors.length)];
    ai.targets.pop();
  }
  // 2) use UAV intel
  while (ai.intel.length) {
    const cell = ai.intel.shift();
    if (!ai.tried.has(ai.key(cell.r, cell.c))) return cell;
  }
  // 3) parity hunt
  const candidates = [];
  for (let r = 0; r < Game.SIZE; r++) {
    for (let c = 0; c < Game.SIZE; c++) {
      if (!ai.tried.has(ai.key(r, c))) candidates.push({ r, c, parity: (r + c) % 2 === 0 });
    }
  }
  if (!candidates.length) return { r: 0, c: 0 };
  const even = candidates.filter(x => x.parity);
  const pool = even.length ? even : candidates;
  return pool[Math.floor(Math.random() * pool.length)];
}

function aiRecordShot(ai, cell, result) {
  ai.tried.add(ai.key(cell.r, cell.c));
  if (result.hit && !result.sunk) ai.targets.push({ r: cell.r, c: cell.c });
  if (result.sunk) {
    // clear chase targets that belong to the sunk ship
    const sunkKeys = new Set((result.shipCells || []).map(p => ai.key(p.r, p.c)));
    ai.targets = ai.targets.filter(t => !sunkKeys.has(ai.key(t.r, t.c)));
    for (const p of result.shipCells || []) ai.tried.add(ai.key(p.r, p.c));
  }
}

function aiRecordScan(ai, cells) {
  for (const cell of cells) {
    if (!ai.tried.has(ai.key(cell.r, cell.c))) ai.intel.push(cell);
  }
}
