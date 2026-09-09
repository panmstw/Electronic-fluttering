import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LedgerStore, snapshot} from '../ledger.js';
import {CloudSync, GraphDrive} from '../onedrive.js';

class MemoryStorage {
  data = new Map(); fail = false;
  get length() {return this.data.size;}
  key(i) {return [...this.data.keys()][i];}
  getItem(k) {return this.data.get(k) ?? null;}
  setItem(k,v) {if(this.fail) throw Error('Quota exceeded');this.data.set(k,String(v));}
}
function local(balance=0, transactions=[]) {
  const storage=new MemoryStorage();
  storage.setItem('piggy_balance_highlight',String(balance));
  storage.setItem('piggy_transactions_highlight',JSON.stringify(transactions));
  const store=new LedgerStore(storage);store.init();return store;
}
const date='2026-09-08';
const tx=(type,amount)=>({type,amount,date,timestamp:1788800000000});
const clone=x=>structuredClone(x);
class FakeDrive {
  files=new Map(); rootId='root-A'; failPut=false; onPut=null;
  async root() {return {id:this.rootId};}
  async request(_path,options) {assert.equal(options.method,'POST');return {id:'folder-'+crypto.randomUUID()};}
  key(folder,name) {return `${folder}/${name}`;}
  async put(folder,name,data) {
    if(this.failPut) throw Error('offline');
    if(this.onPut) {const callback=this.onPut;this.onPut=null;callback();}
    const key=this.key(folder,name), item={id:key,name,eTag:JSON.stringify(data)};
    this.files.set(key,{item,data:clone(data)});return item;
  }
  async seed(folder) {return clone(this.files.get(this.key(folder,'seed.json')).data);}
  async children(folder) {return [...this.files.values()].filter(f=>f.item.id.startsWith(folder+'/')).map(f=>clone(f.item));}
  async readItem(item) {return clone(this.files.get(item.id).data);}
}
async function pair(balance=1000) {
  const a=local(balance), b=local(200);const drive=new FakeDrive();
  const ca=new CloudSync(a,drive,'owner-A');await ca.create();
  const cb=new CloudSync(b,drive,'owner-A');await cb.join(a.get().meta.remote.folderId);
  return {a,b,ca,cb,drive};
}
test('migrates legacy balance independently of history, retains original keys, migration is idempotent',()=>{
  const a=local(300,[tx('deposit',500),tx('withdraw',200)]);
  assert.equal(a.get().balance,300);assert.equal(a.get().transactions.length,2);
  const id=a.activeId();a.init();assert.equal(a.activeId(),id);
  assert.equal(a.storage.getItem('piggy_balance_highlight'),'300');
  assert(a.read('legacy-backup'));
  a.clear();assert.equal(a.get().balance,300);assert.equal(a.get().transactions.length,0);
});
test('invalid legacy JSON, malformed dates and unsafe amounts are rejected without changing old data',()=>{
  const a=local();assert.throws(()=>a.add('deposit',1.2,date));
  assert.throws(()=>a.add('deposit',100,'2026-02-30'));
  assert.throws(()=>a.add('withdraw',1,date));
  assert.throws(()=>a.add('deposit',Number.MAX_SAFE_INTEGER+1,date));
  const storage=new MemoryStorage();storage.setItem('piggy_transactions_highlight','broken');
  assert.throws(()=>new LedgerStore(storage).init());
  assert.equal(storage.getItem('piggy_transactions_highlight'),'broken');
  assert.equal(storage.getItem('piggy_v2:active'),null);
});
test('failed local persistence leaves displayed source of truth unchanged',()=>{
  const a=local(10);a.storage.fail=true;assert.throws(()=>a.add('deposit',5,date));
  assert.equal(a.get().balance,10);assert.equal(a.get().events.length,0);
});
test('joining cloud does not add local balance, old local ledger remains exportable',async()=>{
  const {b}=await pair(1000);assert.equal(b.get().balance,1000);
  const retained=b.list().find(book=>book.balance===200);assert(retained);
  assert.equal(b.export(retained.seed.id).balance,200);
});
test('concurrent offline additions converge and retry does not duplicate balances',async()=>{
  const {a,b,ca,cb}=await pair();a.add('deposit',50,date);b.add('deposit',70,date);
  await Promise.all([ca.sync(),cb.sync()]);await ca.sync();await cb.sync();
  assert.equal(a.get().balance,1120);assert.equal(b.get().balance,1120);
  assert.equal(a.get().transactions.length,2);await ca.sync();assert.equal(a.get().balance,1120);
});
test('clearing records preserves balance and does not clear a previously unseen offline transaction',async()=>{
  const {a,b,ca,cb}=await pair();a.add('deposit',100,date);await ca.sync();await cb.sync();
  a.clear();b.add('deposit',30,date);await cb.sync();await ca.sync();await cb.sync();
  assert.equal(a.get().balance,1130);assert.equal(b.get().balance,1130);
  assert.deepEqual(a.get().transactions.map(t=>t.amount),[30]);
  assert.deepEqual(b.get().transactions.map(t=>t.amount),[30]);
});
test('simultaneous offline withdrawals retain both entries and expose negative balance',async()=>{
  const {a,b,ca,cb}=await pair(100);a.add('withdraw',80,date);b.add('withdraw',80,date);
  await ca.sync();await cb.sync();await ca.sync();assert.equal(a.get().balance,-60);
  assert.equal(a.get().transactions.length,2);
});
test('network failure keeps pending event; successful retry uploads it once',async()=>{
  const {a,ca,drive}=await pair();a.add('deposit',25,date);drive.failPut=true;
  await assert.rejects(ca.sync());assert.equal(a.get().balance,1025);
  assert.equal(a.get().meta.acknowledged.length,0);
  drive.failPut=false;await ca.sync();await ca.sync();assert.equal(a.get().balance,1025);
  assert.equal(a.get().meta.acknowledged.length,1);
});
test('wrong Microsoft account and changed app root cannot upload',async()=>{
  const {a,drive}=await pair();a.add('deposit',25,date);
  await assert.rejects(new CloudSync(a,drive,'other-owner').sync(),/帳號/);
  drive.rootId='root-B';await assert.rejects(new CloudSync(a,drive,'owner-A').sync(),/資料夾/);
});
test('altered or deleted cloud events halt sync without erasing local history',async()=>{
  const {a,ca,drive}=await pair();a.add('deposit',25,date);await ca.sync();
  const event=a.get().events[0], folder=a.get().meta.remote.folderId;
  const key=drive.key(folder,`event-${event.id}.json`);
  const original=clone(drive.files.get(key));
  drive.files.get(key).data.amount=99;drive.files.get(key).item.eTag='changed';
  await assert.rejects(ca.sync(),/不同內容/);assert.equal(a.get().balance,1025);
  drive.files.set(key,original);drive.files.delete(key);
  await assert.rejects(ca.sync(),/移除/);assert.equal(a.get().transactions.length,1);
});
test('local event added during upload stays pending until next sync',async()=>{
  const {a,ca,drive}=await pair();a.add('deposit',25,date);
  drive.onPut=()=>a.add('deposit',35,date);await ca.sync();
  assert.equal(a.get().events.length,2);assert.equal(a.get().meta.acknowledged.length,1);
  await ca.sync();assert.equal(a.get().meta.acknowledged.length,2);assert.equal(a.get().balance,1060);
});
test('per-event storage retains concurrent tab writes',()=>{
  const a=local();const other=new LedgerStore(a.storage);
  a.add('deposit',10,date);other.add('deposit',20,date);assert.equal(a.get().balance,30);
});
test('Graph pagination follows trusted links; preauthenticated download receives no bearer token',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(url.includes('children')) return Response.json({value:[{id:'a'}],'@odata.nextLink':'https://graph.microsoft.com/v1.0/page2'});
    if(url.endsWith('page2')) return Response.json({value:[{id:'b'}]});
    return Response.json({ok:true});
  };
  const drive=new GraphDrive({token:async()=>'test-token'},fetcher);
  assert.equal((await drive.children('root')).length,2);
  await drive.readItem({id:'item','@microsoft.graph.downloadUrl':'https://download.example.test/file'});
  assert.equal(calls[2].options.headers,undefined);
  await assert.rejects(drive.request('https://untrusted.example.test/'),/無效/);
});
test('Mac v1 JSON backup can be imported with balance intact',()=>{
  const a=local();a.create({version:1,balance:400,transactions:[tx('deposit',500),tx('withdraw',100)],theme:'dark'});
  assert.equal(a.get().balance,400);assert.equal(a.get().transactions.length,2);
  assert.equal(snapshot(a.get().seed,[]).balance,400);
});

