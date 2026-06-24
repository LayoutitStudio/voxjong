import { describe, expect, it } from "vitest";
import {
  canPair,
  createGameTiles,
  createPairBag,
  getAvailablePairs,
  getTileBlockingInfo,
  requiredTileNames,
  turtleCells,
  turtleLayout,
  type GameTile,
  type TileCode,
  type TileBounds,
} from "./mahjong";

function bounds(
  id: number,
  gridX: number,
  gridY: number,
  z = 0
): TileBounds {
  return {
    id,
    x: gridX,
    y: gridY,
    z,
    x2: gridX + 1,
    y2: gridY + 1,
    gridX,
    gridY,
    gridX2: gridX + 1,
    gridY2: gridY + 1,
  };
}

function tile(id: number, code: TileCode): GameTile {
  return {
    ...bounds(id, id, 0),
    code,
    removed: false,
  };
}

describe("Mahjong turtle layout", () => {
  it("builds the expected 144-cell board", () => {
    expect(turtleLayout()).toHaveLength(144);
    expect(turtleCells).toHaveLength(144);
    expect(new Set(turtleCells.map((cell) => cell.id)).size).toBe(144);
  });
});

describe("Mahjong tile bags", () => {
  it("includes every required tile texture name", () => {
    expect(requiredTileNames).toHaveLength(42);
    expect(requiredTileNames).toContain("Man1");
    expect(requiredTileNames).toContain("Chun");
    expect(requiredTileNames).toContain("Flower4");
    expect(requiredTileNames).toContain("Season4");
  });

  it("creates 72 pair entries for a 144 tile deal", () => {
    const pairs = createPairBag();

    expect(pairs).toHaveLength(72);
    expect(pairs.flat()).toHaveLength(144);
  });

  it("creates a complete game deal", () => {
    const tiles = createGameTiles();

    expect(tiles).toHaveLength(144);
    expect(new Set(tiles.map((entry) => entry.id)).size).toBe(144);
    expect(tiles.every((entry) => requiredTileNames.includes(entry.code))).toBe(
      true
    );
  });
});

describe("Mahjong blocking rules", () => {
  it("blocks a tile when another tile sits on top", () => {
    const target = bounds(1, 1, 1);
    const top = bounds(2, 1, 1, 1);
    const info = getTileBlockingInfo(target, [target, top]);

    expect(info.blockedTop).toBe(true);
    expect(info.isFree).toBe(false);
    expect(info.topIds).toEqual([2]);
  });

  it("keeps a tile free when only one horizontal side is blocked", () => {
    const target = bounds(1, 1, 1);
    const left = bounds(2, 0, 1);
    const info = getTileBlockingInfo(target, [target, left]);

    expect(info.blockedLeft).toBe(true);
    expect(info.blockedRight).toBe(false);
    expect(info.isFree).toBe(true);
  });

  it("blocks a tile when both horizontal sides are blocked", () => {
    const target = bounds(1, 1, 1);
    const left = bounds(2, 0, 1);
    const right = bounds(3, 2, 1);
    const info = getTileBlockingInfo(target, [target, left, right]);

    expect(info.blockedLeft).toBe(true);
    expect(info.blockedRight).toBe(true);
    expect(info.isFree).toBe(false);
  });
});

describe("Mahjong pairing rules", () => {
  it("matches identical ordinary tiles", () => {
    expect(canPair("Man1", "Man1")).toBe(true);
    expect(canPair("Man1", "Man2")).toBe(false);
  });

  it("matches flowers with flowers and seasons with seasons", () => {
    expect(canPair("Flower1", "Flower4")).toBe(true);
    expect(canPair("Season1", "Season3")).toBe(true);
    expect(canPair("Flower1", "Season1")).toBe(false);
  });

  it("groups available pairs by Mahjong pairing category", () => {
    expect(
      getAvailablePairs([
        tile(1, "Man1"),
        tile(2, "Man1"),
        tile(3, "Flower1"),
        tile(4, "Flower4"),
        tile(5, "Season1"),
      ])
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});
