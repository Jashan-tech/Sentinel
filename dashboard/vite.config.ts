import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Feature 2 agent service. The NVIDIA key stays server-side in agent/.env.
    proxy: {
      // Rover dispatcher control API (Start Patrol / Stop / status).
      "/api/dispatch": {
        target: process.env.DISPATCH_URL ?? "http://127.0.0.1:3002",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/dispatch/, ""),
      },
      // Rover Live page: the rover's Jetson HTTP server (sensors + camera). Set ROVER_URL when starting.
      "/api/rover": {
        // Object form so bracketed IPv6 addresses (iPhone hotspot) work.
        target: (() => {
          const u = new URL(process.env.ROVER_URL ?? "http://127.0.0.1:8000");
          return { protocol: u.protocol, host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || 80) };
        })(),
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/rover/, ""),
      },
      "/api/agent": {
        target: process.env.AGENT_URL ?? "http://127.0.0.1:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/agent/, ""),
      },
    },
  },
});
