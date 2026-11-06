const PAGE_SIZE = 30;
const QUIET_AFTER_DAYS = 30;
const LAST_VISIT_KEY = 'msnews:lastVisit';
// Stands in for posts that mention no tracked technology, so deselecting one topic doesn't hide them.
const OTHER_TOPIC = 'Other';

const TYPES = [
  ['blog', 'Blogs'],
  ['youtube', 'YouTube'],
  ['x', 'X'],
  ['reddit', 'Reddit'],
];
const KIND_LABELS = { blog: 'Blog', youtube: 'YouTube', x: 'X', reddit: 'Reddit' };
const GROUP_LABELS = { blog: 'Microsoft blogs', youtube: 'YouTube', x: 'X', reddit: 'Reddit' };

const el = {
  top: document.getElementById('top'),
  types: document.getElementById('types'),
  topics: document.getElementById('topics'),
  topicsFilter: document.getElementById('topics-filter'),
  topicsToggle: document.getElementById('topics-toggle'),
  search: document.getElementById('search'),
  summary: document.getElementById('summary'),
  feed: document.getElementById('feed'),
  sentinel: document.getElementById('sentinel'),
  end: document.getElementById('end'),
  statusButton: document.getElementById('status-button'),
  statusDialog: document.getElementById('status-dialog'),
  statusNote: document.getElementById('status-note'),
  statusTable: document.getElementById('status-table'),
};

const ALL_TYPE_IDS = TYPES.map(([id]) => id);
const params = new URLSearchParams(location.search);

// A missing parameter means every source. An empty one means the user deselected them all.
function readSelectedTypes() {
  if (!params.has('types')) return new Set(ALL_TYPE_IDS);
  const requested = params.get('types').split(',');
  return new Set(ALL_TYPE_IDS.filter((id) => requested.includes(id)));
}

const state = {
  types: readSelectedTypes(),
  topics: new Set(),
  allTopics: [],
  query: params.get('q') ?? '',
  items: [],
  filtered: [],
  shown: 0,
  section: null,
  sectionKey: '',
  lastVisit: null,
  observer: null,
};

const now = () => Date.now();
const allTypesSelected = () => state.types.size === ALL_TYPE_IDS.length;
const allTopicsSelected = () => state.topics.size === state.allTopics.length;
const topicsOf = (item) => (item.topics?.length ? item.topics : [OTHER_TOPIC]);

// Storage can be unavailable in private windows, and "new" marks are only a convenience.
function readLastVisit() {
  try { return localStorage.getItem(LAST_VISIT_KEY); } catch { return null; }
}

function saveLastVisit() {
  try { localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString()); } catch { /* not saved */ }
}

