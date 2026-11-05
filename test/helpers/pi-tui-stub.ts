/**
 * Preloaded stand-in for `@oh-my-pi/pi-tui` (not installed in this repo). Only `matchesKey` is a
 * value import in src/; it maps the key ids pi-ssh uses to their legacy terminal sequences.
 */
const KEYS: Record<string, string> = {
	escape: "\x1b",
	enter: "\r",
	tab: "\t",
	"shift+tab": "\x1b[Z",
	space: " ",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	backspace: "\x7f",
	delete: "\x1b[3~",
	home: "\x1b[H",
	end: "\x1b[F",
	"ctrl+u": "\x15",
};

export function matchesKey(data: string, id: string): boolean {
	return KEYS[id] === data;
}

Bun.plugin({
	name: "pi-tui-stub",
	setup(b) {
		b.module("@oh-my-pi/pi-tui", () => ({ loader: "object", exports: { matchesKey } }));
	},
});
