// The only bridge between the sandboxed renderer and the main process. It
// exposes a fixed set of named calls — never `ipcRenderer` itself — so the
// renderer can read the dashboard but cannot reach any other channel or Node API.
import { contextBridge, ipcRenderer } from "electron"

import type { DashboardSnapshot, HistoryReport, SitesResponse } from "@rp/api-client/schema"

import type { StatusWithFreshness } from "../main/api.ts"

import type { IpcResult } from "../main/main.ts"

export type Site = SitesResponse["sites"][number]

export interface RpBridge {
  readonly sites: () => Promise<IpcResult<readonly Site[]>>
  readonly dashboard: (siteId: string) => Promise<IpcResult<DashboardSnapshot>>
  readonly history: (siteId: string, limit: number) => Promise<IpcResult<HistoryReport>>
  readonly status: (siteId: string) => Promise<IpcResult<StatusWithFreshness>>
  readonly sync: (siteId: string, siteName: string) => Promise<IpcResult<string>>
  readonly configPath: () => Promise<string>
  readonly openExternal: (url: string) => Promise<boolean>
}

const bridge: RpBridge = {
  sites: () => ipcRenderer.invoke("rp:sites"),
  dashboard: (siteId) => ipcRenderer.invoke("rp:dashboard", siteId),
  history: (siteId, limit) => ipcRenderer.invoke("rp:history", siteId, limit),
  status: (siteId) => ipcRenderer.invoke("rp:status", siteId),
  sync: (siteId, siteName) => ipcRenderer.invoke("rp:sync", siteId, siteName),
  configPath: () => ipcRenderer.invoke("rp:config-path"),
  openExternal: (url) => ipcRenderer.invoke("rp:open-external", url),
}

contextBridge.exposeInMainWorld("rp", bridge)
