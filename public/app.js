import { createSync } from './sync.js?v=__VERSION__';

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
const ADD_SOURCE_TYPES = [
  ['youtube', 'YouTube', '@MSFTMechanics or channel address'],
  ['reddit', 'Reddit', 'r/microsoft365'],
  ['x', 'X', '@MSFTCopilot'],
  ['blog', 'Blog', 'https://example.com/feed'],
];
const BOOKMARK_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2h8a1 1 0 0 1 1 1v11l-5-3-5 3V3a1 1 0 0 1 1-1z"/></svg>';

const el = {
  top: document.getElementById('top'),
  types: document.getElementById('types'),
  topics: document.getElementById('topics'),
  topicsFilter: document.getElementById('topics-filter'),
  topicsToggle: document.getElementById('topics-toggle'),
  search: document.getElementById('search'),
  summary: document.getElementById('summary'),
  notice: document.getElementById('notice'),
  feed: document.getElementById('feed'),
  sentinel: document.getElementById('sentinel'),
  end: document.getElementById('end'),
  savedButton: document.getElementById('saved-button'),
  syncButton: document.getElementById('sync-button'),
  syncDialog: document.getElementById('sync-dialog'),
  syncBody: document.getElementById('sync-body'),
  statusButton: document.getElementById('status-button'),
  statusDialog: document.getElementById('status-dialog'),
  statusNote: document.getElementById('status-note'),
  statusPersonal: document.getElementById('status-personal'),
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
  topicsReady: false,
  query: params.get('q') ?? '',
  savedOnly: params.get('saved') === '1',
  feedItems: [],
  customFeeds: new Map(),
  items: [],
  savedItems: [],
  filtered: [],
  shown: 0,
  section: null,
  sectionKey: '',
  lastVisit: null,
  observer: null,
  status: null,
  loaded: false,
  renderedSignature: '',
  syncIntro: '',
  syncError: '',
  syncNote: '',
  codeDrafts: { create: '', use: '', change: '' },
  addSourceError: '',
  addSourceType: ADD_SOURCE_TYPES[0][0],
  addingSource: false,
};

const sync = createSync({ onChange: profileChanged, onError: showNotice });

const now = () => Date.now();
const allTypesSelected = () => state.types.size === ALL_TYPE_IDS.length;
const allTopicsSelected = () => state.topics.size === state.allTopics.length;
const topicsOf = (item) => (item.topics?.length ? item.topics : [OTHER_TOPIC]);
const byNewest = (a, b) => b.publishedAt.localeCompare(a.publishedAt);

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

function button(label, onClick, props = {}) {
  const node = create('button', { type: 'button', ...props }, label);
  node.addEventListener('click', onClick);
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

function showNotice(message) {
  el.notice.textContent = message;
  el.notice.hidden = !message;
}

function isSaved(id) {
  return sync.profile?.bookmarks.some((item) => item.id === id) ?? false;
}

function openSyncDialog(intro = '') {
  state.syncIntro = intro;
  state.syncError = '';
  state.syncNote = '';
  renderSyncDialog({ force: true });
  if (!el.syncDialog.open) el.syncDialog.showModal();
}

function toggleSaved(item) {
  if (!sync.connected) {
    openSyncDialog('Saving posts needs a sync code, so they stay available on all your devices.');
    return;
  }
  // The whole post goes along, so a saved post survives after the archive drops it.
  sync.change(isSaved(item.id) ? { type: 'bookmark.remove', id: item.id } : { type: 'bookmark.add', item });
}

function saveButton(item) {
  const node = create('button', { class: 'save-button', type: 'button', title: 'Save post' });
  node.innerHTML = BOOKMARK_ICON;
  node.dataset.id = item.id;
  node.setAttribute('aria-label', 'Save post');
  node.setAttribute('aria-pressed', String(isSaved(item.id)));
  node.addEventListener('click', () => toggleSaved(item));
  return node;
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
  meta.append(saveButton(item));

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
      tags.append(button(topic, () => {
        state.topics = new Set([topic]);
        filtersChanged();
      }, { class: 'tag' }));
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
  const noun = state.savedOnly ? 'saved post' : 'post';
  el.summary.append(hasFilter ? `${pluralize(state.filtered.length, noun)} match` : pluralize(state.filtered.length, noun));
  const newCount = state.lastVisit && !state.savedOnly ? state.filtered.filter((item) => item.publishedAt > state.lastVisit).length : 0;
  if (newCount) el.summary.append(' · ', create('strong', {}, `${newCount.toLocaleString()} new since your last visit`));
}

function applyFilters() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const base = state.savedOnly ? state.savedItems : state.items;
  state.filtered = base.filter((item) => matches(item, terms));
  state.shown = 0;
  state.section = null;
  state.sectionKey = '';
  el.feed.replaceChildren();
  renderSummary();
  syncUrl();

  if (!state.filtered.length) {
    el.end.hidden = true;
    if (state.savedOnly && !state.savedItems.length) {
      el.feed.append(create('p', { class: 'empty' }, "You haven't saved any posts yet. Use the bookmark icon on a post to save it."));
      return;
    }
    const unselected = !state.types.size ? 'sources' : !state.topics.size ? 'technologies' : null;
    const action = button(unselected ? `Select all ${unselected}` : 'Clear filters', { sources: selectAllTypes, technologies: selectAllTopics }[unselected] ?? clearFilters);
    el.feed.append(create('p', { class: 'empty' }, unselected ? `No ${unselected} are selected. ` : 'Nothing matches these filters. ', action));
    return;
  }
  renderNextPage();
}

