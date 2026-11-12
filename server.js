"use strict";
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fsSync = require("fs");
const fs = require("fs/promises");
const { spawn } = require("child_process");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[37m", gray: "\x1b[90m"
};

const VERSION = "3.6.0"; // Dynamic Task Engine
const ROOT = path.resolve(process.env.MCP_ROOT || "C:\\Users\\ASD\\Documents\\proyectos");
const PORT = 41337;
const MAX_READ_BYTES = 20 * 1024 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 80000;
const COMMANDS_ENABLED = process.env.MCP_COMMANDS !== "0";
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out", "coverage",
  "__pycache__", ".venv", "venv", ".cache", ".turbo", ".parcel-cache"
]);

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

let REAL_ROOT;
async function initializeRoot() {
  REAL_ROOT = await fs.realpath(ROOT);
  const stat = await fs.stat(REAL_ROOT);
  if (!stat.isDirectory()) throw new Error("La carpeta autorizada no es un directorio");
}

function insideRoot(target) {
  const relative = path.relative(REAL_ROOT, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
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
  const out = { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
  if (isError) out.isError = true;
  return out;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

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
    } else if (e.isFile()) { yield { full, name: e.name, isDir: false }; }
  }
}

async function readTextFile(file, offset = 1, limit = 2000) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("La ruta no es un archivo");
  if (stat.size > MAX_READ_BYTES) throw new Error(`Archivo demasiado grande (${stat.size} bytes)`);
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) throw new Error("Parece un archivo binario");
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
  if (end < total) text += `\n\n[... mostrando lineas ${start}-${end} de ${total}. Usa offset=${end + 1} para continuar]`;
  return text;
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WR = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const CMD = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const STARTED = Date.now();

const INSTRUCTIONS = [
  "ERES UN AGENTE AUTÓNOMO CON ACCESO REAL A LA PC DEL USUARIO (Windows).",
  "1. AL INICIAR: Llama a 'get_project_context' para orientarte.",
  "2. GESTION DE TAREAS DINAMICA (v3.6.0):",
  "   - Tienes una memoria persistente en el servidor. Cada tarea debe tener un 'id' (ej. T1, T2).",
  "   - Usa 'console_message' con 'action: create' para crear tareas al inicio de un plan.",
  "   - Usa 'console_message' con 'action: update' repetidamente para cambiar el status a 'completada' y añadir logs en 'sub_steps'.",
  "3. COMANDOS AUTONOMOS: Usa 'run_command' libremente. No necesitas pedir permiso."
].join("\n");

function stripStderrRedirect(cmd) {
  let out = "", q = null;
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
    "try {", stripStderrRedirect(command), "} catch {",
    "[Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message)",
    "$global:LASTEXITCODE=1", "}",
    "exit $global:LASTEXITCODE", ""
  ].join("\r\n");
}

function spawnPs(command, cwd) {
  const file = path.join(os.tmpdir(), "mcp-cmd-" + crypto.randomBytes(6).toString("hex") + ".ps1");
  fsSync.writeFileSync(file, "\uFEFF" + buildScript(command), "utf8");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
      cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
    });
  const cleanup = () => { try { fsSync.unlinkSync(file); } catch {} };
  child.on("close", cleanup); child.on("error", cleanup);
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

// ==========================================
// ESTADO EN MEMORIA DE TAREAS Y CONSOLA (v3.6.0)
// ==========================================
const taskState = new Map();

function printTasks(thought) {
  console.clear();
  console.log(`\n${C.magenta}${C.bold}======================================${C.reset}`);
  console.log(`${C.magenta}${C.bold}🤖 GEMINI: CENTRO DE MANDO Y TAREAS${C.reset}`);
  console.log(`${C.magenta}${C.bold}======================================${C.reset}`);
  
  if (taskState.size > 0) {
    for (const [id, t] of taskState.entries()) {
      let icon = "[ ]", color = C.white;
      if (t.status === "completada") { icon = "[✔]"; color = C.green; } 
      else if (t.status === "en proceso") { icon = "[➤]"; color = C.yellow; }
      else if (t.status === "error") { icon = "[✖]"; color = C.red; }
      
      console.log(`${color}${icon} [${id}] ${t.title} - (${t.status})${C.reset}`);
      
      if (t.sub_steps && t.sub_steps.length > 0) {
        for (const step of t.sub_steps) {
           console.log(`      ${C.gray}└─ ${step}${C.reset}`);
        }
      }
    }
    console.log(`${C.magenta}${C.bold}--------------------------------------${C.reset}`);
  }
  
  if (thought) {
    console.log(`${C.cyan}💭 Pensamiento: ${C.white}${thought}${C.reset}`);
  }
  console.log(`${C.magenta}${C.bold}======================================${C.reset}\n`);
}


