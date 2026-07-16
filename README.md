# Pincus

Pincus is a [Pi](https://github.com/earendil-works/pi-mono) extension that routes Pi's built-in project tools through an existing [Incus](https://linuxcontainers.org/incus/) container while Pi itself stays on the host.

> [!NOTE]
> Pincus supports Linux hosts and Linux containers.

## Routed operations

When enabled, Pincus routes these built-in tools into the selected container:

- `bash`
- `read`, including binary image reads
- `write`
- `edit`
- `ls`
- `find`
- `grep`
- User `!` and `!!` commands

Pincus does **not** move the Pi process into the container. Custom extension tools, MCP tools, Pi configuration, authentication, and sessions remain on the host unless those tools provide their own container backend.

## Requirements

- The `incus` CLI on the host.
- An existing, running Incus container.
- A container user whose UID matches the host user's UID.
- The project available inside the container, normally through an Incus disk device or another mount.
- These container commands:
  - `bash`, `id`, `runuser`, and `setsid`
  - `cat`, `find`, `mkdir`, `tee`, and `test`
  - `fd` for the `find` tool
  - `rg` (ripgrep) for the `grep` tool

Each operation starts through root `incus exec`, resolves the container username for the host UID, and then uses `runuser` plus a login Bash shell. This gives the operation the container user's permissions and container-native environment. Pincus does not forward the host `HOME`, `USER`, `LOGNAME`, `PATH`, or other command environment values.

Arguments and paths are passed as process arguments rather than interpolated into shell source. Writes send file content over stdin. Cancellation and timeouts terminate the operation's container process group, including descendants. Image MIME types are detected from file signatures, so the container does not need the `file` utility.

## Install

Install the latest Git version:

```bash
pi install git:github.com/david/pincus
```

Version `0.3.0` is prepared in this repository but is not released until a `v0.3.0` tag is published. After installing or updating, restart Pi or run `/reload`.

## Commands

Enable Pincus and save the project configuration:

```text
/pincus <container> [container-cwd]
```

Examples:

```text
/pincus dev
/pincus dev /workspace/my-project
/pincus dev /workspace/a project with spaces
```

Other forms:

```text
/pincus          Re-enable the saved project configuration
/pincus status   Show the current state
/pincus off      Disable Pincus and preserve the saved container
```

The no-argument command does nothing when the saved configuration is already active. It reports an error when the project has no saved configuration.

`/bash-incus` remains as a compatibility alias and accepts the same arguments.

## CLI flags

```text
--pincus-container <container>  Enable Pincus for this process
--pincus-cwd <path>             Map Pi's startup directory to this container path
--no-pincus                     Disable Pincus for this process
```

The old `--incus-container`, `--incus-cwd`, and `--no-bash-incus` flags are still accepted. New flags take precedence when both forms are present.

## Configuration and migration

Pincus reads configuration in this order:

1. `~/.pi/agent/pincus.json`
2. The nearest `.pi/pincus.json` from Pi's startup directory toward the home directory
3. CLI flags

Project values override global values. CLI flags override file values.

```json
{
  "enabled": true,
  "container": "dev",
  "cwd": "/workspace/my-project"
}
```

Existing `bash-incus.json` and older `incus-bash.json` files are renamed to `pincus.json` when found. If both legacy names exist in one directory, `bash-incus.json` has priority. The old command and flags remain available after migration.

## Path mapping

The configured container cwd corresponds to the directory where Pi started on the host.

For example, with Pi started in `/home/me/project` and this configuration:

```json
{
  "enabled": true,
  "container": "dev",
  "cwd": "/workspace/project"
}
```

Pincus maps paths as follows:

- `src/app.ts` → `/workspace/project/src/app.ts`
- `/home/me/project/src/app.ts` → `/workspace/project/src/app.ts`
- `/workspace/project/src/app.ts` stays unchanged
- Other valid container absolute paths, such as `/etc/os-release`, stay unchanged

Relative paths, including paths containing `..`, resolve from the container cwd. If `cwd` is omitted, Pincus uses the same absolute path in the container as Pi's host startup directory.

Pi stores pasted clipboard images in the host temporary directory as `pi-clipboard-<uuid>.<image-extension>`. When such a file exists on the host, Pincus intentionally delegates that read to Pi's local read backend so image attachments continue to work. Other `/tmp` paths remain container paths.

Some files are created or managed by host Pi rather than the container. Reads within Pi's agent directory and installed package directory use the local backend, so configuration and bundled documentation remain available. The same applies to global, project, package, configured, and CLI-provided skill directories discovered by Pi.

When routed `bash` output is truncated, Pi saves the complete stream on the host as `/tmp/pi-bash-<id>.log`. Reads of those generated logs also use the local backend. Use the `read` tool rather than a container command such as `cat` or `sed` to retrieve them.

## Compatibility with other backends

Pincus registers built-in tool overrides only after Incus mode is activated. An unconfigured project therefore does not replace another backend extension. Each override is registered at most once. If Pincus is disabled later, its registered overrides delegate to Pi's local built-in tools.

## Development

```bash
npm install
npm run check
npm test
```

The normal test suite uses a local fake Incus transport to exercise path mapping, all routed tools, migration, fallback, cancellation, timeouts, process cleanup, limits, and result shapes.

An optional real-Incus smoke test creates a temporary host fixture and mounts it at a different container path:

```bash
PINCUS_INCUS_SMOKE=1 \
PINCUS_INCUS_CONTAINER=dev \
npm run test:smoke
```

Set `PINCUS_INCUS_SMOKE_CWD` to choose the temporary container mount path.

## License

MIT
