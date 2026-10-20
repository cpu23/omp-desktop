# OMP Desktop v0.1.3

- Reduced sidebar animation work with a 30 Hz shimmer, cached glyph references, and suspension for hidden rows and documents. The Motion control still supports System, On, and Off.
- Added byte-budgeted saved-session caches that invalidate when transcripts change or are replaced, and prune deleted files.
- Reused unchanged terminal replay snapshots without reducing scrollback or image state.
- Improved PTY termination, bounded shutdown cleanup, and native handle release through a reproducible `bun-pty` patch.
- Selected the DOM terminal renderer for recognized software rasterizers while retaining WebGL for hardware and unknown renderers.

Source release; no prebuilt installers. See the [desktop guide](guide.md) for setup, memory tradeoffs, and process-termination limitations.
