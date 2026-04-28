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
const sourceSessions = new Map();
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const EXPORT_WIDTH = 1080;
const EXPORT_HEIGHT = 1350;

app.use(express.json({ limit: "100mb" }));
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

function cleanHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

const EMOJI_FONT_HREF = "https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap";
const EMOJI_SUPPORT_MARKUP = [
  '<meta charset="utf-8">',
  `<link rel="stylesheet" href="${EMOJI_FONT_HREF}">`,
  "<style>",
  ".codex-emoji-glyph {",
  '  font-family: "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", sans-serif !important;',
  "  font-style: normal !important;",
  "  font-variant-emoji: emoji;",
  "}",
  "</style>",
  "<script>",
  "(function () {",
  "  if (window.__codexEmojiSupportLoaded) {",
  "    return;",
  "  }",
  "  window.__codexEmojiSupportLoaded = true;",
  '  const emojiPattern = /(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?)*)/gu;',
  "  function shouldSkip(node) {",
  "    const parent = node.parentElement;",
  "    if (!parent) {",
  "      return true;",
  "    }",
  "    const tagName = parent.tagName;",
  '    return tagName === "SCRIPT" || tagName === "STYLE" || tagName === "TEXTAREA" || tagName === "TITLE";',
  "  }",
  "  function containsEmoji(text) {",
  "    emojiPattern.lastIndex = 0;",
  "    return emojiPattern.test(text);",
  "  }",
  "  function wrapEmojiText(root) {",
  "    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {",
  "      acceptNode(node) {",
  "        if (!node.nodeValue || !containsEmoji(node.nodeValue) || shouldSkip(node)) {",
  "          return NodeFilter.FILTER_REJECT;",
  "        }",
  "        return NodeFilter.FILTER_ACCEPT;",
  "      }",
  "    });",
  "    const textNodes = [];",
  "    while (walker.nextNode()) {",
  "      textNodes.push(walker.currentNode);",
  "    }",
  "    for (const node of textNodes) {",
  "      const text = node.nodeValue;",
  "      if (!text) {",
  "        continue;",
  "      }",
  "      const fragment = document.createDocumentFragment();",
  "      let lastIndex = 0;",
  "      emojiPattern.lastIndex = 0;",
  "      let match;",
  "      while ((match = emojiPattern.exec(text))) {",
  "        const [value] = match;",
  "        const index = match.index;",
  "        if (index > lastIndex) {",
  "          fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));",
  "        }",
  '        const span = document.createElement("span");',
  '        span.className = "codex-emoji-glyph";',
  "        span.textContent = value;",
  "        fragment.appendChild(span);",
  "        lastIndex = index + value.length;",
  "      }",
  "      if (lastIndex < text.length) {",
  "        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));",
  "      }",
  "      node.parentNode.replaceChild(fragment, node);",
  "    }",
  "  }",
  "  function boot() {",
  "    wrapEmojiText(document.body || document.documentElement);",
  "  }",
  '  if (document.readyState === "loading") {',
  '    document.addEventListener("DOMContentLoaded", boot, { once: true });',
  "  } else {",
  "    boot();",
  "  }",
  "})();",
  "</script>"
].join("");

function injectHeadMarkup(html, markup) {
  if (!markup) {
    return html;
  }

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, match => `${match}${markup}`);
  }

  return `<head>${markup}</head>${html}`;
}

