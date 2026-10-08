import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "LOCAL_APP_");
  const localAppPort =
    process.env.LOCAL_APP_PORT ?? environment.LOCAL_APP_PORT ?? "3000";
  return {
    root: "ui",
    plugins: [react()],
    build: { outDir: "dist", emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        // Preserve the browser Host so the API's same-origin command check also
        // applies during local Vite development. Cookies remain HttpOnly.
        "/api": { target: `http://127.0.0.1:${localAppPort}`, changeOrigin: false },
      },
    },
  };
});
