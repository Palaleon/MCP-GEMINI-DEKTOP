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

// ---------------------------------------------------------------- Colores ANSI
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[37m", gray: "\x1b[90m"
};

// ---------------------------------------------------------------- Config
const VERSION = "3.4.0"; // Claude Code Parity
const ROOT = path.resolve(process.env.MCP_ROOT || "C:\\Users\\ASD\\Documents\\proyectos");
const PORT = 3000;
const MAX_READ_BYTES = 20 * 1024 * 1024;   
const MAX_WRITE_BYTES = 5 * 1024 * 1024;   
const MAX_OUTPUT_CHARS = 80000;            
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

// Log de llamadas
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
    const clone = { ...args };
    delete clone.rationale; 
    return JSON.stringify(clone, (k, v) => (k === "content" || k === "newContent" ? `<${String(v).length} chars>` : v)).slice(0, 300);
  } catch { return "?"; }
}

const app = express();
app.use(express.json({ limit: "10mb" }));

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
  throw new Error(`La ruta "${raw}" no existe. Rutas relativas a la carpeta raiz "${rn}" ('.' es la raiz).`);
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
  "ERES UN AGENTE AUTÓNOMO CON ACCESO REAL A LA PC DEL USUARIO (Windows).",
  "Usa las herramientas directamente. NUNCA digas que no tienes acceso sin intentarlo primero.",
  "Reglas Principales:",
  "1. AL INICIAR UN CHAT NUEVO: Llama SIEMPRE a 'get_project_context' para orientarte en el proyecto actual. No preguntes de que trata el proyecto, averigualo tu mismo.",
  "2. ANTES DE ACCIONES GRANDES: Llama SIEMPRE a 'console_message' para imprimir tus tareas en la pantalla del usuario a color y mantenerlo informado.",
  "3. BUSQUEDA INTELIGENTE: Usa 'search_in_files' que ahora te devuelve bloques de contexto (AST-like) en vez de lineas sueltas.",
  "4. EDICION QUIRURGICA: Usa 'patch_file' para reemplazar lineas exactas de codigo sin lidiar con los problemas de espacios de 'edit_file'.",
  "5. COMANDOS AUTONOMOS: Usa 'run_command' para git, npm, o powershell. Tienes autonomia total. NO NECESITAS PEDIR PERMISO. Exito = exit code 0.",
  "6. TRANSPARENCIA OBLIGATORIA: En herramientas de modificacion, completa siempre el campo 'rationale' para que el usuario sepa por que haces eso."
].join("\n");

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
  return s.length > max ? "[...salida recortada...]\n" + s.slice(-max) : s;
}

const background = new Map();
let backgroundSeq = 0;

function hintFor({ command, code, timedOut, secs, out, err }) {
  const all = out + "\n" + err;
  if (timedOut) return `Timeout tras ${secs}s. Usa start_background_command para procesos largos.`;
  if (/git\s+commit/i.test(command || "") && /nothing to commit/i.test(all)) return "No habia cambios para commitear.";
  if (/EADDRINUSE/i.test(all)) return "El puerto ya esta en uso.";
  if (code === 0 && err.trim()) return "Exit code 0 = EXITO. El stderr son avisos.";
  return "";
}

function formatRun({ command, code, timedOut, ms, cwd, out, err, secs }) {
  const status = timedOut ? "TIMEOUT" : code === 0 ? "OK" : "ERROR";
  const o = tailText(out).trim();
  const e = tailText(err, 20000).trim();
  let t = `[${status}] ${timedOut ? "timeout" : "exit code " + code} | ${(ms / 1000).toFixed(1)}s | cwd: ${cwd}\n`;
  if (o) t += `\n--- stdout ---\n${o}\n`;
  if (e) t += `\n--- stderr ---\n${e}\n`;
  if (!o && !e) t += "\n(sin salida)\n";
  const h = hintFor({ command, code, timedOut, secs, out: o, err: e });
  if (h) t += `\nPISTA: ${h}\n`;
  return t;
}

function friendlyError(e) {
  let out = "ERROR en la herramienta: " + (e.message || String(e));
  out += "\n(Error de ESTA llamada, ajusta parametros y reintenta.)";
  return out;
}

// ---------------------------------------------------------------- Playwright
let pw = null;
let pwBrowser = null;
let pwPage = null;

