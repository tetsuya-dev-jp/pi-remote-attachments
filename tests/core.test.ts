import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BracketedPasteTransformer, END_PASTE, START_PASTE } from "../editor.ts";
import {
	AttachmentManager,
	type PersistedState,
	type PersistedStateV1,
	type SftpRunner,
	buildSftpArgs,
	buildSftpBatch,
	migratePersistedState,
	normalizeConfig,
	parseDroppedPaths,
	parseSftpListings,
	posixPathAdapter,
	resolveSourceConfig,
	resolveSourceRemote,
	saveConfig,
	windowsPathAdapter,
} from "../core.ts";

function replaceParsedPaths(text: string, options: { allowPosix?: boolean } = {}): string {
	const matches = parseDroppedPaths(text, options);
	let result = text;
	for (let index = matches.length - 1; index >= 0; index--) {
		const match = matches[index];
		const name = match.path.split("/").filter(Boolean).at(-1) || "attachment";
		result = result.slice(0, match.start) + "[" + name + "]" + result.slice(match.end);
	}
	return result;
}

test("parses quoted Windows paths with spaces and multiple files", () => {
	const input =
		'"C:\\Users\\windows-user\\My Documents\\paper.pdf" "D:/資料/結果.csv" read these';
	const matches = parseDroppedPaths(input);
	assert.deepEqual(matches.map((match) => match.path), [
		"C:\\Users\\windows-user\\My Documents\\paper.pdf",
		"D:/資料/結果.csv",
	]);
});

test("does not treat URLs or invalid Windows paths as attachments", () => {
	assert.deepEqual(parseDroppedPaths("https://example.test/C:/not-a-local-path"), []);
	assert.deepEqual(parseDroppedPaths("https://example.test/file?path=C:/not-a-local-path"), []);
	assert.deepEqual(parseDroppedPaths("C:\\foo?bar"), []);
	assert.deepEqual(parseDroppedPaths("C:/foo:bar"), []);
	assert.deepEqual(parseDroppedPaths("mention C:/safe/file.txt"), [
		{ start: 8, end: 24, path: "C:/safe/file.txt" },
	]);
});

test("uses Windows OpenSSH SFTP drive namespace", () => {
	assert.equal(
		windowsPathAdapter.toSftpPath("C:\\Users\\windows-user\\Downloads\\Pi Remote Attachments 実装計画書.md"),
		"/C:/Users/windows-user/Downloads/Pi Remote Attachments 実装計画書.md",
	);
	assert.equal(windowsPathAdapter.toSftpPath("D:/資料/result.csv"), "/D:/資料/result.csv");
});

test("parses POSIX paths only from path-only bracketed-paste content", () => {
	assert.deepEqual(parseDroppedPaths("/home/tetsuya/research/a.py"), []);
	assert.deepEqual(parseDroppedPaths("/home/tetsuya/research/a.py", { allowPosix: true }), [
		{ start: 0, end: 27, path: "/home/tetsuya/research/a.py" },
	]);
	assert.deepEqual(parseDroppedPaths("/home/foo/My\\ Documents/a.pdf", { allowPosix: true }), [
		{ start: 0, end: 29, path: "/home/foo/My Documents/a.pdf" },
	]);
	assert.deepEqual(parseDroppedPaths("'/Users/foo/My Documents/a.pdf'", { allowPosix: true }), [
		{ start: 0, end: 31, path: "/Users/foo/My Documents/a.pdf" },
	]);
	assert.deepEqual(parseDroppedPaths("/home/foo/a.py /mnt/c/Users/foo/b.csv", { allowPosix: true }), [
		{ start: 0, end: 14, path: "/home/foo/a.py" },
		{ start: 15, end: 37, path: "/mnt/c/Users/foo/b.csv" },
	]);
	assert.deepEqual(parseDroppedPaths("/home/foo/a.py read this", { allowPosix: true }), []);
});

test("parses POSIX URI and preserves Unicode paths", () => {
	assert.deepEqual(parseDroppedPaths("file:///home/foo/My%20File.pdf", { allowPosix: true }), [
		{ start: 0, end: 30, path: "/home/foo/My File.pdf" },
	]);
	assert.equal(posixPathAdapter.toSftpPath("/home/foo/資料/結果.csv"), "/home/foo/資料/結果.csv");
	assert.equal(posixPathAdapter.basename("/home/foo/資料/結果.csv"), "結果.csv");
	assert.deepEqual(parseDroppedPaths("/home/../secret.txt", { allowPosix: true }), []);
});

test("keeps bracketed paste framing while transforming POSIX paths", () => {
	const transformer = new BracketedPasteTransformer();
	const replace = (text: string, options?: { allowPosix?: boolean }) => replaceParsedPaths(text, options);
	const pasted = START_PASTE + "/home/foo/a.py" + END_PASTE;
	assert.equal(transformer.transform("before " + pasted + " after", replace), "before \x1b[200~[a.py]\x1b[201~ after");
	assert.equal(
		transformer.transform(START_PASTE + "line 1\nline 2" + END_PASTE, replace),
		START_PASTE + "line 1\nline 2" + END_PASTE,
	);
});

