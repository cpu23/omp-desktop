# Launch media

These films use real browser-client footage with genuine `openai-codex/gpt-6-luna` replies. The edit uses fixed framing, one heading per feature scene, and subtext only on the title/end cards and the Desktop reload explanation. There are no automatic zooms, moving lower-thirds, eyebrow labels, or decorative counters.

| Film | Duration | Export | Source |
| --- | --- | --- | --- |
| Desktop | 26.08 s | 1920×1080, 60 fps | 1920×1080, 30 fps |
| Mobile | 17.27 s | 1920×1080, 60 fps | 430×900, 30 fps |

Desktop shows one session → two panes → four panes, real sidebar drag-and-drop, a shared theme change, and the restored workspace after reload. The settings panel receives one deliberate cut to a fixed close-up, then a cut back to the full workspace. The other workspace shots use identical framing.

Mobile stays at native 430×900 in one fixed frame. It shows prompt entry, the genuine reply, and switching live sessions. The idle provider wait is cut. The blank post-reload body and enlarged header-only shot from the previous edit are not used; this film makes no mobile reload/history-restoration claim. Desktop carries the persistence demonstration.

Mobile was recaptured using the real `titanium` theme to preserve its signature blue headings/list markers (`#00b4ff`) and green inline code (`#00ff88`). The previous `dark-catppuccin` take is no longer used. These are verified live CSS theme tokens, not a post-production color treatment.

The real app UI and replies are not recreated or painted over. The footage is from disposable browser sessions, not a native desktop window or physical phone. Desktop persistence concerns browser reload and the daemon's workspace mirror, not a daemon restart. Config sync is demonstrated by a shared theme change, not every possible runtime override.

## Reproduce the edit

Prerequisites: Bun, `ffmpeg`, and `ffprobe` on PATH, plus an instrumental soundtrack covering the complete edit. The renderer uses bundled Hack fonts; no external font installation or Remotion dependency is required. The previous procedural synthesizer has been removed.

Run from the `omp-desktop` checkout with the retained original captures:

```sh
bun run scripts/render-demo.ts desktop /path/to/desktop-master-v4.mp4 docs/media --soundtrack /path/to/instrumental.wav
bun run scripts/render-demo.ts mobile /path/to/mobile-signature.mp4 ../omp-mobile/docs/media --soundtrack /path/to/instrumental.wav
```

The default shot lists are `scripts/launch-film/desktop.film.json` and `mobile.film.json`. They address **those specific captures**. A different recording requires a new shot list and visual review:

```sh
bun run scripts/render-demo.ts desktop /path/to/new-capture.mp4 /path/to/output --manifest /path/to/film.json --soundtrack /path/to/instrumental.wav
```

Outputs replace `launch.mp4`, `demo.gif`, and `launch.shots.json` in the selected directory. `launch.shots.json` records exact output shot boundaries for playback review. `--gif-start seconds` optionally overrides the default preview start at the first footage shot. GIFs are silent, up to nine seconds, and under 10 MiB; the Mobile GIF crops to the actual app rather than shrinking a landscape title composition into a narrow README embed.

### Shot-list format

The JSON root specifies `product` (`desktop` or `mobile`), encoded `width`/`height`, `fps`, `cursorBaked`, and `shots`.

Each shot has a unique `id`, a `heading`, and optional `subtext`:

- A title/end card specifies `duration` in seconds.
- Footage specifies integer source frames `from` (inclusive) and `to` (exclusive).
- Optional `rate`, `holdBefore`, and `holdAfter` specify playback speed and editorial freeze holds. Desktop drags are slowed for readability; holds do not imply model response speed.
- Optional `crop` (`x`, `y`, `width`, `height`) selects a **fixed** detail view. It does not animate a camera.
- Optional `pointers` specify only real `tap` or `drag` actions. `frame`, `endFrame` (drag only), and source-pixel coordinates determine placement. Verify these against the encoded video, not automation wall-clock logs. Do not overlay pointers when `cursorBaked` is true.

Every shot is quantized to an exact 60 fps output-frame count. Independent shot encodes use the same limited-range BT.709 metadata before concatenation. This avoids fractional-timestamp drift and color-range changes at shot boundaries. Final exports are H.264 CRF 18, yuv420p, fast-start MP4 with stereo AAC audio. Source motion remains 30 fps; a 60 fps export is not a claim of 60 fps capture.

```sh
ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate,nb_frames,color_range,color_space -show_entries format=duration:format_tags=comment -of json docs/media/launch.mp4
```

Raw masters and capture provenance remain outside the repositories for re-editing. Private credential copies, disposable runtime state, and capture services were removed after filming. Keep all future personal transcripts, credentials, and private configuration out of captures and version control.

## Instrumental soundtrack

The replacement music was generated locally with [YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B), an empty lyrics field, and explicit instrumental/no-vocals style instructions. Generation used BF16 without quantization on an RTX 5070 Ti; observed peak allocated VRAM was 7.51 GiB for two candidates. The chosen candidate uses seed 831101. A GPU Demucs vocal-separation pass retains only the instrumental backing. The soundtrack is normalized and faded for each film; the real video stream is preserved.

YuE2-3B uses **CC BY-NC 4.0**. These assets were produced for the user-confirmed non-commercial use. This is not commercial-use clearance or a legal claim about ownership of generated music. Do not reuse this soundtrack commercially without appropriate permission. The model, prompts, generation settings, original audio, and stems are retained outside the repositories.
