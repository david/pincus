import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
	BashOperations,
	EditOperations,
	ExtensionAPI,
	ExtensionContext,
	FindOperations,
	GrepToolDetails,
	GrepToolInput,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	formatSize,
	getAgentDir,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";

interface PincusConfig {
	enabled?: boolean;
	container?: string;
	/** Container path corresponding to Pi's startup directory. */
	cwd?: string;
}

interface PincusState {
	enabled: boolean;
	container?: string;
	containerCwd?: string;
}

export interface PincusMapping {
	hostRoot: string;
	containerRoot: string;
}

export interface IncusExecutionResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
}

interface IncusExecutionOptions {
	cwd: string;
	stdin?: string | Buffer;
	signal?: AbortSignal;
	timeout?: number;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
	captureStdout?: boolean;
	captureStderr?: boolean;
}

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type IncusExecutor = (
	executable: string,
	args: readonly string[],
	options: IncusExecutionOptions,
) => Promise<IncusExecutionResult>;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

const CONFIG_FILE = "pincus.json";
const LEGACY_CONFIG_FILES = ["bash-incus.json", "incus-bash.json"] as const;
const DEFAULT_GREP_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;
const PI_CLIPBOARD_IMAGE_PATTERN =
	/^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:bmp|gif|jpe?g|png|webp)$/i;

const INCUS_OPERATION_RUNNER =
	'pid_file=$1; shift; umask 077; printf "%s\\n" "$$" > "$pid_file"; "$@"; status=$?; rm -f -- "$pid_file"; exit "$status"';
const INCUS_RUN_AS_USER =
	'uid=$1; runner=$2; pid_file=$3; shift 3; user=$(id -nu "$uid") || { printf "No container user found for UID %s\\n" "$uid" >&2; exit 1; }; exec runuser -u "$user" -- setsid bash -lc "$runner" pincus-operation "$pid_file" "$@"';
const INCUS_PROCESS_TERMINATOR =
	'pid_file=$1; attempt=0; while [ ! -r "$pid_file" ] && [ "$attempt" -lt 100 ]; do sleep 0.05; attempt=$((attempt + 1)); done; if [ -r "$pid_file" ]; then IFS= read -r pgid < "$pid_file"; case "$pgid" in ""|*[!0-9]*) exit 1;; esac; kill -TERM -- "-$pgid" 2>/dev/null || true; attempt=0; while kill -0 -- "-$pgid" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done; kill -KILL -- "-$pgid" 2>/dev/null || true; rm -f -- "$pid_file"; fi';

export const __testIncusOperationRunner = INCUS_OPERATION_RUNNER;
export const __testIncusRunAsUser = INCUS_RUN_AS_USER;
export const __testIncusProcessTerminator = INCUS_PROCESS_TERMINATOR;

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function isWithin(root: string, value: string): boolean {
	const relativePath = relative(root, value);
	return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function isHostClipboardImagePath(inputPath: string): boolean {
	const absolutePath = resolve(stripAtPrefix(inputPath));
	return (
		dirname(absolutePath) === resolve(tmpdir()) &&
		PI_CLIPBOARD_IMAGE_PATTERN.test(basename(absolutePath)) &&
		existsSync(absolutePath)
	);
}

function detectImageMimeType(buffer: Buffer): string | null {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 6) {
		const signature = buffer.subarray(0, 6).toString("ascii");
		if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
	}
	if (
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
		buffer.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
	return null;
}

/** Map host paths in Pi's startup tree while leaving container absolute paths intact. */
export function mapPincusPath(mapping: PincusMapping, inputPath: string): string {
	const value = stripAtPrefix(inputPath);
	if (!isAbsolute(value)) return path.resolve(mapping.containerRoot, value);
	const normalized = path.resolve(value);
	if (!isWithin(mapping.hostRoot, normalized)) return normalized;
	const suffix = relative(mapping.hostRoot, normalized);
	return suffix ? path.resolve(mapping.containerRoot, suffix) : mapping.containerRoot;
}

function readConfigFile(filePath: string): PincusConfig {
	if (!existsSync(filePath)) return {};
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as PincusConfig;
	} catch {
		return {};
	}
}