function syncUrl() {
  const next = new URLSearchParams();
  if (!allTypesSelected()) next.set('types', [...state.types].join(','));
  if (!allTopicsSelected()) next.set('topics', [...state.topics].join(','));
  if (state.query.trim()) next.set('q', state.query.trim());
  if (state.savedOnly) next.set('saved', '1');
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
    const node = button(label, () => {
      update();
      filtersChanged();
    }, { class: buttonClass });
    if (value) node.dataset.value = value;
    return node;
  };
  container.replaceChildren(
    toggle('All', null, () => {
      state[key] = new Set(state[key].size === options.length ? [] : options.map(([id]) => id));
    }),
    ...options.map(([id, label]) => toggle(label, id, () => {
      if (!state[key].delete(id)) state[key].add(id);
    })),
  );
}

function syncToggleGroup(container, selected, allSelected) {
  for (const node of container.children) {
    const { value } = node.dataset;
    node.setAttribute('aria-pressed', String(value ? selected.has(value) : allSelected));
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

function refreshTopics() {
  const counts = new Map();
  const everything = [...state.feedItems, ...[...state.customFeeds.values()].flat(), ...state.savedItems];
  for (const item of everything) for (const topic of topicsOf(item)) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  const hasOther = counts.delete(OTHER_TOPIC);
  const topics = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  if (hasOther) topics.push(OTHER_TOPIC);
  if (state.topicsReady && topics.join() === state.allTopics.join()) return;

  if (state.topicsReady) {
    // A technology that first appears later should not vanish from an "everything" view.
    const hadAll = allTopicsSelected();
    state.topics = new Set(hadAll ? topics : [...state.topics].filter((topic) => topics.includes(topic)));
  } else {
    // A missing parameter means every topic. An empty one means the user deselected them all.
    const requested = params.get('topics')?.split(',');
    state.topics = new Set(requested ? topics.filter((topic) => requested.includes(topic)) : topics);
    state.topicsReady = true;
  }
  state.allTopics = topics;
  renderToggles(el.topics, 'chip', 'topics', topics.map((topic) => [topic, topic]));
  el.topicsFilter.hidden = false;
}

function rebuildItems() {
  const hidden = new Set(sync.profile?.hiddenSources ?? []);
  const byId = new Map();
  for (const item of state.feedItems) if (!hidden.has(item.sourceId)) byId.set(item.id, item);
  for (const items of state.customFeeds.values()) for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  state.items = [...byId.values()].sort(byNewest);
  state.savedItems = [...(sync.profile?.bookmarks ?? [])].sort(byNewest);
  refreshTopics();
}

// Added sources live in their own files, and only people who added one download it.
async function loadCustomFeeds() {
  const wanted = sync.profile?.customSources ?? [];
  const keys = new Set(wanted.map((source) => source.key));
  for (const key of state.customFeeds.keys()) if (!keys.has(key)) state.customFeeds.delete(key);
  const missing = wanted.filter((source) => !state.customFeeds.has(source.key));
  await Promise.all(missing.map(async ({ key }) => {
    try {
      const response = await fetch(`data/custom/${encodeURIComponent(key)}.json`, { cache: 'no-cache' });
      state.customFeeds.set(key, response.ok ? await response.json() : []);
    } catch {
      state.customFeeds.set(key, []);
    }
  }));
}

function viewSignature() {
  return JSON.stringify({
    hidden: sync.profile?.hiddenSources ?? [],
    custom: [...state.customFeeds].map(([key, items]) => [key, items.length]),
    saved: state.savedOnly ? state.savedItems.map((item) => item.id) : [],
  });
}

// Saving a post must not reset the page, so the list only redraws when what it shows has changed.
function redrawIfNeeded() {
  const signature = viewSignature();
  if (signature === state.renderedSignature) return;
  state.renderedSignature = signature;
  syncToggles();
  applyFilters();
}

function syncSavedControls() {
  const count = sync.profile?.bookmarks.length ?? 0;
  el.savedButton.textContent = count ? `Saved ${count.toLocaleString()}` : 'Saved';
  el.savedButton.setAttribute('aria-pressed', String(state.savedOnly));
  for (const node of el.feed.querySelectorAll('.save-button')) {
    node.setAttribute('aria-pressed', String(isSaved(node.dataset.id)));
  }
}

async function profileChanged() {
  if (!sync.connected) state.savedOnly = false;
  rebuildItems();
  syncSavedControls();
  renderSyncDialog();
  renderStatus();
  if (!state.loaded) return;
  await loadCustomFeeds();
  rebuildItems();
  redrawIfNeeded();
  renderStatus();
}

function sourceState(source) {
  if (!source.ok) return { label: `Failed: ${source.error}`, warn: true };
  if (!source.newest) return { label: 'No posts returned', warn: true };
  const age = (now() - new Date(source.newest).getTime()) / 86_400_000;
  if (age > QUIET_AFTER_DAYS) return { label: `No posts since ${shortDate(source.newest)}`, warn: true };
  return { label: 'OK', warn: false };
}

function sourceNameCell(source, connected) {
  const name = create('span', {}, source.name);
  if (source.detail) name.append(create('span', { class: 'source-detail' }, source.detail));
  if (!connected) return create('td', {}, name);
  const hidden = sync.profile?.hiddenSources.includes(source.id) ?? false;
  const box = create('input', { type: 'checkbox', checked: !hidden });
  box.addEventListener('change', () => sync.change({ type: box.checked ? 'source.show' : 'source.hide', id: source.id }));
  return create('td', {}, create('label', { class: 'source-choice' }, box, name));
}

function renderAddedSources() {
  const added = sync.profile?.customSources ?? [];
  const reports = new Map((state.status?.customSources ?? []).map((report) => [report.id, report]));
  const section = create('div', { class: 'added-sources' }, create('h3', {}, 'Your added sources'));

  if (added.length) {
    const body = create('tbody');
    for (const source of added) {
      const report = reports.get(source.key);
      const { label, warn } = report ? sourceState(report) : { label: 'Waiting for the next refresh', warn: false };
      body.append(create('tr', {},
        create('td', {}, source.name, create('span', { class: 'source-detail' }, KIND_LABELS[source.type])),
        create('td', { class: `source-state${warn ? ' warn' : ''}` }, label),
        create('td', { class: 'source-action' }, button('Remove', () => {
          sync.change({ type: 'source.remove', key: source.key });
        }, { class: 'link-button', 'aria-label': `Remove ${source.name}` }))));
    }
    section.append(create('table', {}, body));
  }

  const select = create('select', { 'aria-label': 'Source type' }, ...ADD_SOURCE_TYPES.map(([id, label]) => create('option', { value: id, selected: id === state.addSourceType }, label)));
  const placeholder = (id) => ADD_SOURCE_TYPES.find(([type]) => type === id)[2];
  const input = create('input', { type: 'text', placeholder: placeholder(state.addSourceType), 'aria-label': 'Source to add', autocomplete: 'off', required: true });
  select.addEventListener('change', () => {
    state.addSourceType = select.value;
    input.placeholder = placeholder(select.value);
  });
  const submit = create('button', { type: 'submit', disabled: state.addingSource }, state.addingSource ? 'Adding…' : 'Add');
  const form = create('form', { class: 'add-source' }, select, input, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.addingSource = true;
    state.addSourceError = '';
    renderStatus();
    try {
      await sync.addSource(select.value, input.value);
    } catch (error) {
      state.addSourceError = error.message;
    }
    state.addingSource = false;
    renderStatus();
  });
  section.append(form);
  if (state.addSourceError) section.append(create('p', { class: 'form-error', role: 'alert' }, state.addSourceError));
  section.append(create('p', { class: 'dialog-note' }, 'Posts from a new source appear after the next hourly refresh. The names of added sources are public, but not who added them.'));
  return section;
}

function renderStatus() {
  const { status } = state;
  const connected = sync.connected;

  // Redrawing would discard whatever is being typed into the add form.
  if (el.statusPersonal.contains(document.activeElement) && document.activeElement.matches('input[type="text"]') && !state.addingSource) return;

  if (connected) {
    el.statusPersonal.replaceChildren(renderAddedSources());
  } else {
    el.statusPersonal.replaceChildren(create('p', { class: 'dialog-note' },
      'Want to hide sources or add your own? ',
      button('Get a sync code', () => {
        el.statusDialog.close();
        openSyncDialog();
      }, { class: 'link-button' })));
  }

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
  el.statusNote.textContent = `Last refresh: ${new Date(status.generatedAt).toLocaleString()}. ${status.sources.length - failed} of ${status.sources.length} default sources responded.${connected ? ' Untick a source to hide it.' : ''}`;

  const body = create('tbody');
  for (const type of Object.keys(GROUP_LABELS)) {
    const group = status.sources.filter((source) => source.type === type);
    if (!group.length) continue;
    body.append(create('tr', {}, create('td', { class: 'source-group', colSpan: 2 }, GROUP_LABELS[type])));
    for (const source of group) {
      const { label, warn } = sourceState(source);
      body.append(create('tr', {},
        sourceNameCell(source, connected),
        create('td', { class: `source-state${warn ? ' warn' : ''}` }, label)));
    }
  }
  el.statusTable.replaceChildren(create('table', {}, body));
}

// One form per way of entering a code. Whatever was typed survives an error, so it can be corrected.
function codeForm({ draft, placeholder, label, submitLabel, required = true, primary = false, action, note = '' }) {
  const input = create('input', { type: 'text', placeholder, value: state.codeDrafts[draft], 'aria-label': label, autocomplete: 'off', spellcheck: false, required });
  const submit = create('button', { type: 'submit', class: primary ? 'primary' : '' }, submitLabel);
  const form = create('form', { class: 'code-form' }, input, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.syncError = '';
    state.syncNote = '';
    state.codeDrafts[draft] = input.value;
    submit.disabled = true;
    try {
      await action(input.value.trim());
      state.codeDrafts[draft] = '';
      state.syncNote = note;
    } catch (error) {
      state.syncError = error.message;
    }
    renderSyncDialog({ force: true });
  });
  return form;
}

