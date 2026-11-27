// 単位の換算: the screen. The calculations are in convert.js (tested without a browser).
import { registerOffline } from "../shared/js/offline.js";
import { convert, formatNumber } from "./convert.js";
import "../shared/js/guide.js";

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "convert.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__unitConvert = { convert, formatNumber };
