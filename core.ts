import { chmod, mkdir, readdir, readFile, rename, rm, stat as statFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PathError } from "./path-adapters/adapter.ts";
import {
	detectPathStyle,
	parseDroppedPaths,
	resolvePathAdapter,
} from "./path-adapters/parser.ts";
import type {
	ConfigPathStyle,
	PathStyle,
} from "./path-adapters/adapter.ts";

export { detectPathStyle, parseDroppedPaths, resolvePathAdapter } from "./path-adapters/parser.ts";
export { PosixPathAdapter, posixPathAdapter } from "./path-adapters/posix.ts";
export { WindowsPathAdapter, windowsPathAdapter } from "./path-adapters/windows.ts";
export type { ConfigPathStyle, DroppedPathMatch, PathAdapter, PathStyle } from "./path-adapters/parser.ts";

export const DEFAULT_ATTACHMENT_ROOT = join(homedir(), ".pi", "attachments");
export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "remote-attachments.json");
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 ** 3;
export const DEFAULT_MAX_DIRECTORY_BYTES = 5 * 1024 ** 3;
export const DEFAULT_MAX_PARALLEL = 3;
export const SESSION_STATE_ENTRY_TYPE = "pi-remote-attachments-state";

export type AttachmentStatus = "pending" | "connecting" | "uploading" | "ready" | "failed";
export type AttachmentType = "file" | "directory";

export type AttachmentErrorCode =
	| "SOURCE_HOST_NOT_FOUND"
	| "SOURCE_SSH_UNREACHABLE"
	| "SOURCE_AUTH_FAILED"
	| "SOURCE_PATH_NOT_FOUND"
	| "SOURCE_PERMISSION_DENIED"
	| "SFTP_ERROR"
	| "DIRECTORY_TOO_LARGE"
	| "FILE_TOO_LARGE"
	| "TRANSFER_INTERRUPTED"
	| "DESTINATION_WRITE_FAILED";

export interface SourceConfig {
	host?: string;
	username?: string;
	port?: number;
	identityFile?: string;
	knownHostsFile?: string;
	hostKeyAlias?: string;
	pathStyle?: ConfigPathStyle;
}

export interface AttachmentConfig {
	source: SourceConfig;
	sources?: Record<string, SourceConfig>;
	limits?: {
		maxFileBytes?: number;
		maxDirectoryBytes?: number;
	};
	maxParallel?: number;
}

export interface SftpResult {
	stdout: string;
	stderr: string;
}

export type SftpRunner = (
	remote: SourceRemote,
	commands: string[],
	signal?: AbortSignal,
) => Promise<SftpResult>;

export interface SourceRemote {
	host: string;
	username: string;
	port: number;
	identityFile?: string;
	knownHostsFile: string;
	hostKeyAlias?: string;
	runSftp?: SftpRunner;
}

export interface Attachment {
	id: string;
	sessionId: string;
	source: {
		host: string;
		username?: string;
		port?: number;
		path: string;
		pathStyle: PathStyle;
		platform?: "windows" | "macos" | "linux" | "bsd" | "wsl" | "unknown";
	};
	name: string;
	type: AttachmentType;
	destinationPath?: string;
	size?: number;
	status: AttachmentStatus;
	error?: string;
	errorCode?: AttachmentErrorCode;
	placeholder: string;
}

export interface PersistedState {
	version: 2;
	sessionId: string;
	attachments: Attachment[];
}

export interface PersistedStateV1 {
	version: 1;
	sessionId: string;
	attachments: Array<Omit<Attachment, "source" | "errorCode"> & {
		errorCode?: string;
		 source: {
			platform: "windows";
			host: string;
			path: string;
		};
	}>;
}

export class AttachmentFailure extends Error {
	public readonly code: AttachmentErrorCode;

	constructor(
		code: AttachmentErrorCode,
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = "AttachmentFailure";
	}
}

class TransferCancelled extends AttachmentFailure {
	constructor() {
		super("TRANSFER_INTERRUPTED", "Transfer was cancelled");
	}
}

class SftpProcessError extends Error {
	public readonly stdout: string;
	public readonly stderr: string;
	public readonly exitCode: number | null;
	public readonly signal: NodeJS.Signals | null;

	constructor(
		stdout: string,
		stderr: string,
		exitCode: number | null,
		signal: NodeJS.Signals | null,
	) {
		super(stderr.trim() || stdout.trim() || "SFTP process failed");
		this.stdout = stdout;
		this.stderr = stderr;
		this.exitCode = exitCode;
		this.signal = signal;
		this.name = "SftpProcessError";
	}
}

interface SftpListing {
	mode: string;
	size: number;
	name: string;
}

interface RemoteEntry {
	name: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number;
	remotePath: string;
}

interface RemoteFile {
	remotePath: string;
	relativePath: string;
	size: number;
}

interface RemoteTree {
	files: RemoteFile[];
	directories: string[];
	totalBytes: number;
}

