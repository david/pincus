import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerBashIncus, {
	__testCreateIncusExecUserEnvArgs,
	__testIncusCommandRunner,
	__testIncusCommandTerminator,
} from "../extensions/bash-incus.ts";

const environmentArgs = __testCreateIncusExecUserEnvArgs({
	USER: "alice",
	HOME: "/srv/alice",
	PATH: "/opt/alice/bin:/usr/bin",
});
assert.ok(environmentArgs.includes("HOME=/srv/alice"));
assert.ok(environmentArgs.includes("USER=alice"));
assert.ok(environmentArgs.includes("LOGNAME=alice"));
assert.ok(environmentArgs.includes("PATH=/opt/alice/bin:/usr/bin"));

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
