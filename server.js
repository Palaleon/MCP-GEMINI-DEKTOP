"use strict";
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fsSync = require("fs");
const fs = require("fs/promises");
const { spawn } = require("child_process");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } =
  require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// ---------------------------------------------------------------- Config
const VERSION = "3.1.0";
const ROOT = path.resolve(process.env.MCP_ROOT || "C:\\Users\\ASD\\Documents\\proyectos");
const PORT = 3000;
const MAX_READ_BYTES = 20 * 1024 * 1024;   // archivo maximo que se abre
const MAX_WRITE_BYTES = 5 * 1024 * 1024;   // maximo por escritura
const MAX_OUTPUT_CHARS = 80000;            // maximo de texto por respuesta
const COMMANDS_ENABLED = process.env.MCP_COMMANDS !== "0";
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out", "coverage",
  "__pycache__", ".venv", "venv", ".cache", ".turbo", ".parcel-cache"
]);

// Token FIJO guardado fuera de la carpeta autorizada
const TOKEN_FILE = path.join(os.homedir(), ".gemini-mcp-token");
function loadToken() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
  try {
    const t = fsSync.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(32).toString("hex");
  fsSync.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();
function tokenOk(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Log de llamadas (fuera de la carpeta autorizada). Sirve para ver si Gemini llega al servidor y que pasa.
const LOG_FILE = path.join(os.homedir(), ".gemini-mcp.log");
function log(msg) {
  try {
    if (fsSync.existsSync(LOG_FILE) && fsSync.statSync(LOG_FILE).size > 1024 * 1024) {
      fsSync.renameSync(LOG_FILE, LOG_FILE + ".old");
    }
    fsSync.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
function summarizeArgs(args) {
  try {
    return JSON.stringify(args, (k, v) => (k === "content" ? `<${String(v).length} chars>` : v)).slice(0, 300);
  } catch { return "?"; }
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// Secreto en la ruta: /mcp/<token>
app.use((req, res, next) => {
  const m = req.url.match(/^\/mcp\/([^/?]+)/);
  if (m) {
    req.headers.authorization = `Bearer ${decodeURIComponent(m[1])}`;
    req.url = "/mcp";
  }
  next();
});

// ---------------------------------------------------------------- Rutas seguras
let REAL_ROOT;

async function initializeRoot() {
  REAL_ROOT = await fs.realpath(ROOT);
  const stat = await fs.stat(REAL_ROOT);
  if (!stat.isDirectory()) throw new Error("La carpeta autorizada no es un directorio");
}

function insideRoot(target) {
  const relative = path.relative(REAL_ROOT, target);
  return relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function rel(full) {
  return path.relative(REAL_ROOT, full).split(path.sep).join("/") || ".";
}

async function stripRootName(raw) {
  // Gemini a veces escribe "proyectos/MCP/x" en vez de "MCP/x": quita el nombre de la raiz si no es una carpeta real
  const parts = String(raw || ".").trim().split(/[\\/]+/).filter(Boolean);
  const rootName = path.basename(REAL_ROOT).toLowerCase();
  if (parts.length && !path.isAbsolute(raw) && parts[0].toLowerCase() === rootName) {
    try { await fs.stat(path.join(REAL_ROOT, parts[0])); return raw; }
    catch { return parts.slice(1).join("/") || "."; }
  }
  return raw;
}

async function safeExisting(relativePath) {
  const raw = (relativePath || ".").trim() || ".";
  const candidates = [raw];
  const stripped = await stripRootName(raw);
  if (stripped !== raw) candidates.push(stripped);
  for (const c of candidates) {
    try {
      const real = await fs.realpath(path.resolve(REAL_ROOT, c));
      if (!insideRoot(real)) throw new Error("Acceso fuera del directorio autorizado");
      return real;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const rn = path.basename(REAL_ROOT);
  throw new Error(`La ruta "${raw}" no existe. Las rutas son relativas a la carpeta raiz "${rn}" ('.' es la raiz): usa "MCP/server.js", no "${rn}/MCP/server.js". Si dudas, usa list_files con path ".".`);
}

async function safeNew(relativePath) {
  const target = path.resolve(REAL_ROOT, await stripRootName(relativePath));
  if (!insideRoot(target)) throw new Error("Ruta fuera del directorio autorizado");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const parent = await fs.realpath(path.dirname(target));
  if (!insideRoot(parent)) throw new Error("Directorio de destino no autorizado");
  return path.join(parent, path.basename(target));
}

function result(value, isError = false) {
  const out = {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }]
  };
  if (isError) out.isError = true;
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeFileFilter(include) {
  if (!include) return () => true;
  const regs = include.split(",").map(s => s.trim()).filter(Boolean).map(g =>
    new RegExp("^" + g.split("*").map(escapeRegex).join("[^/\\\\]*").replace(/\\\?/g, ".") + "$", "i")
  );
  return name => regs.some(r => r.test(name));
}

async function* walkFiles(dir, includeIgnored = false) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!includeIgnored && IGNORE_DIRS.has(e.name)) continue;
      yield { full, name: e.name, isDir: true };
      yield* walkFiles(full, includeIgnored);
    } else if (e.isFile()) {
      yield { full, name: e.name, isDir: false };
    }
  }
}

async function readTextFile(file, offset = 1, limit = 2000) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("La ruta no es un archivo");
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`Archivo demasiado grande (${stat.size} bytes, maximo ${MAX_READ_BYTES})`);
  }
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) {
    throw new Error("Parece un archivo binario; no se puede leer como texto");
  }
  const lines = buf.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(1, offset);
  const out = [];
  let chars = 0;
  let i = start - 1;
  while (i < total && out.length < limit && chars < MAX_OUTPUT_CHARS) {
    const l = lines[i].length > 2000 ? lines[i].slice(0, 2000) + " ...[linea recortada]" : lines[i];
    out.push(l);
    chars += l.length + 1;
    i++;
  }
  const end = start - 1 + out.length;
  let text = out.join("\n");
  if (end < total) {
    text += `\n\n[... mostrando lineas ${start}-${end} de ${total}. Usa offset=${end + 1} para continuar]`;
  }
  return text;
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WR = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const CMD = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// ---------------------------------------------------------------- Procesos / comandos
const STARTED = Date.now();

