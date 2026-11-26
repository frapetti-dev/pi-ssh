import { expect, test } from "bun:test";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { mount, n } from "../src/ui/nodes";

const k = (id: string, kind = "press") => ({ id, kind, raw: "" }) as KeyEvent;

test("mount re-describes on refresh and routes keys", () => {
	let count = 0;
	const root = mount(refresh => ({
		describe: () => n("text", { text: String(count) }),
		handleKey: key => {
			if (key.id === "down") count++;
			refresh();
		},
	}));
	expect(root.children()[0]!.props().text).toBe("0");
	expect(root.handlers.onKey!(k("down"))).toBe(true);
	expect(root.children()[0]!.props().text).toBe("1");
	expect(root.handlers.onKey!(k("down", "release"))).toBe(false);
	expect(root.children()[0]!.props().text).toBe("1");
});