test('edit and delete legacy entries adjust independent balance, preserve seed and original timestamp',()=>{
 const a=local(300,[tx('deposit',500),tx('withdraw',200)]); const original=clone(a.get().seed);
 a.edit('legacy-0',{type:'withdraw',amount:50,date:'2026-09-09'});
 assert.equal(a.get().balance,-250);assert.equal(a.get().transactions.find(t=>t.id==='legacy-0').timestamp,original.transactions[0].timestamp);
 a.remove('legacy-0');assert.equal(a.get().balance,-200);assert.deepEqual(a.get().seed,original);
 assert.throws(()=>a.remove('legacy-0'));
});
test('date-only edits do not change balance and stale editors cannot overwrite another edit',()=>{
 const a=local(300,[tx('deposit',100)]);const old={...a.get().transactions[0],ledgerId:a.activeId()};
 a.edit(old.id,{type:'deposit',amount:100,date:'2026-09-09'},old);assert.equal(a.get().balance,300);
 assert.throws(()=>a.edit(old.id,{type:'deposit',amount:200,date},old),/已變更/);
 const n=a.get().events.length;
 assert.throws(()=>a.edit(old.id,{type:'deposit',amount:0,date}));
 assert.throws(()=>a.edit(old.id,{type:'deposit',amount:2,date:'2026-02-30'}));assert.equal(a.get().events.length,n);
});
test('concurrent edits converge without double applying balance adjustments, then causal edit wins',async()=>{
 const {a,b,ca,cb}=await pair();a.add('deposit',100,date);await ca.sync();await cb.sync();const id=a.get().transactions[0].id;
 a.edit(id,{type:'deposit',amount:200,date});b.edit(id,{type:'withdraw',amount:50,date});
 await ca.sync();await cb.sync();await ca.sync();assert.equal(a.get().balance,b.get().balance);
 assert([1200,950].includes(a.get().balance));
 b.edit(id,{type:'deposit',amount:350,date});await cb.sync();await ca.sync();assert.equal(a.get().balance,1350);
 assert.deepEqual(snapshot(a.get().seed,[...a.get().events].reverse()),snapshot(a.get().seed,a.get().events));
});
test('delete wins over concurrent edits and retries across two devices',async()=>{
 const {a,b,ca,cb}=await pair();a.add('withdraw',100,date);await ca.sync();await cb.sync();const id=a.get().transactions[0].id;
 a.remove(id);b.edit(id,{type:'withdraw',amount:200,date});await ca.sync();await cb.sync();await ca.sync();await cb.sync();
 assert.equal(a.get().balance,1000);assert.equal(b.get().balance,1000);assert.equal(b.get().transactions.length,0);
});
test('clear concurrent with edit hides detail but retains corrected balance',async()=>{
 const {a,b,ca,cb}=await pair();a.add('deposit',100,date);await ca.sync();await cb.sync();const id=a.get().transactions[0].id;
 a.clear();b.edit(id,{type:'deposit',amount:250,date});await ca.sync();await cb.sync();await ca.sync();
 assert.equal(a.get().balance,1250);assert.equal(a.get().transactions.length,0);
});
test('missing transaction dependency rejects entire merge and duplicate events stay idempotent',()=>{
 const a=local();a.add('deposit',100,date);const id=a.get().transactions[0].id;a.edit(id,{type:'deposit',amount:200,date});
 const book=a.get();assert.equal(snapshot(book.seed,[...book.events,...book.events]).balance,200);
 const b=local();const before=b.storage.data.size;
 assert.throws(()=>b.merge(book.seed,[book.events.find(e=>e.kind==='edit')]),/尚未完整/);assert.equal(b.storage.data.size,before);
});

