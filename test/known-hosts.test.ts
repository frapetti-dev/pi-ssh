import { describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendKnownHost,
	checkHostKey,
	forgetHostKey,
	hostField,
	keyInfo,
	knownHostsLine,
	listKnownHosts,
	removeKnownHosts,
} from "../src/core/known-hosts";

function blob(type: string, payload: Buffer = randomBytes(32)): Buffer {
	const t = Buffer.from(type, "ascii");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(t.length);
	return Buffer.concat([len, t, payload]);
}
const b64 = (b: Buffer) => b.toString("base64");

describe("known_hosts", () => {
	const key = blob("ssh-ed25519");

	test("fingerprint is SHA256 base64 without padding", () => {
		const info = keyInfo(key);
		expect(info.type).toBe("ssh-ed25519");
		expect(info.fingerprint).toBe(`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`);
		expect(info.fingerprint.endsWith("=")).toBe(false);
	});

	test("plain match, comma lists and wildcard", () => {
		const text = `# c\n\nother,example.com ssh-ed25519 ${b64(key)}\n`;
		expect(checkHostKey(text, "Example.COM", 22, key).status).toBe("match");
		expect(checkHostKey(`*.example.com ssh-ed25519 ${b64(key)}`, "a.example.com", 22, key).status).toBe("match");
		expect(checkHostKey(`*.example.com,!b.example.com ssh-ed25519 ${b64(key)}`, "b.example.com", 22, key).status).toBe("unknown");
	});

	test("non-default port uses [host]:port", () => {
		expect(hostField("H", 2222)).toBe("[h]:2222");
		const text = `[h]:2222 ssh-ed25519 ${b64(key)}`;
		expect(checkHostKey(text, "h", 2222, key).status).toBe("match");
		expect(checkHostKey(text, "h", 22, key).status).toBe("unknown");
	});

	test("hashed entries", () => {
		const salt = randomBytes(20);
		const hash = createHmac("sha1", salt).update("secret.host").digest();
		const text = `|1|${b64(salt)}|${b64(hash)} ssh-ed25519 ${b64(key)}`;
		expect(checkHostKey(text, "secret.host", 22, key).status).toBe("match");
		expect(checkHostKey(text, "other.host", 22, key).status).toBe("unknown");
	});

	test("same type different blob is a mismatch", () => {
		const text = `h ssh-ed25519 ${b64(blob("ssh-ed25519"))}`;
		expect(checkHostKey(text, "h", 22, key).status).toBe("mismatch");
	});

	test("@revoked wins; cert-authority ignored", () => {
		const text = `h ssh-ed25519 ${b64(key)}\n@revoked h ssh-ed25519 ${b64(key)}\n@cert-authority * ssh-ed25519 ${b64(blob("ssh-ed25519"))}`;
		expect(checkHostKey(text, "h", 22, key).status).toBe("revoked");
		expect(checkHostKey(`@cert-authority * ssh-ed25519 ${b64(blob("ssh-ed25519"))}`, "h", 22, key).status).toBe("unknown");
	});

	test("other key type only is unknown with knownTypes", () => {
		const text = `h ssh-rsa ${b64(blob("ssh-rsa"))}`;
		expect(checkHostKey(text, "h", 22, key)).toEqual({ status: "unknown", knownTypes: ["ssh-rsa"] });
	});

	test("line format and append", async () => {
		expect(knownHostsLine("H", 22, key)).toBe(`h ssh-ed25519 ${b64(key)}\n`);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ssh-kh-"));
		const file = path.join(dir, "sub", "known_hosts");
		await appendKnownHost(file, "h", 2222, key);
		await appendKnownHost(file, "h2", 22, key);
		const text = await fs.readFile(file, "utf8");
		expect(text).toBe(`[h]:2222 ssh-ed25519 ${b64(key)}\nh2 ssh-ed25519 ${b64(key)}\n`);
		expect(checkHostKey(text, "h", 2222, key).status).toBe("match");
		await fs.rm(dir, { recursive: true, force: true });
	});
});

