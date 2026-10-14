import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { planFilm, type CaptureManifest, type PlannedShot, type Product } from "./model";

const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;
const FONT = resolve(import.meta.dir, "../../public/fonts/Hack-Regular.ttf");
const BOLD = resolve(import.meta.dir, "../../public/fonts/Hack-Bold.ttf");
const BACKGROUND = "#080a0e";
const PHONE = { x: 1230, y: 90, width: 430, height: 900 };
const DESKTOP = { x: 192, y: 188, width: 1536, height: 864 };

type RenderOptions = { product: Product; input: string; outputDir: string; manifestPath: string; soundtrack: string; gifStart?: number };
type Probe = { streams: Array<{ codec_type: string; width?: number; height?: number; avg_frame_rate?: string; nb_frames?: string }>; format: { duration: string } };
type Raster = { width: number; height: number; fps: number; frames: number; duration: number };

function n(value: number): string { return value.toFixed(6); }
function quote(value: string): string { return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "'\\''")}'`; }
function filterQuote(value: string): string { return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "'\\\\\\''").replaceAll(":", "\\:")}'`; }

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0]} failed (${code}).`);
}

async function probe(ffprobe: string, input: string): Promise<Raster> {
  const child = Bun.spawn([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", input], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr);
  const data = JSON.parse(stdout) as Probe;
  const video = data.streams.find((stream) => stream.codec_type === "video");
  const rate = video?.avg_frame_rate?.split("/").map(Number);
  const fps = rate?.length === 2 ? rate[0] / rate[1] : NaN;
  const duration = Number(data.format.duration);
  const frames = Number(video?.nb_frames);
  if (!video?.width || !video.height || !Number.isFinite(fps) || fps <= 0 || !Number.isInteger(frames) || frames <= 0 || !Number.isFinite(duration)) {
    throw new Error("Capture must have known raster dimensions, frame rate, duration and frame count.");
  }
  return { width: video.width, height: video.height, fps, frames, duration };
}

function stageFor(product: Product, shot: PlannedShot): typeof DESKTOP {
  if (product === "mobile") return PHONE;
  if (!shot.crop) return DESKTOP;
  // A deliberate cut to a fixed detail shot, never an animated camera crop.
  const height = 810;
  const width = Math.round(height * shot.crop.width / shot.crop.height / 2) * 2;
  return { x: Math.round((WIDTH - width) / 2), y: 224, width, height };
}

async function pointerPng(ffmpeg: string, scratch: string, kind: "drag" | "tap"): Promise<string> {
  const svg = kind === "drag"
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="52" viewBox="0 0 40 52"><path d="M4 3 L4 37 L13 29 L22 46 L29 42 L20 26 L36 26 Z" fill="#f5f7fa" stroke="#080a0e" stroke-width="2.5" stroke-linejoin="round"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="15" fill="#00b4ff" fill-opacity=".12" stroke="#00b4ff" stroke-width="2.5"/></svg>';
  const source = join(scratch, `${kind}.svg`);
  const target = join(scratch, `${kind}.png`);
  await writeFile(source, svg);
  await run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-frames:v", "1", target]);
  return target;
}

async function headingFilters(shot: PlannedShot, product: Product, scratch: string, index: number, previous?: PlannedShot, next?: PlannedShot): Promise<string[]> {
  const card = shot.from === undefined;
  const mobile = product === "mobile";
  const duration = shot.frames / FPS;
  const lines = shot.heading.split("\n");
  const size = card ? 100 : mobile ? 76 : 64;
  const gap = card ? 120 : mobile ? 98 : 78;
  const y = card ? 430 - (lines.length - 1) * 60 : mobile ? 475 - (lines.length - 1) * 49 : 62;
  const x = card ? "(w-text_w)/2" : mobile ? "160" : "192";
  const enter = previous?.heading === shot.heading && !card ? "1" : "min(1,t/0.22)";
  const leave = next?.heading === shot.heading && !card ? "1" : `min(1,(${n(duration)}-t)/0.18)`;
  const alpha = `max(0,min(${enter},${leave}))`;
  const filters: string[] = [];
  for (let line = 0; line < lines.length; line++) {
    const textPath = join(scratch, `heading-${index}-${line}.txt`);
    await writeFile(textPath, lines[line]);
    filters.push(`drawtext=fontfile=${filterQuote(BOLD)}:textfile=${filterQuote(textPath)}:expansion=none:fontsize=${size}:fontcolor=#edf0f5:x=${x}:y=${y + line * gap}:alpha='${alpha}'`);
  }
  if (shot.subtext) {
    const textPath = join(scratch, `subtext-${index}.txt`);
    await writeFile(textPath, shot.subtext);
    const subY = card ? y + lines.length * gap + 32 : mobile ? y + lines.length * gap + 28 : 140;
    filters.push(`drawtext=fontfile=${filterQuote(FONT)}:textfile=${filterQuote(textPath)}:expansion=none:fontsize=${card || mobile ? 30 : 25}:fontcolor=#9ba4b3:x=${x}:y=${subY}:alpha='${alpha}'`);
  }
  return filters;
}

