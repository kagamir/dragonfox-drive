// Pre-paint theme + language bootstrap. Kept as an external same-origin script
// (not inline) so the Content-Security-Policy can stay `script-src 'self'`
// without `'unsafe-inline'` — important for an E2EE app where XSS = key theft.
// Loaded render-blocking in <head> so it still runs before first paint (no FOUC).
(function () {
  try {
    var t = localStorage.getItem("df-theme");
    var sys = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if ((t === "dark" || ((!t || t === "auto") && sys)) && t !== "light") {
      document.documentElement.classList.add("dark");
    }
    var l = localStorage.getItem("df-lang");
    var nl = (navigator.language || "en").toLowerCase();
    var loc = l === "en" || l === "zh" ? l : nl.indexOf("zh") === 0 ? "zh" : "en";
    document.documentElement.lang = loc;
  } catch (e) {}
})();
