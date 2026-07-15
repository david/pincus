# pi-bash-incus

A [Pi](https://github.com/earendil-works/pi-mono) extension that routes the `bash` tool and user `!`/`!!` commands through an existing [Incus](https://linuxcontainers.org/incus/) container.

Pi's `read`, `edit`, and `write` tools continue to use the host filesystem. The project should therefore be mounted at matching paths on the host and in the container, or configured with a container-side working directory.

## Install

Install the latest Git version for your user:

```bash
pi install git:github.com/david/pi-bash-incus
```

Or install a pinned release:

```bash
pi install git:github.com/david/pi-bash-incus@v0.1.0
```

Restart Pi or run `/reload` after installation.

## Requirements

- The `incus` CLI on the host.
- An already-running Incus container.
- `bash` and `setsid` in the container.
- A container user with the same UID and GID as the host user.
- Project files mounted into the container.

## Usage

Enable Incus-backed bash and save the project configuration:

```text
/bash-incus <container> [container-cwd]
```

Examples:

```text
/bash-incus dev
/bash-incus dev /workspace/project
```

Other command forms:

```text
/bash-incus          Re-enable the saved project configuration
/bash-incus status   Show the current state
/bash-incus off      Disable Incus bash and preserve the saved container
```

The no-argument command does nothing when Incus bash is already active. It reports an error when the project has no saved configuration.

## CLI flags

```text
--incus-container <container>  Enable Incus bash for this process
--incus-cwd <path>             Map Pi's startup directory to this container path
--no-bash-incus                Disable configured Incus bash for this process
```

## Configuration

The extension reads configuration from:

1. `~/.pi/agent/bash-incus.json`
2. The nearest `.pi/bash-incus.json` from the startup directory up to the home directory
3. CLI flags, which override file values

Example:

```json
{
  "enabled": true,
  "container": "dev",
  "cwd": "/workspace/project"
}
```

Legacy global and project `incus-bash.json` files are renamed to `bash-incus.json` when found.

## Host command bypass

When Incus bash is active, the footer displays a short shared host token. A single `bash` tool call can run on the host only when the latest user message explicitly requests host bash and includes that token. The token rotates after use.

User `!` and `!!` commands always use the active Incus backend.

## Development

```bash
npm install
npm run check
npm test
```

The tests cover configuration migration, command persistence, and process-group termination.

## License

MIT
