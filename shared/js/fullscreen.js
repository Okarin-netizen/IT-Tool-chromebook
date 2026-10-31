// Full screen for the whole page (timer and name roulette on a classroom screen).
export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