function prepareHtml(html, baseHref) {
  let headMarkup = EMOJI_SUPPORT_MARKUP;

  if (baseHref) {
    const safeHref = String(baseHref).replace(/"/g, "&quot;");
    const baseTag = `<base href="${safeHref}">`;
    if (/<base\b[^>]*>/i.test(html)) {
      html = html.replace(/<base\b[^>]*>/i, baseTag);
    } else {
      headMarkup = `${baseTag}${headMarkup}`;
    }
  }

  return injectHeadMarkup(html, headMarkup);
}

function normalizeRelativeAssetPath(relativePath) {
  const normalized = path.posix.normalize(String(relativePath || "").replace(/\\/g, "/"));

  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid asset path: ${relativePath}`);
  }

  return normalized;
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

function cleanupSourceSession(sourceSessionId) {
  const session = sourceSessions.get(sourceSessionId);

  if (!session) {
    return;
  }

  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  sourceSessions.delete(sourceSessionId);
  return removeDirSafe(session.assetDir);
}

function scheduleSourceCleanup(sourceSessionId) {
  const session = sourceSessions.get(sourceSessionId);

  if (!session) {
    return;
  }

  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.cleanupTimer = setTimeout(async () => {
    await cleanupSourceSession(sourceSessionId);
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

    [data-render-capture-root="true"] {
      transform-origin: top left !important;
    }
  `;
}

async function renderSlides(html, options = {}, onProgress) {
  let browser;
  let requestDir;
  const exportScale = normalizeScale(options.scale);
  const resolvedHtml = prepareHtml(cleanHtml(html), options.assetBaseUrl);

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

    await page.setContent(resolvedHtml, { waitUntil: "networkidle0" });
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

    const renderContext = await page.evaluate((width, height) => {
      const slides = Array.from(document.querySelectorAll(".slide"));
      const sharedParent = slides.length && slides.every(el => el.parentElement === slides[0].parentElement)
        ? slides[0].parentElement
        : null;
      const targetAspect = width / height;
      let captureMode = "slide";

      if (sharedParent) {
        const parentRect = sharedParent.getBoundingClientRect();
        const parentStyle = window.getComputedStyle(sharedParent);
        const parentAspect = parentRect.width && parentRect.height
          ? parentRect.width / parentRect.height
          : 0;
        const slidesFitParent = slides.every(el => {
          const rect = el.getBoundingClientRect();
          return rect.width <= parentRect.width + 1 && rect.height <= parentRect.height + 1;
        });
        const looksLikeFrame = parentRect.width > 0 &&
          parentRect.height > 0 &&
          Math.abs(parentAspect - targetAspect) < 0.05 &&
          slidesFitParent &&
          (parentStyle.overflow === "hidden" || parentStyle.position !== "static");

        if (looksLikeFrame) {
          captureMode = "frame";
          const captureStage = document.createElement("div");
          captureStage.dataset.renderCaptureRoot = "true";
          captureStage.style.position = "fixed";
          captureStage.style.left = "0";
          captureStage.style.top = "0";
          captureStage.style.width = `${width}px`;
          captureStage.style.height = `${height}px`;
          captureStage.style.overflow = "hidden";
          captureStage.style.background = "transparent";
          captureStage.style.zIndex = "2147483647";
          captureStage.style.pointerEvents = "none";

          const clonedRoot = sharedParent.cloneNode(true);
          clonedRoot.dataset.renderClonedRoot = "true";
          clonedRoot.style.position = "absolute";
          clonedRoot.style.left = "0";
          clonedRoot.style.top = "0";
          clonedRoot.style.margin = "0";
          clonedRoot.style.transform = `scale(${width / parentRect.width}, ${height / parentRect.height})`;
          clonedRoot.style.transformOrigin = "top left";

          captureStage.appendChild(clonedRoot);
          document.body.appendChild(captureStage);
        }
      }

      const renderSlides = captureMode === "frame"
        ? Array.from(document.querySelectorAll("[data-render-cloned-root='true'] .slide"))
        : slides;

      renderSlides.forEach(el => {
        const display = window.getComputedStyle(el).display;
        el.dataset.renderDisplay = display && display !== "none" ? display : "block";

        if (captureMode !== "frame") {
          el.dataset.renderSlide = "true";
          el.style.width = `${width}px`;
          el.style.height = `${height}px`;
        } else {
          el.removeAttribute("data-render-slide");
        }

        el.style.visibility = "visible";
        el.style.opacity = "1";
      });

      return {
        slideCount: slides.length,
        captureMode
      };
    }, EXPORT_WIDTH, EXPORT_HEIGHT);

    const slideCount = renderContext.slideCount;

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
      await page.evaluate((index, captureMode) => {
        const selector = captureMode === "frame"
          ? "[data-render-cloned-root='true'] .slide"
          : ".slide";

        document.querySelectorAll(selector).forEach((el, slideIndex) => {
          const active = slideIndex === index;
          el.classList.remove("active", "exit");

          if (active) {
            el.classList.add("active");
          }

          el.style.display = active ? (el.dataset.renderDisplay || "block") : "none";
          el.style.visibility = active ? "visible" : "hidden";
          el.style.opacity = active ? "1" : "0";
        });
      }, i, renderContext.captureMode);

      await new Promise(resolve => setTimeout(resolve, 50));

      const captureHandle = renderContext.captureMode === "frame"
        ? await page.$("[data-render-capture-root='true']")
        : (await page.$$(".slide"))[i];

      if (!captureHandle) {
        throw new Error(`Slide ${i + 1} could not be rendered`);
      }

      const filePath = path.join(requestDir, `slide-${i + 1}.png`);

      await captureHandle.screenshot({
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

app.post("/source/register", async (req, res) => {
  let assetDir;

  try {
    const assets = Array.isArray(req.body.assets) ? req.body.assets : [];

    if (!assets.length) {
      return res.status(400).json({ error: "No asset files provided" });
    }

    assetDir = await fsp.mkdtemp(path.join(os.tmpdir(), "html-to-png-assets-"));

    for (const asset of assets) {
      const relativePath = normalizeRelativeAssetPath(asset.relativePath || asset.name);
      const targetPath = path.join(assetDir, relativePath);
      const targetDir = path.dirname(targetPath);
      const base64 = String(asset.base64 || "");

      if (!base64) {
        throw new Error(`Asset ${relativePath} is empty`);
      }

      await fsp.mkdir(targetDir, { recursive: true });
      await fsp.writeFile(targetPath, Buffer.from(base64, "base64"));
    }

    const sourceSessionId = crypto.randomUUID();
    sourceSessions.set(sourceSessionId, {
      assetDir,
      cleanupTimer: null
    });
    scheduleSourceCleanup(sourceSessionId);

    res.json({
      sourceSessionId,
      assetCount: assets.length
    });
  } catch (error) {
    await removeDirSafe(assetDir);
    res.status(400).json({ error: error.message || "Asset registration failed" });
  }
});

app.get("/source-assets/:sourceSessionId/*", async (req, res) => {
  const sourceSessionId = req.params.sourceSessionId;
  const session = sourceSessions.get(sourceSessionId);

  if (!session) {
    return res.status(404).send("Asset session expired");
  }

  try {
    const relativePath = normalizeRelativeAssetPath(req.params[0]);
    const resolvedPath = path.resolve(session.assetDir, relativePath);
    const rootPath = path.resolve(session.assetDir);

    if (!resolvedPath.startsWith(rootPath + path.sep) && resolvedPath !== rootPath) {
      return res.status(400).send("Invalid asset path");
    }

    scheduleSourceCleanup(sourceSessionId);
    res.sendFile(resolvedPath, error => {
      if (error && !res.headersSent) {
        res.status(error.statusCode || 404).send("Asset not found");
      }
    });
  } catch (error) {
    res.status(400).send(error.message || "Invalid asset path");
  }
});

app.post("/preview/start", async (req, res) => {
  const { html, scale, assetBaseUrl } = req.body;

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

      const rendered = await renderSlides(html, { scale, assetBaseUrl }, async update => {
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

    const { html, scale, assetBaseUrl } = req.body;

    if (!html) {
      return res.status(400).send("No HTML provided");
    }

    const rendered = await renderSlides(html, { scale, assetBaseUrl });
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
