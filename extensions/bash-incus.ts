import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

interface BashIncusConfig {
	enabled?: boolean;
	container?: string;
	/** Container-side cwd corresponding to the pi startup cwd. Defaults to same path as host. */
	cwd?: string;
}

const HOST_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const HOST_TOKEN_LENGTH = 5;
const CONFIG_FILE = "bash-incus.json";
const LEGACY_CONFIG_FILE = "incus-bash.json";
const HOST_TOKEN_FILE = "incus-bash-host-token.json";
const HOST_TOKEN_WATCH_INTERVAL_MS = 500;
const INCUS_COMMAND_RUNNER =
	'pid_file=$1; command=$2; umask 077; printf "%s\\n" "$$" > "$pid_file"; bash -lc "$command"; status=$?; rm -f -- "$pid_file"; exit "$status"';
const INCUS_COMMAND_TERMINATOR =
	'pid_file=$1; attempt=0; while [ ! -r "$pid_file" ] && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done; if [ -r "$pid_file" ]; then IFS= read -r pgid < "$pid_file"; case "$pgid" in ""|*[!0-9]*) exit 1;; esac; kill -TERM -- "-$pgid" 2>/dev/null || true; attempt=0; while kill -0 -- "-$pgid" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done; kill -KILL -- "-$pgid" 2>/dev/null || true; rm -f -- "$pid_file"; fi';

export const __testIncusCommandRunner = INCUS_COMMAND_RUNNER;
export const __testIncusCommandTerminator = INCUS_COMMAND_TERMINATOR;

const bashIncusSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	host: Type.Optional(
		Type.String({
			description:
				"Run this single command on the host instead of Incus. Only use when the latest user message explicitly asks for host bash and includes the current host token from the status bar.",
		}),
	),
});

type BashIncusInput = Static<typeof bashIncusSchema>;

interface BashIncusState {
	enabled: boolean;
	container?: string;
	containerCwd?: string;
	hostToken: string;
	latestUserInput?: string;
	stopHostTokenWatcher?: () => void;
}

function readConfigFile(path: string): BashIncusConfig {
	if (!existsSync(path)) return {};

	try {
		return JSON.parse(readFileSync(path, "utf-8")) as BashIncusConfig;
	} catch {
		return {};
	}
}

function findOrMigrateConfigFile(directory: string): string | undefined {
	const configFile = join(directory, CONFIG_FILE);
	if (existsSync(configFile)) return configFile;

	const legacyConfigFile = join(directory, LEGACY_CONFIG_FILE);
	if (!existsSync(legacyConfigFile)) return undefined;

	try {
		renameSync(legacyConfigFile, configFile);
	} catch (error) {
		if (!existsSync(configFile)) throw error;
	}
	return configFile;
}

function findProjectConfigFile(cwd: string): string | undefined {
	const home = resolve(homedir());
	let dir = resolve(cwd);

	while (true) {
		const configFile = findOrMigrateConfigFile(join(dir, ".pi"));
		if (configFile) return configFile;
		if (dir === home) return undefined;

		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function loadConfig(cwd: string): BashIncusConfig {
	const agentConfigFile = findOrMigrateConfigFile(getAgentDir());
	const projectConfigFile = findProjectConfigFile(cwd);

	return {
		...(agentConfigFile ? readConfigFile(agentConfigFile) : {}),
		...(projectConfigFile ? readConfigFile(projectConfigFile) : {}),
	};
}

function writeConfigFile(path: string, config: BashIncusConfig) {
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmpPath, path);
}

function writeProjectConfig(cwd: string, config: BashIncusConfig) {
	const configFile = findProjectConfigFile(cwd) ?? join(cwd, ".pi", CONFIG_FILE);
	const configDirectory = dirname(configFile);
	if (!existsSync(configDirectory)) mkdirSync(configDirectory, { recursive: true });
	writeConfigFile(configFile, config);
}

function createHostToken(): string {
	const bytes = randomBytes(HOST_TOKEN_LENGTH);
	return Array.from(bytes, (byte) => HOST_TOKEN_ALPHABET[byte % HOST_TOKEN_ALPHABET.length]).join("");
}

function hostTokenFile(): string {
	return join(getAgentDir(), HOST_TOKEN_FILE);
}

function hostTokenLockFile(): string {
	return `${hostTokenFile()}.lock`;
}

function isHostToken(value: unknown): value is string {
	return typeof value === "string" && /^[a-z]{5}$/.test(value);
}

function readSharedHostTokenFile(): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(hostTokenFile(), "utf-8")) as { token?: unknown };
		return isHostToken(parsed.token) ? parsed.token : undefined;
	} catch {
		return undefined;
	}
}

