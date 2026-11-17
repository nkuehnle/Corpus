import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { mkdirSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;

/** Lets the UI run in a plain browser during development: a SQLite file and an HTTP relay
 *  stand in for what the Tauri plugins provide inside the app. Never part of a build. */
function devBackend(): Plugin {
  return {
    name: "corpus-dev-backend",
    apply: "serve",
    async configureServer(server) {
      const { openNodeDb } = await import("./src/db/node.ts");
      mkdirSync(".dev", { recursive: true });
      const dbs = new Map<string, ReturnType<typeof openNodeDb>>();
      const body = (req: import("node:http").IncomingMessage) =>
        new Promise<string>((resolve) => {
          let text = "";
          req.on("data", (c) => (text += c));
          req.on("end", () => resolve(text));
        });

      server.middlewares.use("/__db", async (req, res) => {
        try {
          const { name, kind, sql, params } = JSON.parse(await body(req));
          if (!dbs.has(name)) dbs.set(name, openNodeDb(`.dev/${name}`));
          const db = dbs.get(name)!;
          const out = kind === "select" ? await db.select(sql, params) : await db.execute(sql, params);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out ?? null));
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });

      server.middlewares.use("/__fetch", async (req, res) => {
        try {
          const params = new URL(req.url!, "http://x").searchParams;
          const upstream = await fetch(params.get("url")!, { method: params.get("method") ?? "GET" });
          res.statusCode = upstream.status;
          res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/octet-stream");
          const length = upstream.headers.get("content-length");
          if (length) res.setHeader("x-upstream-length", length);
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (e) {
          res.statusCode = 502;
          res.end(String(e));
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), devBackend()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/.dev/**"],
    },
  },
  test: { exclude: ["**/node_modules/**", "**/src-tauri/**"] },
}));