const INSTRUCTIONS = [
  "Servidor MCP con acceso REAL a la PC del usuario (Windows). Usa estas herramientas directamente, sin que el usuario te nombre la herramienta; no digas que no tienes acceso sin intentarlo primero.",
  "Archivos: rutas relativas a la carpeta raiz ('.' es la raiz; no antepongas el nombre de la raiz). Explora con directory_tree / list_files / search_in_files, lee con read_file (por partes con offset y limit), edita con edit_file.",
  "Comandos: run_command ejecuta PowerShell (no bash) y termina en maximo 90 s. Para instalaciones, servidores o procesos largos usa start_background_command y luego read_background_output.",
  "Un exit code 0 significa EXITO aunque haya texto en stderr (git y npm escriben avisos ahi). Los errores de estas herramientas son de la llamada, no del servidor: lee el mensaje, corrige y reintenta antes de rendirte.",
  "Los comandos destructivos piden confirmacion: preguntale al usuario en el chat y repite con confirmDangerous=true solo si dice que si.",
  "Si dudas del estado del servidor, llama a server_info.",
  "Diseno UI/UX: antes de crear, revisar o mejorar pantallas, componentes, colores, tipografia, accesibilidad o responsive, lee .agents/skills/ui-ux-pro-max/SKILL.md y sigue su flujo. Su buscador se corre con run_command: & 'C:\\Users\\ASD\\Python312\\python.exe' -I '.agents\\skills\\ui-ux-pro-max\\scripts\\search.py' \"<consulta>\" --design-system (o --domain ux, o --stack nextjs). Ignora la ruta ${CLAUDE_PLUGIN_ROOT} del SKILL.md: usa la de aqui."
].join("\n");

// Quita "2>&1" (fuera de comillas): PowerShell 5.1 convierte el stderr de programas nativos en errores
// falsos (exit code 1 y texto ilegible). Igual devolvemos stdout y stderr por separado.
function stripStderrRedirect(cmd) {
  let out = "";
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      out += c;
      if (c === "`" && q === '"' && i + 1 < cmd.length) { out += cmd[++i]; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === "`" && i + 1 < cmd.length) { out += c + cmd[++i]; continue; }
    const m = cmd.slice(i).match(/^(\s+)?(2|\*)>&1/);
    if (m && (m[1] || i === 0)) { i += m[0].length - 1; continue; }
    out += c;
  }
  return out;
}

function buildScript(command) {
  return [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$OutputEncoding=[System.Text.Encoding]::UTF8",
    "$ProgressPreference='SilentlyContinue'",
    "$global:LASTEXITCODE=0",
    "try {",
    stripStderrRedirect(command),
    "} catch {",
    "[Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)",
    "$global:LASTEXITCODE=1",
    "}",
    "exit $global:LASTEXITCODE",
    ""
  ].join("\r\n");
}

