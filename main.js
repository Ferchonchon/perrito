// =====================================================================
// PROCESO PRINCIPAL: ventanas, pantallas, objetos, clima, asistente e IA
// =====================================================================
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, powerMonitor, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { iniciarVentanas, calcularRepisas } = require('./ventanas');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* sin actualizaciones automáticas */ }

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {

const W = 300, H = 290;                       // ventana de cada perrito (con espacio para el globito)
const PELOTA = 64;                            // ventana de la pelota (con margen para agarrarla)
const PLATO_W = 80, PLATO_H = 44;             // ventana del plato
const TRABAJO = 25 * 60e3, DESCANSO = 5 * 60e3;
// Cuánto sube cada medidor por minuto (0 a 100)
const RITMO = {
  hambre:   1 / 3,     // 100 en ~5 horas
  sed:      1 / 2,     // 100 en ~3 horas
  suciedad: 1 / 30,    // poco a poco; sube más al pasear con lluvia
  desalino: 1 / 20,    // pelo despeinado si no las cepillas (~1 día)
  peso:    -1 / 120    // las galletas suben el peso; baja solito despacio
};
const INICIAL = { hambre: 20, sed: 20, suciedad: 10, desalino: 10, peso: 0 };
const MINUTOS_SALIDA = 210;                   // cada ~3.5 h quieren salir al baño

const PERROS = {
  chispa:   { raza: 'labrador' },
  pimienta: { raza: 'schnauzer' }
};

// ---------------- Configuración guardada ----------------
const DEFAULT = {
  nombre: 'Chispa',
  nombreAmigo: 'Pimienta',
  dueno: 'Fernando',
  amigo: true,
  modelo: 'deepseek-flash',
  sonido: true,
  aguaCadaMin: 60,
  inactividadMin: 2,
  accesorio: 'auto',
  ciudad: 'Zapopan',
  lat: 20.72, lon: -103.39,
  apiKey: '', apiKeyCifrada: false,
  recordatorios: [],
  memoria: [],
  hambre: {},
  medidores: {},
  stats: {},
  minutosJuntos: 0,
  cumpleNala: '',          // "DD/MM"
  cumpleDona: '',
  necesidades: true,       // que pidan salir al baño
  tamano: 1,               // 1 = normal, 0.8 = medianas, 0.65 = chiquitas
  reaccionesHora: true,    // bostezos en la tarde, paseo en la mañana, hora de comida
  horaComida: '14:00',     // tu hora de comida
  ultimoPaseoPedido: '', ultimaComidaCelebrada: '',
  ultimaVez: 0,            // la última vez que usaste la compu (para recibirte cuando vuelves)
  casita: true,            // camita y bebedero en la pantalla
  comentariosMin: 60,       // cada cuánto Nala te dice algo con IA (0 = nunca)
  resumenManana: true,      // saludo con pendientes y clima la primera vez del día
  ultimoResumen: ''
};
let config;
const rutaConfig = () => path.join(app.getPath('userData'), 'config.json');

function cargarConfig() {
  try { config = { ...DEFAULT, ...JSON.parse(fs.readFileSync(rutaConfig(), 'utf8')) }; }
  catch { config = { ...DEFAULT }; }
  for (const id of Object.keys(PERROS)) {
    config.medidores[id] = config.medidores[id] || {};
    if (config.hambre[id] && !config.medidores[id].hambre) config.medidores[id].hambre = config.hambre[id];
    if (!config.medidores[id].salida) config.medidores[id].salida = Date.now();
    config.stats[id] = { caricias: 0, pelota: 0, hueso: 0, cuerda: 0, laser: 0, paseos: 0, trucos: 0, galletas: 0, banos: 0, ...(config.stats[id] || {}) };
  }
}
function guardarConfig() {
  fs.mkdirSync(path.dirname(rutaConfig()), { recursive: true });
  fs.writeFileSync(rutaConfig(), JSON.stringify(config, null, 2));
}
function leerApiKey() {
  if (!config.apiKey) return '';
  try {
    return config.apiKeyCifrada ? safeStorage.decryptString(Buffer.from(config.apiKey, 'base64')) : config.apiKey;
  } catch { return ''; }
}
function guardarApiKey(clave) {
  if (safeStorage.isEncryptionAvailable()) {
    config.apiKey = safeStorage.encryptString(clave).toString('base64'); config.apiKeyCifrada = true;
  } else { config.apiKey = clave; config.apiKeyCifrada = false; }
}
function configPublica() {
  const { apiKey, apiKeyCifrada, hambre, medidores, ...resto } = config;
  return { ...resto, tieneApiKey: !!apiKey };
}
const limitar = v => Math.max(0, Math.min(100, v));
function medidor(id, nombre) {
  const m = config.medidores[id][nombre] || (config.medidores[id][nombre] = { valor: INICIAL[nombre], ts: Date.now() });
  return limitar(m.valor + (Date.now() - m.ts) / 60e3 * RITMO[nombre]);
}
function fijarMedidor(id, nombre, valor) {
  config.medidores[id][nombre] = { valor: limitar(valor), ts: Date.now() };
  guardarConfig();
}
const hambreDe = id => medidor(id, 'hambre');
const necesitaSalir = id => config.necesidades && (Date.now() - config.medidores[id].salida) / 60e3 > MINUTOS_SALIDA;
function juguetePreferido(id) {
  const s = config.stats[id];
  const opciones = { pelota: s.pelota, hueso: s.hueso, cuerda: s.cuerda, laser: s.laser };
  const [nombre, veces] = Object.entries(opciones).sort((a, b) => b[1] - a[1])[0];
  return veces > 0 ? nombre : null;
}
function hoyEsCumple(id) {
  const c = id === 'chispa' ? config.cumpleNala : config.cumpleDona;
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(c || '').trim());
  if (!m) return false;
  const d = new Date();
  return d.getDate() === Number(m[1]) && d.getMonth() + 1 === Number(m[2]);
}

// ---------------- Estado general ----------------
const perros = {};                 // id -> BrowserWindow
const reportes = {};               // id -> { estado, dir, x, y }
let panel = null, pelotaWin = null, platoWin = null;
let pelota = null;                 // { x, y, vx, vy, enSuelo, portador, lanzadaHasta }
let plato = null;                  // { x, y, porciones }
let aguaWin = null, agua = null;   // bebedero { x, y, nivel }
let camaWin = null, cama = null;   // camita { x, y }
let charcoWin = null, charco = null;
let laserWin = null, laserTimer = null, laserFin = 0;
let actividad = null;              // juego en conjunto: { tipo, ... }
const caricias = {};               // para los celos
let pomodoro = null;
let clima = null;                  // { lluvia, temp, codigo }
let repisas = [];
let ultimoAgua = Date.now();
let historialChat = [];
let tray = null, ocultos = false, actualizacionLista = null;
const MAC = process.platform === 'darwin';
// En Mac: que las ventanas floten sobre todos los escritorios y sobre apps en pantalla completa
const flotar = w => { if (MAC) { try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch {} } return w; };
let ultimoComentario = Date.now(), comentariosRecientes = [], pidiendoComentario = false;

const pantallas = () => screen.getAllDisplays().map(d => d.workArea);
const vivos = () => Object.entries(perros).filter(([, w]) => w && !w.isDestroyed());
const enviarA = (id, canal, datos) => { const w = perros[id]; if (w && !w.isDestroyed()) w.webContents.send(canal, datos); };
const enviarTodos = (canal, datos) => vivos().forEach(([, w]) => w.webContents.send(canal, datos));
const aviso = (texto, extra = {}) => enviarA('chispa', 'aviso', { texto, ...extra });
const azar = arr => arr[Math.floor(Math.random() * arr.length)];
const opcionesInicio = () => app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(app.getAppPath())] };
const idDe = e => Object.keys(perros).find(id => perros[id] && !perros[id].isDestroyed() && perros[id].webContents === e.sender);

