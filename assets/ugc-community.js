/* Worn by the community: scroll progress and the desktop arrows.
   One listener per section, so several sections on a page stay independent. */
(function () {
  'use strict';

  function init(root) {
    var track = root.querySelector('[data-ugc-track]');
    if (!track) return;

    var progress = root.querySelector('[data-ugc-progress]');
    var thumb = root.querySelector('[data-ugc-thumb]');
    var arrows = root.querySelector('[data-ugc-arrows]');
    var prev = root.querySelector('[data-ugc-prev]');
    var next = root.querySelector('[data-ugc-next]');

    /* Review Focus 4: with one tile there is nothing to scroll, so neither
       control earns its space. scrollWidth can exceed clientWidth by a
       sub-pixel on fractional layouts, hence the 4px tolerance. */
    function scrollable() {
      return track.scrollWidth - track.clientWidth > 4;
    }

    function sync() {
      var on = scrollable();
      if (progress) progress.hidden = !on;
      if (arrows) arrows.hidden = !on;
      if (!on || !thumb) return;

      var max = track.scrollWidth - track.clientWidth;
      var ratio = track.clientWidth / track.scrollWidth;

      /* translateX(%) is relative to the thumb's OWN width, so the travel is
         (100 - w) / w. Deriving it from `ratio` instead only agrees while the
         8% floor is not biting; past ~12.5 screens of track the floor wins and
         the thumb slides clean out of the bar. Derive it from the width that
         was actually assigned. */
      var w = Math.max(ratio * 100, 8);
      thumb.style.width = w + '%';
      thumb.style.transform =
        'translateX(' + (max > 0 ? (track.scrollLeft / max) * ((100 - w) / w * 100) : 0) + '%)';
    }

    function step() {
      /* grid-auto-columns is not resolved to pixels by getComputedStyle - it
         comes back as the computed calc(), which parseFloat reads as NaN. The
         old fallback then used the 62% mobile ratio, but the arrows only exist
         at >=901px where the column is 25%, so every click jumped 2-3 tiles.
         The rendered tile is the honest source; columnGap IS resolved. */
      var first = track.firstElementChild;
      var gap = parseFloat(getComputedStyle(track).columnGap) || 10;
      return (first ? first.getBoundingClientRect().width : track.clientWidth * 0.25) + gap;
    }

    if (prev) prev.addEventListener('click', function () {
      track.scrollBy({ left: -step(), behavior: 'smooth' });
    });
    if (next) next.addEventListener('click', function () {
      track.scrollBy({ left: step(), behavior: 'smooth' });
    });

    track.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    sync();

    initLightbox(root, track);
  }

  /* Ported from the prototype's showUgc/openUgc/closeUgc. Everything the dialog
     shows comes off the clicked tile's data-* attributes, so the markup holds one
     dialog per section rather than one per post. Placeholder tiles carry no
     data-ugc-tile and are therefore not in the list: they are editor-only hints,
     not posts. */
  function initLightbox(root, track) {
    var modal = root.querySelector('[data-ugc-modal]');
    if (!modal) return;

    var tiles = [].slice.call(track.querySelectorAll('[data-ugc-tile]'));
    if (!tiles.length) return;

    var panel = modal.querySelector('[data-ugc-panel]');
    var img = modal.querySelector('[data-ugc-img]');
    var vid = modal.querySelector('[data-ugc-vid]');
    var cap = modal.querySelector('[data-ugc-cap]');
    var badge = modal.querySelector('[data-ugc-badge]');
    var count = modal.querySelector('[data-ugc-box-count]');
    var shop = modal.querySelector('[data-ugc-shop]');
    var shopImg = modal.querySelector('[data-ugc-shop-img]');
    var shopName = modal.querySelector('[data-ugc-shop-name]');
    var shopPrice = modal.querySelector('[data-ugc-shop-price]');
    var closeBtn = modal.querySelector('[data-ugc-close]');
    var media = modal.querySelector('[data-ugc-media]');
    var cur = 0;
    var lastFocus = null;

    function show(i) {
      cur = (i + tiles.length) % tiles.length;
      var t = tiles[cur];
      var tileImg = t.querySelector('img');
      var video = t.getAttribute('data-video');

      /* The dialog reuses the tile's already-decoded image, so opening a post
         costs no second download. */
      if (video) {
        img.hidden = true;
        vid.hidden = false;
        if (tileImg) vid.poster = tileImg.currentSrc || tileImg.src;
        vid.src = video;
        var playing = vid.play();
        if (playing && playing.catch) playing.catch(function () {});
      } else {
        try { vid.pause(); } catch (e) {}
        vid.removeAttribute('src');
        vid.hidden = true;
        img.hidden = false;
        if (tileImg) {
          img.src = tileImg.currentSrc || tileImg.src;
          img.alt = tileImg.alt || '';
        }
      }

      var caption = t.getAttribute('data-cap') || '';
      cap.textContent = caption;
      cap.hidden = !caption;

      var reel = t.getAttribute('data-reel');
      badge.hidden = !reel;
      if (reel) badge.textContent = 'Reel \u00b7 ' + reel;

      var url = t.getAttribute('data-product-url');
      shop.hidden = !url;
      if (url) {
        shop.href = url;
        shopName.textContent = t.getAttribute('data-product-title') || '';
        shopPrice.textContent = t.getAttribute('data-product-price') || '';
        var thumb = t.getAttribute('data-product-image');
        shopImg.hidden = !thumb;
        if (thumb) shopImg.src = thumb;
      }

      count.textContent = (cur + 1) + ' / ' + tiles.length;
      panel.setAttribute('aria-label', 'Instagram post ' + (cur + 1) + ' of ' + tiles.length);
    }

    function open(i) {
      lastFocus = document.activeElement;
      show(i);
      modal.hidden = false;
      document.documentElement.style.overflow = 'hidden';
      closeBtn.focus();
    }

    function close() {
      modal.hidden = true;
      try { vid.pause(); } catch (e) {}
      vid.removeAttribute('src');
      document.documentElement.style.overflow = '';
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    tiles.forEach(function (t, i) {
      t.addEventListener('click', function (e) {
        /* A tile with a product is a real <a> so it still works without JS;
           with JS the dialog wins and its "Shop this look" card carries the link. */
        e.preventDefault();
        open(i);
      });
    });

    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelector('[data-ugc-box-prev]').addEventListener('click', function () { show(cur - 1); });
    modal.querySelector('[data-ugc-box-next]').addEventListener('click', function () { show(cur + 1); });

    document.addEventListener('keydown', function (e) {
      if (modal.hidden) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') show(cur - 1);
      else if (e.key === 'ArrowRight') show(cur + 1);
    });

    var startX = null;
    media.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; }, { passive: true });
    media.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 40) show(cur + (dx < 0 ? 1 : -1));
      startX = null;
    });
  }

  function boot() {
    document.querySelectorAll('[data-ugc]').forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* The theme editor tears the section down and rebuilds it on every edit. */
  document.addEventListener('shopify:section:load', function (e) {
    e.target.querySelectorAll('[data-ugc]').forEach(init);
  });
})();