describe("forgetting host keys", () => {
	const key = blob("ssh-ed25519");
	const k = b64(key);

	test("exact plain line is removed, unrelated lines stay", () => {
		const text = `h ssh-ed25519 ${k}\nother ssh-ed25519 ${k}\n`;
		expect(removeKnownHosts(text, "h", 22)).toEqual({ text: `other ssh-ed25519 ${k}\n`, removed: 1 });
	});

	test("[h]:2222 is removed only for port 2222", () => {
		const text = `[h]:2222 ssh-ed25519 ${k}\nh ssh-ed25519 ${k}`;
		expect(removeKnownHosts(text, "h", 2222)).toEqual({ text: `h ssh-ed25519 ${k}`, removed: 1 });
		expect(removeKnownHosts(text, "h", 22)).toEqual({ text: `[h]:2222 ssh-ed25519 ${k}`, removed: 1 });
	});

	test("hashed line for the host is removed", () => {
		const salt = randomBytes(20);
		const hash = createHmac("sha1", salt).update("secret.host").digest();
		const text = `|1|${b64(salt)}|${b64(hash)} ssh-ed25519 ${k}\nkeep ssh-ed25519 ${k}\n`;
		expect(listKnownHosts(text, "secret.host", 22)).toMatchObject([{ hashed: true, removable: true }]);
		expect(removeKnownHosts(text, "secret.host", 22)).toEqual({ text: `keep ssh-ed25519 ${k}\n`, removed: 1 });
	});

	test("shared pattern list is rewritten without the host", () => {
		const text = `h,other ssh-ed25519 ${k} comment\n`;
		expect(removeKnownHosts(text, "h", 22)).toEqual({ text: `other ssh-ed25519 ${k} comment\n`, removed: 1 });
	});

	test("wildcard-only matches are listed but kept", () => {
		const text = `*.example.com ssh-ed25519 ${k}\n`;
		expect(listKnownHosts(text, "a.example.com", 22)).toEqual([{ ...keyInfo(key), hashed: false, revoked: false, removable: false }]);
		expect(removeKnownHosts(text, "a.example.com", 22)).toEqual({ text, removed: 0 });
	});

	test("@revoked and @cert-authority lines are kept", () => {
		const text = `@revoked h ssh-ed25519 ${k}\n@cert-authority h ssh-ed25519 ${k}\n`;
		expect(listKnownHosts(text, "h", 22)).toMatchObject([{ revoked: true, removable: false }]);
		expect(removeKnownHosts(text, "h", 22)).toEqual({ text, removed: 0 });
	});

	test("CRLF endings are preserved", () => {
		const text = `a ssh-ed25519 ${k}\r\nh ssh-ed25519 ${k}\r\nb ssh-ed25519 ${k}\r\n`;
		expect(removeKnownHosts(text, "h", 22).text).toBe(`a ssh-ed25519 ${k}\r\nb ssh-ed25519 ${k}\r\n`);
	});

	test("forgetHostKey on a missing file returns 0 and creates nothing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ssh-kh-"));
		const file = path.join(dir, "known_hosts");
		expect(await forgetHostKey(file, "h", 22)).toBe(0);
		expect(await fs.readdir(dir)).toEqual([]);
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("forgetHostKey rewrites the file and leaves no temp file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ssh-kh-"));
		const file = path.join(dir, "known_hosts");
		await fs.writeFile(file, `h ssh-ed25519 ${k}\nkeep ssh-ed25519 ${k}\n`);
		expect(await forgetHostKey(file, "h", 22)).toBe(1);
		expect(await fs.readFile(file, "utf8")).toBe(`keep ssh-ed25519 ${k}\n`);
		expect(await fs.readdir(dir)).toEqual(["known_hosts"]);
		await fs.rm(dir, { recursive: true, force: true });
	});
});
