import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4766,
    proxy: {
      "/api": "http://127.0.0.1:4765",
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
