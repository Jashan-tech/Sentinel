import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Feature 2 agent service. The NVIDIA key stays server-side in agent/.env.
    proxy: {
      "/api/agent": {
        target: process.env.AGENT_URL ?? "http://127.0.0.1:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/agent/, ""),
      },
    },
  },
});