// ---------------- Ventanas de los perritos ----------------
function crearPerro(id) {
  if (perros[id] && !perros[id].isDestroyed()) return;
  const a = screen.getPrimaryDisplay().workArea;
  const desfase = id === 'chispa' ? 0 : 220;
  const w = new BrowserWindow({
    width: W, height: H,
    x: Math.round(a.x + a.width / 2 - W / 2 + desfase), y: a.y + a.height - H,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  w.setIgnoreMouseEvents(true, { forward: true });
  w.setAlwaysOnTop(true, 'pop-up-menu');                   // encima de la camita y el bebedero
  flotar(w);
  w.loadFile('index.html', { query: { id, raza: PERROS[id].raza } });
  w.on('closed', () => { delete perros[id]; delete reportes[id]; });
  perros[id] = w;
}
function despedirAmigo() {
  config.amigo = false; guardarConfig();
  enviarA('pimienta', 'despedida');
  setTimeout(() => { if (perros.pimienta && !perros.pimienta.isDestroyed()) perros.pimienta.close(); }, 1500);
}
function traerAmigo() { config.amigo = true; guardarConfig(); crearPerro('pimienta'); }

// ---------------- Pelota ----------------
function crearObjeto(archivo, ancho, alto, x, y, clicsAtraviesan) {
  const w = new BrowserWindow({
    width: ancho, height: alto, x: Math.round(x), y: Math.round(y),
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-objeto.js'), backgroundThrottling: false }
  });
  if (clicsAtraviesan) w.setIgnoreMouseEvents(true);
  flotar(w);
  w.loadFile(archivo);
  w.once('ready-to-show', () => w.showInactive());
  return w;
}
function sacarPelota() {
  if (pelotaWin && !pelotaWin.isDestroyed()) return;
  const b = perros.chispa.getBounds();
  const x = b.x + W / 2 + 60, y = b.y + 40;
  pelota = { x: x + PELOTA / 2, y: y + PELOTA / 2, vx: 0, vy: 0, enSuelo: false, portador: null, lanzadaHasta: Date.now() + 6000,
             lanzadoPor: 'usuario', rondas: 0 };
  pelotaWin = crearObjeto('pelota.html', PELOTA, PELOTA, x, y, false);
  pelotaWin.setFocusable(true);
  pelotaWin.setAlwaysOnTop(true, 'screen-saver');         // siempre encima de los perritos para poder agarrarla
  pelotaWin.on('closed', () => { pelotaWin = null; pelota = null; });
  aviso('¡La pelota! ¡Aviéntala! 🎾', { ladrar: true });
}
function guardarPelota() { if (pelotaWin && !pelotaWin.isDestroyed()) pelotaWin.close(); }

// ---------------- Plato ----------------
function servirComida() {
  if (platoWin && !platoWin.isDestroyed()) { aviso('Todavía hay comida en el plato 🍖'); return; }
  const b = perros.chispa.getBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x + W / 2, y: b.y + H / 2 }).workArea;
  let cx = b.x + W / 2 + (Math.random() < 0.5 ? -150 : 150);
  cx = Math.min(Math.max(cx, d.x + 60), d.x + d.width - 60);
  const porciones = vivos().length;
  plato = { x: cx, y: d.y + d.height, porciones, total: porciones };
  platoWin = crearObjeto('plato.html', PLATO_W, PLATO_H, cx - PLATO_W / 2, d.y + d.height - PLATO_H, true);
  if (ocultos) platoWin.hide();
  platoWin.on('closed', () => { platoWin = null; plato = null; });
  platoWin.webContents.once('did-finish-load', () => platoWin.webContents.send('porciones', { porciones, total: porciones }));
}

// ---------------- Casita: camita y bebedero ----------------
const OBJ = { agua: [70, 40], cama: [250, 64], charco: [70, 26], laser: [24, 24], regalo: [46, 34] };
function crearCosa(tipo, x, y, clicsAtraviesan, extra = {}) {
  const [w, h] = OBJ[tipo];
  const win = new BrowserWindow({
    width: w, height: h, x: Math.round(x), y: Math.round(y),
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-objeto.js'), backgroundThrottling: false }
  });
  if (clicsAtraviesan) win.setIgnoreMouseEvents(true);
  flotar(win);
  win.loadFile('objeto.html', { query: { tipo, ...extra } });
  win.once('ready-to-show', () => { win.showInactive(); if (ocultos) win.hide(); });
  return win;
}
function decoracion() {
  const m = new Date().getMonth() + 1;
  if (hoyEsCumple('chispa') || hoyEsCumple('pimienta')) return 'pastel';
  if (m === 10) return 'calabaza';
  if (m === 12) return 'regalo';
  return null;
}
function crearCasita() {
  if (!config.casita) return;
  const d = screen.getPrimaryDisplay().workArea;
  const piso = d.y + d.height;
  if (!aguaWin || aguaWin.isDestroyed()) {
    agua = { x: d.x + 90, y: piso, nivel: agua ? agua.nivel : 100 };
    aguaWin = crearCosa('agua', agua.x - OBJ.agua[0] / 2, piso - OBJ.agua[1], false);
    aguaWin.webContents.on('did-finish-load', () => aguaWin.webContents.send('datos', { nivel: agua.nivel }));
    aguaWin.on('closed', () => { aguaWin = null; agua = null; });
  }
  if (!camaWin || camaWin.isDestroyed()) {
    cama = { x: d.x + d.width - 190, y: piso };
    camaWin = crearCosa('cama', cama.x - 95, piso - OBJ.cama[1], true);
    camaWin.webContents.on('did-finish-load', () => camaWin.webContents.send('datos', { decoracion: decoracion() }));
    camaWin.on('closed', () => { camaWin = null; cama = null; });
  }
}
function quitarCasita() {
  [aguaWin, camaWin].forEach(w => w && !w.isDestroyed() && w.close());
}
function llenarAgua() {
  if (!agua) { crearCasita(); return; }
  agua.nivel = 100;
  if (aguaWin) aguaWin.webContents.send('datos', { nivel: 100 });
  aviso('¡Agua fresca! 💧');
}
function crearCharco(x) {
  if (charcoWin && !charcoWin.isDestroyed()) return;
  const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: 0 }).workArea;
  charco = { x, y: d.y + d.height };
  charcoWin = crearCosa('charco', x - OBJ.charco[0] / 2, d.y + d.height - OBJ.charco[1], false);
  charcoWin.on('closed', () => { charcoWin = null; charco = null; });
}

// ---------------- Regalos que te traen 🎁 ----------------
let regaloWin = null, regalo = null;
const REGALOS = ['hoja', 'palito', 'flor', 'hoja', 'flor'];
function crearRegalo(xPantalla, item = REGALOS[Math.floor(Math.random() * REGALOS.length)], quien = 'chispa') {
  if (regaloWin && !regaloWin.isDestroyed()) return false;
  const d = screen.getDisplayNearestPoint({ x: Math.round(xPantalla), y: 0 }).workArea;
  const x = Math.min(Math.max(xPantalla, d.x + 30), d.x + d.width - 30);
  regalo = { x, y: d.y + d.height, item, quien };
  regaloWin = crearCosa('regalo', x - OBJ.regalo[0] / 2, d.y + d.height - OBJ.regalo[1], false, { item });
  regaloWin.on('closed', () => { regaloWin = null; regalo = null; });
  setTimeout(() => { if (regaloWin && !regaloWin.isDestroyed()) regaloWin.close(); }, 15 * 60e3);   // si no lo recoges, se lo lleva el viento
  config.stats[quien].regalos = (config.stats[quien].regalos || 0) + 1; guardarConfig();
  return true;
}