function formatRun({ command, code, timedOut, ms, cwd, out, err, secs }) {
  const status = timedOut ? "TIMEOUT" : code === 0 ? "OK" : "ERROR";
  const o = tailText(out).trim();
  const e = tailText(err, 20000).trim();
  let t = `[${status}] ${timedOut ? "timeout" : "exit code " + code} | ${(ms / 1000).toFixed(1)}s | cwd: ${cwd}\n`;
  if (o) t += `\n--- stdout ---\n${o}\n`;
  if (e) t += `\n--- stderr ---\n${e}\n`;
  if (!o && !e) t += "\n(sin salida)\n";
  return t;
}

function friendlyError(e) { return "ERROR en la herramienta: " + (e.message || String(e)) + "\n(Error de ESTA llamada, ajusta parametros y reintenta.)"; }

let pw = null, pwBrowser = null, pwPage = null;
async function getBrowser() {
  if (!pw) { try { pw = require("playwright"); } catch (e) { throw new Error("Playwright no esta instalado."); } }
  if (!pwBrowser) {
    console.log(`\n${C.cyan}${C.bold}▶ INICIANDO NAVEGADOR PLAYWRIGHT...${C.reset}\n`);
    pwBrowser = await pw.chromium.launch({ headless: false }); 
    pwPage = await (await pwBrowser.newContext()).newPage();
  }
  return pwPage;
}