function findOrMigrateConfigFile(directory: string): string | undefined {
	const target = join(directory, CONFIG_FILE);
	if (existsSync(target)) return target;

	for (const legacyName of LEGACY_CONFIG_FILES) {
		const legacy = join(directory, legacyName);
		if (!existsSync(legacy)) continue;
		try {
			renameSync(legacy, target);
		} catch (error) {
			if (!existsSync(target)) throw error;
		}
		return target;
	}
	return undefined;
}

function findProjectConfigFile(cwd: string): string | undefined {
	const home = resolve(homedir());
	let directory = resolve(cwd);
	while (true) {
		const configFile = findOrMigrateConfigFile(join(directory, CONFIG_DIR_NAME));
		if (configFile) return configFile;
		if (directory === home) return undefined;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function loadConfig(cwd: string): PincusConfig {
	const globalConfig = findOrMigrateConfigFile(getAgentDir());
	const projectConfig = findProjectConfigFile(cwd);
	return {
		...(globalConfig ? readConfigFile(globalConfig) : {}),
		...(projectConfig ? readConfigFile(projectConfig) : {}),
	};
}

function writeConfigFile(filePath: string, config: PincusConfig): void {
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, filePath);
}

function writeProjectConfig(cwd: string, config: PincusConfig): void {
	const configFile = findProjectConfigFile(cwd) ?? join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
	mkdirSync(dirname(configFile), { recursive: true });
	writeConfigFile(configFile, config);
}

function createOperationPidFile(): string {
	return `/tmp/pincus-${process.getuid?.() ?? 1000}-${randomUUID()}.pid`;
}

export function createIncusExecArgs(
	container: string,
	cwd: string,
	pidFile: string,
	executable: string,
	args: readonly string[],
): string[] {
	return [
		"exec",
		container,
		"--cwd",
		cwd,
		"--",
		"bash",
		"-c",
		INCUS_RUN_AS_USER,
		"pincus-user",
		String(process.getuid?.() ?? 1000),
		INCUS_OPERATION_RUNNER,
		pidFile,
		executable,
		...args,
	];
}

export function createIncusTerminatorArgs(container: string, pidFile: string): string[] {
	return [
		"exec",
		container,
		"--",
		"bash",
		"-c",
		INCUS_PROCESS_TERMINATOR,
		"pincus-cleanup",
		pidFile,
	];
}

function spawnAndWait(spawnProcess: SpawnProcess, args: string[]): Promise<void> {
	return new Promise((resolve) => {
		const process = spawnProcess("incus", args, { stdio: "ignore" });
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		process.once("error", finish);
		process.once("close", finish);
	});
}

/** Create the process-safe Incus executor used by every routed operation. */
export function createIncusExecutor(container: string, spawnProcess: SpawnProcess = spawn): IncusExecutor {
	return (executable, args, options) =>
		new Promise((resolveExecution, rejectExecution) => {
			if (options.signal?.aborted) {
				rejectExecution(new Error("aborted"));
				return;
			}

			const pidFile = createOperationPidFile();
			const child = spawnProcess(
				"incus",
				createIncusExecArgs(container, options.cwd, pidFile, executable, args),
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let timedOut = false;
			let settled = false;
			let termination: Promise<void> | undefined;

			const terminate = () => {
				if (termination) return termination;
				termination = spawnAndWait(spawnProcess, createIncusTerminatorArgs(container, pidFile)).then(() => {
					if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
				});
				return termination;
			};
			const onAbort = () => {
				void terminate();
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });

			const timer =
				options.timeout && options.timeout > 0
					? setTimeout(() => {
						timedOut = true;
						void terminate();
					}, options.timeout * 1000)
					: undefined;

			child.stdout?.on("data", (chunk: Buffer) => {
				if (options.captureStdout !== false) stdout.push(Buffer.from(chunk));
				options.onStdout?.(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (options.captureStderr !== false) stderr.push(Buffer.from(chunk));
				options.onStderr?.(chunk);
			});
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.stdin);

			const cleanup = () => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			};
			const rejectOnce = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				rejectExecution(error);
			};

			child.once("error", (error) => rejectOnce(error));
			child.once("close", async (code) => {
				if (termination) await termination;
				if (settled) return;
				settled = true;
				cleanup();
				if (options.signal?.aborted) {
					rejectExecution(new Error("aborted"));
					return;
				}
				if (timedOut) {
					rejectExecution(new Error(`timeout:${options.timeout}`));
					return;
				}
				resolveExecution({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code });
			});
		});
}

