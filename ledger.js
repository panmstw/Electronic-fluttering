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
  } else if (['edit','delete'].includes(event.kind)) {
    if (typeof event.targetId !== 'string' || !/^(legacy-\d+|[0-9a-f-]{36})$/.test(event.targetId) || !safe(event.revision) || event.revision < 1) throw Error('修改紀錄格式有誤。');
    if (event.kind === 'edit') validateTransaction(event);
  } else throw Error('未知的同步紀錄類型，請更新電子撲滿後再同步。');
  return event;
}
export function snapshot(seed, events) {
  validateSeed(seed);
  let balance = BigInt(seed.balance);
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
    else if (e.kind === 'transaction') {
      if (tx.has(e.id)) throw Error('收支識別碼重複。');
      balance += BigInt(e.type === 'deposit' ? e.amount : -e.amount);
      tx.set(e.id, e);
    }
  }
  const edits = new Map(), deleted = new Set();
  for (const e of seen.values()) {
    if (!['edit','delete'].includes(e.kind)) continue;
    if (!tx.has(e.targetId)) throw Error('修改所需的原始紀錄尚未完整下載，請稍後再同步。');
    if (e.kind === 'delete') deleted.add(e.targetId);
    else {
      const previous = edits.get(e.targetId);
      if (!previous || e.revision > previous.revision || (e.revision === previous.revision && e.id > previous.id)) edits.set(e.targetId, e);
    }
  }
  const signed = t => BigInt(t.type === 'deposit' ? t.amount : -t.amount);
  for (const [id, original] of tx) {
    if (deleted.has(id)) { balance -= signed(original); tx.delete(id); }
    else if (edits.has(id)) {
      const e = edits.get(id);
      balance += signed(e) - signed(original);
      tx.set(id, {...original, type:e.type, amount:e.amount, date:e.date});
    }
  }
  if (balance > BigInt(Number.MAX_SAFE_INTEGER) || balance < BigInt(Number.MIN_SAFE_INTEGER)) throw Error('金額超過可安全計算的範圍。');
  return {balance:Number(balance), transactions: [...tx.values()].filter(t => !hidden.has(t.id))
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
  change(targetId, kind, fields = {}, expected = null) {
    const book = this.get(), current = book.transactions.find(t => t.id === targetId);
    if (!current) throw Error('這筆紀錄已刪除或清除，請查看最新帳本。');
    if (expected && (expected.ledgerId !== book.seed.id || ['type','amount','date'].some(k => expected[k] !== current[k]))) throw Error('帳本或這筆紀錄已變更，請重新開啟修改。');
    if (!['edit','delete'].includes(kind)) throw Error('無效的操作。');
    const revision = 1 + Math.max(0,...book.events.filter(e => e.targetId === targetId).map(e => e.revision));
    const event = {schema:'piggy-event-v2', ledgerId:book.seed.id, id:this.uuid(), kind, targetId, revision, timestamp:this.now()};
    if (kind === 'edit') Object.assign(event, {type:fields.type, amount:fields.amount, date:fields.date});
    snapshot(book.seed,[...book.events,event]);
    this.write(`event:${book.seed.id}:${event.id}`,event);
  }
  edit(id, fields, expected) { this.change(id,'edit',fields,expected); }
  remove(id, expected) { this.change(id,'delete',{},expected); }
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