async function getBrowser() {
  if (!pw) {
    try { pw = require("playwright"); } 
    catch (e) { throw new Error("Playwright no esta instalado."); }
  }
  if (!pwBrowser) {
    console.log(`\n${C.cyan}${C.bold}▶ INICIANDO NAVEGADOR PLAYWRIGHT (Visible)...${C.reset}\n`);
    pwBrowser = await pw.chromium.launch({ headless: false }); 
    const context = await pwBrowser.newContext();
    pwPage = await context.newPage();
  }
  return pwPage;
}

// ---------------------------------------------------------------- Servidor MCP
function createServer() {
  const server = new McpServer({ name: "local-project-filesystem", version: VERSION }, { instructions: INSTRUCTIONS });

  const originalRegister = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => originalRegister(name, config, async (...a) => {
    const t0 = Date.now();
    const args = config.inputSchema && Object.keys(config.inputSchema).length ? a[0] : {};
    
    // Log Interceptor a la consola
    if (name !== "console_message") {
      console.log(`\n${C.cyan}▶ LLAMANDO HERRAMIENTA:${C.reset} ${C.bold}${name}${C.reset}`);
      if (args.rationale) {
        console.log(`${C.yellow}💡 Razón: ${args.rationale}${C.reset}`);
      }
      console.log(`${C.gray}  Params: ${summarizeArgs(args)}${C.reset}`);
    }

    try {
      const r = await handler(...a);
      const ms = Date.now() - t0;
      if (name !== "console_message") {
        if (r && r.isError) console.log(`${C.red}✖ ERROR EN ${name} (${ms}ms)${C.reset}`);
        else console.log(`${C.green}✔ OK ${name} (${ms}ms)${C.reset}`);
      }
      log(`tool ${name} ${r && r.isError ? "ERROR" : "ok"} ${ms}ms ${summarizeArgs(args)}`);
      return r;
    } catch (e) {
      const ms = Date.now() - t0;
      console.log(`${C.red}✖ EXCEPCION EN ${name} (${ms}ms): ${e.message}${C.reset}`);
      log(`tool ${name} EXCEPCION ${ms}ms -> ${e.message}`);
      return result(friendlyError(e), true);
    }
  });

  // --- Herramientas de IA y Proyecto (Claude Code Parity) ---
  server.registerTool("console_message", {
    description: "Imprime tu razonamiento y tareas en la consola del usuario a todo color.",
    inputSchema: {
      thought: z.string().describe("Tu pensamiento o explicacion"),
      tasks: z.array(z.object({ task: z.string(), status: z.enum(["completada", "en proceso", "pendiente"]) })).optional()
    },
    annotations: RO
  }, async ({ thought, tasks }) => {
    console.log(`\n${C.magenta}${C.bold}======================================${C.reset}`);
    console.log(`${C.magenta}${C.bold}🤖 GEMINI: ESTADO DE TAREAS Y RAZONAMIENTO${C.reset}`);
    console.log(`${C.magenta}${C.bold}======================================${C.reset}`);
    if (tasks && tasks.length) {
      for (const t of tasks) {
        let icon = "[ ]", color = C.white;
        if (t.status === "completada") { icon = "[✔]"; color = C.green; }
        else if (t.status === "en proceso") { icon = "[➤]"; color = C.yellow; }
        console.log(`${color}${icon} ${t.task} - (${t.status})${C.reset}`);
      }
      console.log(`${C.magenta}${C.bold}--------------------------------------${C.reset}`);
    }
    console.log(`${C.cyan}💭 Pensamiento: ${C.white}${thought}${C.reset}`);
    console.log(`${C.magenta}${C.bold}======================================${C.reset}\n`);
    return result("Mensaje mostrado.");
  });

  server.registerTool("get_project_context", {
    description: "Llamala al iniciar. Extrae la estructura raiz, package.json, y reglas (.geminirules.md) para que entiendas el proyecto sin preguntar.",
    inputSchema: { rationale: z.string().optional() },
    annotations: RO
  }, async () => {
    let ctx = "============================\nCONTEXTO GLOBAL DEL PROYECTO\n============================\n\n";
    try {
      const dirs = (await fs.readdir(REAL_ROOT, {withFileTypes: true}))
                   .filter(d=>d.isDirectory() && !IGNORE_DIRS.has(d.name))
                   .map(d=>d.name);
      ctx += `[Carpetas Raíz]: ${dirs.join(", ")}\n\n`;
    } catch(e){}
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(REAL_ROOT, "package.json"), "utf8"));
      ctx += `[package.json -> Dependencias]: ${Object.keys(pkg.dependencies||{}).join(", ")}\n`;
      ctx += `[package.json -> Scripts]: ${Object.keys(pkg.scripts||{}).join(", ")}\n\n`;
    } catch(e) {}
    for (const ruleFile of [".geminirules.md", ".cursorrules", "README.md"]) {
      try {
        const rules = await fs.readFile(path.join(REAL_ROOT, ruleFile), "utf8");
        ctx += `--- Contenido de ${ruleFile} ---\n${rules.slice(0, 1500)}\n\n`;
      } catch(e) {}
    }
    return result(ctx || "Proyecto vacio o sin metadatos estandar.");
  });

  // --- Archivos (Edicion Quirurgica) ---
  server.registerTool("patch_file", {
    description: "Reemplaza un bloque exacto de lineas en un archivo. Mejor que edit_file para codigo.",
    inputSchema: {
      path: z.string(),
      startLine: z.number().describe("Linea inicial a borrar/reemplazar (inclusive, desde 1)"),
      endLine: z.number().describe("Linea final a borrar/reemplazar (inclusive, desde 1)"),
      newContent: z.string().describe("El nuevo codigo que se insertara ahi"),
      rationale: z.string().describe("Por que haces este parche")
    },
    annotations: WR
  }, async ({ path: p, startLine, endLine, newContent }) => {
    const file = await safeExisting(p);
    const content = await fs.readFile(file, "utf8");
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.split(/\r?\n/);
    if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
      throw new Error(`Rango invalido. Archivo tiene ${lines.length} lineas.`);
    }
    lines.splice(startLine - 1, endLine - startLine + 1, newContent);
    await fs.writeFile(file, lines.join(eol), "utf8");
    return result({ success: true, path: p, linesPatched: `${startLine}-${endLine}` });
  });

  server.registerTool("write_file", {
    description: "Crea o sobrescribe un archivo completo.",
    inputSchema: {
      path: z.string(), content: z.string(), append: z.boolean().optional(),
      rationale: z.string().describe("Razón de la modificación")
    },
    annotations: WR
  }, async ({ path: p, content, append = false }) => {
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) throw new Error("Contenido muy grande");
    const target = await safeNew(p);
    await fs.writeFile(target, content, { encoding: "utf8", flag: append ? "a" : "w" });
    return result({ success: true, path: p, append });
  });

  server.registerTool("edit_file", {
    description: "Reemplaza texto exacto.",
    inputSchema: { 
      path: z.string(), oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().optional(),
      rationale: z.string().describe("Razón de la modificación")
    },
    annotations: WR
  }, async ({ path: p, oldText, newText, replaceAll = false }) => {
    const file = await safeExisting(p);
    const content = await fs.readFile(file, "utf8");
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const norm = s => s.replace(/\r?\n/g, eol);
    const oldN = norm(oldText), newN = norm(newText);
    const first = content.indexOf(oldN);
    if (first === -1) throw new Error("Texto no encontrado");
    const count = content.split(oldN).length - 1;
    if (count > 1 && !replaceAll) throw new Error(`Texto aparece ${count} veces; usa replaceAll=true`);
    const updated = replaceAll ? content.split(oldN).join(newN) : content.slice(0, first) + newN + content.slice(first + oldN.length);
    await fs.writeFile(file, updated, "utf8");
    return result({ success: true, path: p });
  });

  server.registerTool("search_in_files", {
    description: "Busca texto (Grep AST-like). Devuelve lineas con contexto arriba y abajo.",
    inputSchema: { 
      query: z.string().min(1), path: z.string().optional(), include: z.string().optional(), 
      regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), maxResults: z.number().optional() 
    },
    annotations: RO
  }, async ({ query, path: p = ".", include, regex = false, caseSensitive = false, maxResults = 100 }) => {
    const root = await safeExisting(p);
    maxResults = Math.min(500, Math.max(1, Math.floor(Number(maxResults) || 100)));
    const filter = makeFileFilter(include);
    let re = new RegExp(regex ? query : escapeRegex(query), caseSensitive ? "" : "i");
    const source = (await fs.stat(root)).isFile() ? [{ full: root, name: path.basename(root), isDir: false }] : walkFiles(root);
    
    let resultText = "";
    let matchesCount = 0;
    
    for await (const f of source) {
      if (f.isDir || !filter(f.name)) continue;
      try {
        if ((await fs.stat(f.full)).size > 2 * 1024 * 1024) continue;
        const buf = await fs.readFile(f.full);
        if (buf.subarray(0, 8000).includes(0)) continue;
        
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matchesCount++;
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length - 1, i + 2);
            resultText += `\n[Archivo: ${rel(f.full)}]\n`;
            for (let j = start; j <= end; j++) {
              resultText += `${j === i ? ">>" : "  "} ${j + 1}: ${lines[j].trim()}\n`;
            }
            if (matchesCount >= maxResults) break;
          }
        }
      } catch {}
      if (matchesCount >= maxResults) break;
    }
    return result(resultText.trim() || "Sin coincidencias");
  });

  server.registerTool("read_file", {
    description: "Lee un archivo por partes.",
    inputSchema: { path: z.string(), offset: z.number().optional(), limit: z.number().optional() },
    annotations: RO
  }, async ({ path: p, offset = 1, limit = 2000 }) => {
    return result(await readTextFile(await safeExisting(p), Math.max(1, Math.floor(Number(offset) || 1)), Math.min(10000, Math.max(1, Math.floor(Number(limit) || 2000)))));
  });

  server.registerTool("list_files", {
    description: "Lista archivos y carpetas", inputSchema: { path: z.string().optional() }, annotations: RO
  }, async ({ path: p = "." }) => {
    const dir = await safeExisting(p);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const lines = [];
    for (const e of entries.slice(0, 500)) {
      if (e.isDirectory()) { lines.push(`[DIR]  ${e.name}`); continue; }
      lines.push(`[FILE] ${e.name}`);
    }
    return result(lines.join("\n") || "(carpeta vacia)");
  });

  server.registerTool("directory_tree", {
    description: "Arbol de directorios",
    inputSchema: { path: z.string().optional(), maxDepth: z.number().optional() }, annotations: RO
  }, async ({ path: p = ".", maxDepth = 3 }) => {
    const root = await safeExisting(p);
    const lines = [rel(root) + "/"];
    const counter = { n: 0 };
    async function tree(dir, depth, prefix) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      let shown = 0;
      for (const e of entries) {
        if (e.isDirectory() && IGNORE_DIRS.has(e.name)) { lines.push(`${prefix}${e.name}/ (omitido)`); continue; }
        if (counter.n >= 1500 || shown >= 200) { lines.push(`${prefix}...`); break; }
        counter.n++; shown++;
        if (e.isDirectory()) {
          lines.push(`${prefix}${e.name}/`);
          if (depth < maxDepth) await tree(path.join(dir, e.name), depth + 1, prefix + "  ");
        } else { lines.push(`${prefix}${e.name}`); }
      }
    }
    await tree(root, 1, "  ");
    return result(lines.join("\n"));
  });

  // --- Comandos Autonomos ---
  if (COMMANDS_ENABLED) {
    server.registerTool("run_command", {
      description: "Ejecuta PowerShell. TOTAL AUTONOMIA.",
      inputSchema: { 
        command: z.string(), cwd: z.string().optional(), timeoutSeconds: z.number().optional(),
        rationale: z.string().describe("Por que ejecutas esto")
      },
      annotations: CMD
    }, async ({ command, cwd = ".", timeoutSeconds = 60 }) => {
      const secs = Math.min(90, Math.max(1, Math.floor(Number(timeoutSeconds) || 60)));
      const dir = await safeExisting(cwd);
      const t0 = Date.now();
      return new Promise(resolve => {
        let out = "", err = "", timedOut = false;
        const child = spawnPs(command, dir);
        child.stdout.on("data", d => { out += d; if (out.length > MAX_OUTPUT_CHARS*2) out = out.slice(-MAX_OUTPUT_CHARS*2); });
        child.stderr.on("data", d => { err += d; if (err.length > MAX_OUTPUT_CHARS*2) err = err.slice(-MAX_OUTPUT_CHARS*2); });
        const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, secs * 1000);
        child.on("error", e => { clearTimeout(timer); resolve(result("[ERROR] " + e.message, true)); });
        child.on("close", code => {
          clearTimeout(timer);
          resolve(result(formatRun({ command, code, timedOut, ms: Date.now() - t0, cwd: rel(dir), out, err, secs }), timedOut || code !== 0));
        });
      });
    });

    server.registerTool("start_background_command", {
      description: "Proceso 2do plano.",
      inputSchema: { command: z.string(), cwd: z.string().optional(), rationale: z.string() }, annotations: CMD
    }, async ({ command, cwd = "." }) => {
      const dir = await safeExisting(cwd);
      const id = "bg" + (++backgroundSeq);
      const child = spawnPs(command, dir);
      const entry = { id, command, cwd: rel(dir), child, out: "", dropped: 0, readUpTo: 0, exited: false, code: null };
      const add = d => { entry.out += d; };
      child.stdout.on("data", add); child.stderr.on("data", add);
      child.on("error", e => { add(`\n[error: ${e.message}]\n`); entry.exited = true; });
      child.on("close", code => { entry.exited = true; entry.code = code; });
      background.set(id, entry);
      await new Promise(r => setTimeout(r, 1500));
      entry.readUpTo = entry.out.length;
      return result({ id, pid: child.pid, corriendo: !entry.exited, salida: tailText(entry.out, 3000) });
    });

    server.registerTool("read_background_output", { description: "Lee proceso", inputSchema: { id: z.string() }, annotations: RO }, async ({ id }) => {
      const e = background.get(id); if (!e) throw new Error("No existe");
      const text = e.out.slice(e.readUpTo); e.readUpTo = e.out.length;
      return result(`[${e.exited ? "terminado" : "corriendo"}]\n` + text);
    });

    server.registerTool("stop_background_command", { description: "Detiene proceso", inputSchema: { id: z.string(), rationale: z.string() }, annotations: CMD }, async ({ id }) => {
      const e = background.get(id); if (!e) throw new Error("No existe");
      if (!e.exited) killTree(e.child.pid); return result({ id, detenido: true });
    });
  }

  // --- Playwright Extra Tools ---
  server.registerTool("browser_navigate", {
    description: "Abre URL visible", inputSchema: { url: z.string(), rationale: z.string().optional() }, annotations: RO
  }, async ({ url }) => {
    const page = await getBrowser();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    return result(`Navegado a ${url}`);
  });
  
  server.registerTool("browser_evaluate", {
    description: "JS en el navegador.", inputSchema: { script: z.string(), rationale: z.string().optional() }, annotations: RO
  }, async ({ script }) => {
    const page = await getBrowser(); return result(await page.evaluate(script));
  });

  server.registerTool("browser_click", {
    description: "Clic en elemento.", inputSchema: { selector: z.string(), rationale: z.string() }, annotations: WR
  }, async ({ selector }) => {
    const page = await getBrowser(); await page.click(selector, { timeout: 10000 }); return result(`Clic en ${selector}`);
  });

  server.registerTool("browser_close", {
    description: "Cierra navegador.", inputSchema: { rationale: z.string().optional() }, annotations: WR
  }, async () => {
    if (pwBrowser) { await pwBrowser.close(); pwBrowser = null; pwPage = null; return result("Navegador cerrado."); }
    return result("No abierto.");
  });

  return server;
}

