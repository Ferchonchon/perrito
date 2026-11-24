// Puente seguro para la pelota y el plato
const { contextBridge, ipcRenderer } = require('electron');
const CANALES = ['soltar', 'porciones', 'pantallas', 'datos'];

contextBridge.exposeInMainWorld('objeto', {
  pantallas: () => ipcRenderer.invoke('pantallas'),
  mover: (x, y) => ipcRenderer.send('mover', x, y),
  estado: p => ipcRenderer.send('pelota-estado', p),
  arrastrar: d => ipcRenderer.send('pelota-arrastre', d),
  fin: () => ipcRenderer.send('pelota-fin'),
  clic: tipo => ipcRenderer.send('objeto-clic', tipo),
  on: (canal, fn) => { if (CANALES.includes(canal)) ipcRenderer.on(canal, (_e, d) => fn(d)); }
});
