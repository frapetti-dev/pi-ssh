import { describe, expect, test } from "bun:test";
import { BUILTIN_ALLOW, BUILTIN_DENY, classify } from "../src/core/classify";

const base = { allow: [...BUILTIN_ALLOW], deny: [...BUILTIN_DENY] };
const reason = (cmd: string, rules = base) => {
	const r = classify(cmd, rules);
	return r.allowed ? "ALLOWED" : r.reason;
};

describe("classify", () => {
	test("allows read-only commands and pipelines", () => {
		expect(reason("ls -la /var/log")).toBe("ALLOWED");
		expect(reason("cat a | grep b | wc -l")).toBe("ALLOWED");
		expect(reason("git log --oneline")).toBe("ALLOWED");
		expect(reason("systemctl status nginx")).toBe("ALLOWED");
		expect(reason("echo '$(id)'")).toBe("ALLOWED");
	});

	test("rejects commands off the allowlist", () => {
		expect(reason("git push")).toContain("not on the read-only allowlist");
		expect(reason("rm -rf /")).toBe('"rm" is not on the read-only allowlist');
		expect(reason("systemctl restart nginx")).toContain("not on the read-only allowlist");
	});

	test("rejects shell control syntax", () => {
		expect(reason("ls; rm x")).toBe('contains ";"');
		expect(reason("ls && rm x")).toBe('contains "&"');
		expect(reason("ls || rm x")).toBe('contains "||"');
		expect(reason("echo $(id)")).toBe('contains "$("');
		expect(reason('echo "$(id)"')).toBe('contains "$("');
		expect(reason('echo "`id`"')).toBe('contains "`"');
		expect(reason("cat x > y")).toBe('contains ">"');
		expect(reason("cat < y")).toBe('contains "<"');
		expect(reason("ls\nrm x")).toBe('contains "newline"');
		expect(reason("ls |")).toBe("empty pipeline segment");
		expect(reason("echo 'unterminated")).toBe("unterminated quote");
	});

	test("rejects env assignment and privilege escalation per segment", () => {
		expect(reason("FOO=1 ls")).toBe("sets environment variable");
		expect(reason("sudo ls")).toBe("privilege escalation");
		expect(reason("ls | sudo tee x")).toBe("privilege escalation");
	});

	test("deny rules win over allow", () => {
		expect(reason("find / -name x -delete")).toBe('matches deny rule "find * -delete"');
		expect(reason("find / -name x")).toBe("ALLOWED");
		expect(reason("journalctl --vacuum-size=1G")).toContain("matches deny rule");
		expect(reason("git diff --output=x")).toContain("matches deny rule");
		expect(reason("sort -o out in")).toContain("matches deny rule");
	});

	test("user rules extend built-ins", () => {
		const rules = { allow: [...base.allow, "kubectl get"], deny: [...base.deny, "cat /etc/shadow"] };
		expect(reason("kubectl get pods", rules)).toBe("ALLOWED");
		expect(reason("kubectl delete pod x", rules)).toContain("not on the read-only allowlist");
		expect(reason("cat /etc/shadow", rules)).toContain("matches deny rule");
		expect(reason("cat /etc/hostname", rules)).toBe("ALLOWED");
	});
});
