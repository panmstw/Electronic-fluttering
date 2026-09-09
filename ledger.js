export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safe = n => Number.isSafeInteger(n);
const signature = t => JSON.stringify([t.type,t.amount,t.date,t.timestamp]);
export function readBackup(data) {
  if (!data || !safe(data.balance) || !Array.isArray(data.transactions)) throw Error('備份檔格式不正確。');
  return {balance:data.balance,transactions:data.transactions.map(t=>{
    validateTransaction(t);return {type:t.type,amount:t.amount,date:t.date,timestamp:t.timestamp};
  })};
}
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
  } else if (['restore','import'].includes(event.kind)) {
    validateSeed({schema:'piggy-ledger-v2',id:ledgerId,createdAt:event.timestamp,balance:event.balance,transactions:event.transactions});
    if(event.kind==='restore' && (!safe(event.revision) || event.revision<1 || !Array.isArray(event.observed) || event.observed.some(id=>!UUID.test(id)))) throw Error('還原紀錄格式有誤。');
  } else if (['edit','delete'].includes(event.kind)) {
    if (typeof event.targetId !== 'string' || !/^(legacy-\d+|[0-9a-f-]{36})$/.test(event.targetId) || !safe(event.revision) || event.revision < 1) throw Error('修改紀錄格式有誤。');
    if (event.kind === 'edit') validateTransaction(event);
  } else throw Error('未知的同步紀錄類型，請更新電子撲滿後再同步。');
  return event;
}
export function snapshot(seed, events) {
  validateSeed(seed);
  const seen = new Map(), hidden = new Set();
  for (const e of events) {
    validateEvent(e, seed.id);
    if (seen.has(e.id)) {
      if (JSON.stringify(seen.get(e.id)) !== JSON.stringify(e)) throw Error('相同紀錄出現不同內容，已停止同步。');
      continue;
    }
    seen.set(e.id, e);
  }
  const all=[...seen.values()];
  const restores=all.filter(e=>e.kind==='restore').sort((a,b)=>b.revision-a.revision || (a.id>b.id?-1:1));
  const reset=restores[0], observed=new Set(reset?.observed || []);
  if(reset && [...observed].some(id=>!seen.has(id))) throw Error('還原所需紀錄尚未完整下載，請稍後再同步。');
  let balance=BigInt(reset?reset.balance:seed.balance);
  const tx=new Map((reset?reset.transactions:seed.transactions).map(t=>[t.id,t]));
  const retired=new Set(seed.transactions.map(t=>t.id));
  for(const e of all) {
    if(e.kind==='transaction')retired.add(e.id);
    if(e.transactions)for(const t of e.transactions)retired.add(t.id);
  }
  const active=all.filter(e=>!observed.has(e.id)&&e.kind!=='restore');
  for(const e of active) {
    if (e.kind === 'clear') e.hiddenIds.forEach(id => hidden.add(id));
    else if (e.kind === 'transaction') {
      if (tx.has(e.id)) throw Error('收支識別碼重複。');
      balance += BigInt(e.type === 'deposit' ? e.amount : -e.amount);
      tx.set(e.id, e);
    }
  }
  // Imported rows have deterministic IDs. Retries and simultaneous imports of
  // the same row are counted once, independently of event download order.
  const imported=new Map();
  for(const e of active.filter(e=>e.kind==='import'))for(const t of e.transactions) {
    if(imported.has(t.id) && signature(imported.get(t.id))!==signature(t))throw Error('匯入紀錄識別碼衝突。');
    imported.set(t.id,t);
  }
  for(const [id,t] of imported) {
    if(tx.has(id)) {if(signature(tx.get(id))!==signature(t))throw Error('匯入紀錄識別碼衝突。');continue;}
    tx.set(id,t);balance+=BigInt(t.type==='deposit'?t.amount:-t.amount);
  }
  const edits = new Map(), deleted = new Set();
  for (const e of active) {
    if (!['edit','delete'].includes(e.kind)) continue;
    if (!tx.has(e.targetId)) {
      if(reset && retired.has(e.targetId))continue;
      throw Error('修改所需的原始紀錄尚未完整下載，請稍後再同步。');
    }
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
  backups() {return this.keys().filter(k=>k.startsWith(PREFIX+'backup:')).map(k=>this.read(k.slice(PREFIX.length))).sort((a,b)=>b.savedAt-a.savedAt);}
  saveBackup(data=this.export(),name='手動備份') {
    readBackup(data);
    const backup={id:this.uuid(),name:String(name).slice(0,120),savedAt:this.now(),data};
    this.write(`backup:${backup.id}`,backup);return backup.id;
  }
  deleteBackup(id) {
    if(!UUID.test(id))throw Error('無效的備份。');
    this.storage.removeItem(PREFIX+`backup:${id}`);
  }
  previewImport(data,mode) {
    const backup=readBackup(data),book=this.get();
    if(mode==='replace')return {...backup,added:backup.transactions.length};
    if(mode!=='merge')throw Error('無效的匯入方式。');
    const counts=new Map();
    const known=new Map(book.transactions.map(t=>[t.id,t]));
    const reset=book.events.filter(e=>e.kind==='restore').sort((a,b)=>b.revision-a.revision||(a.id>b.id?-1:1))[0];
    const observed=new Set(reset?.observed||[]);
    for(const e of book.events)if(e.kind==='import'&&!observed.has(e.id))for(const t of e.transactions)known.set(t.id,t);
    for(const t of known.values())counts.set(signature(t),(counts.get(signature(t))||0)+1);
    const rows=backup.transactions.filter(t=>{const key=signature(t),count=counts.get(key)||0;if(count){counts.set(key,count-1);return false;}return true;});
    let balance=BigInt(book.balance);
    for(const t of rows)balance+=BigInt(t.type==='deposit'?t.amount:-t.amount);
    if(balance>BigInt(Number.MAX_SAFE_INTEGER)||balance<BigInt(Number.MIN_SAFE_INTEGER))throw Error('金額超過可安全計算的範圍。');
    return {balance:Number(balance),transactions:rows,added:rows.length};
  }
  async importInto(data,mode,expectedId=this.activeId()) {
    const backup=readBackup(data);
    const state=JSON.stringify(this.get());
    const book=this.get(),preview=this.previewImport(backup,mode);
    if(book.seed.id!==expectedId)throw Error('目前帳本已切換，請重新匯入。');
    if(mode==='merge'&&!preview.added)return {added:0};
    const event={schema:'piggy-event-v2',ledgerId:book.seed.id,id:this.uuid(),timestamp:this.now(),kind:mode==='replace'?'restore':'import',balance:mode==='replace'?backup.balance:0,transactions:[]};
    const occurrences=new Map();
    const totals=new Map(),remaining=new Map();
    for(const t of backup.transactions)totals.set(signature(t),(totals.get(signature(t))||0)+1);
    for(const t of preview.transactions)remaining.set(signature(t),(remaining.get(signature(t))||0)+1);
    for(const t of preview.transactions) {
      let id=this.uuid();
      if(mode==='merge') {
        const key=signature(t),index=occurrences.get(key)??(totals.get(key)-remaining.get(key));occurrences.set(key,index+1);
        const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(book.seed.id+'|'+key+'|'+index));
        const h=[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('').slice(0,32);
        id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      }
      event.transactions.push({...t,id});
    }
    if(mode==='replace') {
      event.observed=book.events.map(e=>e.id);
      event.revision=book.events.filter(e=>e.kind==='restore').reduce((n,e)=>Math.max(n,e.revision),0)+1;
    }
    if(this.activeId()!==expectedId||JSON.stringify(this.get())!==state)throw Error('帳本在匯入期間已變更，請重新確認。');
    snapshot(book.seed,[...book.events,event]);
    this.saveBackup(this.export(),'匯入前自動備份');
    this.write(`event:${book.seed.id}:${event.id}`,event);
    return {added:preview.added};
  }
  deleteBook(id) {
    this.get(id);
    if(this.activeId()===id) {
      const other=this.list().find(b=>b.seed.id!==id);
      if(other)this.activate(other.seed.id);else this.create({balance:0,transactions:[]});
    }
    // Removing the seed first keeps partially removed books out of the list.
    for(const key of [`${PREFIX}seed:${id}`,`${PREFIX}meta:${id}`,...this.keys().filter(k=>k.startsWith(`${PREFIX}event:${id}:`))])this.storage.removeItem(key);
  }
}
