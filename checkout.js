// Site-wide shopping cart for denomination "Add to Cart" buttons.
// Expects a .buy-row with data-series / data-denomination / data-face-value,
// a .buy-qty number input, a .buy-btn button, and an optional sibling
// .buy-error. Cart persists in localStorage across pages; checkout submits
// every item in one Stripe Checkout Session.
(function () {
  var CART_KEY = 'gbm_cart';

  function getCart() {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function setCart(items) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items));
    } catch (e) {}
    renderBadge();
  }

  function addToCart(item) {
    var cart = getCart();
    var existing = cart.find(function (c) {
      return c.series === item.series && c.denomination === item.denomination;
    });
    if (existing) existing.quantity = Math.min(50, existing.quantity + item.quantity);
    else cart.push(item);
    setCart(cart);
  }

  function removeFromCart(index) {
    var cart = getCart();
    cart.splice(index, 1);
    setCart(cart);
    renderDrawer();
  }

  function updateQty(index, qty) {
    var cart = getCart();
    if (qty <= 0) cart.splice(index, 1);
    else cart[index].quantity = Math.min(50, qty);
    setCart(cart);
    renderDrawer();
  }

  // ---- Styles ----
  var style = document.createElement('style');
  style.textContent = [
    '.gb-cart-btn { background: transparent; border: 1px solid rgba(250,246,236,0.35); color: var(--cream, #FAF6EC); border-radius: 20px; padding: 0.4rem 0.8rem; font-family: Arial, Helvetica, sans-serif; font-size: 0.9rem; cursor: pointer; margin-left: 0.9rem; display: inline-flex; align-items: center; gap: 0.35rem; }',
    '.gb-cart-btn:hover { border-color: var(--gold, #DA9900); color: var(--gold-light, #FDDD3B); }',
    '.gb-cart-btn.has-items { border-color: var(--gold, #DA9900); }',
    '.gb-cart-count { background: var(--gold, #DA9900); color: var(--dark, #1a1611); border-radius: 50%; min-width: 1.3rem; height: 1.3rem; display: inline-flex; align-items: center; justify-content: center; font-size: 0.72rem; font-weight: bold; padding: 0 0.2rem; }',
    '.gb-cart-overlay { position: fixed; inset: 0; background: rgba(10,8,5,0.55); z-index: 1998; }',
    '.gb-cart-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 92vw); background: #FAF6EC; z-index: 1999; box-shadow: -8px 0 30px rgba(0,0,0,0.3); overflow-y: auto; font-family: Arial, Helvetica, sans-serif; color: #2b2417; }',
    '.gb-cart-head { display: flex; align-items: center; justify-content: space-between; padding: 1.2rem 1.4rem; border-bottom: 1px solid #e8dfc8; }',
    '.gb-cart-head h3 { margin: 0; font-size: 1.15rem; color: #1a1611; }',
    '.gb-cart-close { background: none; border: none; font-size: 1.6rem; line-height: 1; cursor: pointer; color: #6b6252; }',
    '.gb-cart-empty { padding: 2rem 1.4rem; color: #6b6252; font-size: 0.95rem; }',
    '.gb-cart-items { padding: 0.6rem 1.4rem; }',
    '.gb-cart-item { padding: 0.8rem 0; border-bottom: 1px solid #e8dfc8; }',
    '.gb-cart-item-name { font-weight: bold; font-size: 0.95rem; margin-bottom: 0.5rem; }',
    '.gb-cart-item-controls { display: flex; gap: 0.6rem; align-items: center; }',
    '.gb-cart-qty { width: 3.2rem; padding: 0.35rem; text-align: center; border: 1px solid #e8dfc8; border-radius: 6px; font-size: 0.85rem; }',
    '.gb-cart-remove { background: none; border: none; color: #b03a2e; font-size: 0.82rem; cursor: pointer; text-decoration: underline; }',
    '.gb-cart-error { color: #b03a2e; font-size: 0.85rem; padding: 0 1.4rem; margin-bottom: 0.6rem; }',
    '.gb-cart-checkout { display: block; width: calc(100% - 2.8rem); margin: 1rem 1.4rem 1.4rem; padding: 0.85rem; border: none; border-radius: 6px; background: #DA9900; color: #1a1611; font-weight: bold; font-size: 1rem; cursor: pointer; }',
    '.gb-cart-checkout:hover { background: #FDDD3B; }',
    '.gb-cart-checkout:disabled { opacity: 0.6; cursor: default; }',
  ].join('\n');
  document.head.appendChild(style);

  // ---- Cart button in header ----
  var cartBtn = document.createElement('button');
  cartBtn.type = 'button';
  cartBtn.className = 'gb-cart-btn';
  cartBtn.innerHTML = '🔐 <span class="gb-cart-count" id="gbCartCount">0</span>';
  // Prefer appending inside <nav> so it flows/wraps naturally with the other
  // links; falls back to <header> on pages with no nav (order confirmation
  // pages, which only have a logo).
  var navEl = document.querySelector('header nav');
  var header = document.querySelector('header');
  if (navEl) navEl.appendChild(cartBtn);
  else if (header) header.appendChild(cartBtn);

  // ---- Drawer + overlay ----
  var overlay = document.createElement('div');
  overlay.className = 'gb-cart-overlay';
  overlay.hidden = true;
  document.body.appendChild(overlay);

  var drawer = document.createElement('div');
  drawer.className = 'gb-cart-drawer';
  drawer.hidden = true;
  document.body.appendChild(drawer);

  function openDrawer() {
    renderDrawer();
    drawer.hidden = false;
    overlay.hidden = false;
  }
  function closeDrawer() {
    drawer.hidden = true;
    overlay.hidden = true;
  }
  cartBtn.addEventListener('click', openDrawer);
  overlay.addEventListener('click', closeDrawer);

  function renderBadge() {
    var cart = getCart();
    var count = cart.reduce(function (sum, i) { return sum + i.quantity; }, 0);
    var el = document.getElementById('gbCartCount');
    if (el) el.textContent = count;
    cartBtn.classList.toggle('has-items', count > 0);
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderDrawer() {
    var cart = getCart();
    var html = '<div class="gb-cart-head"><h3>Your Cart</h3><button type="button" class="gb-cart-close">&times;</button></div>';
    if (!cart.length) {
      html += '<p class="gb-cart-empty">Your cart is empty. Add a denomination from any series page to get started.</p>';
    } else {
      html += '<div class="gb-cart-items">' + cart.map(function (item, i) {
        return '<div class="gb-cart-item">' +
          '<div class="gb-cart-item-name">' + esc(item.series) + ' ' + item.denomination + '</div>' +
          '<div class="gb-cart-item-controls">' +
            '<input type="number" class="gb-cart-qty" data-index="' + i + '" value="' + item.quantity + '" min="1" max="50">' +
            '<button type="button" class="gb-cart-remove" data-index="' + i + '">Remove</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
      html += '<div class="gb-cart-error" id="gbCartError" hidden></div>';
      html += '<button type="button" class="gb-cart-checkout" id="gbCartCheckoutBtn">Checkout</button>';
    }
    drawer.innerHTML = html;

    drawer.querySelector('.gb-cart-close').addEventListener('click', closeDrawer);
    drawer.querySelectorAll('.gb-cart-qty').forEach(function (input) {
      input.addEventListener('change', function () {
        updateQty(parseInt(input.dataset.index, 10), parseInt(input.value, 10) || 0);
      });
    });
    drawer.querySelectorAll('.gb-cart-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeFromCart(parseInt(btn.dataset.index, 10));
      });
    });
    var checkoutBtn = drawer.querySelector('#gbCartCheckoutBtn');
    if (checkoutBtn) checkoutBtn.addEventListener('click', doCheckout);
  }

  function doCheckout() {
    var cart = getCart();
    if (!cart.length) return;
    var btn = document.getElementById('gbCartCheckoutBtn');
    var errorEl = document.getElementById('gbCartError');
    btn.disabled = true;
    btn.textContent = 'Starting checkout…';
    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }

    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map(function (i) {
          return { series: i.series, denomination: i.denomination, faceValueGB: i.faceValueGB, quantity: i.quantity };
        }),
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok && data.url) {
          try { localStorage.removeItem(CART_KEY); } catch (e) {}
          window.location.href = data.url;
          return;
        }
        throw new Error(data.error || 'Could not start checkout.');
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Checkout';
        if (errorEl) {
          errorEl.textContent = err.message || 'Could not start checkout. Please try again or request a quote.';
          errorEl.hidden = false;
        } else {
          alert(err.message || 'Could not start checkout.');
        }
      });
  }

  // ---- Wire up "Add to Cart" buttons already on the page ----
  document.querySelectorAll('.buy-btn').forEach(function (btn) {
    btn.textContent = 'Add to Cart';
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.buy-btn');
    if (!btn) return;

    var row = btn.closest('.buy-row');
    var qtyInput = row.querySelector('.buy-qty');
    var quantity = Math.max(1, Math.min(50, parseInt(qtyInput.value, 10) || 1));

    addToCart({
      series: row.dataset.series,
      denomination: row.dataset.denomination,
      faceValueGB: parseFloat(row.dataset.faceValue),
      quantity: quantity,
    });

    var originalText = btn.textContent;
    btn.textContent = 'Added ✓';
    setTimeout(function () { btn.textContent = originalText; }, 1200);
    openDrawer();
  });

  renderBadge();
})();
