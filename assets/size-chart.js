/* Size chart finder. Binds to every [data-size-finder] on the page. */
(function () {
  'use strict';

  function decode(value) {
    var el = document.createElement('textarea');
    el.innerHTML = value;
    return el.value;
  }
  function rows(attr) {
    if (!attr) return [];
    return decode(attr).split('~~').map(function (r) { return r.split('||'); });
  }

  function wire(root) {
    if (root.dataset.sizeFinderWired) return;
    root.dataset.sizeFinderWired = '1';

    var grid = rows(root.getAttribute('data-grid'));
    var meas = rows(root.getAttribute('data-measurements'));

    var rowSel = root.querySelector('[data-size-finder-row]');
    var colSel = root.querySelector('[data-size-finder-col]');
    var empty = root.querySelector('[data-size-finder-empty]');
    var result = root.querySelector('[data-size-finder-result]');
    var sizeEl = root.querySelector('[data-size-finder-size]');
    var ctxEl = root.querySelector('[data-size-finder-context]');
    var measEl = root.querySelector('[data-size-finder-measures]');
    if (!rowSel || !colSel || !result) return;

    /* "XXS  71.12  109.22" with headings "Size, Length (cm), Chest (cm)"
       becomes "71.12 Length (cm) - 109.22 Chest (cm)". */
    function measuresFor(size) {
      if (meas.length < 2) return '';
      var head = meas[0];
      for (var i = 1; i < meas.length; i++) {
        if ((meas[i][0] || '').trim() !== size) continue;
        var parts = [];
        for (var c = 1; c < head.length; c++) {
          if (meas[i][c]) parts.push(meas[i][c] + ' ' + head[c]);
        }
        return parts.join(' \u00b7 ');
      }
      return '';
    }

    function update() {
      var r = parseInt(rowSel.value, 10);
      var c = parseInt(colSel.value, 10);
      var ok = !isNaN(r) && !isNaN(c) && r > 0 && c > 0 && grid[r] && grid[r][c];

      if (!ok) {
        result.hidden = true;
        if (empty) empty.hidden = false;
        return;
      }

      var size = grid[r][c];
      sizeEl.textContent = size;
      ctxEl.textContent = grid[r][0] + ' \u00b7 ' + grid[0][c];

      var m = measuresFor(size);
      if (measEl) {
        measEl.textContent = m;
        measEl.hidden = !m;
      }
      if (empty) empty.hidden = true;
      result.hidden = false;
    }

    rowSel.addEventListener('change', update);
    colSel.addEventListener('change', update);
  }

  function scan() {
    document.querySelectorAll('[data-size-finder]').forEach(wire);
  }

  document.addEventListener('DOMContentLoaded', scan);
  scan();
})();

/* Two screens inside one panel: the chart, and the finder behind a button. */
(function () {
  'use strict';

  function show(panel, name) {
    panel.querySelectorAll('[data-size-chart-view]').forEach(function (view) {
      view.hidden = view.getAttribute('data-size-chart-view') !== name;
    });
    var focusable = panel.querySelector('[data-size-chart-view]:not([hidden]) button, [data-size-chart-view]:not([hidden]) select');
    if (focusable) focusable.focus();
    var scroller = panel.closest('.popover__content') || panel;
    scroller.scrollTop = 0;
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-size-chart-to]');
    if (!btn) return;
    var panel = btn.closest('[data-size-chart-views]');
    if (!panel) return;
    e.preventDefault();
    show(panel, btn.getAttribute('data-size-chart-to'));
  });

  /* Always open on the chart.

     Resetting on open rather than on close means it cannot depend on how the
     panel was dismissed, and a reset that somehow missed still self-corrects
     the next time it opens. Two triggers, because the click fires before the
     attribute lands and the observer covers every other way in. */
  function reset(popover) {
    var panel = popover.querySelector('[data-size-chart-views]');
    if (panel) {
      panel.querySelectorAll('[data-size-chart-view]').forEach(function (view) {
        view.hidden = view.getAttribute('data-size-chart-view') !== 'chart';
      });
    }

    /* Clear the finder too: both dropdowns back to "Select", the answer put
       away, and the prompt back. Reopening starts from nothing. */
    popover.querySelectorAll('[data-size-finder]').forEach(function (finder) {
      finder.querySelectorAll('select').forEach(function (sel) { sel.value = '-1'; });
      var result = finder.querySelector('[data-size-finder-result]');
      var empty = finder.querySelector('[data-size-finder-empty]');
      var measures = finder.querySelector('[data-size-finder-measures]');
      if (result) result.hidden = true;
      if (empty) empty.hidden = false;
      if (measures) measures.hidden = true;
    });

    var content = popover.querySelector('.popover__content');
    if (content) content.scrollTop = 0;
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('.size-chart__trigger');
    if (!trigger) return;
    var id = trigger.getAttribute('aria-controls');
    var popover = id && document.getElementById(id);
    if (popover) reset(popover);
  });

  function watchOpen() {
    document.querySelectorAll('.size-chart__popover').forEach(function (popover) {
      if (popover.dataset.sizeChartResetWired) return;
      popover.dataset.sizeChartResetWired = '1';
      new MutationObserver(function () {
        if (popover.hasAttribute('open')) reset(popover);
      }).observe(popover, { attributes: true, attributeFilter: ['open'] });
    });
  }

  document.addEventListener('DOMContentLoaded', watchOpen);
  watchOpen();
})();

