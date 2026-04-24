const path = require("path");

module.exports = {
  chrome: {
    skipDownload: false
  },
  cacheDirectory: path.join(__dirname, ".cache", "puppeteer")
};
