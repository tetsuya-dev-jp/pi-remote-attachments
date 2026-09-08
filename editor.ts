export const START_PASTE = "\x1b[200~";
export const END_PASTE = "\x1b[201~";

export type ReplacePastedText = (text: string, options?: { allowPosix?: boolean }) => string;

export class BracketedPasteTransformer {
	private pasteBuffer: string | undefined;

	transform(data: string, replace: ReplacePastedText): string {
		let input = data;
		let output = "";
		while (input || this.pasteBuffer !== undefined) {
			if (this.pasteBuffer === undefined) {
				const start = input.indexOf(START_PASTE);
				if (start < 0) {
					output += replace(input);
					break;
				}
				output += replace(input.slice(0, start));
				this.pasteBuffer = "";
				input = input.slice(start + START_PASTE.length);
			}

			const paste = this.pasteBuffer + input;
			const end = paste.indexOf(END_PASTE);
			if (end < 0) {
				this.pasteBuffer = paste;
				break;
			}
			output += START_PASTE + replace(
				paste.slice(0, end),
				{ allowPosix: true },
			) + END_PASTE;
			this.pasteBuffer = undefined;
			input = paste.slice(end + END_PASTE.length);
		}
		return output;
	}
}