function create(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

const isWebUrl = (value) => /^https?:\/\//i.test(value ?? '');

function relativeTime(iso) {
  const minutes = Math.round((now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return 'Today';
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  const options = { weekday: 'long', month: 'long', day: 'numeric' };
  if (date.getFullYear() !== today.getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(undefined, options);
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function pluralize(count, word) {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

function renderItem(item) {
  const published = new Date(item.publishedAt);
  const isNew = state.lastVisit && item.publishedAt > state.lastVisit;
  const url = isWebUrl(item.url) ? item.url : '#';
  const link = (label) => create('a', { class: 'item-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, label);

  const meta = create('div', { class: 'meta' },
    create('span', { class: `kind kind-${item.type}` }, KIND_LABELS[item.type] ?? item.type),
    create('span', {}, item.source),
    create('time', { dateTime: item.publishedAt, title: published.toLocaleString() }, relativeTime(item.publishedAt)));
  if (isNew) meta.append(create('span', { class: 'new-tag' }, 'New'));

  const row = create('article', { class: 'item' }, meta);

  const fullWidthImage = item.type === 'youtube' || item.type === 'x';
  let image = null;
  if (isWebUrl(item.image)) {
    image = create('img', {
      class: fullWidthImage ? 'media' : 'thumb',
      src: item.image,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      referrerPolicy: 'no-referrer',
    });
    image.addEventListener('error', () => image.remove());
    if (!fullWidthImage) row.append(image);
  }

  if (item.title) {
    row.append(create('h3', {}, link(item.title)));
    if (item.text) row.append(create('p', { class: 'excerpt' }, item.text));
  } else {
    row.append(create('p', { class: 'post-text' }, link(item.text)));
  }

  if (image && fullWidthImage) row.append(image);

  if (item.topics?.length) {
    const tags = create('div', { class: 'tags' });
    for (const topic of item.topics) {
      const tag = create('button', { class: 'tag', type: 'button' }, topic);
      tag.addEventListener('click', () => {
        state.topics = new Set([topic]);
        filtersChanged();
      });
      tags.append(tag);
    }
    row.append(tags);
  }
  return row;
}

function renderNextPage() {
  const page = state.filtered.slice(state.shown, state.shown + PAGE_SIZE);
  for (const item of page) {
    const date = new Date(item.publishedAt);
    const key = dayKey(date);
    if (key !== state.sectionKey) {
      state.sectionKey = key;
      state.section = create('section', { class: 'day' }, create('h2', { class: 'day-heading' }, dayLabel(date)));
      el.feed.append(state.section);
    }
    state.section.append(renderItem(item));
  }
  state.shown += page.length;
  el.end.hidden = state.filtered.length === 0 || state.shown < state.filtered.length;
  // The observer only reports changes, so a page too short to push the sentinel away needs a fresh look.
  state.observer?.unobserve(el.sentinel);
  state.observer?.observe(el.sentinel);
}

function matches(item, terms) {
  if (!state.types.has(item.type)) return false;
  if (!allTopicsSelected() && !topicsOf(item).some((topic) => state.topics.has(topic))) return false;
  if (!terms.length) return true;
  const haystack = `${item.title ?? ''} ${item.text ?? ''} ${item.source}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function selectAllTypes() {
  state.types = new Set(ALL_TYPE_IDS);
  filtersChanged();
}

function selectAllTopics() {
  state.topics = new Set(state.allTopics);
  filtersChanged();
}

function clearFilters() {
  state.types = new Set(ALL_TYPE_IDS);
  state.topics = new Set(state.allTopics);
  state.query = '';
  el.search.value = '';
  filtersChanged();
}

function renderSummary() {
  el.summary.replaceChildren();
  const hasFilter = !allTypesSelected() || !allTopicsSelected() || state.query.trim();
  el.summary.append(hasFilter ? `${pluralize(state.filtered.length, 'post')} match` : pluralize(state.filtered.length, 'post'));
  const newCount = state.lastVisit ? state.filtered.filter((item) => item.publishedAt > state.lastVisit).length : 0;
  if (newCount) el.summary.append(' · ', create('strong', {}, `${newCount.toLocaleString()} new since your last visit`));
}

function applyFilters() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  state.filtered = state.items.filter((item) => matches(item, terms));
  state.shown = 0;
  state.section = null;
  state.sectionKey = '';
  el.feed.replaceChildren();
  renderSummary();
  syncUrl();

  if (!state.filtered.length) {
    const unselected = !state.types.size ? 'sources' : !state.topics.size ? 'technologies' : null;
    const action = create('button', { type: 'button' }, unselected ? `Select all ${unselected}` : 'Clear filters');
    action.addEventListener('click', { sources: selectAllTypes, technologies: selectAllTopics }[unselected] ?? clearFilters);
    el.feed.append(create('p', { class: 'empty' }, unselected ? `No ${unselected} are selected. ` : 'Nothing matches these filters. ', action));
    el.end.hidden = true;
    return;
  }
  renderNextPage();
}

function syncUrl() {
  const next = new URLSearchParams();
  if (!allTypesSelected()) next.set('types', [...state.types].join(','));
  if (!allTopicsSelected()) next.set('topics', [...state.topics].join(','));
  if (state.query.trim()) next.set('q', state.query.trim());
  const search = next.toString();
  history.replaceState(null, '', search ? `?${search}` : location.pathname);
}

function filtersChanged() {
  syncToggles();
  applyFilters();
  scrollTo({ top: 0 });
}

// Buttons stay in place between clicks so keyboard focus and the open dropdown aren't disturbed.
function renderToggles(container, buttonClass, key, options) {
  const toggle = (label, value, update) => {
    const button = create('button', { class: buttonClass, type: 'button' }, label);
    if (value) button.dataset.value = value;
    button.addEventListener('click', () => {
      update();
      filtersChanged();
    });
    return button;
  };
  container.replaceChildren(
    toggle('All', null, () => {
      state[key] = new Set(options.map(([id]) => id));
    }),
    ...options.map(([id, label]) => toggle(label, id, () => {
      if (!state[key].delete(id)) state[key].add(id);
    })),
  );
}

function syncToggleGroup(container, selected, allSelected) {
  for (const button of container.children) {
    const { value } = button.dataset;
    button.setAttribute('aria-pressed', String(value ? selected.has(value) : allSelected));
  }
}

function topicsToggleLabel() {
  if (allTopicsSelected()) return 'All';
  if (state.topics.size === 0) return 'None';
  return state.topics.size === 1 ? [...state.topics][0] : `${state.topics.size} selected`;
}

function syncToggles() {
  syncToggleGroup(el.types, state.types, allTypesSelected());
  syncToggleGroup(el.topics, state.topics, allTopicsSelected());
  el.topicsToggle.firstElementChild.textContent = `Technologies: ${topicsToggleLabel()}`;
}

function setTopicsOpen(open) {
  el.topicsFilter.classList.toggle('open', open);
  el.topicsToggle.setAttribute('aria-expanded', String(open));
}

function setUpTopics() {
  const counts = new Map();
  for (const item of state.items) for (const topic of topicsOf(item)) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  const hasOther = counts.delete(OTHER_TOPIC);
  state.allTopics = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  if (hasOther) state.allTopics.push(OTHER_TOPIC);

  // A missing parameter means every topic. An empty one means the user deselected them all.
  const requested = params.get('topics')?.split(',');
  state.topics = new Set(requested ? state.allTopics.filter((topic) => requested.includes(topic)) : state.allTopics);

  renderToggles(el.topics, 'chip', 'topics', state.allTopics.map((topic) => [topic, topic]));
  el.topicsFilter.hidden = false;
}

function sourceState(source) {
  if (!source.ok) return { label: `Failed: ${source.error}`, warn: true };
  if (!source.newest) return { label: 'No posts returned', warn: true };
  const age = (now() - new Date(source.newest).getTime()) / 86_400_000;
  if (age > QUIET_AFTER_DAYS) return { label: `No posts since ${shortDate(source.newest)}`, warn: true };
  return { label: 'OK', warn: false };
}

function renderStatus(status) {
  if (!status) {
    el.statusButton.textContent = 'Sources';
    el.statusNote.textContent = 'Source status is not available right now.';
    return;
  }
  const failed = status.sources.filter((source) => !source.ok).length;
  const updated = relativeTime(status.generatedAt);
  el.statusButton.textContent = failed
    ? `Updated ${updated} · ${failed} source${failed === 1 ? '' : 's'} failed`
    : `Updated ${updated}`;
  el.statusButton.classList.toggle('warn', failed > 0);
  el.statusNote.textContent = `Last refresh: ${new Date(status.generatedAt).toLocaleString()}. ${status.sources.length - failed} of ${status.sources.length} sources responded.`;

  const body = create('tbody');
  for (const type of Object.keys(GROUP_LABELS)) {
    const group = status.sources.filter((source) => source.type === type);
    if (!group.length) continue;
    body.append(create('tr', {}, create('td', { class: 'source-group', colSpan: 2 }, GROUP_LABELS[type])));
    for (const source of group) {
      const { label, warn } = sourceState(source);
      body.append(create('tr', {},
        create('td', {}, source.name),
        create('td', { class: `source-state${warn ? ' warn' : ''}` }, label)));
    }
  }
  el.statusTable.replaceChildren(create('table', {}, body));
}

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function showLoadError() {
  el.summary.textContent = '';
  const retry = create('button', { type: 'button' }, 'Try again');
  retry.addEventListener('click', () => location.reload());
  el.feed.replaceChildren(create('p', { class: 'empty' }, 'The news could not be loaded. ', retry));
  el.statusButton.textContent = 'Sources';
}

function watchHeaderHeight() {
  const update = () => document.documentElement.style.setProperty('--header-height', `${el.top.offsetHeight}px`);
  new ResizeObserver(update).observe(el.top);
  update();
}

async function init() {
  watchHeaderHeight();
  el.search.value = state.query;
  renderToggles(el.types, '', 'types', TYPES);
  syncToggleGroup(el.types, state.types, allTypesSelected());

  el.topicsToggle.addEventListener('click', () => setTopicsOpen(!el.topicsFilter.classList.contains('open')));
  document.addEventListener('click', (event) => {
    if (!el.topicsFilter.contains(event.target)) setTopicsOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !el.topicsFilter.classList.contains('open')) return;
    setTopicsOpen(false);
    el.topicsToggle.focus();
  });

  let searchTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = el.search.value;
      applyFilters();
    }, 150);
  });
  el.statusButton.addEventListener('click', () => el.statusDialog.showModal());
  el.statusDialog.addEventListener('click', (event) => {
    if (event.target === el.statusDialog) el.statusDialog.close();
  });

  state.lastVisit = readLastVisit();

  const [feed, status] = await Promise.allSettled([loadJson('data/feed.json'), loadJson('data/status.json')]);
  renderStatus(status.status === 'fulfilled' ? status.value : null);
  if (feed.status === 'rejected') {
    showLoadError();
    return;
  }

  state.items = feed.value;
  saveLastVisit();
  state.observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.shown < state.filtered.length) renderNextPage();
  }, { rootMargin: '1000px' });
  setUpTopics();
  syncToggles();
  applyFilters();
}

init();
