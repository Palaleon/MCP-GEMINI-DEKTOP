# Roadmap del Proyecto MCP-GEMINI-DEKTOP

## Fase 1: Consolidación y Control de Versiones (Actual)
- [ ] Inicializar repositorio Git local.
- [ ] Subir a GitHub de forma pública (MCP-GEMINI-DEKTOP).
- [ ] Limpieza de archivos innecesarios (`.bak`, logs antiguos).

## Fase 2: Comunicación Bidireccional (Consola)
- [ ] Crear herramienta `gemini_console_out` en `server.js` para imprimir tareas y estados en tiempo real con colores ANSI en la consola `.bat`.

## Fase 3: Integración de "Ojos" (Playwright)
- [ ] Instalar Playwright (`npm install playwright`).
- [ ] Inyectar herramientas de navegación en `server.js` (`browser_navigate`, `browser_evaluate`, etc.).
- [ ] Configurar ciclo de vida seguro (cerrar navegador al salir, timeouts de 15s).

## Fase 4: Refactorización y Mejora Continua
- [ ] Mejorar el manejo de errores y robustez del túnel Cloudflare.
- [ ] Autenticación avanzada (opcional a futuro).