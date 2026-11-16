import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  envDir: "..",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
  server: { port: 5207, host: true },
});
