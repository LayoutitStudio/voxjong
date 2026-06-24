<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  createCamera,
  renderScene,
  type HeadlessCameraHandle,
  type HeadlessRenderHandle,
  type SceneState,
} from "@layoutit/voxcss";
import {
  canPair,
  createGameTiles,
  getAvailablePairs,
  getFreeTileIds,
  requiredTileNames,
  turtleCells,
  type GameTile,
  type MoveRecord,
} from "./game/mahjong";

type ViewMode = "isometric" | "topdown";

const imageModules = import.meta.glob("./assets/*.png", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const tileTextures = Object.fromEntries(
  Object.entries(imageModules).map(([path, url]) => [
    path.split("/").pop()?.replace(".png", "") ?? path,
    url,
  ])
) as Record<string, string>;
const logoUrl = imageModules["./assets/voxjong-logo.png"];
const socialCardUrl = imageModules["./assets/voxjong-social.png"];
const pageTitle = "VoxJong - CSS Mahjong Solitaire";
const pageDescription = "Play VoxJong, a free CSS Mahjong Solitaire.";

const route = useRoute();
const runtimeConfig = useRuntimeConfig();
const siteUrl = computed(() => {
  const raw =
    (runtimeConfig.public.siteUrl as string | undefined)?.trim() ?? "";
  return raw ? raw.replace(/\/+$/, "") : "";
});
const canonicalUrl = computed(() => {
  if (!siteUrl.value) {
    return undefined;
  }
  const path = route.path === "/" ? "" : route.path;
  return `${siteUrl.value}${path}`;
});
const socialImageUrl = computed(() => {
  if (!socialCardUrl) {
    return undefined;
  }
  if (
    socialCardUrl.startsWith("http://") ||
    socialCardUrl.startsWith("https://")
  ) {
    return socialCardUrl;
  }
  return siteUrl.value ? `${siteUrl.value}${socialCardUrl}` : socialCardUrl;
});
const jsonLd = computed(() => ({
  "@context": "https://schema.org",
  "@type": "VideoGame",
  name: "VoxJong",
  description: pageDescription,
  applicationCategory: "Game",
  genre: "Mahjong Solitaire",
  operatingSystem: "Any",
  ...(canonicalUrl.value ? { url: canonicalUrl.value } : {}),
}));

useSeoMeta({
  title: pageTitle,
  description: pageDescription,
  robots:
    "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1",
  ogTitle: pageTitle,
  ogDescription: pageDescription,
  ogType: "website",
  ogSiteName: "VoxJong",
  ogUrl: () => canonicalUrl.value,
  ogImage: () => socialImageUrl.value,
  twitterCard: "summary_large_image",
  twitterTitle: pageTitle,
  twitterDescription: pageDescription,
  twitterImage: () => socialImageUrl.value,
});

useHead(() => ({
  link: canonicalUrl.value
    ? [{ rel: "canonical", href: canonicalUrl.value }]
    : [],
  script: [
    {
      key: "voxjong-jsonld",
      type: "application/ld+json",
      children: JSON.stringify(jsonLd.value),
    },
  ],
}));

const missingTileNames = requiredTileNames.filter(
  (name) => !tileTextures[name]
);
if (missingTileNames.length > 0) {
  throw new Error(`Missing tile images: ${missingTileNames.join(", ")}`);
}

const rotX = ref(55);
const rotY = ref(35);
const pan = ref(0);
const tilt = ref(0);
const rotXMin = 0;
const rotXMax = 89;
const rotateSpeed = 0.2;
const isometricView = { rotX: 55, rotY: 35 };
const topDownView = { rotX: 0, rotY: 90 };
const zoom = ref(1.5);
const viewMode = ref<ViewMode>("isometric");
const zoomMin = 0.65;
const zoomMaxDesktop = 2.8;
const zoomMaxCurrent = ref(zoomMaxDesktop);
const clickMoveTolerance = 11;
const pinchDistance = ref<number | null>(null);
const pointerStart = ref<{
  id: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  target: EventTarget | null;
  tileId: number | null;
  cube: HTMLElement | null;
} | null>(null);
const sceneRoot = ref<HTMLElement | null>(null);
const sceneVersion = ref(0);
let selectedCubeEls: HTMLElement[] = [];
let hintedCubeEls: HTMLElement[] = [];
let refreshRafId: number | null = null;
let viewportRafId: number | null = null;
let voxcssCameraHandle: HeadlessCameraHandle | null = null;
let voxcssRenderHandle: HeadlessRenderHandle | null = null;
let voxcssCameraElement: HTMLElement | null = null;
const wallViewSignature = ref("");

function clampZoom(value: number): number {
  return Math.min(zoomMaxCurrent.value, Math.max(zoomMin, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampRotX(value: number): number {
  return clamp(value, rotXMin, rotXMax);
}

function clampRotY(value: number, _snapPastCutoff = false): number {
  return value;
}

function normalizeDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function getWallViewSignature(nextRotX: number, nextRotY: number): string {
  const topHalf = nextRotX >= 90 ? 1 : 0;
  const normalizedY = normalizeDegrees(nextRotY);
  const yawQuadrant =
    normalizedY < 90 ? 0 : normalizedY < 180 ? 1 : normalizedY < 270 ? 2 : 3;
  return `${topHalf}:${yawQuadrant}`;
}

wallViewSignature.value = getWallViewSignature(rotX.value, rotY.value);

function setZoom(value: number): void {
  zoom.value = Math.round(clampZoom(value) * 1000) / 1000;
}

function applyZoomDelta(delta: number): void {
  setZoom(zoom.value + delta);
}

function onZoomSliderInput(event: Event): void {
  const target = event.target as HTMLInputElement | null;
  if (!target) {
    return;
  }
  const value = Number.parseFloat(target.value);
  if (!Number.isFinite(value)) {
    return;
  }
  setZoom(value);
  scheduleCubeVisualRefresh();
}

function setView(mode: ViewMode): void {
  viewMode.value = mode;
  const preset = mode === "topdown" ? topDownView : isometricView;
  rotX.value = clampRotX(preset.rotX);
  rotY.value = clampRotY(preset.rotY);
  scheduleCubeVisualRefresh();
}

function viewportShortSide(): number {
  if (typeof window === "undefined") {
    return 1024;
  }
  const viewport = window.visualViewport;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  return Math.min(viewportWidth, viewportHeight);
}

function computeViewportZoomMax(): number {
  const shortSide = viewportShortSide();

  if (shortSide <= 420) {
    return 1.15;
  }
  if (shortSide <= 540) {
    return 1.3;
  }
  if (shortSide <= 768) {
    return 1.6;
  }
  return zoomMaxDesktop;
}

function computeViewportDefaultZoom(): number {
  const shortSide = viewportShortSide();
  if (shortSide <= 420) {
    return 0.84;
  }
  if (shortSide <= 540) {
    return 0.92;
  }
  if (shortSide <= 768) {
    return 1.15;
  }
  return 1.5;
}

function updateViewportZoomBounds(): void {
  zoomMaxCurrent.value = computeViewportZoomMax();
  const clampedZoom = clampZoom(zoom.value);
  if (clampedZoom !== zoom.value) {
    zoom.value = clampedZoom;
    scheduleCubeVisualRefresh();
  }
}

function scheduleViewportZoomBoundsUpdate(): void {
  if (viewportRafId !== null) {
    return;
  }
  viewportRafId = requestAnimationFrame(() => {
    viewportRafId = null;
    updateViewportZoomBounds();
  });
}

function onWheelZoom(event: WheelEvent): void {
  const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  const speed = event.ctrlKey ? 0.01 : 0.0032;
  applyZoomDelta(-deltaY * speed);
  scheduleCubeVisualRefresh();
}

function touchDistance(touches: TouchList): number {
  const first = touches[0];
  const second = touches[1];
  if (!first || !second) {
    return 0;
  }
  return Math.hypot(
    first.clientX - second.clientX,
    first.clientY - second.clientY
  );
}

function onTouchStart(event: TouchEvent): void {
  if (event.touches.length === 2) {
    pinchDistance.value = touchDistance(event.touches);
  }
}

function onTouchMove(event: TouchEvent): void {
  if (event.touches.length !== 2) {
    return;
  }
  const nextDistance = touchDistance(event.touches);
  if (pinchDistance.value === null) {
    pinchDistance.value = nextDistance;
    return;
  }
  const distanceDelta = nextDistance - pinchDistance.value;
  pinchDistance.value = nextDistance;
  applyZoomDelta(distanceDelta * 0.0042);
  scheduleCubeVisualRefresh();
  event.preventDefault();
}

function onTouchEnd(event: TouchEvent): void {
  if (event.touches.length < 2) {
    pinchDistance.value = null;
  }
}

function preventNativeGestureZoom(event: Event): void {
  event.preventDefault();
}

const tiles = ref<GameTile[]>(createGameTiles());
const selectedTileId = ref<number | null>(null);
const totalTiles = turtleCells.length;
const elapsedSeconds = ref(0);
let timerId: ReturnType<typeof setInterval> | null = null;

const activeTiles = computed(() => tiles.value.filter((tile) => !tile.removed));
const remainingTiles = computed(() => activeTiles.value.length);
const isWon = computed(() => remainingTiles.value === 0);
const selectedTile = computed(() =>
  selectedTileId.value === null
    ? null
    : activeTiles.value.find(
        (tile) => tile.id === selectedTileId.value && !tile.removed
      ) ?? null
);

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
}

const timerLabel = computed(() => formatElapsed(elapsedSeconds.value));

function restartTimer(): void {
  elapsedSeconds.value = 0;
}

const freeTileIds = computed(() => {
  return new Set<number>(getFreeTileIds(activeTiles.value));
});
const freeTiles = computed(() =>
  activeTiles.value.filter((tile) => freeTileIds.value.has(tile.id))
);

const availablePairs = computed(() => getAvailablePairs(freeTiles.value));

const hasMoves = computed(() => availablePairs.value.length > 0);
const hintedTileIds = ref<number[]>([]);
const hintPairIndex = ref(0);
const undoStack = ref<MoveRecord[]>([]);
const redoStack = ref<MoveRecord[]>([]);
const canUndo = computed(() => undoStack.value.length > 0);
const canRedo = computed(() => redoStack.value.length > 0);

function applyMoveRemoval(move: MoveRecord): boolean {
  const first = tiles.value.find((tile) => tile.id === move.firstId);
  const second = tiles.value.find((tile) => tile.id === move.secondId);
  if (!first || !second) {
    return false;
  }
  first.removed = true;
  second.removed = true;
  return true;
}

function applyMoveRestore(move: MoveRecord): boolean {
  const first = tiles.value.find((tile) => tile.id === move.firstId);
  const second = tiles.value.find((tile) => tile.id === move.secondId);
  if (!first || !second) {
    return false;
  }
  first.removed = false;
  second.removed = false;
  return true;
}

function recordRemovedPair(firstId: number, secondId: number): void {
  undoStack.value.push({ firstId, secondId });
  redoStack.value = [];
}

function clearMoveHistory(): void {
  undoStack.value = [];
  redoStack.value = [];
}

function undoMove(): void {
  const move = undoStack.value.pop();
  if (!move) {
    return;
  }
  if (!applyMoveRestore(move)) {
    undoStack.value.push(move);
    return;
  }
  redoStack.value.push(move);
  clearSelectionAndHintState();
  sceneVersion.value += 1;
  scheduleCubeVisualRefresh();
}

function redoMove(): void {
  const move = redoStack.value.pop();
  if (!move) {
    return;
  }
  if (!applyMoveRemoval(move)) {
    redoStack.value.push(move);
    return;
  }
  undoStack.value.push(move);
  clearSelectionAndHintState();
  sceneVersion.value += 1;
  scheduleCubeVisualRefresh();
}

function parseGridLine(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGridArea(
  value: string
): { x: number; y: number; x2: number; y2: number } | null {
  const [xText, yText, x2Text, y2Text] = value.split("/");
  const x = parseGridLine(xText);
  const y = parseGridLine(yText);
  const x2 = parseGridLine(x2Text);
  const y2 = parseGridLine(y2Text);
  if (x === null || y === null || x2 === null || y2 === null) {
    return null;
  }
  return { x, y, x2, y2 };
}

function resolveTileFromGridArea(target: EventTarget | null): GameTile | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  const cube = target.closest(".voxcss-cube") as HTMLElement | null;
  const tileIdText = cube?.dataset.tileId;
  if (tileIdText) {
    const tileId = Number.parseInt(tileIdText, 10);
    if (Number.isFinite(tileId)) {
      const byId = activeTiles.value.find((entry) => entry.id === tileId);
      if (byId) {
        return byId;
      }
    }
  }

  let node: HTMLElement | null = target;
  while (node && node !== sceneRoot.value && !node.style.gridArea) {
    node = node.parentElement;
  }
  if (!node || !node.style.gridArea) {
    return null;
  }

  const parsedArea = parseGridArea(node.style.gridArea);
  if (!parsedArea) {
    return null;
  }

  const layer = node.closest(".voxcss-layer") as HTMLElement | null;
  let layerZ: number | null = null;
  if (layer && sceneRoot.value) {
    const layers = Array.from(
      sceneRoot.value.querySelectorAll<HTMLElement>(".voxcss-layer")
    );
    const index = layers.indexOf(layer);
    if (index >= 0) {
      layerZ = index;
    }
  }

  const candidates = activeTiles.value.filter(
    (tile) =>
      (layerZ === null || tile.z === layerZ) &&
      tile.gridX === parsedArea.x &&
      tile.gridY === parsedArea.y &&
      tile.gridX2 === parsedArea.x2 &&
      tile.gridY2 === parsedArea.y2
  );

  const fallbackCandidates =
    candidates.length > 0
      ? candidates
      : activeTiles.value.filter(
          (tile) =>
            tile.gridX === parsedArea.x &&
            tile.gridY === parsedArea.y &&
            tile.gridX2 === parsedArea.x2 &&
            tile.gridY2 === parsedArea.y2
        );
  if (!fallbackCandidates.length) {
    return null;
  }
  return (
    [...fallbackCandidates].sort((left, right) => right.z - left.z)[0] ?? null
  );
}

function resolveTileFromPoint(
  clientX: number,
  clientY: number
): GameTile | null {
  const doc = sceneRoot.value?.ownerDocument ?? document;
  const target = doc.elementFromPoint(clientX, clientY);
  return resolveTileFromGridArea(target);
}

function resolveCubeFromPoint(
  clientX: number,
  clientY: number
): HTMLElement | null {
  const doc = sceneRoot.value?.ownerDocument ?? document;
  const target = doc.elementFromPoint(clientX, clientY);
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest(".voxcss-cube") as HTMLElement | null;
}

function clearHintCubeVisual(): void {
  for (const cube of hintedCubeEls) {
    cube.classList.remove("is-hint");
  }
  hintedCubeEls = [];
}

function clearHintState(): void {
  hintedTileIds.value = [];
  hintPairIndex.value = 0;
  clearHintCubeVisual();
}

function clearSelectionAndHintState(): void {
  selectedTileId.value = null;
  clearSelectedCubeVisual();
  clearHintState();
}

function clearSelectedCubeVisual(): void {
  for (const cube of selectedCubeEls) {
    cube.classList.remove("is-active");
  }
  selectedCubeEls = [];
}

function setSelectedCubeVisual(
  tile: GameTile | null,
  preferredCube: HTMLElement | null = null
): void {
  clearSelectedCubeVisual();
  const cubes = tile ? findCubesForTile(tile) : [];
  if (preferredCube && !cubes.includes(preferredCube)) {
    cubes.unshift(preferredCube);
  }
  if (cubes.length === 0) {
    return;
  }
  for (const cube of cubes) {
    cube.classList.add("is-active");
  }
  selectedCubeEls = cubes;
}

function findCubesForTile(tile: GameTile): HTMLElement[] {
  const root = sceneRoot.value;
  if (!root) {
    return [];
  }
  const layers = Array.from(
    root.querySelectorAll<HTMLElement>(".voxcss-layer")
  );
  const layer = layers[tile.z];
  if (!layer) {
    return [];
  }
  const cubes = Array.from(layer.querySelectorAll<HTMLElement>(".voxcss-cube"));
  return cubes.filter((cube) => {
    const area = parseGridArea(cube.style.gridArea);
    return (
      area &&
      area.x === tile.gridX &&
      area.y === tile.gridY &&
      area.x2 === tile.gridX2 &&
      area.y2 === tile.gridY2
    );
  });
}

function syncCubeTileBindings(): void {
  const root = sceneRoot.value;
  if (!root) {
    return;
  }
  const allCubes = Array.from(
    root.querySelectorAll<HTMLElement>(".voxcss-cube")
  );
  for (const cube of allCubes) {
    delete cube.dataset.tileId;
  }

  for (const tile of activeTiles.value) {
    const cubes = findCubesForTile(tile);
    if (cubes.length === 0) {
      continue;
    }
    for (const cube of cubes) {
      cube.dataset.tileId = String(tile.id);
    }
  }
}

function syncCubeInteractivity(): void {
  const root = sceneRoot.value;
  if (!root) {
    return;
  }
  const allCubes = Array.from(
    root.querySelectorAll<HTMLElement>(".voxcss-cube")
  );
  for (const cube of allCubes) {
    cube.classList.remove("is-selectable", "is-blocked");
  }
  for (const tile of activeTiles.value) {
    const cubes = findCubesForTile(tile);
    if (cubes.length === 0) {
      continue;
    }
    const selectable = freeTileIds.value.has(tile.id);
    for (const cube of cubes) {
      cube.classList.add(selectable ? "is-selectable" : "is-blocked");
    }
  }
}

function refreshSelectionVisual(): void {
  const tile = selectedTile.value;
  if (!tile) {
    clearSelectedCubeVisual();
    return;
  }
  const cubes = findCubesForTile(tile);
  if (cubes.length === 0) {
    clearSelectedCubeVisual();
    return;
  }
  setSelectedCubeVisual(tile);
}

function refreshHintVisual(): void {
  clearHintCubeVisual();
  if (hintedTileIds.value.length !== 2) {
    return;
  }
  for (const id of hintedTileIds.value) {
    const tile = activeTiles.value.find((entry) => entry.id === id);
    if (!tile) {
      continue;
    }
    const cubes = findCubesForTile(tile);
    if (cubes.length === 0) {
      continue;
    }
    for (const cube of cubes) {
      cube.classList.add("is-hint");
      hintedCubeEls.push(cube);
    }
  }
}

function refreshCubeVisuals(): void {
  syncCubeTileBindings();
  syncCubeInteractivity();
  refreshSelectionVisual();
  refreshHintVisual();
}

function scheduleCubeVisualRefresh(): void {
  if (refreshRafId !== null) {
    return;
  }
  refreshRafId = requestAnimationFrame(() => {
    refreshRafId = null;
    refreshCubeVisuals();
  });
}

function showHint(): void {
  const pairs = availablePairs.value;
  if (remainingTiles.value <= 0 || pairs.length === 0) {
    clearHintState();
    return;
  }

  let sourcePairs = pairs;
  const selectedId = selectedTileId.value;
  if (selectedId !== null) {
    const preferredPairs = pairs.filter(
      ([left, right]) => left === selectedId || right === selectedId
    );
    if (preferredPairs.length === 0) {
      clearHintState();
      return;
    }
    sourcePairs = preferredPairs;
  }

  const pair = sourcePairs[hintPairIndex.value % sourcePairs.length];
  if (!pair) {
    clearHintState();
    return;
  }
  hintPairIndex.value = (hintPairIndex.value + 1) % sourcePairs.length;
  hintedTileIds.value = [pair[0], pair[1]];
  refreshHintVisual();
}

function selectTile(tile: GameTile, cube: HTMLElement | null): void {
  const selectedId = selectedTileId.value;

  if (hintedTileIds.value.length > 0) {
    clearHintState();
  }

  if (selectedId === tile.id) {
    selectedTileId.value = null;
    clearSelectedCubeVisual();
    scheduleCubeVisualRefresh();
    return;
  }

  const clickedIsFree = freeTileIds.value.has(tile.id);
  if (!clickedIsFree) {
    scheduleCubeVisualRefresh();
    return;
  }

  if (selectedId === null) {
    selectedTileId.value = tile.id;
    setSelectedCubeVisual(tile, cube);
    scheduleCubeVisualRefresh();
    return;
  }

  const selectedTile = tiles.value.find((entry) => entry.id === selectedId);
  if (!selectedTile || selectedTile.removed) {
    selectedTileId.value = tile.id;
    setSelectedCubeVisual(tile, cube);
    scheduleCubeVisualRefresh();
    return;
  }

  const selectedIsFree = freeTileIds.value.has(selectedTile.id);
  if (
    selectedIsFree &&
    clickedIsFree &&
    canPair(selectedTile.code, tile.code)
  ) {
    const removedFirstId = selectedTile.id;
    const removedSecondId = tile.id;
    selectedTile.removed = true;
    tile.removed = true;
    recordRemovedPair(removedFirstId, removedSecondId);
    selectedTileId.value = null;
    clearSelectedCubeVisual();
    clearHintState();
    // Force a scene remount to avoid stale cubes lingering after pair removal.
    sceneVersion.value += 1;
    scheduleCubeVisualRefresh();
    return;
  }

  selectedTileId.value = tile.id;
  setSelectedCubeVisual(tile, cube);
  scheduleCubeVisualRefresh();
}

function onScenePointerDown(event: PointerEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const cube = target?.closest(".voxcss-cube") as HTMLElement | null;
  const downTile = cube ? resolveTileFromGridArea(cube) : null;
  pointerStart.value = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    target: cube,
    tileId: downTile?.id ?? null,
    cube: cube ?? null,
  };
}

function onScenePointerMove(event: PointerEvent): void {
  if (event.buttons === 0) {
    return;
  }
  const start = pointerStart.value;
  if (!start || start.id !== event.pointerId) {
    return;
  }
  const deltaX = event.clientX - start.lastX;
  const deltaY = event.clientY - start.lastY;
  if (deltaX !== 0 || deltaY !== 0) {
    rotY.value = clampRotY(rotY.value - deltaX * rotateSpeed, true);
    rotX.value = clampRotX(rotX.value - deltaY * rotateSpeed);
    start.lastX = event.clientX;
    start.lastY = event.clientY;
  }
  scheduleCubeVisualRefresh();
}

function onScenePointerUp(event: PointerEvent): void {
  const start = pointerStart.value;
  pointerStart.value = null;
  if (!start || start.id !== event.pointerId) {
    return;
  }

  const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
  if (moved > clickMoveTolerance) {
    scheduleCubeVisualRefresh();
    return;
  }

  const startTile =
    start.tileId !== null
      ? activeTiles.value.find((entry) => entry.id === start.tileId) ?? null
      : null;
  const pointTile = resolveTileFromPoint(event.clientX, event.clientY);
  const tile = pointTile ?? startTile;
  if (!tile) {
    clearSelectionAndHintState();
    scheduleCubeVisualRefresh();
    return;
  }
  const cube = start.cube ?? resolveCubeFromPoint(event.clientX, event.clientY);
  selectTile(tile, cube);
  scheduleCubeVisualRefresh();
}

function onScenePointerCancel(): void {
  pointerStart.value = null;
}

function buildSceneState(nextVoxels: SceneState["voxels"]): SceneState {
  return {
    voxels: nextVoxels,
    projection: "dimetric",
    showFloor: false,
    showWalls: false,
    mergeVoxels: false,
  };
}

function syncVoxcssCamera(): void {
  if (!voxcssCameraHandle) {
    return;
  }
  voxcssCameraHandle.update({
    zoom: zoom.value,
    pan: pan.value,
    tilt: tilt.value,
    rotX: rotX.value,
    rotY: rotY.value,
    interactive: false,
    animate: false,
    perspective: 8000,
  });
}

function destroyVoxcssScene(): void {
  if (voxcssRenderHandle) {
    voxcssRenderHandle.destroy();
    voxcssRenderHandle = null;
    voxcssCameraHandle = null;
  } else if (voxcssCameraHandle) {
    voxcssCameraHandle.destroy();
    voxcssCameraHandle = null;
  }

  if (voxcssCameraElement?.parentElement) {
    voxcssCameraElement.parentElement.removeChild(voxcssCameraElement);
  }
  voxcssCameraElement = null;

  const root = sceneRoot.value;
  if (root) {
    const staleCameras = Array.from(
      root.querySelectorAll<HTMLElement>(".voxcss-camera")
    );
    for (const cameraNode of staleCameras) {
      cameraNode.remove();
    }
  }
}

function mountVoxcssScene(): void {
  const root = sceneRoot.value;
  if (!root) {
    return;
  }

  destroyVoxcssScene();
  const doc = root.ownerDocument ?? document;
  voxcssCameraElement = doc.createElement("div");
  voxcssCameraHandle = createCamera({
    element: voxcssCameraElement,
    zoom: zoom.value,
    pan: pan.value,
    tilt: tilt.value,
    rotX: rotX.value,
    rotY: rotY.value,
    interactive: false,
    animate: false,
    perspective: 8000,
  });
  voxcssRenderHandle = renderScene({
    element: root,
    camera: voxcssCameraHandle,
    scene: buildSceneState(voxels.value),
  });
}

onMounted(() => {
  updateViewportZoomBounds();
  zoom.value = clampZoom(computeViewportDefaultZoom());
  window.addEventListener("resize", scheduleViewportZoomBoundsUpdate, {
    passive: true,
  });
  window.addEventListener(
    "orientationchange",
    scheduleViewportZoomBoundsUpdate,
    {
      passive: true,
    }
  );
  window.visualViewport?.addEventListener(
    "resize",
    scheduleViewportZoomBoundsUpdate
  );
  document.addEventListener("gesturestart", preventNativeGestureZoom, {
    passive: false,
  });
  document.addEventListener("gesturechange", preventNativeGestureZoom, {
    passive: false,
  });
  document.addEventListener("gestureend", preventNativeGestureZoom, {
    passive: false,
  });

  timerId = setInterval(() => {
    if (!isWon.value) {
      elapsedSeconds.value += 1;
    }
  }, 1000);
  requestAnimationFrame(() => {
    rotX.value = clampRotX(rotX.value);
    rotY.value = clampRotY(rotY.value);
    mountVoxcssScene();
    syncVoxcssCamera();
    refreshCubeVisuals();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", scheduleViewportZoomBoundsUpdate);
  window.removeEventListener(
    "orientationchange",
    scheduleViewportZoomBoundsUpdate
  );
  window.visualViewport?.removeEventListener(
    "resize",
    scheduleViewportZoomBoundsUpdate
  );
  document.removeEventListener("gesturestart", preventNativeGestureZoom);
  document.removeEventListener("gesturechange", preventNativeGestureZoom);
  document.removeEventListener("gestureend", preventNativeGestureZoom);
  if (viewportRafId !== null) {
    cancelAnimationFrame(viewportRafId);
    viewportRafId = null;
  }
  destroyVoxcssScene();
  clearSelectedCubeVisual();
  clearHintCubeVisual();
  if (refreshRafId !== null) {
    cancelAnimationFrame(refreshRafId);
    refreshRafId = null;
  }
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
});

function newGame(): void {
  sceneVersion.value += 1;
  tiles.value = createGameTiles();
  pinchDistance.value = null;
  pointerStart.value = null;
  clearMoveHistory();
  clearSelectionAndHintState();
  restartTimer();
  scheduleCubeVisualRefresh();
}

const voxels = computed(() => {
  return activeTiles.value.map((tile) => {
    const isFree = freeTileIds.value.has(tile.id);
    const color = isFree ? "#f4e4bf" : "#dcc89f";
    return {
      x: tile.gridX,
      y: tile.gridY,
      z: tile.z,
      x2: tile.gridX2,
      y2: tile.gridY2,
      color,
      texture: tileTextures[tile.code] ?? tileTextures.Man1,
      shape: "cube" as const,
    };
  });
});

watch(
  [zoom, pan, tilt, rotX, rotY],
  () => {
    const nextSignature = getWallViewSignature(rotX.value, rotY.value);
    if (nextSignature !== wallViewSignature.value) {
      wallViewSignature.value = nextSignature;
      mountVoxcssScene();
    }
    syncVoxcssCamera();
    scheduleCubeVisualRefresh();
  },
  { flush: "post" }
);

watch(
  voxels,
  (nextVoxels) => {
    if (!voxcssRenderHandle) {
      return;
    }
    voxcssRenderHandle.setScene(buildSceneState(nextVoxels));
    scheduleCubeVisualRefresh();
  },
  { flush: "post" }
);

watch(
  sceneVersion,
  () => {
    mountVoxcssScene();
    scheduleCubeVisualRefresh();
  },
  { flush: "post" }
);
</script>

<template>
  <div class="app">
    <section
      ref="sceneRoot"
      class="scene"
      @pointerdown.capture="onScenePointerDown"
      @pointermove.capture="onScenePointerMove"
      @pointerup.capture="onScenePointerUp"
      @pointercancel.capture="onScenePointerCancel"
      @wheel.prevent="onWheelZoom"
      @touchstart="onTouchStart"
      @touchmove.prevent="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
    />

    <header class="sidebar">
      <div class="brand">
        <h1 class="sr-only">VoxJong 3D Mahjong Solitaire</h1>
        <div class="brand-mark">
          <img class="logo" :src="logoUrl" alt="VoxJong" />
          <span class="logo-version">v0.2</span>
        </div>
      </div>

      <div class="controls">
        <button type="button" class="chip chip--button" @click="newGame">
          <span class="chip-button-label">New Game</span>
          <span class="chip-button-suit" aria-hidden="true">&hearts;</span>
        </button>
        <button
          type="button"
          class="chip chip--button chip--hint"
          :disabled="remainingTiles === 0 || !hasMoves"
          @click="showHint"
        >
          <span class="chip-button-label">Hints</span>
          <span class="chip-button-suit" aria-hidden="true">&diamondsuit;</span>
        </button>
        <div style="display: flex; gap: 2px; align-items: center">
          <button
            type="button"
            class="chip chip--button"
            :disabled="!canUndo"
            @click="undoMove"
          >
            <span class="chip-button-label">Undo</span>
          </button>
          <span>|</span>
          <button
            type="button"
            class="chip chip--button"
            :disabled="!canRedo"
            @click="redoMove"
          >
            <span class="chip-button-label">Redo</span>
          </button>
        </div>
        <article class="chip chip--timer">
          <strong>Time:</strong>
          <span class="chip-value">{{ timerLabel }}</span>
        </article>
        <article class="chip chip--tiles">
          <strong>Tiles:</strong>
          <span class="chip-value">{{ remainingTiles }}/{{ totalTiles }}</span>
        </article>
      </div>
    </header>

    <div class="zoom-dock">
      <div class="dock-row">
        <span class="zoom-label">View:</span>
        <div class="view-options" role="radiogroup" aria-label="View">
          <label
            class="view-option"
            :class="{ 'is-active': viewMode === 'isometric' }"
          >
            <input
              class="view-radio"
              type="radio"
              name="view-mode"
              value="isometric"
              :checked="viewMode === 'isometric'"
              @change="setView('isometric')"
            />
            <span>Isometric</span>
          </label>
          <span class="view-separator">/</span>
          <label
            class="view-option"
            :class="{ 'is-active': viewMode === 'topdown' }"
          >
            <input
              class="view-radio"
              type="radio"
              name="view-mode"
              value="topdown"
              :checked="viewMode === 'topdown'"
              @change="setView('topdown')"
            />
            <span>Top Down</span>
          </label>
        </div>
      </div>
      <div class="dock-row">
        <label class="zoom-label" for="zoom-slider">Zoom:</label>
        <input
          id="zoom-slider"
          class="zoom-slider"
          type="range"
          :min="zoomMin"
          :max="zoomMaxCurrent"
          step="0.01"
          :value="zoom"
          aria-label="Zoom"
          @input="onZoomSliderInput"
        />
      </div>
    </div>

    <a
      class="btn-github"
      rel="noopener"
      target="_blank"
      aria-label="View source on GitHub"
      href="https://github.com/LayoutitStudio/voxjong"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="55"
        height="55"
        viewBox="0 0 250 250"
      >
        <path d="M0 0l115 115h15l12 27 108 108V0z" fill="#fff" />
        <path
          class="octo-arm"
          d="M128 109c-15-9-9-19-9-19 3-7 2-11 2-11-1-7 3-2 3-2 4 5 2 11 2 11-3 10 5 15 9 16"
        />
        <path
          class="octo-body"
          d="M115 115s4 2 5 0l14-14c3-2 6-3 8-3-8-11-15-24 2-41 5-5 10-7 16-7 1-2 3-7 12-11 0 0 5 3 7 16 4 2 8 5 12 9s7 8 9 12c14 3 17 7 17 7-4 8-9 11-11 11 0 6-2 11-7 16-16 16-30 10-41 2 0 3-1 7-5 11l-12 11c-1 1 1 5 1 5z"
        />
      </svg>
    </a>

    <div v-if="isWon" class="win-overlay" role="status" aria-live="polite">
      <div class="win-emoji" aria-hidden="true">🀄</div>
      <div class="win-title">You Win</div>
      <div class="win-time">Time: {{ timerLabel }}</div>
    </div>
  </div>
</template>

<style scoped>
:global(html),
:global(body),
:global(#__nuxt) {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  overscroll-behavior: none;
}

.app {
  --ui-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  --ui-font-size: 14px;
  --ui-line-height: 1.2;
  --ui-color: #dfcc91;
  --ui-color-muted: #cdbb85;
  --ui-color-hover: #e6d39a;
  --ui-color-active: #f0e0ac;
  --ui-track: #a6945f;
  --ui-track-hover: #b8a56d;
  --ui-track-active: #c5b278;
  --ui-thumb-border: #ceb565;
  --ui-thumb-border-hover: #d9c075;
  --ui-thumb-border-active: #e1ca7d;
  --ui-thumb: #ebd796;
  --ui-thumb-hover: #f0e0ab;
  --ui-thumb-active: #f6e7b8;
  --ui-gap-s: 6px;
  --ui-gap-m: 10px;
  position: fixed;
  inset: 0;
  overflow: hidden;
  -webkit-user-select: none;
  user-select: none;
  touch-action: none;
  overscroll-behavior: none;
  background: radial-gradient(
    circle at center,
    #2a7f49 0%,
    #1a6a3b 44%,
    #0d4727 100%
  );
}

.logo {
  display: block;
  height: 50px;
  width: auto;
  object-fit: contain;
  margin-left: -8px;
  margin-top: 5px;
}

.brand-mark {
  display: inline-flex;
  align-items: flex-end;
  gap: 4px;
}

.logo-version {
  font-size: 12px;
  line-height: 1;
  color: var(--ui-color-muted);
  margin-bottom: 9px;
  opacity: 0.75;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.chip {
  border: 0;
  outline: 0;
  background: none;
  color: inherit;
  padding: 0;
  min-height: 1.4rem;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  box-sizing: border-box;
  font-family: inherit;
  font-size: var(--ui-font-size);
  line-height: var(--ui-line-height);
  font-weight: 400;
  gap: 0.35rem;
}

.chip--button {
  appearance: none;
  cursor: pointer;
  transition: color 140ms ease, transform 100ms ease;
  color: var(--ui-color-muted);
}

.chip-button-label {
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
  text-decoration-color: currentColor;
}

.chip-button-suit {
  text-decoration: none;
}

.chip--button:hover:not(:disabled) {
  color: var(--ui-color-hover);
  transform: translateX(1px);
}

.chip--button:active:not(:disabled) {
  color: var(--ui-color-active);
  transform: translateY(1px) scale(0.99);
}

.chip--button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.scene {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
}

.scene :deep(.voxcss-camera) {
  width: 100%;
  height: 100%;
  min-height: 100%;
}

.scene :deep(.voxcss-floor-z) {
  background: transparent !important;
  background-image: none !important;
}

.scene :deep(.voxcss-cube-face) {
  background-color: #e6d8b8;
  cursor: default;
}

.scene :deep(.voxcss-cube-face--t) {
  background-color: #f6ead0 !important;
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
  background-origin: content-box;
  background-clip: border-box;
  padding: 6px;
  transform: translateZ(var(--voxcss-layer-half)) rotate(-90deg);
}

.scene :deep(.voxcss-projection--dimetric .voxcss-cube-face--t) {
  transform: translateZ(0) rotate(-90deg);
}

.scene :deep(.voxcss-cube-face--b),
.scene :deep(.voxcss-cube-face--bl),
.scene :deep(.voxcss-cube-face--br),
.scene :deep(.voxcss-cube-face--fl),
.scene :deep(.voxcss-cube-face--fr) {
  background-color: #e1d2af !important;
  background-image: none !important;
}

.scene :deep(.voxcss-cube.is-hint .voxcss-cube-face) {
  background-color: #ffe5a8 !important;
}

.scene :deep(.voxcss-cube.is-active .voxcss-cube-face) {
  background-color: #ffcb87 !important;
}

@media (hover: hover) and (pointer: fine) {
  .scene
    :deep(
      .voxcss-cube.is-selectable:not(.is-active):not(.is-hint):hover
        .voxcss-cube-face
    ) {
    background-color: #ffe5a8 !important;
  }
}

.scene :deep(.voxcss-cube.is-selectable .voxcss-cube-face) {
  cursor: pointer;
}

.scene :deep(.voxcss-cube.is-blocked .voxcss-cube-face) {
  cursor: not-allowed;
}

.scene :deep(.voxcss-cube.is-blocked) {
  background-color: #f6ead0;
}

.scene :deep(.voxcss-cube.is-blocked .voxcss-cube-face--t) {
  opacity: 0.5;
}

.sidebar {
  position: absolute;
  top: 0px;
  left: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ui-gap-m);
  padding: 5px 15px;
  font-family: var(--ui-font-family);
  font-size: var(--ui-font-size);
  line-height: var(--ui-line-height);
  color: var(--ui-color);
}

.btn-github {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 30;
  line-height: 0;
  color: #104d2b;
}

.btn-github svg {
  display: block;
  fill: currentColor;
}

.btn-github .octo-arm {
  transform-origin: 130px 106px;
}

.btn-github:hover .octo-arm {
  animation: octocat-wave 560ms ease-in-out;
}

@keyframes octocat-wave {
  0%,
  100% {
    transform: rotate(0);
  }
  20%,
  60% {
    transform: rotate(-26deg);
  }
  40%,
  80% {
    transform: rotate(12deg);
  }
}

.brand {
  display: grid;
  gap: var(--ui-gap-s);
  min-width: 160px;
}

.controls {
  display: grid;
  gap: var(--ui-gap-s);
  align-items: start;
  justify-items: start;
}

.zoom-dock {
  position: absolute;
  left: 15px;
  bottom: 12px;
  z-index: 20;
  display: grid;
  gap: var(--ui-gap-s);
  color: var(--ui-color);
  font-family: var(--ui-font-family);
  font-size: var(--ui-font-size);
  line-height: var(--ui-line-height);
}

.dock-row {
  display: flex;
  align-items: center;
  gap: var(--ui-gap-s);
}

.zoom-label {
  font-weight: 700;
}

.zoom-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 96px;
  height: 14px;
  margin: 0;
  background: transparent;
}

.zoom-slider:focus {
  outline: none;
}

.zoom-slider::-webkit-slider-runnable-track {
  height: 2px;
  border-radius: 999px;
  background: var(--ui-track);
}

.zoom-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: -4px;
  border: 1px solid var(--ui-thumb-border);
  background: var(--ui-thumb);
}

.zoom-slider:hover::-webkit-slider-runnable-track {
  background: var(--ui-track-hover);
}

.zoom-slider:hover::-webkit-slider-thumb {
  border-color: var(--ui-thumb-border-hover);
  background: var(--ui-thumb-hover);
}

.zoom-slider:active::-webkit-slider-runnable-track {
  background: var(--ui-track-active);
}

.zoom-slider:active::-webkit-slider-thumb {
  border-color: var(--ui-thumb-border-active);
  background: var(--ui-thumb-active);
}

.zoom-slider::-moz-range-track {
  height: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--ui-track);
}

.zoom-slider::-moz-range-progress {
  height: 2px;
  border-radius: 999px;
  background: var(--ui-track-active);
}

.zoom-slider::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--ui-thumb-border);
  background: var(--ui-thumb);
}

