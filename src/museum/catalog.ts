import { museum, type Theme } from '../museumData';
import { museumRoutes } from './routes';
import './catalog.css';

export function installMuseumCatalog(actions: { open: () => boolean | void; close: () => void; visit: (theme: Theme) => void }) {
  const trigger = document.createElement('button');
  trigger.id = 'museum-browse';
  trigger.textContent = 'Browse collections · B';
  document.getElementById('hud')!.append(trigger);
  const dialog = document.createElement('dialog');
  dialog.id = 'museum-catalog';
  dialog.setAttribute('aria-label', 'Museum collections');
  dialog.innerHTML = '<header><div><h2>Explore the museum</h2><p class="catalog-total"></p></div><button class="catalog-close" aria-label="Close collection browser">×</button></header><div class="catalog-controls"><button class="catalog-back">All collections</button><input type="search" aria-label="Search museum" placeholder="Search collections or room themes"><button class="catalog-surprise">Surprise me</button></div><p class="catalog-summary" aria-live="polite"></p><div class="catalog-grid"></div><button class="catalog-more">Show more themes</button>';
  document.body.append(dialog);
  const input = dialog.querySelector('input')!;
  const grid = dialog.querySelector<HTMLElement>('.catalog-grid')!;
  const summary = dialog.querySelector<HTMLElement>('.catalog-summary')!;
  const more = dialog.querySelector<HTMLButtonElement>('.catalog-more')!;
  const back = dialog.querySelector<HTMLButtonElement>('.catalog-back')!;
  let collection: string | null = null, limit = 48;
  function visit(theme: Theme) { dialog.close(); actions.visit(theme); }
  function card(title: string, detail: string, click: () => void) {
    const button = document.createElement('button'), name = document.createElement('b'), sub = document.createElement('span');
    name.textContent = title;
    sub.textContent = detail;
    button.append(name, sub);
    button.onclick = click;
    grid.append(button);
  }
  function render() {
    const data = museum(), query = input.value.trim().toLocaleLowerCase();
    grid.replaceChildren();
    back.hidden = collection === null;
    dialog.querySelector('.catalog-total')!.textContent = `${data.total.toLocaleString()} objects · ${new Set(data.themes.map((t) => t.collection)).size} collections · ${data.themes.length.toLocaleString()} room themes`;
    if (!collection && !query) {
      const collections = [...new Set(data.themes.map((t) => t.collection))].sort();
      summary.textContent = 'Choose a collection, or search for a room theme. Every theme is available here.';
      for (const name of collections) {
        const themes = data.themes.filter((t) => t.collection === name);
        card(name, `${themes.reduce((sum, t) => sum + t.size, 0).toLocaleString()} objects · ${themes.length} themes`, () => { collection = name; limit = 48; render(); });
      }
      more.hidden = true;
      return;
    }
    const themes = data.themes.filter((t) => (!collection || t.collection === collection) && (!query || `${t.name} ${t.collection} ${t.words.join(' ')}`.toLocaleLowerCase().includes(query)));
    summary.textContent = `${collection ?? 'All collections'} · ${themes.length.toLocaleString()} matching themes`;
    for (const theme of themes.slice(0, limit)) card(theme.name, `${theme.collection} · ${theme.size.toLocaleString()} objects`, () => visit(theme));
    if (!themes.length) summary.textContent += ' — try a different search.';
    more.hidden = themes.length <= limit;
  }
  const show = () => {
    if (dialog.open) return;
    if (actions.open() === false) return;
    render();
    dialog.showModal();
    input.focus();
  };
  trigger.onclick = show;
  input.oninput = () => { limit = 48; render(); };
  back.onclick = () => { collection = null; input.value = ''; limit = 48; render(); };
  more.onclick = () => { limit += 48; render(); };
  dialog.querySelector<HTMLButtonElement>('.catalog-close')!.onclick = () => dialog.close();
  dialog.addEventListener('close', actions.close);
  dialog.querySelector<HTMLButtonElement>('.catalog-surprise')!.onclick = () => {
    const themes = museum().themes;
    const fresh = themes.filter((t) => museumRoutes.available({ kind: 'gallery', theme: t.id, page: 0 }));
    const pool = fresh.length ? fresh : themes;
    const collections = [...new Set(pool.map((t) => t.collection))];
    const chosen = collections[Math.floor(Math.random() * collections.length)];
    const matches = pool.filter((t) => t.collection === chosen);
    visit(matches[Math.floor(Math.random() * matches.length)]);
  };
  return { show, close: () => dialog.close(), get opened() { return dialog.open; } };
}
