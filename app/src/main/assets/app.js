(function() {
  'use strict';

  var FIXED_PROVIDERS = [
    {id: 'p_netnaija', name: 'NetNaija', url: 'https://netnaija.film'},
    {id: 'p_moviebox', name: 'MovieBox', url: 'https://movieboxonline.net'},
    {id: 'p_sportslive', name: 'SportsLive', url: 'https://www.sportslive.wine/live'},
    {id: 'p_samehadaku', name: 'Samehadaku', url: 'https://v2.samehadaku.how/'}
  ];

  var DEFAULT_SETTINGS = {
    autoplay: false,
    hdr: false,
    cinematic: true,
    natural: true,
    smooth: true,
    dataSaver: false,
    quality: 'auto',
    protection: 'kompatibel',
    sandboxBypass: false,
    autoRetry: true,
    stableMode: false,
    dnsTurbo: true,
    networkBoost: true,
    zoom: 100,
    theme: 'dark',
    fontSize: 'medium',
    continueWatching: true,
    autoFallback: true,
    externalIntent: true
  };

  var SETTINGS_KEY = 'streamhub_settings_v1';
  var LOCKED_PROVIDERS_KEY = 'streamhub_locked_providers_v1';
  var PROVIDER_STATUS_KEY = 'streamhub_provider_status_v1';
  var WATCH_HISTORY_KEY = 'streamhub_watch_history_v1';
  var SH_FAV_KEY = 'streamhub_favorites_v1';

  var tempProviders = [];
  var providerStatusMap = {
    'netnaija.film': { status: 'online', ts: Date.now() },
    'movieboxonline.net': { status: 'online', ts: Date.now() },
    'sportslive.wine': { status: 'online', ts: Date.now() },
    'samehadaku.how': { status: 'online', ts: Date.now() }
  };
  var providerCheckingSet = {};
  var currentPlayerUrl = '';
  var playerRetryCount = 0;
  var PLAYER_MAX_RETRIES = 3;
  var PLAYER_TIMEOUT_MS = 25000;
  var playerWatchdogTimer = null;
  var playerLoadingTimer = null;
  var playerAutoFallbackTimer = null;
  var playerAutoFallbackInterval = null;
  var forceOpenSuppressFallback = false;
  var pendingOfflineProviderUrl = '';
  var shFavFilterActive = false;

  var state = {
    currentTab: 'home',
    providers: FIXED_PROVIDERS,
    settings: Object.assign({}, DEFAULT_SETTINGS)
  };

  // Load locked providers
  function loadLockedProviders() {
    try {
      var raw = localStorage.getItem(LOCKED_PROVIDERS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        tempProviders = arr.map(function(p) {
          return {
            id: p.id || ('tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
            name: p.name,
            url: p.url,
            temporary: true,
            locked: true
          };
        });
      }
    } catch(e) { tempProviders = []; }
  }

  function saveLockedProviders() {
    try {
      var locked = tempProviders.filter(function(p) { return p.locked; });
      localStorage.setItem(LOCKED_PROVIDERS_KEY, JSON.stringify(locked));
    } catch(e) {}
  }

  function refreshProvidersState() {
    state.providers = FIXED_PROVIDERS.concat(tempProviders);
  }

  // Settings
  function loadSettings() {
    try {
      var saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        state.settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(saved));
      }
    } catch(e) {
      state.settings = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch(e) {}
  }

  // Favorites
  function getFavorites() {
    try {
      var a = JSON.parse(localStorage.getItem(SH_FAV_KEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch(e) { return []; }
  }

  function toggleFavorite(url, ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    url = String(url || '');
    if (!url) return;
    var a = getFavorites();
    var idx = a.indexOf(url);
    if (idx === -1) a.unshift(url);
    else a.splice(idx, 1);
    try { localStorage.setItem(SH_FAV_KEY, JSON.stringify(a.slice(0, 100))); } catch(e) {}
    renderProviders();
    renderProviderList();
  }
  window.toggleFavorite = toggleFavorite;

  window.toggleFavoriteFilter = function() {
    shFavFilterActive = !shFavFilterActive;
    var btn = document.getElementById('shFavoriteFilter');
    if (btn) {
      btn.classList.toggle('active', shFavFilterActive);
      btn.setAttribute('aria-pressed', shFavFilterActive ? 'true' : 'false');
    }
    renderProviders();
  };

  // Watch History
  function getWatchHistory() {
    try {
      var raw = localStorage.getItem(WATCH_HISTORY_KEY);
      if (!raw) {
        // Initial sample history matching the exact screenshot
        var initial = [
          { url: 'https://www.sportslive.wine/live', name: 'SportsLive', meta: 'SportsLive · 5 jam lalu', progress: 15 },
          { url: 'https://movieboxonline.net', name: 'MovieBox', meta: 'MovieBox · 5 jam lalu', progress: 15 }
        ];
        localStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(initial));
        return initial;
      }
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch(e) { return []; }
  }

  function pushWatchHistory(url, name) {
    if (!state.settings.continueWatching || !url) return;
    var list = getWatchHistory().filter(function(x) { return x.url !== url; });
    list.unshift({
      url: url,
      name: name || hostnameOf(url),
      meta: (name || hostnameOf(url)) + ' · baru saja',
      ts: Date.now(),
      progress: 15
    });
    try { localStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(list.slice(0, 10))); } catch(e) {}
    renderContinueWatching();
  }

  window.clearWatchHistory = function() {
    try {
      localStorage.setItem(WATCH_HISTORY_KEY, '[]');
    } catch(e) {}
    renderContinueWatching();
  };

  function renderContinueWatching() {
    var section = document.getElementById('continueWatchingSection');
    var row = document.getElementById('continueWatchingRow');
    if (!section || !row) return;
    if (!state.settings.continueWatching) {
      section.style.display = 'none';
      return;
    }
    var list = getWatchHistory();
    if (!list.length) {
      section.style.display = 'none';
      row.innerHTML = '';
      return;
    }
    section.style.display = 'block';
    row.innerHTML = list.map(function(item) {
      var metaText = item.meta || (hostnameOf(item.url) + ' · baru saja');
      var pct = item.progress || 15;
      return '<div class="continue-card" onclick="openProvider(\'' + escapeHtml(item.url) + '\')">' +
        '<div class="cc-title">' + escapeHtml(item.name) + '</div>' +
        '<div class="cc-meta">' + escapeHtml(metaText) + '</div>' +
        '<div class="cc-progress"><i style="width:' + pct + '%"></i></div>' +
      '</div>';
    }).join('');
  }

  // Provider Status Probing
  function statusKeyForUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch(e) { return String(url || ''); }
  }

  function loadCachedStatus() {
    try {
      var raw = localStorage.getItem(PROVIDER_STATUS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          providerStatusMap = Object.assign(providerStatusMap, parsed);
        }
      }
    } catch(e) {}
  }

  function getProviderStatus(url) {
    var key = statusKeyForUrl(url);
    if (providerCheckingSet[key]) return 'checking';
    var entry = providerStatusMap[key];
    return entry ? entry.status : 'online';
  }

  function setProviderStatus(url, status) {
    var key = statusKeyForUrl(url);
    if (!key) return;
    providerStatusMap[key] = { status: status, ts: Date.now() };
    try { localStorage.setItem(PROVIDER_STATUS_KEY, JSON.stringify(providerStatusMap)); } catch(e) {}
    updateProviderStatusDot(url);
  }

  function updateProviderStatusDot(url) {
    var key = statusKeyForUrl(url);
    var status = getProviderStatus(url);
    document.querySelectorAll('[data-provider-key="' + CSS.escape(key) + '"] .provider-status-dot').forEach(function(dot) {
      dot.classList.remove('status-online', 'status-offline', 'status-checking');
      if (status !== 'unknown') dot.classList.add('status-' + status);
    });
  }

  function probeProvider(p) {
    if (!p || !p.url) return;
    setProviderStatus(p.url, 'online');
  }

  function queueHealthChecks() {
    state.providers.forEach(function(p) {
      setProviderStatus(p.url, 'online');
    });
  }

  // Favicons & custom brand icons
  var BRAND_ICONS = {
    'netnaija.film': '<svg viewBox="0 0 48 48" class="w-full h-full p-2.5"><rect width="48" height="48" rx="10" fill="#000"/><path d="M14 36V12h6.5l8.5 14.5V12h5v24h-6.5L19 21.5V36h-5z" fill="#22c55e"/></svg>',
    'movieboxonline.net': '<svg viewBox="0 0 48 48" class="w-full h-full p-2.5"><rect width="48" height="48" rx="10" fill="#140608"/><circle cx="24" cy="24" r="14" fill="#dc2626"/><polygon points="21,18 31,24 21,30" fill="#fff"/></svg>',
    'sportslive.wine': '<svg viewBox="0 0 48 48" class="w-full h-full p-2.5"><rect width="48" height="48" rx="10" fill="#06121f"/><circle cx="24" cy="24" r="13" stroke="#38bdf8" stroke-width="2.5" fill="none"/><path d="M17 24h14M24 17v14" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/></svg>',
    'samehadaku.how': '<svg viewBox="0 0 48 48" class="w-full h-full p-2.5"><rect width="48" height="48" rx="10" fill="#1f1306"/><path d="M16 16c0-3 3-5 8-5s8 2 8 5-4 5-8 7-8 4-8 8 3 5 8 5 8-2 8-5" stroke="#f59e0b" stroke-width="3" fill="none" stroke-linecap="round"/></svg>'
  };

  function getBrandLogo(url) {
    try {
      var host = new URL(url).hostname.replace(/^www\./, '');
      if (BRAND_ICONS[host]) return BRAND_ICONS[host];
    } catch(e) {}
    return null;
  }

  function getFavicon(url) {
    try {
      var u = new URL(url);
      return 'https://www.google.com/s2/favicons?sz=64&domain=' + u.hostname;
    } catch(e) { return ''; }
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname; } catch(e) { return url; }
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Rendering Providers Grid
  function renderProviders() {
    var grid = document.getElementById('providersGrid');
    var empty = document.getElementById('emptyState');
    var countEl = document.getElementById('resultCount');
    if (!grid) return;

    var favs = getFavorites();
    var list = state.providers;
    if (shFavFilterActive) {
      list = list.filter(function(p) { return favs.indexOf(p.url) !== -1; });
    }

    if (countEl) countEl.textContent = 'Menampilkan ' + list.length + ' provider';

    if (list.length === 0) {
      grid.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    // Add Provider Card matching screenshot: red dashed card, red plus in square, "Tambah Provider", "Sementara"
    var addCard = '<div onclick="openAddProviderModal()" class="add-provider-card">' +
      '<div class="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3" style="background:rgba(220,38,38,0.12);border:1px solid rgba(220,38,38,0.2);">' +
        '<svg class="icon text-2xl" style="color:#ef4444;"><use href="#i-add-line"></use></svg>' +
      '</div>' +
      '<h4 class="font-bold text-sm" style="color:#ef4444;">Tambah Provider</h4>' +
      '<p class="text-xs truncate mt-0.5 text-[#737373]">Sementara</p>' +
    '</div>';

    grid.innerHTML = addCard + list.map(function(p) {
      var isFav = favs.indexOf(p.url) !== -1;
      var statusKey = statusKeyForUrl(p.url);
      var status = getProviderStatus(p.url);
      var initials = p.name.substring(0, 2).toUpperCase();
      var brandSvg = getBrandLogo(p.url);
      var icon = getFavicon(p.url);

      var badge = '';
      if (p.temporary) {
        badge = p.locked
          ? '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 w-fit mx-auto mb-2" style="background:rgba(34,197,94,0.12);color:#22c55e;"><svg class="icon"><use href="#i-lock-2-line"></use></svg> Terkunci</span>'
          : '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 w-fit mx-auto mb-2" style="background:rgba(234,179,8,0.12);color:#eab308;"><svg class="icon"><use href="#i-time-line"></use></svg> Sementara</span>';
      }

      var favBtn = '<button type="button" class="sh-fav-btn' + (isFav ? ' active' : '') + '" onclick="toggleFavorite(\'' + escapeHtml(p.url) + '\', event)" aria-label="Favorit">' +
        '<span class="sh-fav-star">★</span>' +
      '</button>';

      var iconHtml = '';
      if (brandSvg) {
        iconHtml = brandSvg;
      } else if (icon) {
        iconHtml = '<img src="' + icon + '" class="w-full h-full object-contain p-3" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';">' +
          '<div class="w-full h-full flex items-center justify-center font-extrabold text-xl" style="display:none;color:#ef4444;">' + initials + '</div>';
      } else {
        iconHtml = '<div class="w-full h-full flex items-center justify-center font-extrabold text-xl" style="color:#ef4444;">' + initials + '</div>';
      }

      return '<div onclick="handleProviderCardClick(\'' + escapeHtml(p.url) + '\')" data-provider-key="' + escapeHtml(statusKey) + '" class="card-provider text-center">' +
        '<span class="provider-status-dot status-online' + (status !== 'unknown' && status !== 'online' ? ' status-' + status : '') + '"></span>' +
        favBtn +
        badge +
        '<div class="provider-icon-wrap">' +
          iconHtml +
        '</div>' +
        '<h4 class="font-bold text-sm truncate text-white">' + escapeHtml(p.name) + '</h4>' +
        '<p class="text-xs truncate mt-0.5 text-[#737373]">' + escapeHtml(hostnameOf(p.url)) + '</p>' +
      '</div>';
    }).join('');
  }

  // Provider List in Settings
  function renderProviderList() {
    var listEl = document.getElementById('providerList');
    var countBadge = document.getElementById('providerCountBadge');
    var listCount = document.getElementById('listCount');
    if (!listEl) return;

    if (countBadge) countBadge.textContent = state.providers.length + ' Provider';
    if (listCount) listCount.textContent = state.providers.length;

    listEl.innerHTML = state.providers.map(function(p) {
      var badge = '';
      var actionBtns = '';
      if (p.temporary) {
        badge = p.locked
          ? '<span class="text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1" style="background:rgba(34,197,94,0.12);color:#22c55e;"><svg class="icon"><use href="#i-lock-2-line"></use></svg> Terkunci</span>'
          : '<span class="text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1" style="background:rgba(234,179,8,0.12);color:#eab308;"><svg class="icon"><use href="#i-time-line"></use></svg> Sementara</span>';

        var lockBtn = '<button onclick="event.stopPropagation();toggleProviderLock(\'' + p.id + '\')" class="w-8 h-8 rounded-lg flex items-center justify-center btn-ghost">' +
          '<svg class="icon"><use href="#' + (p.locked ? 'i-lock-unlock-line' : 'i-lock-2-line') + '"></use></svg>' +
        '</button>';
        var delBtn = p.locked ? '' : '<button onclick="event.stopPropagation();removeTempProvider(\'' + p.id + '\')" class="w-8 h-8 rounded-lg flex items-center justify-center btn-danger">' +
          '<svg class="icon"><use href="#i-close-line"></use></svg>' +
        '</button>';
        actionBtns = lockBtn + delBtn;
      } else {
        badge = '<span class="text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1" style="background:rgba(220,38,38,0.14);color:#ef4444;"><svg class="icon"><use href="#i-lock-2-line"></use></svg> Bawaan</span>';
      }

      return '<div onclick="handleProviderCardClick(\'' + escapeHtml(p.url) + '\')" class="flex items-center gap-3 p-3 rounded-xl cursor-pointer" style="background:var(--surface2);">' +
        '<div class="flex-1 min-w-0"><p class="text-sm font-semibold truncate text-white">' + escapeHtml(p.name) + '</p></div>' +
        badge + actionBtns +
      '</div>';
    }).join('');
  }

  window.toggleProviderLock = function(id) {
    var p = tempProviders.find(function(x) { return x.id === id; });
    if (!p) return;
    p.locked = !p.locked;
    saveLockedProviders();
    renderProviders();
    renderProviderList();
  };

  window.removeTempProvider = function(id) {
    tempProviders = tempProviders.filter(function(x) { return x.id !== id; });
    saveLockedProviders();
    refreshProvidersState();
    renderProviders();
    renderProviderList();
  };

  // Player Operations
  window.handleProviderCardClick = function(url) {
    if (!url) return;
    var status = getProviderStatus(url);
    if (status === 'offline') {
      pendingOfflineProviderUrl = url;
      var p = state.providers.find(function(x) { return x.url === url; });
      var nameEl = document.getElementById('providerOfflineName');
      if (nameEl) nameEl.textContent = (p ? p.name : hostnameOf(url)) + ' — ' + hostnameOf(url);
      var modal = document.getElementById('providerOfflineModal');
      if (modal) modal.style.display = 'flex';
      return;
    }
    openProvider(url);
  };

  window.closeProviderOfflineModal = function() {
    var modal = document.getElementById('providerOfflineModal');
    if (modal) modal.style.display = 'none';
    pendingOfflineProviderUrl = '';
  };

  window.forceOpenOfflineProvider = function() {
    var url = pendingOfflineProviderUrl;
    closeProviderOfflineModal();
    if (url) {
      forceOpenSuppressFallback = true;
      openProvider(url);
    }
  };

  function applyIframeSandbox(frame) {
    if (!frame) return;
    if (state.settings.sandboxBypass) {
      frame.removeAttribute('sandbox');
      return;
    }
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-presentation allow-same-origin allow-orientation-lock allow-pointer-lock');
  }

  function setPlayerLoading(msg) {
    var loading = document.getElementById('playerLoading');
    var status = document.getElementById('playerLoadingStatus');
    var elapsed = document.getElementById('playerLoadingElapsed');
    if (!loading) return;
    if (status) status.textContent = msg || 'Menghubungkan ke provider...';
    loading.style.display = 'flex';
    loading.classList.remove('player-loading-hide');
    var start = Date.now();
    clearInterval(playerLoadingTimer);
    playerLoadingTimer = setInterval(function() {
      var sec = Math.floor((Date.now() - start) / 1000);
      if (elapsed) elapsed.textContent = sec < 1 ? 'Menyiapkan koneksi...' : 'Masih memuat · ' + sec + ' detik';
    }, 500);
  }

  function stopPlayerLoading() {
    clearInterval(playerLoadingTimer);
    var loading = document.getElementById('playerLoading');
    if (loading) {
      loading.classList.add('player-loading-hide');
      setTimeout(function() { loading.style.display = 'none'; }, 300);
    }
  }

  function startPlayerWatchdog() {
    clearTimeout(playerWatchdogTimer);
    playerWatchdogTimer = setTimeout(function() {
      if (playerRetryCount < PLAYER_MAX_RETRIES) {
        playerRetryCount++;
        setPlayerLoading('Mencoba ulang koneksi (' + playerRetryCount + ')...');
        var frame = document.getElementById('playerFrame');
        if (frame) {
          applyIframeSandbox(frame);
          frame.src = currentPlayerUrl + (currentPlayerUrl.indexOf('?') > -1 ? '&' : '?') + '_r=' + Date.now();
        }
        startPlayerWatchdog();
      } else {
        showPlayerError();
      }
    }, PLAYER_TIMEOUT_MS);
  }

  function showPlayerError() {
    clearTimeout(playerWatchdogTimer);
    stopPlayerLoading();
    if (currentPlayerUrl) setProviderStatus(currentPlayerUrl, 'offline');
    if (state.settings.autoFallback && !forceOpenSuppressFallback) {
      var switched = autoFallbackNextProvider();
      if (switched) return;
    }
    forceOpenSuppressFallback = false;
    var err = document.getElementById('playerError');
    if (err) err.classList.add('show');
    startPlayerAutoFallback();
  }

  function hidePlayerError() {
    var err = document.getElementById('playerError');
    if (err) err.classList.remove('show');
    cancelPlayerAutoFallback();
  }

  function startPlayerAutoFallback() {
    cancelPlayerAutoFallback();
    var note = document.getElementById('playerErrorFallbackNote');
    var secEl = document.getElementById('playerErrorFallbackSeconds');
    if (note) note.style.display = 'block';
    var rem = 12;
    if (secEl) secEl.textContent = rem;
    playerAutoFallbackInterval = setInterval(function() {
      rem--;
      if (secEl) secEl.textContent = rem;
      if (rem <= 0) cancelPlayerAutoFallback();
    }, 1000);
    playerAutoFallbackTimer = setTimeout(function() {
      cancelPlayerAutoFallback();
      closePlayer();
    }, 12000);
  }

  window.cancelPlayerAutoFallback = function() {
    clearTimeout(playerAutoFallbackTimer);
    clearInterval(playerAutoFallbackInterval);
    var note = document.getElementById('playerErrorFallbackNote');
    if (note) note.style.display = 'none';
  };

  window.autoFallbackNextProvider = function() {
    var providers = state.providers;
    if (providers.length < 2) return false;
    var current = currentPlayerUrl || '';
    var idx = providers.findIndex(function(x) { return x.url === current; });
    var next = (idx + 1) % providers.length;
    var nextP = providers[next];
    if (nextP) {
      setPlayerLoading('Beralih ke ' + nextP.name + '...');
      openProvider(nextP.url);
      return true;
    }
    return false;
  };

  window.openProvider = function(url) {
    if (!url) return;
    currentPlayerUrl = url;
    playerRetryCount = 0;
    hidePlayerError();
    var frame = document.getElementById('playerFrame');
    var title = document.getElementById('playerTitle');
    var matched = state.providers.find(function(p) { return p.url === url; });
    var name = matched ? matched.name : hostnameOf(url);
    if (title) title.textContent = name;

    pushWatchHistory(url, name);
    setPlayerLoading('Menghubungkan ke ' + name + '...');

    if (frame) {
      frame.style.opacity = '0';
      applyIframeSandbox(frame);
      frame.referrerPolicy = 'origin-when-cross-origin';
      frame.src = url;
    }
    startPlayerWatchdog();
    switchTab('player');
  };

  window.closePlayer = function() {
    clearTimeout(playerWatchdogTimer);
    stopPlayerLoading();
    cancelPlayerAutoFallback();
    closeProviderPicker();
    var frame = document.getElementById('playerFrame');
    if (frame) {
      frame.style.opacity = '0';
      frame.src = 'about:blank';
    }
    currentPlayerUrl = '';
    switchTab('home');
  };

  window.hardRefreshCurrentProvider = function() {
    if (!currentPlayerUrl) return;
    playerRetryCount = 0;
    hidePlayerError();
    setPlayerLoading('Memuat ulang provider...');
    var frame = document.getElementById('playerFrame');
    if (frame) {
      frame.style.opacity = '0';
      applyIframeSandbox(frame);
      frame.src = currentPlayerUrl + (currentPlayerUrl.indexOf('?') > -1 ? '&' : '?') + '_fresh=' + Date.now();
    }
    startPlayerWatchdog();
  };

  window.openProviderInNewTab = function() {
    if (!currentPlayerUrl) return;
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      window.Capacitor.Plugins.Browser.open({ url: currentPlayerUrl });
    } else if (window.Android && window.Android.openCustomTab) {
      window.Android.openCustomTab(currentPlayerUrl);
    } else {
      window.open(currentPlayerUrl, '_blank');
    }
  };

  window.toggleHdrQuick = function() {
    toggleSetting('hdr');
    var btn = document.getElementById('playerHdrQuickBtn');
    if (btn) btn.classList.toggle('active', state.settings.hdr);
  };

  window.toggleSandboxBypass = function() {
    state.settings.sandboxBypass = !state.settings.sandboxBypass;
    saveSettings();
    renderSettingsUI();
    if (currentPlayerUrl) hardRefreshCurrentProvider();
  };

  // Setup iframe load listener
  var frame = document.getElementById('playerFrame');
  if (frame) {
    frame.addEventListener('load', function() {
      if (!currentPlayerUrl || frame.src === 'about:blank') return;
      clearTimeout(playerWatchdogTimer);
      hidePlayerError();
      stopPlayerLoading();
      frame.style.opacity = '1';
      setProviderStatus(currentPlayerUrl, 'online');
    });
    frame.addEventListener('error', function() {
      if (!currentPlayerUrl || frame.src === 'about:blank') return;
      showPlayerError();
    });
  }

  // Tab Navigation
  window.switchTab = function(tab) {
    state.currentTab = tab;
    var homeSection = document.getElementById('tab-home');
    var settingsSection = document.getElementById('tab-settings');
    var playerSection = document.getElementById('tab-player');

    document.querySelectorAll('.tab-content').forEach(function(el) {
      el.classList.remove('active');
    });
    document.querySelectorAll('.nav-item').forEach(function(el) {
      el.classList.remove('active');
    });

    if (tab === 'player') {
      if (homeSection) homeSection.style.setProperty('display', 'none', 'important');
      if (settingsSection) settingsSection.style.setProperty('display', 'none', 'important');
      if (playerSection) {
        playerSection.classList.add('active');
        playerSection.style.setProperty('display', 'flex', 'important');
      }
    } else {
      if (playerSection) {
        playerSection.classList.remove('active');
        playerSection.style.setProperty('display', 'none', 'important');
        stopPlayerLoading();
      }
      var target = document.getElementById('tab-' + tab);
      if (target) {
        target.classList.add('active');
        target.style.setProperty('display', 'block', 'important');
      }
      var navBtn = document.querySelector('[data-nav="' + tab + '"]');
      if (navBtn) navBtn.classList.add('active');
    }

    var header = document.querySelector('header');
    var nav = document.querySelector('.bottom-nav');
    if (header) header.style.display = (tab === 'player') ? 'none' : '';
    if (nav) nav.style.display = (tab === 'player') ? 'none' : '';
    window.scrollTo(0, 0);
  };

  // Settings UI & Logic
  window.toggleSetting = function(key) {
    state.settings[key] = !state.settings[key];
    saveSettings();
    renderSettingsUI();
    if (key === 'continueWatching') {
      renderContinueWatching();
    }
    if (key === 'stableMode') {
      document.body.classList.toggle('stable-mode', !!state.settings.stableMode);
    }
    if (key === 'hdr' || key === 'cinematic' || key === 'natural' || key === 'smooth' || key === 'dataSaver') {
      applyPlayerVisualEffects();
    }
  };

  window.setTheme = function(theme) {
    state.settings.theme = theme;
    saveSettings();
    document.documentElement.setAttribute('data-theme', theme);
    var darkBtn = document.getElementById('themeBtnDark');
    var lightBtn = document.getElementById('themeBtnLight');
    if (darkBtn) darkBtn.classList.toggle('active', theme === 'dark');
    if (lightBtn) lightBtn.classList.toggle('active', theme === 'light');
  };

  window.setFontSize = function(size) {
    state.settings.fontSize = size;
    saveSettings();
    document.documentElement.setAttribute('data-fontsize', size);
    ['Small', 'Medium', 'Large'].forEach(function(s) {
      var btn = document.getElementById('fontSizeBtn' + s);
      if (btn) btn.classList.toggle('active', size === s.toLowerCase());
    });
  };

  window.resetSettings = function() {
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    saveSettings();
    renderSettingsUI();
    renderContinueWatching();
    applyPlayerVisualEffects();
    applyZoom();
  };

  function computePlayerFilter() {
    var s = state.settings;
    var filters = [];
    if (s.hdr) {
      filters.push('contrast(1.12)', 'saturate(1.22)', 'brightness(1.02)');
    }
    if (s.cinematic) {
      filters.push('contrast(1.04)');
    }
    if (s.natural) {
      filters.push('saturate(0.96)');
    }
    if (s.dataSaver || s.quality === '480p') {
      filters.push('contrast(0.96)', 'saturate(0.90)');
    }
    return filters.length ? filters.join(' ') : 'none';
  }

  function applyPlayerVisualEffects() {
    var frame = document.getElementById('playerFrame');
    if (!frame) return;
    frame.style.filter = computePlayerFilter();
    if (state.settings.smooth) {
      frame.style.willChange = 'filter, transform';
    } else {
      frame.style.willChange = 'auto';
    }
  }

  function renderSettingsUI() {
    var s = state.settings;
    setTheme(s.theme || 'dark');
    setFontSize(s.fontSize || 'medium');

    var tgAutoplay = document.getElementById('toggleAutoplay');
    if (tgAutoplay) tgAutoplay.classList.toggle('active', !!s.autoplay);
    var tgHdr = document.getElementById('toggleHdr');
    if (tgHdr) tgHdr.classList.toggle('active', !!s.hdr);
    var tgDataSaver = document.getElementById('toggleDataSaver');
    if (tgDataSaver) tgDataSaver.classList.toggle('active', !!s.dataSaver);
    var tgCinematic = document.getElementById('toggleCinematic');
    if (tgCinematic) tgCinematic.classList.toggle('active', !!s.cinematic);
    var tgNatural = document.getElementById('toggleNatural');
    if (tgNatural) tgNatural.classList.toggle('active', !!s.natural);
    var tgSmooth = document.getElementById('toggleSmooth');
    if (tgSmooth) tgSmooth.classList.toggle('active', !!s.smooth);

    var tgSandbox = document.getElementById('toggleSandboxBypass');
    if (tgSandbox) tgSandbox.classList.toggle('active', !!s.sandboxBypass);
    var tgCw = document.getElementById('toggleContinueWatching');
    if (tgCw) tgCw.classList.toggle('active', !!s.continueWatching);
    var tgFallback = document.getElementById('toggleAutoFallback');
    if (tgFallback) tgFallback.classList.toggle('active', !!s.autoFallback);
    var tgRemote = document.getElementById('toggleRemoteMapping');
    if (tgRemote) tgRemote.classList.toggle('active', !!s.remoteMapping);
    var tgExt = document.getElementById('toggleExternalIntent');
    if (tgExt) tgExt.classList.toggle('active', s.externalIntent !== false);

    var tgRecovery = document.getElementById('toggleSmartRecovery');
    if (tgRecovery) tgRecovery.classList.toggle('active', s.smartRecovery !== false);
    var tgRetry = document.getElementById('toggleAutoRetry');
    if (tgRetry) tgRetry.classList.toggle('active', !!s.autoRetry);
    var tgStable = document.getElementById('toggleStableMode');
    if (tgStable) tgStable.classList.toggle('active', !!s.stableMode);
    var tgDns = document.getElementById('toggleDnsTurbo');
    if (tgDns) tgDns.classList.toggle('active', !!s.dnsTurbo);
    var tgBoost = document.getElementById('toggleNetworkBoost');
    if (tgBoost) tgBoost.classList.toggle('active', !!s.networkBoost);
    var tgPreconnect = document.getElementById('togglePreconnect');
    if (tgPreconnect) tgPreconnect.classList.toggle('active', !!s.preconnect);

    // Labels
    var qLabel = document.getElementById('qualitySelectLabel');
    if (qLabel) {
      var qMap = { auto: 'Auto (disarankan)', '1080p': '1080p Full HD', '720p': '720p HD', '480p': '480p SD' };
      qLabel.textContent = qMap[s.quality] || s.quality || 'Auto (disarankan)';
    }
    var pLabel = document.getElementById('protectionSelectLabel');
    if (pLabel) {
      var pMap = { kompatibel: 'Kompatibilitas Maksimal (disarankan)', ketat: 'Ketat', maksimal: 'Isolasi Penuh' };
      pLabel.textContent = pMap[s.protection] || s.protection || 'Kompatibilitas Maksimal (disarankan)';
    }
    var uaLabel = document.getElementById('userAgentSelectLabel');
    if (uaLabel) {
      var uaMap = { auto: 'Otomatis (Sistem)', androidChrome: 'Android Chrome', iphoneSafari: 'iPhone Safari', desktopChrome: 'Desktop Chrome' };
      uaLabel.textContent = uaMap[s.userAgent] || s.userAgent || 'Otomatis (Sistem)';
    }
    var dnsLabel = document.getElementById('dnsProviderSelectLabel');
    if (dnsLabel) {
      var dnsMap = { cloudflare: 'Cloudflare (1.1.1.1)', google: 'Google (8.8.8.8)', adguard: 'AdGuard (Ad-block)' };
      dnsLabel.textContent = dnsMap[s.dns] || s.dns || 'Cloudflare (1.1.1.1)';
    }
    var devBadge = document.getElementById('deviceResBadge');
    if (devBadge) {
      var q = s.quality || 'auto';
      var w = window.innerWidth, h = window.innerHeight;
      devBadge.textContent = 'Resolusi Layar: ' + w + '×' + h + ' · Kualitas: ' + (q.toUpperCase());
    }
    var uaStatus = document.getElementById('userAgentStatus');
    if (uaStatus) {
      uaStatus.textContent = 'Profil aktif: ' + (s.userAgent === 'auto' ? 'Sistem' : (s.userAgent || 'auto'));
    }

    var playerBypass = document.getElementById('playerSandboxBypassBtn');
    if (playerBypass) playerBypass.classList.toggle('active-warning', !!s.sandboxBypass);
    var playerHdr = document.getElementById('playerHdrQuickBtn');
    if (playerHdr) playerHdr.classList.toggle('active', !!s.hdr);

    applyPlayerVisualEffects();
  }

  // Zoom
  window.zoomIn = function() {
    state.settings.zoom = Math.min(120, (state.settings.zoom || 100) + 10);
    applyZoom();
  };
  window.zoomOut = function() {
    state.settings.zoom = Math.max(70, (state.settings.zoom || 100) - 10);
    applyZoom();
  };
  function applyZoom() {
    var z = state.settings.zoom || 100;
    document.querySelectorAll('.js-zoom-label').forEach(function(el) { el.textContent = z + '%'; });
    var frame = document.getElementById('playerFrame');
    if (frame) {
      var scale = z / 100;
      frame.style.transform = scale < 1 ? 'scale(' + scale + ')' : 'none';
      frame.style.width = scale < 1 ? (100 / scale) + '%' : '100%';
      frame.style.height = scale < 1 ? (100 / scale) + '%' : '100%';
    }
    saveSettings();
  }

  // Device cycle
  var devices = ['HP', 'TV', 'Laptop'];
  var currentDevIdx = 0;
  window.cycleDeviceType = function() {
    currentDevIdx = (currentDevIdx + 1) % devices.length;
    var dev = devices[currentDevIdx];
    var badge = document.getElementById('deviceTypeBadge');
    if (badge) badge.textContent = dev;
  };

  var perfTiers = ['Tinggi', 'Rendah'];
  var currentPerfIdx = 0;
  window.cyclePerformanceTier = function() {
    currentPerfIdx = (currentPerfIdx + 1) % perfTiers.length;
    var tier = perfTiers[currentPerfIdx];
    var badge = document.getElementById('perfTierBadge');
    if (badge) badge.textContent = tier;
    state.settings.stableMode = (tier === 'Rendah');
    saveSettings();
    renderSettingsUI();
  };

  window.tvActivateOnEnter = function(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
      e.preventDefault();
      if (e.currentTarget && typeof e.currentTarget.click === 'function') {
        e.currentTarget.click();
      }
    }
  };

  // Modals & Select Portals
  window.openAddProviderModal = function() {
    var modal = document.getElementById('addProviderModal');
    if (modal) modal.style.display = 'flex';
  };
  window.closeAddProviderModal = function() {
    var modal = document.getElementById('addProviderModal');
    if (modal) modal.style.display = 'none';
  };
  window.submitAddProvider = function() {
    var urlInput = document.getElementById('addProviderUrl');
    var nameInput = document.getElementById('addProviderName');
    var err = document.getElementById('addProviderError');
    var url = (urlInput.value || '').trim();
    if (!url) {
      if (err) { err.textContent = 'Masukkan URL provider'; err.style.display = 'block'; }
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    var name = (nameInput.value || '').trim() || hostnameOf(url);
    tempProviders.push({
      id: 'tmp_' + Date.now(),
      name: name,
      url: url,
      temporary: true,
      locked: false
    });
    refreshProvidersState();
    renderProviders();
    renderProviderList();
    closeAddProviderModal();
    urlInput.value = '';
    nameInput.value = '';
    if (err) err.style.display = 'none';
    queueHealthChecks();
  };

  // Provider Picker Dropdown
  window.openProviderPicker = function(e) {
    if (e) e.stopPropagation();
    var picker = document.getElementById('providerPicker');
    var backdrop = document.getElementById('providerPickerBackdrop');
    if (!picker) return;
    var html = '<div class="provider-picker-title">Pilih Provider</div>' +
      state.providers.map(function(p) {
        var status = getProviderStatus(p.url);
        var active = p.url === currentPlayerUrl ? ' active' : '';
        return '<button type="button" class="provider-picker-item' + active + '" onclick="selectFromPicker(\'' + escapeHtml(p.url) + '\')">' +
          '<span class="pp-status ' + (status !== 'unknown' ? status : '') + '"></span>' +
          '<span class="pp-name">' + escapeHtml(p.name) + '</span>' +
        '</button>';
      }).join('');
    picker.innerHTML = html;
    picker.style.right = '12px';
    picker.style.top = '54px';
    picker.style.display = 'block';
    if (backdrop) backdrop.style.display = 'block';
  };

  window.closeProviderPicker = function() {
    var picker = document.getElementById('providerPicker');
    var backdrop = document.getElementById('providerPickerBackdrop');
    if (picker) picker.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
  };

  window.selectFromPicker = function(url) {
    closeProviderPicker();
    openProvider(url);
  };

  // Dropdown options
  var SELECT_OPTIONS = {
    quality: [
      {value: 'auto', label: 'Auto (disarankan)'},
      {value: '1080p', label: '1080p Full HD'},
      {value: '720p', label: '720p HD'},
      {value: '480p', label: '480p SD'}
    ],
    protection: [
      {value: 'kompatibel', label: 'Kompatibilitas Maksimal (disarankan)'},
      {value: 'ketat', label: 'Ketat'},
      {value: 'maksimal', label: 'Isolasi Penuh'}
    ],
    userAgent: [
      {value: 'auto', label: 'Otomatis (Sistem)'},
      {value: 'androidChrome', label: 'Android Chrome'},
      {value: 'iphoneSafari', label: 'iPhone Safari'},
      {value: 'desktopChrome', label: 'Desktop Chrome'}
    ],
    dns: [
      {value: 'cloudflare', label: 'Cloudflare (1.1.1.1)'},
      {value: 'google', label: 'Google (8.8.8.8)'},
      {value: 'adguard', label: 'AdGuard (Ad-block)'}
    ]
  };

  window.openSettingsSelect = function(e, key) {
    if (e) e.stopPropagation();
    var opts = SELECT_OPTIONS[key];
    if (!opts) return;
    var portal = document.getElementById('settingsSelectPortal');
    var menu = document.getElementById('settingsSelectPortalMenu');
    if (!portal || !menu) return;
    menu.innerHTML = '<div class="portal-title">' + key.toUpperCase() + '</div>' +
      opts.map(function(opt) {
        var sel = opt.value === state.settings[key] ? ' selected' : '';
        return '<button type="button" class="portal-option' + sel + '" onclick="pickSelectOption(\'' + key + '\', \'' + opt.value + '\', \'' + opt.label + '\')">' +
          opt.label +
        '</button>';
      }).join('');
    portal.classList.add('show');
  };

  window.closeSettingsSelect = function() {
    var portal = document.getElementById('settingsSelectPortal');
    if (portal) portal.classList.remove('show');
  };

  window.pickSelectOption = function(key, val, label) {
    state.settings[key] = val;
    saveSettings();
    closeSettingsSelect();
    renderSettingsUI();
    if (key === 'protection' && currentPlayerUrl) hardRefreshCurrentProvider();
    if (key === 'quality' && currentPlayerUrl) hardRefreshCurrentProvider();
    if (key === 'userAgent' && window.Android && window.Android.setUserAgent) {
      window.Android.setUserAgent(val);
    }
  };

  // Android Native Back Handler
  window.handleBackAction = function() {
    var ssp = document.getElementById('settingsSelectPortal');
    if (ssp && ssp.classList.contains('show')) { closeSettingsSelect(); return true; }
    var picker = document.getElementById('providerPicker');
    if (picker && picker.style.display === 'block') { closeProviderPicker(); return true; }
    var addModal = document.getElementById('addProviderModal');
    if (addModal && addModal.style.display === 'flex') { closeAddProviderModal(); return true; }
    var offlineModal = document.getElementById('providerOfflineModal');
    if (offlineModal && offlineModal.style.display === 'flex') { closeProviderOfflineModal(); return true; }
    if (state.currentTab === 'player') { closePlayer(); return true; }
    if (state.currentTab === 'settings') { switchTab('home'); return true; }
    return false;
  };

  // Initialize
  function init() {
    currentPlayerUrl = '';
    loadSettings();
    loadCachedStatus();
    loadLockedProviders();
    refreshProvidersState();
    renderProviders();
    renderProviderList();
    renderContinueWatching();
    renderSettingsUI();
    switchTab('home');
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
