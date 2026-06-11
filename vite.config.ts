import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // getUserMedia requires a secure context; localhost counts as secure,
    // so no HTTPS config is needed for local dev.
  },
  build: {
    // three + the mediapipe runtime are large; raise the default warning limit.
    chunkSizeWarningLimit: 1600,
  },
});
