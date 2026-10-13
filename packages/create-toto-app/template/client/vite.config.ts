import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";

export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    resolve: {
        alias: {
            "@client": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    server: {
        port: 3000,
        strictPort: true,
        proxy: {
            "/api": "http://localhost:3001",
        },
    },
    build: {
        outDir: fileURLToPath(new URL("../server/public", import.meta.url)),
        emptyOutDir: true,
    },
});