MemoryStorage.prototype.removeItem=function(k){if(this.fail)throw Error('Quota exceeded');this.data.delete(k);};
test('restore replaces balance and rows, preserves cloud identity, autosaves previous state and synchronizes',async()=>{
 const {a,b,ca,cb}=await pair();a.add('deposit',10,date);await ca.sync();await cb.sync();
 const id=a.activeId(),remote=clone(a.get().meta.remote);
 await a.importInto({balance:250,transactions:[tx('withdraw',50)]},'replace');
 assert.equal(a.activeId(),id);assert.deepEqual(a.get().meta.remote,remote);assert.equal(a.backups()[0].data.balance,1010);
 await ca.sync();await cb.sync();assert.equal(b.get().balance,250);assert.equal(b.get().transactions.length,1);
 const entry=b.get().transactions[0];b.edit(entry.id,{type:'withdraw',amount:70,date});await cb.sync();await ca.sync();assert.equal(a.get().balance,230);
});
test('restore retains unseen offline additions and wins over edits to replaced rows',async()=>{
 const {a,b,ca,cb}=await pair();a.add('deposit',100,date);await ca.sync();await cb.sync();const old=b.get().transactions[0].id;
 await a.importInto({balance:20,transactions:[]},'replace');b.edit(old,{type:'deposit',amount:900,date});b.add('deposit',30,date);
 await ca.sync();await cb.sync();await ca.sync();assert.equal(a.get().balance,50);assert.equal(b.get().balance,50);
});
test('merge skips duplicate rows, keeps independent balance and is idempotent',async()=>{
 const a=local(300,[tx('deposit',100)]),data={balance:9000,transactions:[tx('deposit',100),tx('deposit',100),tx('withdraw',20)]};
 assert.equal(a.previewImport(data,'merge').added,2);await a.importInto(data,'merge');assert.equal(a.get().balance,380);
 assert.equal(a.get().transactions.length,3);await a.importInto(data,'merge');assert.equal(a.get().balance,380);
});
test('simultaneous overlapping merges converge once, different rows both survive',async()=>{
 const {a,b,ca,cb}=await pair();
 await a.importInto({balance:0,transactions:[tx('deposit',100),tx('withdraw',10)]},'merge');
 await b.importInto({balance:0,transactions:[tx('deposit',100),tx('withdraw',20)]},'merge');
 await ca.sync();await cb.sync();await ca.sync();assert.equal(a.get().balance,1070);assert.equal(b.get().balance,1070);assert.equal(a.get().transactions.length,3);
});
test('concurrent restores deterministically choose one, later restore supersedes both',async()=>{
 const {a,b,ca,cb}=await pair();await a.importInto({balance:10,transactions:[]},'replace');await b.importInto({balance:20,transactions:[]},'replace');
 await ca.sync();await cb.sync();await ca.sync();assert.equal(a.get().balance,b.get().balance);assert([10,20].includes(a.get().balance));
 await b.importInto({balance:40,transactions:[]},'replace');await cb.sync();await ca.sync();assert.equal(a.get().balance,40);
});
test('failed automatic backup prevents replacement, invalid imports leave book unchanged',async()=>{
 const a=local(100);a.storage.fail=true;await assert.rejects(a.importInto({balance:0,transactions:[]},'replace'));assert.equal(a.get().balance,100);
 a.storage.fail=false;await assert.rejects(a.importInto({balance:0,transactions:[{}]},'replace'));assert.equal(a.get().balance,100);
});
test('backup deletion leaves ledger intact; active and last local book deletion keeps usable state',()=>{
 const a=local(100),id=a.saveBackup();assert.equal(a.backups().length,1);a.deleteBackup(id);assert.equal(a.backups().length,0);assert.equal(a.get().balance,100);
 const old=a.activeId();a.deleteBook(old);assert.notEqual(a.activeId(),old);assert.equal(a.get().balance,0);assert.equal(a.list().length,1);assert.equal(a.read('seed:'+old),null);
});
test('cloud deletion checks owner, handles failure without local loss, then removes selected folder only',async()=>{
 const {a,ca,drive}=await pair();const id=a.activeId(),folder=a.get().meta.remote.folderId;
 await assert.rejects(new CloudSync(a,drive,'other').deleteCloudBook(id));assert.equal(a.activeId(),id);
 drive.request=async()=>{throw Error('offline');};await assert.rejects(ca.deleteCloudBook(id));assert.equal(a.activeId(),id);
 drive.request=async(path,options)=>{assert.equal(options.method,'DELETE');assert.equal(path,'/me/drive/items/'+folder);for(const k of drive.files.keys())if(k.startsWith(folder+'/'))drive.files.delete(k);return null;};
 await ca.deleteCloudBook(id);assert.notEqual(a.activeId(),id);assert.equal(a.get().balance,0);assert.equal(drive.files.size,0);
});
test('merge preview matches result after deleting a previously imported row',async()=>{
 const a=local(0),data={balance:100,transactions:[tx('deposit',100)]};await a.importInto(data,'merge');a.remove(a.get().transactions[0].id);
 assert.equal(a.previewImport(data,'merge').added,0);assert.equal(a.previewImport(data,'merge').balance,0);await a.importInto(data,'merge');assert.equal(a.get().balance,0);
});