function spawnPs(command, cwd) {
  const file = path.join(os.tmpdir(), "mcp-cmd-" + crypto.randomBytes(6).toString("hex") + ".ps1");
  fsSync.writeFileSync(file, "\uFEFF" + buildScript(command), "utf8");
  const child = spawn("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
      cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
    });
  const cleanup = () => { try { fsSync.unlinkSync(file); } catch {} };
  child.on("close", cleanup);
  child.on("error", cleanup);
  return child;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}

function tailText(s, max = MAX_OUTPUT_CHARS) {
  s = s.replace(/^\uFEFF/, "");
  return s.length > max ? "[...salida recortada, se muestra el final...]\n" + s.slice(-max) : s;
}

const background = new Map();
let backgroundSeq = 0;

// Comandos que piden confirmacion explicita del usuario (cinturon de seguridad, no es un sandbox)
const DANGEROUS = [
  [/\bRemove-Item\b[^\n;|]*-Recurse|\brm\s+(-\w*r|-Recurse)|\b(rd|rmdir)\s+\/s|\bdel\s+[^\n]*\/s/i, "borrado recursivo de archivos o carpetas"],
  [/\bgit\s+reset\s+--hard|\bgit\s+clean\b[^\n]*\s-\w*[fdx]|\bgit\s+push\b[^\n]*(--force\b|\s-f\b)|\bgit\s+branch\b[^\n]*\s-D\b|\bgit\s+checkout\s+(--\s+)?\.(\s|$)|\bgit\s+restore\b[^\n]*\s\.(\s|$)|\bgit\s+stash\s+(drop|clear)/i, "operacion de git que descarta cambios o reescribe historial"],
  [/\b(Format-Volume|Clear-Disk|diskpart)\b|\bformat\s+[a-z]:/i, "formatear discos"],
  [/\b(Stop-Computer|Restart-Computer|shutdown)\b/i, "apagar o reiniciar la PC"],
  [/\b(taskkill|Stop-Process)\b/i, "terminar procesos (podria cerrar el propio servidor MCP)"],
  [/\breg(\.exe)?\s+(delete|add|import)\b|\bSet-ExecutionPolicy\b/i, "cambiar el registro o politicas del sistema"],
  [/\b(iex|Invoke-Expression)\b/i, "ejecutar texto dinamico o descargado"],
  [/\b(npm|pnpm|yarn)\s+(publish|unpublish)\b|\b(winget|choco|scoop)\s+(uninstall|remove)\b|\bnpm\s+(uninstall|remove)\s+(-g|--global)/i, "publicar o desinstalar software"],
  [/\.gemini-mcp|id_rsa|[\\\/]\.ssh\b/i, "acceder a credenciales del sistema o del propio MCP"]
];

function dangerReason(cmd) {
  for (const [re, why] of DANGEROUS) if (re.test(cmd)) return why;
  return null;
}

function dangerMessage(why) {
  return "[REQUIERE CONFIRMACION DEL USUARIO] NO se ejecuto nada. El comando parece destructivo o sensible (" + why + ").\n" +
    "Pidele permiso al usuario EN EL CHAT mostrandole el comando exacto. Si dice que si, vuelve a llamar a la herramienta con el mismo comando y confirmDangerous=true. Si dice que no, no lo ejecutes.";
}

