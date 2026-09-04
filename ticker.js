// Site-wide scrolling gold price ticker. Loaded with `defer` in <head> on
// every public page; injects itself as the first element in <body>, above
// the existing sticky header, so it scrolls away naturally on scroll while
// the header sticks. Self-contained (own styles + markup) so it drops into
// any page with a single <script defer src="/ticker.js"> tag.
(function () {
  var style = document.createElement('style');
  style.textContent = [
    '.gb-ticker { background: #120f0b; color: #FDDD3B; overflow: hidden; white-space: nowrap; font-family: Arial, Helvetica, sans-serif; font-size: 0.82rem; border-bottom: 1px solid rgba(218,153,0,0.3); }',
    '.gb-ticker-track { display: inline-block; padding-left: 100%; animation: gb-ticker-scroll 35s linear infinite; }',
    '.gb-ticker:hover .gb-ticker-track { animation-play-state: paused; }',
    '.gb-ticker-item { display: inline-block; padding: 0.4rem 2.5rem 0.4rem 0; }',
    '.gb-ticker-item .up { color: #7bc67e; }',
    '.gb-ticker-item .down { color: #e2776b; }',
    '@keyframes gb-ticker-scroll { from { transform: translateX(0); } to { transform: translateX(-100%); } }',
    '@media (prefers-reduced-motion: reduce) { .gb-ticker-track { animation: none; padding-left: 1rem; } }',
  ].join('\n');
  document.head.appendChild(style);

  var bar = document.createElement('div');
  bar.className = 'gb-ticker';
  bar.hidden = true;
  document.body.insertBefore(bar, document.body.firstChild);

  fetch('/api/gold-price')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) return;

      var history = data.history || [];
      var changeHtml = '';
      if (history.length > 1) {
        var first = history[0].close;
        var last = history[history.length - 1].close;
        var pct = ((last - first) / first) * 100;
        var up = pct >= 0;
        changeHtml = ' <span class="' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + ' ' + Math.abs(pct).toFixed(2) + '% past year</span>';
      }

      var goldbackHtml = data.goldbackRate
        ? '  •  🇺🇸 Goldback Inc. Official Rate: $' + data.goldbackRate.toFixed(2) + ' / Goldback'
        : '';

      var text = '🥇 Live Gold Price: $' + data.price.toFixed(2) + ' / oz' + changeHtml + goldbackHtml + ' — not Goldenbee MALAJ’s own exchange rate';
      var track = document.createElement('div');
      track.className = 'gb-ticker-track';
      // Repeat the item a few times so the loop reads continuously across the full width, not just once per pass.
      var itemsHtml = '';
      for (var i = 0; i < 6; i++) {
        itemsHtml += '<span class="gb-ticker-item">' + text + '</span>';
      }
      track.innerHTML = itemsHtml;
      bar.appendChild(track);
      bar.hidden = false;
    })
    .catch(function () {
      // Fail silently — no ticker is better than a broken one.
    });
})();
