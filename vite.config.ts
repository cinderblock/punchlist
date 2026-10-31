import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  define: {
    __APP_REVISION__: JSON.stringify(process.env.APP_REVISION ?? "dev"),
  },
  build: {
    // Browser code is minified, so an error report needs these to mean anything.
    // "hidden" leaves no pointer in the files; scripts/finalize-build.ts moves the
    // browser's maps to where only the server finds them.
    sourcemap: "hidden",
  },
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