async function executeChecked(
	executor: IncusExecutor,
	executable: string,
	args: readonly string[],
	options: IncusExecutionOptions,
): Promise<IncusExecutionResult> {
	const result = await executor(executable, args, options);
	if (result.exitCode === 0) return result;
	const message = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
	throw new Error(message || `${executable} exited with code ${result.exitCode}`);
}

function createReadOperations(executor: IncusExecutor, mapping: PincusMapping, signal?: AbortSignal): ReadOperations {
	const reads = new Map<string, Promise<Buffer>>();
	const readFile = (filePath: string): Promise<Buffer> => {
		const mappedPath = mapPincusPath(mapping, filePath);
		let pending = reads.get(mappedPath);
		if (!pending) {
			pending = executeChecked(executor, "cat", ["--", mappedPath], { cwd: mapping.containerRoot, signal }).then(
				(result) => result.stdout,
			);
			reads.set(mappedPath, pending);
		}
		return pending;
	};

	return {
		readFile,
		access: async (filePath) => {
			await executeChecked(executor, "test", ["-r", mapPincusPath(mapping, filePath)], {
				cwd: mapping.containerRoot,
				signal,
			});
		},
		detectImageMimeType: async (filePath) => detectImageMimeType(await readFile(filePath)),
	};
}

function createWriteOperations(executor: IncusExecutor, mapping: PincusMapping, signal?: AbortSignal): WriteOperations {
	return {
		mkdir: async (directory) => {
			await executeChecked(executor, "mkdir", ["-p", "--", mapPincusPath(mapping, directory)], {
				cwd: mapping.containerRoot,
				signal,
			});
		},
		writeFile: async (filePath, content) => {
			await executeChecked(executor, "tee", ["--", mapPincusPath(mapping, filePath)], {
				cwd: mapping.containerRoot,
				stdin: content,
				signal,
				captureStdout: false,
			});
		},
	};
}

function createEditOperations(executor: IncusExecutor, mapping: PincusMapping, signal?: AbortSignal): EditOperations {
	const read = createReadOperations(executor, mapping, signal);
	const write = createWriteOperations(executor, mapping, signal);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (filePath) => {
			const mapped = mapPincusPath(mapping, filePath);
			await executeChecked(executor, "test", ["-r", mapped], { cwd: mapping.containerRoot, signal });
			await executeChecked(executor, "test", ["-w", mapped], { cwd: mapping.containerRoot, signal });
		},
	};
}

function createLsOperations(executor: IncusExecutor, mapping: PincusMapping, signal?: AbortSignal): LsOperations {
	return {
		exists: async (filePath) => {
			const result = await executor("test", ["-e", mapPincusPath(mapping, filePath)], {
				cwd: mapping.containerRoot,
				signal,
			});
			return result.exitCode === 0;
		},
		stat: async (filePath) => {
			const result = await executor("test", ["-d", mapPincusPath(mapping, filePath)], {
				cwd: mapping.containerRoot,
				signal,
			});
			return { isDirectory: () => result.exitCode === 0 };
		},
		readdir: async (directory) => {
			const result = await executeChecked(
				executor,
				"find",
				[mapPincusPath(mapping, directory), "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0"],
				{ cwd: mapping.containerRoot, signal },
			);
			return result.stdout.toString("utf8").split("\0").filter(Boolean);
		},
	};
}

