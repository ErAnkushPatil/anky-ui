import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume the library source directly so edits in packages/core hot-reload without a build.
    alias: {
      "@erankushpatil/anky-ui": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
});