function hintFor({ command, code, timedOut, secs, out, err }) {
  const all = out + "\n" + err;
  if (timedOut) return `El comando tardo mas de ${secs}s y se detuvo. Si es algo largo (install, build, servidor), usa start_background_command y luego read_background_output. Antes de repetirlo, verifica si ya hizo efecto.`;
  if (/git\s+commit/i.test(command || "") && /nothing to commit|nada para hacer commit/i.test(all)) return "No habia cambios para commitear. No es un fallo real.";
  if (/pathspec .* did not match|did not match any file/i.test(all)) return "Git no encontro esa rama, archivo o ruta. Revisa con git branch -a o git status y corrige el nombre.";
  if (/index\.lock/i.test(all)) return "Hay un .git/index.lock colgado. Confirma que no corre otro git y, con permiso del usuario, borra ese archivo.";
  if (/no se reconoce como nombre de un cmdlet|is not recognized as the name/i.test(all)) return "Ese comando no existe en PowerShell o no esta en el PATH. Verifica con Get-Command <nombre>. Usa sintaxis de PowerShell, no bash (ls -> Get-ChildItem, rm -rf -> Remove-Item -Recurse -Force, cat -> Get-Content).";
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(all)) return "Git necesita credenciales y aqui no hay entrada interactiva. El usuario debe iniciar sesion desde su terminal (credential manager o llave SSH).";
  if (/EADDRINUSE|address already in use/i.test(all)) return "El puerto ya esta en uso. Busca quien lo ocupa con Get-NetTCPConnection -LocalPort <puerto>.";
  if (/Acceso denegado|Access is denied|EPERM|EBUSY|being used by another process/i.test(all)) return "Windows niega el acceso o el archivo esta en uso por otro programa. Cierra ese programa o reintenta.";
  if (/ENOENT|cannot find path|no puede encontrar la ruta|no existe/i.test(all)) return "Alguna ruta no existe. Verifica con list_files o directory_tree y usa rutas relativas a la raiz.";
  if (/npm ERR!/i.test(all)) return "npm fallo: la causa suele estar en las primeras lineas 'npm ERR!'. Con ERESOLVE, consulta al usuario si usar --legacy-peer-deps.";
  if (code === 0 && err.trim()) return "Exit code 0 = el comando SI funciono. El texto de stderr son avisos (git, npm y otros escriben su progreso ahi). No lo trates como fallo.";
  if (code !== 0) return `El comando termino con codigo ${code}. Lee la salida y los mensajes de arriba para ver la causa, corrige y reintenta una vez. Si sigue fallando, explicale al usuario el error exacto.`;
  return "";
}

function formatRun({ command, code, timedOut, ms, cwd, out, err, secs }) {
  const status = timedOut ? "TIMEOUT" : code === 0 ? "OK" : "ERROR";
  const o = tailText(out).trim();
  const e = tailText(err, 20000).trim();
  let t = `[${status}] ${timedOut ? "cortado por timeout" : "exit code " + (code === null ? "?" : code)} | ${(ms / 1000).toFixed(1)}s | carpeta: ${cwd}\n`;
  if (o) t += `\n--- salida ---\n${o}\n`;
  if (e) t += `\n--- stderr (avisos o errores) ---\n${e}\n`;
  if (!o && !e) t += "\n(el comando no imprimio nada)\n";
  const h = hintFor({ command, code, timedOut, secs, out: o, err: e });
  if (h) t += `\nPISTA: ${h}\n`;
  return t;
}

function friendlyError(e) {
  const m = e && e.message ? e.message : String(e);
  const byCode = {
    ENOENT: "Esa ruta no existe. Usa list_files, directory_tree o search_files para encontrarla (rutas relativas a la raiz, '.' es la raiz).",
    EACCES: "Windows niega el permiso sobre ese archivo o carpeta.",
    EPERM: "Windows niega el permiso sobre ese archivo o carpeta.",
    EBUSY: "El archivo esta en uso por otro programa. Cierra ese programa o reintenta.",
    EISDIR: "Eso es una carpeta, no un archivo. Usa list_files.",
    ENOTDIR: "Una parte de la ruta no es una carpeta.",
    EEXIST: "Ya existe algo con ese nombre.",
    ENOSPC: "No hay espacio en disco."
  };
  let out = "ERROR en la herramienta: " + m;
  const hint = e && byCode[e.code];
  if (hint) out += "\nQue hacer: " + hint;
  else if (/no es un archivo/i.test(m)) out += "\nQue hacer: usa list_files para ver el contenido de una carpeta.";
  out += "\n(Es un error de ESTA llamada, no del servidor: ajusta los datos y reintenta. No concluyas que el servidor o la consola dejaron de funcionar.)";
  return out;
}

