import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerBashIncus, {
	__testCreateIncusExecArgs,
	__testCreateIncusTerminatorArgs,
	__testIncusCommandRunner,
	__testIncusCommandTerminator,
	__testIncusRunAsUser,
} from "../extensions/bash-incus.ts";

const hostUid = String(process.getuid?.() ?? 1000);
assert.deepEqual(__testCreateIncusExecArgs("dev", "/workspace/project", "/tmp/command.pid", "printf ok"), [
	"exec",
	"dev",
	"--cwd",
	"/workspace/project",
	"--",
	"bash",
	"-c",
	__testIncusRunAsUser,
	"bash-incus-user",
	hostUid,
	__testIncusCommandRunner,
	"/tmp/command.pid",
	"printf ok",
]);
assert.deepEqual(__testCreateIncusTerminatorArgs("dev", "/tmp/command.pid"), [
	"exec",
	"dev",
	"--",
	"bash",
	"-c",
	__testIncusCommandTerminator,
	"bash-incus-cleanup",
	"/tmp/command.pid",
]);
assert.doesNotMatch(__testIncusRunAsUser, /\b(?:HOME|USER|LOGNAME|PATH)=/);
assert.doesNotMatch(__testIncusCommandRunner, /\b(?:HOME|USER|LOGNAME|PATH)=/);

