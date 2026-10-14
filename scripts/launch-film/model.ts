export type Product = "desktop" | "mobile";

export type PointerAction = {
  kind: "drag" | "tap";
  frame: number;
  endFrame?: number;
  x: number;
  y: number;
  toX?: number;
  toY?: number;
};
export type Shot = {
  id: string;
  heading: string;
  subtext?: string;
  /** Cards have no source range and use duration; footage uses exact source frames. */
  duration?: number;
  from?: number;
  to?: number;
  rate?: number;
  holdBefore?: number;
  holdAfter?: number;
  crop?: { x: number; y: number; width: number; height: number };
  pointers?: PointerAction[];
};
export type CaptureManifest = {
  product: Product;
  width: number;
  height: number;
  fps: number;
  cursorBaked: boolean;
  shots: Shot[];
};
export type PlannedShot = Shot & {
  startFrame: number;
  frames: number;
  motionFrames: number;
  beforeFrames: number;
  afterFrames: number;
};

export function planFilm(value: unknown, product: Product, width: number, height: number, fps: number, sourceFrames: number): { manifest: CaptureManifest; shots: PlannedShot[]; frames: number } {
  if (!value || typeof value !== "object") throw new Error("The film manifest must be an object.");
  const manifest = value as CaptureManifest;
  if (manifest.product !== product || manifest.width !== width || manifest.height !== height || !Number.isFinite(manifest.fps) || Math.abs(manifest.fps - fps) > 0.01) {
    throw new Error("Film manifest product, raster, and fps must match the actual capture.");
  }
  if (typeof manifest.cursorBaked !== "boolean" || !Array.isArray(manifest.shots) || !manifest.shots.length) {
    throw new Error("A film needs cursorBaked and a non-empty shot list.");
  }
  const ids = new Set<string>();
  let frames = 0;
  const shots = manifest.shots.map((shot): PlannedShot => {
    if (!shot || typeof shot.id !== "string" || !shot.id || ids.has(shot.id)) throw new Error("Each shot needs a unique id.");
    ids.add(shot.id);
    if (typeof shot.heading !== "string" || !shot.heading || (shot.subtext !== undefined && typeof shot.subtext !== "string")) {
      throw new Error(`Shot ${shot.id} needs a heading and optional text subheading.`);
    }
    const card = shot.from === undefined && shot.to === undefined;
    const rate = shot.rate ?? 1;
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid playback rate in ${shot.id}.`);
    for (const hold of [shot.holdBefore ?? 0, shot.holdAfter ?? 0]) {
      if (!Number.isFinite(hold) || hold < 0) throw new Error(`Invalid hold in ${shot.id}.`);
    }
    if (card) {
      if (!Number.isFinite(shot.duration) || shot.duration! <= 0 || shot.crop || shot.pointers?.length) throw new Error(`Invalid card ${shot.id}.`);
    } else if (!Number.isInteger(shot.from) || !Number.isInteger(shot.to) || shot.from! < 0 || shot.to! <= shot.from! || shot.to! > sourceFrames || shot.duration !== undefined) {
      throw new Error(`Shot ${shot.id} must select an existing, non-empty source-frame range [from, to).`);
    }
    if (shot.crop) {
      const crop = shot.crop;
      if (![crop.x, crop.y, crop.width, crop.height].every(Number.isInteger) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > width || crop.y + crop.height > height) {
        throw new Error(`Crop outside source raster in ${shot.id}.`);
      }
    }
    if (shot.pointers !== undefined && !Array.isArray(shot.pointers)) throw new Error(`Invalid pointer list in ${shot.id}.`);
    for (const pointer of shot.pointers ?? []) {
      if (manifest.cursorBaked) throw new Error("Do not overlay a second cursor on a baked-cursor capture.");
      if (pointer.kind !== "drag" && pointer.kind !== "tap") throw new Error(`Invalid pointer kind in ${shot.id}.`);
      if (!Number.isInteger(pointer.frame) || pointer.frame < shot.from! || pointer.frame >= shot.to!) throw new Error(`Pointer outside shot ${shot.id}.`);
      if (pointer.kind === "drag" && (!Number.isInteger(pointer.endFrame) || pointer.endFrame! <= pointer.frame || pointer.endFrame! >= shot.to!)) throw new Error(`Invalid drag range in ${shot.id}.`);
      const coordinates = [[pointer.x, width], [pointer.y, height]];
      if (pointer.kind === "drag") coordinates.push([pointer.toX!, width], [pointer.toY!, height]);
      if (coordinates.some(([coordinate, limit]) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > limit)) throw new Error(`Pointer outside source raster in ${shot.id}.`);
    }
    const beforeFrames = card ? 0 : Math.round((shot.holdBefore ?? 0) * 60);
    const afterFrames = card ? 0 : Math.round((shot.holdAfter ?? 0) * 60);
    const motionFrames = card ? Math.round(shot.duration! * 60) : Math.round((shot.to! - shot.from!) / fps / rate * 60);
    const count = beforeFrames + motionFrames + afterFrames;
    if (count < 1) throw new Error(`Empty shot ${shot.id}.`);
    const result = { ...shot, startFrame: frames, frames: count, motionFrames, beforeFrames, afterFrames };
    frames += count;
    return result;
  });
  if (!shots.some((shot) => shot.from !== undefined)) throw new Error("A launch film needs real footage, not only title cards.");
  if (frames >= 60 * 60) throw new Error("Launch films must be under one minute.");
  return { manifest, shots, frames };
}
