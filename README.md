# OMP Desktop

Use [OMP](https://omp.sh) coding sessions in a browser or optional native Linux window. Organize chats into
spaces with up to four terminal panes; switch between live and saved sessions. Closing a pane or window does not
stop its session.

## Requirements

- Bun 1.3+, Git and OMP 18.x on `PATH`; run `omp` once to complete provider setup.
- Linux is required for the native window. The browser client needs a host that supports Bun and PTYs.

## Quick setup

From the folder where you keep projects:

```sh
git clone https://github.com/cpu23/omp-desktop.git && cd omp-desktop && bun install --frozen-lockfile && bun run start
```

Open <http://127.0.0.1:4180> and select **+ New session**. Keep the terminal running.

For a native window, install [Rust](https://rustup.rs) and the [Linux build packages](docs/guide.md#native-linux-app),
then run `bun run app:install` from `omp-desktop/` in another terminal. Open **OMP Desktop** from the application
menu; the daemon above must remain running.

> The desktop API has no authentication. Keep it on loopback. Setup does not change your OMP configuration.

## Spaces and files

- Click **+** to add a space. Drag a pane or sidebar session onto another space's tab to move/open it there.
- Drop files onto a pane to insert their paths without submitting. Native drops preserve original paths for all
  file types; file contents are not uploaded.
- Closing a pane only detaches its view. Output continues in the daemon; use the sidebar stop action to end a
  session. See the [guide](docs/guide.md) for configuration, security and native setup details.

## CI and local checks

GitHub Actions runs on pull requests, pushes to `main`, and manual dispatch. Its Ubuntu Linux jobs install the
locked Bun dependencies, run the TypeScript check and existing tests, smoke-test the daemon APIs in a disposable
home/state directory, and build the native Tauri app. The daemon smoke does not need OMP, provider credentials,
or any sibling checkout.

Run the same JavaScript checks locally:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run scripts/daemon-smoke.ts
```

The broader `bun run smoke` additionally exercises the OMP PTY integration and requires OMP 18.x on `PATH`.
For a native Linux build, install Rust stable and the [Linux packages listed in the guide](docs/guide.md#native-linux-app),
then run:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --locked --release
bun run app:build
```

## Releases and links

Source releases only—no prebuilt installers: [v0.1.3](https://github.com/cpu23/omp-desktop/releases/tag/v0.1.3)
([notes](docs/release-v0.1.3.md)) · [all releases](https://github.com/cpu23/omp-desktop/releases).

[OMP Mobile companion](https://github.com/cpu23/omp-mobile) · [Mobile setup](https://github.com/cpu23/omp-mobile#quick-setup) · [MIT license](LICENSE)
[Initial release notes](docs/release-v0.1.0.md) · [Desktop guide](docs/guide.md)
