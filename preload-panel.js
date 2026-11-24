// Puente seguro para la ventana de chat, pendientes, memoria y ajustes
const { contextBridge, ipcRenderer } = require('electron');
const CANALES = ['pestana', 'datos-actualizados'];

contextBridge.exposeInMainWorld('panel', {
  config: () => ipcRenderer.invoke('config'),
  guardar: d => ipcRenderer.invoke('guardar-config', d),
  datos: () => ipcRenderer.invoke('datos'),
  recuerdos: () => ipcRenderer.invoke('recuerdos'),
  nuevoRecordatorio: d => ipcRenderer.invoke('recordatorio-nuevo', d),
  borrarRecordatorio: id => ipcRenderer.invoke('recordatorio-borrar', id),
  nuevaMemoria: t => ipcRenderer.invoke('memoria-nueva', t),
  borrarMemoria: i => ipcRenderer.invoke('memoria-borrar', i),
  historial: () => ipcRenderer.invoke('chat-historial'),
  chat: m => ipcRenderer.invoke('chat', m),
  cerrar: () => ipcRenderer.send('cerrar-panel'),
  on: (canal, fn) => { if (CANALES.includes(canal)) ipcRenderer.on(canal, (_e, d) => fn(d)); }
});