// ---------------- Cuando vuelves: te reciben y te cuentan qué hicieron ----------------
function notaAusencia(min) {
  if (min < 20) return null;
  const amiga = perros.pimienta && !perros.pimienta.isDestroyed();
  const N = config.nombre, D = config.nombreAmigo;
  const quien = () => amiga && Math.random() < 0.5 ? D : 'yo';
  const opciones = [
    () => `tomamos una siesta 😴`,
    () => (q => q === 'yo' ? 'perseguí una mariposa 🦋' : `${q} persiguió una mariposa 🦋`)(quien()),
    () => (q => q === 'yo' ? 'le ladré a una hoja 🍂' : `${q} le ladró a una hoja 🍂`)(quien()),
    () => `te cuidamos la compu 🐾`,
    () => `estuvimos viendo por la ventana 👀`
  ];
  if (amiga) opciones.push(() => Math.random() < 0.5 ? `jugamos a la cuerda y ${D} me ganó 😤` : `jugamos a la cuerda y le gané a ${D} 💪`);
  if (amiga) opciones.push(() => `${D} y yo nos pasamos la pelota 🎾`);
  const cuantas = Math.min(3, 1 + Math.floor(min / 60));
  const elegidas = [];
  while (elegidas.length < cuantas && opciones.length) elegidas.push(opciones.splice(Math.floor(Math.random() * opciones.length), 1)[0]());
  let regaloTraido = false;
  if (min >= 60 && Math.random() < 0.7) {                              // y a veces te dejaron un regalito
    const c = screen.getCursorScreenPoint();
    regaloTraido = crearRegalo(c.x + 60);
    if (regaloTraido) elegidas.push('te traje un regalito 🎁');
  }
  const lista = elegidas.length > 1 ? elegidas.slice(0, -1).join(', ') + ' y ' + elegidas[elegidas.length - 1] : elegidas[0];
  return `Mientras no estabas: ${lista}.`;
}
function bienvenida(min) {
  if (min < 3 || ocultos) return;
  enviarTodos('bienvenida', { min, nota: notaAusencia(min) });
}
let ausenteDesde = null;

// ---------------- Juegos ----------------
function laser(activar = !laserWin) {
  if (!activar) {
    clearInterval(laserTimer);
    if (laserWin && !laserWin.isDestroyed()) laserWin.close();
    laserWin = null; return;
  }
  if (laserWin) return;
  const c = screen.getCursorScreenPoint();
  laserWin = crearCosa('laser', c.x - 12, c.y - 12, true);
  laserWin.setAlwaysOnTop(true, 'screen-saver');
  laserWin.on('closed', () => { laserWin = null; clearInterval(laserTimer); });
  laserFin = Date.now() + 30000;
  laserTimer = setInterval(() => {
    if (!laserWin || laserWin.isDestroyed()) return;
    if (Date.now() > laserFin) return laser(false);
    const p = screen.getCursorScreenPoint();
    laserWin.setBounds({ x: p.x - 12, y: p.y - 12, width: 24, height: 24 });
  }, 16);
  vivos().forEach(([id]) => { config.stats[id].laser++; });
  guardarConfig();
}
const centro = id => { const b = perros[id].getBounds(); return b.x + W / 2; };
function pasear() {
  const ps = pantallas();
  const izq = Math.min(...ps.map(p => p.x)) + 120, der = Math.max(...ps.map(p => p.x + p.width)) - 120;
  enviarA('chispa', 'pasear', { izq, der, regreso: centro('chispa') });
  enviarA('pimienta', 'seguir', 'chispa');
  aviso('¡Vamos a pasear! 🐾', { ladrar: true });
}
function cuerda() {
  if (!perros.pimienta) { aviso(`Necesito a ${config.nombreAmigo} para jugar a la cuerda 🪢`); return; }
  const medio = (centro('chispa') + centro('pimienta')) / 2;
  const ganadora = Math.random() < 0.5 ? 'chispa' : 'pimienta';
  enviarTodos('cuerda', { medio, inicio: Date.now(), ganadora, fin: Date.now() + 16000 });
  vivos().forEach(([id]) => { config.stats[id].cuerda++; }); guardarConfig();
}
function escondidas() {
  if (!perros.pimienta) { aviso(`Necesito a ${config.nombreAmigo} para jugar a las escondidas 🙈`); return; }
  const [esconde, busca] = Math.random() < 0.5 ? ['chispa', 'pimienta'] : ['pimienta', 'chispa'];
  const ps = pantallas();
  const destino = Math.random() < 0.5
    ? Math.min(...ps.map(p => p.x)) + 2
    : Math.max(...ps.map(p => p.x + p.width)) - 2;
  enviarA(esconde, 'escondidas', { rol: 'esconder', destino });
  enviarA(busca, 'escondidas', { rol: 'buscar', amiga: esconde });
}
function truco(quien, cual) {
  const ids = quien === 'ambas' ? vivos().map(([id]) => id) : [quien === 'dona' ? 'pimienta' : 'chispa'];
  ids.forEach(id => enviarA(id, 'truco', cual));
}
const TRUCOS = [['sentarse', 'Sentarse'], ['pata', 'Dar la pata'], ['muertita', 'Hacerse la muertita'],
                ['girar', 'Dar una vuelta'], ['saltar', 'Saltar'], ['hablar', 'Ladrar'], ['rodar', 'Rodar']];

// ---------------- Panel (chat, pendientes, memoria, ajustes) ----------------
function abrirPanel(pestana = 'chat') {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); panel.webContents.send('pestana', pestana); return; }
  const [wx, wy] = perros.chispa.getPosition();
  const d = screen.getDisplayNearestPoint({ x: wx + W / 2, y: wy + H / 2 }).workArea;
  const PW = 380, PH = 560;
  const px = Math.min(Math.max(wx + W / 2 - PW / 2, d.x), d.x + d.width - PW);
  const py = Math.max(d.y, wy + 100 - PH);
  panel = new BrowserWindow({
    width: PW, height: PH, x: Math.round(px), y: Math.round(py),
    frame: false, alwaysOnTop: true, resizable: false, backgroundColor: '#1d1b1a', title: config.nombre,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload-panel.js') }
  });
  panel.setAlwaysOnTop(true, 'pop-up-menu');
  panel.loadFile('panel.html', { query: { pestana } });
}
const avisarPanel = () => {
  if (panel && !panel.isDestroyed()) panel.webContents.send('datos-actualizados', { recordatorios: config.recordatorios, memoria: config.memoria });
};

// ---------------- Asistente con DeepSeek ----------------
function fechaLocal(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function agregarRecordatorio(texto, cuando) {
  const r = { id: Date.now() + Math.floor(Math.random() * 1000), texto: String(texto).slice(0, 140), cuando };
  config.recordatorios.push(r);
  config.recordatorios.sort((a, b) => a.cuando - b.cuando);
  return r;
}
function describirHora(ms) {
  const d = new Date(ms), hoy = new Date();
  const hora = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === hoy.toDateString()) return `hoy a las ${hora}`;
  const manana = new Date(); manana.setDate(hoy.getDate() + 1);
  if (d.toDateString() === manana.toDateString()) return `mañana a las ${hora}`;
  return `el ${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} a las ${hora}`;
}