function createFindOperations(executor: IncusExecutor, mapping: PincusMapping, signal?: AbortSignal): FindOperations {
	return {
		exists: async (filePath) => {
			const result = await executor("test", ["-e", mapPincusPath(mapping, filePath)], {
				cwd: mapping.containerRoot,
				signal,
			});
			return result.exitCode === 0;
		},
		glob: async (pattern, cwd, options) => {
			const searchRoot = mapPincusPath(mapping, cwd);
			const args = ["--glob", "--color=never", "--hidden", "--absolute-path", "--max-results", String(options.limit)];
			for (const ignored of options.ignore) args.push("--exclude", ignored);
			let effectivePattern = pattern;
			if (pattern.includes("/")) {
				args.push("--full-path");
				if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
					effectivePattern = `**/${pattern}`;
				}
			}
			args.push("--", effectivePattern, searchRoot);
			const result = await executeChecked(executor, "fd", args, { cwd: mapping.containerRoot, signal });
			return result.stdout
				.toString("utf8")
				.split("\n")
				.map((line) => line.replace(/\r$/, ""))
				.filter(Boolean);
		},
	};
}

function createBashOperations(executor: IncusExecutor, mapping: PincusMapping): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const result = await executor("bash", ["-lc", command], {
				cwd: mapPincusPath(mapping, cwd),
				signal,
				timeout,
				onStdout: onData,
				onStderr: onData,
				captureStdout: false,
				captureStderr: false,
			});
			return { exitCode: result.exitCode };
		},
	};
}

function normalizeLineEndings(content: string): string[] {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

async function executeIncusGrep(
	executor: IncusExecutor,
	mapping: PincusMapping,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const searchPath = mapPincusPath(mapping, params.path ?? ".");
	const directoryProbe = await executor("test", ["-d", searchPath], { cwd: mapping.containerRoot, signal });
	const isDirectory = directoryProbe.exitCode === 0;
	if (!isDirectory) {
		const existsProbe = await executor("test", ["-e", searchPath], { cwd: mapping.containerRoot, signal });
		if (existsProbe.exitCode !== 0) throw new Error(`Path not found: ${searchPath}`);
	}

	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const args = ["--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.glob) args.push("--glob", params.glob);
	args.push("--", params.pattern, searchPath);
	const search = await executor("rg", args, { cwd: mapping.containerRoot, signal });
	if (search.exitCode !== 0 && search.exitCode !== 1) {
		throw new Error(search.stderr.toString("utf8").trim() || `ripgrep exited with code ${search.exitCode}`);
	}

	const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
	let sawAdditionalMatch = false;
	for (const line of search.stdout.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
		try {
			event = JSON.parse(line) as typeof event;
		} catch {
			continue;
		}
		if (event.type !== "match") continue;
		const filePath = event.data?.path?.text;
		const lineNumber = event.data?.line_number;
		if (!filePath || typeof lineNumber !== "number") continue;
		if (matches.length >= effectiveLimit) {
			sawAdditionalMatch = true;
			break;
		}
		matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text });
	}
	if (matches.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const outputLines: string[] = [];
	const fileCache = new Map<string, string[]>();
	let linesTruncated = false;
	const displayPath = (filePath: string) => {
		if (isDirectory) {
			const relativePath = path.relative(searchPath, filePath);
			if (relativePath && !relativePath.startsWith("..")) return relativePath.split(path.sep).join("/");
		}
		return basename(filePath);
	};
	const getLines = async (filePath: string) => {
		const cached = fileCache.get(filePath);
		if (cached) return cached;
		try {
			const result = await executeChecked(executor, "cat", ["--", filePath], { cwd: mapping.containerRoot, signal });
			const lines = normalizeLineEndings(result.stdout.toString("utf8"));
			fileCache.set(filePath, lines);
			return lines;
		} catch {
			return [];
		}
	};

	for (const match of matches) {
		const shownPath = displayPath(match.filePath);
		if (contextLines === 0 && match.lineText !== undefined) {
			const source = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
			const truncated = truncateLine(source);
			if (truncated.wasTruncated) linesTruncated = true;
			outputLines.push(`${shownPath}:${match.lineNumber}: ${truncated.text}`);
			continue;
		}
		const lines = await getLines(match.filePath);
		if (lines.length === 0) {
			outputLines.push(`${shownPath}:${match.lineNumber}: (unable to read file)`);
			continue;
		}
		const start = contextLines > 0 ? Math.max(1, match.lineNumber - contextLines) : match.lineNumber;
		const end = contextLines > 0 ? Math.min(lines.length, match.lineNumber + contextLines) : match.lineNumber;
		for (let current = start; current <= end; current++) {
			const truncated = truncateLine((lines[current - 1] ?? "").replace(/\r/g, ""));
			if (truncated.wasTruncated) linesTruncated = true;
			const separator = current === match.lineNumber ? ":" : "-";
			outputLines.push(`${shownPath}${separator}${current}${separator} ${truncated.text}`);
		}
	}

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	let output = truncation.content;
	// Pi's built-in grep reports the limit as soon as it collects that many matches.
	if (matches.length >= effectiveLimit || sawAdditionalMatch) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length ? details : undefined };
}

