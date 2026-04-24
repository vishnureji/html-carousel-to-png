const express = require("express");
const puppeteer = require("puppeteer");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());

app.post("/export", async (req, res) => {
  try {
    console.log("🚀 Request received");

    let { html } = req.body;

    if (!html) return res.status(400).send("No HTML provided");

    // Clean injected comments
    html = html.replace(/<!--[\s\S]*?-->/g, "");

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 1400,
      height: 1800,
      deviceScaleFactor: 2
    });

    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>body{margin:0}</style>
      </head>
      <body>${html}</body>
      </html>
    `, { waitUntil: "networkidle0" });

    // Font fix
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(r => setTimeout(r, 300));
    });

    // 🔥 FORCE SLIDES VISIBLE
    await page.evaluate(() => {
      document.querySelectorAll(".slide").forEach(el => {
        el.style.display = "flex";
        el.style.visibility = "visible";
        el.style.opacity = "1";
      });
    });

    // Detect slides
    const slideBoxes = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll(".slide"));

      return elements.map(el => {
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
      return res.status(400).send("No slides found");
    }

    const outputDir = path.join(__dirname, "output");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const files = [];

    // Capture each slide
    for (let i = 0; i < slideBoxes.length; i++) {

      await page.evaluate((index) => {
        document.querySelectorAll(".slide").forEach((el, i) => {
          el.style.display = i === index ? "flex" : "none";
        });
      }, i);

      const box = slideBoxes[i];

      const filePath = path.join(outputDir, `slide-${i + 1}.png`);

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

    // ZIP creation
    const zipPath = path.join(outputDir, "slides.zip");
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip");

    archive.pipe(output);

    files.forEach(file => {
      archive.file(file, { name: path.basename(file) });
    });

    await archive.finalize();

    console.log("✅ Export complete");

    res.download(zipPath);

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).send("Export failed");
  }
});

app.listen(3000, () => {
  console.log("🔥 Server running on http://localhost:3000");
});