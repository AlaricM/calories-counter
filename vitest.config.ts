import { defineConfig } from "vitest/config";

// Backend unit tests only (the React app has its own Vite toolchain). Tests live
// next to the code they cover under lambda/**.
export default defineConfig({
  test: {
    include: ["lambda/**/*.test.ts"],
  },
});
