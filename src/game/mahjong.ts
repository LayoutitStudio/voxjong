export type TurtleCoord = {
  x: number;
  y: number;
  z: number;
};

export const requiredTileNames = [
  "Man1",
  "Man2",
  "Man3",
  "Man4",
  "Man5",
  "Man6",
  "Man7",
  "Man8",
  "Man9",
  "Pin1",
  "Pin2",
  "Pin3",
  "Pin4",
  "Pin5",
  "Pin6",
  "Pin7",
  "Pin8",
  "Pin9",
  "Sou1",
  "Sou2",
  "Sou3",
  "Sou4",
  "Sou5",
  "Sou6",
  "Sou7",
  "Sou8",
  "Sou9",
  "Ton",
  "Nan",
  "Shaa",
  "Pei",
  "Haku",
  "Hatsu",
  "Chun",
  "Flower1",
  "Flower2",
  "Flower3",
  "Flower4",
  "Season1",
  "Season2",
  "Season3",
  "Season4",
] as const;

export type TileCode = (typeof requiredTileNames)[number];

export type GameTile = {
  id: number;
  code: TileCode;
  x: number;
  y: number;
  z: number;
  x2: number;
  y2: number;
  gridX: number;
  gridY: number;
  gridX2: number;
  gridY2: number;
  removed: boolean;
};

export type TileBounds = Pick<
  GameTile,
  "id" | "x" | "y" | "z" | "x2" | "y2" | "gridX" | "gridY" | "gridX2" | "gridY2"
>;

export type TilePair = [number, number];

export type TileBlockingInfo = {
  topIds: number[];
  leftIds: number[];
  rightIds: number[];
  blockedTop: boolean;
  blockedLeft: boolean;
  blockedRight: boolean;
  isFree: boolean;
};

export type MoveRecord = {
  firstId: number;
  secondId: number;
};

export function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j] as T, list[i] as T];
  }
  return list;
}

function createRow(
  target: TurtleCoord[],
  xStart: number,
  xEnd: number,
  y: number,
  z: number
): void {
  for (let x = xStart; x <= xEnd; x += 1) {
    target.push({ x, y, z });
  }
}

function createRect(
  target: TurtleCoord[],
  xStart: number,
  yStart: number,
  xEnd: number,
  yEnd: number,
  z: number
): void {
  for (let y = yStart; y <= yEnd; y += 1) {
    createRow(target, xStart, xEnd, y, z);
  }
}

export function turtleLayout(): TurtleCoord[] {
  const coords: TurtleCoord[] = [];

  createRow(coords, 1, 12, 0, 0);
  createRow(coords, 3, 10, 1, 0);
  createRow(coords, 2, 11, 2, 0);
  createRect(coords, 1, 3, 12, 4, 0);
  createRow(coords, 2, 11, 5, 0);
  createRow(coords, 3, 10, 6, 0);
  createRow(coords, 1, 12, 7, 0);
  coords.push({ x: 0, y: 4, z: 0 });
  createRow(coords, 13, 14, 4, 0);

  createRect(coords, 4, 1, 9, 6, 1);
  createRect(coords, 5, 2, 8, 5, 2);
  createRect(coords, 6, 3, 7, 4, 3);
  coords.push({ x: 7, y: 4, z: 4 });

  return coords;
}

const turtleCoords = turtleLayout();
if (turtleCoords.length !== 144) {
  throw new Error(
    `Turtle layout expected 144 tiles, got ${turtleCoords.length}`
  );
}

export const turtleCells: TileBounds[] = turtleCoords.map((coord, index) => {
  const gridX = coord.x + 1;
  const gridY = coord.y + 1;
  return {
    id: index,
    x: coord.x + 1,
    y: coord.y + 1,
    z: coord.z,
    x2: coord.x + 2,
    y2: coord.y + 2,
    gridX,
    gridY,
    gridX2: gridX + 1,
    gridY2: gridY + 1,
  };
});

export function createPairBag(): Array<[TileCode, TileCode]> {
  const pairs: Array<[TileCode, TileCode]> = [];
  for (const suit of ["Man", "Pin", "Sou"] as const) {
    for (let value = 1; value <= 9; value += 1) {
      const code = `${suit}${value}` as TileCode;
      pairs.push([code, code], [code, code]);
    }
  }
  for (const honor of [
    "Ton",
    "Nan",
    "Shaa",
    "Pei",
    "Haku",
    "Hatsu",
    "Chun",
  ] as const) {
    pairs.push([honor, honor], [honor, honor]);
  }
  const [flowerA, flowerB, flowerC, flowerD] = shuffle([
    "Flower1",
    "Flower2",
    "Flower3",
    "Flower4",
  ]);
  if (!flowerA || !flowerB || !flowerC || !flowerD) {
    throw new Error("Flower tile bag expected 4 tiles.");
  }
  pairs.push([flowerA, flowerB], [flowerC, flowerD]);

  const [seasonA, seasonB, seasonC, seasonD] = shuffle([
    "Season1",
    "Season2",
    "Season3",
    "Season4",
  ]);
  if (!seasonA || !seasonB || !seasonC || !seasonD) {
    throw new Error("Season tile bag expected 4 tiles.");
  }
  pairs.push([seasonA, seasonB], [seasonC, seasonD]);

  if (pairs.length !== 72) {
    throw new Error(`Tile pair bag expected 72 pairs, got ${pairs.length}`);
  }
  return shuffle(pairs);
}