function createServer() {
  const server = new McpServer({ name: "local-project-filesystem", version: VERSION }, { instructions: INSTRUCTIONS });
  const originalRegister = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => originalRegister(name, config, async (...a) => {
    const t0 = Date.now();
    const args = config.inputSchema && Object.keys(config.inputSchema).length ? a[0] : {};
    
    if (name !== "console_message") {
      console.log(`\n${C.cyan}▶ LLAMANDO HERRAMIENTA:${C.reset} ${C.bold}${name}${C.reset}`);
      if (args.rationale) console.log(`${C.yellow}💡 Razón: ${args.rationale}${C.reset}`);
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

  server.registerTool("console_message", {
    description: "Actualiza tu estado de tareas. Usa 'create' para iniciar, y 'update' repetidamente para avanzar.",
    inputSchema: { 
        action: z.enum(["create", "update"]).describe("'create' borra la memoria. 'update' actualiza por ID."),
        thought: z.string().optional(), 
        tasks: z.array(z.object({ 
            id: z.string(), title: z.string().optional(),
            status: z.enum(["completada", "en proceso", "pendiente", "error"]).optional(),
            sub_steps: z.array(z.string()).optional()
        })).optional() 
    },
    annotations: RO
  }, async ({ action = "create", thought, tasks }) => {
    
    if (action === "create") {
        taskState.clear();
    }
    
    if (tasks && tasks.length > 0) {
        for (const t of tasks) {
            if (action === "create" || !taskState.has(t.id)) {
                taskState.set(t.id, {
                    title: t.title || "Tarea sin titulo",
                    status: t.status || "pendiente",
                    sub_steps: t.sub_steps || []
                });
            } else {
                const existing = taskState.get(t.id);
                if (t.title) existing.title = t.title;
                if (t.status) existing.status = t.status;
                if (t.sub_steps) existing.sub_steps = t.sub_steps;
            }
        }
    }
    
    printTasks(thought);
    return result("Tablero de tareas actualizado.");
  });

  server.registerTool("reset_mcp_session", {
    description: "Limpia la sesion, tareas en memoria, procesos y logs.",
    inputSchema: { rationale: z.string() }, annotations: WR
  }, async () => {
    let killed = 0;
    for (const [id, b] of background.entries()) {
      if (!b.exited) { killTree(b.child.pid); killed++; }
      background.delete(id);
    }
    backgroundSeq = 0;
    taskState.clear();
    try { if (fsSync.existsSync(LOG_FILE)) fsSync.unlinkSync(LOG_FILE); } catch(e) {}
    console.log(`\n${C.green}${C.bold}🧹 SESION RESETEADA POR LA IA (${killed} procesos detenidos).${C.reset}\n`);
    return result(`Sesion reiniciada exitosamente.`);
  });

  server.registerTool("get_project_context", {
    description: "Extrae reglas para que entiendas el proyecto.",
    inputSchema: { rationale: z.string().optional() }, annotations: RO
  }, async () => {
    let ctx = "============================\nCONTEXTO GLOBAL\n============================\n\n";
    try {
      const dirs = (await fs.readdir(REAL_ROOT, {withFileTypes: true})).filter(d=>d.isDirectory() && !IGNORE_DIRS.has(d.name)).map(d=>d.name);
      ctx += `[Carpetas Raíz]: ${dirs.join(", ")}\n\n`;
    } catch(e){}
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(REAL_ROOT, "package.json"), "utf8"));
      ctx += `[package.json -> Dependencias]: ${Object.keys(pkg.dependencies||{}).join(", ")}\n`;
    } catch(e) {}
    for (const ruleFile of [".geminirules.md", "README.md"]) {
      try { const rules = await fs.readFile(path.join(REAL_ROOT, ruleFile), "utf8"); ctx += `\n--- Contenido de ${ruleFile} ---\n${rules.slice(0, 1500)}\n`; } catch(e) {}
    }
    return result(ctx);
  });

  server.registerTool("patch_file", {
    description: "Reemplaza bloque de lineas.",
    inputSchema: { path: z.string(), startLine: z.number(), endLine: z.number(), newContent: z.string(), rationale: z.string() }, annotations: WR
  }, async ({ path: p, startLine, endLine, newContent }) => {
    const file = await safeExisting(p), content = await fs.readFile(file, "utf8");
    const eol = content.includes("\r\n") ? "\r\n" : "\n", lines = content.split(/\r?\n/);
    if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) throw new Error("Rango invalido.");
    lines.splice(startLine - 1, endLine - startLine + 1, newContent);
    await fs.writeFile(file, lines.join(eol), "utf8");
    return result({ success: true, path: p, linesPatched: `${startLine}-${endLine}` });
  });

  server.registerTool("write_file", {
    description: "Crea o sobrescribe.",
    inputSchema: { path: z.string(), content: z.string(), append: z.boolean().optional(), rationale: z.string() }, annotations: WR
  }, async ({ path: p, content, append = false }) => {
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) throw new Error("Contenido muy grande");
    await fs.writeFile(await safeNew(p), content, { encoding: "utf8", flag: append ? "a" : "w" });
    return result({ success: true, path: p });
  });

  server.registerTool("edit_file", {
    description: "Reemplaza texto exacto.",
    inputSchema: { path: z.string(), oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().optional(), rationale: z.string() }, annotations: WR
  }, async ({ path: p, oldText, newText, replaceAll = false }) => {
    const file = await safeExisting(p), content = await fs.readFile(file, "utf8");
    const eol = content.includes("\r\n") ? "\r\n" : "\n", norm = s => s.replace(/\r?\n/g, eol);
    const oldN = norm(oldText), newN = norm(newText), first = content.indexOf(oldN);
    if (first === -1) throw new Error("Texto no encontrado");
    const count = content.split(oldN).length - 1;
    if (count > 1 && !replaceAll) throw new Error(`Aparece ${count} veces; usa replaceAll=true`);
    await fs.writeFile(file, replaceAll ? content.split(oldN).join(newN) : content.slice(0, first) + newN + content.slice(first + oldN.length), "utf8");
    return result({ success: true, path: p });
  });

  server.registerTool("search_in_files", {
    description: "Busca texto.",
    inputSchema: { query: z.string().min(1), path: z.string().optional(), include: z.string().optional(), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), maxResults: z.number().optional() }, annotations: RO
  }, async ({ query, path: p = ".", include, regex = false, caseSensitive = false, maxResults = 100 }) => {
    const root = await safeExisting(p); maxResults = Math.min(500, Math.max(1, Math.floor(Number(maxResults) || 100)));
    const filter = makeFileFilter(include), re = new RegExp(regex ? query : escapeRegex(query), caseSensitive ? "" : "i");
    const source = (await fs.stat(root)).isFile() ? [{ full: root, name: path.basename(root), isDir: false }] : walkFiles(root);
    let resultText = "", matchesCount = 0;
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
            resultText += `\n[Archivo: ${rel(f.full)}]\n`;
            for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) resultText += `${j === i ? ">>" : "  "} ${j + 1}: ${lines[j].trim()}\n`;
            if (matchesCount >= maxResults) break;
          }
        }
      } catch {}
      if (matchesCount >= maxResults) break;
    }
    return result(resultText.trim() || "Sin coincidencias");
  });

  server.registerTool("read_file", {
    description: "Lee un archivo por partes.", inputSchema: { path: z.string(), offset: z.number().optional(), limit: z.number().optional() }, annotations: RO
  }, async ({ path: p, offset = 1, limit = 2000 }) => result(await readTextFile(await safeExisting(p), Math.max(1, Math.floor(Number(offset) || 1)), Math.min(10000, Math.max(1, Math.floor(Number(limit) || 2000))))));

  server.registerTool("list_files", { description: "Lista archivos", inputSchema: { path: z.string().optional() }, annotations: RO }, async ({ path: p = "." }) => {
    const dir = await safeExisting(p), entries = await fs.readdir(dir, { withFileTypes: true }), lines = [];
    for (const e of entries.slice(0, 500)) lines.push(e.isDirectory() ? `[DIR]  ${e.name}` : `[FILE] ${e.name}`);
    return result(lines.join("\n") || "(vacia)");
  });

  server.registerTool("directory_tree", {
    description: "Arbol de directorios", inputSchema: { path: z.string().optional(), maxDepth: z.number().optional() }, annotations: RO
  }, async ({ path: p = ".", maxDepth = 3 }) => {
    const root = await safeExisting(p), lines = [rel(root) + "/"], counter = { n: 0 };
    async function tree(dir, depth, prefix) {
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
        if (counter.n >= 1500) { lines.push(`${prefix}...`); break; }
        counter.n++;
        lines.push(e.isDirectory() ? `${prefix}${e.name}/` : `${prefix}${e.name}`);
        if (e.isDirectory() && depth < maxDepth) await tree(path.join(dir, e.name), depth + 1, prefix + "  ");
      }
    }
    await tree(root, 1, "  "); return result(lines.join("\n"));
  });

  if (COMMANDS_ENABLED) {
    server.registerTool("run_command", {
      description: "Ejecuta PowerShell.",
      inputSchema: { command: z.string(), cwd: z.string().optional(), timeoutSeconds: z.number().optional(), rationale: z.string() }, annotations: CMD
    }, async ({ command, cwd = ".", timeoutSeconds = 60 }) => {
      const secs = Math.min(90, Math.max(1, Math.floor(Number(timeoutSeconds) || 60))), dir = await safeExisting(cwd), t0 = Date.now();
      return new Promise(resolve => {
        let out = "", err = "", timedOut = false, child = spawnPs(command, dir);
        child.stdout.on("data", d => { out += d; if (out.length > MAX_OUTPUT_CHARS*2) out = out.slice(-MAX_OUTPUT_CHARS*2); });
        child.stderr.on("data", d => { err += d; if (err.length > MAX_OUTPUT_CHARS*2) err = err.slice(-MAX_OUTPUT_CHARS*2); });
        const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, secs * 1000);
        child.on("error", e => { clearTimeout(timer); resolve(result("[ERROR] " + e.message, true)); });
        child.on("close", code => { clearTimeout(timer); resolve(result(formatRun({ command, code, timedOut, ms: Date.now() - t0, cwd: rel(dir), out, err, secs }), timedOut || code !== 0)); });
      });
    });

    server.registerTool("start_background_command", {
      description: "Proceso 2do plano.", inputSchema: { command: z.string(), cwd: z.string().optional(), rationale: z.string() }, annotations: CMD
    }, async ({ command, cwd = "." }) => {
      const dir = await safeExisting(cwd), id = "bg" + (++backgroundSeq), child = spawnPs(command, dir), entry = { id, command, cwd: rel(dir), child, out: "", dropped: 0, readUpTo: 0, exited: false, code: null };
      const add = d => { entry.out += d; }; child.stdout.on("data", add); child.stderr.on("data", add);
      child.on("error", e => { add(`\n[error: ${e.message}]\n`); entry.exited = true; }); child.on("close", code => { entry.exited = true; entry.code = code; });
      background.set(id, entry); await new Promise(r => setTimeout(r, 1500)); entry.readUpTo = entry.out.length;
      return result({ id, pid: child.pid, corriendo: !entry.exited, salida: tailText(entry.out, 3000) });
    });

    server.registerTool("read_background_output", { description: "Lee proceso", inputSchema: { id: z.string() }, annotations: RO }, async ({ id }) => {
      const e = background.get(id); if (!e) throw new Error("No existe");
      const text = e.out.slice(e.readUpTo); e.readUpTo = e.out.length; return result(`[${e.exited ? "terminado" : "corriendo"}]\n` + text);
    });

    server.registerTool("stop_background_command", { description: "Detiene proceso", inputSchema: { id: z.string(), rationale: z.string() }, annotations: CMD }, async ({ id }) => {
      const e = background.get(id); if (!e) throw new Error("No existe");
      if (!e.exited) killTree(e.child.pid); return result({ id, detenido: true });
    });
  }

  server.registerTool("browser_navigate", { description: "Abre URL visible", inputSchema: { url: z.string(), rationale: z.string().optional() }, annotations: RO }, async ({ url }) => {
    await (await getBrowser()).goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }); return result(`Navegado a ${url}`);
  });
  
  server.registerTool("browser_evaluate", { description: "JS en el navegador.", inputSchema: { script: z.string(), rationale: z.string().optional() }, annotations: RO }, async ({ script }) => {
    return result(await (await getBrowser()).evaluate(script));
  });

  server.registerTool("browser_click", { description: "Clic en elemento.", inputSchema: { selector: z.string(), rationale: z.string() }, annotations: WR }, async ({ selector }) => {
    await (await getBrowser()).click(selector, { timeout: 10000 }); return result(`Clic en ${selector}`);
  });

  server.registerTool("browser_close", { description: "Cierra navegador.", inputSchema: { rationale: z.string().optional() }, annotations: WR }, async () => {
    if (pwBrowser) { await pwBrowser.close(); pwBrowser = null; pwPage = null; return result("Navegador cerrado."); }
    return result("No abierto.");
  });

  return server;
}

