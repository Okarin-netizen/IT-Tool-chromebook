// Asks for the password of a PDF that needs one to open, in a small dialog of our own
// (window.prompt shows the site address and cannot hide what is typed).
let dialog = null;

function build() {
  dialog = document.createElement("dialog");
  dialog.className = "app-dialog password-dialog";
  dialog.innerHTML = `
    <form method="dialog">
      <h2>パスワードを入力</h2>
      <p class="hint"></p>
      <input type="password" name="password" autocomplete="off" aria-label="パスワード">
      <label class="show"><input type="checkbox" name="show"> パスワードを表示</label>
      <p class="error" hidden>パスワードがちがいます。もう一度入力してください。</p>
      <div class="dialog-buttons">
        <button value="cancel" class="btn" formnovalidate>やめる</button>
        <button value="ok" class="btn primary">開く</button>
      </div>
    </form>`;
  const form = dialog.querySelector("form");
  form.show.addEventListener("change", () => {
    form.password.type = form.show.checked ? "text" : "password";
  });
  document.body.append(dialog);
}

// Resolves to the password, or null when cancelled. Only one dialog is shown at a time;
// several PDFs opened together wait for each other.
let queue = Promise.resolve();
export function askPassword(name, { retry = false } = {}) {
  const ask = () => new Promise((resolve) => {
    if (!dialog) build();
    const form = dialog.querySelector("form");
    dialog.querySelector(".hint").textContent =
      `${name ? `「${name}」は` : "このPDFは"}パスワードで保護されています。`;
    dialog.querySelector(".error").hidden = !retry;
    form.password.value = "";
    form.show.checked = false;
    form.password.type = "password";
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok" ? form.password.value : null);
    }, { once: true });
    dialog.showModal();
    form.password.focus();
  });
  const result = queue.then(ask);
  queue = result.catch(() => {});
  return result;
}
