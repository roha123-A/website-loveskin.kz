/* ==========================================================
   loveskin.kz — логика магазина
   Без фреймворков. Порядок в файле:
     1. Настройки
     2. Загрузка товаров (сюда подключать Google Sheets)
     3. Каталог: фильтры, поиск, карточки
     4. Корзина (localStorage)
     5. Оформление заказа → WhatsApp
     6. Мелочи интерфейса (меню, уведомления)
   ========================================================== */

'use strict';

/* ---------- 1. Настройки ---------- */
const CONFIG = {
  // Номер WhatsApp только цифрами, без «+» — так требует wa.me
  whatsapp: '77714003351',

  // Откуда брать товары. Пока это локальный JSON.
  // Для Google Sheets см. функцию loadProducts() ниже.
  productsUrl: 'data/products.json',

  // Порог бесплатной доставки по Алматы и стоимость доставки ниже порога
  freeDeliveryFrom: 15000,
  almatyDeliveryFrom: 1500,

  // Картинка, если у товара нет фото или файл не найден
  placeholderImage: 'images/placeholder.svg',

  // Ключ, под которым корзина лежит в localStorage
  cartKey: 'loveskin_cart_v1',

  // Максимум одной позиции в корзине
  maxQty: 20,
};

// Порядок кнопок-фильтров. «Все» — служебная, показывает всё.
const CATEGORIES = [
  'Все', 'Сыворотки', 'SPF', 'Кремы', 'Тонеры', 'Пэды', 'Маски',
  'Очищение', 'Для тела', 'Волосы', 'Макияж', 'Для мужчин', 'Наборы',
];

// Текущее состояние страницы
const state = {
  products: [],        // все видимые товары
  byId: new Map(),     // быстрый поиск товара по id
  category: 'Все',
  query: '',
  cart: {},            // { id: количество }
};

/* Короткие помощники */
const $ = (sel) => document.querySelector(sel);
const money = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₸';

// Экранируем текст из данных, чтобы символы < > & не ломали вёрстку.
// Особенно важно, когда товары придут из Google Sheets, где их правят руками.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function waLink(text) {
  return `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(text)}`;
}

/* ==========================================================
   2. Загрузка товаров
   ========================================================== */

/*
  Сейчас товары берутся из data/products.json.

  Как перейти на Google Sheets (план):
  1. Сделать таблицу с колонками ровно как поля JSON:
     id | brand | name | description | price | oldPrice | category | image | inStock | visible
  2. Файл → Поделиться → Опубликовать в интернете → лист → формат CSV.
     Получится ссылка вида
     https://docs.google.com/spreadsheets/d/e/XXXX/pub?gid=0&single=true&output=csv
  3. В CONFIG.productsUrl поставить эту ссылку, а в loadProducts()
     вместо response.json() разобрать CSV: parseCsv(await response.text()).
     Функция parseCsv ниже уже готова.
  Всё остальное (normalizeProduct, фильтры, корзина) менять не нужно:
  normalizeProduct понимает и числа, и строки из таблицы («7 500», «TRUE», «да»).
*/
async function loadProducts() {
  const response = await fetch(CONFIG.productsUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error('HTTP ' + response.status);

  // Для Google Sheets (CSV): const rows = parseCsv(await response.text());
  const rows = await response.json();

  return rows
    .map(normalizeProduct)
    .filter((p) => p && p.visible);
}

// Приводим строку из JSON/таблицы к единому виду
function normalizeProduct(raw) {
  if (!raw || !raw.id || !raw.name) return null; // пустые строки таблицы пропускаем
  return {
    id: String(raw.id).trim(),
    brand: String(raw.brand ?? '').trim(),
    name: String(raw.name).trim(),
    description: String(raw.description ?? '').trim(),
    price: toNumber(raw.price),
    oldPrice: toNumber(raw.oldPrice) || null,
    category: String(raw.category ?? '').trim(),
    image: String(raw.image ?? '').trim() || CONFIG.placeholderImage,
    inStock: toBool(raw.inStock, true),
    visible: toBool(raw.visible, true),
  };
}

// «7 500», "7500", 7500 → 7500
function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// true / "TRUE" / "да" / "1" → true; пустое значение → значение по умолчанию
function toBool(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'да', 'yes', 'есть'].includes(String(v).trim().toLowerCase());
}

