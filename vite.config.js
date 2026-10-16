import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  assetsInclude: ["**/*.ttf"],
  build: { target: "es2022", chunkSizeWarningLimit: 3000 },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
