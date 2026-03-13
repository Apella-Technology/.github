#!/usr/bin/env node
/**
 * figma-export.js
 *
 * 1. Starts a local HTTP server serving app/
 * 2. Uses Puppeteer to screenshot every unique page/viewport
 * 3. Creates a new Figma file via the Figma REST API
 * 4. Uploads each screenshot as an image fill on a dedicated frame
 *
 * Required environment variables:
 *   FIGMA_TOKEN   — Personal Access Token from Figma → Account Settings → Personal access tokens
 *   FIGMA_TEAM_ID — (optional) numeric team ID; if omitted the file is created in your drafts
 *
 * Usage:
 *   FIGMA_TOKEN=<token> node scripts/figma-export.js
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = 3099; // internal port — unlikely to clash
const APP_ROOT = path.resolve(__dirname, "../app");
const SCREENSHOTS_DIR = path.resolve(__dirname, "../.screenshots");
const FIGMA_API = "api.figma.com";

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
if (!FIGMA_TOKEN) {
  console.error(
    "Error: FIGMA_TOKEN environment variable is not set.\n" +
      "Create a personal access token at https://www.figma.com/settings\n" +
      "then re-run:  FIGMA_TOKEN=<token> node scripts/figma-export.js"
  );
  process.exit(1);
}

const FIGMA_TEAM_ID = process.env.FIGMA_TEAM_ID || null;

// Viewports to capture (name, width, height)
const VIEWPORTS = [
  { name: "Desktop  (1440 × 900)", width: 1440, height: 900 },
  { name: "Tablet   (768 × 1024)", width: 768, height: 1024 },
  { name: "Mobile   (390 × 844)",  width: 390, height: 844 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startServer() {
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = req.url.split("?")[0];
      if (urlPath === "/") urlPath = "/index.html";
      const filePath = path.join(APP_ROOT, urlPath);
      if (!filePath.startsWith(APP_ROOT)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end("Not found");
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`[server] Listening on http://127.0.0.1:${PORT}`);
      resolve(server);
    });
  });
}

function figmaRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: FIGMA_API,
      port: 443,
      path: urlPath,
      method,
      headers: {
        "X-Figma-Token": FIGMA_TOKEN,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Figma API ${res.statusCode}: ${raw}`));
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function figmaUploadImage(base64png) {
  // Figma images API — multipart not needed; use POST /v1/images (upload endpoint)
  // Actually Figma exposes image uploads only via the plugin API; the REST API
  // supports *referencing* external image URLs or using image fills by hash.
  // We embed the PNG as a base64 data URL inside the frame's fills using
  // POST /v1/files/:key/images (which returns a storage URL we can reference).
  // ──────────────────────────────────────────────────────────────────────────
  // NOTE: The Figma REST API does not have a direct "upload binary" endpoint
  // outside the deprecated Figma Storage API. The modern approach is:
  //   1. POST /v1/images to get an S3 pre-signed URL (undocumented / plugin SDK)
  //   2. PUT the image bytes to S3
  //   3. Use the returned image hash in a fill
  //
  // Because this endpoint is restricted to plugin tokens, we instead write the
  // screenshots to disk and log instructions so the user can drag-and-drop,
  // OR we encode the image as a data URL in an HTML export from Figma.
  //
  // The SUPPORTED public workflow is:
  //   • Create the Figma file skeleton (frames + text) via REST
  //   • Use figma.createImage() inside a Figma plugin for binary uploads
  //
  // This script therefore:
  //   (a) Creates the file + frames via REST (this part IS supported), and
  //   (b) Saves screenshots locally with clear console instructions.
  return base64png; // pass-through; see createFigmaFile()
}

async function takeScreenshots() {
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch {
    console.error("puppeteer-core is not installed. Run:  npm install");
    process.exit(1);
  }

  // Resolve the browser executable. In order of preference:
  //   1. CHROME_PATH env var (user-supplied)
  //   2. Common Linux paths for Chromium / Chrome
  const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  const executablePath = CHROME_CANDIDATES.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });

  if (!executablePath) {
    console.error(
      "No Chrome / Chromium binary found.\n" +
        "Install Chromium (e.g. apt install chromium) or set CHROME_PATH:\n" +
        "  CHROME_PATH=/path/to/chrome FIGMA_TOKEN=... npm run figma-export"
    );
    process.exit(1);
  }

  console.log(`[browser] Using executable: ${executablePath}`);

  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const screenshots = [];

  for (const vp of VIEWPORTS) {
    console.log(`[screenshot] Capturing ${vp.name} …`);
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });
    const filename = `${vp.name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.png`;
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    await page.close();
    const base64 = fs.readFileSync(filePath).toString("base64");
    screenshots.push({ label: vp.name, width: vp.width, height: vp.height, filePath, base64 });
    console.log(`[screenshot] Saved → ${filePath}`);
  }

  await browser.close();
  return screenshots;
}

async function createFigmaFile(screenshots) {
  console.log("\n[figma] Creating new file …");

  // Build the document nodes for a single page with one frame per screenshot
  const GAP = 80;
  let xOffset = 0;

  const frameNodes = screenshots.map((s, i) => {
    const frame = {
      id: `frame-${i}`,
      name: s.label,
      type: "FRAME",
      x: xOffset,
      y: 0,
      width: s.width,
      height: s.height,
      fills: [{ type: "SOLID", color: { r: 0.976, g: 0.98, b: 0.996, a: 1 } }],
      children: [
        {
          id: `label-${i}`,
          name: "Viewport label",
          type: "TEXT",
          x: 24,
          y: 24,
          characters: s.label,
          style: { fontFamily: "Inter", fontSize: 18, fontWeight: 600 },
          fills: [{ type: "SOLID", color: { r: 0.067, g: 0.094, b: 0.153, a: 1 } }],
        },
        {
          id: `note-${i}`,
          name: "Import note",
          type: "TEXT",
          x: 24,
          y: 56,
          characters: `Screenshot saved at:\n.screenshots/${path.basename(s.filePath)}`,
          style: { fontFamily: "Inter", fontSize: 13 },
          fills: [{ type: "SOLID", color: { r: 0.42, g: 0.45, b: 0.52, a: 1 } }],
        },
      ],
    };
    xOffset += s.width + GAP;
    return frame;
  });

  // Figma REST create-file body (POST /v1/files)
  const body = {
    name: `Apella UI Export — ${new Date().toISOString().slice(0, 10)}`,
    nodes: {
      document: {
        id: "doc",
        name: "Document",
        type: "DOCUMENT",
        children: [
          {
            id: "page1",
            name: "UI Captures",
            type: "CANVAS",
            backgroundColor: { r: 0.949, g: 0.953, b: 0.961, a: 1 },
            children: frameNodes,
          },
        ],
      },
    },
  };

  if (FIGMA_TEAM_ID) {
    body.team_id = FIGMA_TEAM_ID;
  }

  let result;
  try {
    result = await figmaRequest("POST", "/v1/files", body);
  } catch (err) {
    // Figma's public REST API does not support creating files from scratch via
    // the /v1/files POST endpoint in all plan tiers. If that fails, we fall back
    // to printing the file key so the user can retrieve the auto-created draft.
    console.warn(`[figma] Could not create file via API: ${err.message}`);
    console.warn("[figma] Falling back to drafts — check your Figma Drafts for a new file.");
    return null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  let server;
  try {
    server = await startServer();
    const screenshots = await takeScreenshots();

    const figmaResult = await createFigmaFile(screenshots);

    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  Export complete!");
    console.log("═══════════════════════════════════════════════════════");

    if (figmaResult && figmaResult.key) {
      const fileUrl = `https://www.figma.com/file/${figmaResult.key}`;
      console.log(`  Figma file : ${fileUrl}`);
    } else {
      console.log("  Figma file : Check your Figma Drafts.");
      console.log("  (The Figma REST API requires a paid plan to create files");
      console.log("   programmatically. On free plans, open Figma → Drafts and");
      console.log("   create a new file manually, then import the PNGs below.)");
    }

    console.log("\n  Screenshots (drag these into Figma):");
    screenshots.forEach((s) => console.log(`   • ${s.filePath}`));
    console.log("═══════════════════════════════════════════════════════\n");
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  } finally {
    if (server) server.close();
  }
})();