test("handles repeated frames and ordinary Escape input", () => {
	const transformer = new BracketedPasteTransformer();
	const replace = (text: string, options?: { allowPosix?: boolean }) => replaceParsedPaths(text, options);
	assert.equal(
		transformer.transform(START_PASTE + "/home/foo/b.py" + END_PASTE + START_PASTE + "/home/foo/c.py" + END_PASTE, replace),
		START_PASTE + "[b.py]" + END_PASTE + START_PASTE + "[c.py]" + END_PASTE,
	);
	const splitEnd = new BracketedPasteTransformer();
	assert.equal(splitEnd.transform(START_PASTE + "/home/foo/d.py" + "\x1b[201", replace), "");
	assert.equal(splitEnd.transform("~ after", replace), START_PASTE + "[d.py]" + END_PASTE + " after");
	assert.equal(transformer.transform("\x1b", replace), "\x1b");
	assert.equal(transformer.transform("\x1b[A", replace), "\x1b[A");
	assert.equal(transformer.transform("\x1b[20", replace), "\x1b[20");
	assert.equal(transformer.transform("0~/home/foo/e.py" + END_PASTE, replace), "0~/home/foo/e.py" + END_PASTE);
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
		config: { source: { host: "pc", username: "windows-user" } },
	});
	const state: PersistedState = {
		version: 2,
		sessionId,
		attachments: [{
			id,
			sessionId,
			source: {
				host: "pc",
				path: "C:/Users/windows-user/paper.pdf",
				pathStyle: "windows",
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
		config: { source: { host: "new-pc", username: "windows-user" } },
	});
	await manager.restore({
		version: 2,
		sessionId,
		attachments: [{
			id,
			sessionId,
			source: { host: "old-pc", path: "C:/Users/windows-user/paper.pdf", pathStyle: "windows" },
			name: "paper.pdf",
			type: "file",
			destinationPath: destination,
			size: 5,
			status: "ready",
			placeholder: "[paper.pdf]",
		}],
	});
	assert.equal(manager.list()[0].status, "failed");
	assert.equal(manager.list()[0].errorCode, "SOURCE_HOST_NOT_FOUND");
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
		config: { source: { host: "pc", username: "windows-user" } },
	});
	await manager.restore({
		version: 2,
		sessionId,
		attachments: [{
			id,
			sessionId,
			source: { host: "pc", path: "C:/Users/windows-user/paper.pdf", pathStyle: "windows" },
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
		source: { host: "pc", username: "windows-user", port: 22, pathStyle: "posix" },
		maxParallel: 99,
		limits: { maxFileBytes: -1 },
	});
	assert.equal(config.source.host, "pc");
	assert.equal(config.source.username, "windows-user");
	assert.equal(config.source.port, 22);
	assert.equal(config.source.pathStyle, "posix");
	assert.equal(config.maxParallel, 16);
	assert.equal(config.limits?.maxFileBytes, 2 * 1024 ** 3);
});

test("migrates legacy Windows config and state to source v2", () => {
	const config = normalizeConfig({ windows: { host: "pc", username: "windows-user" } });
	assert.deepEqual(config.source, {
		host: "pc",
		username: "windows-user",
		port: 22,
		identityFile: "~/.ssh/pi_windows_attachment",
		knownHostsFile: "~/.ssh/known_hosts",
		pathStyle: "windows",
	});
	const state = migratePersistedState({
		version: 1,
		sessionId: "session-legacy",
		attachments: [{
			id: "0123456789abcdef",
			sessionId: "session-legacy",
			source: { platform: "windows", host: "pc", path: "C:/Users/foo/a.pdf" },
			name: "a.pdf",
			type: "file",
			status: "failed",
			placeholder: "[a.pdf]",
			errorCode: "WINDOWS_PATH_NOT_FOUND",
		}],
	});
	assert.equal(state?.version, 2);
	assert.equal(state?.attachments[0].source.pathStyle, "windows");
	assert.equal(state?.attachments[0].errorCode, "SOURCE_PATH_NOT_FOUND");
	assert.equal(migratePersistedState({
		version: 1,
		sessionId: "session-legacy",
		attachments: [{
			id: "0123456789abcdef",
			sessionId: "session-legacy",
			source: { platform: "linux", host: "pc", path: "/home/foo/a.pdf" },
			name: "a.pdf",
			type: "file",
			status: "failed",
			placeholder: "[a.pdf]",
		}],
	})?.attachments.length, 0);
});

