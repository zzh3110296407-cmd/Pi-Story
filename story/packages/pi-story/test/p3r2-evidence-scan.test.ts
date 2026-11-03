import path from "node:path";
import { expect, test } from "vitest";
import { publicEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { scanSecrets } from "../../../scripts/eval/p2/secrets.mjs";

test("ordinary authorization labels in fictional administrative prose are preserved", () => {
	expect(() =>
		publicEvidence(
			JSON.stringify({
				text: "The permit lists case 49. Authorization: supervisor code entered in the public register.",
			}),
		),
	).not.toThrow();
});

test("ordinary fictional discussion of a temporary password is preserved as model evidence", () => {
	expect(() =>
		publicEvidence(
			JSON.stringify({
				thinking: "The character remembers the reset pattern: temporary password: a date mentioned in the story.",
			}),
		),
	).not.toThrow();
});

test.each([
	JSON.stringify({ password: "synthetic-private-value" }),
	"PASSWORD=synthetic-private-value",
	"setting\n password: synthetic-private-value",
	JSON.stringify({ log: "setting\nPASSWORD=synthetic-private-value" }),
	JSON.stringify({ api_key: "synthetic-private-value" }),
	JSON.stringify({ authorization: "synthetic-private-value" }),
	JSON.stringify({ "proxy-authorization": "synthetic-private-value" }),
	"Authorization: synthetic-private-value",
	JSON.stringify({ log: "headers\nAuthorization: synthetic-private-value" }),
	"request header Authorization: Basic synthetic-private-value",
	"request header Proxy-Authorization: Digest synthetic-private-value",
	"configuration API_KEY=synthetic-private-value",
	JSON.stringify({ prose: `sk-${"x".repeat(24)}` }),
	JSON.stringify({ prose: ["Bearer", "synthetic-private-value"].join(" ") }),
])("credential material and actual password fields remain rejected", (text) => {
	expect(() => publicEvidence(text)).toThrow("Sensitive evidence rejected");
});

test("synthetic negative inputs do not embed credential-shaped material in the published test sources", () => {
	const result = scanSecrets([import.meta.dirname], path.resolve(import.meta.dirname, "../../../.."));
	expect(result.hits).toEqual([]);
});
