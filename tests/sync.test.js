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
