// Help for people who do not read instructions twice: the first screen (#welcome) gets a large
// "pick a file" area, and the app bar gets a 「使い方」 button that shows the same instructions
// again after a file is open (the welcome card is hidden from then on).
// Imported for its side effect by every tool that has a #welcome card and a #file-input.

// What the file input takes, in words, from its accept list.
function fileWord(input) {
  const accept = input.accept || "";
  const pdf = /pdf/.test(accept);
  const image = /image/.test(accept);
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
  close.innerHTML = `<button class="btn primary" value="close">閉じる</button>`;
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

function setup() {
  const welcome = document.getElementById("welcome");
  const input = document.getElementById("file-input");
  if (!welcome || !input) return;
  addPickZone(welcome, input);
  addGuideButton(welcome);
}

setup();