function renderSyncConnected() {
  const { profile, code } = sync;
  const copy = button('Copy', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select and copy it';
    }
  });
  return [
    create('p', { class: 'dialog-note' }, 'Enter this code on another device to get the same saved posts and sources.'),
    create('div', { class: 'code-box' }, create('code', {}, code), copy),
    create('p', { class: 'code-warning' }, "Keep this code somewhere safe. It can't be recovered if lost, and anyone who has it can see and change your saved posts and sources."),
    create('p', { class: 'dialog-note' },
      `${pluralize(profile?.bookmarks.length ?? 0, 'saved post')} · ${pluralize(profile?.hiddenSources.length ?? 0, 'hidden source')} · ${pluralize(profile?.customSources.length ?? 0, 'added source')}`),
    create('h3', {}, 'Change your code'),
    codeForm({
      draft: 'change',
      placeholder: 'New code, at least 4 characters',
      label: 'New sync code',
      submitLabel: 'Change code',
      action: (next) => sync.changeCode(next),
      note: 'Your code has changed. Enter the new one on your other devices.',
    }),
    create('div', { class: 'dialog-actions' },
      button('Manage sources', () => {
        el.syncDialog.close();
        el.statusDialog.showModal();
      }),
      button('Forget on this device', async () => {
        await sync.forgetDevice();
      }),
      button('Delete my data', async () => {
        if (!window.confirm('Delete your saved posts and sources permanently? This cannot be undone, on any device.')) return;
        try {
          await sync.deleteProfile();
          showNotice('Your data was deleted.');
        } catch (error) {
          state.syncError = error.message;
        }
        renderSyncDialog({ force: true });
      }, { class: 'danger' })),
  ];
}

