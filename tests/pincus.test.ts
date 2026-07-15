import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import registerPincus, {
	__testIncusOperationRunner,
	__testIncusProcessTerminator,
	__testIncusRunAsUser,
	createIncusExecArgs,
	createIncusExecutor,
	createIncusTerminatorArgs,
	mapPincusPath,
} from "../extensions/pincus.ts";

const hostUid = String(process.getuid?.() ?? 1000);
const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPath = process.env.PATH;

interface Harness {
	hostRoot: string;
	containerRoot: string;
	agentRoot: string;
	tools: Map<string, any>;
	commands: Map<string, any>;
	handlers: Map<string, (...args: any[]) => any>;
	notifications: Array<{ message: string; level: string }>;
	ctx: any;
	cleanup: () => Promise<void>;
}

async function makeFakeIncus(directory: string): Promise<void> {
	const fakeIncus = join(directory, "incus");
	await writeFile(
		fakeIncus,
		`#!/usr/bin/env bash
set -euo pipefail
[ "$1" = exec ]
shift
container=$1
shift
cwd=
if [ "\${1:-}" = --cwd ]; then
  cwd=$2
  shift 2
fi
[ "$1" = -- ]
shift
if [ -n "$cwd" ]; then cd "$cwd"; fi
if [ "$4" = pincus-user ]; then
  runner=$6
  pid_file=$7
  shift 7
  exec setsid bash -lc "$runner" pincus-operation "$pid_file" "$@"
fi
if [ "$4" = pincus-cleanup ]; then
  exec bash -c "$3" "$4" "$5"
fi
exit 97
`,
	);
	await chmod(fakeIncus, 0o755);
}

