const path = require("path");

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

app.use(express.json({ limit: "10mb" }));
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/export", async (req, res) => {
  let browser;
  let requestDir;

  try {
    console.log("Request received");

    let { html } = req.body;

    if (!html) {
      return res.status(400).send("No HTML provided");
    }

    html = html.replace(/<!--[\s\S]*?-->/g, "");
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
      <body>${html}</body>
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

    const slideBoxes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".slide")).map(el => {
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height)
        };
      });
    });

    console.log("Slides found:", slideBoxes.length);

    if (!slideBoxes.length) {
      await browser.close();
      browser = null;
      return res.status(400).send("No slides found");
    }

    const files = [];

    for (let i = 0; i < slideBoxes.length; i += 1) {
      await page.evaluate(index => {
        document.querySelectorAll(".slide").forEach((el, slideIndex) => {
          el.style.display = slideIndex === index ? "flex" : "none";
        });
      }, i);

      const box = slideBoxes[i];
      const filePath = path.join(requestDir, `slide-${i + 1}.png`);

      await page.screenshot({
        path: filePath,
        clip: {
          x: Math.max(0, box.x),
          y: Math.max(0, box.y),
          width: box.width,
          height: box.height
        }
      });

      files.push(filePath);
    }

    await browser.close();
    browser = null;

    const zipPath = path.join(requestDir, "slides.zip");
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

    console.log("Export complete");

    res.download(zipPath, "slides.zip", async downloadErr => {
      if (downloadErr) {
        console.error("Download error:", downloadErr);
      }

      if (requestDir) {
        await fsp.rm(requestDir, { recursive: true, force: true });
      }
    });
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }

    if (requestDir) {
      await fsp.rm(requestDir, { recursive: true, force: true }).catch(() => {});
    }

    console.error("ERROR:", err);
    res.status(500).send("Export failed");
  }
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