// ---------------------------------------------------------------- HTTP
const methodNotAllowed = (req, res) => res.status(405).json({ error: "Method not allowed" });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);
app.get("/health", (req, res) => res.json({ status: "ok", version: VERSION }));

app.post("/mcp", async (req, res) => {
  if (!tokenOk((req.headers.authorization || "").replace(/^Bearer /, ""))) return res.status(401).json({ error: "No autorizado" });
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: "Error MCP" });
  }
});

process.on("exit", () => {
  if (pwBrowser) { try { pwBrowser.close(); } catch(e){} }
  for (const b of background.values()) if (!b.exited) killTree(b.child.pid); 
});

initializeRoot().then(() => {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`\n${C.magenta}${C.bold}==================================${C.reset}`);
    console.log(`${C.magenta}${C.bold} MCP FILESYSTEM ${VERSION} (CLAUDE-PARITY) ${C.reset}`);
    console.log(`${C.magenta}${C.bold}==================================${C.reset}`);
    console.log(`${C.cyan}Endpoint:${C.reset} http://127.0.0.1:${PORT}/mcp/<token>`);
    console.log(`${C.cyan}Carpeta:${C.reset}  ${REAL_ROOT}`);
    console.log(`${C.green}▶ MODO CLAUDE CODE ACTIVADO: Auto-Onboarding, AST-Grep y Patch File.${C.reset}`);
    console.log(`${C.green}▶ AUTONOMÍA TOTAL (Sin confirmación manual).${C.reset}\n`);
  });
}).catch(error => {
  console.error("No se pudo iniciar:", error);
  process.exit(1);
});