.zoom-slider:hover::-moz-range-track {
  background: var(--ui-track-hover);
}

.zoom-slider:hover::-moz-range-thumb {
  border-color: var(--ui-thumb-border-hover);
  background: var(--ui-thumb-hover);
}

.view-options {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.view-option {
  display: inline-flex;
  align-items: center;
  color: var(--ui-color-muted);
  cursor: pointer;
}

.view-option:hover {
  color: var(--ui-color-hover);
}

.view-option.is-active {
  color: var(--ui-color-active);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

.view-radio {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.view-option:focus-within {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.view-separator {
  margin: 0;
  color: var(--ui-color-muted);
}

.chip strong {
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  font-weight: 700;
}

.chip-value {
  font-weight: 400;
}

.chip--timer .chip-value {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}

.win-overlay {
  position: absolute;
  inset: 0;
  z-index: 25;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: var(--ui-gap-s);
  pointer-events: none;
  color: #f7e6b2;
  font-family: var(--ui-font-family);
  font-size: 14px;
  text-align: center;
}

.win-emoji {
  font-size: 52px;
  line-height: 1;
  margin-bottom: 10px;
}

.win-title {
  font-size: 22px;
  line-height: 1;
  font-weight: 700;
}

.win-time {
  font-size: 14px;
  line-height: var(--ui-line-height);
}

@media (max-width: 640px) {
  .logo {
    height: 46px;
  }

  .logo-version {
    font-size: 11px;
    margin-bottom: 8px;
  }

  .brand {
    min-width: 0;
  }

  .sidebar {
    top: 8px;
    padding: 6px 8px;
  }

  .zoom-dock {
    left: 8px;
    bottom: 8px;
    font-size: 14px;
  }

  .zoom-slider {
    width: 84px;
  }
}
</style>
