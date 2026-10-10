# Agent instructions

## Build for users, not one workstation

A feature may originate from one user's personal workflow, but its implementation must be usable by other users without that person's machine, accounts, files, or configuration.

- Express personal preferences through documented configuration or explicit opt-in settings, not hard-coded user-specific behavior.
- Discover paths and dependencies through existing project conventions, environment variables, or configuration. Use portable defaults; never embed a developer's username, home directory, project paths, hostnames, or credentials.
- Reuse the existing configuration surface. Add only the options needed to make the requested feature reusable; avoid speculative abstractions or unrelated features.
- Keep personal configuration, credentials, transcripts, and runtime state out of version control. Documentation and examples must use generic or disposable data.
- Preserve existing installations and user choices. Do not overwrite personal configuration or stop/restart active OMP processes or services unless explicitly authorized for that operation.
- Document prerequisites, defaults, overrides, and limitations so a new user can use the feature from a fresh checkout.
- Verify behavioral changes in an isolated environment with a fresh HOME and private state/socket paths and ports. Exercise the portable default and any new user-configurable override, without borrowing personal credentials.

With both sibling checkouts available, `bun run release:check` runs the isolated fresh-install and shared-runtime checks. Native-shell and real-device/provider checks remain separate; report exactly what was exercised.
