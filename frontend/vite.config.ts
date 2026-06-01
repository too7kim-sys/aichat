import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Set DEV_HTTPS=1 in .env (or shell) to serve the dev server over a
// self-signed HTTPS cert. This unlocks Web APIs that require a secure
// context (File System Access, clipboard write, ...) when other
// machines on the LAN access this host by IP.
//
//   DEV_HTTPS=1 npm run dev
//
// The first visit each client gets a "Not secure" warning from the
// browser — click through it once and the cert is cached.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const useHttps = env.DEV_HTTPS === "1" || env.DEV_HTTPS === "true";

  return {
    plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
    server: {
      host: true,
      port: 5173,
      proxy: {
        "/api": {
          target: "http://localhost:9000",
          changeOrigin: true,
        },
      },
    },
  };
});
