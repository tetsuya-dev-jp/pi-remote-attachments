import { PathError, type PathAdapter } from "./adapter.ts";

export class WindowsPathAdapter implements PathAdapter {
	readonly style = "windows" as const;

	isAbsolutePath(value: string): boolean {
		const path = value.trim();
		if (!/^[A-Za-z]:[\\/]/.test(path)) return false;
		const rest = path.slice(2);
		const normalizedRest = rest.replaceAll("\\", "/");
		return !/[\u0000-\u001f\u007f<>:"|?*]/.test(rest) &&
			!normalizedRest.split("/").some((part) => part === "." || part === "..");
	}

	normalize(value: string): string {
		const path = value.trim();
		if (!this.isAbsolutePath(path)) {
			throw new PathError("Not a valid Windows absolute path");
		}
		const normalized = path.replaceAll("\\", "/");
		const rest = normalized.slice(2);
		if (rest.split("/").some((part) => part === "." || part === "..")) {
			throw new PathError("Windows path contains a traversal segment");
		}
		return normalized[0].toUpperCase() + ":" + (rest.startsWith("/") ? rest : "/" + rest);
	}

	basename(value: string): string {
		const normalized = this.normalize(value).replace(/\/+$/, "");
		const slash = normalized.lastIndexOf("/");
		return slash >= 0 ? normalized.slice(slash + 1) || normalized.slice(0, 2) : normalized;
	}

	toSftpPath(value: string): string {
		return "/" + this.normalize(value);
	}
}

export const windowsPathAdapter = new WindowsPathAdapter();