// ---------------------------------------------------------------- Servidor MCP
function createServer() {
  const server = new McpServer({ name: "local-project-filesystem", version: VERSION }, { instructions: INSTRUCTIONS });

  // Registra cada llamada a herramienta en el log (sin guardar el contenido de los archivos)
  const originalRegister = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => originalRegister(name, config, async (...a) => {
    const t0 = Date.now();
    const args = config.inputSchema && Object.keys(config.inputSchema).length ? a[0] : {};
    try {
      const r = await handler(...a);
      log(`tool ${name} ${r && r.isError ? "ERROR" : "ok"} ${Date.now() - t0}ms ${summarizeArgs(args)}`);
      return r;
    } catch (e) {
      log(`tool ${name} EXCEPCION ${Date.now() - t0}ms ${summarizeArgs(args)} -> ${e.message}`);
      return result(friendlyError(e), true);
    }
  });

  server.registerTool("list_files", {
    description: "Lista archivos y carpetas de un directorio (ruta relativa a la carpeta raiz; '.' es la raiz)",
    inputSchema: { path: z.string().optional() },
    annotations: RO
  }, async ({ path: p = "." }) => {
    const dir = await safeExisting(p);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const lines = [];
    for (const e of entries.slice(0, 500)) {
      if (e.isDirectory()) { lines.push(`[DIR]  ${e.name}`); continue; }
      let size = "";
      try { size = ` (${(await fs.stat(path.join(dir, e.name))).size} bytes)`; } catch {}
      lines.push(`[FILE] ${e.name}${size}`);
    }
    if (entries.length > 500) lines.push(`... y ${entries.length - 500} mas`);
    return result(lines.join("\n") || "(carpeta vacia)");
  });

  server.registerTool("read_file", {
    description: "Lee un archivo de texto. Para archivos grandes usa offset (linea inicial, desde 1) y limit (cantidad de lineas, por defecto 2000) y sigue leyendo por partes.",
    inputSchema: {
      path: z.string(),
      offset: z.number().optional().describe("Linea inicial (desde 1)"),
      limit: z.number().optional().describe("Cantidad de lineas (1-10000, por defecto 2000)")
    },
    annotations: RO
  }, async ({ path: p, offset = 1, limit = 2000 }) => {
    return result(await readTextFile(await safeExisting(p), Math.max(1, Math.floor(Number(offset) || 1)), Math.min(10000, Math.max(1, Math.floor(Number(limit) || 2000)))));
  });

  server.registerTool("read_multiple_files", {
    description: "Lee varios archivos de texto a la vez (maximo 20, primeras 800 lineas de cada uno)",
    inputSchema: { paths: z.array(z.string()).min(1).max(20) },
    annotations: RO
  }, async ({ paths }) => {
    const parts = [];
    for (const p of paths) {
      try {
        parts.push(`===== ${p} =====\n` + await readTextFile(await safeExisting(p), 1, 800));
      } catch (e) {
        parts.push(`===== ${p} =====\nERROR: ${e.message}`);
      }
    }
    return result(parts.join("\n\n"));
  });

  server.registerTool("write_file", {
    description: "Crea un archivo (y sus carpetas) o reemplaza uno existente. Con append=true agrega al final (util para escribir archivos grandes por partes). Usalo solo con autorizacion del usuario",
    inputSchema: {
      path: z.string(),
      content: z.string(),
      append: z.boolean().optional()
    },
    annotations: WR
  }, async ({ path: p, content, append = false }) => {
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new Error("Contenido demasiado grande para una sola escritura (maximo 5 MB)");
    }
    const target = await safeNew(p);
    await fs.writeFile(target, content, { encoding: "utf8", flag: append ? "a" : "w" });
    return result({ success: true, path: p, bytes: Buffer.byteLength(content, "utf8"), append });
  });

  server.registerTool("edit_file", {
    description: "Reemplaza texto exacto dentro de un archivo. Falla si el texto aparece mas de una vez, salvo que uses replaceAll=true",
    inputSchema: {
      path: z.string(),
      oldText: z.string().min(1),
      newText: z.string(),
      replaceAll: z.boolean().optional()
    },
    annotations: WR
  }, async ({ path: p, oldText, newText, replaceAll = false }) => {
    const file = await safeExisting(p);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("La ruta no es un archivo");
    if (stat.size > MAX_READ_BYTES) throw new Error("Archivo demasiado grande para editar");
    const content = await fs.readFile(file, "utf8");
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const norm = s => s.replace(/\r?\n/g, eol);
    const oldN = norm(oldText);
    const newN = norm(newText);
    const first = content.indexOf(oldN);
    if (first === -1) throw new Error("No se encontro el texto indicado");
    const count = content.split(oldN).length - 1;
    if (count > 1 && !replaceAll) {
      throw new Error(`El texto aparece ${count} veces; agrega mas contexto o usa replaceAll=true`);
    }
    const updated = replaceAll ? content.split(oldN).join(newN)
      : content.slice(0, first) + newN + content.slice(first + oldN.length);
    if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES * 4) {
      throw new Error("El archivo resultante es demasiado grande");
    }
    await fs.writeFile(file, updated, "utf8");
    return result({ success: true, path: p, replacements: replaceAll ? count : 1 });
  });

  server.registerTool("create_directory", {
    description: "Crea un directorio (y los intermedios) dentro de la carpeta autorizada",
    inputSchema: { path: z.string() },
    annotations: WR
  }, async ({ path: p }) => {
    const target = await safeNew(p);
    await fs.mkdir(target, { recursive: true });
    return result({ success: true, path: p });
  });

  server.registerTool("move_file", {
    description: "Mueve o renombra un archivo o carpeta sin sobrescribir el destino",
    inputSchema: { source: z.string(), destination: z.string() },
    annotations: WR
  }, async ({ source, destination }) => {
    const src = await safeExisting(source);
    if (src === REAL_ROOT) throw new Error("No se puede mover la carpeta raiz");
    const dest = await safeNew(destination);
    try {
      await fs.access(dest);
      throw new Error("El destino ya existe; no se sobrescribira");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.rename(src, dest);
    return result({ success: true, source, destination });
  });

  server.registerTool("get_file_info", {
    description: "Tamano, tipo y fechas de un archivo o carpeta",
    inputSchema: { path: z.string() },
    annotations: RO
  }, async ({ path: p }) => {
    const target = await safeExisting(p);
    const s = await fs.stat(target);
    return result({
      path: rel(target),
      type: s.isDirectory() ? "directory" : "file",
      bytes: s.size,
      modified: s.mtime.toISOString(),
      created: s.birthtime.toISOString()
    });
  });

  server.registerTool("directory_tree", {
    description: "Arbol de carpetas y archivos (ignora node_modules, .git, dist, etc. salvo includeIgnored=true)",
    inputSchema: {
      path: z.string().optional(),
      maxDepth: z.number().optional().describe("1 a 8 (por defecto 3)"),
      includeIgnored: z.boolean().optional()
    },
    annotations: RO
  }, async ({ path: p = ".", maxDepth = 3, includeIgnored = false }) => {
    const root = await safeExisting(p);
    maxDepth = Math.min(8, Math.max(1, Math.floor(Number(maxDepth) || 3)));
    const lines = [rel(root) + "/"];
    const counter = { n: 0 };
    async function tree(dir, depth, prefix) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      let shown = 0;
      for (const e of entries) {
        if (e.isDirectory() && !includeIgnored && IGNORE_DIRS.has(e.name)) {
          lines.push(`${prefix}${e.name}/  (omitido)`);
          continue;
        }
        if (counter.n >= 1500 || shown >= 200) { lines.push(`${prefix}... (hay mas entradas)`); break; }
        counter.n++; shown++;
        if (e.isDirectory()) {
          lines.push(`${prefix}${e.name}/`);
          if (depth < maxDepth) await tree(path.join(dir, e.name), depth + 1, prefix + "  ");
        } else {
          lines.push(`${prefix}${e.name}`);
        }
      }
    }
    await tree(root, 1, "  ");
    return result(lines.join("\n"));
  });

  server.registerTool("search_files", {
    description: "Busca archivos y carpetas por parte del nombre (ignora node_modules, .git, dist, etc.)",
    inputSchema: { query: z.string().min(1), path: z.string().optional() },
    annotations: RO
  }, async ({ query, path: p = "." }) => {
    const root = await safeExisting(p);
    const needle = query.toLowerCase();
    const matches = [];
    for await (const f of walkFiles(root)) {
      if (f.name.toLowerCase().includes(needle)) matches.push(rel(f.full) + (f.isDir ? "/" : ""));
      if (matches.length >= 300) break;
    }
    return result(matches.length ? matches.join("\n") : "Sin coincidencias");
  });

  server.registerTool("search_in_files", {
    description: "Busca texto (o regex) DENTRO de los archivos de texto, como grep. Devuelve archivo:linea: contenido. Ignora node_modules, .git, dist, etc.",
    inputSchema: {
      query: z.string().min(1),
      path: z.string().optional(),
      include: z.string().optional().describe('Filtro por nombre de archivo, ej: "*.js,*.ts"'),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      maxResults: z.number().optional().describe("1 a 500 (por defecto 100)")
    },
    annotations: RO
  }, async ({ query, path: p = ".", include, regex = false, caseSensitive = false, maxResults = 100 }) => {
    const root = await safeExisting(p);
    maxResults = Math.min(500, Math.max(1, Math.floor(Number(maxResults) || 100)));
    const filter = makeFileFilter(include);
    let re;
    try {
      re = new RegExp(regex ? query : escapeRegex(query), caseSensitive ? "" : "i");
    } catch (e) {
      throw new Error("Regex invalida: " + e.message);
    }
    const st = await fs.stat(root);
    const source = st.isFile() ? [{ full: root, name: path.basename(root), isDir: false }] : walkFiles(root);
    const matches = [];
    let scanned = 0;
    for await (const f of source) {
      if (f.isDir || !filter(f.name)) continue;
      let s, buf;
      try { s = await fs.stat(f.full); } catch { continue; }
      if (s.size > 2 * 1024 * 1024) continue;
      try { buf = await fs.readFile(f.full); } catch { continue; }
      if (buf.subarray(0, 8000).includes(0)) continue;
      scanned++;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${rel(f.full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= maxResults) break;
        }
      }
      if (matches.length >= maxResults) break;
    }
    if (!matches.length) return result(`Sin coincidencias (${scanned} archivos revisados)`);
    const limit = matches.length >= maxResults ? ", limite alcanzado" : "";
    return result(`${matches.join("\n")}\n\n[${matches.length} coincidencias, ${scanned} archivos revisados${limit}]`);
  });

  server.registerTool("server_info", {
    description: "Estado del servidor: version, carpeta raiz, si los comandos estan activos, procesos en segundo plano y guia rapida de uso. Llamala si dudas del estado o de como usar las herramientas.",
    inputSchema: {},
    annotations: RO
  }, async () => {
    const running = [...background.values()].filter(b => !b.exited).length;
    return result({
      estado: "servidor funcionando",
      version: VERSION,
      carpeta_raiz: REAL_ROOT,
      comandos_activados: COMMANDS_ENABLED,
      segundos_encendido: Math.round((Date.now() - STARTED) / 1000),
      procesos_en_segundo_plano: running,
      guia: INSTRUCTIONS.split("\n")
    });
  });

  if (COMMANDS_ENABLED) {
    server.registerTool("run_command", {
      description: "Ejecuta un comando de PowerShell (Windows, NO bash) en la PC del usuario y devuelve estado, exit code, salida y stderr por separado. Exit code 0 = exito aunque haya texto en stderr. Maximo 90 s (limite del tunel): para instalaciones, servidores o procesos largos usa start_background_command. Los comandos destructivos piden confirmDangerous=true tras preguntar al usuario. Ojo: el comando NO esta limitado a la carpeta raiz.",
      inputSchema: {
        command: z.string().min(1).max(6000),
        cwd: z.string().optional().describe("Carpeta de trabajo relativa a la raiz (por defecto '.')"),
        timeoutSeconds: z.number().optional().describe("1 a 90 segundos (por defecto 60)"),
        confirmDangerous: z.boolean().optional().describe("Solo true si el usuario ya aprobo este comando destructivo en el chat")
      },
      annotations: CMD
    }, async ({ command, cwd = ".", timeoutSeconds = 60, confirmDangerous = false }) => {
      const why = dangerReason(command);
      if (why && !confirmDangerous) return result(dangerMessage(why));
      const secs = Math.min(90, Math.max(1, Math.floor(Number(timeoutSeconds) || 60)));
      const dir = await safeExisting(cwd);
      const t0 = Date.now();
      return new Promise(resolve => {
        let out = "", err = "", timedOut = false;
        const child = spawnPs(command, dir);
        const cap = MAX_OUTPUT_CHARS * 2;
        child.stdout.on("data", d => { out += d; if (out.length > cap) out = out.slice(-cap); });
        child.stderr.on("data", d => { err += d; if (err.length > cap) err = err.slice(-cap); });
        const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, secs * 1000);
        child.on("error", e => {
          clearTimeout(timer);
          resolve(result("[ERROR] No se pudo iniciar PowerShell: " + e.message + "\nPISTA: es un fallo del sistema al lanzar el proceso; reintenta una vez.", true));
        });
        child.on("close", code => {
          clearTimeout(timer);
          resolve(result(formatRun({ command, code, timedOut, ms: Date.now() - t0, cwd: rel(dir), out, err, secs }), timedOut || code !== 0));
        });
      });
    });

    server.registerTool("start_background_command", {
      description: "Inicia un comando de PowerShell en segundo plano (npm run dev, servidores, watchers, instalaciones largas). Devuelve un id y las primeras lineas de salida; luego usa read_background_output y stop_background_command.",
      inputSchema: {
        command: z.string().min(1).max(6000),
        cwd: z.string().optional(),
        confirmDangerous: z.boolean().optional().describe("Solo true si el usuario ya aprobo este comando destructivo en el chat")
      },
      annotations: CMD
    }, async ({ command, cwd = ".", confirmDangerous = false }) => {
      const why = dangerReason(command);
      if (why && !confirmDangerous) return result(dangerMessage(why));
      const dir = await safeExisting(cwd);
      if ([...background.values()].filter(b => !b.exited).length >= 5) {
        throw new Error("Ya hay 5 procesos en segundo plano; detén alguno con stop_background_command");
      }
      const id = "bg" + (++backgroundSeq);
      const child = spawnPs(command, dir);
      const entry = { id, command, cwd: rel(dir), child, out: "", dropped: 0, readUpTo: 0, exited: false, code: null };
      const add = d => {
        entry.out += d;
        if (entry.out.length > 400000) {
          const cut = entry.out.length - 300000;
          entry.out = entry.out.slice(cut);
          entry.dropped += cut;
        }
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      child.on("error", e => { add(`\n[error: ${e.message}]\n`); entry.exited = true; });
      child.on("close", code => { entry.exited = true; entry.code = code; });
      background.set(id, entry);
      await new Promise(r => setTimeout(r, 1500));
      entry.readUpTo = entry.dropped + entry.out.length;
      return result({
        id, pid: child.pid, corriendo: !entry.exited,
        salida_inicial: tailText(entry.out, 3000).trim() || "(aun sin salida)",
        siguiente_paso: `usa read_background_output con id "${id}" para ver mas salida`
      });
    });

    server.registerTool("read_background_output", {
      description: "Lee la salida NUEVA de un proceso en segundo plano desde la ultima lectura y dice si sigue corriendo",
      inputSchema: { id: z.string() },
      annotations: RO
    }, async ({ id }) => {
      const e = background.get(id);
      if (!e) throw new Error(`No existe el proceso "${id}". Usa list_background_commands para ver los ids vigentes.`);
      const from = Math.max(e.readUpTo, e.dropped);
      const text = e.out.slice(from - e.dropped);
      e.readUpTo = e.dropped + e.out.length;
      return result(`[${e.exited ? `terminado, exit code ${e.code}` : "corriendo"}]\n` + (tailText(text).trim() || "(sin salida nueva)"));
    });

    server.registerTool("stop_background_command", {
      description: "Detiene un proceso en segundo plano (y sus procesos hijos)",
      inputSchema: { id: z.string() },
      annotations: CMD
    }, async ({ id }) => {
      const e = background.get(id);
      if (!e) throw new Error(`No existe el proceso "${id}". Usa list_background_commands para ver los ids vigentes.`);
      if (!e.exited) killTree(e.child.pid);
      return result({ id, detenido: true });
    });

    server.registerTool("list_background_commands", {
      description: "Lista los procesos en segundo plano iniciados",
      inputSchema: {},
      annotations: RO
    }, async () => {
      const list = [...background.values()].map(b => ({
        id: b.id, command: b.command.slice(0, 120), cwd: b.cwd,
        estado: b.exited ? `terminado (${b.code})` : "corriendo"
      }));
      return result(list.length ? list : "No hay procesos en segundo plano");
    });
  }

  return server;
}

