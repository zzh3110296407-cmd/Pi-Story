import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

const rules = JSON.parse(readFileSync(new URL("dependency-rules.json", import.meta.url), "utf8"));
const packageName = (name) => (name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]);
const within = (file, folder) => file === folder || file.startsWith(`${folder}${path.sep}`);
const isPi = (name) => name.startsWith("@earendil-works/") || name.startsWith("@mariozechner/pi-");

// TypeScript 7's exported scanner excludes comments and string contents. No source is executed.
function imports(text) {
	const scanner = createScanner(true, undefined, text);
	const tokens = [];
	const templateDepths = [];
	let braceDepth = 0;
	while (scanner.scan() !== SyntaxKind.EndOfFile) {
		const kind = scanner.getToken();
		if (kind === SyntaxKind.TemplateHead) templateDepths.push(braceDepth);
		else if (kind === SyntaxKind.OpenBraceToken) braceDepth++;
		else if (kind === SyntaxKind.CloseBraceToken) {
			if (templateDepths.at(-1) === braceDepth) {
				// A template's closing interpolation brace starts literal text, not JavaScript.
				if (scanner.reScanTemplateToken(false) === SyntaxKind.TemplateTail) templateDepths.pop();
			} else braceDepth--;
		}
		tokens.push({ kind: scanner.getToken(), value: scanner.getTokenValue(), start: scanner.getTokenStart() });
	}
	const found = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind === SyntaxKind.ImportKeyword) {
			if (tokens[i + 1]?.kind === SyntaxKind.OpenParenToken)
				found.push({ forbidden: "dynamic import / import type", start: token.start });
			else if (tokens[i + 1]?.kind === SyntaxKind.StringLiteral)
				found.push({ specifier: tokens[i + 1].value, start: token.start });
		}
		if (token.kind === SyntaxKind.FromKeyword && tokens[i + 1]?.kind === SyntaxKind.StringLiteral)
			found.push({ specifier: tokens[i + 1].value, start: token.start });
		if (token.value === "require" && tokens[i + 1]?.kind === SyntaxKind.OpenParenToken)
			found.push({ forbidden: "require", start: token.start });
	}
	return found;
}

export function inspectDependencies(storyRoot) {
	const units = [];
	const violations = [];
	for (const area of ["packages", "apps"]) {
		const folder = path.resolve(storyRoot, area);
		if (!existsSync(folder)) continue;
		for (const entry of readdirSync(folder, { withFileTypes: true }).filter((item) => item.isDirectory())) {
			const root = path.join(folder, entry.name);
			if (!existsSync(path.join(root, "package.json"))) continue;
			const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
			units.push({ root, src: path.join(root, "src"), role: entry.name, name: manifest.name, manifest });
		}
	}
	for (const unit of units) {
		const rule = rules[unit.role];
		if (!rule) {
			violations.push({ file: unit.root, reason: "Unknown business unit" });
			continue;
		}
		const dependencies = Object.assign(
			{},
			unit.manifest.dependencies,
			unit.manifest.optionalDependencies,
			unit.manifest.peerDependencies,
		);
		const inspect = (file, specifier) => {
			let target;
			let name = packageName(specifier);
			const alias = dependencies[name];
			if (typeof alias === "string" && alias.startsWith("npm:"))
				name = packageName(alias.slice(4).replace(/@[^@/]+$/u, ""));
			if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
				const resolved = path.resolve(path.dirname(file), specifier);
				if (
					path
						.relative(storyRoot, resolved)
						.split(path.sep)
						.some((part) => ["test", "tests", "__tests__"].includes(part))
				)
					return "Product imports test code";
				if (within(resolved, unit.src)) return;
				target = units.find((other) => within(resolved, other.src));
				if (!target) return "Import escapes business source roots";
			} else {
				target = units.find((other) => other.name === name);
				if (!target && name.startsWith("@pi-story/")) return "Unknown project dependency";
			}
			if (target)
				return target === unit || rule.project.includes(target.role)
					? undefined
					: `Forbidden project dependency: ${target.role}`;
			if (isPi(name)) return rule.pi ? undefined : "Pi dependency forbidden";
			if (isBuiltin(specifier))
				return rule.node === "*" || rule.node.includes(specifier) ? undefined : "Node builtin forbidden";
			return rule.external === "*" || rule.external.includes(name) ? undefined : "External dependency forbidden";
		};
		for (const specifier of Object.keys(dependencies)) {
			const reason = inspect(path.join(unit.src, "index.ts"), specifier);
			if (reason) violations.push({ file: path.join(unit.root, "package.json"), specifier, reason });
		}
		const walk = (folder) => {
			if (!existsSync(folder)) return;
			for (const entry of readdirSync(folder, { withFileTypes: true })) {
				const file = path.join(folder, entry.name);
				if (entry.isDirectory()) walk(file);
				else if (/\.[cm]?[jt]sx?$/u.test(file)) {
					const source = readFileSync(file, "utf8");
					for (const item of imports(source)) {
						const reason = item.forbidden ?? inspect(file, item.specifier);
						if (reason)
							violations.push({
								file,
								specifier: item.specifier,
								reason,
								line: source.slice(0, item.start).split("\n").length,
							});
					}
				}
			}
		};
		walk(unit.src);
	}
	return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const violations = inspectDependencies(path.resolve(import.meta.dirname, ".."));
	if (violations.length) {
		console.error(JSON.stringify(violations, null, 2));
		process.exitCode = 1;
	} else console.log("Story dependency boundaries: passed");
}
