// Safe bridge between the renderer (UI) and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ha", {
  getState: () => ipcRenderer.invoke("get-state"),
  login: (creds) => ipcRenderer.invoke("login", creds),
  logout: () => ipcRenderer.invoke("logout"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  refreshCategories: () => ipcRenderer.invoke("refresh-categories"),
  startWatch: () => ipcRenderer.invoke("start-watch"),
  stopWatch: () => ipcRenderer.invoke("stop-watch"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  retryFailed: () => ipcRenderer.invoke("retry-failed"),
  setServer: (addr) => ipcRenderer.invoke("set-server", addr),
  onState: (cb) => ipcRenderer.on("state", (_e, s) => cb(s)),
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
});
