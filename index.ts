import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AttachmentManager,
	type Attachment,
	type AttachmentConfig,
	type PersistedState,
	SESSION_STATE_ENTRY_TYPE,
	detectClientHost,
	loadConfig,
	parseWindowsPaths,
	resolveWindowsRemote,
	saveConfig,
} from "./core.ts";

const STATUS_ID = "pi-remote-attachments";
const WIDGET_ID = "pi-remote-attachments";
const START_PASTE = "\x1b[200~";
const END_PASTE = "\x1b[201~";

type CustomEditorArguments = ConstructorParameters<typeof CustomEditor>;
type ReplacePastedText = (text: string) => string;

class AttachmentEditor extends CustomEditor {
	private attachmentPasteBuffer: string | undefined;
	private readonly replacePastedText: ReplacePastedText;

	constructor(
		tui: CustomEditorArguments[0],
		theme: CustomEditorArguments[1],
		keybindings: CustomEditorArguments[2],
		replacePastedText: ReplacePastedText,
	) {
		super(tui, theme, keybindings);
		this.replacePastedText = replacePastedText;
	}

	handleInput(data: string): void {
		const start = data.indexOf(START_PASTE);
		if (this.attachmentPasteBuffer !== undefined || start >= 0) {
			if (this.attachmentPasteBuffer === undefined) {
				if (start > 0) super.handleInput(this.replacePastedText(data.slice(0, start)));
				this.attachmentPasteBuffer = data.slice(start + START_PASTE.length);
			} else {
				this.attachmentPasteBuffer += data;
			}
			const end = this.attachmentPasteBuffer.indexOf(END_PASTE);
			if (end < 0) return;
			const content = this.attachmentPasteBuffer.slice(0, end);
			const remaining = this.attachmentPasteBuffer.slice(end + END_PASTE.length);
			this.attachmentPasteBuffer = undefined;
			super.handleInput(START_PASTE + this.replacePastedText(content) + END_PASTE);
			if (remaining) this.handleInput(remaining);
			return;
		}
		super.handleInput(this.replacePastedText(data));
	}
}

let manager: AttachmentManager | undefined;
let currentContext: ExtensionContext | undefined;
let currentConfig: AttachmentConfig | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function loadPersistedState(ctx: ExtensionContext): PersistedState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY_TYPE) continue;
		if (!isRecord(entry.data) || entry.data.version !== 1 || !Array.isArray(entry.data.attachments)) {
			return undefined;
		}
		return entry.data as unknown as PersistedState;
	}
	return undefined;
}

function render(ctx: ExtensionContext, attachments: Attachment[]): void {
	if (attachments.length === 0) {
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	const active = attachments.filter((attachment) =>
		attachment.status === "pending" ||
		attachment.status === "connecting" ||
		attachment.status === "uploading",
	).length;
	ctx.ui.setStatus(
		STATUS_ID,
		active > 0 ? "attachments: " + active + " transferring" : "attachments: " + attachments.length,
	);
	ctx.ui.setWidget(
		WIDGET_ID,
		attachments.map((attachment, index) => {
			const detail = attachment.error ? " — " + attachment.error : "";
			return String(index + 1) + "  [" + attachment.name + "] " + attachment.status + detail;
		}),
	);
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
}

function configForDisplay(config: AttachmentConfig): string {
	return JSON.stringify(config, null, 2);
}

async function configure(args: string, ctx: ExtensionContext): Promise<void> {
	if (!currentConfig) return;
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		notify(ctx, configForDisplay(currentConfig));
		return;
	}
	const key = tokens[0];
	const value = tokens.slice(1).join(" ").trim();
	if (key === "setup") {
		if (!ctx.hasUI) {
			notify(ctx, "Setup requires interactive UI", "warning");
			return;
		}
		const host = await ctx.ui.input("Windows SSH host", currentConfig.windows.host || detectClientHost() || "");
		const username = await ctx.ui.input("Windows SSH username", currentConfig.windows.username || "");
		const identityFile = await ctx.ui.input(
			"SSH identity file",
			currentConfig.windows.identityFile || "~/.ssh/pi_windows_attachment",
		);
		if (!host || !username || !identityFile) {
			notify(ctx, "Setup cancelled", "warning");
			return;
		}
		currentConfig.windows.host = host.trim();
		currentConfig.windows.username = username.trim();
		currentConfig.windows.identityFile = identityFile.trim();
		await saveConfig(currentConfig);
		manager?.setConfig(currentConfig);
		notify(ctx, "Attachment config saved");
		return;
	}
	if (!value || !["host", "username", "identityFile", "knownHostsFile", "hostKeyAlias", "port"].includes(key)) {
		notify(ctx, "Usage: /attachments config <host|username|port|identityFile|knownHostsFile|hostKeyAlias> <value>", "warning");
		return;
	}
	if (key === "port") {
		const port = Number(value);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			notify(ctx, "Invalid SSH port", "warning");
			return;
		}
		currentConfig.windows.port = port;
	} else {
		currentConfig.windows[key as "host" | "username" | "identityFile" | "knownHostsFile" | "hostKeyAlias"] = value;
	}
	await saveConfig(currentConfig);
	manager?.setConfig(currentConfig);
	notify(ctx, "Attachment config saved");
}