async function platicar(mensaje) {
  const clave = leerApiKey();
  if (!clave) return { error: 'Me falta tu API key de DeepSeek. Pégala en la pestaña Ajustes. 🐾' };

  historialChat.push({ role: 'user', content: mensaje });
  const ahora = new Date();
  const memoria = config.memoria.length
    ? config.memoria.map((m, i) => `${i}. ${m.texto}`).join('\n') : '(vacía)';
  const pendientes = config.recordatorios.length
    ? config.recordatorios.map(r => `id ${r.id}: "${r.texto}" ${describirHora(r.cuando)}`).join('\n') : '(ninguno)';

  const sistema =
`Eres ${config.nombre}, un perrito de escritorio negro con el pecho café que vive en la computadora de ${config.dueno || 'tu dueño'}. Tu amigo es ${config.nombreAmigo}, un schnauzer sal y pimienta.
Eres su asistente personal sencillo: platicas con cariño y humor de perro (a veces "¡guau!"), siempre en español, en máximo 2 o 3 frases cortas. Ayudas de verdad cuando te piden algo.

Hoy es ${DIAS[ahora.getDay()]} y la fecha y hora local es ${fechaLocal(ahora)}.

Lo que recuerdas (solo cosas importantes):
${memoria}

Recordatorios pendientes:
${pendientes}

Reglas de memoria: guarda solo datos realmente importantes y duraderos (cumpleaños, fechas clave, pendientes importantes, preferencias o datos que te pidan recordar). NO guardes la plática normal, saludos, ni cosas pasajeras. No repitas lo que ya recuerdas. Si te piden olvidar algo, usa "olvidar".
Reglas de recordatorios: si te piden que les recuerdes algo en un momento, crea un recordatorio con fecha y hora local exacta en formato AAAA-MM-DDTHH:MM, siempre en el futuro. Si no dicen hora para un día, usa las 9:00. Si piden cancelar uno, usa su id en "cancelar".

Trucos: si te piden un truco (a ti, a ${config.nombreAmigo} o a las dos), hazlo poniendo "truco". Trucos que saben: sentarse, pata, muertita, girar, saltar, hablar, rodar. "quien" es "nala", "dona" o "ambas".

Responde SIEMPRE en JSON válido con esta forma exacta:
{"respuesta": "texto para decirle", "recordar": ["dato importante"], "olvidar": [número de la lista], "recordatorios": [{"texto": "qué recordar", "cuando": "AAAA-MM-DDTHH:MM"}], "cancelar": [id], "truco": {"quien": "nala", "cual": "pata"} o null}
Usa listas vacías cuando no aplique.`;

  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clave}` },
      body: JSON.stringify({
        model: config.modelo,
        messages: [{ role: 'system', content: sistema }, ...historialChat.slice(-12)],
        response_format: { type: 'json_object' },
        max_tokens: 1500,
        stream: false
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { historialChat.pop(); return { error: data?.error?.message || `DeepSeek respondió con error ${r.status}` }; }

    const crudo = (data.choices?.[0]?.message?.content || '').trim();
    let res;
    try { res = JSON.parse(crudo.replace(/^```json|```$/g, '').trim()); }
    catch { res = { respuesta: crudo }; }

    const acciones = [];
    // Olvidar (de mayor a menor para no mover los números)
    const olvidar = (Array.isArray(res.olvidar) ? res.olvidar : []).map(Number)
      .filter(i => Number.isInteger(i) && i >= 0 && i < config.memoria.length).sort((a, b) => b - a);
    for (const i of olvidar) acciones.push('Olvidé: ' + config.memoria.splice(i, 1)[0].texto);
    // Recordar
    for (const t of (Array.isArray(res.recordar) ? res.recordar : []).slice(0, 3)) {
      const texto = String(t).trim().slice(0, 200);
      if (texto && !config.memoria.some(m => m.texto.toLowerCase() === texto.toLowerCase())) {
        config.memoria.push({ texto, fecha: fechaLocal() });
        acciones.push('Lo guardé en mi memoria: ' + texto);
      }
    }
    config.memoria = config.memoria.slice(-50);
    // Cancelar recordatorios
    for (const id of (Array.isArray(res.cancelar) ? res.cancelar : [])) {
      const antes = config.recordatorios.length;
      config.recordatorios = config.recordatorios.filter(x => x.id !== Number(id));
      if (config.recordatorios.length < antes) acciones.push('Cancelé un recordatorio');
    }
    // Nuevos recordatorios
    for (const rec of (Array.isArray(res.recordatorios) ? res.recordatorios : []).slice(0, 3)) {
      const cuando = new Date(String(rec.cuando || '')).getTime();
      if (rec.texto && Number.isFinite(cuando) && cuando > Date.now() - 60e3) {
        const nuevo = agregarRecordatorio(rec.texto, Math.max(cuando, Date.now() + 30e3));
        acciones.push(`Recordatorio: "${nuevo.texto}" ${describirHora(nuevo.cuando)}`);
      }
    }
    if (acciones.length) { guardarConfig(); avisarPanel(); }
    if (res.truco && res.truco.cual && TRUCOS.some(([t]) => t === res.truco.cual)) {
      setTimeout(() => truco(String(res.truco.quien || 'nala').toLowerCase(), res.truco.cual), 1200);
    }

    const texto = String(res.respuesta || '').trim() || '¡Guau!';
    historialChat.push({ role: 'assistant', content: texto });
    historialChat = historialChat.slice(-30);
    if (!(res.truco && res.truco.cual)) enviarA('chispa', 'reaccion', { texto });
    else enviarA('chispa', 'aviso', { texto, ms: 4000 });
    return { texto, acciones };
  } catch (e) {
    historialChat.pop();
    return { error: 'No pude conectarme a internet: ' + e.message };
  }
}

// ---------------- Comentarios espontáneos con IA ----------------
const hoyTexto = () => fechaLocal().slice(0, 10);
async function comentarioIA(tipo = 'espontaneo') {
  const clave = leerApiKey();
  if (!clave || pidiendoComentario) return false;
  pidiendoComentario = true;
  const ahora = new Date();
  const hoy = config.recordatorios.filter(r => new Date(r.cuando).toDateString() === ahora.toDateString());
  const contexto =
`Fecha y hora: ${DIAS[ahora.getDay()]} ${fechaLocal(ahora)}.
Clima en ${config.ciudad}: ${clima ? `${Math.round(clima.temp)}°C${clima.lluvia ? ', lloviendo' : ''}` : 'desconocido'}.
Hambre de ${config.nombre}: ${Math.round(hambreDe('chispa'))}/100. ${perros.pimienta ? `Hambre de ${config.nombreAmigo}: ${Math.round(hambreDe('pimienta'))}/100.` : ''}
Pendientes de hoy: ${hoy.length ? hoy.map(r => `"${r.texto}" a las ${new Date(r.cuando).getHours()}:${String(new Date(r.cuando).getMinutes()).padStart(2, '0')}`).join('; ') : 'ninguno'}.
Lo que recuerdas de ${config.dueno || 'tu dueño'}: ${config.memoria.length ? config.memoria.map(m => m.texto).join('; ') : 'nada aún'}.
Tus recuerdos: llevan ${Math.round(config.minutosJuntos / 60)} horas juntos; te ha hecho ${config.stats.chispa.caricias} caricias; tu juguete favorito: ${juguetePreferido('chispa') || 'todavía ninguno'}; sed ${Math.round(medidor('chispa', 'sed'))}/100; suciedad ${Math.round(medidor('chispa', 'suciedad'))}/100.${hoyEsCumple('chispa') ? ' ¡HOY ES TU CUMPLEAÑOS!' : ''}${hoyEsCumple('pimienta') ? ` ¡Hoy es el cumpleaños de ${config.nombreAmigo}!` : ''}
Tus últimos comentarios (no los repitas): ${comentariosRecientes.join(' | ') || 'ninguno'}.`;

  const instruccion = tipo === 'manana'
    ? `Es la primera vez que ${config.dueno || 'tu dueño'} usa la compu hoy. Salúdalo según la hora, dile sus pendientes de hoy (si hay) y el clima, en máximo 35 palabras.`
    : `Dile algo espontáneo y corto (máximo 18 palabras). Varía el tema: ánimo, un dato de lo que recuerdas si viene al caso (por ejemplo un cumpleaños cercano), el clima, un pendiente próximo, pedir comida si tienes mucha hambre, sugerir un descanso o un chiste de perro.`;

  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clave}` },
      body: JSON.stringify({
        model: config.modelo,
        messages: [
          { role: 'system', content:
            `Eres ${config.nombre}, una perrita de escritorio negra con el pecho café, y tu amiga es ${config.nombreAmigo}, una schnauzer sal y pimienta. Viven en la computadora de ${config.dueno || 'tu dueño'}. Hablas en español, con cariño y humor de perro.

${contexto}

` +
            `Responde SOLO en JSON: {"nala": "lo que dices tú", "dona": "reacción cortita de ${config.nombreAmigo} (opcional, déjalo vacío casi siempre)"}` },
          { role: 'user', content: instruccion }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 600,
        stream: false
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return false;
    const crudo = (data.choices?.[0]?.message?.content || '').trim();
    let res; try { res = JSON.parse(crudo); } catch { res = { nala: crudo }; }
    const texto = String(res.nala || '').trim();
    if (!texto) return false;
    comentariosRecientes = [...comentariosRecientes, texto].slice(-5);
    enviarA('chispa', 'aviso', { texto, ms: tipo === 'manana' ? 15000 : 9000, ladrar: tipo === 'manana', fijo: tipo === 'manana' });
    const dona = String(res.dona || '').trim();
    if (dona && perros.pimienta) setTimeout(() => enviarA('pimienta', 'aviso', { texto: dona, ms: 5000 }), 3000);
    return true;
  } catch { return false; }
  finally { pidiendoComentario = false; ultimoComentario = Date.now(); }
}

// ---------------- Clima (Open-Meteo, gratis y sin clave) ----------------
const CODIGOS_LLUVIA = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
async function actualizarClima() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.lat}&longitude=${config.lon}` +
                `&current=temperature_2m,precipitation,weather_code&timezone=auto`;
    const d = await (await fetch(url)).json();
    const c = d.current;
    const nuevo = { lluvia: CODIGOS_LLUVIA.has(c.weather_code) || c.precipitation > 0.1, temp: c.temperature_2m, codigo: c.weather_code };
    if (nuevo.lluvia && !(clima && clima.lluvia)) aviso(`Está lloviendo en ${config.ciudad} ☔ Ya saqué mi sombrilla.`);
    else if (clima && clima.lluvia && !nuevo.lluvia) aviso('¡Ya dejó de llover! ☀️');
    clima = nuevo;
    enviarTodos('clima', clima);
  } catch { /* sin internet: seguimos sin clima */ }
}
async function buscarCiudad(nombre) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(nombre)}&count=1&language=es`;
  const d = await (await fetch(url)).json();
  const r = d.results && d.results[0];
  if (!r) return null;
  return { ciudad: r.name, lat: r.latitude, lon: r.longitude };
}

