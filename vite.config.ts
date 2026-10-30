import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    // Vite 8 resolves tsconfig `paths` natively.
    tsconfigPaths: true,
  },
  server: {
    port: Number(process.env.PORT ?? 3000),
  },
  ssr: {
    // src/ holds runtime-only server modules. Externalizing bun:sqlite keeps it
    // out of the SSR bundle; the runtime provides it.
    external: ["bun:sqlite"],
  },
});