function writeSharedHostTokenFile(token: string) {
	const path = hostTokenFile();
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmpPath, path);
}

function withHostTokenLock<T>(fn: () => T): T {
	const lockFile = hostTokenLockFile();
	const fd = openSync(lockFile, "wx");

	try {
		return fn();
	} finally {
		closeSync(fd);
		try {
			unlinkSync(lockFile);
		} catch {
			// Lock already gone; nothing to clean up.
		}
	}
}

function readOrCreateSharedHostToken(): string {
	const existing = readSharedHostTokenFile();
	if (existing) return existing;

	return withHostTokenLock(() => {
		const lockedExisting = readSharedHostTokenFile();
		if (lockedExisting) return lockedExisting;

		const token = createHostToken();
		writeSharedHostTokenFile(token);
		return token;
	});
}

function initialHostToken(): string {
	try {
		return readOrCreateSharedHostToken();
	} catch {
		return readSharedHostTokenFile() ?? createHostToken();
	}
}

function refreshHostToken(state: Pick<BashIncusState, "hostToken">): string {
	try {
		state.hostToken = readOrCreateSharedHostToken();
	} catch {
		// Keep the last known token if another process is rotating it right now.
	}
	return state.hostToken;
}

function toBashParams(params: BashIncusInput): { command: string; timeout?: number } {
	return params.timeout === undefined ? { command: params.command } : { command: params.command, timeout: params.timeout };
}

function mapCwd(hostCwd: string, cwd: string, containerCwd?: string): string {
	if (!containerCwd) return cwd;
	if (cwd === hostCwd) return containerCwd;
	if (cwd.startsWith(`${hostCwd}/`)) return `${containerCwd}${cwd.slice(hostCwd.length)}`;
	return cwd;
}

function createIncusExecUserEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const user = env.USER || env.LOGNAME || userInfo().username;
	const home = env.HOME || homedir();
	const path =
		env.PATH ||
		[
			`${home}/.pi/agent/bin`,
			`${home}/.bun/bin`,
			`${home}/.local/bin`,
			"/usr/local/sbin",
			"/usr/local/bin",
			"/usr/sbin",
			"/usr/bin",
			"/sbin",
			"/bin",
		].join(":");

	return [
		"--user",
		String(process.getuid?.() ?? 1000),
		"--group",
		String(process.getgid?.() ?? 1000),
		"--env",
		`HOME=${home}`,
		"--env",
		`USER=${user}`,
		"--env",
		`LOGNAME=${user}`,
		"--env",
		`PATH=${path}`,
	];
}

export const __testCreateIncusExecUserEnvArgs = createIncusExecUserEnvArgs;

function createIncusCommandPidFile(): string {
	return `/tmp/pi-bash-incus-${process.getuid?.() ?? 1000}-${randomUUID()}.pid`;
}

function terminateIncusProcessGroup(container: string, pidFile: string, onComplete: () => void) {
	const terminator = spawn(
		"incus",
		[
			"exec",
			container,
			...createIncusExecUserEnvArgs(),
			"--",
			"bash",
			"-c",
			INCUS_COMMAND_TERMINATOR,
			"bash-incus-cleanup",
			pidFile,
		],
		{ stdio: "ignore" },
	);
	let completed = false;
	const complete = () => {
		if (completed) return;
		completed = true;
		onComplete();
	};
	terminator.once("error", complete);
	terminator.once("close", complete);
}