function statusText(state: PincusState): string {
	if (!state.enabled || !state.container) return "Pincus: off";
	return `Pincus: ${state.container}${state.containerCwd ? ` cwd=${state.containerCwd}` : ""}`;
}

function activate(state: PincusState, container: string, containerCwd?: string): void {
	state.enabled = true;
	state.container = container;
	state.containerCwd = containerCwd;
}

function deactivate(state: PincusState): void {
	state.enabled = false;
}

function applyUiStatus(ctx: ExtensionContext, state: PincusState): void {
	ctx.ui.setStatus("pincus", state.enabled && state.container ? `pincus:${state.container}` : undefined);
}

function parseActivationArguments(args: string): { container: string; cwd?: string } | undefined {
	const match = args.trim().match(/^(\S+)(?:\s+(.+))?$/);
	if (!match) return undefined;
	return { container: match[1]!, ...(match[2]?.trim() ? { cwd: match[2].trim() } : {}) };
}

export default function registerPincus(pi: ExtensionAPI): void {
	pi.registerFlag("pincus-container", {
		description: "Route Pi's built-in project tools through this Incus container",
		type: "string",
	});
	pi.registerFlag("pincus-cwd", {
		description: "Container path corresponding to Pi's startup directory",
		type: "string",
	});
	pi.registerFlag("no-pincus", {
		description: "Disable Pincus for this process",
		type: "boolean",
		default: false,
	});
	// Compatibility flags from pi-bash-incus 0.2.x.
	pi.registerFlag("incus-container", { description: "Legacy alias for --pincus-container", type: "string" });
	pi.registerFlag("incus-cwd", { description: "Legacy alias for --pincus-cwd", type: "string" });
	pi.registerFlag("no-bash-incus", { description: "Legacy alias for --no-pincus", type: "boolean", default: false });

	const hostRoot = process.cwd();
	const localTools = {
		bash: createBashTool(hostRoot),
		read: createReadTool(hostRoot),
		write: createWriteTool(hostRoot),
		edit: createEditTool(hostRoot),
		ls: createLsTool(hostRoot),
		find: createFindTool(hostRoot),
		grep: createGrepTool(hostRoot),
	};
	const state: PincusState = { enabled: false };
	let overridesRegistered = false;
	let hostSkillRoots: string[] = [];

	const isHostSkillPath = (inputPath: string) => {
		const value = stripAtPrefix(inputPath);
		if (!isAbsolute(value)) return false;
		const absolutePath = resolve(value);
		return hostSkillRoots.some((root) => isWithin(root, absolutePath));
	};

	const activeBackend = () => {
		if (!state.enabled || !state.container) return undefined;
		const mapping = { hostRoot, containerRoot: state.containerCwd ?? hostRoot };
		return { mapping, executor: createIncusExecutor(state.container) };
	};

	const ensureOverridesRegistered = () => {
		if (overridesRegistered) return;
		overridesRegistered = true;

		pi.registerTool({
			...localTools.bash,
			async execute(id, params, signal, onUpdate) {
				const backend = activeBackend();
				if (!backend) return localTools.bash.execute(id, params, signal, onUpdate);
				return createBashTool(backend.mapping.containerRoot, {
					operations: createBashOperations(backend.executor, backend.mapping),
				}).execute(id, params, signal, onUpdate);
			},
		});
		pi.registerTool({
			...localTools.read,
			async execute(id, params, signal, onUpdate) {
				const backend = activeBackend();
				if (!backend || isHostClipboardImagePath(params.path) || isHostSkillPath(params.path)) {
					return localTools.read.execute(id, params, signal, onUpdate);
				}
				return createReadTool(backend.mapping.containerRoot, {
					operations: createReadOperations(backend.executor, backend.mapping, signal),
				}).execute(id, params, signal, onUpdate);
			},
		});
		pi.registerTool({
			...localTools.write,
			async execute(id, params, signal, onUpdate) {
				const backend = activeBackend();
				if (!backend) return localTools.write.execute(id, params, signal, onUpdate);
				return createWriteTool(backend.mapping.containerRoot, {
					operations: createWriteOperations(backend.executor, backend.mapping, signal),
				}).execute(id, params, signal, onUpdate);
			},
		});
		pi.registerTool({
			...localTools.edit,
			async execute(id, params, signal, onUpdate) {
				const backend = activeBackend();
				if (!backend) return localTools.edit.execute(id, params, signal, onUpdate);
				return createEditTool(backend.mapping.containerRoot, {
					operations: createEditOperations(backend.executor, backend.mapping, signal),
				}).execute(id, params, signal, onUpdate);
			},
		});
		pi.registerTool({
			...localTools.ls,
			async execute(id, params, signal, onUpdate) {
				const backend = activeBackend();
				if (!backend) return localTools.ls.execute(id, params, signal, onUpdate);
				return createLsTool(backend.mapping.containerRoot, {
					operations: createLsOperations(backend.executor, backend.mapping, signal),
				}).execute(id, params, signal, onUpdate);
			},
		});
		pi.registerTool({
			...localTools.find,
			async execute(id, params, signal, onUpdate) {
				const backend = activeBackend();
				if (!backend) return localTools.find.execute(id, params, signal, onUpdate);
				return createFindTool(backend.mapping.containerRoot, {
					operations: createFindOperations(backend.executor, backend.mapping, signal),
				}).execute(id, params, signal, onUpdate);
			},
		});
		pi.registerTool({
			...localTools.grep,
			async execute(_id, params, signal, _onUpdate) {
				const backend = activeBackend();
				if (!backend) return localTools.grep.execute(_id, params, signal, _onUpdate);
				return executeIncusGrep(backend.executor, backend.mapping, params, signal);
			},
		});
	};

	pi.on("user_bash", () => {
		const backend = activeBackend();
		if (!backend) return;
		return { operations: createBashOperations(backend.executor, backend.mapping) };
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		const newContainer = pi.getFlag("pincus-container") as string | undefined;
		const oldContainer = pi.getFlag("incus-container") as string | undefined;
		const newCwd = pi.getFlag("pincus-cwd") as string | undefined;
		const oldCwd = pi.getFlag("incus-cwd") as string | undefined;
		const newDisabled = pi.getFlag("no-pincus") as boolean;
		const oldDisabled = pi.getFlag("no-bash-incus") as boolean;

		if (newDisabled || (oldDisabled && !newContainer)) {
			deactivate(state);
		} else {
			const container = newContainer ?? oldContainer ?? config.container;
			const containerCwd = newCwd ?? oldCwd ?? config.cwd;
			if ((newContainer || oldContainer || config.enabled) && container) activate(state, container, containerCwd);
			else deactivate(state);
		}

		if (state.enabled) ensureOverridesRegistered();
		applyUiStatus(ctx, state);
		if (state.enabled) ctx.ui.notify(statusText(state), "info");
	});

	pi.on("before_agent_start", (event) => {
		hostSkillRoots = (event.systemPromptOptions?.skills ?? []).map((skill) => resolve(skill.baseDir));
		if (!state.enabled || !state.container) return;
		const containerRoot = state.containerCwd ?? hostRoot;
		return {
			systemPrompt: `${event.systemPrompt}\n\nPincus mode is enabled. The built-in bash, read, write, edit, ls, find, and grep tools, plus user !/!! commands, run inside existing Incus container ${JSON.stringify(state.container)} as the container user whose UID matches the host UID. Pi started on the host in ${JSON.stringify(hostRoot)}; that directory corresponds to ${JSON.stringify(containerRoot)} in the container. Resolve relative tool paths from the container path. Host absolute paths under ${JSON.stringify(hostRoot)} are translated to the matching path under ${JSON.stringify(containerRoot)}. Other valid container absolute paths are used unchanged. Reads within skills discovered by host Pi stay on the host so their instructions and supporting files remain available. Pi configuration, sessions, custom tools, and MCP tools remain on the host.`,
		};
	});

	const commandHandler = async (args: string, ctx: ExtensionContext) => {
		const trimmed = args.trim();
		if (!trimmed) {
			const configFile = findProjectConfigFile(ctx.cwd);
			if (!configFile) {
				ctx.ui.notify(`No project ${CONFIG_DIR_NAME}/${CONFIG_FILE} found`, "error");
				return;
			}
			if (state.enabled) return;
			const config = readConfigFile(configFile);
			if (!config.container) {
				ctx.ui.notify(`Project ${CONFIG_FILE} has no container`, "error");
				return;
			}
			writeConfigFile(configFile, { ...config, enabled: true });
			activate(state, config.container, config.cwd);
			ensureOverridesRegistered();
			applyUiStatus(ctx, state);
			ctx.ui.notify(statusText(state), "info");
			return;
		}
		if (trimmed === "status") {
			ctx.ui.notify(statusText(state), "info");
			return;
		}
		if (trimmed === "off") {
			writeProjectConfig(ctx.cwd, {
				enabled: false,
				...(state.container ? { container: state.container } : {}),
				...(state.containerCwd ? { cwd: state.containerCwd } : {}),
			});
			deactivate(state);
			applyUiStatus(ctx, state);
			ctx.ui.notify("Pincus disabled", "info");
			return;
		}
		const activation = parseActivationArguments(trimmed);
		if (!activation) {
			ctx.ui.notify("Usage: /pincus <container> [container-cwd]", "error");
			return;
		}
		writeProjectConfig(ctx.cwd, {
			enabled: true,
			container: activation.container,
			...(activation.cwd ? { cwd: activation.cwd } : {}),
		});
		activate(state, activation.container, activation.cwd);
		ensureOverridesRegistered();
		applyUiStatus(ctx, state);
		ctx.ui.notify(statusText(state), "info");
	};

	const command = {
		description: "Configure Pincus: /pincus <container> [container-cwd], /pincus status, /pincus off",
		handler: commandHandler,
	};
	pi.registerCommand("pincus", command);
	pi.registerCommand("bash-incus", {
		description: "Compatibility alias for /pincus",
		handler: commandHandler,
	});
}
