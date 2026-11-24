// Puente seguro para la ventana de cada perrito
const { contextBridge, ipcRenderer } = require('electron');
const CANALES = ['tick', 'pantallas', 'aviso', 'pomodoro', 'config', 'dormir', 'reaccion',
                 'clima', 'te-invitan', 'despedida', 'truco', 'pasear', 'seguir', 'fin-actividad', 'pedir-paseo', 'hora-comida', 'bienvenida', 'a-la-cama', 'regalo-recibido',
                 'cuerda', 'escondidas', 'banar', 'hueso', 'galleta', 'salir', 'celos'];

contextBridge.exposeInMainWorld('mascota', {
  pantallas: () => ipcRenderer.invoke('pantallas'),
  config: () => ipcRenderer.invoke('config'),
  clima: () => ipcRenderer.invoke('clima'),
  mover: (x, y) => ipcRenderer.send('mover', x, y),
  ignorar: v => ipcRenderer.send('ignorar', v),
  reporte: r => ipcRenderer.send('reporte', r),
  menu: () => ipcRenderer.send('menu'),
  abrirPanel: p => ipcRenderer.send('abrir-panel', p),
  jugarCon: () => ipcRenderer.send('jugar-con'),
  agarrarPelota: () => ipcRenderer.invoke('agarrar-pelota'),
  soltarPelota: p => ipcRenderer.send('soltar-pelota', p),
  comer: () => ipcRenderer.invoke('comer'),
  beber: () => ipcRenderer.invoke('beber'),
  evento: ev => ipcRenderer.send('evento', ev),
  pedirPasear: () => ipcRenderer.send('pedir-pasear'),
  pedirComida: () => ipcRenderer.send('pedir-comida'),
  dejarRegalo: d => ipcRenderer.invoke('dejar-regalo', d),
  meVoyADormir: () => ipcRenderer.send('me-voy-a-dormir'),
  on: (canal, fn) => { if (CANALES.includes(canal)) ipcRenderer.on(canal, (_e, d) => fn(d)); }
});
