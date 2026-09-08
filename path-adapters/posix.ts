import { PathError, type PathAdapter } from "./adapter.ts";

export class PosixPathAdapter implements PathAdapter {
	readonly style = "posix" as const;

	isAbsolutePath(value: string): boolean {
		const path = value.trim();
		return path.startsWith("/") &&
			!/[\u0000-\u001f\u007f]/.test(path) &&
			!path.split("/").some((part) => part === "." || part === "..");
	}

	normalize(value: string): string {
		const path = value.trim();
		if (!this.isAbsolutePath(path)) {
			throw new PathError("Not a valid POSIX absolute path");
		}
		if (path.split("/").some((part) => part === "." || part === "..")) {
			throw new PathError("POSIX path contains a traversal segment");
		}
		return path.replace(/\/{2,}/g, "/") || "/";
	}

	basename(value: string): string {
		const normalized = this.normalize(value).replace(/\/+$/, "");
		const slash = normalized.lastIndexOf("/");
		return slash >= 0 ? normalized.slice(slash + 1) : normalized;
	}

	toSftpPath(value: string): string {
		return this.normalize(value);
	}
}

export const posixPathAdapter = new PosixPathAdapter();
