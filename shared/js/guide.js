// Help for people who do not read instructions twice: the first screen (#welcome) gets a large
// "pick a file" area, and the app bar gets a 「使い方」 button that shows the same instructions
// again after a file is open (the welcome card is hidden from then on). The open button is the
// colored one only until a file is open.
// Tools with no #welcome card or #file-input get a 「使い方」 link to their page in 説明書 instead.
// The dialog also links to that page (manual/, with a picture of the screen, printable on A4).
// Imported for its side effect by every tool.

const ROOT = new URL("../../", import.meta.url);
// This tool's 説明書: manual/#<tool folder>
function manualUrl() {
  const tool = location.pathname.slice(ROOT.pathname.length).split("/")[0];
  return new URL(`manual/#${tool}`, ROOT).href;
}

// What the file input takes, in words, from its accept list.
function fileWord(input) {
  const accept = input.accept || "";
  const pdf = /pdf/.test(accept);
  const image = /image/.test(accept);
  if (!accept) return "ファイル";
  if (/video/.test(accept)) return "動画";
  if (pdf && image) return "PDFか写真";
  if (pdf) return "PDF";
  return "写真・画像";
}

function addPickZone(welcome, input) {
  const zone = document.createElement("label");
  zone.className = "pick-zone";
  zone.htmlFor = input.id;
  const word = fileWord(input);
  const many = input.multiple ? "（いくつでも選べます）" : "";
  zone.innerHTML = `<strong>ここを押して${word}を選ぶ</strong><span>または、${word}をこの画面にドラッグ${many}</span>`;
  const heading = welcome.querySelector("p") ?? welcome.querySelector("h1");
  heading.after(zone);
}

function buildDialog(welcome) {
  const dialog = document.createElement("dialog");
  dialog.className = "app-dialog guide-dialog";
  const body = welcome.cloneNode(true);
  body.removeAttribute("id");
  body.hidden = false;
  body.className = "guide-body";
  body.querySelector(".pick-zone")?.remove();
  const close = document.createElement("form");
  close.method = "dialog";
  close.className = "dialog-buttons";
  close.innerHTML = `<a class="guide-more" href="${manualUrl()}" target="_blank" rel="noopener">くわしい説明書を開く（印刷もできます）</a><button class="btn primary" value="close">閉じる</button>`;
  dialog.append(body, close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // a click on the dimmed backdrop
  });
  document.body.append(dialog);
  return dialog;
}

function addGuideButton(welcome) {
  const title = document.querySelector(".toolbar .app-title");
  if (!title) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn guide-btn";
  button.title = "このツールの使い方をもう一度見る";
  button.textContent = "？ 使い方";
  let dialog = null;
  button.addEventListener("click", () => {
    dialog ??= buildDialog(welcome);
    dialog.showModal();
  });
  title.after(button);
}

// Only one colored button at a time: 「開く」 before a file is open, 「保存」 after (the welcome card
// is hidden once a file is open).
function followWelcome(welcome, input) {
  const openBtn = document.querySelector(`.toolbar label[for="${input.id}"]`);
  if (!openBtn) return;
  const sync = () => openBtn.classList.toggle("primary", !welcome.hidden);
  new MutationObserver(sync).observe(welcome, { attributes: true, attributeFilter: ["hidden"] });
  sync();
}

// For tools without a welcome card: the same button opens 説明書 in a new tab, so the work on
// this page stays as it is.
function addManualLink() {
  const title = document.querySelector(".toolbar .app-title");
  if (!title) return;
  const link = document.createElement("a");
  link.className = "btn guide-btn";
  link.href = manualUrl();
  link.target = "_blank";
  link.rel = "noopener";
  link.title = "このツールの説明書を開く（新しいタブ）";
  link.textContent = "？ 使い方";
  title.after(link);
}

function setup() {
  const welcome = document.getElementById("welcome");
  const input = document.getElementById("file-input");
  if (!welcome || !input) {
    addManualLink();
    return;
  }
  addPickZone(welcome, input);
  addGuideButton(welcome);
  followWelcome(welcome, input);
}

setup();
