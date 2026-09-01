// Bundle the three Electron entry points into ./dist with Bun's own bundler —
// no extra toolchain, and TypeScript straight to the runtime each entry point
// actually has. The main process and the preload script are emitted as
// CommonJS because Electron's sandboxed preload cannot be an ES module; the
// renderer is an ES module loaded by index.html.
//
// `electron` and the Node builtins stay external: they are provided by the
// Electron runtime, not by the bundle.
import { cp } from "node:fs/promises"

const root = new URL(".", import.meta.url).pathname
const outdir = `${root}dist`

const bundle = async (
  entrypoint: string,
  name: string,
  options: { readonly target: "node" | "browser"; readonly format: "cjs" | "esm" },
) => {
  const result = await Bun.build({
    entrypoints: [`${root}${entrypoint}`],
    outdir,
    naming: name,
    target: options.target,
    format: options.format,
    external: ["electron"],
    sourcemap: "linked",
    // React and Recharts branch on this at module scope; without it the bundle
    // keeps the development builds (slower, and noisy in the console).
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`Failed to bundle ${entrypoint}.`)
  }
}

await bundle("src/main/main.ts", "main.cjs", { target: "node", format: "cjs" })
await bundle("src/preload/preload.ts", "preload.cjs", { target: "node", format: "cjs" })
await bundle("src/renderer/main.tsx", "renderer.js", { target: "browser", format: "esm" })

// The window template and its stylesheet are served from the same directory as
// the bundles, so `loadFile(dist/index.html)` resolves both without a path map.
await cp(`${root}src/renderer/index.html`, `${outdir}/index.html`)
await cp(`${root}src/renderer/styles.css`, `${outdir}/styles.css`)

// The app icon ships beside the bundles for the same reason the template does:
// the main process resolves everything it loads from `app.getAppPath()/dist`.
await cp(`${root}assets/icon.png`, `${outdir}/icon.png`)

console.log(`Built the desktop bundles into ${outdir}.`)
