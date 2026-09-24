// Runs before the app draws, so a chosen theme doesn't flash the other one first. It only reads the
// choice; everything else about themes is in app.js.
try {
  const chosen = localStorage.getItem('polyphemus.theme');
  if (chosen === 'light' || chosen === 'dark') document.documentElement.setAttribute('data-theme', chosen);
} catch {
  // private window, blocked storage: the device's own setting it is
}