// Простой разбор CSV (кавычки, запятые и переносы внутри ячеек поддерживаются).
// Первая строка — заголовки колонок. Пригодится для Google Sheets.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }

  const [head = [], ...body] = rows;
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

/* ==========================================================
   3. Каталог
   ========================================================== */

function renderFilters() {
  const box = $('#filters');
  box.innerHTML = CATEGORIES.map((cat) => `
    <button type="button" class="filter${cat === state.category ? ' is-active' : ''}"
            data-category="${esc(cat)}" aria-pressed="${cat === state.category}">${esc(cat)}</button>
  `).join('');
}

function filteredProducts() {
  const q = state.query.trim().toLowerCase();
  return state.products.filter((p) => {
    if (state.category !== 'Все' && p.category !== state.category) return false;
    if (!q) return true;
    return `${p.brand} ${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q);
  });
}

function productCard(p) {
  const out = !p.inStock;
  const sale = p.oldPrice && p.oldPrice > p.price;
  const badge = out
    ? '<span class="card__badge card__badge--out">Нет в наличии</span>'
    : sale ? `<span class="card__badge card__badge--sale">−${Math.round((1 - p.price / p.oldPrice) * 100)}%</span>` : '';

  return `
    <article class="card${out ? ' is-out' : ''}">
      <div class="card__media">
        <img class="card__img" src="${esc(p.image)}" alt="${esc(p.brand + ' ' + p.name)}"
             loading="lazy" width="600" height="600" data-fallback>
        ${badge}
      </div>
      <div class="card__body">
        <p class="card__brand">${esc(p.brand)}</p>
        <h3 class="card__name">${esc(p.name)}</h3>
        ${p.description ? `<p class="card__desc">${esc(p.description)}</p>` : ''}
        <div class="card__bottom">
          <div class="card__price">
            <strong>${money(p.price)}</strong>
            ${sale ? `<s>${money(p.oldPrice)}</s>` : ''}
          </div>
          <button type="button" class="btn ${out ? '' : 'btn--primary'} btn--block"
                  data-add="${esc(p.id)}" ${out ? 'disabled' : ''}>
            ${out ? 'Нет в наличии' : 'В корзину'}
          </button>
        </div>
      </div>
    </article>`;
}

function renderCatalog() {
  const grid = $('#productGrid');
  const list = filteredProducts();

  $('#catalogCount').textContent = state.products.length ? countLabel(list.length) : '';

  if (!list.length) {
    grid.innerHTML = `
      <div class="grid__state">
        <p>${state.query ? 'По вашему запросу ничего не нашлось.' : 'В этой категории пока нет товаров — скоро добавим.'}</p>
        <a href="#" class="btn btn--outline" data-wa-link
           data-wa-text="Здравствуйте! Ищу: ${esc(state.query || state.category)}">Спросить в WhatsApp</a>
      </div>`;
    bindWaLinks(grid);
    return;
  }
  grid.innerHTML = list.map(productCard).join('');
}

// 1 товар, 2 товара, 5 товаров
function countLabel(n) {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'товар'
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'товара' : 'товаров';
  return `${n} ${word}`;
}

// Если фото товара не загрузилось — ставим заглушку.
// Событие error не всплывает, поэтому ловим его на фазе перехвата.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.hasAttribute('data-fallback') && !img.dataset.failed) {
    img.dataset.failed = '1';
    img.src = CONFIG.placeholderImage;
  }
}, true);

/* ==========================================================
   4. Корзина
   ========================================================== */

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.cartKey) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {}; // приватный режим или битые данные — начинаем с пустой корзины
  }
}

function saveCart() {
  try { localStorage.setItem(CONFIG.cartKey, JSON.stringify(state.cart)); } catch { /* ничего */ }
}

// Строки корзины с актуальными ценами из каталога.
// Если товар исчез из каталога или закончился — он не попадёт в заказ.
function cartLines() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ product: state.byId.get(id), qty }))
    .filter((l) => l.product && l.product.inStock && l.qty > 0);
}

const cartTotal = () => cartLines().reduce((s, l) => s + l.product.price * l.qty, 0);
const cartCount = () => cartLines().reduce((s, l) => s + l.qty, 0);

function addToCart(id) {
  const p = state.byId.get(id);
  if (!p || !p.inStock) return;
  state.cart[id] = Math.min((state.cart[id] || 0) + 1, CONFIG.maxQty);
  saveCart();
  renderCart();
  showToast(`«${p.name}» в корзине`);
  const btn = $('#cartBtn');
  btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
}

function setQty(id, qty) {
  if (qty <= 0) delete state.cart[id];
  else state.cart[id] = Math.min(qty, CONFIG.maxQty);
  saveCart();
  renderCart();
}

// Убираем из сохранённой корзины то, чего больше нет в каталоге
function cleanCart() {
  for (const id of Object.keys(state.cart)) {
    const p = state.byId.get(id);
    const qty = Number(state.cart[id]);
    if (!p || !p.inStock || !Number.isFinite(qty) || qty <= 0) delete state.cart[id];
  }
  saveCart();
}

function renderCart() {
  const lines = cartLines();
  const total = cartTotal();
  const count = cartCount();

  // Счётчик на кнопке в шапке
  const badge = $('#cartCount');
  badge.textContent = count;
  badge.hidden = count === 0;
  $('#cartBtn').setAttribute('aria-label', count ? `Открыть корзину, товаров: ${count}` : 'Открыть корзину');

  const box = $('#cartItems');
  $('#cartFoot').hidden = lines.length === 0;

  if (!lines.length) {
    box.innerHTML = `
      <div class="cart-empty">
        <p>Корзина пока пустая</p>
        <button type="button" class="btn btn--primary" data-close-cart>Перейти в каталог</button>
      </div>`;
  } else {
    box.innerHTML = lines.map(({ product: p, qty }) => `
      <div class="line">
        <img class="line__img" src="${esc(p.image)}" alt="" width="64" height="64" data-fallback>
        <div>
          <p class="line__brand">${esc(p.brand)}</p>
          <p class="line__name">${esc(p.name)}</p>
          <div class="line__row">
            <div class="qty">
              <button type="button" class="qty__btn" data-qty="${esc(p.id)}" data-delta="-1" aria-label="Уменьшить количество">−</button>
              <span class="qty__value" aria-live="polite">${qty}</span>
              <button type="button" class="qty__btn" data-qty="${esc(p.id)}" data-delta="1" aria-label="Увеличить количество" ${qty >= CONFIG.maxQty ? 'disabled' : ''}>+</button>
            </div>
            <span class="line__sum">${money(p.price * qty)}</span>
          </div>
          <button type="button" class="line__remove" data-remove="${esc(p.id)}">Убрать</button>
        </div>
      </div>`).join('');
  }

  // Подсказка про бесплатную доставку
  const hint = $('#freeHint');
  const left = CONFIG.freeDeliveryFrom - total;
  const pct = Math.min(100, (total / CONFIG.freeDeliveryFrom) * 100);
  if (left > 0) {
    hint.className = 'free-hint';
    hint.innerHTML = `До бесплатной доставки по Алматы осталось <strong>${money(left)}</strong>
      <span class="free-bar"><span style="width:${pct}%"></span></span>`;
  } else {
    hint.className = 'free-hint is-done';
    hint.innerHTML = `Доставка по Алматы — бесплатно
      <span class="free-bar"><span style="width:100%"></span></span>`;
  }

  $('#cartTotal').textContent = money(total);
  $('#checkoutTotal').textContent = money(total);

  // Если корзину опустошили на шаге оформления — возвращаемся к списку
  if (!lines.length && !$('#checkoutView').hidden) showView('cart');
}

/* ---------- Открытие / закрытие панели ---------- */
let lastFocus = null;

function openCart(view = 'cart') {
  lastFocus = document.activeElement;
  const drawer = $('#drawer');
  const overlay = $('#overlay');
  showView(view);
  overlay.hidden = false;
  drawer.inert = false;
  drawer.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    overlay.classList.add('is-open');
    drawer.classList.add('is-open');
  });
  document.body.classList.add('no-scroll');
  setTimeout(() => $('#drawerClose').focus(), 50);
}

function closeCart() {
  const drawer = $('#drawer');
  const overlay = $('#overlay');
  drawer.classList.remove('is-open');
  overlay.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.inert = true;
  document.body.classList.remove('no-scroll');
  setTimeout(() => { overlay.hidden = true; }, 250);
  if (lastFocus) lastFocus.focus();
}

// Переключение шагов внутри панели: cart → checkout → done
function showView(view) {
  $('#cartView').hidden = view !== 'cart';
  $('#checkoutView').hidden = view !== 'checkout';
  $('#doneView').hidden = view !== 'done';
  $('#drawerBack').hidden = view !== 'checkout';
  $('#drawerTitle').textContent = { cart: 'Корзина', checkout: 'Оформление', done: 'Спасибо!' }[view];
  if (view === 'checkout') updateDeliveryNote();
}

/* ==========================================================
   5. Оформление заказа → WhatsApp
   ========================================================== */

const isAlmaty = (city) => /алмат|almat/i.test(city);

// Подсказка о доставке под формой — зависит от города и суммы
function updateDeliveryNote() {
  const city = $('#checkoutForm').elements.city.value;
  $('#deliveryNote').textContent = deliveryText(city, cartTotal());
}

function deliveryText(city, total) {
  if (!city.trim()) return 'Стоимость доставки менеджер уточнит в WhatsApp.';
  if (isAlmaty(city)) {
    return total >= CONFIG.freeDeliveryFrom
      ? 'Доставка по Алматы бесплатно (в зоне Аль-Фараби – Саина – Рыскулова – ВОАД).'
      : `Доставка по Алматы — от ${money(CONFIG.almatyDeliveryFrom)}.`;
  }
  return 'Доставка по Казахстану: курьер экспресс или эконом — от 3 200 ₸, Казпочта — 1 800 ₸. Менеджер уточнит.';
}

// Казахстанский номер: 11 цифр, начинается с 7 или 8 (8 заменим на 7)
function normalizePhone(value) {
  let d = value.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return /^7\d{10}$/.test(d) ? d : null;
}

function formatPhone(d) {
  return `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9)}`;
}

// Собираем текст заказа для WhatsApp
function buildOrderText(data) {
  const lines = cartLines();
  const total = cartTotal();
  const items = lines.map((l, i) =>
    `${i + 1}. ${l.product.brand} — ${l.product.name}\n   ${l.qty} шт × ${money(l.product.price)} = ${money(l.product.price * l.qty)}`
  ).join('\n');

  return [
    'Здравствуйте! Хочу оформить заказ на loveskin.kz',
    '',
    items,
    '',
    `Сумма товаров: ${money(total)}`,
    deliveryText(data.city, total),
    '',
    `Имя: ${data.name}`,
    `Телефон: ${data.phone}`,
    `Город: ${data.city}`,
    `Адрес: ${data.address}`,
    data.comment ? `Комментарий: ${data.comment}` : '',
  ].filter((s, i, arr) => !(s === '' && arr[i - 1] === '')).join('\n').trim();
}

function submitOrder(e) {
  e.preventDefault();
  const form = e.target;
  const f = form.elements;
  const error = $('#formError');

  // Простая проверка обязательных полей
  form.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
  const missing = ['name', 'phone', 'city', 'address'].filter((k) => !f[k].value.trim());
  const phone = normalizePhone(f.phone.value);
  if (!phone && f.phone.value.trim()) missing.push('phone');

  if (missing.length) {
    missing.forEach((k) => f[k].classList.add('is-invalid'));
    error.textContent = !phone && f.phone.value.trim() && missing.length === 1
      ? 'Проверьте номер телефона: например, +7 701 123 45 67'
      : 'Заполните, пожалуйста, отмеченные поля';
    f[missing[0]].focus();
    return;
  }
  if (!cartLines().length) { showView('cart'); return; }
  error.textContent = '';

  const data = {
    name: f.name.value.trim(),
    phone: formatPhone(phone),
    city: f.city.value.trim(),
    address: f.address.value.trim(),
    comment: f.comment.value.trim(),
  };

  const url = waLink(buildOrderText(data));
  $('#waAgain').href = url;

  // Открываем WhatsApp. Если браузер заблокировал новое окно
  // (бывает во встроенном браузере Instagram) — переходим в этой же вкладке.
  const win = window.open(url, '_blank', 'noopener');
  if (!win) window.location.href = url;

  // Заказ ушёл в текст сообщения — очищаем корзину и форму
  state.cart = {};
  saveCart();
  renderCart();
  form.reset();
  showView('done');
}

/* ==========================================================
   6. Мелочи интерфейса
   ========================================================== */

let toastTimer;
function showToast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-show'), 2000);
}

// Все ссылки с data-wa-link ведут в WhatsApp с готовым текстом
function bindWaLinks(root = document) {
  root.querySelectorAll('[data-wa-link]').forEach((a) => {
    a.href = waLink(a.dataset.waText || 'Здравствуйте!');
    a.target = '_blank';
    a.rel = 'noopener';
  });
}

function toggleMenu(open) {
  const nav = $('#nav');
  const btn = $('#menuBtn');
  const isOpen = open ?? !nav.classList.contains('is-open');
  nav.classList.toggle('is-open', isOpen);
  btn.setAttribute('aria-expanded', String(isOpen));
  btn.setAttribute('aria-label', isOpen ? 'Закрыть меню' : 'Открыть меню');
}

function bindEvents() {
  // Фильтры
  $('#filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-category]');
    if (!btn) return;
    state.category = btn.dataset.category;
    renderFilters();
    renderCatalog();
  });

  // «В корзину»
  $('#productGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add]');
    if (btn) addToCart(btn.dataset.add);
  });

  // Поиск: фильтруем по мере ввода, по Enter — прокручиваем к каталогу
  const input = $('#searchInput');
  let searchTimer;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = input.value;
      if (state.query) state.category = 'Все';
      renderFilters();
      renderCatalog();
    }, 150);
  });
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.query = input.value;
    renderCatalog();
    input.blur();
    $('#catalog').scrollIntoView({ behavior: 'smooth' });
  });

  // Корзина
  $('#cartBtn').addEventListener('click', () => openCart());
  $('#drawerClose').addEventListener('click', closeCart);
  $('#overlay').addEventListener('click', closeCart);
  $('#drawerBack').addEventListener('click', () => showView('cart'));
  $('#checkoutBtn').addEventListener('click', () => {
    showView('checkout');
    $('#checkoutForm').elements.name.focus();
  });
  $('#doneClose').addEventListener('click', () => {
    closeCart();
    $('#catalog').scrollIntoView({ behavior: 'smooth' });
  });

  $('#cartItems').addEventListener('click', (e) => {
    const qtyBtn = e.target.closest('[data-qty]');
    if (qtyBtn) {
      const id = qtyBtn.dataset.qty;
      setQty(id, (state.cart[id] || 0) + Number(qtyBtn.dataset.delta));
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) { setQty(rm.dataset.remove, 0); return; }
    if (e.target.closest('[data-close-cart]')) {
      closeCart();
      $('#catalog').scrollIntoView({ behavior: 'smooth' });
    }
  });

  // Форма заказа
  const form = $('#checkoutForm');
  form.addEventListener('submit', submitOrder);
  form.elements.city.addEventListener('input', updateDeliveryNote);
  form.addEventListener('input', (e) => e.target.classList.remove('is-invalid'));

  // Esc закрывает корзину и меню
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#drawer').classList.contains('is-open')) closeCart();
    toggleMenu(false);
  });

  // Мобильное меню
  $('#menuBtn').addEventListener('click', () => toggleMenu());
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) toggleMenu(false); });

  // Корзина изменилась в другой вкладке — обновляем
  window.addEventListener('storage', (e) => {
    if (e.key === CONFIG.cartKey) { state.cart = loadCart(); renderCart(); }
  });
}

/* ---------- Запуск ---------- */
async function init() {
  $('#year').textContent = new Date().getFullYear();
  bindWaLinks();
  state.cart = loadCart();
  renderFilters();
  bindEvents();
  renderCart();

  try {
    state.products = await loadProducts();
    state.byId = new Map(state.products.map((p) => [p.id, p]));
    cleanCart();
    renderCatalog();
    renderCart();

    // Если открыли ссылку вида site/#catalog — после загрузки товаров
    // высота страницы изменилась, поэтому прокручиваем к якорю ещё раз
    if (location.hash.length > 1) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  } catch (err) {
    console.error('Не удалось загрузить товары:', err);
    $('#productGrid').innerHTML = `
      <div class="grid__state">
        <p>Не получилось загрузить каталог. Обновите страницу или напишите нам — подскажем по наличию.</p>
        <a href="#" class="btn btn--outline" data-wa-link data-wa-text="Здравствуйте! Хочу узнать о наличии товаров.">Написать в WhatsApp</a>
      </div>`;
    bindWaLinks($('#productGrid'));
  }
}

init();