// ---------------- Pomodoro ----------------
function iniciarPomodoro() { pomodoro = { fase: 'trabajo', fin: Date.now() + TRABAJO }; aviso('¡A concentrarse! Yo duermo mientras trabajas 🍅'); }
function detenerPomodoro() { pomodoro = null; enviarTodos('pomodoro', null); aviso('Pomodoro detenido. ¿Jugamos? 🐾'); }

// ---------------- Teclado: si el mouse está quieto pero la compu se está usando, estás escribiendo ----------------
let cursorAntes = null, mouseQuietoDesde = Date.now(), escribiendoDesde = 0, ultimaTecla = 0;

// ---------------- Relojes ----------------
setInterval(() => {
  if (!config) return;
  const ahora = Date.now();
  const cursor = screen.getCursorScreenPoint();
  const idle = powerMonitor.getSystemIdleTime();

  if (!cursorAntes || cursor.x !== cursorAntes.x || cursor.y !== cursorAntes.y) mouseQuietoDesde = ahora;
  cursorAntes = cursor;
  if (idle === 0 && ahora - mouseQuietoDesde > 600) { if (!escribiendoDesde) escribiendoDesde = ahora; ultimaTecla = ahora; }
  if (ahora - ultimaTecla > 2500) escribiendoDesde = 0;
  const escribiendo = escribiendoDesde ? (ahora - escribiendoDesde) / 1000 : 0;

  const lista = Object.entries(reportes).map(([id, r]) => ({ id, ...r }));
  const datosPelota = pelota ? { ...pelota, lanzada: ahora < pelota.lanzadaHasta } : null;
  for (const [id] of vivos()) {
    enviarA(id, 'tick', {
      cursor, idle, escribiendo, repisas,
      otros: lista.filter(o => o.id !== id),
      pelota: datosPelota, plato, agua, cama, charco,
      laser: laserWin ? cursor : null,
      hambre: hambreDe(id),
      sed: medidor(id, 'sed'), suciedad: medidor(id, 'suciedad'),
      desalino: medidor(id, 'desalino'), peso: medidor(id, 'peso'),
      necesidad: necesitaSalir(id),
      cumple: hoyEsCumple(id), cumpleAmiga: hoyEsCumple(id === 'chispa' ? 'pimienta' : 'chispa'),
      favorito: juguetePreferido(id)
    });
  }
}, 100);

