import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

const api = {
  listTasks: () => ipcRenderer.invoke("tasks:list"),
  createTask: (payload: any) => ipcRenderer.invoke("tasks:create", payload),
  updateTask: (payload: any) => ipcRenderer.invoke("tasks:update", payload),
  deleteTask: (id: number) => ipcRenderer.invoke("tasks:delete", id),
  finishTask: (id: number) => ipcRenderer.invoke("tasks:finish", id),
  dnfTask: (id: number) => ipcRenderer.invoke("tasks:dnf", id),
  getNextGp: () => ipcRenderer.invoke("f1:next"),
  listGp: () => ipcRenderer.invoke("f1:list"),
  calendarList: () => ipcRenderer.invoke("calendar:list"),
  calendarCreate: (payload: any) => ipcRenderer.invoke("calendar:create", payload),
  calendarDelete: (id: number) => ipcRenderer.invoke("calendar:delete", id),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore
  window.electron = electronAPI;
  // @ts-ignore
  window.api = api;
}