function createBashIncusOps(hostCwd: string, state: Required<Pick<BashIncusState, "container">> & BashIncusState): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const pidFile = createIncusCommandPidFile();
				const child = spawn(
					"incus",
					[
						"exec",
						state.container,
						"--cwd",
						mapCwd(hostCwd, cwd, state.containerCwd),
						...createIncusExecUserEnvArgs(),
						"--",
						"setsid",
						"bash",
						"-c",
						INCUS_COMMAND_RUNNER,
						"bash-incus",
						pidFile,
						command,
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);

				let timedOut = false;
				let terminating = false;
				const terminate = () => {
					if (terminating) return;
					terminating = true;
					terminateIncusProcessGroup(state.container, pidFile, () => child.kill());
				};
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							terminate();
						}, timeout * 1000)
					: undefined;

				child.stdout.on("data", onData);
				child.stderr.on("data", onData);

				const onAbort = () => terminate();
				if (signal?.aborted) terminate();
				else signal?.addEventListener("abort", onAbort, { once: true });

				child.on("error", (error) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				});

				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code ?? 1 });
				});
			}),
	};
}

function statusText(state: BashIncusState): string {
	if (!state.enabled || !state.container) return "Incus bash: off";
	return `Incus bash: ${state.container}${state.containerCwd ? ` cwd=${state.containerCwd}` : ""}`;
}

function activate(state: BashIncusState, container: string, containerCwd?: string) {
	state.enabled = true;
	state.container = container;
	state.containerCwd = containerCwd;
}

function deactivate(state: BashIncusState) {
	state.enabled = false;
	state.container = undefined;
	state.containerCwd = undefined;
}

function applyUiStatus(ctx: ExtensionContext, state: BashIncusState) {
	const active = state.enabled && state.container;
	ctx.ui.setStatus("bash-incus", active ? `incus:${state.container}` : undefined);
	ctx.ui.setStatus("bash-incus-host", active ? `host:${refreshHostToken(state)}` : undefined);
}

function watchHostToken(ctx: ExtensionContext, state: BashIncusState) {
	state.stopHostTokenWatcher?.();

	const path = hostTokenFile();
	const listener = () => applyUiStatus(ctx, state);
	watchFile(path, { interval: HOST_TOKEN_WATCH_INTERVAL_MS, persistent: false }, listener);
	state.stopHostTokenWatcher = () => {
		unwatchFile(path, listener);
		state.stopHostTokenWatcher = undefined;
	};
}

