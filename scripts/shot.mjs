// Dev helper: screenshots of the UI running against the Vite dev server.
// usage: node scripts/shot.mjs <outDir> <route> [route...]   (add ":dark" to a route for dark mode)
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const cache = `${homedir()}/.cache/ms-playwright`;
const dir = readdirSync(cache).find((d) => /^chromium-\d+$/.test(d));
const sub = readdirSync(`${cache}/${dir}`).find((d) => d.startsWith("chrome"));
const browser = await chromium.launch({ executablePath: `${cache}/${dir}/${sub}/chrome` });
const [out, ...routes] = process.argv.slice(2);
for (const spec of routes) {
  const [route, mode] = spec.split(":");
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, colorScheme: mode === "dark" ? "dark" : "light" });
  page.on("pageerror", (e) => console.log("PAGE ERROR", route, e.message));
  page.on("console", (m) => m.type() === "error" && console.log("console error", route, m.text()));
  await page.goto(`http://localhost:1420/#${route}`);
  await page.waitForTimeout(Number(process.env.WAIT ?? 2500));
  const name = `${out}/${route.replace(/[^\w]+/g, "_")}${mode ? "_" + mode : ""}.png`;
  await page.screenshot({ path: name, fullPage: process.env.FULL === "1" });
  console.log(name);
  await page.close();
}
await browser.close();