// ---------------------------------------------------------------- HTTP
const methodNotAllowed = (req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "local-project-filesystem", version: VERSION });
});

app.post("/mcp", async (req, res) => {
  if (!tokenOk((req.headers.authorization || "").replace(/^Bearer /, ""))) {
    log("rpc 401 (token incorrecto)");
    return res.status(401).json({ error: "No autorizado" });
  }
  log("rpc " + ((req.body && req.body.method) || "?"));
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error MCP:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "Error interno MCP" });
  }
});

process.on("exit", () => { for (const b of background.values()) if (!b.exited) killTree(b.child.pid); });

initializeRoot().then(() => {
  app.listen(PORT, "127.0.0.1", () => {
    console.log("==================================");
    console.log(` MCP FILESYSTEM ${VERSION}`);
    console.log("==================================");
    console.log(`Endpoint: http://127.0.0.1:${PORT}/mcp/<token>`);
    console.log("Token en:", TOKEN_FILE);
    console.log("Carpeta:", REAL_ROOT);
    console.log("Herramientas de archivos/estado: 12");
    console.log("Comandos:", COMMANDS_ENABLED ? "ACTIVADOS (5 herramientas)" : "desactivados");
    console.log("Escucha local: 127.0.0.1");
    console.log("Log de llamadas:", LOG_FILE);
    log(`=== servidor iniciado v${VERSION} (comandos ${COMMANDS_ENABLED ? "on" : "off"}) ===`);
  });
}).catch(error => {
  console.error("No se pudo iniciar:", error);
  process.exit(1);
});