function consumeHostToken(ctx: ExtensionContext, state: BashIncusState, token: string) {
	if (!state.latestUserInput?.includes(token)) throw new Error("Host bash token must appear in the latest user message");

	state.hostToken = withHostTokenLock(() => {
		const currentToken = readSharedHostTokenFile();
		if (token !== currentToken) throw new Error("Invalid host bash token");

		const nextToken = createHostToken();
		writeSharedHostTokenFile(nextToken);
		return nextToken;
	});
	applyUiStatus(ctx, state);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("incus-container", {
		description: "Run pi bash tool calls in this Incus container",
		type: "string",
	});
	pi.registerFlag("incus-cwd", {
		description: "Container-side cwd corresponding to pi's startup cwd",
		type: "string",
	});
	pi.registerFlag("no-bash-incus", {
		description: "Disable Incus-backed bash even when bash-incus.json is configured",
		type: "boolean",
		default: false,
	});

	const hostCwd = process.cwd();
	const localBash = createBashTool(hostCwd);
	const state: BashIncusState = { enabled: false, hostToken: "" };
	let bashToolRegistered = false;

	const ensureBashToolRegistered = () => {
		if (bashToolRegistered) return;

		pi.registerTool({
			...localBash,
			label: "bash (local/incus)",
			parameters: bashIncusSchema,
			async execute(id, params: BashIncusInput, signal, onUpdate, ctx) {
				const bashParams = toBashParams(params);

				if (!state.enabled || !state.container) {
					return localBash.execute(id, bashParams, signal, onUpdate);
				}

				if (params.host !== undefined) {
					consumeHostToken(ctx, state, params.host);
					return localBash.execute(id, bashParams, signal, onUpdate);
				}

				const bashIncus = createBashTool(hostCwd, {
					operations: createBashIncusOps(
						hostCwd,
						state as Required<Pick<BashIncusState, "container">> & BashIncusState,
					),
				});
				return bashIncus.execute(id, bashParams, signal, onUpdate);
			},
		});
		bashToolRegistered = true;
	};

	pi.on("input", (event) => {
		state.latestUserInput = event.text;
	});

	pi.on("user_bash", () => {
		if (!state.enabled || !state.container) return;
		return {
			operations: createBashIncusOps(hostCwd, state as Required<Pick<BashIncusState, "container">> & BashIncusState),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		const flagContainer = pi.getFlag("incus-container") as string | undefined;
		const flagCwd = pi.getFlag("incus-cwd") as string | undefined;
		const disabled = pi.getFlag("no-bash-incus") as boolean;

		if (disabled) {
			deactivate(state);
		} else {
			const container = flagContainer ?? config.container;
			const containerCwd = flagCwd ?? config.cwd;
			if ((flagContainer || config.enabled) && container) activate(state, container, containerCwd);
			else deactivate(state);
		}

		if (state.enabled) {
			state.hostToken = initialHostToken();
			ensureBashToolRegistered();
			watchHostToken(ctx, state);
		} else {
			state.stopHostTokenWatcher?.();
		}
		applyUiStatus(ctx, state);
		if (state.enabled) ctx.ui.notify(statusText(state), "info");
	});

	pi.on("session_shutdown", () => {
		state.stopHostTokenWatcher?.();
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.enabled || !state.container) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\nIncus bash mode is enabled. The bash tool and user !/!! commands run inside Incus container ${JSON.stringify(
				state.container,
			)}${state.containerCwd ? ` with container cwd ${JSON.stringify(state.containerCwd)}` : ""}. The read, edit, and write tools still operate on the host filesystem, so assume the project is mounted consistently between host and container. The bash tool has an optional shared host token parameter for one-command host bypass; never set it unless the latest user message explicitly asks for host bash and includes the current host token from the status bar.`,
		};
	});

	pi.registerCommand("bash-incus", {
		description: "Show or persist Incus-backed bash: /bash-incus <container> [cwd], /bash-incus off",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				const configFile = findProjectConfigFile(ctx.cwd);
				if (!configFile) {
					ctx.ui.notify("No project .pi/bash-incus.json found", "error");
					return;
				}
				if (state.enabled) return;

				const config = readConfigFile(configFile);
				if (!config.container) {
					ctx.ui.notify("Project bash-incus.json has no container", "error");
					return;
				}

				writeConfigFile(configFile, { ...config, enabled: true });
				activate(state, config.container, config.cwd);
				state.hostToken = initialHostToken();
				ensureBashToolRegistered();
				watchHostToken(ctx, state);
				applyUiStatus(ctx, state);
				ctx.ui.notify(statusText(state), "info");
				return;
			}

			if (parts[0] === "status") {
				ctx.ui.notify(statusText(state), "info");
				return;
			}

			if (parts[0] === "off") {
				writeProjectConfig(ctx.cwd, {
					enabled: false,
					...(state.container ? { container: state.container } : {}),
					...(state.containerCwd ? { cwd: state.containerCwd } : {}),
				});
				deactivate(state);
				state.stopHostTokenWatcher?.();
				applyUiStatus(ctx, state);
				ctx.ui.notify("Incus bash disabled", "info");
				return;
			}

			if (parts.length > 2) {
				ctx.ui.notify("Usage: /bash-incus <container> [cwd]", "error");
				return;
			}

			writeProjectConfig(ctx.cwd, {
				enabled: true,
				container: parts[0],
				...(parts[1] ? { cwd: parts[1] } : {}),
			});
			activate(state, parts[0], parts[1]);
			state.hostToken = initialHostToken();
			ensureBashToolRegistered();
			watchHostToken(ctx, state);
			applyUiStatus(ctx, state);
			ctx.ui.notify(statusText(state), "info");
		},
	});
}
