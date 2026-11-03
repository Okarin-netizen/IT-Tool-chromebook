// "Saved to Downloads" notice shown after every download (files.js download(), and かおトリ /
// かおかくし, which load it with import()). Needs the .saved-notice look from base.css.

// Saves happen in bursts (one file per page, a ZIP and its CSV), so names saved within this
// time are listed in one notice.
const NOTICE_GROUP_MS = 1500;
let noticeNames = [];
let noticeAt = 0;

// A notice that stays until it is closed: people who seldom use computers lose track of
// where a download went, and the short status message is gone before they look.
export function showSavedNotice(name) {
  const now = Date.now();
  if (now - noticeAt > NOTICE_GROUP_MS) noticeNames = [];
  noticeAt = now;
  noticeNames.push(name);
  let box = document.getElementById("saved-notice");
  if (!box) {
    box = document.createElement("div");
    box.id = "saved-notice";
    box.className = "saved-notice";
    box.setAttribute("role", "status");
    document.body.append(box);
  }
  const what = noticeNames.length === 1 ? `「${noticeNames[0]}」` : `${noticeNames.length}個のファイル`;
  box.innerHTML = `<div class="saved-text"><strong></strong><span>ファイルアプリの「ダウンロード」で見られます。Classroom では「追加」→「ファイル」→「ダウンロード」から選べます。</span></div><button type="button" class="btn saved-close">閉じる</button>`;
  box.querySelector("strong").textContent = `「ダウンロード」フォルダに${what}を保存しました`;
  box.querySelector(".saved-close").addEventListener("click", () => (box.hidden = true));
  box.hidden = false;
}