test("restores v1 attachment with Windows path style", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-attachments-"));
	const manager = new AttachmentManager({
		rootDir: root,
		sessionId: "session-v1",
		config: { source: { host: "pc", username: "windows-user" } },
	});
	const state: PersistedStateV1 = {
		version: 1,
		sessionId: "session-v1",
		attachments: [{
			id: "0123456789abcdef",
			sessionId: "session-v1",
			source: { platform: "windows", host: "pc", path: "C:/Users/foo/a.pdf" },
			name: "a.pdf",
			type: "file",
			status: "failed",
			placeholder: "[a.pdf]",
		}],
	};
	await manager.restore(state);
	assert.equal(manager.list()[0].source.pathStyle, "windows");
	assert.equal(manager.serialize().version, 2);
	assert.equal(manager.add("C:/Users/foo/a.pdf").id, state.attachments[0].id);
	assert.equal(manager.list().length, 1);
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("does not attach POSIX text outside bracketed paste mode", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-attachments-"));
	const manager = new AttachmentManager({
		rootDir: root,
		sessionId: "session-posix-input",
		config: {
			source: {
				host: "pc",
				username: "user",
				pathStyle: "posix",
				knownHostsFile: join(root, "missing-known-hosts"),
			},
		},
	});
	assert.equal(manager.replacePastedText("/home/foo/a.py"), "/home/foo/a.py");
	assert.equal(manager.replacePastedText("/home/foo/a.py", { allowPosix: true }), "[a.py]");
	assert.equal(manager.list()[0].source.pathStyle, "posix");
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("does not deduplicate identical paths from different source identities", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-attachments-"));
	const missingKnownHosts = join(root, "missing-known-hosts");
	const manager = new AttachmentManager({
		rootDir: root,
		sessionId: "session-source-hosts",
		config: {
			source: {
				host: "host-a",
				username: "user-a",
				port: 22,
				pathStyle: "posix",
				knownHostsFile: missingKnownHosts,
			},
		},
	});
	const first = manager.add("/home/foo/a.py");
	manager.setConfig({
		source: {
			host: "host-a",
			username: "user-b",
			port: 2222,
			pathStyle: "posix",
			knownHostsFile: missingKnownHosts,
		},
	});
	const second = manager.add("/home/foo/a.py");
	assert.notEqual(first.id, second.id);
	assert.deepEqual(manager.list().map((attachment) => [
		attachment.source.host,
		attachment.source.username,
		attachment.source.port,
	]), [["host-a", "user-a", 22], ["host-a", "user-b", 2222]]);
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("uses source connection captured when transfer was queued", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-attachments-"));
	const calls: Array<{ host: string; username: string; port: number }> = [];
	let startedResolve!: () => void;
	const started = new Promise<void>((resolve) => {
		startedResolve = resolve;
	});
	const runSftp: SftpRunner = async (remote, commands) => {
		calls.push({ host: remote.host, username: remote.username, port: remote.port });
		if (commands[0].startsWith("cd ")) return { stdout: "", stderr: "not a directory" };
		if (commands[0].startsWith("ls -l ")) {
			startedResolve();
			return {
				stdout: "-rw-------    ? 0        0           5 Sep  8 15:49 /home/foo/a.py\n",
				stderr: "",
			};
		}
		if (commands[0].startsWith("get ")) {
			const quoted = [...commands[0].matchAll(/"([^\"]*)"/g)];
			await writeFile(quoted[1][1], "hello");
			return { stdout: "", stderr: "" };
		}
		throw new Error("unexpected fake SFTP command");
	};
	const manager = new AttachmentManager({
		rootDir: root,
		sessionId: "session-captured-source",
		runSftp,
		config: {
			source: {
				host: "host-a",
				username: "user-a",
				port: 22,
				pathStyle: "posix",
			},
		},
	});
	const attachment = manager.add("/home/foo/a.py");
	await started;
	manager.setConfig({
		source: {
			host: "host-b",
			username: "user-b",
			port: 2222,
			pathStyle: "posix",
		},
	});
	const ready = await manager.waitForReady(attachment.placeholder, 1000);
	assert.equal(ready[0].status, "ready");
	assert.ok(calls.length > 0);
	assert.ok(calls.every((call) => call.host === "host-a" && call.username === "user-a" && call.port === 22));
	assert.equal(manager.list()[0].source.host, "host-a");
	assert.equal(manager.list()[0].source.username, "user-a");
	assert.equal(manager.list()[0].source.port, 22);
	await manager.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("selects matching source profile by SSH client address", () => {
	const config = normalizeConfig({
		source: { username: "default-user", pathStyle: "auto" },
		sources: {
			desktop: { host: "10.0.0.2", username: "windows-user", pathStyle: "windows" },
			laptop: { host: "10.0.0.3", username: "mac-user", pathStyle: "posix" },
		},
	});
	const env = { SSH_CONNECTION: "10.0.0.3 22 22 22" };
	assert.equal(resolveSourceConfig(config, env).username, "mac-user");
	assert.equal(resolveSourceRemote(config, env).host, "10.0.0.3");
});

test("saves normalized config in source format", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-remote-attachments-"));
	const configPath = join(root, "remote-attachments.json");
	await saveConfig(normalizeConfig({ windows: { host: "pc", username: "windows-user" } }), configPath);
	const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
	assert.equal("windows" in saved, false);
	assert.equal((saved.source as Record<string, unknown>).pathStyle, "windows");
	await rm(root, { recursive: true, force: true });
});
