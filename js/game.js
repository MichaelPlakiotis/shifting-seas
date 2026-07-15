/* Shifting Seas — core rules engine (pure logic, no DOM) */
'use strict';

const SIZE = 10;
const FLEET_SPEC = [
  { name: 'Carrier',    size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser',    size: 3 },
  { name: 'Submarine',  size: 2 },
  { name: 'Scout',      size: 1 },
];
const UAV_COOLDOWN = 5;    // usable once every 5 of your turns
const TRIPLE_COOLDOWN = 6;

function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

/* A ship: { id, name, size, r, c, dir:'h'|'v', hits:[bool], immobile:bool }
   r,c is the HEAD. The tail (rear) is the last cell. Damage is per-segment
   and travels with the ship when it moves. */
function shipCells(ship) {
  const cells = [];
  for (let i = 0; i < ship.size; i++) {
    cells.push(ship.dir === 'h' ? { r: ship.r, c: ship.c + i } : { r: ship.r + i, c: ship.c });
  }
  return cells;
}

function isSunk(ship) { return ship.hits.every(h => h); }

function fleetAllSunk(fleet) { return fleet.every(isSunk); }

function cellOwner(fleet, r, c) {
  for (const ship of fleet) {
    const cells = shipCells(ship);
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].r === r && cells[i].c === c) return { ship, seg: i };
    }
  }
  return null;
}

function canPlace(fleet, size, r, c, dir, ignoreId) {
  for (let i = 0; i < size; i++) {
    const rr = dir === 'h' ? r : r + i;
    const cc = dir === 'h' ? c + i : c;
    if (!inBounds(rr, cc)) return false;
    const hit = cellOwner(fleet.filter(s => s.id !== ignoreId), rr, cc);
    if (hit) return false;
  }
  return true;
}

function makeShip(id, spec, r, c, dir) {
  return { id, name: spec.name, size: spec.size, r, c, dir, hits: new Array(spec.size).fill(false), immobile: false };
}

function randomFleet(rng) {
  const rand = rng || Math.random;
  for (let attempt = 0; attempt < 200; attempt++) {
    const fleet = [];
    let ok = true;
    for (let i = 0; i < FLEET_SPEC.length; i++) {
      const spec = FLEET_SPEC[i];
      let placed = false;
      for (let t = 0; t < 300; t++) {
        const dir = rand() < 0.5 ? 'h' : 'v';
        const r = Math.floor(rand() * SIZE);
        const c = Math.floor(rand() * SIZE);
        if (canPlace(fleet, spec.size, r, c, dir)) {
          fleet.push(makeShip(i, spec, r, c, dir));
          placed = true;
          break;
        }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return fleet;
  }
  throw new Error('could not place fleet');
}

/* Movement: size>=2 ships slide 1 cell forward/backward along their axis only.
   Size-1 ships step 1 cell in any orthogonal direction (never diagonal).
   A ship whose rear segment was hit is immobilized. Sunk ships never move. */
function moveOptions(fleet, ship) {
  if (ship.immobile || isSunk(ship)) return [];
  const opts = [];
  // r,c = new head position; stepR,stepC = the square the ship enters (for UI highlighting)
  const tryPos = (r, c, stepR, stepC) => {
    if (canPlace(fleet, ship.size, r, c, ship.dir, ship.id)) opts.push({ r, c, stepR, stepC });
  };
  if (ship.size >= 2) {
    if (ship.dir === 'h') {
      tryPos(ship.r, ship.c - 1, ship.r, ship.c - 1);                 // ahead: enters the cell in front of the bow
      tryPos(ship.r, ship.c + 1, ship.r, ship.c + ship.size);         // astern: enters the cell behind the stern
    } else {
      tryPos(ship.r - 1, ship.c, ship.r - 1, ship.c);
      tryPos(ship.r + 1, ship.c, ship.r + ship.size, ship.c);
    }
  } else {
    tryPos(ship.r - 1, ship.c, ship.r - 1, ship.c); tryPos(ship.r + 1, ship.c, ship.r + 1, ship.c);
    tryPos(ship.r, ship.c - 1, ship.r, ship.c - 1); tryPos(ship.r, ship.c + 1, ship.r, ship.c + 1);
  }
  return opts;
}

function applyMove(ship, r, c) { ship.r = r; ship.c = c; }

/* Resolve a shot at (r,c) against a fleet. Rear-segment hit on size>=2
   immobilizes the ship. Returns everything the attacker learns. */
function applyShot(fleet, r, c) {
  const found = cellOwner(fleet, r, c);
  if (!found) return { r, c, hit: false, sunk: false, immobilized: false };
  const { ship, seg } = found;
  ship.hits[seg] = true;
  let immobilized = false;
  if (seg === ship.size - 1 && ship.size >= 2 && !ship.immobile) {
    ship.immobile = true;
    immobilized = true;
  }
  const sunk = isSunk(ship);
  return {
    r, c, hit: true, sunk, immobilized,
    shipCells: sunk ? shipCells(ship) : undefined,
    shipName: sunk ? ship.name : undefined,
  };
}

/* UAV sweep: which cells of a row/column are currently occupied. */
function scanLine(fleet, axis, idx) {
  const cells = [];
  for (let i = 0; i < SIZE; i++) {
    const r = axis === 'row' ? idx : i;
    const c = axis === 'row' ? i : idx;
    if (cellOwner(fleet, r, c)) cells.push({ r, c });
  }
  return cells;
}

/* 3 contiguous in-line cells centred on (r,c); clamped to the board. */
function tripleCells(r, c, axis) {
  let cells;
  if (axis === 'row') {
    let start = Math.min(Math.max(c - 1, 0), SIZE - 3);
    cells = [0, 1, 2].map(i => ({ r, c: start + i }));
  } else {
    let start = Math.min(Math.max(r - 1, 0), SIZE - 3);
    cells = [0, 1, 2].map(i => ({ r: start + i, c }));
  }
  return cells;
}

const Game = {
  SIZE, FLEET_SPEC, UAV_COOLDOWN, TRIPLE_COOLDOWN,
  inBounds, shipCells, isSunk, fleetAllSunk, cellOwner, canPlace,
  makeShip, randomFleet, moveOptions, applyMove, applyShot, scanLine, tripleCells,
};
if (typeof module !== 'undefined') module.exports = Game;
