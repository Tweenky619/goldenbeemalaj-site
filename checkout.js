// Shared "Buy Now" handler for denomination cards across series pages.
// Expects a .buy-row with data-series / data-denomination / data-face-value,
// a .buy-qty number input, a .buy-btn button, and an optional sibling .buy-error.
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.buy-btn');
    if (!btn) return;

    var row = btn.closest('.buy-row');
    var qtyInput = row.querySelector('.buy-qty');
    var quantity = Math.max(1, Math.min(50, parseInt(qtyInput.value, 10) || 1));
    var errorEl = row.parentElement.querySelector('.buy-error');
    var originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = 'Starting checkout…';
    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }

    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        series: row.dataset.series,
        denomination: row.dataset.denomination,
        faceValueGB: row.dataset.faceValue,
        quantity: quantity,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok && data.url) {
          window.location.href = data.url;
          return;
        }
        throw new Error(data.error || 'Could not start checkout.');
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = originalText;
        if (errorEl) {
          errorEl.textContent = err.message || 'Could not start checkout. Please try again or request a quote.';
          errorEl.hidden = false;
        } else {
          alert(err.message || 'Could not start checkout.');
        }
      });
  });
})();
