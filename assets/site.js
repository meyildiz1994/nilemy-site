// Every page: the language menu remembers the language picked (the Turkish root pages read it to
// send people to their language), and closes on a click outside it or Escape. Copy buttons.
(function () {
  document.querySelectorAll('.langs a[data-lang]').forEach(function (a) {
    a.addEventListener('click', function () {
      try { localStorage.setItem('nilemy.lang', a.getAttribute('data-lang')); } catch (e) {}
    });
  });
  document.addEventListener('click', function (e) {
    document.querySelectorAll('.langs[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.langs[open]').forEach(function (d) { d.removeAttribute('open'); d.querySelector('summary').focus(); });
  });
  document.querySelectorAll('.copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy');
      var done = function () { var old = b.textContent; b.textContent = b.getAttribute('data-done'); setTimeout(function () { b.textContent = old; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    });
  });
})();