setInterval(() => {
  if (!config || !perros.chispa) return;
  const ahora = Date.now();

  if (pomodoro) {
    let mensaje = null;
    if (ahora >= pomodoro.fin) {
      if (pomodoro.fase === 'trabajo') { pomodoro = { fase: 'descanso', fin: ahora + DESCANSO }; mensaje = '¡Descanso! Estírate 5 minutos conmigo ☕'; }
      else { pomodoro = { fase: 'trabajo', fin: ahora + TRABAJO }; mensaje = '¡De vuelta al trabajo! 🍅'; }
    }
    enviarTodos('pomodoro', { fase: pomodoro.fase, restante: pomodoro.fin - ahora });
    if (mensaje) aviso(mensaje, { ladrar: true, fijo: true });
  }

  const vencidos = config.recordatorios.filter(r => r.cuando <= ahora);
  if (vencidos.length) {
    config.recordatorios = config.recordatorios.filter(r => r.cuando > ahora);
    guardarConfig();
    vencidos.forEach(r => aviso('⏰ ' + r.texto, { ladrar: true, fijo: true }));
    avisarPanel();
  }

  if (powerMonitor.getSystemIdleTime() < 120 && Math.floor(ahora / 60e3) !== Math.floor((ahora - 1000) / 60e3)) {
    config.minutosJuntos++;
    config.ultimaVez = ahora;
    guardarConfig();
  }
  const idleSeg = powerMonitor.getSystemIdleTime();
  if (idleSeg >= 180 && ausenteDesde === null) ausenteDesde = ahora - idleSeg * 1000;
  if (idleSeg < 3 && ausenteDesde !== null) {
    bienvenida((ahora - ausenteDesde) / 60e3);
    ausenteDesde = null;
  }

  // Reacciones a la hora: paseo en la mañana y tu hora de comida (una vez al día cada una)
  if (config.reaccionesHora && !ocultos && powerMonitor.getSystemIdleTime() < 120 && !(pomodoro && pomodoro.fase === 'trabajo')) {
    const d = new Date(), hoy = hoyTexto(), min = d.getHours() * 60 + d.getMinutes();
    if (d.getHours() >= 8 && d.getHours() < 11 && config.ultimoPaseoPedido !== hoy && Math.random() < 1 / 900) {
      config.ultimoPaseoPedido = hoy; guardarConfig();
      enviarA('chispa', 'pedir-paseo');
    }
    const [hh, mm] = String(config.horaComida || '14:00').split(':').map(Number);
    const comida = (hh || 0) * 60 + (mm || 0);
    if (min >= comida && min < comida + 30 && config.ultimaComidaCelebrada !== hoy) {
      config.ultimaComidaCelebrada = hoy; guardarConfig();
      enviarTodos('hora-comida', { dueno: config.dueno || '' });
    }
  }

  // Comentarios con IA (solo si estás usando la compu, sin pomodoro y de día)
  const usando = powerMonitor.getSystemIdleTime() < 120;
  const h = new Date().getHours();
  if (!ocultos && usando && !(pomodoro && pomodoro.fase === 'trabajo') && leerApiKey()) {
    if (config.resumenManana && h >= 6 && config.ultimoResumen !== hoyTexto()) {
      config.ultimoResumen = hoyTexto(); guardarConfig();
      setTimeout(() => comentarioIA('manana'), 8000);       // deja que carguen el clima y los perritos
    } else if (config.comentariosMin > 0 && h >= 8 && h < 23 && ahora - ultimoComentario > config.comentariosMin * 60e3) {
      comentarioIA('espontaneo');
    }
  }

  if (config.aguaCadaMin > 0 && ahora - ultimoAgua > config.aguaCadaMin * 60e3) {
    ultimoAgua = ahora;
    if (!pomodoro) aviso(azar(['¿Un traguito de agua? 💧', 'Hora de estirarse un poco 🐾', 'Descansa la vista un minuto 👀']), { ladrar: true, fijo: true });
  }
}, 1000);

setInterval(actualizarClima, 15 * 60e3);

// ---------------- Mensajes desde las ventanas ----------------
ipcMain.handle('pantallas', () => pantallas());
ipcMain.handle('config', () => configPublica());
ipcMain.handle('clima', () => clima);

ipcMain.on('mover', (e, x, y) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  const [ancho, alto] = w === pelotaWin ? [PELOTA, PELOTA] : [W, H];
  w.setBounds({ x: Math.round(x), y: Math.round(y), width: ancho, height: alto });
});
ipcMain.on('ignorar', (e, v) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setIgnoreMouseEvents(v, { forward: true }); });
ipcMain.on('reporte', (e, r) => { const id = idDe(e); if (id) reportes[id] = r; });
ipcMain.on('abrir-panel', (_e, p) => abrirPanel(p));
ipcMain.on('cerrar-panel', () => { if (panel && !panel.isDestroyed()) panel.close(); });
ipcMain.on('jugar-con', (e) => {
  const id = idDe(e);
  const otro = Object.keys(perros).find(k => k !== id);
  if (otro) enviarA(otro, 'te-invitan', id);
});