const methodNotAllowed = (req, res) => res.status(405).json({ error: "Method not allowed" });
app.get("/mcp", methodNotAllowed); app.delete("/mcp", methodNotAllowed);
app.get("/health", (req, res) => res.json({ status: "ok", version: VERSION }));

app.post("/mcp", async (req, res) => {
  if (!tokenOk((req.headers.authorization || "").replace(/^Bearer /, ""))) return res.status(401).json({ error: "No autorizado" });
  const server = createServer(), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); } catch (error) { if (!res.headersSent) res.status(500).json({ error: "Error MCP" }); }
});

process.on("exit", () => {
  if (pwBrowser) { try { pwBrowser.close(); } catch(e){} }
  for (const b of background.values()) if (!b.exited) killTree(b.child.pid); 
});

initializeRoot().then(() => {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`\n${C.magenta}${C.bold}==================================${C.reset}`);
    console.log(`${C.magenta}${C.bold} MCP FILESYSTEM ${VERSION} (41337) ${C.reset}`);
    console.log(`${C.magenta}${C.bold}==================================${C.reset}`);
    console.log(`${C.cyan}Endpoint:${C.reset} http://127.0.0.1:${PORT}/mcp/<token>`);
    console.log(`${C.cyan}Carpeta:${C.reset}  ${REAL_ROOT}`);
    console.log(`${C.green}▶ HERRAMIENTA RESET CACHE: 'reset_mcp_session' inyectada.${C.reset}`);
    console.log(`${C.green}▶ MOTOR DINAMICO TAREAS ACTIVADO (console.clear).${C.reset}\n`);
  });
}).catch(error => { console.error("Fallo:", error); process.exit(1); });