function renderSyncDisconnected() {
  return [
    ...(state.syncIntro ? [create('p', { class: 'sync-intro' }, state.syncIntro)] : []),
    create('p', { class: 'dialog-note' }, 'The news is free to read without one. A sync code lets you save posts, hide sources and add your own, and keeps all of that the same on every device. No account or email needed.'),
    create('h3', {}, 'Create a code'),
    codeForm({
      draft: 'create',
      placeholder: 'Your own code, or leave empty',
      label: 'Choose a sync code, or leave empty for a random one',
      submitLabel: 'Create code',
      required: false,
      primary: true,
      action: (chosen) => sync.create(chosen),
    }),
    create('p', { class: 'dialog-note' }, 'Leave it empty for a random code, which is the safest choice. Your own code needs at least 4 characters. Anyone who guesses it can see and change your data, so avoid short or common ones.'),
    create('h3', {}, 'Already have a code?'),
    codeForm({
      draft: 'use',
      placeholder: 'Your sync code',
      label: 'Your sync code',
      submitLabel: 'Use code',
      action: (input) => sync.connect(input),
    }),
  ];
}

// Background updates must not discard a code being typed. A finished action always redraws, because
// the input usually still has focus after pressing Enter.
function renderSyncDialog({ force = false } = {}) {
  if (!force && el.syncBody.contains(document.activeElement) && document.activeElement.matches('input')) return;
  el.syncBody.replaceChildren(
    ...(sync.connected ? renderSyncConnected() : renderSyncDisconnected()),
    ...(state.syncError ? [create('p', { class: 'form-error', role: 'alert' }, state.syncError)] : []),
    ...(state.syncNote ? [create('p', { class: 'sync-intro', role: 'status' }, state.syncNote)] : []),
  );
}

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function showLoadError() {
  el.summary.textContent = '';
  el.feed.replaceChildren(create('p', { class: 'empty' }, 'The news could not be loaded. ', button('Try again', () => location.reload())));
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
  if (!sync.connected) state.savedOnly = false;
  syncSavedControls();
  renderSyncDialog();

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
  el.statusButton.addEventListener('click', () => {
    state.addSourceError = '';
    renderStatus();
    el.statusDialog.showModal();
  });
  el.syncButton.addEventListener('click', () => openSyncDialog());
  el.savedButton.addEventListener('click', () => {
    if (!sync.connected) {
      openSyncDialog('Saving posts needs a sync code, so they stay available on all your devices.');
      return;
    }
    state.savedOnly = !state.savedOnly;
    state.renderedSignature = viewSignature();
    syncSavedControls();
    filtersChanged();
  });
  for (const dialog of [el.statusDialog, el.syncDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  state.lastVisit = readLastVisit();

  const [feed, status] = await Promise.allSettled([loadJson('data/feed.json'), loadJson('data/status.json')]);
  state.status = status.status === 'fulfilled' ? status.value : null;
  renderStatus();
  if (feed.status === 'rejected') {
    showLoadError();
    return;
  }

  state.feedItems = feed.value;
  saveLastVisit();
  state.observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.shown < state.filtered.length) renderNextPage();
  }, { rootMargin: '1000px' });
  await loadCustomFeeds();
  rebuildItems();
  state.loaded = true;
  state.renderedSignature = viewSignature();
  syncToggles();
  applyFilters();
  sync.refresh();
}

init();
