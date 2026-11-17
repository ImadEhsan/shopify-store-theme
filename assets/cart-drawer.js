/* Cart drawer behaviour, on top of Focal's <cart-drawer>.

   Focal still opens, closes and re-renders the drawer: every cart change ends
   in a cart:refresh event whose detail carries the new mini-cart section HTML.
   This file only adds what Focal does not have, and always finishes through
   that same event, so there is one way the drawer updates.

   - Shipping protection: on by default. Added with the first item, removed
     with the last, and switched off by the shopper through a cart attribute
     (_protection_off) so the choice survives page loads.
   - Header badge: Focal writes cart.item_count, which includes the protection
     line. It is corrected here to the items the shopper actually chose.
   - "Complete your bundle": add buttons, size chips, the recommendations
     fetch, and "Browse all" opening the bundle builder where it exists.

   The drawer's state (item count, protection) is read from [data-cau-state],
   which the section renders; nothing here does cart maths of its own. */

(() => {
  if (window.CAU && window.CAU.cartDrawer) return;
  window.CAU = window.CAU || {};

  const drawer = document.getElementById('mini-cart');
  if (!drawer) return;

  const routes = (window.themeVariables && window.themeVariables.routes) || {};
  const CART_URL = routes.cartUrl || '/cart';
  const CART_ADD_URL = routes.cartAddUrl || '/cart/add';
  const RECOMMENDATIONS_URL = routes.productRecommendationsUrl || '/recommendations/products';
  const SECTION_ID = drawer.getAttribute('section') || 'mini-cart';

  /* ---------- state ---------- */

  function readState() {
    const el = drawer.querySelector('[data-cau-state]');
    if (!el) return null;
    return {
      itemCount: Number(el.dataset.itemCount || 0),
      productIds: (el.dataset.productIds || '').split(',').filter(Boolean),
      protectionVariant: el.dataset.protectionVariant || null,
      protectionProduct: el.dataset.protectionProduct ? Number(el.dataset.protectionProduct) : null,
      protectionQty: Number(el.dataset.protectionQty || 0),
      protectionOff: el.dataset.protectionOff === 'true'
    };
  }

  /* ---------- cart requests ---------- */

  function publish(cart, detail) {
    document.documentElement.dispatchEvent(new CustomEvent('cart:updated', { bubbles: true, detail: { cart } }));
    document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true, detail: Object.assign({ cart }, detail) }));
  }

  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(Object.assign({}, body, { sections: SECTION_ID }))
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.description || json.message || 'Your bag could not be updated. Please try again.');
    return json;
  }

  // /cart/update.js answers with the whole cart, sections included.
  async function updateCart(body) {
    const cart = await post(`${CART_URL}/update.js`, body);
    publish(cart, { replacementDelay: 0 });
    return cart;
  }

  // /cart/add.js answers with the added items only, so read the cart after.
  async function addVariant(id) {
    const result = await post(`${CART_ADD_URL}.js`, { items: [{ id: Number(id), quantity: 1 }] });
    const response = await fetch(`${CART_URL}.js`, { headers: { Accept: 'application/json' } });
    const cart = Object.assign(await response.json(), { sections: result.sections });
    publish(cart, { replacementDelay: 0 });
  }

  function showError(text) {
    const el = drawer.querySelector('[data-cau-error]');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  /* ---------- shipping protection ---------- */

  let syncing = false;
  let syncFailed = false;

  // Bring the protection line in line with the bag: one while there are items
  // and the shopper has not switched it off, none otherwise.
  async function syncProtection() {
    const state = readState();
    if (!state || !state.protectionVariant || syncing || syncFailed) return;

    const wanted = state.itemCount > 0 && !state.protectionOff ? 1 : 0;
    if (state.protectionQty === wanted) return;

    syncing = true;
    try {
      await updateCart({ updates: { [state.protectionVariant]: wanted } });
    } catch (error) {
      // Sold out or removed: stop trying for this page view rather than loop.
      syncFailed = true;
    } finally {
      syncing = false;
    }
  }

  async function onProtectChange(input) {
    const state = readState();
    if (!state || !state.protectionVariant) return;

    const on = input.checked;
    input.closest('.cau-protect').classList.toggle('is-off', !on);
    syncing = true;
    try {
      await updateCart({
        updates: { [state.protectionVariant]: on && state.itemCount > 0 ? 1 : 0 },
        attributes: { _protection_off: on ? '' : '1' }
      });
      syncFailed = false;
    } catch (error) {
      input.checked = !on;
      input.closest('.cau-protect').classList.toggle('is-off', on);
      showError(error.message);
    } finally {
      syncing = false;
    }
  }

  /* ---------- header badge ---------- */

  let badgeCount = null;

  function setBadges(count) {
    badgeCount = count;
    document.querySelectorAll('cart-count').forEach((el) => {
      if (el.textContent.trim() !== String(count)) el.textContent = count;
    });
  }

  function countFromCart(cart, protectionProduct) {
    return cart.items
      .filter((item) => item.product_id !== protectionProduct)
      .reduce((n, item) => n + item.quantity, 0);
  }

  // Focal's listeners run first (they were registered first) and write the raw
  // count; these run after and write the real one.
  ['cart:updated', 'cart:refresh'].forEach((name) => {
    document.documentElement.addEventListener(name, (event) => {
      const state = readState();
      const cart = event.detail && event.detail.cart;
      if (state && state.protectionProduct && cart && Array.isArray(cart.items)) {
        setBadges(countFromCart(cart, state.protectionProduct));
      }
    });
  });

  // Focal also refreshes the badge from its own /cart.js fetch, which lands
  // whenever it lands. Put the real count back if it does.
  const badgeObserver = new MutationObserver(() => {
    const state = readState();
    if (state && state.protectionProduct && badgeCount !== null) setBadges(badgeCount);
  });
  document.querySelectorAll('cart-count').forEach((el) => badgeObserver.observe(el, { childList: true, characterData: true, subtree: true }));

  /* ---------- complete your bundle ---------- */

  function refreshUpsell() {
    const upsell = drawer.querySelector('[data-cau-upsell]');
    if (!upsell) return;
    const state = readState();
    const inBag = state ? state.productIds : [];

    let shown = 0;
    upsell.querySelectorAll('[data-cau-card]').forEach((card) => {
      card.hidden = inBag.includes(card.dataset.cauCard);
      if (!card.hidden) shown += 1;
    });
    upsell.hidden = shown === 0;

    // Off the product page the button has no collection to link to and stays
    // hidden; on it, the bundle builder takes over.
    const browse = upsell.querySelector('button[data-cau-browse]');
    if (browse) browse.hidden = !window.CAU.bundleSheet;
  }

  function toggleSizes(button) {
    const box = document.getElementById(button.getAttribute('aria-controls'));
    if (!box) return;
    const open = box.hidden;
    box.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      box.closest('[data-cau-card]').scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const first = box.querySelector('button:not([disabled])');
      if (first) first.focus({ preventScroll: true });
    }
  }

  async function onAdd(button) {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-busy');
    showError('');
    try {
      await addVariant(button.dataset.cauAdd);
    } catch (error) {
      showError(error.message);
      button.disabled = false;
      button.classList.remove('is-busy');
    }
  }

  function onBrowse(event) {
    if (!window.CAU.bundleSheet) return;
    event.preventDefault();
    drawer.open = false;
    window.CAU.bundleSheet.open();
  }

  /* Recommendations for the newest item: Shopify's complementary products
     (set in Search & Discovery) when there are any, otherwise related ones.
     The drawer re-renders on every cart change, so answers are cached per
     product for the page view. */
  const recommendationsCache = {};

  async function loadRecommendations(productId) {
    for (const intent of ['complementary', 'related']) {
      try {
        const response = await fetch(`${RECOMMENDATIONS_URL}?product_id=${productId}&limit=10&section_id=${SECTION_ID}&intent=${intent}`);
        if (!response.ok) continue;
        const div = document.createElement('div');
        div.innerHTML = await response.text();
        const row = div.querySelector('cau-cart-recommendations');
        if (row && row.querySelector('[data-cau-card]')) return row.innerHTML;
      } catch (error) { /* try the next intent */ }
    }
    return '';
  }

  class CauCartRecommendations extends HTMLElement {
    async connectedCallback() {
      if (this.querySelector('[data-cau-card]')) return refreshUpsell();

      const productId = this.getAttribute('product-id');
      if (!productId) return;
      recommendationsCache[productId] = recommendationsCache[productId] || loadRecommendations(productId);

      const html = await recommendationsCache[productId];
      if (!this.isConnected) return;
      this.innerHTML = html;
      refreshUpsell();
    }
  }

  if (!window.customElements.get('cau-cart-recommendations')) {
    window.customElements.define('cau-cart-recommendations', CauCartRecommendations);
  }

  /* ---------- wiring ---------- */

  // The drawer's contents are replaced on every cart change, so listen on the
  // drawer itself, which stays.
  drawer.addEventListener('click', (event) => {
    const sizes = event.target.closest('[data-cau-sizes]');
    if (sizes) return toggleSizes(sizes);

    const add = event.target.closest('[data-cau-add]');
    if (add) return onAdd(add);

    const browse = event.target.closest('[data-cau-browse]');
    if (browse) return onBrowse(event);
  });

  drawer.addEventListener('change', (event) => {
    if (event.target.matches('[data-cau-protect]')) onProtectChange(event.target);
  });

  // Dim a line while Focal's remove request is in flight.
  drawer.addEventListener('line-item-quantity:change:start', (event) => {
    const line = event.target.closest('.cau-line');
    if (line) line.classList.add('is-busy');
  });

  function afterRender() {
    const state = readState();
    if (state && state.protectionProduct) setBadges(state.itemCount);
    refreshUpsell();
    syncProtection();
  }

  new MutationObserver(afterRender).observe(drawer, { childList: true });
  afterRender();

  // The drawer renders above the product section, so this file runs before
  // pdp-bundle-sheet.js; look for the bundle builder again once every
  // deferred script has run.
  document.addEventListener('DOMContentLoaded', refreshUpsell);

  window.CAU.cartDrawer = { sync: afterRender };
})();