const environmentDirectory = await mkdtemp(join(tmpdir(), "pi-bash-incus-environment-"));
const environmentPidFile = join(environmentDirectory, "group.pid");
const runuserRecordFile = join(environmentDirectory, "runuser.txt");
await writeFile(
	join(environmentDirectory, "id"),
	'#!/bin/sh\n[ "$1" = "-nu" ] || exit 1\nprintf "merlin\\n"\n',
	{ mode: 0o755 },
);
await writeFile(
	join(environmentDirectory, "runuser"),
	'#!/bin/sh\n[ "$1" = "-u" ] && [ "$2" = "merlin" ] && [ "$3" = "--" ] || exit 1\nprintf "%s\\n" "$2" > "$RUNUSER_RECORD"\nshift 3\nexport HOME=/home/merlin USER=merlin LOGNAME=merlin\nexec "$@"\n',
	{ mode: 0o755 },
);
const environmentRunner = spawn(
	"bash",
	[
		"-c",
		__testIncusRunAsUser,
		"bash-incus-user",
		hostUid,
		__testIncusCommandRunner,
		environmentPidFile,
		'printf "%s\\n" "$HOME"',
	],
	{
		env: {
			...process.env,
			HOME: "/host/home",
			PATH: `${environmentDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			RUNUSER_RECORD: runuserRecordFile,
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);
const environmentOutput: Buffer[] = [];
const environmentErrors: Buffer[] = [];
environmentRunner.stdout.on("data", (data) => environmentOutput.push(data));
environmentRunner.stderr.on("data", (data) => environmentErrors.push(data));
const [environmentCode] = (await once(environmentRunner, "close")) as [number | null];
assert.equal(environmentCode, 0, Buffer.concat(environmentErrors).toString());
assert.equal(Buffer.concat(environmentOutput).toString().trim(), "/home/merlin");
assert.equal((await readFile(runuserRecordFile, "utf8")).trim(), "merlin");
await rm(environmentDirectory, { recursive: true, force: true });

const testAgentDir = await mkdtemp(join(tmpdir(), "pi-bash-incus-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const handlers = new Map<string, (...args: any[]) => unknown>();
const registeredTools: unknown[] = [];
const notifications: Array<{ message: string; level: string }> = [];
let bashIncusCommand: { handler: (args: string, ctx: any) => unknown } | undefined;

try {
	process.env.PI_CODING_AGENT_DIR = testAgentDir;
	await writeFile(join(testAgentDir, "incus-bash.json"), '{"enabled":false,"container":"global"}\n');
	registerBashIncus({
		registerFlag: () => {},
		registerTool: (tool: unknown) => registeredTools.push(tool),
		on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
		registerCommand: (name: string, command: unknown) => {
			if (name === "bash-incus") bashIncusCommand = command as typeof bashIncusCommand;
		},
		getFlag: (name: string) => (name === "no-bash-incus" ? false : undefined),
	} as any);

	const ctx = {
		cwd: testAgentDir,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: () => {},
		},
	};
	await handlers.get("session_start")?.({}, ctx);
	assert.equal(registeredTools.length, 0);
	assert.ok(bashIncusCommand);
	assert.deepEqual(JSON.parse(await readFile(join(testAgentDir, "bash-incus.json"), "utf8")), {
		enabled: false,
		container: "global",
	});
	await assert.rejects(readFile(join(testAgentDir, "incus-bash.json")));

	await bashIncusCommand.handler("", ctx);
	assert.deepEqual(notifications.at(-1), { message: "No project .pi/bash-incus.json found", level: "error" });

	await mkdir(join(testAgentDir, ".pi"));
	await writeFile(
		join(testAgentDir, ".pi", "incus-bash.json"),
		'{"enabled":false,"container":"dev","cwd":"/workspace/project"}\n',
	);
	await bashIncusCommand.handler("", ctx);
	assert.equal(registeredTools.length, 1);
	const bashTool = registeredTools[0] as { parameters: { properties: Record<string, unknown> } };
	assert.deepEqual(Object.keys(bashTool.parameters.properties).sort(), ["command", "timeout"]);
	assert.deepEqual(JSON.parse(await readFile(join(testAgentDir, ".pi", "bash-incus.json"), "utf8")), {
		enabled: true,
		container: "dev",
		cwd: "/workspace/project",
	});
	await assert.rejects(readFile(join(testAgentDir, ".pi", "incus-bash.json")));
	assert.deepEqual(notifications.at(-1), {
		message: "Incus bash: dev cwd=/workspace/project",
		level: "info",
	});

	const notificationCount = notifications.length;
	await bashIncusCommand.handler("", ctx);
	assert.equal(notifications.length, notificationCount);

	await bashIncusCommand.handler("off", ctx);
	assert.deepEqual(JSON.parse(await readFile(join(testAgentDir, ".pi", "bash-incus.json"), "utf8")), {
		enabled: false,
		container: "dev",
		cwd: "/workspace/project",
	});

	await bashIncusCommand.handler("", ctx);
	assert.deepEqual(JSON.parse(await readFile(join(testAgentDir, ".pi", "bash-incus.json"), "utf8")), {
		enabled: true,
		container: "dev",
		cwd: "/workspace/project",
	});
	assert.equal(registeredTools.length, 1);

	await bashIncusCommand.handler("next /workspace/next", ctx);
	assert.deepEqual(JSON.parse(await readFile(join(testAgentDir, ".pi", "bash-incus.json"), "utf8")), {
		enabled: true,
		container: "next",
		cwd: "/workspace/next",
	});
	await handlers.get("session_shutdown")?.();
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(testAgentDir, { recursive: true, force: true });
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			await readFile(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const tempDirectory = await mkdtemp(join(tmpdir(), "pi-bash-incus-"));
const groupPidFile = join(tempDirectory, "group.pid");
const childPidFile = join(tempDirectory, "child.pid");
const command = `bash -c 'printf "%s\\n" "$$" > "$TEST_CHILD_PID_FILE"; sleep 60' & wait`;
const runner = spawn("setsid", ["bash", "-c", __testIncusCommandRunner, "bash-incus", groupPidFile, command], {
	env: { ...process.env, TEST_CHILD_PID_FILE: childPidFile },
	stdio: "ignore",
});
const runnerClosed = once(runner, "close");

try {
	await waitForFile(groupPidFile);
	await waitForFile(childPidFile);
	const childPid = Number(await readFile(childPidFile, "utf8"));
	assert.equal(isAlive(childPid), true);

	const terminator = spawn("bash", ["-c", __testIncusCommandTerminator, "bash-incus-cleanup", groupPidFile], {
		stdio: "ignore",
	});
	const [terminatorCode] = (await once(terminator, "close")) as [number | null];
	assert.equal(terminatorCode, 0);
	await runnerClosed;
	assert.equal(isAlive(childPid), false);
} finally {
	if (runner.exitCode === null) runner.kill("SIGKILL");
	await rm(tempDirectory, { recursive: true, force: true });
}
