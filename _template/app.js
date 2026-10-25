import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their settings. Add a new key instead.
const SETTINGS_KEY = "new-tool-settings-v1";

const $ = (id) => document.getElementById(id);
const settings = loadJson(SETTINGS_KEY, { opened: 0 });
let file = null;

function openFile(f) {
  if (!f) return;
  file = f;
  settings.opened++;
  saveJson(SETTINGS_KEY, settings);
  $("save-btn").disabled = false;
  showStatus(`${f.name} を開きました`);
}

function save() {
  if (!file) return;
  download(new Blob([`${file.name}: ${file.size} bytes\n`], { type: "text/plain" }), "結果.txt");
  showStatus("保存しました");
}

$("file-input").addEventListener("change", (e) => {
  openFile(e.target.files[0]);
  e.target.value = "";
});
$("save-btn").addEventListener("click", save);
onFileDrop((files) => openFile(files[0]));

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__newTool = { openFile, save };
