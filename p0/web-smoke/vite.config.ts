import { defineConfig } from "vite";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	cacheDir: ".cache/vite",
	build: { outDir: "dist", emptyOutDir: true },
});
