export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safe = n => Number.isSafeInteger(n);
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateTransaction(t) {
  if (!t || !['deposit', 'withdraw'].includes(t.type) || !safe(t.amount) || t.amount <= 0 ||
      !validDate(t.date) || !safe(t.timestamp) || t.timestamp < 0) throw Error('帳本含有無效的收支紀錄，未變更原始資料。');
  return t;
}
export function validateSeed(seed) {
  if (!seed || seed.schema !== 'piggy-ledger-v2' || !UUID.test(seed.id) || !safe(seed.balance) ||
      !safe(seed.createdAt) || !Array.isArray(seed.transactions)) throw Error('無法辨識帳本格式，未變更原始資料。');
  const ids = new Set();
  for (const t of seed.transactions) {
    validateTransaction(t);
    if (typeof t.id !== 'string' || !/^(legacy-\d+|[0-9a-f-]{36})$/.test(t.id) || ids.has(t.id)) throw Error('帳本紀錄識別碼重複或無效。');
    ids.add(t.id);
  }
  return seed;
}
export function validateEvent(event, ledgerId) {
  if (!event || event.schema !== 'piggy-event-v2' || event.ledgerId !== ledgerId || !UUID.test(event.id) ||
      !safe(event.timestamp) || event.timestamp < 0) throw Error('同步紀錄格式有誤。');
  if (event.kind === 'transaction') validateTransaction(event);
  else if (event.kind === 'clear') {
    if (!Array.isArray(event.hiddenIds) || event.hiddenIds.some(id => typeof id !== 'string' || !/^(legacy-\d+|[0-9a-f-]{36})$/.test(id))) throw Error('清除紀錄格式有誤。');
  } else throw Error('未知的同步紀錄類型。');
  return event;
}
export function snapshot(seed, events) {
  validateSeed(seed);
  let balance = seed.balance;
  const tx = new Map(seed.transactions.map(t => [t.id, t]));
  const seen = new Map(), hidden = new Set();
  for (const e of events) {
    validateEvent(e, seed.id);
    if (seen.has(e.id)) {
      if (JSON.stringify(seen.get(e.id)) !== JSON.stringify(e)) throw Error('相同紀錄出現不同內容，已停止同步。');
      continue;
    }
    seen.set(e.id, e);
    if (e.kind === 'clear') e.hiddenIds.forEach(id => hidden.add(id));
    else {
      if (tx.has(e.id)) throw Error('收支識別碼重複。');
      balance += e.type === 'deposit' ? e.amount : -e.amount;
      if (!safe(balance)) throw Error('金額超過可安全計算的範圍。');
      tx.set(e.id, e);
    }
  }
  return {balance, transactions: [...tx.values()].filter(t => !hidden.has(t.id))
    .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))};
}

const PREFIX = 'piggy_v2:';
export class LedgerStore {
  constructor(storage, uuid = () => crypto.randomUUID(), now = () => Date.now()) {
    this.storage = storage; this.uuid = uuid; this.now = now;
  }
  keys() { return Array.from({length: this.storage.length}, (_, i) => this.storage.key(i)); }
  read(key) { const raw = this.storage.getItem(PREFIX + key); return raw === null ? null : JSON.parse(raw); }
  write(key, value) { this.storage.setItem(PREFIX + key, JSON.stringify(value)); }
  activeId() { return this.read('active'); }
  activate(id) { this.get(id); this.write('active', id); }
  init() {
    if (this.activeId()) return this.get();
    const balanceRaw = this.storage.getItem('piggy_balance_highlight');
    const txRaw = this.storage.getItem('piggy_transactions_highlight');
    const balance = balanceRaw === null ? 0 : Number(balanceRaw);
    const transactions = txRaw === null ? [] : JSON.parse(txRaw);
    if (!safe(balance) || !Array.isArray(transactions)) throw Error('舊版資料無法讀取，請先保留原瀏覽器資料。');
    if (!this.read('legacy-backup')) this.write('legacy-backup', {balanceRaw, txRaw, time: this.now()});
    return this.create({balance, transactions});
  }
  create(data) {
    if (!data || !safe(data.balance) || !Array.isArray(data.transactions)) throw Error('備份檔格式不正確。');
    const seed = validateSeed({schema: 'piggy-ledger-v2', id: this.uuid(), createdAt: this.now(), balance: data.balance,
      transactions: data.transactions.map((t, index) => ({...validateTransaction(t), id: `legacy-${index}`}))});
    this.write(`seed:${seed.id}`, seed);
    this.write(`meta:${seed.id}`, {name: '本機帳本', remote: null, acknowledged: []});
    this.write('active', seed.id);
    return this.get();
  }
  list() { return this.keys().filter(k => k.startsWith(PREFIX + 'seed:')).map(k => this.get(k.slice((PREFIX + 'seed:').length))); }
  get(id = this.activeId()) {
    if (!UUID.test(id || '')) throw Error('尚未建立帳本。');
    const seed = validateSeed(this.read(`seed:${id}`));
    const events = this.keys().filter(k => k.startsWith(`${PREFIX}event:${id}:`))
      .map(k => validateEvent(JSON.parse(this.storage.getItem(k)), id));
    const meta = this.read(`meta:${id}`) || {name: '本機帳本', remote: null, acknowledged: []};
    return {seed, events, meta, ...snapshot(seed, events)};
  }
  updateMeta(id, fields) {
    const meta = this.get(id).meta;
    this.write(`meta:${id}`, {...meta, ...fields});
  }
  merge(seed, events) {
    validateSeed(seed);
    const existing = this.read(`seed:${seed.id}`);
    if (existing && JSON.stringify(existing) !== JSON.stringify(seed)) throw Error('雲端帳本的起始資料已改變，已停止同步。');
    const currentEvents = existing ? this.get(seed.id).events : [];
    snapshot(seed, [...currentEvents, ...events]); // Validate the entire batch before any write.
    if (!existing) this.write(`seed:${seed.id}`, seed);
    for (const e of events) this.write(`event:${seed.id}:${e.id}`, e);
  }
  add(type, amount, date) {
    const book = this.get();
    if (!['deposit','withdraw'].includes(type) || !safe(amount) || amount <= 0 || !validDate(date)) throw Error('請輸入正整數金額及有效日期。');
    if (type === 'withdraw' && amount > book.balance) throw Error(`餘額不足！目前結餘 $${book.balance.toLocaleString()}`);
    const event = {schema:'piggy-event-v2', ledgerId:book.seed.id, id:this.uuid(), kind:'transaction', type, amount, date, timestamp:this.now()};
    snapshot(book.seed, [...book.events, event]);
    this.write(`event:${book.seed.id}:${event.id}`, event);
  }
  clear() {
    const book = this.get();
    if (!book.transactions.length) return;
    const event = {schema:'piggy-event-v2', ledgerId:book.seed.id, id:this.uuid(), kind:'clear',
      timestamp:this.now(), hiddenIds:book.transactions.map(t => t.id)};
    this.write(`event:${book.seed.id}:${event.id}`, event);
  }
  export(id = this.activeId()) {
    const book = this.get(id);
    return {schema:'piggy-backup-v2', exportedAt:this.now(), balance:book.balance, transactions:book.transactions,
      ledger: {seed:book.seed, events:book.events}};
  }
}
