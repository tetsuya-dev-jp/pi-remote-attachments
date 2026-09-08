import type { ConfigPathStyle, PathAdapter, PathStyle } from "./adapter.ts";
import { posixPathAdapter } from "./posix.ts";
import { windowsPathAdapter } from "./windows.ts";

export interface DroppedPathMatch {
	start: number;
	end: number;
	path: string;
}

export interface ParseDroppedPathOptions {
	pathStyle?: ConfigPathStyle;
	allowPosix?: boolean;
}

interface ShellToken {
	start: number;
	end: number;
	value: string;
}

function parseFileUri(value: string): string | undefined {
	if (!value.toLowerCase().startsWith("file://")) return undefined;
	try {
		const uri = new URL(value);
		if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost") || uri.search || uri.hash) {
			return undefined;
		}
		return decodeURIComponent(uri.pathname);
	} catch {
		return undefined;
	}
}

function tokenizeShellInput(text: string): ShellToken[] | undefined {
	const tokens: ShellToken[] = [];
	let index = 0;
	while (index < text.length) {
		while (index < text.length && /\s/.test(text[index])) index++;
		if (index >= text.length) break;
		const start = index;
		let value = "";
		let quote: "'" | '"' | undefined;
		while (index < text.length) {
			const char = text[index];
			if (quote) {
				if (char === quote) {
					quote = undefined;
					index++;
					continue;
				}
				if (char === "\\" && quote === '"') {
					if (index + 1 >= text.length) return undefined;
					value += text[index + 1];
					index += 2;
					continue;
				}
				value += char;
				index++;
				continue;
			}
			if (/\s/.test(char)) break;
			if (char === "'" || char === '"') {
				quote = char;
				index++;
				continue;
			}
			if (char === "\\") {
				if (index + 1 >= text.length) return undefined;
				value += text[index + 1];
				index += 2;
				continue;
			}
			value += char;
			index++;
		}
		if (quote) return undefined;
		tokens.push({ start, end: index, value });
	}
	return tokens;
}

function parseWindowsPathMatches(text: string): DroppedPathMatch[] {
	const matches: DroppedPathMatch[] = [];
	const occupied: Array<{ start: number; end: number }> = [];
	const quoted = /(["'])([^\r\n]*?)\1/g;
	for (const match of text.matchAll(quoted)) {
		const path = match[2];
		const start = match.index ?? 0;
		if (windowsPathAdapter.isAbsolutePath(path)) {
			matches.push({ start, end: start + match[0].length, path });
			occupied.push({ start, end: start + match[0].length });
		}
	}
	const unquoted = /[A-Za-z]:[\\/][^\s"'<>|?*]*/g;
	for (const match of text.matchAll(unquoted)) {
		const start = match.index ?? 0;
		if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]*$/.test(text.slice(0, start))) continue;
		const previous = text[start - 1];
		if (previous && /[A-Za-z0-9_/:.-]/.test(previous)) continue;
		const end = start + match[0].length;
		if (/[<>|?*":]/.test(text[end] || "")) continue;
		if (occupied.some((range) => start < range.end && end > range.start)) continue;
		if (windowsPathAdapter.isAbsolutePath(match[0])) matches.push({ start, end, path: match[0] });
	}
	return matches;
}

function parsePosixPathList(text: string): DroppedPathMatch[] {
	const tokens = tokenizeShellInput(text);
	if (!tokens || tokens.length === 0) return [];
	const matches: DroppedPathMatch[] = [];
	for (const token of tokens) {
		const path = parseFileUri(token.value) || token.value;
		if (!posixPathAdapter.isAbsolutePath(path)) return [];
		matches.push({ start: token.start, end: token.end, path });
	}
	return matches;
}

export function parseDroppedPaths(
	text: string,
	options: ParseDroppedPathOptions = {},
): DroppedPathMatch[] {
	const style = options.pathStyle || "auto";
	const matches = style === "posix" ? [] : parseWindowsPathMatches(text);
	if (options.allowPosix && style !== "windows") matches.push(...parsePosixPathList(text));
	return matches.sort((a, b) => a.start - b.start);
}

export function detectPathStyle(value: string): PathStyle | undefined {
	if (windowsPathAdapter.isAbsolutePath(value)) return "windows";
	const posixPath = parseFileUri(value) || value;
	if (posixPathAdapter.isAbsolutePath(posixPath)) return "posix";
	return undefined;
}

export function resolvePathAdapter(style: PathStyle): PathAdapter {
	return style === "windows" ? windowsPathAdapter : posixPathAdapter;
}

export { posixPathAdapter, windowsPathAdapter };
export type { ConfigPathStyle, PathAdapter, PathStyle } from "./adapter.ts";
