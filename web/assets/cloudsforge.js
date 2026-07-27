/* Hearth web — the shared CloudsForge identity bar, in plain JS.
 *
 * The explorer and the wallet are hand-written multi-page files with no
 * bundler, so <CloudsForgeBar> from @cloudsforge/ui cannot be rendered here.
 * Before this existed they carried their own nav and never said the word
 * CloudsForge — which mattered, because explorer.cloudsforge.online is the most
 * linkable public thing this company ships.
 *
 * A plain-JS translation of @cloudsforge/ui@0.3.0's `CloudsForgeBar`, emitting
 * the same DOM against the same `cf-` classes, styled by the vendored
 * vendor/cf-tokens.css + vendor/cf-ui.css. Same rule as assets/obs.js: the
 * React component is canonical — fix it there first, then mirror it here.
 *
 * The surface list below mirrors `@cloudsforge/shared/products`, which is the
 * single declaration of what a CloudsForge product is. Nothing here may invent
 * an entry; copy it from there.
 */
(function (global) {
  'use strict';

  /* ========================= surface registry ======================= *
   * Mirror of SURFACES in @cloudsforge/shared/products (0.2.0). Fields the
   * bar does not read (kind, verb, markId) are left out on purpose: this is a
   * mirror of a dependency, and every field copied is a field that can drift.
   * ------------------------------------------------------------------ */
  var CLOUDSFORGE_EMBER = '#e8622c';

  var SURFACES = [
    { key: 'site', name: 'CloudsForge', blurb: 'One crypto world', subdomain: '', devPort: 3000, accent: CLOUDSFORGE_EMBER, glyph: '◆', inSwitcher: true },
    { key: 'crypto', name: 'Hearth', blurb: 'Money mined at home', subdomain: 'hearth', devPort: 3003, accent: '#ff5a1e', glyph: '●', inSwitcher: true },
    { key: 'crucible', name: 'Crucible', blurb: 'Test the idea before you fund it', subdomain: 'crucible', devPort: 4006, accent: '#3fc8bb', glyph: '◐', inSwitcher: true },
    { key: 'mint', name: 'ForgeMint', blurb: 'Launch a token, cross-chain', subdomain: 'mint', devPort: 4004, accent: '#ff8a1f', glyph: '✦', inSwitcher: true },
    { key: 'wallet', name: 'Forge Pay', blurb: 'Shards & balances', subdomain: 'pay', devPort: 4003, accent: '#93a97c', glyph: '◈', inSwitcher: true },
    { key: 'play', name: 'Games', blurb: 'Ninety Days After', subdomain: 'play', devPort: 3001, accent: '#d9812f', glyph: '▲', inSwitcher: true },
    { key: 'admin', name: 'Admin', blurb: 'Operator console', subdomain: 'admin', devPort: 3002, accent: CLOUDSFORGE_EMBER, glyph: '▣', inSwitcher: true },
    { key: 'lantern', name: 'Lantern', blurb: 'Logs & errors', subdomain: 'lantern', devPort: 4010, accent: '#f4a63c', glyph: '✷', inSwitcher: true, adminOnly: true },
    { key: 'nimbus', name: 'Nimbus', blurb: 'Accounts & SSO', subdomain: 'nimbus', devPort: 4001, accent: CLOUDSFORGE_EMBER, glyph: '◇', inSwitcher: false },
    { key: 'account', name: 'CloudsForge Account', blurb: 'One account, everything', subdomain: 'account', devPort: 4001, accent: CLOUDSFORGE_EMBER, glyph: '◇', inSwitcher: false },
    { key: 'api', name: 'Game API', blurb: 'Ninety Days After API', subdomain: 'api', devPort: 4002, accent: '#d9812f', glyph: '▤', inSwitcher: false },
    { key: 'pay', name: 'Forge Pay API', blurb: 'Payments & the Shard economy', subdomain: 'pay', devPort: 4003, accent: '#93a97c', glyph: '▤', inSwitcher: false },
    { key: 'explorer', name: 'Hearth Explorer', blurb: 'Blocks, transactions & wallet', subdomain: 'explorer', devPort: 8080, accent: '#ff5a1e', glyph: '▦', inSwitcher: false },
    { key: 'keyvault', name: 'ForgeKeyvault', blurb: 'Custodial key service', subdomain: 'vault', devPort: 4005, accent: CLOUDSFORGE_EMBER, glyph: '▩', inSwitcher: false },
  ];

  var BY_KEY = {};
  var KNOWN_SUBS = { www: true };
  SURFACES.forEach(function (s) {
    BY_KEY[s.key] = s;
    if (s.subdomain) KNOWN_SUBS[s.subdomain] = true;
  });

  function isLocal(host) {
    return !host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
  }

  /* Resolved in the browser, never baked in at build time, so one copy of these
   * files serves localhost, the desktop app and production alike. */
  function hostFor(key) {
    var s = BY_KEY[key];
    if (!s) throw new Error('Unknown CloudsForge surface: ' + key);
    var host = location.hostname;
    if (isLocal(host)) return 'http://localhost:' + s.devPort;
    var parts = host.split('.');
    var apex = parts.length > 2 && KNOWN_SUBS[parts[0]] ? parts.slice(1).join('.') : host;
    return 'https://' + (s.subdomain ? s.subdomain + '.' : '') + apex;
  }

  /* The wallet is a route inside the game client rather than a host of its own,
   * so it is the one surface whose URL is derived rather than declared. */
  function urlFor(key) {
    return key === 'wallet' ? hostFor('play') + '/wallet' : hostFor(key);
  }

  function accountUrl() {
    return hostFor('account');
  }

  /* ============================= session ============================ *
   * The shared CloudsForge token keys, so a session handed to this origin is
   * stored where every other product looks for it. Best effort throughout:
   * the explorer and the wallet work perfectly well signed out, and neither
   * may break because Nimbus is unreachable.
   * ------------------------------------------------------------------ */
  var ACCESS_KEY = 'cf.accessToken';
  var REFRESH_KEY = 'cf.refreshToken';

  function setTokens(t) {
    try {
      localStorage.setItem(ACCESS_KEY, t.accessToken);
      localStorage.setItem(REFRESH_KEY, t.refreshToken);
    } catch (e) {
      /* private mode, or storage full — signed out is a fine outcome */
    }
  }

  function clearTokens() {
    try {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
    } catch (e) {
      /* ditto */
    }
  }

  function readToken(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function signInRedirect(returnUrl) {
    location.assign(accountUrl() + '/login?return=' + encodeURIComponent(returnUrl || location.href));
  }

  function signOutRedirect(returnUrl) {
    clearTokens();
    location.assign(accountUrl() + '/logout?return=' + encodeURIComponent(returnUrl || location.origin));
  }

  /**
   * Redeem the SSO hand-off code in location.hash (#cf_code=…) for this
   * origin's own tokens. Single-use, minute-lived and origin-bound, so it is
   * stripped from the URL whether or not redemption works.
   */
  function consumeAuthCallback() {
    var hash = location.hash.charAt(0) === '#' ? location.hash.slice(1) : location.hash;
    if (!hash) return Promise.resolve(null);
    var params = new URLSearchParams(hash);
    var code = params.get('cf_code');
    if (!code) return Promise.resolve(null);

    params.delete('cf_code');
    var rest = params.toString();
    history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));

    return fetch(hostFor('nimbus') + '/auth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code }),
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  /** Who the viewer is, or null. One silent refresh on a 401. */
  function fetchViewer() {
    var nimbus = hostFor('nimbus');

    function me() {
      var token = readToken(ACCESS_KEY);
      if (!token) return Promise.resolve(null);
      return fetch(nimbus + '/auth/me', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + token },
      }).catch(function () {
        return null;
      });
    }

    function shape(res) {
      if (!res || !res.ok) return null;
      return res.json().then(function (u) {
        return u && u.handle ? { handle: u.handle, roles: u.roles || [] } : null;
      });
    }

    return me().then(function (res) {
      if (!res || res.status !== 401) return shape(res);

      // Only a real 401 means these tokens are no good; Nimbus being down is
      // not the same thing and must not sign anybody out.
      var refreshToken = readToken(REFRESH_KEY);
      if (!refreshToken) {
        clearTokens();
        return null;
      }
      return fetch(nimbus + '/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshToken }),
      })
        .then(function (r) {
          if (!r.ok) {
            clearTokens();
            return null;
          }
          return r.json().then(function (t) {
            setTokens(t);
            return me().then(shape);
          });
        })
        .catch(function () {
          return null;
        });
    });
  }

  /* ============================== DOM =============================== */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        node.setAttribute(k, attrs[k]);
      });
    }
    return node;
  }

  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) {
      node.setAttribute(k, attrs[k]);
    });
    return node;
  }

  /** The CloudsForge emblem: an ember spark cresting an anvil-ash ridge. */
  function logoMark(size) {
    var root = svg('svg', {
      class: 'cf-logo__mark',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      role: 'img',
      'aria-label': 'CloudsForge',
      fill: 'none',
    });
    root.appendChild(
      svg('path', {
        d: 'M3 18.5h18M5.5 18.5c1-3.4 3.4-5.2 6.5-5.2s5.5 1.8 6.5 5.2',
        stroke: 'currentColor',
        'stroke-opacity': '0.55',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
    root.appendChild(
      svg('path', {
        d: 'M12 3.5c1.9 2.2 3 3.9 3 5.8a3 3 0 11-6 0c0-1.2.5-2.3 1.4-3.4.5 1 .1 1.9-.2 2.6 .7-.5 1.4-1.6 1.8-5z',
        fill: 'currentColor',
      }),
    );
    return root;
  }

  function caret() {
    var root = svg('svg', { class: 'cf-btn__caret', viewBox: '0 0 12 12', 'aria-hidden': 'true' });
    root.appendChild(
      svg('path', {
        d: 'M2 4l4 4 4-4',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
    return root;
  }

  var menuSeq = 0;

  /**
   * Shared dropdown behaviour, matching the React `useDropdown`: the menu only
   * exists while open, outside clicks and Escape close it, and Escape returns
   * focus to the trigger.
   */
  function dropdown(trigger, buildMenu) {
    var pop = el('div', 'cf-pop');
    var menu = null;
    pop.appendChild(trigger);

    function close() {
      if (!menu) return;
      pop.removeChild(menu);
      menu = null;
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    }

    function onDown(e) {
      if (!pop.contains(e.target)) close();
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        close();
        trigger.focus();
      }
    }

    function open() {
      menu = buildMenu(close);
      pop.appendChild(menu);
      trigger.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }

    trigger.addEventListener('click', function () {
      if (menu) close();
      else open();
    });

    return { root: pop, close: close };
  }

  function menuItem(node, surface, isCurrent) {
    node.className = 'cf-menu__item';
    node.setAttribute('role', 'menuitem');

    var icon = el('span', 'cf-menu__icon', { 'aria-hidden': 'true' });
    icon.style.color = surface.accent;
    icon.textContent = surface.glyph;
    node.appendChild(icon);

    var text = el('span', 'cf-menu__text');
    var name = el('span', 'cf-menu__name');
    name.textContent = surface.name;
    text.appendChild(name);
    if (surface.blurb) {
      var blurb = el('span', 'cf-menu__blurb');
      blurb.textContent = surface.blurb;
      text.appendChild(blurb);
    }
    node.appendChild(text);

    if (isCurrent) {
      node.setAttribute('aria-current', 'true');
      var check = el('span', 'cf-menu__check', { 'aria-hidden': 'true' });
      check.textContent = '●';
      node.appendChild(check);
    }
    return node;
  }

  function productSwitcher(current, isAdmin) {
    var menuId = 'cf-menu-' + ++menuSeq;
    var active = BY_KEY[current];

    var trigger = el('button', 'cf-btn', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-controls': menuId,
    });
    trigger.appendChild(el('span', 'cf-dot', { 'aria-hidden': 'true' }));
    var label = el('span', 'cf-switch__label');
    label.textContent = active ? active.name : 'Products';
    trigger.appendChild(label);
    trigger.appendChild(caret());

    return dropdown(trigger, function (close) {
      var list = el('ul', 'cf-menu cf-menu--left', {
        id: menuId,
        role: 'menu',
        'aria-label': 'CloudsForge products',
      });
      var heading = el('li', 'cf-menu__label', { 'aria-hidden': 'true' });
      heading.textContent = 'CloudsForge';
      list.appendChild(heading);

      SURFACES.filter(function (s) {
        return s.inSwitcher && (isAdmin || !s.adminOnly);
      }).forEach(function (s) {
        var li = el('li', null, { role: 'none' });
        var link = el('a', null, { href: urlFor(s.key) });
        link.addEventListener('click', close);
        li.appendChild(menuItem(link, s, s.key === current));
        list.appendChild(li);
      });

      return list;
    }).root;
  }

  function accountMenu(viewer) {
    if (!viewer) {
      var signIn = el('button', 'cf-btn cf-btn--ember', { type: 'button' });
      signIn.textContent = 'Sign in';
      signIn.addEventListener('click', function () {
        signInRedirect();
      });
      return signIn;
    }

    var menuId = 'cf-menu-' + ++menuSeq;
    var handle = viewer.handle || 'account';

    var trigger = el('button', 'cf-btn', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-controls': menuId,
    });
    var avatar = el('span', 'cf-account__avatar', { 'aria-hidden': 'true' });
    avatar.textContent = handle.slice(0, 2);
    trigger.appendChild(avatar);
    var name = el('span', 'cf-account__handle');
    name.textContent = handle;
    trigger.appendChild(name);
    trigger.appendChild(caret());

    return dropdown(trigger, function (close) {
      var list = el('ul', 'cf-menu cf-menu--right', {
        id: menuId,
        role: 'menu',
        'aria-label': 'Account',
      });
      var heading = el('li', 'cf-menu__label', { 'aria-hidden': 'true' });
      heading.textContent = 'Signed in as ' + handle;
      list.appendChild(heading);

      [
        {
          glyph: '◇',
          name: 'Account',
          run: function () {
            location.assign(accountUrl() + '/account');
          },
        },
        { sep: true },
        {
          glyph: '⏻',
          name: 'Sign out',
          run: function () {
            signOutRedirect(location.origin);
          },
        },
      ].forEach(function (entry) {
        var li = el('li', null, { role: 'none' });
        if (entry.sep) {
          li.setAttribute('aria-hidden', 'true');
          li.appendChild(el('hr', 'cf-menu__sep'));
        } else {
          var button = el('button', null, { type: 'button' });
          button.addEventListener('click', function () {
            close();
            entry.run();
          });
          li.appendChild(menuItem(button, { accent: '', glyph: entry.glyph, name: entry.name, blurb: '' }, false));
        }
        list.appendChild(li);
      });

      return list;
    }).root;
  }

  /**
   * Point every `[data-cf-surface]` link at the surface it names, resolved for
   * this environment. The markup carries the production URL as its href so the
   * link still works with scripting off; this only corrects it on localhost and
   * on any other apex.
   */
  function resolveLinks(root) {
    var nodes = (root || document).querySelectorAll('[data-cf-surface]');
    Array.prototype.forEach.call(nodes, function (node) {
      var key = node.getAttribute('data-cf-surface');
      if (!BY_KEY[key]) return;
      node.href = urlFor(key) + (node.getAttribute('data-cf-path') || '');
    });
  }

  /**
   * Render the bar into `mount` (replacing its contents) and then, once the
   * session resolves, swap the account control for the signed-in one.
   *
   *   CloudsForge.mountBar(document.getElementById('cf-bar'), { current: 'crypto' })
   */
  function mountBar(mount, options) {
    if (!mount) return;
    var current = (options && options.current) || 'site';

    function render(viewer) {
      var isAdmin = !!(viewer && viewer.roles && viewer.roles.indexOf('admin') !== -1);

      var bar = el('div', 'cf-bar cf-dark', { role: 'banner' });
      bar.style.colorScheme = 'dark';
      var inner = el('div', 'cf-bar__inner');

      var logo = el('a', 'cf-logo', { href: urlFor('site'), 'aria-label': 'CloudsForge home' });
      var logoInner = el('span', 'cf-logo__inner');
      logoInner.style.display = 'inline-flex';
      logoInner.style.alignItems = 'center';
      logoInner.style.gap = '0.5rem';
      logoInner.appendChild(logoMark(20));
      var word = el('span', 'cf-logo__word');
      word.appendChild(document.createTextNode('Clouds'));
      var bold = document.createElement('b');
      bold.textContent = 'Forge';
      word.appendChild(bold);
      logoInner.appendChild(word);
      logo.appendChild(logoInner);
      inner.appendChild(logo);

      inner.appendChild(el('span', 'cf-bar__sep', { 'aria-hidden': 'true' }));
      inner.appendChild(productSwitcher(current, isAdmin));
      inner.appendChild(el('span', 'cf-bar__spacer'));
      inner.appendChild(accountMenu(viewer));

      bar.appendChild(inner);
      mount.textContent = '';
      mount.appendChild(bar);
    }

    // Signed out first, so the bar is there on the first paint rather than
    // after a round trip to Nimbus that may never come back.
    render(null);
    resolveLinks(document);

    consumeAuthCallback()
      .then(function (handed) {
        if (handed) setTokens(handed);
        return fetchViewer();
      })
      .then(function (viewer) {
        if (viewer) render(viewer);
      })
      .catch(function () {
        /* stays signed out */
      });
  }

  global.CloudsForge = {
    SURFACES: SURFACES,
    urlFor: urlFor,
    accountUrl: accountUrl,
    signInRedirect: signInRedirect,
    signOutRedirect: signOutRedirect,
    consumeAuthCallback: consumeAuthCallback,
    resolveLinks: resolveLinks,
    mountBar: mountBar,
  };
})(window);
