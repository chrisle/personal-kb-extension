import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  outfile: "dist/index.js",
  // Node built-ins are always available at runtime — don't bundle them
  external: [
    "node:*",
    "fs", "path", "os", "child_process", "util", "events",
    "stream", "buffer", "url", "crypto", "http", "https", "net",
  ],
  // Suppress esbuild's warning about CJS packages (xlsx ships CJS)
  logLevel: "info",
  // Inject a banner so Node.js ESM loader is happy with the output
  banner: {
    js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
  },
});
