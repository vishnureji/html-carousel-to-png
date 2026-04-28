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
const previewJobs = new Map();
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const EXPORT_WIDTH = 1080;
const EXPORT_HEIGHT = 1350;

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

function buildSlidePayload(index, filePath, image) {
  return {
    index: index + 1,
    name: path.basename(filePath),
    dataUrl: `data:image/png;base64,${image}`
  };
}

function cleanupPreviewSession(sessionId) {
  const session = previewSessions.get(sessionId);

  if (!session) {
    return;
  }

  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  previewSessions.delete(sessionId);
  return removeDirSafe(session.requestDir);
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
    await cleanupPreviewSession(sessionId);
  }, PREVIEW_TTL_MS);
}

function scheduleJobCleanup(jobId) {
  const job = previewJobs.get(jobId);

  if (!job) {
    return;
  }

  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
  }

  job.cleanupTimer = setTimeout(() => {
    previewJobs.delete(jobId);
  }, PREVIEW_TTL_MS);
}

function normalizeScale(scale) {
  return Number(scale) === 2 ? 2 : 1;
}

function buildRenderStyles() {
  return `
    html, body {
      margin: 0 !important;
      background: transparent !important;
      width: ${EXPORT_WIDTH}px !important;
      min-height: ${EXPORT_HEIGHT}px !important;
      overflow: hidden !important;
    }

    body {
      position: relative !important;
    }

    .slide[data-render-slide="true"] {
      box-sizing: border-box !important;
      width: ${EXPORT_WIDTH}px !important;
      height: ${EXPORT_HEIGHT}px !important;
      margin: 0 !important;
      isolation: isolate !important;
    }
  `;
}

async function renderSlides(html, options = {}, onProgress) {
  let browser;
  let requestDir;
  const exportScale = normalizeScale(options.scale);

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
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      deviceScaleFactor: exportScale
    });

    await page.setContent(cleanHtml(html), { waitUntil: "networkidle0" });
    await page.addStyleTag({ content: buildRenderStyles() });

    await page.evaluate(() => {
      document.documentElement.style.background = "transparent";
      if (document.body) {
        document.body.style.background = "transparent";
      }
    });

    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }

      const imagePromises = Array.from(document.images || [])
        .filter(image => !image.complete)
        .map(image => new Promise(resolve => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        }));

      if (imagePromises.length) {
        await Promise.all(imagePromises);
      }

      await new Promise(resolve => setTimeout(resolve, 300));
    });

    await page.evaluate((width, height) => {
      document.querySelectorAll(".slide").forEach(el => {
        const display = window.getComputedStyle(el).display;
        el.dataset.renderDisplay = display && display !== "none" ? display : "block";
        el.dataset.renderSlide = "true";
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
        el.style.visibility = "visible";
        el.style.opacity = "1";
      });
    }, EXPORT_WIDTH, EXPORT_HEIGHT);

    const slideCount = await page.evaluate(() => {
      return document.querySelectorAll(".slide").length;
    });

    if (!slideCount) {
      throw new Error("No slides found");
    }

    if (onProgress) {
      await onProgress({
        stage: "preparing",
        total: slideCount,
        completed: 0
      });
    }

    const files = [];
    const slides = [];

    for (let i = 0; i < slideCount; i += 1) {
      await page.evaluate(index => {
        document.querySelectorAll(".slide").forEach((el, slideIndex) => {
          const active = slideIndex === index;
          el.style.display = active ? (el.dataset.renderDisplay || "block") : "none";
          el.style.visibility = active ? "visible" : "hidden";
          el.style.opacity = active ? "1" : "0";
        });
      }, i);

      await new Promise(resolve => setTimeout(resolve, 50));

      const slideHandles = await page.$$(".slide");
      const currentSlide = slideHandles[i];

      if (!currentSlide) {
        throw new Error(`Slide ${i + 1} could not be rendered`);
      }

      const filePath = path.join(requestDir, `slide-${i + 1}.png`);

      await currentSlide.screenshot({
        path: filePath,
        omitBackground: true
      });
      const image = await fsp.readFile(filePath, { encoding: "base64" });
      const slide = buildSlidePayload(i, filePath, image);

      files.push(filePath);
      slides.push(slide);

      if (onProgress) {
        await onProgress({
          stage: "rendering",
          total: slideCount,
          completed: i + 1,
          slide
        });
      }
    }

    return { files, slides, requestDir };
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

app.post("/preview/start", async (req, res) => {
  const { html, scale } = req.body;

  if (!html) {
    return res.status(400).json({ error: "No HTML provided" });
  }

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: "queued",
    total: 0,
    completed: 0,
    slides: [],
    sessionId: null,
    error: null,
    cleanupTimer: null
  };

  previewJobs.set(jobId, job);
  scheduleJobCleanup(jobId);

  (async () => {
    try {
      job.status = "running";

      const rendered = await renderSlides(html, { scale }, async update => {
        if (typeof update.total === "number") {
          job.total = update.total;
        }

        if (typeof update.completed === "number") {
          job.completed = update.completed;
        }

        if (update.slide) {
          job.slides.push(update.slide);
        }
      });

      const sessionId = crypto.randomUUID();

      previewSessions.set(sessionId, {
        files: rendered.files,
        requestDir: rendered.requestDir,
        cleanupTimer: null
      });
      schedulePreviewCleanup(sessionId);

      job.status = "completed";
      job.sessionId = sessionId;
      job.total = rendered.slides.length;
      job.completed = rendered.slides.length;
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "Preview failed";
    } finally {
      scheduleJobCleanup(jobId);
    }
  })();

  res.json({ jobId });
});

app.get("/preview/status/:jobId", (req, res) => {
  const job = previewJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Preview job not found" });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    progress: job.total ? Math.round((job.completed / job.total) * 100) : 0,
    slides: job.slides,
    sessionId: job.sessionId,
    error: job.error
  });
});

app.get("/download/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = previewSessions.get(sessionId);

  if (!session) {
    return res.status(404).send("Preview expired. Render slides again.");
  }

  try {
    const zipPath = path.join(session.requestDir, "slides.zip");
    await createZip(session.files, zipPath);

    res.download(zipPath, "slides.zip", async () => {
      await cleanupPreviewSession(sessionId);
    });
  } catch (err) {
    console.error("Download error:", err);
    await cleanupPreviewSession(sessionId);
    res.status(500).send("Download failed");
  }
});

app.post("/export", async (req, res) => {
  let requestDir;

  try {
    console.log("Export request received");

    const { html, scale } = req.body;

    if (!html) {
      return res.status(400).send("No HTML provided");
    }

    const rendered = await renderSlides(html, { scale });
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
