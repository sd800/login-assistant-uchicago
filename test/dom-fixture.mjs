// Minimal DOM double for adapter behavior. It does not simulate browser layout.
export class Element {
  constructor(tag, attributes = {}, ...children) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.style = {};
    this.hidden = !!attributes.hidden;
    this.disabled = !!attributes.disabled;
    this.readOnly = !!attributes.readonly;
    this._value = attributes.value || '';
    this.clicks = 0;
    this.events = [];
    this.listeners = new Map();
    this.append(...children);
  }
  append(...children) {
    for (const child of children) {
      if (typeof child !== 'string') child.parentElement = this;
      this.children.push(child);
    }
  }
  remove() {
    const parent = this.parentElement;
    if (parent) { const index = parent.children.indexOf(this); if (index >= 0) parent.children.splice(index, 1); }
    this.parentElement = null;
  }
  insertBefore(child, reference) {
    child.remove();
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    if (index < 0) throw new Error('Reference node is not a child.');
    child.parentElement = this; this.children.splice(index, 0, child); return child;
  }
  prepend(child) { return this.insertBefore(child, this.children[0] || null); }
  attachShadow() { this._shadowRoot = new Element('shadow-root', {}); return this._shadowRoot; }
  get value() { return this._value; }
  set value(value) { this._value = value; }
  get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(value) { this.children = [String(value)]; }
  replaceChildren(...children) { this.children = []; this.append(...children); if (this.tagName === 'SELECT') this.value = children[0]?.value || ''; }
  addEventListener(type, listener) { const group = this.listeners.get(type) || []; group.push(listener); this.listeners.set(type, group); }
  async emit(type, extra = {}) {
    const event = { type, target: this, isTrusted: true, preventDefault() {}, ...extra };
    for (const listener of this.listeners.get(type) || []) await listener(event);
  }
  get innerText() { return this.textContent; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  matches(selector) {
    const attributes = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
    if (!attributes.every(([, key, value]) => this.getAttribute(key) !== null && (value === undefined || this.getAttribute(key) === value))) return false;
    const simple = selector.replace(/\[[^\]]+\]/g, '').trim();
    const tag = simple.match(/^[a-z][\w-]*/i)?.[0];
    const id = simple.match(/#([\w-]+)/)?.[1];
    const classes = [...simple.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    return (!tag || this.tagName === tag.toUpperCase()) &&
      (!id || this.getAttribute('id') === id) &&
      classes.every(c => (this.getAttribute('class') || '').split(/\s+/).includes(c));
  }
  descendants() { return this.children.filter(c => typeof c !== 'string').flatMap(c => [c, ...c.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter(e => selector.split(',').some(s => e.matches(s))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return this.descendants().find(e => e.getAttribute('id') === id) || null; }
  getClientRects() {
    for (let e = this; e; e = e.parentElement) if (e.hidden || e.style.display === 'none') return [];
    return [{}];
  }
  contains(node) { return this === node || this.descendants().includes(node); }
  closest(selector) {
    for (let e = this; e; e = e.parentElement) if (selector.split(',').some(part => e.matches(part))) return e;
    return null;
  }
  click() { this.clicks++; this.onClick?.(); }
  dispatchEvent(event) { this.events.push(event.type); }
}
export const element = (tag, attributes, ...children) => new Element(tag, attributes, ...children);
export function documentWith(...children) {
  const document = element('document', {}, element('body', {}, ...children));
  document.body = document.querySelector('body');
  document.createElement = tag => element(tag, {});
  return document;
}