/* The size guide as a view of the size sheet.

   The button swaps the sheet's body between the options and the chart. There
   is no second overlay and no timer, so there is no race between one popover
   closing and another opening — which is what kept breaking before.

   Two ways in, one destination: the button inside the sheet's header, and the
   "Size chart" link beside the SIZE label, which opens the sheet already on
   the guide. */
(function () {
  'use strict';

  /* Focal opens the picker from a sibling button, not from a class on the
     sheet: <button class="select" aria-controls="...-combo-box">. */
  function sheetFrom(el) {
    var scope = el.closest('.product-form__option-selector') || document;
    var toggle = scope.querySelector('button.select[aria-controls]');
    if (!toggle) return null;
    var combo = document.getElementById(toggle.getAttribute('aria-controls'));
    return combo ? { toggle: toggle, combo: combo } : null;
  }

  function host(combo) { return combo.querySelector('[data-size-chart-host]'); }
  function list(combo) { return combo.querySelector('.combo-box__option-list'); }

  function showGuide(combo, on) {
    var h = host(combo), l = list(combo);
    if (!h || !l) return;
    h.hidden = !on;
    l.hidden = on;
    /* Desktop presents the guide as a centred modal rather than the narrow
       anchored dropdown the picker normally is: a twelve-column table needs
       the width. CSS keys off this class. */
    combo.classList.toggle('is-guide', !!on);

    var btn = combo.querySelector('[data-open-size-chart]');
    var title = combo.querySelector('.combo-box__title');
    if (btn) btn.textContent = on ? 'Back' : 'Size guide';
    if (title) {
      if (!title.dataset.sizeChartLabel) title.dataset.sizeChartLabel = title.textContent;
      title.textContent = on ? 'Size guide' : title.dataset.sizeChartLabel;
    }
  }

  /* Only show the button where a chart actually resolved. */
  function reveal() {
    var buttons = document.querySelectorAll('[data-open-size-chart]');
    for (var i = 0; i < buttons.length; i++) {
      var combo = buttons[i].closest('.combo-box');
      buttons[i].hidden = !(combo && host(combo));
    }
    var links = document.querySelectorAll('[data-open-size-chart-link]');
    for (var j = 0; j < links.length; j++) {
      var sel = links[j].closest('.product-form__option-selector');
      links[j].hidden = !(sel && sel.querySelector('[data-size-chart-host]'));
    }
  }

  /* Capture phase on purpose. Focal activates a focus trap on the sheet 150ms
     after it opens, and its combo-box delegates its own click handlers inside
     it; either can stop a bubbling event before it reaches the document. A
     capture listener runs on the way down, so it cannot be intercepted. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-open-size-chart]');
    if (btn) {
      e.preventDefault();
      var combo = btn.closest('.combo-box');
      if (!combo) return;
      var h = host(combo);
      showGuide(combo, !!(h && h.hidden));
      return;
    }

    /* The link beside the label: open the sheet, then show the guide.

       Focal's picker is opened by a sibling <button class="select"> that names
       the combo-box in aria-controls — there is no toggle class on the sheet
       itself, so the button is found by that relationship. */
    var link = e.target.closest && e.target.closest('[data-open-size-chart-link]');
    if (link) {
      e.preventDefault();
      var pair = sheetFrom(link);
      if (!pair) return;
      pair.toggle.click();
      showGuide(pair.combo, true);
    }
  }, true);

  /* The sheet opens on the options, never on whatever it showed last. */
  document.addEventListener('click', function (e) {
    var toggle = e.target.closest && e.target.closest('button.select[aria-controls]');
    if (!toggle || e.defaultPrevented) return;
    var combo = document.getElementById(toggle.getAttribute('aria-controls'));
    if (combo) showGuide(combo, false);
  }, true);

  document.addEventListener('DOMContentLoaded', reveal);
  reveal();
})();