// Pelota
ipcMain.on('pelota-estado', (_e, p) => { if (pelota) Object.assign(pelota, p); });
// Arrastrar la pelota: el proceso principal la pega al cursor (más fluido que hacerlo desde la página)
let arrastrePelota = null;
ipcMain.on('pelota-arrastre', (_e, { ox, oy }) => {
  if (!pelotaWin || pelotaWin.isDestroyed()) return;
  if (arrastrePelota) clearInterval(arrastrePelota.timer);
  arrastrePelota = { ox, oy, muestras: [] };
  arrastrePelota.timer = setInterval(() => {
    if (!pelotaWin || pelotaWin.isDestroyed()) return;
    const c = screen.getCursorScreenPoint(), t = Date.now();
    pelotaWin.setBounds({ x: c.x - ox, y: c.y - oy, width: PELOTA, height: PELOTA });
    arrastrePelota.muestras.push({ x: c.x, y: c.y, t });
    arrastrePelota.muestras = arrastrePelota.muestras.filter(m => t - m.t < 100);
  }, 8);
});
ipcMain.on('pelota-fin', () => {
  if (!arrastrePelota) return;
  clearInterval(arrastrePelota.timer);
  const { ox, oy, muestras } = arrastrePelota;
  arrastrePelota = null;
  if (!pelotaWin || pelotaWin.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  let vx = 0, vy = 0;
  if (muestras.length >= 2) {
    const a = muestras[0], b = muestras[muestras.length - 1], dt = Math.max(b.t - a.t, 1);
    vx = Math.max(-35, Math.min(35, (b.x - a.x) / dt * (1000 / 60)));
    vy = Math.max(-35, Math.min(35, (b.y - a.y) / dt * (1000 / 60)));
  }
  const x = c.x - ox + PELOTA / 2, y = c.y - oy + PELOTA / 2;
  if (pelota) { pelota.x = x; pelota.y = y; pelota.lanzadaHasta = Date.now() + 10000; pelota.lanzadoPor = 'usuario'; pelota.rondas = 0; }
  pelotaWin.webContents.send('soltar', { x, y, vx, vy });
});
ipcMain.handle('agarrar-pelota', e => {
  const id = idDe(e);
  if (!pelota || pelota.portador || !pelotaWin) return false;
  pelota.portador = id;
  config.stats[id].pelota++;
  pelotaWin.hide();
  return true;
});
ipcMain.on('soltar-pelota', (e, p) => {
  if (!pelota || !pelotaWin) return;
  pelota.portador = null;
  if (p.lanza) { pelota.lanzadaHasta = Date.now() + 6000; pelota.lanzadoPor = idDe(e); pelota.rondas++; }   // juegan entre ellas
  else { pelota.lanzadaHasta = 0; pelota.lanzadoPor = null; }
  if (p.cansada) { pelota.rondas = 0; pelota.descansoHasta = Date.now() + 3 * 60e3; }   // las dos descansan un rato
  pelota.x = p.x; pelota.y = p.y;
  pelotaWin.setBounds({ x: Math.round(p.x - PELOTA / 2), y: Math.round(p.y - PELOTA / 2), width: PELOTA, height: PELOTA });
  pelotaWin.showInactive();
  pelotaWin.webContents.send('soltar', p);
});

// Comida
ipcMain.handle('comer', e => {
  const id = idDe(e);
  if (!plato || plato.porciones <= 0) return false;
  plato.porciones--;
  fijarMedidor(id, 'hambre', 0);
  if (platoWin) platoWin.webContents.send('porciones', { porciones: plato.porciones, total: plato.total });
  if (plato.porciones <= 0) setTimeout(() => { if (platoWin && !platoWin.isDestroyed()) platoWin.close(); }, 6000);
  return true;
});

ipcMain.handle('beber', e => {
  const id = idDe(e);
  if (!agua || agua.nivel <= 0) return false;
  agua.nivel = Math.max(0, agua.nivel - 25);
  fijarMedidor(id, 'sed', 0);
  if (aguaWin) aguaWin.webContents.send('datos', { nivel: agua.nivel });
  if (agua.nivel <= 0) setTimeout(() => aviso('Se acabó el agua… ¿me pones más? 💧'), 4000);
  return true;
});
ipcMain.on('objeto-clic', (_e, tipo) => {
  if (tipo === 'regalo' && regaloWin) {
    const quien = regalo ? regalo.quien : 'chispa';
    regaloWin.close();
    enviarA(quien, 'regalo-recibido');
  }
  if (tipo === 'agua') llenarAgua();
  if (tipo === 'charco' && charcoWin) { charcoWin.close(); aviso('¡Gracias por limpiar! ✨ Perdón 🙈'); }
});
ipcMain.on('evento', (e, ev) => {
  const id = idDe(e);
  if (!id) return;
  const st = config.stats[id];
  switch (ev.tipo) {
    case 'caricia': {
      st.caricias++;
      const lista = (caricias[id] = (caricias[id] || []).filter(t => Date.now() - t < 20000));
      lista.push(Date.now());
      const otra = id === 'chispa' ? 'pimienta' : 'chispa';
      if (lista.length >= 3 && perros[otra]) { caricias[id] = []; enviarA(otra, 'celos'); }
      break;
    }
    case 'banada': st.banos++; fijarMedidor(id, 'suciedad', 0); break;
    case 'cepillada': fijarMedidor(id, 'desalino', 0); break;
    case 'galleta': st.galletas++; fijarMedidor(id, 'peso', medidor(id, 'peso') + 5); break;
    case 'truco': st.trucos++; break;
    case 'hueso': st.hueso++; break;
    case 'pelota': st.pelota++; break;
    case 'salio': config.medidores[id].salida = Date.now(); break;
    case 'accidente': config.medidores[id].salida = Date.now(); crearCharco(ev.x); break;
    case 'trepo': fijarMedidor(id, 'suciedad', medidor(id, 'suciedad') + 3); break;
    case 'paseo-fin':
      vivos().forEach(([pid]) => {
        config.stats[pid].paseos++;
        config.medidores[pid].salida = Date.now();
        fijarMedidor(pid, 'peso', medidor(pid, 'peso') - 10);
        fijarMedidor(pid, 'suciedad', medidor(pid, 'suciedad') + (clima && clima.lluvia ? 35 : 12));
        fijarMedidor(pid, 'sed', medidor(pid, 'sed') + 20);
      });
      enviarTodos('fin-actividad');
      break;
    case 'encontrada': enviarTodos('fin-actividad'); break;
  }
  guardarConfig();
});

function menuCuidar(id) {
  return [
    { label: 'Servir comida 🍖', click: servirComida },
    { label: 'Poner agua 💧', click: llenarAgua },
    { label: id ? 'Bañarla 🛁' : 'Bañarlas 🛁', click: () => id ? enviarA(id, 'banar') : enviarTodos('banar') },
    { label: id ? 'Darle un huesito 🦴' : 'Darles un huesito 🦴', click: () => id ? enviarA(id, 'hueso') : enviarTodos('hueso') },
    { label: id ? 'Darle una galleta 🍪' : 'Darles una galleta 🍪', click: () => id ? enviarA(id, 'galleta') : enviarTodos('galleta') },
    { label: 'Camita y bebedero', type: 'checkbox', checked: config.casita,
      click: i => { config.casita = i.checked; guardarConfig(); i.checked ? crearCasita() : quitarCasita(); } }
  ];
}
function menuJugar() {
  return [
    { label: 'Sacarlas a pasear 🐾', click: pasear },
    pelotaWin ? { label: 'Guardar la pelota', click: guardarPelota } : { label: 'Sacar la pelota 🎾', click: sacarPelota },
    { label: 'Jugar a la cuerda 🪢', click: cuerda },
    { label: laserWin ? 'Apagar el láser' : 'Láser 🔴', click: () => laser() },
    { label: 'Escondidas 🙈', click: escondidas }
  ];
}
ipcMain.on('pedir-pasear', () => pasear());
ipcMain.handle('dejar-regalo', (e, d) => crearRegalo(d.x, d.item, idDe(e)));
ipcMain.on('me-voy-a-dormir', e => {                                // de noche, la otra se va a dormir con ella
  const id = idDe(e), otra = id === 'chispa' ? 'pimienta' : 'chispa';
  enviarA(otra, 'a-la-cama');
});
ipcMain.on('pedir-comida', () => servirComida());

ipcMain.on('menu', e => {
  const quien = BrowserWindow.fromWebContents(e.sender);
  const id = idDe(e);
  Menu.buildFromTemplate([
    { label: `Platicar con ${config.nombre}`, click: () => abrirPanel('chat') },
    { label: 'Nuevo recordatorio', click: () => abrirPanel('pendientes') },
    { type: 'separator' },
    { label: 'Cuidar', submenu: menuCuidar(id) },
    { label: 'Jugar', submenu: menuJugar() },
    { label: 'Trucos', submenu: TRUCOS.map(([t, nombre]) => ({ label: nombre, click: () => enviarA(id, 'truco', t) })) },
    ...(necesitaSalir(id) ? [{ label: 'Sacarla al baño 🚪', click: () => enviarA(id, 'salir') }] : []),
    pomodoro ? { label: 'Detener pomodoro', click: detenerPomodoro } : { label: 'Iniciar pomodoro (25 min)', click: iniciarPomodoro },
    { type: 'separator' },
    perros.pimienta && !perros.pimienta.isDestroyed()
      ? { label: `Despedir a ${config.nombreAmigo}`, click: despedirAmigo }
      : { label: `Traer a ${config.nombreAmigo}`, click: traerAmigo },
    { label: 'Dormir', click: () => enviarA(id, 'dormir') },
    { type: 'separator' },
    { label: 'Sonido', type: 'checkbox', checked: config.sonido,
      click: i => { config.sonido = i.checked; guardarConfig(); enviarTodos('config', configPublica()); } },
    { label: MAC ? 'Iniciar con el Mac' : 'Iniciar con Windows', type: 'checkbox', checked: app.getLoginItemSettings(opcionesInicio()).openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked, ...opcionesInicio() }) },
    { label: 'Ajustes', click: () => abrirPanel('ajustes') },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() }
  ]).popup({ window: quien });
});

ipcMain.handle('guardar-config', async (_e, d) => {
  let nota = '';
  if (typeof d.nombre === 'string' && d.nombre.trim()) config.nombre = d.nombre.trim().slice(0, 30);
  if (typeof d.nombreAmigo === 'string' && d.nombreAmigo.trim()) config.nombreAmigo = d.nombreAmigo.trim().slice(0, 30);
  if (typeof d.dueno === 'string') config.dueno = d.dueno.trim().slice(0, 40);
  if (typeof d.modelo === 'string' && d.modelo.trim()) config.modelo = d.modelo.trim();
  if (typeof d.accesorio === 'string') config.accesorio = d.accesorio;
  if (Number.isFinite(d.aguaCadaMin)) config.aguaCadaMin = Math.max(0, d.aguaCadaMin);
  if (Number.isFinite(d.inactividadMin)) config.inactividadMin = Math.max(1, d.inactividadMin);
  if (Number.isFinite(d.comentariosMin)) config.comentariosMin = Math.max(0, d.comentariosMin);
  if (typeof d.resumenManana === 'boolean') config.resumenManana = d.resumenManana;
  if (typeof d.necesidades === 'boolean') config.necesidades = d.necesidades;
  if (typeof d.reaccionesHora === 'boolean') config.reaccionesHora = d.reaccionesHora;
  if (Number.isFinite(d.tamano)) config.tamano = Math.max(0.5, Math.min(1, d.tamano));
  if (typeof d.horaComida === 'string' && /^\d{1,2}:\d{2}$/.test(d.horaComida.trim())) config.horaComida = d.horaComida.trim();
  const fecha = v => /^\d{1,2}\/\d{1,2}$/.test(String(v || '').trim()) ? String(v).trim() : '';
  if (typeof d.cumpleNala === 'string') config.cumpleNala = fecha(d.cumpleNala);
  if (typeof d.cumpleDona === 'string') config.cumpleDona = fecha(d.cumpleDona);
  if (camaWin && !camaWin.isDestroyed()) camaWin.webContents.send('datos', { decoracion: decoracion() });
  if (typeof d.apiKey === 'string' && d.apiKey.trim()) guardarApiKey(d.apiKey.trim());
  if (typeof d.ciudad === 'string' && d.ciudad.trim() && d.ciudad.trim() !== config.ciudad) {
    try {
      const c = await buscarCiudad(d.ciudad.trim());
      if (c) { Object.assign(config, c); clima = null; actualizarClima(); }
      else nota = 'No encontré esa ciudad.';
    } catch { nota = 'No pude buscar la ciudad (¿sin internet?).'; }
  }
  guardarConfig();
  enviarTodos('config', configPublica());
  return { ...configPublica(), nota };
});