async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
	if (!manager) {
		notify(ctx, "Attachment manager is not ready", "error");
		return;
	}
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const action = tokens[0] || "list";
	if (action === "list") {
		const attachments = manager.list();
		notify(
			ctx,
			attachments.length === 0
				? "No attachments"
				: attachments.map((attachment, index) => {
					const detail = attachment.error ? " — " + attachment.error : "";
					return String(index + 1) + "  " + attachment.name + "  " + attachment.status + detail;
				}).join("\n"),
		);
		return;
	}
	if (action === "dir") {
		notify(ctx, manager.sessionRoot);
		return;
	}
	if (action === "status") {
		let remote = "unresolved";
		try {
			const resolved = resolveWindowsRemote(currentConfig!);
			remote = resolved.username + "@" + resolved.host + ":" + resolved.port;
		} catch (error) {
			remote = (error as Error).message;
		}
		const attachments = manager.list();
		notify(
			ctx,
			"Windows host: " + remote +
			"\nSFTP: OpenSSH on demand" +
			"\nAttachments: " + attachments.filter((attachment) => attachment.status === "ready").length + " ready",
		);
		return;
	}
	if (action === "config" || action === "setup") {
		await configure(action === "setup" ? "setup" : tokens.slice(1).join(" "), ctx);
		return;
	}
	if (action === "remove") {
		if (!tokens[1] || !(await manager.remove(tokens[1]))) notify(ctx, "Attachment not found", "warning");
		else notify(ctx, "Attachment removed");
		return;
	}
	if (action === "retry") {
		if (!tokens[1] || !manager.retry(tokens[1])) notify(ctx, "Failed attachment not found", "warning");
		else notify(ctx, "Attachment retry started");
		return;
	}
	if (action === "cleanup") {
		const count = await manager.cleanup();
		notify(ctx, "Removed " + count + " stale attachment directories");
		return;
	}
	notify(ctx, "Usage: /attachments [status|dir|remove <id>|retry <id>|cleanup|config]", "warning");
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("attachments", {
		description: "Manage Windows-to-Ubuntu file attachments",
		handler: handleCommand,
	});
	pi.registerCommand("attach", {
		description: "Alias for /attachments",
		handler: handleCommand,
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !manager) return { action: "continue" as const };
		const activeManager = manager;
		const text = activeManager.replacePastedText(event.text);
		const references = activeManager.referenced(text);
		if (references.length === 0) return { action: "continue" as const };
		const attachments = await activeManager.waitForReady(text);
		if (manager !== activeManager) return { action: "handled" as const };
		const incomplete = attachments.filter((attachment) => attachment.status !== "ready");
		if (incomplete.length > 0) {
			notify(
				ctx,
				"Attachment upload incomplete. Retry or remove: " +
				incomplete.map((attachment) => attachment.name).join(", "),
				"error",
			);
			return { action: "handled" as const };
		}
		return { action: "transform" as const, text: manager.transformPrompt(text) };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (manager) await manager.shutdown();
		currentContext = ctx;
		currentConfig = { windows: {} };
		try {
			currentConfig = await loadConfig();
		} catch (error) {
			notify(ctx, (error as Error).message, "error");
		}
		const activeManager = new AttachmentManager({
			sessionId: ctx.sessionManager.getSessionId(),
			config: currentConfig,
			onChange: (attachments) => {
				if (currentContext === ctx) render(ctx, attachments);
			},
			onState: (state) => {
				pi.appendEntry(SESSION_STATE_ENTRY_TYPE, state);
			},
		});
		manager = activeManager;
		await activeManager.restore(loadPersistedState(ctx));
		render(ctx, activeManager.list());
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		if (previous) {
			notify(ctx, "Attachment editor disabled because another extension owns the editor", "warning");
			return;
		}
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new AttachmentEditor(tui, theme, keybindings, (text) => activeManager.replacePastedText(text)),
		);
	});

	pi.on("session_shutdown", async () => {
		const current = manager;
		manager = undefined;
		currentContext = undefined;
		currentConfig = undefined;
		if (current) await current.shutdown();
	});
}
