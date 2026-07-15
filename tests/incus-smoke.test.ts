import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createIncusExecutor } from "../extensions/pincus.ts";

const execFile = promisify(execFileCallback);
const container = process.env.PINCUS_INCUS_CONTAINER;
const enabled = process.env.PINCUS_INCUS_SMOKE === "1" && Boolean(container);

test(
	"optional real-Incus smoke test uses a fixture mounted at a different container path",
	{ skip: enabled ? false : "set PINCUS_INCUS_SMOKE=1 and PINCUS_INCUS_CONTAINER=<running-container>" },
	async () => {
		const fixture = await mkdtemp(join(tmpdir(), "pincus-incus-smoke-"));
		const device = `pincus-smoke-${process.pid}`;
		const containerPath = process.env.PINCUS_INCUS_SMOKE_CWD ?? `/tmp/${device}`;
		try {
			await execFile("incus", [
				"config",
				"device",
				"add",
				container!,
				device,
				"disk",
				`source=${fixture}`,
				`path=${containerPath}`,
				"shift=true",
			]);
			const executor = createIncusExecutor(container!);
			const written = await executor("tee", ["--", `${containerPath}/smoke.txt`], {
				cwd: containerPath,
				stdin: "real incus\n",
				captureStdout: false,
			});
			assert.equal(written.exitCode, 0, written.stderr.toString());
			assert.equal(await readFile(join(fixture, "smoke.txt"), "utf8"), "real incus\n");
			const read = await executor("cat", ["--", `${containerPath}/smoke.txt`], { cwd: containerPath });
			assert.equal(read.stdout.toString(), "real incus\n");
			const identity = await executor(
				"bash",
				["-lc", 'printf "%s|%s|%s\\n" "$(id -u)" "$USER" "$HOME"'],
				{ cwd: containerPath },
			);
			assert.match(identity.stdout.toString(), new RegExp(`^${process.getuid?.() ?? 1000}\\|[^|]+\\|/`));
		} finally {
			await execFile("incus", ["config", "device", "remove", container!, device]).catch(() => {});
			await rm(fixture, { recursive: true, force: true });
		}
	},
);
