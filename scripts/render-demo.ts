#!/usr/bin/env bun
/** Render real OMP footage using an explicit, frame-addressed shot list. */
import { join, resolve } from "node:path";
import { renderFilm } from "./launch-film/render";
import type { Product } from "./launch-film/model";

const usage = "Usage: bun run scripts/render-demo.ts <desktop|mobile> <capture.mp4> <output-dir> --soundtrack music.wav [--manifest film.json] [--gif-start seconds]";

function fail(message: string): never {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(usage);
  process.exit(0);
}
if (args.length < 3) fail("A product, capture, and output directory are required.");
const product = args[0] as Product;
if (product !== "desktop" && product !== "mobile") fail("Product must be desktop or mobile.");
const input = resolve(args[1]);
const outputDir = resolve(args[2]);
let manifestPath = join(import.meta.dir, "launch-film", `${product}.film.json`);
let gifStart: number | undefined;
let soundtrack: string | undefined;

for (let index = 3; index < args.length; index++) {
  const option = args[index];
  if (option === "--manifest" && args[index + 1]) {
    manifestPath = resolve(args[++index]);
  } else if (option === "--soundtrack" && args[index + 1]) {
    soundtrack = resolve(args[++index]);
  } else if (option === "--gif-start" && args[index + 1]) {
    gifStart = Number(args[++index]);
    if (!Number.isFinite(gifStart) || gifStart < 0) fail("--gif-start must be a non-negative time in seconds.");
  } else {
    fail(`Unknown or incomplete option: ${option}`);
  }
}
if (!soundtrack) fail("--soundtrack requires an instrumental audio file.");

try {
  const result = await renderFilm({ product, input, outputDir, manifestPath, gifStart, soundtrack });
  console.log(`Wrote ${join(outputDir, "launch.mp4")} (${(result.bytes / 1024 / 1024).toFixed(2)} MiB, ${result.duration.toFixed(2)}s).`);
  console.log(`Wrote ${join(outputDir, "demo.gif")} (${(result.gifBytes / 1024 / 1024).toFixed(2)} MiB).`);
  console.log(`Source: ${result.sourceFps.toFixed(2)} fps; finished picture: ${result.containerFps.toFixed(2)} fps.`);
  console.log(`Shots: ${result.shots.map((shot) => `${shot.id}@${shot.time.toFixed(2)}s`).join(" · ")}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
