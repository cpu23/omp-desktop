# OMP Desktop 0.1.0 — Initial source release

OMP Desktop brings live OMP sessions into one browser workspace, with an optional native Linux window.

[Launch video (MP4)](https://github.com/cpu23/omp-desktop/releases/download/v0.1.0/launch.mp4) · [Demo GIF](https://github.com/cpu23/omp-desktop/releases/download/v0.1.0/demo.gif) · [Quick setup](https://github.com/cpu23/omp-desktop#quick-setup)

## Highlights

- Run and navigate live or saved OMP sessions in the browser, search sessions, and work in up to four terminal panes.
- Keep sessions running when the window closes.
- On Linux, open the same local daemon in an optional Tauri 2 native window.
- The 26-second launch film uses real 1920 × 1080 browser footage with four independent `openai-codex/gpt-6-luna` sessions. It shows one pane → two panes → a four-pane grid, actual sidebar session swaps, a shared theme change through `/settings`, and restored pane bindings after clearing browser storage and reloading. The revised 1080p60 edit uses fixed framing, heading-only feature scenes, tracked drag feedback, and an original soundtrack. Loading intervals are edited out; the settings detail is a fixed close-up, not an automatic zoom. This is not native-window footage or a daemon-restart demonstration.

## Requirements and setup

Bun 1.3+, Git, and OMP 18.x on `PATH`; complete OMP provider setup before starting a session. Linux is required only for the native window; the browser client needs a host that supports Bun and PTYs.

Follow the [browser Quick setup](https://github.com/cpu23/omp-desktop#quick-setup). To build the native window locally, see the [Native Linux app guide](https://github.com/cpu23/omp-desktop/blob/main/docs/guide.md#native-linux-app).

## Distribution and security

This is a source release with demo media; it includes no prebuilt binaries or installers. GitHub provides source archives for the release tag. Keep the local desktop API on loopback: it has no authentication.

The launch soundtrack is instrumental music generated locally with [YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B), with vocals removed using Demucs. YuE2's model license is CC BY-NC 4.0; this soundtrack was made for non-commercial use, not commercially cleared. The repository's source-code license does not grant additional rights to the soundtrack.
