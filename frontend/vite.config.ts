import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to all interfaces so other machines on the LAN can reach the
    // dev server at http://<your-ip>:5173. The /api proxy still targets
    // localhost:9000 on the machine running Vite, so the backend stays
    // private to this host.
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:9000",
    },
  },
});
