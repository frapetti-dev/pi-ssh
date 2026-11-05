import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendConfigHost, listConfigHosts, type NewHost, resolveHost, validateNewHost } from "../src/core/hosts";

const defaults = { user: "me", home: path.join("C:", "home", "me") };
const config = `
Host web db !bad ws* q?
  HostName 10.0.0.5
  Port 2200
  ProxyJump bastion

Host bastion
  HostName bastion.example.com
  User jump

Host multi
  ProxyJump a,b

Host plain
  User none-given

Host *
  User bob
  IdentityFile ~/.ssh/default_key
`;

describe("listConfigHosts", () => {
	test("skips patterns and keeps order", () => {
		expect(listConfigHosts(config)).toEqual(["web", "db", "bastion", "multi", "plain"]);
	});
	test("dedupes", () => {
		expect(listConfigHosts("Host a\nHost a b\n")).toEqual(["a", "b"]);
	});
});

describe("resolveHost", () => {
	test("alias with computed fields", () => {
		const h = resolveHost("web", config, defaults);
		expect(h).toMatchObject({ id: "web", alias: "web", hostName: "10.0.0.5", user: "bob", port: 2200, proxyJump: "bastion" });
		expect(h.identityFiles).toEqual([path.join(defaults.home, ".ssh", "default_key")]);
	});
	test("alias without HostName falls back to alias; explicit user wins over Host *", () => {
		expect(resolveHost("plain", config, defaults)).toMatchObject({ hostName: "plain", user: "none-given", port: 22 });
		expect(resolveHost("bastion", config, defaults)).toMatchObject({ hostName: "bastion.example.com", user: "jump" });
	});
	test("multi-level ProxyJump throws", () => {
		expect(() => resolveHost("multi", config, defaults)).toThrow("Only single-level ProxyJump is supported (got: a,b)");
	});
	test("ad-hoc forms", () => {
		expect(resolveHost("u@h:2222", "", defaults)).toMatchObject({ id: "u@h:2222", hostName: "h", user: "u", port: 2222 });
		expect(resolveHost("h", "", defaults)).toMatchObject({ id: "me@h:22", user: "me", port: 22 });
		expect(resolveHost("[::1]:22", "", defaults)).toMatchObject({ hostName: "::1", port: 22 });
	});
	test("ad-hoc picks up wildcard defaults, explicit parts win", () => {
		expect(resolveHost("h", config, defaults).user).toBe("bob");
		expect(resolveHost("alice@h", config, defaults).user).toBe("alice");
	});
	test("invalid input", () => {
		expect(() => resolveHost("a b", "", defaults)).toThrow("Invalid host: a b. Use a ~/.ssh/config alias or user@host[:port]");
	});
	test("empty config text is fine", () => {
		expect(listConfigHosts("")).toEqual([]);
	});
});

describe("new hosts", () => {
	const base: NewHost = { alias: "box", hostName: "box.example.com", user: "", port: "", identityFile: "", proxyJump: "" };
	const bad = (patch: Partial<NewHost>, save = true, existing: string[] = []) => validateNewHost({ ...base, ...patch }, save, existing);

	test("validation messages in order", () => {
		expect(bad({})).toBeUndefined();
		expect(bad({ alias: "" })).toBe("Alias is required to save to ~/.ssh/config");
		expect(bad({ alias: "" }, false)).toBeUndefined();
		expect(bad({ alias: "a b" })).toBe("Alias may only contain letters, digits, '.', '_' and '-'");
		expect(bad({}, true, ["box"])).toBe("Alias already exists in ~/.ssh/config: box");
		expect(bad({}, false, ["box"])).toBeUndefined();
		expect(bad({ hostName: "" })).toBe("HostName is required");
		expect(bad({ hostName: "a b" })).toBe("HostName must not contain spaces");
		expect(bad({ user: "a@b" })).toBe("User must not contain spaces or '@'");
		expect(bad({ port: "0" })).toBe("Port must be a number from 1 to 65535");
		expect(bad({ port: "65536" })).toBe("Port must be a number from 1 to 65535");
		expect(bad({ port: "2x" })).toBe("Port must be a number from 1 to 65535");
		expect(bad({ proxyJump: "a,b" })).toBe("Only single-level ProxyJump is supported");
		expect(bad({ proxyJump: "a b" })).toBe("ProxyJump must not contain spaces");
	});

	test("appended block resolves, even when the file lacks a trailing newline", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ssh-cfg-"));
		const file = path.join(dir, "ssh", "config");
		await fs.mkdir(path.dirname(file));
		await fs.writeFile(file, "Host old\n  HostName old.example.com");
		await appendConfigHost(file, { ...base, user: "deploy", port: "2222", proxyJump: "bastion" });
		const text = await fs.readFile(file, "utf8");
		expect(listConfigHosts(text)).toEqual(["old", "box"]);
		expect(resolveHost("box", text, defaults)).toMatchObject({
			hostName: "box.example.com",
			user: "deploy",
			port: 2222,
			proxyJump: "bastion",
		});
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("an IdentityFile containing a space is quoted and resolves unquoted", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ssh-cfg-"));
		const file = path.join(dir, "config");
		await appendConfigHost(file, { ...base, identityFile: "C:/Users/a b/key" });
		const text = await fs.readFile(file, "utf8");
		expect(resolveHost("box", text, defaults).identityFiles).toEqual(["C:/Users/a b/key"]);
		await fs.rm(dir, { recursive: true, force: true });
	});
});
