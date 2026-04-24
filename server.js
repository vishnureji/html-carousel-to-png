const path = require("path");
const crypto = require("crypto");

process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || path.join(__dirname, ".cache", "puppeteer");

const express = require("express");
const puppeteer = require("puppeteer");
const archiver = require("archiver");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const cors = require("cors");

const app = express();
const previewSessions = new Map();
const PREVIEW_TTL_MS = 15 * 60 * 1000;

app.use(express.json({ limit: "25mb" }));
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

function cleanHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

async function removeDirSafe(dirPath) {
  if (!dirPath) {
    return;
  }

  await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {});
}

function schedulePreviewCleanup(sessionId) {
  const session = previewSessions.get(sessionId);

  if (!session) {
    return;
  }

  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.cleanupTimer = setTimeout(async () => {
    const activeSession = previewSessions.get(sessionId);

    if (!activeSession) {
      return;
    }

    previewSessions.delete(sessionId);
    await removeDirSafe(activeSession.requestDir);
  }, PREVIEW_TTL_MS);
}

async function renderSlides(html) {
  let browser;
  let requestDir;

  try {
    requestDir = await fsp.mkdtemp(path.join(os.tmpdir(), "html-to-png-"));

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: puppeteer.executablePath(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 1400,
      height: 1800,
      deviceScaleFactor: 2
    });

    await page.setContent(
      `<!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>body{margin:0}</style>
      </head>
      <body>${cleanHtml(html)}</body>
      </html>`,
      { waitUntil: "networkidle0" }
    );

    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => setTimeout(resolve, 300));
    });

    await page.evaluate(() => {
      document.querySelectorAll(".slide").forEach(el => {
        el.style.display = "flex";
        el.style.visibility = "visible";
        el.style.opacity = "1";
      });
    });

    const slideCount = await page.evaluate(() => {
      return document.querySelectorAll(".slide").length;
    });

    if (!slideCount) {
      throw new Error("No slides found");
    }

    const files = [];

    for (let i = 0; i < slideCount; i += 1) {
      await page.evaluate(index => {
        document.querySelectorAll(".slide").forEach((el, slideIndex) => {
          el.style.display = slideIndex === index ? "flex" : "none";
          el.style.visibility = slideIndex === index ? "visible" : "hidden";
          el.style.opacity = slideIndex === index ? "1" : "0";
        });
      }, i);

      await new Promise(resolve => setTimeout(resolve, 50));

      const slideHandles = await page.$$(".slide");
      const currentSlide = slideHandles[i];

      if (!currentSlide) {
        throw new Error(`Slide ${i + 1} could not be rendered`);
      }

      const filePath = path.join(requestDir, `slide-${i + 1}.png`);

      await currentSlide.screenshot({ path: filePath });

      files.push(filePath);
    }

    return { files, requestDir };
  } catch (error) {
    await removeDirSafe(requestDir);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function createZip(files, zipPath) {
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");

  const zipReady = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });

  archive.pipe(output);

  files.forEach(file => {
    archive.file(file, { name: path.basename(file) });
  });

  archive.finalize();
  await zipReady;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/preview", async (req, res) => {
  try {
    console.log("Preview request received");

    const { html } = req.body;

    if (!html) {
      return res.status(400).json({ error: "No HTML provided" });
    }

    const { files, requestDir } = await renderSlides(html);
    const sessionId = crypto.randomUUID();
    const slides = await Promise.all(
      files.map(async (filePath, index) => {
        const image = await fsp.readFile(filePath, { encoding: "base64" });

        return {
          index: index + 1,
          name: path.basename(filePath),
          dataUrl: `data:image/png;base64,${image}`
        };
      })
    );

    previewSessions.set(sessionId, {
      files,
      requestDir,
      cleanupTimer: null
    });
    schedulePreviewCleanup(sessionId);

    res.json({
      sessionId,
      slides
    });
  } catch (err) {
    console.error("Preview error:", err);

    if (err.message === "No slides found") {
      return res.status(400).json({ error: err.message });
    }

    res.status(500).json({ error: "Preview failed" });
  }
});

app.get("/download/:sessionId", async (req, res) => {
  const session = previewSessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).send("Preview expired. Render slides again.");
  }

  try {
    schedulePreviewCleanup(req.params.sessionId);

    const zipPath = path.join(session.requestDir, "slides.zip");
    await createZip(session.files, zipPath);

    res.download(zipPath, "slides.zip");
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).send("Download failed");
  }
});

app.post("/export", async (req, res) => {
  let requestDir;

  try {
    console.log("Export request received");

    const { html } = req.body;

    if (!html) {
      return res.status(400).send("No HTML provided");
    }

    const rendered = await renderSlides(html);
    requestDir = rendered.requestDir;

    const zipPath = path.join(requestDir, "slides.zip");
    await createZip(rendered.files, zipPath);

    res.download(zipPath, "slides.zip", async () => {
      await removeDirSafe(requestDir);
    });
  } catch (err) {
    if (requestDir) {
      await removeDirSafe(requestDir);
    }

    console.error("ERROR:", err);

    if (err.message === "No slides found") {
      return res.status(400).send(err.message);
    }

    res.status(500).send("Export failed");
  }
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