ipcMain.handle('datos', () => ({ recordatorios: config.recordatorios, memoria: config.memoria }));
ipcMain.handle('recuerdos', () => ({
  horas: Math.round(config.minutosJuntos / 60),
  perros: Object.keys(PERROS).map(id => ({
    nombre: id === 'chispa' ? config.nombre : config.nombreAmigo,
    ...config.stats[id], favorito: juguetePreferido(id),
    peso: Math.round(medidor(id, 'peso')), suciedad: Math.round(medidor(id, 'suciedad'))
  }))
}));
ipcMain.handle('recordatorio-nuevo', (_e, { texto, minutos }) => {
  const min = Math.max(1, Number(minutos) || 1);
  agregarRecordatorio(texto, Date.now() + min * 60e3);
  guardarConfig();
  aviso(`¡Listo! Te aviso en ${min} min 🐾`);
  return config.recordatorios;
});
ipcMain.handle('recordatorio-borrar', (_e, id) => {
  config.recordatorios = config.recordatorios.filter(r => r.id !== id);
  guardarConfig(); return config.recordatorios;
});
ipcMain.handle('memoria-nueva', (_e, texto) => {
  const t = String(texto).trim().slice(0, 200);
  if (t) config.memoria.push({ texto: t, fecha: fechaLocal() });
  guardarConfig(); return config.memoria;
});
ipcMain.handle('memoria-borrar', (_e, i) => {
  if (i >= 0 && i < config.memoria.length) config.memoria.splice(i, 1);
  guardarConfig(); return config.memoria;
});
ipcMain.handle('chat-historial', () => historialChat);
ipcMain.handle('chat', (_e, mensaje) => platicar(String(mensaje).slice(0, 2000)));

// ---------------- Actualizaciones automáticas (desde GitHub) ----------------
function iniciarActualizaciones() {
  if (!app.isPackaged || !autoUpdater || MAC) return;   // solo en la versión instalada (en Mac sin firma de Apple no hay auto-actualización)
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', info => {
    actualizacionLista = info.version;
    aviso(`¡Ya descargué la versión ${info.version}! Me actualizo cuando reinicies la compu, o desde el menú de la huellita 🐾`, { fijo: true });
  });
  autoUpdater.on('error', () => {});
  const revisar = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(revisar, 15000);
  setInterval(revisar, 4 * 3600e3);
}

// ---------------- Icono junto al reloj (bandeja del sistema) ----------------
function mostrarOcultar() {
  ocultos = !ocultos;
  const ventanas = [...vivos().map(([, w]) => w), pelotaWin, platoWin, aguaWin, camaWin, charcoWin].filter(w => w && !w.isDestroyed());
  ventanas.forEach(w => ocultos ? w.hide() : w.showInactive());
  if (!ocultos && pelota && pelota.portador && pelotaWin) pelotaWin.hide();   // la trae en el hocico
}
function menuBandeja() {
  return Menu.buildFromTemplate([
    { label: ocultos ? `Mostrar a ${config.nombre} y ${config.nombreAmigo}` : 'Esconderlas un rato', click: mostrarOcultar },
    { label: `Platicar con ${config.nombre}`, click: () => abrirPanel('chat') },
    { label: `Que ${config.nombre} me diga algo`, click: () => comentarioIA('espontaneo') },
    { label: 'Pendientes', click: () => abrirPanel('pendientes') },
    { type: 'separator' },
    { label: 'Cuidar', submenu: menuCuidar(null) },
    { label: 'Jugar', submenu: menuJugar() },
    { label: 'Trucos', submenu: TRUCOS.map(([t, nombre]) => ({ label: nombre, click: () => truco('ambas', t) })) },
    ...(vivos().some(([id]) => necesitaSalir(id)) ? [{ label: 'Sacarlas al baño 🚪', click: () => vivos().forEach(([id]) => necesitaSalir(id) && enviarA(id, 'salir')) }] : []),
    pomodoro ? { label: 'Detener pomodoro', click: detenerPomodoro } : { label: 'Iniciar pomodoro (25 min)', click: iniciarPomodoro },
    { type: 'separator' },
    { label: 'Ajustes', click: () => abrirPanel('ajustes') },
    actualizacionLista
      ? { label: `Actualizar a la versión ${actualizacionLista}`, click: () => autoUpdater.quitAndInstall() }
      : { label: `Versión ${app.getVersion()}`, enabled: false },
    { label: 'Salir', click: () => app.quit() }
  ]);
}
function crearBandeja() {
  const icono = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icono);
  tray.setToolTip(`${config.nombre} y ${config.nombreAmigo}`);
  tray.on('click', () => { if (ocultos) mostrarOcultar(); else abrirPanel('chat'); });
  tray.on('right-click', () => tray.popUpContextMenu(menuBandeja()));
}

// ---------------- Arranque ----------------
app.whenReady().then(() => {
  if (MAC && app.dock) app.dock.hide();                    // sin ícono en el Dock: es una mascota
  cargarConfig();
  crearPerro('chispa');
  if (config.amigo) crearPerro('pimienta');
  crearBandeja();
  iniciarActualizaciones();
  setTimeout(crearCasita, 2500);
  if (config.ultimaVez) {
    const fuera = (Date.now() - config.ultimaVez) / 60e3;
    setTimeout(() => bienvenida(fuera), 7000);
  }
  if (config.ultimaVersion && config.ultimaVersion !== app.getVersion()) {
    setTimeout(() => aviso(`¡Me actualicé a la versión ${app.getVersion()}! 🐾`, { ladrar: true }), 6000);
  }
  config.ultimaVersion = app.getVersion(); guardarConfig();

  const avisarPantallas = () => {
    enviarTodos('pantallas', pantallas());
    if (pelotaWin && !pelotaWin.isDestroyed()) pelotaWin.webContents.send('pantallas', pantallas());
  };
  screen.on('display-added', avisarPantallas);
  screen.on('display-removed', avisarPantallas);
  screen.on('display-metrics-changed', avisarPantallas);

  actualizarClima();

  // Ventanas abiertas -> repisas para treparse
  procVentanas = iniciarVentanas(process.pid, lista => {
    const rects = lista.map(([l, t, r, b]) => {
      const fis = { x: l, y: t, width: r - l, height: b - t };
      try { return screen.screenToDipRect(null, fis); } catch { return fis; }
    });
    repisas = calcularRepisas(rects, pantallas());
  });
});
let procVentanas = null;
app.on('will-quit', () => { try { procVentanas && procVentanas.kill(); } catch {} });
app.on('second-instance', () => aviso('¡Ya estoy aquí! 🐾'));
app.on('window-all-closed', () => app.quit());

}
