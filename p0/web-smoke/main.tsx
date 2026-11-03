import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownText } from "./vendor/ui-primitives/src/markdown/MarkdownText.tsx";
import chapter from "./chapter.md?raw";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

const labels = { code: { copyLabel: "复制", copiedLabel: "已复制" }, footnotes: "注释" };

createRoot(root).render(
	<StrictMode>
		<main>
			<header>
				<p>P0 V25 · 中文 Markdown</p>
				<h1>章节阅读</h1>
			</header>
			<article aria-label="中文样例章节">
				<MarkdownText text={chapter} labels={labels} />
			</article>
		</main>
	</StrictMode>,
);
