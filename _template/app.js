// The starting point for a new tool: open a file, keep a setting, save a result.
// It is written the way docs/開発の手引き.md (書き方の決まり) asks every tool to be.
import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their settings. Add a new key instead.
const SETTINGS_KEY = "new-tool-settings-v1";

const $ = (id) => document.getElementById(id);

const settings = loadJson(SETTINGS_KEY, { opened: 0 });
const state = {
  file: null, // the file being worked on
};

function openFile(file) {
  if (!file) return;
  state.file = file;
  settings.opened++;
  saveJson(SETTINGS_KEY, settings);
  render();
  showStatus(`${file.name} を開きました`);
}

// Brings the screen in line with `state`.
function render() {
  $("save-btn").disabled = !state.file;
}

function save() {
  if (!state.file) return;
  const { name, size } = state.file;
  download(new Blob([`${name}: ${size} bytes\n`], { type: "text/plain" }), "結果.txt");
  showStatus("保存しました");
}

$("file-input").addEventListener("change", (e) => {
  openFile(e.target.files[0]);
  e.target.value = "";
});
$("save-btn").addEventListener("click", save);
onFileDrop((files) => openFile(files[0]));
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__newTool = { openFile, save };
