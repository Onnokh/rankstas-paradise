// Electron main process. It owns the window and the only network access: the
// renderer is sandboxed with no Node integration, so every read reaches the
// server through the IPC channels registered here (see ../preload/preload.ts).
//
// Failures are returned as `{ ok: false, message }` rather than thrown across
// IPC, because a rejected `invoke` reaches the renderer as an opaque
// "Error invoking remote method" string and the user would lose the real cause
// (a missing client.json, a 401, an unreachable host).
import { BrowserWindow, app, ipcMain, shell } from "electron"
import { join } from "node:path"

import { dashboard, history, sites, status, syncSite } from "./api.ts"
import { clientConfigPath } from "./config.ts"
import { favicon } from "./favicon.ts"

// The application's own name, which is not the same thing as the window title.
// `productName` in package.json covers a packaged build; this covers `electron .`,
// where Electron would otherwise fall back to the workspace name `@rp/desktop`
// and put the profile in `Application Support/@rp/desktop`.
//
// It must run before anything reads `app.getPath("userData")`, because that path
// is derived from the name and is resolved on first use.
app.setName("Ranksta’s Paradise")

// The window's assets sit next to this bundle in ./dist. They are resolved from
// `app.getAppPath()` (the package root) rather than `__dirname`, which the
// bundler rewrites to the *source* directory and would resolve to src/main.
const assets = () => join(app.getAppPath(), "dist")

export type IpcResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string }

const attempt = async <A>(work: () => Promise<A>): Promise<IpcResult<A>> => {
  try {
    return { ok: true, value: await work() }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
  }
}

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    title: "Ranksta’s Paradise",
    // The window paints its own chrome: the traffic lights sit inside the
    // sidebar's drag strip, which is why the sidebar reserves 46px at the top.
    backgroundColor: "#16181d",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(assets(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void window.loadFile(join(assets(), "index.html"))
  return window
}

ipcMain.handle("rp:sites", () => attempt(async () => (await sites()).sites))
ipcMain.handle("rp:dashboard", (_event, siteId: string) => attempt(() => dashboard(siteId)))
ipcMain.handle("rp:history", (_event, siteId: string, limit: number) =>
  attempt(() => history(siteId, limit)),
)
ipcMain.handle("rp:status", (_event, siteId: string) => attempt(() => status(siteId)))
ipcMain.handle("rp:sync", (_event, siteId: string, siteName: string) =>
  attempt(() => syncSite(siteId, siteName)),
)
// A site's own icon, read by the main process because the renderer's CSP allows
// no remote origins. Returns null rather than failing: a missing icon is
// cosmetic and the sidebar falls back to its dot.
ipcMain.handle("rp:favicon", (_event, origin: string) => favicon(origin))
ipcMain.handle("rp:config-path", () => clientConfigPath)
// Opening a tracked page belongs in the OS browser, matching the TUI's Enter
// key. Only http(s) is forwarded, so a malformed URL in the data cannot be used
// to launch an arbitrary handler.
ipcMain.handle("rp:open-external", (_event, url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  void shell.openExternal(parsed.toString())
  return true
})

void app.whenReady().then(() => {
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
