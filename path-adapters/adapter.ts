export type PathStyle = "windows" | "posix";
export type ConfigPathStyle = "auto" | PathStyle;

export interface PathAdapter {
	readonly style: PathStyle;

	isAbsolutePath(value: string): boolean;

	normalize(value: string): string;

	basename(value: string): string;

	toSftpPath(value: string): string;
}

export class PathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathError";
	}
}