export function createSolvableRemovalPairs(
  cells: TileBounds[],
  attempts = 400
): Array<[number, number]> {
  const expectedPairs = cells.length / 2;
  const allIds = cells.map((cell) => cell.id);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remaining = new Set<number>(allIds);
    const sequence: Array<[number, number]> = [];
    let failed = false;

    while (remaining.size > 0) {
      const active = cells.filter((cell) => remaining.has(cell.id));
      const free = shuffle(getFreeTileIds(active));
      if (free.length < 2) {
        failed = true;
        break;
      }

      const first = free[0];
      const second = free[1 + Math.floor(Math.random() * (free.length - 1))];
      if (first === undefined || second === undefined) {
        failed = true;
        break;
      }

      remaining.delete(first);
      remaining.delete(second);
      sequence.push([first, second]);
    }

    if (!failed && sequence.length === expectedPairs) {
      return sequence;
    }
  }

  throw new Error("Unable to generate a solvable turtle deal.");
}

export function createGameTiles(): GameTile[] {
  const removalPairs = createSolvableRemovalPairs(turtleCells);
  const codePairs = createPairBag();
  if (removalPairs.length !== codePairs.length) {
    throw new Error(
      `Mismatch between removable pairs (${removalPairs.length}) and code pairs (${codePairs.length}).`
    );
  }

  const codeById = new Map<number, TileCode>();
  for (let i = 0; i < removalPairs.length; i += 1) {
    const pair = removalPairs[i];
    const codes = codePairs[i];
    if (!pair || !codes) {
      continue;
    }
    codeById.set(pair[0], codes[0]);
    codeById.set(pair[1], codes[1]);
  }

  return turtleCells.map((cell) => {
    const code = codeById.get(cell.id);
    if (!code) {
      throw new Error(`Missing generated tile code for cell ${cell.id}.`);
    }

    return {
      id: cell.id,
      code,
      x: cell.x,
      y: cell.y,
      z: cell.z,
      x2: cell.x2,
      y2: cell.y2,
      gridX: cell.gridX,
      gridY: cell.gridY,
      gridX2: cell.gridX2,
      gridY2: cell.gridY2,
      removed: false,
    };
  });
}

export function overlapOnAxis(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function overlapGridRect(a: TileBounds, b: TileBounds): boolean {
  return (
    overlapOnAxis(a.gridX, a.gridX2, b.gridX, b.gridX2) &&
    overlapOnAxis(a.gridY, a.gridY2, b.gridY, b.gridY2)
  );
}

export function getTileBlockingInfo(
  tile: TileBounds,
  active: TileBounds[]
): TileBlockingInfo {
  const topIds: number[] = [];
  const leftIds: number[] = [];
  const rightIds: number[] = [];

  for (const other of active) {
    if (other.id === tile.id) {
      continue;
    }

    if (other.z === tile.z + 1 && overlapGridRect(tile, other)) {
      topIds.push(other.id);
    }
    if (
      other.z === tile.z &&
      other.gridX2 === tile.gridX &&
      overlapOnAxis(other.gridY, other.gridY2, tile.gridY, tile.gridY2)
    ) {
      leftIds.push(other.id);
    }
    if (
      other.z === tile.z &&
      other.gridX === tile.gridX2 &&
      overlapOnAxis(other.gridY, other.gridY2, tile.gridY, tile.gridY2)
    ) {
      rightIds.push(other.id);
    }
  }

  const blockedTop = topIds.length > 0;
  const blockedLeft = leftIds.length > 0;
  const blockedRight = rightIds.length > 0;
  const isFree = !blockedTop && (!blockedLeft || !blockedRight);

  return {
    topIds,
    leftIds,
    rightIds,
    blockedTop,
    blockedLeft,
    blockedRight,
    isFree,
  };
}

export function getFreeTileIds(active: TileBounds[]): number[] {
  const free: number[] = [];
  for (const tile of active) {
    const info = getTileBlockingInfo(tile, active);
    if (info.isFree) {
      free.push(tile.id);
    }
  }
  return free;
}

export function isFlower(code: string): boolean {
  return code.startsWith("Flower");
}

export function isSeason(code: string): boolean {
  return code.startsWith("Season");
}

export function tilePairGroup(code: string): string {
  if (isFlower(code)) {
    return "Flower";
  }
  if (isSeason(code)) {
    return "Season";
  }
  return code;
}

export function canPair(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return (
    (isFlower(left) && isFlower(right)) || (isSeason(left) && isSeason(right))
  );
}

export function getAvailablePairs(tiles: ReadonlyArray<GameTile>): TilePair[] {
  const grouped = new Map<string, number[]>();
  for (const tile of tiles) {
    const key = tilePairGroup(tile.code);
    const ids = grouped.get(key);
    if (ids) {
      ids.push(tile.id);
    } else {
      grouped.set(key, [tile.id]);
    }
  }

  const pairs: TilePair[] = [];
  for (const ids of grouped.values()) {
    if (ids.length < 2) {
      continue;
    }
    for (let i = 0; i < ids.length - 1; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const first = ids[i];
        const second = ids[j];
        if (first !== undefined && second !== undefined) {
          pairs.push([first, second]);
        }
      }
    }
  }
  return pairs;
}
