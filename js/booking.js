/* =====================================================================
   MRKLL — checkout page: real availability, slot hold, Stripe Checkout.
   Talks only to the site's own API:
     GET  /api/availability          calendar + package (price, duration)
     POST /api/create-checkout-session  hold the slot, get the Stripe URL
     POST /api/release-hold          release this browser's hold
   The browser never decides prices, durations or rules: it only sends
   the chosen package, date and start time; the server checks everything.
   ===================================================================== */
(function () {
  "use strict";

  var core = window.MRKLLBookingCore;
  var calendar = document.getElementById("calendarDays");
  if (!core || !calendar) return;

  var HOLD_KEY = "mrkll.bookingHold";
  var REQUEST_TIMEOUT_MS = 15000;

  var el = {
    panel: document.querySelector(".calendar-panel"),
    monthTitle: document.getElementById("monthTitle"),
    prev: document.getElementById("prevMonth"),
    next: document.getElementById("nextMonth"),
    slots: document.getElementById("timeSlots"),
    packageName: document.getElementById("package-name"),
    duration: document.getElementById("package-duration"),
    price: document.getElementById("package-price"),
    date: document.getElementById("selected-date"),
    session: document.getElementById("session-time"),
    button: document.getElementById("continueBtn") || document.querySelector(".summary-card .btn"),
    message: document.getElementById("bookingMessage"),
    packageButtons: Array.prototype.slice.call(document.querySelectorAll("[data-package]")),
  };
  var buttonLabel = el.button ? el.button.textContent.trim() : "CONTINUE →";

  var state = {
    packageId: core.parsePackage(new URLSearchParams(window.location.search).get("package")),
    pkg: null,
    month: null,
    minMonth: null,
    maxMonth: null,
    days: [],
    selectedDate: null,
    selectedSlot: null,
    loadSeq: 0,
    loading: false,
    submitting: false,
  };

  /* ---------------- helpers ---------------- */

  function storageGet() {
    try {
      var raw = window.sessionStorage.getItem(HOLD_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function storageSet(value) {
    try { window.sessionStorage.setItem(HOLD_KEY, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function storageClear() {
    try { window.sessionStorage.removeItem(HOLD_KEY); } catch (e) { /* ignore */ }
  }

  // fetch with timeout; network problems become { status: 0 }.
  function request(url, options) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    var opts = Object.assign({ headers: {} }, options || {});
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts)
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          return { status: res.status, json: json };
        });
      })
      .catch(function () { return { status: 0, json: null }; })
      .then(function (result) {
        if (timer) clearTimeout(timer);
        return result;
      });
  }

  function postJson(url, body, extra) {
    return request(url, Object.assign({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    }, extra || {}));
  }

  function showMessage(text, tone) {
    if (!el.message) return;
    if (!text) {
      el.message.hidden = true;
      el.message.textContent = "";
      return;
    }
    el.message.textContent = text;
    el.message.className = "booking-message" + (tone === "info" ? " info" : "");
    el.message.hidden = false;
  }

  function setLoading(on) {
    state.loading = on;
    if (el.panel) {
      el.panel.classList.toggle("is-loading", on);
      el.panel.setAttribute("aria-busy", on ? "true" : "false");
    }
  }

  function setUrlPackage(packageId) {
    try {
      var url = new URL(window.location.href);
      url.searchParams.set("package", packageId);
      url.searchParams.delete("cancelled");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (e) { /* ignore */ }
  }

  /* ---------------- holds ---------------- */

  // Releases the hold this browser created, if any (cancel / new choice).
  function releaseStoredHold() {
    var hold = storageGet();
    if (!hold || !hold.bookingId || !hold.releaseToken) return Promise.resolve(false);
    storageClear();
    return postJson("/api/release-hold", { bookingId: hold.bookingId, releaseToken: hold.releaseToken }, { keepalive: true })
      .then(function (r) { return Boolean(r.json && r.json.released); });
  }

  /* ---------------- rendering ---------------- */

  function renderPackage() {
    el.packageButtons.forEach(function (b) {
      var active = b.getAttribute("data-package") === state.packageId;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
      b.disabled = state.submitting;
    });
    if (!state.pkg) return;
    el.packageName.textContent = state.pkg.name;
    el.duration.textContent = core.formatDuration(state.pkg.durationMinutes);
    el.price.textContent = core.formatPrice(state.pkg.priceCents, state.pkg.currency);
  }

  function renderNav() {
    if (el.monthTitle && state.month) el.monthTitle.textContent = core.monthLabel(state.month);
    if (el.prev) el.prev.disabled = state.submitting || !state.month || state.month <= state.minMonth;
    if (el.next) el.next.disabled = state.submitting || !state.month || state.month >= state.maxMonth;
  }

  function renderDays() {
    calendar.innerHTML = "";
    if (!state.days.length) return;
    for (var i = 0; i < core.leadingBlanks(state.days[0].date); i++) {
      var empty = document.createElement("div");
      empty.className = "calendar-empty";
      calendar.appendChild(empty);
    }
    state.days.forEach(function (day) {
      var view = core.dayView(day);
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = ["calendar-day"].concat(view.classes).join(" ");
      cell.textContent = String(Number(day.date.slice(8)));
      cell.setAttribute("data-date", day.date);
      cell.setAttribute("aria-label", view.ariaLabel);
      cell.disabled = !view.selectable || state.submitting;
      if (day.date === state.selectedDate) {
        cell.classList.add("active");
        cell.setAttribute("aria-pressed", "true");
      }
      if (view.selectable) {
        cell.addEventListener("click", function () { selectDate(day.date); });
      }
      calendar.appendChild(cell);
    });
  }

  function selectedDay() {
    for (var i = 0; i < state.days.length; i++) {
      if (state.days[i].date === state.selectedDate) return state.days[i];
    }
    return null;
  }

  function renderSlots() {
    el.slots.innerHTML = "";
    var day = selectedDay();
    if (!day) {
      var hint = document.createElement("p");
      hint.className = "slots-empty";
      hint.textContent = state.loading ? "Loading available times…" : "Select a date to see the available times.";
      el.slots.appendChild(hint);
      return;
    }
    day.slots.forEach(function (slot) {
      var view = core.slotView(slot);
      var b = document.createElement("button");
      b.type = "button";
      b.className = ["slot"].concat(view.classes).join(" ");
      b.textContent = slot.start;
      b.setAttribute("data-start", slot.start);
      b.setAttribute("aria-label", view.ariaLabel);
      b.disabled = !view.selectable || state.submitting;
      if (state.selectedSlot && state.selectedSlot.start === slot.start) {
        b.classList.add("active");
        b.setAttribute("aria-pressed", "true");
      }
      if (view.selectable) {
        b.addEventListener("click", function () { selectSlot(slot); });
      }
      el.slots.appendChild(b);
    });
  }

  function renderSummary() {
    el.date.textContent = state.selectedDate ? core.dateLabel(state.selectedDate) : "Not selected";
    el.session.textContent = state.selectedSlot ? core.sessionLabel(state.selectedSlot) : "Not selected";
    if (el.button) {
      el.button.disabled = state.submitting || state.loading || !state.selectedDate || !state.selectedSlot;
      el.button.textContent = state.submitting ? "SECURING YOUR SESSION…" : buttonLabel;
      el.button.setAttribute("aria-busy", state.submitting ? "true" : "false");
    }
  }

  function render() {
    renderPackage();
    renderNav();
    renderDays();
    renderSlots();
    renderSummary();
  }

  /* ---------------- data ---------------- */

  // Loads one month. Out-of-order responses (fast clicks) are ignored.
  function loadMonth(month, options) {
    var keepSelection = options && options.keepSelection;
    var seq = ++state.loadSeq;
    setLoading(true);
    render();
    var url = "/api/availability?package=" + encodeURIComponent(state.packageId) + (month ? "&month=" + encodeURIComponent(month) : "");
    return request(url).then(function (r) {
      if (seq !== state.loadSeq) return;
      setLoading(false);
      if (r.status === 200 && r.json && Array.isArray(r.json.days)) {
        state.pkg = r.json.package;
        state.month = r.json.month;
        state.minMonth = r.json.minMonth;
        state.maxMonth = r.json.maxMonth;
        state.days = r.json.days;
        // Keep the customer's choice only if it is still bookable.
        var day = keepSelection ? selectedDay() : null;
        if (!day || day.status !== "available") {
          state.selectedDate = null;
          state.selectedSlot = null;
        } else if (state.selectedSlot && !day.slots.some(function (s) { return s.start === state.selectedSlot.start && s.available; })) {
          state.selectedSlot = null;
        }
        render();
        return;
      }
      var code = r.json && r.json.error && r.json.error.code;
      if (code === "MONTH_OUT_OF_RANGE" && month) {
        return loadMonth(null);
      }
      showMessage(core.errorFor(r.status, code).message);
      render();
    });
  }

  /* ---------------- interactions ---------------- */

  function selectDate(date) {
    if (state.submitting) return;
    state.selectedDate = date;
    state.selectedSlot = null; // a time chosen for another day is never kept
    showMessage("");
    render();
  }

  function selectSlot(slot) {
    if (state.submitting || !slot.available) return;
    state.selectedSlot = slot;
    showMessage("");
    renderSlots();
    renderSummary();
  }

  function changePackage(packageId) {
    packageId = core.parsePackage(packageId);
    if (state.submitting || packageId === state.packageId) return;
    state.packageId = packageId;
    state.selectedSlot = null;
    setUrlPackage(packageId);
    showMessage("");
    loadMonth(state.month, { keepSelection: true });
  }

  function goToMonth(offset) {
    if (state.submitting || !state.month) return;
    var target = core.addMonths(state.month, offset);
    if (target < state.minMonth || target > state.maxMonth) return;
    state.selectedDate = null;
    state.selectedSlot = null;
    loadMonth(target);
  }

  function startCheckout() {
    if (state.submitting || !state.selectedDate || !state.selectedSlot) return; // double clicks
    state.submitting = true;
    showMessage("");
    render();

    releaseStoredHold()
      .then(function () {
        return postJson("/api/create-checkout-session", {
          packageId: state.packageId,
          date: state.selectedDate,
          startTime: state.selectedSlot.start,
        });
      })
      .then(function (r) {
        if (r.status === 200 && r.json && r.json.url && r.json.bookingId && r.json.releaseToken) {
          storageSet({
            bookingId: r.json.bookingId,
            releaseToken: r.json.releaseToken,
            packageId: state.packageId,
            date: state.selectedDate,
            startTime: state.selectedSlot.start,
            holdExpiresAt: r.json.holdExpiresAt,
          });
          window.location.assign(r.json.url);
          return; // stay disabled while the browser leaves the page
        }
        var code = r.json && r.json.error && r.json.error.code;
        var error = core.errorFor(r.status, code);
        state.submitting = false;
        showMessage(error.message);
        if (error.refresh) {
          state.selectedSlot = null;
          return loadMonth(state.month, { keepSelection: true });
        }
        render();
      });
  }

  /* ---------------- start ---------------- */

  el.packageButtons.forEach(function (b) {
    b.addEventListener("click", function () { changePackage(b.getAttribute("data-package")); });
  });
  if (el.prev) el.prev.addEventListener("click", function () { goToMonth(-1); });
  if (el.next) el.next.addEventListener("click", function () { goToMonth(1); });
  if (el.button) el.button.addEventListener("click", startCheckout);

  // Back from Stripe with the browser's back button (page restored from cache).
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    state.submitting = false;
    releaseStoredHold().then(function () { loadMonth(state.month, { keepSelection: true }); });
  });

  var params = new URLSearchParams(window.location.search);
  var cancelled = params.get("cancelled") === "1";
  var stored = storageGet();
  if (stored && stored.packageId && !params.get("package")) {
    state.packageId = core.parsePackage(stored.packageId);
  }
  setUrlPackage(state.packageId);

  releaseStoredHold().then(function (released) {
    if (cancelled) {
      showMessage(released || stored
        ? "Payment cancelled. Your selected time has been released — you can choose again."
        : "Payment cancelled. You can choose a new time.", "info");
    }
    return loadMonth(null);
  });
})();