async function createHarness(options: {
	projectConfig?: { name?: "pincus.json" | "bash-incus.json" | "incus-bash.json"; value: unknown };
	globalConfig?: { name?: "pincus.json" | "bash-incus.json" | "incus-bash.json"; value: unknown };
	flags?: Record<string, unknown>;
} = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "pincus-test-"));
	const hostRoot = join(root, "host project");
	const containerRoot = join(root, "container project");
	const agentRoot = join(root, "agent");
	const binRoot = join(root, "bin");
	await Promise.all([mkdir(hostRoot), mkdir(containerRoot), mkdir(agentRoot), mkdir(binRoot)]);
	await makeFakeIncus(binRoot);
	if (options.projectConfig) {
		await mkdir(join(hostRoot, ".pi"));
		await writeFile(
			join(hostRoot, ".pi", options.projectConfig.name ?? "pincus.json"),
			`${JSON.stringify(options.projectConfig.value)}\n`,
		);
	}
	if (options.globalConfig) {
		await writeFile(
			join(agentRoot, options.globalConfig.name ?? "pincus.json"),
			`${JSON.stringify(options.globalConfig.value)}\n`,
		);
	}

	process.chdir(hostRoot);
	process.env.PI_CODING_AGENT_DIR = agentRoot;
	process.env.PATH = `${binRoot}:${originalPath}`;
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const notifications: Array<{ message: string; level: string }> = [];
	const flags = options.flags ?? {};
	registerPincus({
		registerFlag: () => {},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		getFlag: (name: string) => {
			if (Object.hasOwn(flags, name)) return flags[name];
			return name === "no-pincus" || name === "no-bash-incus" ? false : undefined;
		},
	} as any);
	const ctx = {
		cwd: hostRoot,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: () => {},
		},
	};

	return {
		hostRoot,
		containerRoot,
		agentRoot,
		tools,
		commands,
		handlers,
		notifications,
		ctx,
		cleanup: async () => {
			process.chdir(originalCwd);
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function execute(tool: any, params: unknown, signal?: AbortSignal): Promise<any> {
	return tool.execute("test-call", params, signal, undefined);
}

async function waitForFile(filePath: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			await readFile(filePath);
			return;
		} catch {
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		}
	}
	throw new Error(`Timed out waiting for ${filePath}`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("path mapping supports different host and container roots", () => {
	const mapping = { hostRoot: "/home/david/project", containerRoot: "/workspace/project" };
	assert.equal(mapPincusPath(mapping, "src/file.ts"), "/workspace/project/src/file.ts");
	assert.equal(mapPincusPath(mapping, "../shared/file.ts"), "/workspace/shared/file.ts");
	assert.equal(mapPincusPath(mapping, "/home/david/project/src/file.ts"), "/workspace/project/src/file.ts");
	assert.equal(mapPincusPath(mapping, "/workspace/project/src/file.ts"), "/workspace/project/src/file.ts");
	assert.equal(mapPincusPath(mapping, "/etc/os-release"), "/etc/os-release");
	assert.equal(mapPincusPath(mapping, "@src/file.ts"), "/workspace/project/src/file.ts");
});

test("Incus argv keeps paths and commands out of shell source", () => {
	const args = createIncusExecArgs(
		"dev; untouched",
		"/workspace/a path;$(false)",
		"/tmp/pincus.pid",
		"tee",
		["--", "/workspace/weird;$(touch nope).txt"],
	);
	assert.deepEqual(args.slice(0, 6), ["exec", "dev; untouched", "--cwd", "/workspace/a path;$(false)", "--", "bash"]);
	assert.equal(args.at(-1), "/workspace/weird;$(touch nope).txt");
	assert.equal(args.includes(__testIncusRunAsUser), true);
	assert.deepEqual(createIncusTerminatorArgs("dev", "/tmp/pincus.pid"), [
		"exec",
		"dev",
		"--",
		"bash",
		"-c",
		__testIncusProcessTerminator,
		"pincus-cleanup",
		"/tmp/pincus.pid",
	]);
});

test("runuser resolves the matching UID and initializes the container user's environment", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pincus-env-"));
	const pidFile = join(directory, "group.pid");
	const recordFile = join(directory, "runuser.txt");
	try {
		await writeFile(join(directory, "id"), '#!/bin/sh\n[ "$1" = "-nu" ] || exit 1\nprintf "merlin\\n"\n', { mode: 0o755 });
		await writeFile(
			join(directory, "runuser"),
			'#!/bin/sh\n[ "$1" = "-u" ] && [ "$2" = "merlin" ] && [ "$3" = "--" ] || exit 1\nprintf "%s\\n" "$2" > "$RUNUSER_RECORD"\nshift 3\nexport HOME=/home/merlin USER=merlin LOGNAME=merlin\nexec "$@"\n',
			{ mode: 0o755 },
		);
		const child = spawn(
			"bash",
			[
				"-c",
				__testIncusRunAsUser,
				"pincus-user",
				hostUid,
				__testIncusOperationRunner,
				pidFile,
				"bash",
				"-lc",
				'printf "%s|%s|%s\\n" "$HOME" "$USER" "$LOGNAME"',
			],
			{
				env: {
					...process.env,
					HOME: "/host/home",
					PATH: `${directory}:${originalPath ?? "/usr/bin:/bin"}`,
					RUNUSER_RECORD: recordFile,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (data) => stdout.push(data));
		child.stderr.on("data", (data) => stderr.push(data));
		const [code] = (await once(child, "close")) as [number | null];
		assert.equal(code, 0, Buffer.concat(stderr).toString());
		assert.match(Buffer.concat(stdout).toString().trim(), /^\/home\/merlin\|/);
		assert.equal((await readFile(recordFile, "utf8")).trim(), "merlin");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("activation, aliases, migration, deactivation, and one-time override registration", async () => {
	const harness = await createHarness({
		globalConfig: { name: "incus-bash.json", value: { enabled: false, container: "global" } },
	});
	try {
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		assert.equal(harness.tools.size, 0, "unconfigured projects must not replace another backend");
		assert.ok(harness.commands.has("pincus"));
		assert.ok(harness.commands.has("bash-incus"));
		assert.deepEqual(JSON.parse(await readFile(join(harness.agentRoot, "pincus.json"), "utf8")), {
			enabled: false,
			container: "global",
		});
		await assert.rejects(readFile(join(harness.agentRoot, "incus-bash.json")));

		await harness.commands.get("pincus").handler(`dev ${harness.containerRoot}`, harness.ctx);
		assert.deepEqual([...harness.tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
		for (const tool of harness.tools.values()) assert.equal(tool.name in Object.fromEntries(harness.tools), true);
		assert.deepEqual(JSON.parse(await readFile(join(harness.hostRoot, ".pi", "pincus.json"), "utf8")), {
			enabled: true,
			container: "dev",
			cwd: harness.containerRoot,
		});
		assert.match(harness.notifications.at(-1)!.message, /^Pincus: dev cwd=/);

		await harness.commands.get("bash-incus").handler("off", harness.ctx);
		assert.equal(harness.notifications.at(-1)!.message, "Pincus disabled");
		assert.equal(harness.tools.size, 7);
		assert.equal(await harness.handlers.get("user_bash")?.({}, harness.ctx), undefined);

		await harness.commands.get("bash-incus").handler("", harness.ctx);
		assert.equal(harness.tools.size, 7);
		assert.ok(await harness.handlers.get("user_bash")?.({}, harness.ctx));
		await harness.commands.get("pincus").handler(`next ${harness.containerRoot}`, harness.ctx);
		assert.equal(harness.tools.size, 7);
		await harness.commands.get("pincus").handler("status", harness.ctx);
		assert.match(harness.notifications.at(-1)!.message, /^Pincus: next/);
	} finally {
		await harness.cleanup();
	}
});

test("saved configuration and legacy flags activate Pincus", async () => {
	const configured = await createHarness({
		projectConfig: { value: { enabled: true, container: "configured", cwd: "/configured" } },
	});
	try {
		await configured.handlers.get("session_start")?.({}, configured.ctx);
		assert.equal(configured.tools.size, 7);
		assert.equal(configured.notifications.at(-1)!.message, "Pincus: configured cwd=/configured");
	} finally {
		await configured.cleanup();
	}

	const legacyFlags = await createHarness({
		flags: { "incus-container": "legacy", "incus-cwd": "/legacy-root" },
	});
	try {
		await legacyFlags.handlers.get("session_start")?.({}, legacyFlags.ctx);
		assert.equal(legacyFlags.tools.size, 7);
		assert.equal(legacyFlags.notifications.at(-1)!.message, "Pincus: legacy cwd=/legacy-root");
	} finally {
		await legacyFlags.cleanup();
	}
});

test("bash-incus.json migrates and new flags take precedence over old flags", async () => {
	const harness = await createHarness({
		projectConfig: {
			name: "bash-incus.json",
			value: { enabled: true, container: "configured", cwd: "/configured" },
		},
		flags: {
			"pincus-container": "new",
			"pincus-cwd": "/new-root",
			"incus-container": "old",
			"incus-cwd": "/old-root",
			"no-bash-incus": true,
		},
	});
	try {
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		assert.equal(harness.tools.size, 7, "the new enable flag must override the old disable flag");
		assert.deepEqual(JSON.parse(await readFile(join(harness.hostRoot, ".pi", "pincus.json"), "utf8")), {
			enabled: true,
			container: "configured",
			cwd: "/configured",
		});
		await assert.rejects(readFile(join(harness.hostRoot, ".pi", "bash-incus.json")));
		assert.equal(harness.notifications.at(-1)!.message, "Pincus: new cwd=/new-root");
	} finally {
		await harness.cleanup();
	}

	const disabled = await createHarness({
		projectConfig: { value: { enabled: true, container: "configured" } },
		flags: { "pincus-container": "new", "no-pincus": true },
	});
	try {
		await disabled.handlers.get("session_start")?.({}, disabled.ctx);
		assert.equal(disabled.tools.size, 0, "--no-pincus must override every enable source");
	} finally {
		await disabled.cleanup();
	}
});

test("all built-in project tools route to a differently mounted container root", async () => {
	const harness = await createHarness();
	try {
		await harness.commands.get("pincus").handler(`dev ${harness.containerRoot}`, harness.ctx);
		const prompt = await harness.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, harness.ctx);
		assert.match(prompt.systemPrompt, new RegExp(`started on the host in ${JSON.stringify(harness.hostRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(prompt.systemPrompt, new RegExp(`corresponds to ${JSON.stringify(harness.containerRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

		const oddName = "odd ; $(touch PINCUS_INJECTED).txt";
		const writeResult = await execute(harness.tools.get("write"), {
			path: oddName,
			content: "alpha\nneedle one\nomega\n",
		});
		assert.equal(writeResult.details, undefined);
		assert.equal(await readFile(join(harness.containerRoot, oddName), "utf8"), "alpha\nneedle one\nomega\n");
		await assert.rejects(readFile(join(harness.containerRoot, "PINCUS_INJECTED")));

		const readResult = await execute(harness.tools.get("read"), { path: join(harness.hostRoot, oddName) });
		assert.equal(readResult.content[0].text, "alpha\nneedle one\nomega\n");

		const editResult = await execute(harness.tools.get("edit"), {
			path: oddName,
			edits: [{ oldText: "needle one", newText: "needle two" }],
		});
		assert.match(editResult.details.diff, /needle two/);
		assert.match(editResult.details.patch, /needle two/);

		await mkdir(join(harness.containerRoot, "sub directory"));
		await writeFile(join(harness.containerRoot, "sub directory", "match.ts"), "needle two\nneedle three\n");
		const lsResult = await execute(harness.tools.get("ls"), { path: "." });
		assert.match(lsResult.content[0].text, /sub directory\//);
		assert.match(lsResult.content[0].text, /odd ; \$\(touch PINCUS_INJECTED\)\.txt/);

		const findResult = await execute(harness.tools.get("find"), { pattern: "*.ts", path: "." });
		assert.equal(findResult.content[0].text, "sub directory/match.ts");
		assert.equal(findResult.details, undefined);

		const grepResult = await execute(harness.tools.get("grep"), {
			pattern: "needle",
			path: ".",
			glob: "*.ts",
			limit: 1,
		});
		assert.match(grepResult.content[0].text, /^sub directory\/match\.ts:1: needle two/);
		assert.equal(grepResult.details.matchLimitReached, 1);
		assert.equal("fullOutputPath" in (grepResult.details ?? {}), false);

		const bashResult = await execute(harness.tools.get("bash"), {
			command: 'printf "stdout\\n"; printf "stderr\\n" >&2; printf "%s\\n" "$PWD"',
		});
		assert.match(bashResult.content[0].text, /stdout/);
		assert.match(bashResult.content[0].text, /stderr/);
		assert.match(bashResult.content[0].text, new RegExp(harness.containerRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

		const fileStat = await stat(join(harness.containerRoot, oddName));
		assert.equal(String(fileStat.uid), hostUid);
		await assert.rejects(readFile(join(harness.hostRoot, oddName)), "host and container roots must remain distinct");
	} finally {
		await harness.cleanup();
	}
});

test("binary image reads preserve built-in image result shape", async () => {
	const harness = await createHarness();
	try {
		await harness.commands.get("pincus").handler(`dev ${harness.containerRoot}`, harness.ctx);
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		await writeFile(join(harness.containerRoot, "pixel.png"), png);
		const result = await execute(harness.tools.get("read"), { path: "pixel.png" });
		assert.match(result.content[0].text, /^Read image file \[image\/png\]/);
		assert.equal(result.content[1].type, "image");
		assert.equal(result.content[1].mimeType, "image/png");
		assert.ok(result.content[1].data.length > 0);
	} finally {
		await harness.cleanup();
	}
});

test("grep preserves limits, result details, long-line notices, and byte truncation", async () => {
	const harness = await createHarness();
	try {
		await harness.commands.get("pincus").handler(`dev ${harness.containerRoot}`, harness.ctx);
		await writeFile(join(harness.containerRoot, "long.txt"), `needle ${"x".repeat(600)}\nneedle second\n`);
		const limited = await execute(harness.tools.get("grep"), { pattern: "needle", path: "long.txt", limit: 1 });
		assert.equal(limited.details.matchLimitReached, 1);
		assert.equal(limited.details.linesTruncated, true);
		assert.match(limited.content[0].text, /Some lines truncated to 500 chars/);

		const manyLines = Array.from({ length: 180 }, (_, index) => `needle-${index} ${"z".repeat(400)}`).join("\n");
		await writeFile(join(harness.containerRoot, "many.txt"), `${manyLines}\n`);
		const truncated = await execute(harness.tools.get("grep"), { pattern: "needle", path: "many.txt", limit: 180 });
		assert.equal(truncated.details.matchLimitReached, 180);
		assert.equal(truncated.details.truncation.truncated, true);
		assert.match(truncated.content[0].text, /KB limit reached/);
	} finally {
		await harness.cleanup();
	}
});

test("disabled overrides delegate to Pi's local tools", async () => {
	const harness = await createHarness();
	try {
		await harness.commands.get("pincus").handler(`dev ${harness.containerRoot}`, harness.ctx);
		await harness.commands.get("pincus").handler("off", harness.ctx);
		const result = await execute(harness.tools.get("write"), { path: "local.txt", content: "local\n" });
		assert.match(result.content[0].text, /Successfully wrote/);
		assert.equal(await readFile(join(harness.hostRoot, "local.txt"), "utf8"), "local\n");
		await assert.rejects(readFile(join(harness.containerRoot, "local.txt")));
	} finally {
		await harness.cleanup();
	}
});

test("cancellation and timeout terminate the whole container process group", async () => {
	const harness = await createHarness();
	try {
		const executor = createIncusExecutor("dev");
		const childPidFile = join(harness.containerRoot, "child.pid");
		const controller = new AbortController();
		const running = executor(
			"bash",
			["-lc", `bash -c 'printf "%s\\n" "$$" > "$1"; sleep 60' child ${JSON.stringify(childPidFile)} & wait`],
			{ cwd: harness.containerRoot, signal: controller.signal },
		);
		await waitForFile(childPidFile);
		const childPid = Number(await readFile(childPidFile, "utf8"));
		assert.equal(isAlive(childPid), true);
		controller.abort();
		await assert.rejects(running, /aborted/);
		assert.equal(isAlive(childPid), false);

		const timeoutPidFile = join(harness.containerRoot, "timeout-child.pid");
		const timed = executor(
			"bash",
			["-lc", `bash -c 'printf "%s\\n" "$$" > "$1"; sleep 60' child ${JSON.stringify(timeoutPidFile)} & wait`],
			{ cwd: harness.containerRoot, timeout: 0.5 },
		);
		const timedRejection = assert.rejects(timed, /timeout:0\.5/);
		await waitForFile(timeoutPidFile);
		const timeoutPid = Number(await readFile(timeoutPidFile, "utf8"));
		await timedRejection;
		assert.equal(isAlive(timeoutPid), false);
	} finally {
		await harness.cleanup();
	}
});

test("the standalone process-group scripts kill descendants", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pincus-group-"));
	const groupPidFile = join(directory, "group.pid");
	const childPidFile = join(directory, "child.pid");
	const command = `bash -c 'printf "%s\\n" "$$" > "$TEST_CHILD_PID_FILE"; sleep 60' & wait`;
	const runner = spawn("setsid", ["bash", "-c", __testIncusOperationRunner, "pincus", groupPidFile, "bash", "-lc", command], {
		env: { ...process.env, TEST_CHILD_PID_FILE: childPidFile },
		stdio: "ignore",
	});
	const closed = once(runner, "close");
	try {
		await waitForFile(groupPidFile);
		await waitForFile(childPidFile);
		const childPid = Number(await readFile(childPidFile, "utf8"));
		const terminator = spawn("bash", ["-c", __testIncusProcessTerminator, "pincus-cleanup", groupPidFile], {
			stdio: "ignore",
		});
		const [code] = (await once(terminator, "close")) as [number | null];
		assert.equal(code, 0);
		await closed;
		assert.equal(isAlive(childPid), false);
	} finally {
		if (runner.exitCode === null) runner.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
});

test.after(async () => {
	process.chdir(originalCwd);
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
});
