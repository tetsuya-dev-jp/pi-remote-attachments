import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	AttachmentManager,
	type PersistedState,
	buildSftpArgs,
	buildSftpBatch,
	normalizeConfig,
	parseSftpListings,
	parseWindowsPaths,
	windowsPathToSftpPath,
} from "../core.ts";

test("parses quoted Windows paths with spaces and multiple files", () => {
	const input =
		'"C:\\Users\\windows-user\\My Documents\\paper.pdf" "D:/資料/結果.csv" read these';
	const matches = parseWindowsPaths(input);
	assert.deepEqual(matches.map((match) => match.path), [
		"C:\\Users\\windows-user\\My Documents\\paper.pdf",
		"D:/資料/結果.csv",
	]);
});

test("does not treat URLs or invalid Windows paths as attachments", () => {
	assert.deepEqual(parseWindowsPaths("https://example.test/C:/not-a-local-path"), []);
	assert.deepEqual(parseWindowsPaths("C:\\foo?bar"), []);
	assert.deepEqual(parseWindowsPaths("C:/foo:bar"), []);
	assert.deepEqual(parseWindowsPaths("mention C:/safe/file.txt"), [
		{ start: 8, end: 24, path: "C:/safe/file.txt" },
	]);
});

test("uses Windows OpenSSH SFTP drive namespace", () => {
	assert.equal(
		windowsPathToSftpPath("C:\\Users\\windows-user\\Downloads\\Pi Remote Attachments 実装計画書.md"),
		"/C:/Users/windows-user/Downloads/Pi Remote Attachments 実装計画書.md",
	);
	assert.equal(windowsPathToSftpPath("D:/資料/result.csv"), "/D:/資料/result.csv");
});

test("builds non-interactive strict SFTP invocation", () => {
	const args = buildSftpArgs({
		host: "pc",
		username: "windows-user",
		port: 22,
		identityFile: "/home/ubuntu-user/.ssh/id_ed25519",
		knownHostsFile: "/home/ubuntu-user/.ssh/known_hosts",
		hostKeyAlias: "pc",
	});
	assert.ok(args.includes("-oBatchMode=yes"));
	assert.ok(args.includes("-oStrictHostKeyChecking=yes"));
	assert.ok(args.includes("-oPreferredAuthentications=publickey"));
	assert.ok(args.includes("-oUserKnownHostsFile=/home/ubuntu-user/.ssh/known_hosts"));
	assert.ok(args.includes("-oHostKeyAlias=pc"));
	assert.deepEqual(args.slice(args.indexOf("-P"), args.indexOf("-P") + 2), ["-P", "22"]);
	assert.equal(args.at(-1), "windows-user@pc");
	assert.equal(
		buildSftpBatch(['get "/C:/a b.txt" "/tmp/a b.txt"']),
		'get "/C:/a b.txt" "/tmp/a b.txt"\n',
	);
});

test("parses Windows OpenSSH long listings", () => {
	const output = [
		"sftp> ls -l \"/C:/Users/windows-user/Downloads/Pi Remote Attachments 実装計画書.md\"",
		"-rw-------    ? 0        0           19413 Sep  8 15:49 /C:/Users/windows-user/Downloads/Pi Remote Attachments 実装計画書.md",
		"drwx******    1 -        -               0 Sep  8 00:41 agents",
	].join("\n");
	assert.deepEqual(parseSftpListings(output), [
		{
			mode: "-rw-------",
			size: 19413,
			name: "/C:/Users/windows-user/Downloads/Pi Remote Attachments 実装計画書.md",
		},
		{ mode: "drwx******", size: 0, name: "agents" },
	]);
});

test("restores ready attachment only when local materialization matches", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-attachments-"));
	const sessionId = "session-123";
	const id = "0123456789abcdef";
	const destination = join(root, sessionId, id, "paper.pdf");
	await mkdir(join(root, sessionId, id), { recursive: true });
	await writeFile(destination, "hello");
	const manager = new AttachmentManager({
		rootDir: root,
		sessionId,
			config: { windows: { host: "pc", username: "windows-user" } },
	});
	const state: PersistedState = {
		version: 1,
		sessionId,
		attachments: [{
			id,
			sessionId,
			source: {
				platform: "windows",
				host: "pc",
				path: "C:/Users/windows-user/paper.pdf",
			},
			name: "paper.pdf",
			type: "file",
			destinationPath: destination,
			size: 5,
			status: "ready",
			placeholder: "[paper.pdf]",
		}],
	};
	await manager.restore(state);
	assert.equal(manager.list()[0].status, "ready");
	assert.equal(
		manager.transformPrompt("[paper.pdf] read this"),
		"Attached files:\n\n- paper.pdf\n  " + destination + "\n\nUser request:\nread this",
	);
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("invalidates attachments when Windows host changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-attachments-"));
	const sessionId = "session-host-change";
	const id = "fedcba9876543210";
	const destination = join(root, sessionId, id, "paper.pdf");
	await mkdir(join(root, sessionId, id), { recursive: true });
	await writeFile(destination, "hello");
	const manager = new AttachmentManager({
		rootDir: root,
		sessionId,
			config: { windows: { host: "new-pc", username: "windows-user" } },
	});
	await manager.restore({
		version: 1,
		sessionId,
		attachments: [{
			id,
			sessionId,
			source: { platform: "windows", host: "old-pc", path: "C:/Users/windows-user/paper.pdf" },
			name: "paper.pdf",
			type: "file",
			destinationPath: destination,
			size: 5,
			status: "ready",
			placeholder: "[paper.pdf]",
		}],
	});
	assert.equal(manager.list()[0].status, "failed");
	assert.equal(manager.list()[0].errorCode, "WINDOWS_HOST_NOT_FOUND");
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("removes attachment data and orphan directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-attachments-"));
	const sessionId = "session-cleanup";
	const id = "0011223344556677";
	const destination = join(root, sessionId, id, "paper.pdf");
	await mkdir(join(root, sessionId, id), { recursive: true });
	await writeFile(destination, "hello");
	await mkdir(join(root, sessionId, "orphan"), { recursive: true });
	const manager = new AttachmentManager({
		rootDir: root,
		sessionId,
			config: { windows: { host: "pc", username: "windows-user" } },
	});
	await manager.restore({
		version: 1,
		sessionId,
		attachments: [{
			id,
			sessionId,
			source: { platform: "windows", host: "pc", path: "C:/Users/windows-user/paper.pdf" },
			name: "paper.pdf",
			type: "file",
			destinationPath: destination,
			size: 5,
			status: "ready",
			placeholder: "[paper.pdf]",
		}],
	});
	assert.equal(await manager.cleanup(), 1);
	assert.equal(await manager.remove("1"), true);
	assert.equal(manager.list().length, 0);
	await assert.rejects(() => import("node:fs/promises").then(({ stat }) => stat(destination)));
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("normalizes malformed config without accepting unsafe values", () => {
	const config = normalizeConfig({
		windows: { host: "pc", username: "windows-user", port: 22 },
		maxParallel: 99,
		limits: { maxFileBytes: -1 },
	});
	assert.equal(config.windows.host, "pc");
	assert.equal(config.windows.username, "windows-user");
	assert.equal(config.windows.port, 22);
	assert.equal(config.maxParallel, 16);
	assert.equal(config.limits?.maxFileBytes, 2 * 1024 ** 3);
});
