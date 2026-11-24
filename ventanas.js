// =====================================================================
// VENTANAS: averigua dónde están las ventanas abiertas (solo Windows)
// Usa PowerShell (ya viene en Windows) con un poquito de C#, así no hay
// que instalar módulos nativos. Cada 0.7 s manda la lista de ventanas.
// =====================================================================
const { spawn } = require('child_process');

const CODIGO_CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Ventanas {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  static bool listo = false;

  public static string Leer(int miPid) {
    if (!listo) { SetProcessDPIAware(); listo = true; }
    StringBuilder sb = new StringBuilder("[");
    bool primero = true;
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h) || IsIconic(h) || GetWindowTextLength(h) == 0) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;              // ventanas de herramientas
      int oculta;
      if (DwmGetWindowAttribute(h, 14, out oculta, 4) == 0 && oculta != 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == (uint)miPid) return true;                                // nuestras propias ventanas
      StringBuilder cn = new StringBuilder(64); GetClassName(h, cn, 64);
      string c = cn.ToString();
      if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Progman" || c == "WorkerW") return true;
      RECT r;
      if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) return true;
      if (r.R - r.L < 200 || r.B - r.T < 100) return true;
      if (!primero) sb.Append(',');
      primero = false;
      sb.Append('[').Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R).Append(',').Append(r.B).Append(']');
      return true;
    }, IntPtr.Zero);
    return sb.Append(']').ToString();
  }
}
`;

function iniciarVentanas(pidPropio, alRecibir) {
  if (process.platform !== 'win32') return null;

  const script =
    "$ErrorActionPreference = 'Stop'\n" +
    "Add-Type -TypeDefinition @'\n" + CODIGO_CS + "\n'@\n" +
    "while ($true) { [Console]::Out.WriteLine([Ventanas]::Leer(" + pidPropio + ")); [Console]::Out.Flush(); Start-Sleep -Milliseconds 700 }";
  const codificado = Buffer.from(script, 'utf16le').toString('base64');

  let proc;
  try {
    proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', codificado],
      { windowsHide: true });
  } catch { return null; }

  let buffer = '';
  proc.stdout.on('data', datos => {
    buffer += datos.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linea = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (linea.startsWith('[')) {
        try { alRecibir(JSON.parse(linea)); } catch { /* línea incompleta */ }
      }
    }
  });
  proc.stderr.on('data', () => {});   // si PowerShell falla, simplemente no se trepan
  proc.on('error', () => {});
  return proc;
}

// Quita de una lista de segmentos [a, b] el tramo [c, d]
function restar(segmentos, c, d) {
  const res = [];
  for (const [a, b] of segmentos) {
    if (d <= a || c >= b) { res.push([a, b]); continue; }
    if (c > a) res.push([a, c]);
    if (d < b) res.push([d, b]);
  }
  return res;
}

// Convierte ventanas (de la de hasta arriba a la de hasta abajo) en "repisas":
// el borde superior de cada ventana que no esté tapado por otra.
function calcularRepisas(rects, pantallas) {
  const repisas = [];
  const encima = [];
  for (const r of rects) {
    const pantalla = pantallas.find(p => r.x + r.width / 2 >= p.x && r.x + r.width / 2 < p.x + p.width);
    const maximizada = pantalla && r.y <= pantalla.y + 10;
    if (!maximizada) {
      let tramos = [[r.x, r.x + r.width]];
      for (const e of encima) {
        if (e.y <= r.y && e.y + e.height > r.y) tramos = restar(tramos, e.x, e.x + e.width);
      }
      for (const [a, b] of tramos) if (b - a > 80) repisas.push({ x1: a, x2: b, y: r.y });
    }
    encima.push(r);
  }
  return repisas;
}

module.exports = { iniciarVentanas, calcularRepisas };