async function renderShot(ffmpeg: string, input: string, product: Product, manifest: CaptureManifest, shot: PlannedShot, index: number, scratch: string, assets: Record<"drag" | "tap", string>, previous?: PlannedShot, next?: PlannedShot): Promise<string> {
  const card = shot.from === undefined;
  const duration = shot.frames / FPS;
  const output = join(scratch, `shot-${String(index).padStart(2, "0")}.mp4`);
  const args = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-y", "-filter_threads", "1", "-filter_complex_threads", "1"];
  const graph: string[] = [];
  if (card) {
    args.push("-f", "lavfi", "-i", `color=c=${BACKGROUND}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${n(duration)}`);
    graph.push("[0:v]setsar=1[stage]");
  } else {
    args.push("-threads", "1", "-i", input);
    const stage = stageFor(product, shot);
    const crop = shot.crop ? `crop=${shot.crop.width}:${shot.crop.height}:${shot.crop.x}:${shot.crop.y},` : "";
    // Quantize each cut independently. Every shot emits exactly its planned CFR frame count;
    // no cumulative fractional PTS drift, zoompan rounding, or overlapping freeze segments.
    graph.push(`[0:v]trim=start_frame=${shot.from}:end_frame=${shot.to},setpts=(PTS-STARTPTS)/${n(shot.rate ?? 1)},fps=${FPS},tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${shot.motionFrames},setpts=N/(${FPS}*TB),tpad=start_mode=clone:start_duration=${n(shot.beforeFrames / FPS)}:stop_mode=clone:stop_duration=${n(shot.afterFrames / FPS)},trim=end_frame=${shot.frames},${crop}scale=${stage.width}:${stage.height}:flags=lanczos,setsar=1[footage]`);
    graph.push(`color=c=${BACKGROUND}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${n(duration)}[matte]`);
    graph.push(`[matte]drawbox=x=${stage.x - 2}:y=${stage.y - 2}:w=${stage.width + 4}:h=${stage.height + 4}:color=#242a33:t=2[border]`);
    graph.push(`[border][footage]overlay=${stage.x}:${stage.y}:shortest=1[stage]`);
  }
  let prior = "stage";
  for (const [pointerIndex, pointer] of (shot.pointers ?? []).entries()) {
    const stage = stageFor(product, shot);
    const crop = shot.crop ?? { x: 0, y: 0, width: manifest.width, height: manifest.height };
    const scaleX = stage.width / crop.width;
    const scaleY = stage.height / crop.height;
    const rate = shot.rate ?? 1;
    const start = shot.beforeFrames / FPS + (pointer.frame - shot.from!) / manifest.fps / rate;
    const travel = pointer.kind === "drag" ? (pointer.endFrame! - pointer.frame) / manifest.fps / rate : 0;
    const nextPointer = shot.pointers?.[pointerIndex + 1];
    const nextStart = nextPointer ? (nextPointer.frame - pointer.frame) / manifest.fps / rate : Infinity;
    const length = Math.min(travel + (pointer.kind === "tap" ? 0.28 : 0.18), nextStart - 1 / FPS);
    if (length <= 0) throw new Error(`Pointer actions in ${shot.id} must be ordered and separated by at least one output frame.`);
    const fadeOut = Math.min(pointer.kind === "tap" ? 0.12 : 0.05, length / 2);
    const offset = pointer.kind === "tap" ? 24 : 4;
    const x = stage.x + (pointer.x - crop.x) * scaleX - offset;
    const y = stage.y + (pointer.y - crop.y) * scaleY - offset;
    const progress = travel > 0 ? `clip((t-${n(start)})/${n(travel)},0,1)` : "0";
    const dx = pointer.kind === "drag" ? (pointer.toX! - pointer.x) * scaleX : 0;
    const dy = pointer.kind === "drag" ? (pointer.toY! - pointer.y) * scaleY : 0;
    args.push("-loop", "1", "-framerate", String(FPS), "-i", assets[pointer.kind]);
    graph.push(`[${pointerIndex + 1}:v]format=rgba,trim=duration=${n(length)},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.05:alpha=1,fade=t=out:st=${n(length - fadeOut)}:d=${n(fadeOut)}:alpha=1,setpts=PTS+${n(start)}/TB[pointer${pointerIndex}]`);
    graph.push(`[${prior}][pointer${pointerIndex}]overlay=x='${n(x)}+${n(dx)}*${progress}':y='${n(y)}+${n(dy)}*${progress}':eof_action=pass:repeatlast=0:enable='between(t,${n(start)},${n(start + length)})'[pointer-stage${pointerIndex}]`);
    prior = `pointer-stage${pointerIndex}`;
  }
  const text = await headingFilters(shot, product, scratch, index, previous, next);
  const cardFade = card ? `,fade=t=in:st=0:d=0.18,fade=t=out:st=${n(duration - 0.18)}:d=0.18` : "";
  // Normalize range and color metadata across shots to avoid boundary luminance shifts.
  graph.push(`[${prior}]${text.join(",")},scale=in_range=auto:out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709${cardFade},setpts=N/(${FPS}*TB)[out]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[out]", "-an", "-frames:v", String(shot.frames), "-r", String(FPS), "-c:v", "libx264", "-threads", "4", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-video_track_timescale", "60000", output);
  await run(args);
  return output;
}

async function renderGif(ffmpeg: string, video: string, output: string, start: number, duration: number, product: Product, scratch: string): Promise<number> {
  const crop = product === "mobile" ? `crop=${PHONE.width + 4}:${PHONE.height + 4}:${PHONE.x - 2}:${PHONE.y - 2},` : "";
  const palette = join(scratch, "palette.png");
  for (const width of product === "desktop" ? [960, 800, 640] : [430, 360, 300]) {
    const base = `${crop}fps=12,scale=${width}:-2:flags=lanczos`;
    await run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", n(start), "-i", video, "-t", n(duration), "-vf", `${base},palettegen=max_colors=192:stats_mode=diff`, "-frames:v", "1", palette]);
    await run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", n(start), "-i", video, "-i", palette, "-t", n(duration), "-filter_complex", `[0:v]${base}[clip];[clip][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, "-loop", "0", output]);
    const bytes = (await stat(output)).size;
    if (bytes < 10 * 1024 * 1024) return bytes;
  }
  throw new Error("GIF exceeded 10 MiB at the minimum preview size.");
}

