// Menus that drop down from a toolbar button (each menu sits with its button in a
// <div class="menu-wrap">). Opening one closes the others, and a press anywhere outside
// the menus closes them all. The button's aria-expanded follows its menu.
export function createMenus(...menus) {
  const buttonOf = (menu) => menu.closest(".menu-wrap")?.querySelector("[aria-haspopup]");
  const setOpen = (menu, open) => {
    menu.hidden = !open;
    buttonOf(menu)?.setAttribute("aria-expanded", String(open));
  };
  const close = () => menus.forEach((menu) => setOpen(menu, false));
  const toggle = (menu) => {
    const show = menu.hidden;
    close();
    setOpen(menu, show);
  };
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".menu-wrap")) close();
  });
  return { close, toggle };
}
