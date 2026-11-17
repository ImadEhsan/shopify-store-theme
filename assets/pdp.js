/* CoppedAU product page behaviour.

   ES5 only — this is served raw, there is no build step.

   Focal re-renders the buy box through <product-rerender> when a variant
   changes, which replaces our nodes. Everything here therefore binds on the
   document and reads the DOM at event time, rather than caching elements at
   load. Anything that genuinely must bind to a node guards with a data flag so
   a re-render cannot double-bind it. */
(function () {
  'use strict';

  window.CAU = window.CAU || {};

  /* Run fn now and again after every Focal re-render. */
  window.CAU.onRender = function (fn) {
    fn();
    document.addEventListener('variant:change', fn);
    document.addEventListener('variant:changed', fn);
    document.addEventListener('shopify:section:load', fn);
  };

  /* The BNPL explainer. Closes on the button, on the scrim, and on Escape,
     because a modal that only closes one way traps someone eventually. */
  function bnplModal(from) {
    var row = from.closest('.pdp-v2__bnpl') || document;
    return (row.parentNode || document).querySelector('[data-pdp-bnpl-modal]');
  }

  document.addEventListener('click', function (e) {
    var open = e.target.closest && e.target.closest('[data-pdp-bnpl-open]');
    if (open) {
      var m = bnplModal(open);
      if (m) { m.hidden = false; var c = m.querySelector('[data-pdp-bnpl-close]'); if (c) c.focus(); }
      return;
    }
    var close = e.target.closest && e.target.closest('[data-pdp-bnpl-close]');
    if (close) { var mc = close.closest('[data-pdp-bnpl-modal]'); if (mc) mc.hidden = true; return; }

    var scrim = e.target.closest && e.target.closest('[data-pdp-bnpl-modal]');
    if (scrim && !e.target.closest('.pdp-v2__modal-box')) scrim.hidden = true;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelector('[data-pdp-bnpl-modal]:not([hidden])');
    if (open) open.hidden = true;
  });


  /* Size-first, the prototype's way.

     Add to cart is never disabled for want of a size — a dead grey button
     tells a shopper nothing. It stays black and tappable, and opening the size
     sheet is what the tap does. Shop Pay gets the same treatment through a
     transparent catcher, because its own click cannot be intercepted: it is
     Shopify's element and it checks out with the pre-selected variant.

     This replaces assets/size-first.js, which disabled the button instead.

     Capture phase throughout, for the same reason as size-chart.js: Focal
     traps focus inside the open sheet and delegates its own handlers there. */

  function sizeTriggers() {
    return document.querySelectorAll('.pdp-v2 .product-form__option-selector button.select[aria-controls]');
  }

  /* The first size control the shopper has not answered yet. On a two-size set
     this is what makes Add to cart open the Sweatpant sheet once the Hoodie
     size is chosen, rather than reopening the first one. */
  function firstUnfilled() {
    var t = sizeTriggers();
    for (var i = 0; i < t.length; i++) {
      if (!t[i].getAttribute('data-pdp-chosen')) return t[i];
    }
    return t[0] || null;
  }

  window.CAU.openSizeSheet = function () {
    var trigger = firstUnfilled();
    if (!trigger) return false;
    trigger.click();
    return true;
  };

  function allChosen() {
    var t = sizeTriggers();
    if (!t.length) return true;
    for (var i = 0; i < t.length; i++) {
      if (!t[i].getAttribute('data-pdp-chosen')) return false;
    }
    return true;
  }

  function syncGuard() {
    var done = allChosen();
    var guards = document.querySelectorAll('[data-pdp-express-guard]');
    for (var i = 0; i < guards.length; i++) {
      guards[i].hidden = done;
      var wrap = guards[i].parentNode;
      var btn = wrap && wrap.querySelector('.shopify-payment-button');
      if (!btn) continue;
      if (done) { btn.removeAttribute('inert'); }
      else { btn.setAttribute('inert', ''); }
    }
  }
  window.CAU.syncGuard = syncGuard;
  /* The bundle builder seeds "This item" in the page's size only when the
     shopper actually chose one, not the pre-selected first variant. */
  window.CAU.allSizesChosen = allChosen;

  /* A page arriving with ?variant= was reached from a shared or back-button
     link, so the size on it was chosen deliberately. */
  function chosenFromUrl() {
    try { return new URLSearchParams(window.location.search).has('variant'); }
    catch (e) { return false; }
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;

    var opt = e.target.closest('.combo-box__option-item, [role="option"]');
    if (opt) {
      var combo = opt.closest('.combo-box');
      if (combo && combo.id) {
        var trig = document.querySelector('[aria-controls="' + combo.id + '"]');
        if (trig) {
          trig.setAttribute('data-pdp-chosen', '1');

          /* Focal rewrites the label only when the selection actually changes.
             Shopify pre-selects the first variant, so clicking that one is not
             a change — and since applyPlaceholder() has already replaced the
             label with the prompt, nothing would ever put the real value back.
             That is the one size that silently fails to register. Write it
             here; for every other option this is the same text Focal is about
             to write anyway. */
          var label = trig.querySelector('.select__selected-value');
          var name = opt.querySelector('.size-option__name');
          var text = (name ? name.textContent : opt.textContent).trim();
          if (label && text) label.textContent = text;
        }
      }
      setTimeout(function () { applyPlaceholder(); syncGuard(); }, 0);
      return;
    }

    var guard = e.target.closest('[data-pdp-express-guard]');
    if (guard) {
      e.preventDefault();
      e.stopPropagation();
      window.CAU.openSizeSheet();
      return;
    }

    var add = e.target.closest('.pdp-v2 [data-product-add-to-cart-button]');
    if (add && !allChosen()) {
      e.preventDefault();
      e.stopPropagation();
      window.CAU.openSizeSheet();
    }
  }, true);

  /* Shopify always pre-selects a variant, so the size field arrives reading
     "XX-Small" whether or not the shopper chose it. The design asks for a
     prompt until they do, and it is also the honest state: nothing has been
     chosen yet. The underlying form value is untouched — that is what the
     express-checkout guard is for.

     Once a size is picked, Focal rewrites this label itself and we leave it
     alone. */
  function placeholderFor(trigger) {
    var selector = trigger.closest('.product-form__option-selector');
    var name = selector && selector.querySelector('.product-form__option-name');
    var label = name ? name.textContent.replace(':', '').trim().toLowerCase() : 'size';
    return 'Select your ' + label;
  }

  function applyPlaceholder() {
    var t = sizeTriggers();
    for (var i = 0; i < t.length; i++) {
      var value = t[i].querySelector('.select__selected-value');
      if (!value) continue;

      if (t[i].getAttribute('data-pdp-chosen')) {
        t[i].classList.remove('pdp-v2--unchosen');
        continue;
      }
      value.textContent = placeholderFor(t[i]);
      t[i].classList.add('pdp-v2--unchosen');
    }
  }

  window.CAU.onRender(function () {
    if (chosenFromUrl()) {
      var t = sizeTriggers();
      for (var i = 0; i < t.length; i++) t[i].setAttribute('data-pdp-chosen', '1');
    }
    applyPlaceholder();
    syncGuard();
  });

  /* The rating rows: the buy box's and the Reviews section's heading.

     One writer, every row that asks. pdp-reviews.js calls this with the
     numbers Loox's Storefront API returns; syncRating below is only the
     fallback for a store with no Loox store ID in its loox metaobject yet. */
  window.CAU.setRating = function (rating, raters) {
    var rows = document.querySelectorAll('[data-pdp-rating]');
    if (!rows.length || !rating || !raters) return false;

    var label = raters + (raters === 1 ? ' review' : ' reviews');

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var stars = row.querySelector('.pdp-v2__stars');
      var text = row.querySelector('[data-pdp-rating-text]');
      var score = row.querySelector('[data-pdp-rating-score]');
      var count = row.querySelector('[data-pdp-rating-count]');

      if (stars) stars.style.setProperty('--pct', (rating * 20) + '%');
      /* The buy box states it as one line; the Reviews heading splits the
         score and the count either side of the stars. */
      if (text) text.textContent = rating.toFixed(1) + ' \u00b7 ' + label;
      if (score) score.textContent = rating.toFixed(1);
      if (count) count.textContent = label;

      row.hidden = false;
    }

    /* Latches so the scraper stands down for the rest of the page's life. */
    window.CAU.ratingSet = true;
    return true;
  };

  /* Fallback: scrape Loox's own widget.

     Runs only while the Storefront API has not answered - no Loox store ID in
     the loox metaobject entry, or a call that failed. Loox writes
     data-rating and data-raters onto its widget once its script answers, which
     can be after our first pass, hence the observer. The widget itself is
     clipped out of sight by CSS rather than display:none, so Loox still treats
     it as live and fills it. */
  function syncRating() {
    if (window.CAU.ratingSet) return true;

    var src = null, all = document.querySelectorAll('.loox-rating');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-rating')) { src = all[i]; break; }
    }
    if (!src) return false;

    return window.CAU.setRating(
      parseFloat(src.getAttribute('data-rating')),
      parseInt(src.getAttribute('data-raters') || '0', 10)
    );
  }

  if (document.querySelector('[data-pdp-rating]')) {
    if (!syncRating()) {
      var seen = new MutationObserver(function () {
        if (syncRating()) seen.disconnect();
      });
      seen.observe(document.body, { subtree: true, attributes: true,
        attributeFilter: ['data-rating', 'data-raters'], childList: true });
      /* Give up quietly rather than observe for the life of the page. */
      setTimeout(function () { seen.disconnect(); }, 15000);
    }
  }

  /* Drag the size sheet down to dismiss it.

     Phones only — above Focal's 741px switch the same element is an anchored
     dropdown and there is nothing to drag. The threshold is distance OR
     velocity, so a short flick dismisses as readily as a long pull, which is
     what platform sheets do. Below both, it springs back.

     Pointer events cover touch and mouse in one path. Capture phase, because
     Focal traps focus inside the open sheet and delegates its own handlers
     there. */

  var DRAG_CLOSE_PX = 90;
  var DRAG_CLOSE_VELOCITY = 0.5;   /* px per ms */
  var drag = null;

  function draggableSheet(target) {
    if (!target || !target.closest) return null;
    if (window.matchMedia('(min-width: 741px)').matches) return null;
    var grip = target.closest('.pdp-v2__grab, .pdp-v2 .combo-box__header');
    if (!grip) return null;
    /* The close and size-guide buttons keep their own jobs. */
    if (target.closest('button') && !target.closest('.pdp-v2__grab')) return null;
    return grip.closest('.combo-box');
  }

  document.addEventListener('pointerdown', function (e) {
    var sheet = draggableSheet(e.target);
    if (!sheet) return;
    drag = { sheet: sheet, startY: e.clientY, lastY: e.clientY, lastT: Date.now(), dy: 0, vy: 0 };
    sheet.classList.add('is-dragging');
  }, true);

  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dy = e.clientY - drag.startY;
    if (dy < 0) dy = 0;              /* the sheet does not drag upward */
    drag.dy = dy;
    /* Velocity is measured between this move and the previous one. Reading it
       at pointerup instead would compare the release point against itself,
       which is always zero — the flick would never register. */
    var now = Date.now();
    drag.vy = (e.clientY - drag.lastY) / Math.max(1, now - drag.lastT);
    drag.lastY = e.clientY;
    drag.lastT = now;
    drag.sheet.style.transform = 'translateY(' + dy + 'px)';
  }, true);

  function endDrag(e) {
    if (!drag) return;
    var sheet = drag.sheet;
    var dy = drag.dy;
    var velocity = drag.vy || 0;

    sheet.classList.remove('is-dragging');
    sheet.style.transform = '';

    if (dy > DRAG_CLOSE_PX || velocity > DRAG_CLOSE_VELOCITY) {
      var close = sheet.querySelector('[data-action="close"]');
      if (close) close.click();
    }
    drag = null;
  }

  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);

  /* The sticky bar's label and button.

     Focal owns when the bar appears — it is a <product-sticky-form> custom
     element that toggles its own hidden attribute on scroll — so nothing here
     tries to reveal it. All this does is keep its wording honest: what is
     about to be bought, and a button that says what tapping it will do. */
  function syncSticky() {
    var bar = document.querySelector('.product-sticky-form');
    if (!bar) return;

    var chosen = allChosen();
    var many = sizeTriggers().length > 1;

    var label = bar.querySelector('[data-pdp-sticky-size]');
    if (label) {
      var picked = [];
      var t = sizeTriggers();
      for (var i = 0; i < t.length; i++) {
        var v = t[i].querySelector('.select__selected-value');
        if (t[i].getAttribute('data-pdp-chosen') && v) picked.push(v.textContent.trim());
      }
      label.textContent = (chosen && picked.length) ? picked.join(' / ')
        : (many ? 'select options' : 'select size');
    }

    var button = bar.querySelector('[data-product-add-to-cart-button]');
    if (button) {
      /* Focal publishes the canonical wording in data-button-content and
         disables the button itself when the variant cannot be bought
         (product-sticky-form.liquid:148-152). Sniffing textContent instead
         captured "Sold out" as the canonical label on a sold-out variant and
         then wrote it back for the rest of the page's life. */
      if (button.disabled) {
        /* Focal's own label is the honest one here. Leave it alone. */
      } else if (chosen) {
        var real = button.getAttribute('data-button-content');
        if (real) button.textContent = real;
      } else {
        button.textContent = many ? 'Select options' : 'Select size';
      }
    }
  }
  window.CAU.syncSticky = syncSticky;

  window.CAU.onRender(syncSticky);
  document.addEventListener('click', function () { setTimeout(syncSticky, 0); }, true);
})();
