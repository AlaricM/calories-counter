import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Static SPA served from S3 behind CloudFront. The chat backend URL is NOT baked
// in at build time — it's read at runtime from /config.json, which CDK writes at
// deploy (see lib/food-tracker-stack.ts). That keeps this bundle deploy-agnostic.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist" },
});