export async function renderFilm(options: RenderOptions): Promise<{ duration: number; sourceFps: number; containerFps: number; bytes: number; gifBytes: number; shots: Array<{ id: string; time: number; duration: number }> }> {
  const ffmpeg = Bun.which("ffmpeg");
  const ffprobe = Bun.which("ffprobe");
  if (!ffmpeg || !ffprobe) throw new Error("Install ffmpeg and ffprobe on PATH.");
  const input = resolve(options.input);
  const outputDir = resolve(options.outputDir);
  const source = await probe(ffprobe, input);
  const plan = planFilm(JSON.parse(await readFile(options.manifestPath, "utf8")), options.product, source.width, source.height, source.fps, source.frames);
  const duration = plan.frames / FPS;
  const audioProbe = Bun.spawn([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type:format=duration", "-of", "json", options.soundtrack], { stdout: "pipe", stderr: "pipe" });
  const audioText = await new Response(audioProbe.stdout).text();
  if (await audioProbe.exited !== 0) throw new Error("Cannot read the soundtrack.");
  const audioInfo = JSON.parse(audioText) as { streams?: unknown[]; format?: { duration?: string } };
  const audioDuration = Number(audioInfo.format?.duration);
  if (!audioInfo.streams?.length || !Number.isFinite(audioDuration) || audioDuration < duration) {
    throw new Error("Soundtrack must contain audio covering the full film duration.");
  }
  const video = join(outputDir, "launch.mp4");
  if (video === input) throw new Error("The output must not overwrite the source capture.");
  const gifStart = options.gifStart ?? plan.shots.find((shot) => shot.from !== undefined)!.startFrame / FPS;
  if (!Number.isFinite(gifStart) || gifStart < 0 || gifStart >= duration - 0.5) throw new Error("GIF start must fall within the film.");
  await mkdir(outputDir, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), "omp-film-"));
  try {
    const assets = { drag: await pointerPng(ffmpeg, scratch, "drag"), tap: await pointerPng(ffmpeg, scratch, "tap") };
    const files: string[] = [];
    for (const [index, shot] of plan.shots.entries()) {
      console.log(`${options.product}: ${shot.id} ${(shot.startFrame / FPS).toFixed(2)}–${((shot.startFrame + shot.frames) / FPS).toFixed(2)}s`);
      files.push(await renderShot(ffmpeg, input, options.product, plan.manifest, shot, index, scratch, assets, plan.shots[index - 1], plan.shots[index + 1]));
    }
    const list = join(scratch, "shots.txt");
    await writeFile(list, files.map((file) => `file ${quote(file)}`).join("\n") + "\n");
    const soundtrack = resolve(options.soundtrack);
    const comment = `source=${basename(input)};source-fps=${source.fps};renderer=scripts/launch-film/render.ts;render-fps=60;camera=fixed;edit=frame-addressed-shots;audio=${basename(soundtrack)}`;
    await run([ffmpeg, "-hide_banner", "-loglevel", "warning", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", soundtrack, "-map", "0:v:0", "-map", "1:a:0", "-t", n(duration), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-af", `afade=t=in:d=0.3,afade=t=out:st=${n(duration - 1.2)}:d=1.2`, "-movflags", "+faststart", "-metadata", `title=OMP ${options.product}`, "-metadata", `comment=${comment}`, video]);
    const actual = await probe(ffprobe, video);
    if (actual.frames !== plan.frames || actual.fps !== FPS) throw new Error(`Frame-count mismatch: expected ${plan.frames}, received ${actual.frames}.`);
    const gifDuration = Math.min(9, duration - gifStart);
    const gifBytes = await renderGif(ffmpeg, video, join(outputDir, "demo.gif"), gifStart, gifDuration, options.product, scratch);
    const shots = plan.shots.map((shot) => ({ id: shot.id, time: shot.startFrame / FPS, duration: shot.frames / FPS }));
    await writeFile(join(outputDir, "launch.shots.json"), JSON.stringify({ product: options.product, fps: FPS, width: WIDTH, height: HEIGHT, duration, source: basename(input), shots }, null, 2) + "\n");
    return { duration, sourceFps: source.fps, containerFps: actual.fps, bytes: (await stat(video)).size, gifBytes, shots };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
