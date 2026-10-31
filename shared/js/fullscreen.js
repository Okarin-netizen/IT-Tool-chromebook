// Full screen for the whole page (timer, name roulette and 授業の画面 on a classroom screen).
export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