interface ManagerOptions {
	sessionId: string;
	config: AttachmentConfig;
	rootDir?: string;
	env?: Record<string, string | undefined>;
	runSftp?: SftpRunner;
	onChange?: (attachments: Attachment[]) => void;
	onState?: (state: PersistedState) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finitePositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function copyConfig(config: AttachmentConfig): AttachmentConfig {
	return {
		source: { ...config.source },
		sources: config.sources
			? Object.fromEntries(Object.entries(config.sources).map(([name, source]) => [name, { ...source }]))
			: undefined,
		limits: config.limits ? { ...config.limits } : undefined,
		maxParallel: config.maxParallel,
	};
}

export function defaultConfig(): AttachmentConfig {
	return {
		source: {
			port: 22,
			identityFile: "~/.ssh/pi_remote_attachment",
			knownHostsFile: "~/.ssh/known_hosts",
			pathStyle: "auto",
		},
		limits: {
			maxFileBytes: DEFAULT_MAX_FILE_BYTES,
			maxDirectoryBytes: DEFAULT_MAX_DIRECTORY_BYTES,
		},
		maxParallel: DEFAULT_MAX_PARALLEL,
	};
}

export function normalizeConfig(value: unknown): AttachmentConfig {
	const defaults = defaultConfig();
	if (!isRecord(value)) return defaults;
	const hasSource = isRecord(value.source);
	const legacyWindows = !hasSource && isRecord(value.windows);
	const rawSource = hasSource ? value.source : legacyWindows ? value.windows : {};
	const sourceDefaults: SourceConfig = legacyWindows
		? { ...defaults.source, identityFile: "~/.ssh/pi_windows_attachment", pathStyle: "windows" }
		: { ...defaults.source };
	const source = isRecord(rawSource) ? rawSource : {};
	const limits = isRecord(value.limits) ? value.limits : {};
	const config: AttachmentConfig = {
		source: sourceDefaults,
		limits: { ...defaults.limits },
		maxParallel: defaults.maxParallel,
	};
	for (const key of ["host", "username", "identityFile", "knownHostsFile", "hostKeyAlias"] as const) {
		if (typeof source[key] === "string" && source[key].trim()) {
			config.source[key] = source[key].trim();
		}
	}
	const pathStyle = source.pathStyle;
	if (pathStyle === "auto" || pathStyle === "windows" || pathStyle === "posix") {
		config.source.pathStyle = pathStyle;
	}
	const port = finitePositiveNumber(source.port);
	const maxFileBytes = finitePositiveNumber(limits.maxFileBytes);
	const maxDirectoryBytes = finitePositiveNumber(limits.maxDirectoryBytes);
	const maxParallel = finitePositiveNumber(value.maxParallel);
	if (port !== undefined) config.source.port = port;
	if (maxFileBytes !== undefined) config.limits!.maxFileBytes = maxFileBytes;
	if (maxDirectoryBytes !== undefined) config.limits!.maxDirectoryBytes = maxDirectoryBytes;
	if (maxParallel !== undefined) {
		config.maxParallel = Math.min(Math.floor(maxParallel), 16);
	}
	if (isRecord(value.sources)) {
		const sources: Record<string, SourceConfig> = {};
		for (const [name, rawProfile] of Object.entries(value.sources)) {
			if (!isRecord(rawProfile)) continue;
			const profile = normalizeConfig({ source: rawProfile }).source;
			sources[name] = profile;
		}
		if (Object.keys(sources).length > 0) config.sources = sources;
	}
	return config;
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<AttachmentConfig> {
	try {
		return normalizeConfig(JSON.parse(await readFile(expandHomePath(path), "utf8")));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return defaultConfig();
		throw new Error("Cannot read remote attachment config: " + (error as Error).message);
	}
}

export async function saveConfig(config: AttachmentConfig, path = DEFAULT_CONFIG_PATH): Promise<void> {
	const target = expandHomePath(path);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const temporary = target + ".tmp-" + randomUUID();
	await writeFile(temporary, JSON.stringify(copyConfig(config), null, 2) + "\n", { mode: 0o600 });
	try {
		await rename(temporary, target);
		await chmod(target, 0o600);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function expandHomePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

export function detectClientHost(env: Record<string, string | undefined> = process.env): string | null {
	for (const key of ["SSH_CONNECTION", "SSH_CLIENT"]) {
		const first = (env[key] ?? "").trim().split(/\s+/)[0];
		if (first && isSafeHost(first)) return first;
	}
	return null;
}

function isSafeHost(value: string): boolean {
	return /^[A-Za-z0-9._:[\]-]+$/.test(value) && !value.includes("..\\");
}

function assertSafeHost(value: string, label: string): string {
	const host = value.trim();
	if (!host || !isSafeHost(host)) {
		throw new AttachmentFailure("SOURCE_HOST_NOT_FOUND", "Invalid source " + label);
	}
	return host;
}

export function resolveSourceConfig(
	config: AttachmentConfig,
	env: Record<string, string | undefined> = process.env,
): SourceConfig {
	const clientHost = detectClientHost(env);
	if (!clientHost || !config.sources) return config.source;
	const matches = Object.values(config.sources).filter((source) => source.host?.trim() === clientHost);
	if (matches.length > 1) {
		throw new AttachmentFailure("SOURCE_HOST_NOT_FOUND", "Multiple source profiles match SSH client " + clientHost);
	}
	return matches[0] || config.source;
}

export function resolveSourceRemote(
	config: AttachmentConfig,
	env: Record<string, string | undefined> = process.env,
): SourceRemote {
	const source = resolveSourceConfig(config, env);
	const host = source.host?.trim() || detectClientHost(env);
	if (!host) {
		throw new AttachmentFailure(
			"SOURCE_HOST_NOT_FOUND",
			"Source host is not configured and SSH_CONNECTION is unavailable",
		);
	}
	const username = source.username?.trim();
	if (!username || !/^[A-Za-z0-9._-]+$/.test(username)) {
		throw new AttachmentFailure("SOURCE_AUTH_FAILED", "Source SSH username is not configured");
	}
	const port = source.port ?? 22;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new AttachmentFailure("SFTP_ERROR", "Source SSH port is invalid");
	}
	const knownHostsFile = expandHomePath(source.knownHostsFile || "~/.ssh/known_hosts");
	const identityFile = source.identityFile
		? expandHomePath(source.identityFile)
		: undefined;
	return {
		host: assertSafeHost(host, "host"),
		username,
		port,
		identityFile,
		knownHostsFile,
		hostKeyAlias: source.hostKeyAlias
			? assertSafeHost(source.hostKeyAlias, "host-key alias")
			: undefined,
	};
}

export function sanitizeName(value: string): string {
	const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
	if (!sanitized || sanitized === "." || sanitized === "..") return "attachment";
	return sanitized.slice(0, 240);
}

export function quoteSftpArgument(value: string): string {
	if (/[\u0000\r\n]/.test(value)) throw new Error("SFTP argument contains a control character");
	return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

export function buildSftpArgs(remote: SourceRemote): string[] {
	const targetHost = remote.host.includes(":") && !remote.host.startsWith("[")
		? "[" + remote.host + "]"
		: remote.host;
	return [
		"-q",
		"-oBatchMode=yes",
		"-oStrictHostKeyChecking=yes",
		"-oPreferredAuthentications=publickey",
		"-oPasswordAuthentication=no",
		"-oKbdInteractiveAuthentication=no",
		"-oUserKnownHostsFile=" + remote.knownHostsFile,
		"-oConnectTimeout=10",
		"-oServerAliveInterval=10",
		"-oServerAliveCountMax=2",
		"-P",
		String(remote.port),
		...(remote.identityFile ? ["-i", remote.identityFile] : []),
		...(remote.hostKeyAlias ? ["-oHostKeyAlias=" + remote.hostKeyAlias] : []),
		remote.username + "@" + targetHost,
	];
}

export function buildSftpBatch(commands: string[]): string {
	for (const command of commands) {
		if (/[\u0000\r\n]/.test(command)) throw new Error("SFTP command contains a control character");
	}
	return commands.join("\n") + "\n";
}

function appendOutput(current: string, chunk: Buffer, limit: number): string {
	const remaining = limit - Buffer.byteLength(current, "utf8");
	if (remaining <= 0) return current;
	if (chunk.byteLength <= remaining) return current + chunk.toString("utf8");
	return current + chunk.subarray(0, remaining).toString("utf8");
}

async function assertSftpFiles(remote: SourceRemote): Promise<void> {
	try {
		const knownHosts = await statFile(remote.knownHostsFile);
		if (!knownHosts.isFile()) throw new Error("not a file");
	} catch {
		throw new AttachmentFailure("SFTP_ERROR", "SSH known-hosts file is missing");
	}
	if (remote.identityFile) {
		try {
			const identity = await statFile(remote.identityFile);
			if (!identity.isFile()) throw new Error("not a file");
		} catch {
			throw new AttachmentFailure("SOURCE_AUTH_FAILED", "Source SSH identity file is missing");
		}
	}
}

export async function runSftpBatch(
	remote: SourceRemote,
	commands: string[],
	signal?: AbortSignal,
): Promise<SftpResult> {
	await assertSftpFiles(remote);
	if (signal?.aborted) throw new TransferCancelled();
	const child = spawn("sftp", buildSftpArgs(remote), {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let abortTimer: ReturnType<typeof setTimeout> | undefined;
	let aborted = false;
	const maxOutput = 16 * 1024 * 1024;
	const onAbort = () => {
		aborted = true;
		child.kill("SIGTERM");
		abortTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	child.stdout.on("data", (chunk: Buffer) => {
		stdout = appendOutput(stdout, chunk, maxOutput);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = appendOutput(stderr, chunk, maxOutput);
	});
	child.stdin.end(buildSftpBatch(commands));
	return await new Promise<SftpResult>((resolveResult, reject) => {
		child.once("error", (error) => {
			if (abortTimer) clearTimeout(abortTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(new AttachmentFailure("SFTP_ERROR", "Cannot start sftp: " + error.message));
		});
		child.once("close", (code, signalName) => {
			if (abortTimer) clearTimeout(abortTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (aborted || signal?.aborted) {
				reject(new TransferCancelled());
			} else if (code === 0) {
				resolveResult({ stdout, stderr });
			} else {
				reject(new SftpProcessError(stdout, stderr, code, signalName));
			}
		});
	});
}

function failureText(error: unknown): string {
	if (error instanceof SftpProcessError) return (error.stderr + "\n" + error.stdout).trim();
	return error instanceof Error ? error.message : String(error);
}

export function classifyFailure(error: unknown): AttachmentFailure {
	if (error instanceof AttachmentFailure) return error;
	const text = failureText(error);
	const lower = text.toLowerCase();
	if (/could not resolve hostname|name or service not known|no address associated/.test(lower)) {
		return new AttachmentFailure("SOURCE_HOST_NOT_FOUND", "Source SSH host was not found");
	}
	if (/permission denied \(publickey\)|authentication failed|no supported authentication/.test(lower)) {
		return new AttachmentFailure("SOURCE_AUTH_FAILED", "Source SSH authentication failed");
	}
	if (/host key verification failed|offending .* key|remote host identification/.test(lower)) {
		return new AttachmentFailure("SFTP_ERROR", "Source SSH host key is not trusted");
	}
	if (/no such file|not found|cannot ls/.test(lower)) {
		return new AttachmentFailure("SOURCE_PATH_NOT_FOUND", "Source path was not found");
	}
	if (/permission denied|access denied/.test(lower)) {
		return new AttachmentFailure("SOURCE_PERMISSION_DENIED", "Source path access was denied");
	}
	if (/connection refused|connection timed out|connect to host|no route to host|connection closed|broken pipe|kex_exchange/.test(lower)) {
		return new AttachmentFailure("SOURCE_SSH_UNREACHABLE", "Source SSH is unreachable");
	}
	return new AttachmentFailure("SFTP_ERROR", "Source SFTP transfer failed");
}

function isReconnectable(error: unknown): boolean {
	const text = failureText(error).toLowerCase();
	return /connection refused|connection timed out|connect to host|no route to host|connection closed|broken pipe|kex_exchange/.test(text);
}

async function runSftpWithReconnect(
	remote: SourceRemote,
	commands: string[],
	signal?: AbortSignal,
): Promise<SftpResult> {
	const run = remote.runSftp || runSftpBatch;
	try {
		return await run(remote, commands, signal);
	} catch (error) {
		if (signal?.aborted || !isReconnectable(error)) throw error;
		return await run(remote, commands, signal);
	}
}

function parseListingLine(line: string): SftpListing | undefined {
	const match = line.match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.+)$/);
	if (!match || !/^[dl-]/.test(match[1])) return undefined;
	return { mode: match[1], size: Number(match[2]), name: match[3].trim() };
}

export function parseSftpListings(output: string): SftpListing[] {
	return output.split(/\r?\n/).map(parseListingLine).filter((value): value is SftpListing => value !== undefined);
}

function remoteJoin(parent: string, name: string): string {
	if (!name || name === "." || name === ".." || name.includes("/")) {
		throw new AttachmentFailure("SFTP_ERROR", "Source directory contains an unsafe name");
	}
	return parent.replace(/\/+$/, "") + "/" + name;
}

function listingName(value: string): string {
	const slash = value.lastIndexOf("/");
	return slash >= 0 ? value.slice(slash + 1) : value;
}

async function remoteStat(
	remote: SourceRemote,
	remotePath: string,
	signal?: AbortSignal,
): Promise<{ type: "file" | "directory" | "symlink" | "other"; size: number }> {
	let directoryProbe: SftpResult | undefined;
	try {
		directoryProbe = await runSftpWithReconnect(
			remote,
			["cd " + quoteSftpArgument(remotePath), "pwd"],
			signal,
		);
		if (!/can't change directory|not a directory|no such file|not found|cannot canonicalize/i.test(directoryProbe.stderr)) {
			return { type: "directory", size: 0 };
		}
	} catch (error) {
		if (signal?.aborted) throw error;
		directoryProbe = undefined;
	}
	let result: SftpResult;
	try {
		result = await runSftpWithReconnect(remote, ["ls -l " + quoteSftpArgument(remotePath)], signal);
	} catch (error) {
		throw classifyFailure(error);
	}
	const entry = parseSftpListings(result.stdout)[0];
	if (!entry) {
		throw classifyFailure(
			new SftpProcessError(result.stdout, result.stderr || directoryProbe?.stderr || "", 0, null),
		);
	}
	const first = entry.mode[0];
	return {
		type: first === "d" ? "directory" : first === "l" ? "symlink" : first === "-" ? "file" : "other",
		size: entry.size,
	};
}

async function listRemoteDirectory(
	remote: SourceRemote,
	remotePath: string,
	signal?: AbortSignal,
): Promise<RemoteEntry[]> {
	const quoted = quoteSftpArgument(remotePath);
	const result = await runSftpWithReconnect(
		remote,
		["ls -la " + quoted],
		signal,
	);
	if (result.stderr) {
		throw classifyFailure(new SftpProcessError(result.stdout, result.stderr, 0, null));
	}
	const byName = new Map<string, RemoteEntry>();
	for (const listing of parseSftpListings(result.stdout)) {
		if (listing.mode[0] === "l") continue;
		const name = listingName(listing.name);
		if (name === "." || name === ".." || byName.has(name)) continue;
		const type = listing.mode[0] === "d"
			? "directory"
			: listing.mode[0] === "-"
					? "file"
					: "other";
		byName.set(name, { name, type, size: listing.size, remotePath: remoteJoin(remotePath, name) });
	}
	return [...byName.values()];
}

async function walkRemoteDirectory(
	remote: SourceRemote,
	root: string,
	signal: AbortSignal,
): Promise<RemoteTree> {
	const files: RemoteFile[] = [];
	const directories = [""];
	const queue: Array<{ remotePath: string; relativePath: string }> = [{ remotePath: root, relativePath: "" }];
	let totalBytes = 0;
	while (queue.length > 0) {
		if (signal.aborted) throw new TransferCancelled();
		const current = queue.shift()!;
		for (const entry of await listRemoteDirectory(remote, current.remotePath, signal)) {
			if (entry.type === "symlink") continue;
			const relativePath = current.relativePath
				? current.relativePath + "/" + entry.name
				: entry.name;
			if (entry.type === "directory") {
				directories.push(relativePath);
				queue.push({ remotePath: entry.remotePath, relativePath });
			} else if (entry.type === "file") {
				totalBytes += entry.size;
				files.push({ remotePath: entry.remotePath, relativePath, size: entry.size });
			}
		}
	}
	return { files, directories, totalBytes };
}

async function downloadFiles(
	remote: SourceRemote,
	files: Array<{ remotePath: string; localPath: string }>,
	signal: AbortSignal,
): Promise<void> {
	if (files.length === 0) return;
	const commands = files.map((file) =>
		"get " + quoteSftpArgument(file.remotePath) + " " + quoteSftpArgument(file.localPath),
	);
	await runSftpWithReconnect(remote, commands, signal);
}

function ensureInside(root: string, target: string): void {
	const rootPath = resolve(root);
	const targetPath = resolve(target);
	if (targetPath !== rootPath && !targetPath.startsWith(rootPath + sep)) {
		throw new AttachmentFailure("DESTINATION_WRITE_FAILED", "Attachment destination escaped its root");
	}
}

function sessionSegment(value: string): string {
	const segment = value.replace(/[^A-Za-z0-9._-]/g, "_");
	return segment || "session";
}

function attachmentRoot(rootDir: string, sessionId: string, id: string): string {
	return join(rootDir, sessionSegment(sessionId), id);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolveValue) => {
		resolvePromise = resolveValue;
	});
	return { promise, resolve: resolvePromise };
}

function cloneAttachment(attachment: Attachment): Attachment {
	return { ...attachment, source: { ...attachment.source } };
}

export class AttachmentManager {
	private readonly rootDir: string;
	private readonly sessionId: string;
	private readonly env: Record<string, string | undefined>;
	private readonly runSftp?: SftpRunner;
	private config: AttachmentConfig;
	private readonly attachments: Attachment[] = [];
	private readonly queue: Attachment[] = [];
	private readonly settled = new Map<string, { promise: Promise<Attachment>; resolve: (value: Attachment) => void }>();
	private readonly active = new Map<string, AbortController>();
	private readonly running = new Map<string, Promise<void>>();
	private readonly sourceRemotes = new Map<string, SourceRemote>();
	private readonly removed = new Set<string>();
	private metadataWrite: Promise<void> = Promise.resolve();
	private pumping = false;
	private disposed = false;
	private readonly onChange?: (attachments: Attachment[]) => void;
	private readonly onState?: (state: PersistedState) => void;

	constructor(options: ManagerOptions) {
		this.rootDir = expandHomePath(options.rootDir || DEFAULT_ATTACHMENT_ROOT);
		this.sessionId = options.sessionId;
		this.env = options.env || process.env;
		this.runSftp = options.runSftp;
		this.config = normalizeConfig(options.config);
		this.onChange = options.onChange;
		this.onState = options.onState;
	}

	get sessionRoot(): string {
		return join(this.rootDir, sessionSegment(this.sessionId));
	}

	list(): Attachment[] {
		return this.attachments.map(cloneAttachment);
	}

	get(idOrIndex: string): Attachment | undefined {
		const index = Number.parseInt(idOrIndex, 10);
		const attachment = Number.isInteger(index) && index > 0
			? this.attachments[index - 1]
			: this.attachments.find((item) => item.id === idOrIndex);
		return attachment ? cloneAttachment(attachment) : undefined;
	}

	setConfig(config: AttachmentConfig): void {
		this.config = normalizeConfig(config);
		this.emit();
	}

	add(sourcePath: string): Attachment {
		const source = resolveSourceConfig(this.config, this.env);
		let sourceRemote: SourceRemote | undefined;
		try {
			sourceRemote = resolveSourceRemote(this.config, this.env);
			if (this.runSftp) sourceRemote = { ...sourceRemote, runSftp: this.runSftp };
		} catch {
			// Transfer reports configuration errors through attachment state.
		}
		const sourceHost = sourceRemote?.host || source.host?.trim() || detectClientHost(this.env) || "";
		const sourceUsername = sourceRemote?.username || source.username?.trim();
		const sourcePort = sourceRemote?.port ||
			(typeof source.port === "number" && Number.isInteger(source.port) && source.port >= 1 && source.port <= 65535
				? source.port
				: undefined);
		const configuredStyle = source.pathStyle || "auto";
		const style = configuredStyle === "auto" ? detectPathStyle(sourcePath) : configuredStyle;
		if (!style) throw new AttachmentFailure("SOURCE_PATH_NOT_FOUND", "Not a valid absolute source path");
		const adapter = resolvePathAdapter(style);
		let normalized: string;
		try {
			normalized = adapter.normalize(sourcePath);
		} catch (error) {
			if (error instanceof PathError) {
				throw new AttachmentFailure("SOURCE_PATH_NOT_FOUND", error.message);
			}
			throw error;
		}
		const existing = [...this.attachments].reverse().find((attachment) =>
			attachment.source.host.toLowerCase() === sourceHost.toLowerCase() &&
			attachment.source.username === sourceUsername &&
			attachment.source.port === sourcePort &&
			attachment.source.pathStyle === style &&
			(style === "windows"
				? attachment.source.path.toLowerCase() === normalized.toLowerCase()
				: attachment.source.path === normalized),
		);
		if (existing) return cloneAttachment(existing);
		const name = sanitizeName(adapter.basename(normalized));
		const attachment: Attachment = {
			id: randomUUID(),
			sessionId: this.sessionId,
			source: {
				host: sourceHost,
				username: sourceUsername,
				port: sourcePort,
				path: normalized,
				pathStyle: style,
			},
			name,
			type: "file",
			status: "pending",
			placeholder: "[" + name + "]",
		};
		this.attachments.push(attachment);
		if (sourceRemote) this.sourceRemotes.set(attachment.id, sourceRemote);
		this.settled.set(attachment.id, deferred<Attachment>());
		this.persist();
		this.queue.push(attachment);
		void this.pump();
		return cloneAttachment(attachment);
	}

	replacePastedText(text: string, options: { allowPosix?: boolean } = {}): string {
		const source = resolveSourceConfig(this.config, this.env);
		const matches = parseDroppedPaths(text, {
			pathStyle: source.pathStyle || "auto",
			allowPosix: options.allowPosix,
		});
		let result = text;
		for (let index = matches.length - 1; index >= 0; index--) {
			const match = matches[index];
			const attachment = this.add(match.path);
			result = result.slice(0, match.start) + attachment.placeholder + result.slice(match.end);
		}
		return result;
	}

	referenced(text: string): Array<{ attachment: Attachment; start: number; end: number }> {
		const groups = new Map<string, Attachment[]>();
		for (const attachment of this.attachments) {
			const group = groups.get(attachment.placeholder) || [];
			group.push(attachment);
			groups.set(attachment.placeholder, group);
		}
		const references: Array<{ attachment: Attachment; start: number; end: number }> = [];
		for (const [placeholder, group] of groups) {
			let from = 0;
			let occurrence = 0;
			while (true) {
				const start = text.indexOf(placeholder, from);
				if (start < 0) break;
				references.push({
					attachment: group[occurrence] || group[0],
					start,
					end: start + placeholder.length,
				});
				occurrence++;
				from = start + placeholder.length;
			}
		}
		return references.sort((a, b) => a.start - b.start);
	}

	async waitForReady(text: string, timeoutMs = 5 * 60 * 1000): Promise<Attachment[]> {
		const ids = [...new Set(this.referenced(text).map((reference) => reference.attachment.id))];
		if (ids.length === 0) return [];
		const wait = Promise.all(ids.map((id) => this.settled.get(id)?.promise || Promise.resolve(this.get(id)!)));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<Attachment[]>((resolveTimeout) => {
			timer = setTimeout(() => resolveTimeout(ids.map((id) => this.get(id)!).filter(Boolean)), timeoutMs);
		});
		const result = await Promise.race([wait, timeout]);
		if (timer) clearTimeout(timer);
		return result;
	}

	transformPrompt(text: string): string {
		const references = this.referenced(text);
		const ready = references.filter((reference) =>
			reference.attachment.status === "ready" && reference.attachment.destinationPath,
		);
		if (ready.length === 0) return text;
		const unique: Attachment[] = [];
		const seen = new Set<string>();
		for (const reference of ready) {
			if (!seen.has(reference.attachment.id)) {
				seen.add(reference.attachment.id);
				unique.push(reference.attachment);
			}
		}
		let request = text;
		for (const reference of [...ready].reverse()) {
			request = request.slice(0, reference.start) + request.slice(reference.end);
		}
		request = request.trim();
		const files = unique.filter((attachment) => attachment.type === "file");
		const directories = unique.filter((attachment) => attachment.type === "directory");
		const sections: string[] = [];
		if (files.length > 0) {
			sections.push(
				"Attached files:\n\n" +
				files.map((attachment) => "- " + attachment.name + "\n  " + attachment.destinationPath).join("\n"),
			);
		}
		if (directories.length > 0) {
			sections.push(
				"Attached directories:\n\n" +
				directories.map((attachment) => "- " + attachment.name + "\n  " + attachment.destinationPath).join("\n"),
			);
		}
		sections.push("User request:\n" + request);
		return sections.join("\n\n");
	}

	async restore(state: PersistedState | PersistedStateV1 | undefined): Promise<void> {
		const migrated = migratePersistedState(state);
		if (!migrated || migrated.sessionId !== this.sessionId) {
			return;
		}
		let currentRemote: SourceRemote | undefined;
		try {
			currentRemote = resolveSourceRemote(this.config, this.env);
			if (this.runSftp) currentRemote = { ...currentRemote, runSftp: this.runSftp };
		} catch {
			currentRemote = undefined;
		}
		for (const raw of migrated.attachments) {
			if (!isRestorableAttachment(raw, this.sessionId)) continue;
			const attachment = cloneAttachment(raw);
			attachment.name = sanitizeName(attachment.name);
			attachment.placeholder = attachment.placeholder || "[" + attachment.name + "]";
			const root = attachmentRoot(this.rootDir, this.sessionId, attachment.id);
			const expected = join(root, attachment.name);
			ensureInside(root, expected);
			attachment.destinationPath = expected;
			if (currentRemote && attachment.source.host &&
				attachment.source.host.toLowerCase() !== currentRemote.host.toLowerCase()) {
				attachment.status = "failed";
				attachment.errorCode = "SOURCE_HOST_NOT_FOUND";
				attachment.error = "Source host changed; retry attachment";
			} else if (currentRemote &&
				((attachment.source.username !== undefined && attachment.source.username !== currentRemote.username) ||
					(attachment.source.port !== undefined && attachment.source.port !== currentRemote.port))) {
				attachment.status = "failed";
				attachment.errorCode = "SOURCE_AUTH_FAILED";
				attachment.error = "Source connection changed; retry attachment";
			} else {
				if (currentRemote) {
					attachment.source.username ??= currentRemote.username;
					attachment.source.port ??= currentRemote.port;
				}
				if (attachment.status === "ready") {
					try {
						const local = await statFile(expected);
						if (attachment.type === "file" && attachment.size !== undefined && local.size !== attachment.size) {
							throw new Error("size mismatch");
						}
						if (attachment.type === "file" && !local.isFile()) throw new Error("not a file");
						if (attachment.type === "directory" && !local.isDirectory()) throw new Error("not a directory");
					} catch {
						attachment.status = "failed";
						attachment.errorCode = "TRANSFER_INTERRUPTED";
						attachment.error = "Attachment data is missing; retry attachment";
					}
				} else {
					attachment.status = "failed";
					attachment.errorCode = "TRANSFER_INTERRUPTED";
					attachment.error = "Previous transfer did not finish; retry attachment";
				}
			}
			if (currentRemote && attachment.status !== "failed") this.sourceRemotes.set(attachment.id, currentRemote);
			this.attachments.push(attachment);
			const promise = deferred<Attachment>();
			this.settled.set(attachment.id, promise);
			if (attachment.status === "ready" || attachment.status === "failed") promise.resolve(cloneAttachment(attachment));
		}
		this.emit();
	}

	async remove(idOrIndex: string): Promise<boolean> {
		const index = this.resolveIndex(idOrIndex);
		if (index < 0) return false;
		const [attachment] = this.attachments.splice(index, 1);
		this.removed.add(attachment.id);
		this.sourceRemotes.delete(attachment.id);
		this.queue.splice(0, this.queue.length, ...this.queue.filter((item) => item.id !== attachment.id));
		this.active.get(attachment.id)?.abort();
		await rm(attachmentRoot(this.rootDir, this.sessionId, attachment.id), { recursive: true, force: true });
		this.persist();
		return true;
	}

	retry(idOrIndex: string): boolean {
		const index = this.resolveIndex(idOrIndex);
		if (index < 0) return false;
		const attachment = this.attachments[index];
		if (attachment.status !== "failed") return false;
		this.removed.delete(attachment.id);
		this.sourceRemotes.delete(attachment.id);
		this.settled.set(attachment.id, deferred<Attachment>());
		attachment.status = "pending";
		attachment.error = undefined;
		attachment.errorCode = undefined;
		attachment.destinationPath = undefined;
		this.persist();
		this.queue.push(attachment);
		void this.pump();
		return true;
	}

	async cleanup(): Promise<number> {
		const keep = new Set(this.attachments.map((attachment) => attachment.id));
		let removedCount = 0;
		try {
			for (const entry of await readdir(this.sessionRoot, { withFileTypes: true })) {
				if (!entry.isDirectory() || keep.has(entry.name)) continue;
				await rm(join(this.sessionRoot, entry.name), { recursive: true, force: true });
				removedCount++;
			}
		} catch (error) {
			if (!(isRecord(error) && error.code === "ENOENT")) throw error;
		}
		return removedCount;
	}

	async shutdown(): Promise<void> {
		this.disposed = true;
		this.queue.length = 0;
		for (const controller of this.active.values()) controller.abort();
		await Promise.allSettled([...this.running.values()]);
		await this.metadataWrite;
	}

	serialize(): PersistedState {
		return {
			version: 2,
			sessionId: this.sessionId,
			attachments: this.list(),
		};
	}

	private resolveIndex(idOrIndex: string): number {
		const index = Number.parseInt(idOrIndex, 10);
		if (Number.isInteger(index) && index > 0) return index - 1 < this.attachments.length ? index - 1 : -1;
		return this.attachments.findIndex((attachment) => attachment.id === idOrIndex);
	}

	private emit(): void {
		this.onChange?.(this.list());
	}

	private persist(): void {
		if (this.disposed) return;
		const state = this.serialize();
		try {
			this.onState?.(state);
		} catch {
			// Session persistence must not interrupt a transfer.
		}
		this.emit();
		this.metadataWrite = this.metadataWrite
			.catch(() => undefined)
			.then(async () => {
				await mkdir(this.sessionRoot, { recursive: true, mode: 0o700 });
				const target = join(this.sessionRoot, "attachments.json");
				const temporary = target + ".tmp-" + randomUUID();
				await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
				await rename(temporary, target);
				await chmod(target, 0o600);
			})
			.catch(() => undefined);
	}

	private update(attachment: Attachment, update: Partial<Attachment>): void {
		Object.assign(attachment, update);
		this.persist();
		if (attachment.status === "ready" || attachment.status === "failed") {
			const pending = this.settled.get(attachment.id);
			if (pending) pending.resolve(cloneAttachment(attachment));
		}
	}

	private async pump(): Promise<void> {
		if (this.pumping || this.disposed) return;
		this.pumping = true;
		try {
			const limit = Math.max(1, Math.min(16, Math.floor(this.config.maxParallel || DEFAULT_MAX_PARALLEL)));
			while (!this.disposed && this.active.size < limit && this.queue.length > 0) {
				const attachment = this.queue.shift()!;
				if (this.removed.has(attachment.id)) continue;
				const controller = new AbortController();
				this.active.set(attachment.id, controller);
				const running = this.transfer(attachment, controller.signal)
					.catch(() => undefined)
					.finally(() => {
						this.active.delete(attachment.id);
						this.running.delete(attachment.id);
						void this.pump();
					});
				this.running.set(attachment.id, running);
			}
		} finally {
			this.pumping = false;
		}
	}

	private async transfer(attachment: Attachment, signal: AbortSignal): Promise<void> {
		const root = attachmentRoot(this.rootDir, this.sessionId, attachment.id);
		try {
			this.update(attachment, { status: "connecting", error: undefined, errorCode: undefined });
			const resolved = this.sourceRemotes.get(attachment.id) || resolveSourceRemote(this.config, this.env);
			const remote = this.runSftp && !resolved.runSftp
				? { ...resolved, runSftp: this.runSftp }
				: resolved;
			this.sourceRemotes.set(attachment.id, remote);
			attachment.source.host = remote.host;
			attachment.source.username = remote.username;
			attachment.source.port = remote.port;
			let sourcePath: string;
			try {
				sourcePath = resolvePathAdapter(attachment.source.pathStyle).toSftpPath(attachment.source.path);
			} catch (error) {
				if (error instanceof PathError) {
					throw new AttachmentFailure("SOURCE_PATH_NOT_FOUND", error.message);
				}
				throw error;
			}
			const source = await remoteStat(remote, sourcePath, signal);
			if (source.type === "symlink") {
				throw new AttachmentFailure("SFTP_ERROR", "Source symlink or junction is not supported");
			}
			if (source.type !== "file" && source.type !== "directory") {
				throw new AttachmentFailure("SFTP_ERROR", "Source path is not a regular file or directory");
			}
			attachment.type = source.type;
			if (source.type === "file") {
				const maxFileBytes = this.config.limits?.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
				if (source.size > maxFileBytes) {
					throw new AttachmentFailure("FILE_TOO_LARGE", "File exceeds configured size limit");
				}
				this.update(attachment, { status: "uploading", size: source.size });
				const destination = await this.materializeFile(remote, attachment, sourcePath, source.size, root, signal);
				this.update(attachment, { status: "ready", destinationPath: destination, size: source.size });
			} else {
				const tree = await walkRemoteDirectory(remote, sourcePath, signal);
				const maxDirectoryBytes = this.config.limits?.maxDirectoryBytes || DEFAULT_MAX_DIRECTORY_BYTES;
				if (tree.totalBytes > maxDirectoryBytes) {
					throw new AttachmentFailure("DIRECTORY_TOO_LARGE", "Directory exceeds configured size limit");
				}
				this.update(attachment, { status: "uploading", size: tree.totalBytes });
				const destination = await this.materializeDirectory(remote, attachment, tree, root, signal);
				this.update(attachment, { status: "ready", destinationPath: destination, size: tree.totalBytes });
			}
		} catch (error) {
			await rm(root, { recursive: true, force: true }).catch(() => undefined);
			if (this.removed.has(attachment.id) || this.disposed) return;
			const failure = classifyFailure(error);
			this.update(attachment, {
				status: "failed",
				destinationPath: undefined,
				errorCode: failure.code,
				error: failure.message,
			});
		}
	}

	private async materializeFile(
		remote: SourceRemote,
		attachment: Attachment,
		sourcePath: string,
		size: number,
		root: string,
		signal: AbortSignal,
	): Promise<string> {
		const finalPath = join(root, sanitizeName(attachment.name));
		const temporary = join(root, ".partial-" + randomUUID());
		ensureInside(root, finalPath);
		await mkdir(this.sessionRoot, { recursive: true, mode: 0o700 });
		await mkdir(root, { mode: 0o700 });
		await downloadFiles(remote, [{ remotePath: sourcePath, localPath: temporary }], signal);
		const actual = await statFile(temporary);
		if (!actual.isFile() || actual.size !== size) {
			throw new AttachmentFailure("TRANSFER_INTERRUPTED", "Downloaded file size does not match source");
		}
		await chmod(temporary, 0o600);
		await rename(temporary, finalPath);
		await chmod(finalPath, 0o600);
		return finalPath;
	}

	private async materializeDirectory(
		remote: SourceRemote,
		attachment: Attachment,
		tree: RemoteTree,
		root: string,
		signal: AbortSignal,
	): Promise<string> {
		const finalPath = join(root, sanitizeName(attachment.name));
		const temporary = join(root, ".partial");
		ensureInside(root, finalPath);
		await mkdir(this.sessionRoot, { recursive: true, mode: 0o700 });
		await mkdir(root, { mode: 0o700 });
		await mkdir(temporary, { mode: 0o700 });
		for (const directory of tree.directories) {
			if (!directory) continue;
			const local = join(temporary, ...directory.split("/").map(sanitizeName));
			ensureInside(temporary, local);
			await mkdir(local, { recursive: true, mode: 0o700 });
		}
		const downloads = tree.files.map((file) => {
			const local = join(temporary, ...file.relativePath.split("/").map(sanitizeName));
			ensureInside(temporary, local);
			return { remotePath: file.remotePath, localPath: local };
		});
		await downloadFiles(remote, downloads, signal);
		for (const file of tree.files) {
			const local = join(temporary, ...file.relativePath.split("/").map(sanitizeName));
			const actual = await statFile(local);
			if (!actual.isFile() || actual.size !== file.size) {
				throw new AttachmentFailure("TRANSFER_INTERRUPTED", "Downloaded directory file size does not match source");
			}
			await chmod(local, 0o600);
		}
		await rename(temporary, finalPath);
		await chmod(finalPath, 0o700);
		return finalPath;
	}
}

const persistedErrorCodeMap: Record<string, AttachmentErrorCode> = {
	WINDOWS_HOST_NOT_FOUND: "SOURCE_HOST_NOT_FOUND",
	WINDOWS_SSH_UNREACHABLE: "SOURCE_SSH_UNREACHABLE",
	WINDOWS_AUTH_FAILED: "SOURCE_AUTH_FAILED",
	WINDOWS_PATH_NOT_FOUND: "SOURCE_PATH_NOT_FOUND",
	WINDOWS_PERMISSION_DENIED: "SOURCE_PERMISSION_DENIED",
};

function migratePersistedAttachment(value: unknown, version: 1 | 2): Attachment | undefined {
	if (!isRecord(value) || !isRecord(value.source)) return undefined;
	const source = value.source;
	if (version === 1 && source.platform !== "windows") return undefined;
	const pathStyle = version === 1
		? "windows"
		: source.pathStyle === "windows" || source.pathStyle === "posix"
			? source.pathStyle
			: source.platform === "windows"
				? "windows"
				: undefined;
	if (!pathStyle) return undefined;
	const errorCode = typeof value.errorCode === "string"
		? persistedErrorCodeMap[value.errorCode] || (value.errorCode as AttachmentErrorCode)
		: undefined;
	return {
		...(value as unknown as Attachment),
		source: { ...(source as unknown as Attachment["source"]), pathStyle },
		errorCode,
	};
}

export function migratePersistedState(value: unknown): PersistedState | undefined {
	if (!isRecord(value) || (value.version !== 1 && value.version !== 2) ||
		typeof value.sessionId !== "string" || !Array.isArray(value.attachments)) {
		return undefined;
	}
	const version = value.version as 1 | 2;
	return {
		version: 2,
		sessionId: value.sessionId,
		attachments: value.attachments
			.map((attachment) => migratePersistedAttachment(attachment, version))
			.filter((attachment): attachment is Attachment => attachment !== undefined),
	};
}

function isRestorableAttachment(value: unknown, sessionId: string): value is Attachment {
	if (!isRecord(value)) return false;
	if (value.sessionId !== sessionId || typeof value.id !== "string" || !/^[0-9a-f-]{16,}$/i.test(value.id)) return false;
	if (!isRecord(value.source) || typeof value.source.host !== "string" || typeof value.source.path !== "string") return false;
	if (value.source.pathStyle !== "windows" && value.source.pathStyle !== "posix") return false;
	if (!resolvePathAdapter(value.source.pathStyle).isAbsolutePath(value.source.path) || typeof value.name !== "string") return false;
	if (value.source.username !== undefined &&
		(typeof value.source.username !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.source.username))) return false;
	const port = value.source.port;
	if (port !== undefined &&
		(typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return false;
	const platform = value.source.platform;
	if (platform !== undefined && typeof platform !== "string") return false;
	if (typeof platform === "string" && !["windows", "macos", "linux", "bsd", "wsl", "unknown"].includes(platform)) return false;
	if (value.type !== "file" && value.type !== "directory") return false;
	if (!["pending", "connecting", "uploading", "ready", "failed"].includes(String(value.status))) return false;
	return typeof value.placeholder === "string" || value.placeholder === undefined;
}
