// Minimal, dependency-free DOM stub.
//
// Covers exactly the DOM surface that index.html's inline <script> touches:
// getElementById, querySelector/querySelectorAll for the selector forms the page
// uses, classList, textContent/innerHTML, value, style, and addEventListener plus
// a `dispatch` helper for firing handlers.
//
// It is deliberately NOT a general DOM implementation. Unknown selectors throw
// rather than silently returning null, so this file fails loudly instead of
// producing a misleading "everything renders fine" result when the page starts
// using something new.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

function decodeEntities(s) {
  return String(s).replace(/&(nbsp|amp|lt|gt|quot);/g, (m) => ENTITIES[m]);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1]] = m[2];
  return attrs;
}

class StubElement {
  constructor(tag, attrs) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs || {};
    this.value = this.attrs.value !== undefined ? this.attrs.value : '';
    this.style = {};
    this._rawText = '';
    this._htmlOverride = null;
    this._classes = new Set((this.attrs.class || '').split(/\s+/).filter(Boolean));
    this._listeners = {};
    this._children = [];
    this.parentNode = null;
  }

  get className() {
    return Array.from(this._classes).join(' ');
  }

  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const self = this;
    return {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toggle: (c) => (self._classes.has(c) ? self._classes.delete(c) : self._classes.add(c)),
    };
  }

  get textContent() {
    return this._htmlOverride !== null ? this._htmlOverride : decodeEntities(this._rawText).trim();
  }

  set textContent(v) {
    this._rawText = String(v);
    this._htmlOverride = null;
  }

  get innerHTML() {
    return this._htmlOverride !== null ? this._htmlOverride : this._rawText;
  }

  set innerHTML(v) {
    this._htmlOverride = String(v);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  select() {
    /* no-op: only used by the focus handler */
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }

  /** Fire registered handlers -- lets tests open the calendar, etc. */
  dispatch(type, event) {
    const ev = event || { target: this, preventDefault() {} };
    (this._listeners[type] || []).forEach((fn) => fn.call(this, ev));
  }

  matches(sel) {
    let m = /^\.([\w-]+)$/.exec(sel);
    if (m) return this._classes.has(m[1]);
    m = /^([a-zA-Z]+)\[type="([^"]+)"\]$/.exec(sel);
    if (m) return this.tagName === m[1].toUpperCase() && this.attrs.type === m[2];
    m = /^\.([\w-]+)\[([\w-]+)\]$/.exec(sel);
    if (m) {
      return (
        this._classes.has(m[1]) &&
        Object.prototype.hasOwnProperty.call(this.attrs, m[2])
      );
    }
    throw new Error('dom-stub: unsupported selector ' + sel);
  }

  _descendants(out) {
    for (const c of this._children) {
      out.push(c);
      c._descendants(out);
    }
    return out;
  }

  querySelector(sel) {
    const found = this._descendants([]).find((el) => {
      try {
        return el.matches(sel);
      } catch {
        return false;
      }
    });
    if (!found) throw new Error('dom-stub: no match for ' + sel);
    return found;
  }

  querySelectorAll(sel) {
    return this._descendants([]).filter((el) => {
      try {
        return el.matches(sel);
      } catch {
        return false;
      }
    });
  }
}

export function createDom(html) {
  const byId = new Map();
  const all = [];
  const root = new StubElement('#root', {});
  const stack = [root];

  // Tag scanner. Attribute values may contain ">" (e.g. inline style strings in
  // the script), so quoted runs are consumed as a unit.
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

  let cursor = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    // Text between the previous tag and this one belongs to the open element.
    if (m.index > cursor) stack[stack.length - 1]._rawText += html.slice(cursor, m.index);
    cursor = tagRe.lastIndex;

    const closeTag = m[1];
    const openTag = m[2];

    if (!openTag && !closeTag) continue; // comment / CDATA

    if (closeTag) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === closeTag.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    // Raw-text elements: everything up to the matching close tag is not markup.
    if (openTag.toLowerCase() === 'script' || openTag.toLowerCase() === 'style') {
      const end = html.toLowerCase().indexOf('</' + openTag.toLowerCase(), cursor);
      cursor = end === -1 ? html.length : end;
      tagRe.lastIndex = cursor;
      continue;
    }

    const attrs = parseAttrs(m[3]);
    const el = new StubElement(openTag, attrs);
    el.parentNode = stack[stack.length - 1];
    el.parentNode._children.push(el);
    all.push(el);
    if (attrs.id) byId.set(attrs.id, el);

    const isVoid = VOID_TAGS.has(openTag.toLowerCase()) || m[4] === '/';
    if (!isVoid) stack.push(el);
  }

  const document = {
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  };

  const winListeners = {};
  const opened = [];
  const window = {
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    // Records window.open calls so a test can assert where a click navigates.
    open(url, target) {
      opened.push({ url: String(url), target: target || '' });
      return null;
    },
  };

  const localStorage = createLocalStorage();

  return { document, window, localStorage, byId, all, root, opened };
}

/**
 * Standalone localStorage stub. `_store` is exposed so tests can assert that
 * the page wrote nothing at all.
 */
export function createLocalStorage() {
  const store = new Map();
  return {
    _store: store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

export { StubElement };
