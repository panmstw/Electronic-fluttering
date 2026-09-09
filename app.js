import {createTransactionEditor} from './transaction-editor.js';
import {LedgerStore, UUID} from './ledger.js';
import {MicrosoftLogin, GraphDrive, CloudSync} from './onedrive.js';

const $ = id => document.getElementById(id);
const store = new LedgerStore(localStorage);
let login = null, drive = null, cloud = null, busy = false, timer = null, fatal = false;
const settingsButtons = ['saveClient','login','logout','refreshBooks','joinBook','createBook','switchLocal','importBackup'];
function report(error) {
  $('appError').textContent = error instanceof Error ? error.message : String(error);
  $('appError').hidden = false;
}
function clearError() { $('appError').hidden = true; }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function applyTheme() { $('themeToggle').textContent = document.documentElement.dataset.theme === 'dark' ? '☀️ 淺色' : '🌙 深色'; }
const appendActions=createTransactionEditor({store,render,schedule,report,clearError,isBusy:()=>busy || fatal});
function pending(book) { const ack = new Set(book.meta.acknowledged || []); return book.events.filter(e=>!ack.has(e.id)).length; }
function render() {
  if (fatal) return;
  const book = store.get();
  $('totalBalance').textContent = book.balance.toLocaleString('zh-TW');
  $('balanceWarning').hidden = book.balance >= 0;
  const list = $('transactionList'); list.replaceChildren();
  if (!book.transactions.length) {
    const empty = document.createElement('div'); empty.className='empty-history'; empty.textContent='🐷 還沒有任何收支紀錄，開始存錢吧！'; list.append(empty);
  }
  for (const tx of book.transactions) {
    const isDeposit = tx.type === 'deposit';
    const row = document.createElement('div'); row.className=`tx-item ${isDeposit ? 'tx-deposit-bg':'tx-withdraw-bg'}`;
    const type = document.createElement('div'); type.className='tx-type'; type.textContent=isDeposit ? '📥 存入':'📤 取出';
    const date = document.createElement('div'); date.className='tx-date'; date.textContent=tx.date.replaceAll('-','/');
    const amount = document.createElement('div'); amount.className='tx-amount'; amount.textContent=`${isDeposit ? '+':'−'} $${tx.amount.toLocaleString('zh-TW')}`;
    row.append(type,date,amount); appendActions(row,tx); list.append(row);
  }
  const account=login?.account();
  $('accountLabel').textContent=account ? `已登入：${account.username || account.name || 'Microsoft 帳號'}`:'尚未登入 OneDrive';
  $('logout').hidden=!account; $('cloudControls').hidden=!account;
  $('syncNow').disabled=busy || !cloud || !book.meta.remote || !navigator.onLine;
  for (const id of settingsButtons) $(id).disabled=busy;
  $('login').disabled=busy || !login?.instance;
  $('createBook').disabled=busy || !!book.meta.remote;
  let status='僅此裝置 · 已自動儲存';
  if (busy) status='正在連接 OneDrive…';
  else if (book.meta.remote) {
    if (!navigator.onLine) status=`離線 · ${pending(book)} 筆待同步`;
    else if (!account) status=`請登入同步 · ${pending(book)} 筆待同步`;
    else if (pending(book)) status=`${pending(book)} 筆待同步`;
    else if (book.meta.lastSync) status=`已同步 · ${new Date(book.meta.lastSync).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'})}`;
    else status='已連接 · 等待同步';
  }
  $('syncStatus').textContent=status;
  const selected = $('localBooks').value;
  $('localBooks').replaceChildren();
  for (const local of store.list()) {
    const option=document.createElement('option'); option.value=local.seed.id;
    option.textContent=`${local.seed.id===book.seed.id ? '目前 · ':''}${local.meta.remote ? 'OneDrive':'本機保留'} · $${local.balance.toLocaleString()} · ${new Date(local.seed.createdAt).toLocaleString('zh-TW')}`;
    $('localBooks').append(option);
  }
  $('localBooks').value = [...$('localBooks').options].some(o=>o.value===selected) ? selected : book.seed.id;
}
async function run(task) {
  if (busy || fatal) return;
  busy=true; clearError(); render();
  let succeeded=false;
  try { await task(); succeeded=true; }
  catch(error) { report(error); }
  finally { busy=false; render(); if(succeeded && cloud && store.get().meta.remote && pending(store.get())) schedule(); }
}
function schedule() {
  clearTimeout(timer);
  timer=setTimeout(()=>{
    if (document.visibilityState !== 'visible' || !navigator.onLine || !cloud || busy || fatal || !store.get().meta.remote) return;
    run(()=>cloud.sync());
  },1200);
}
async function initializeLogin() {
  const clientId=(window.PIGGY_CONFIG?.clientId || localStorage.getItem('piggy_client_id') || '').trim();
  $('clientId').value=clientId;
  $('clientSetup').hidden=!!window.PIGGY_CONFIG?.clientId;
  if (!clientId) return;
  login=new MicrosoftLogin(clientId);
  await login.init();
  if (login.account()) {
    drive=new GraphDrive(login); cloud=new CloudSync(store,drive,login.account().homeAccountId);
  }
}
async function refreshBooks() {
  if (!drive) return;
  const books=await drive.books(); $('cloudBooks').replaceChildren();
  const prompt=document.createElement('option'); prompt.value=''; prompt.textContent=books.length ? '請選擇要共用的帳本':'目前沒有雲端帳本'; $('cloudBooks').append(prompt);
  for (const book of books) {
    const option=document.createElement('option'); option.value=book.folderId;
    option.textContent=`電子撲滿 · 建立於 ${new Date(book.seed.createdAt).toLocaleString('zh-TW')} · ${book.seed.id.slice(0,8)}`;
    $('cloudBooks').append(option);
  }
  const remote=store.get().meta.remote;
  if (remote && books.some(b=>b.folderId===remote.folderId)) $('cloudBooks').value=remote.folderId;
}

try { store.init(); render(); } catch(error) {
  fatal=true; report(error); $('syncStatus').textContent='資料讀取失敗，原始資料已保留';
  document.querySelectorAll('button').forEach(b=>{b.disabled=true;});
}
$('depositDate').value=today(); $('withdrawDate').value=today(); applyTheme();
for (const kind of ['deposit','withdraw']) {
  function record() {
    if (fatal) return;
    try {
      store.add(kind,Number($(kind+'Amount').value),$(kind+'Date').value || today());
      $(kind+'Amount').value=''; clearError(); render(); schedule();
    } catch(error) { report(error); }
  }
  $(kind+'Btn').addEventListener('click',record);
  $(kind+'Amount').addEventListener('keydown',event=>{if(event.key==='Enter') record();});
}
$('clearHistoryBtn').addEventListener('click',()=>{
  if (!store.get().transactions.length) return;
  if (!confirm('清除目前所有收支明細，但保留結餘總額。連接 OneDrive 時，這項變更也會同步到其他裝置。確定繼續？')) return;
  try { store.clear(); clearError(); render(); schedule(); } catch(error) { report(error); }
});
$('themeToggle').addEventListener('click',()=>{
  const next=document.documentElement.dataset.theme==='dark' ? 'light':'dark';
  try { localStorage.setItem('piggy_theme',next); document.documentElement.dataset.theme=next; applyTheme(); } catch(error) { report(error); }
});
$('openSync').addEventListener('click',()=>{ $('syncSettings').open=!$('syncSettings').open; });
$('syncNow').addEventListener('click',()=>run(()=>cloud.sync()));
$('saveClient').addEventListener('click',()=>run(async()=>{
  const id=$('clientId').value.trim();
  if (!UUID.test(id)) throw Error('請輸入有效的 Microsoft 應用程式識別碼（不是密碼或用戶端密碼）。');
  localStorage.setItem('piggy_client_id',id);
  login=null;drive=null;cloud=null;
  await initializeLogin();
}));
$('login').addEventListener('click',()=>run(()=>login.login()));
$('logout').addEventListener('click',()=>run(()=>login.logout()));
$('refreshBooks').addEventListener('click',()=>run(refreshBooks));
$('createBook').addEventListener('click',()=>{
  if (!confirm('將目前這台裝置的餘額與明細建立為新的 OneDrive 帳本？其他裝置之後請選擇這一本。')) return;
  run(async()=>{await cloud.create(); await refreshBooks();});
});
$('joinBook').addEventListener('click',()=>{
  const folder=$('cloudBooks').value;
  if (!folder) { report(Error('請先選擇雲端帳本。')); return; }
  if (!confirm('改用選取的雲端帳本？這台原有帳本會保留在「這台裝置保留的帳本」，不會將兩邊餘額相加。')) return;
  run(()=>cloud.join(folder));
});
$('switchLocal').addEventListener('click',()=>{
  if (!confirm('切換到選取的帳本？目前資料會保留。')) return;
  try { store.activate($('localBooks').value); clearError();render();schedule(); } catch(error) { report(error); }
});
$('exportBackup').addEventListener('click',()=>{
  try {
    const data=store.export($('localBooks').value || store.activeId());
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a'); a.href=url;a.download=`電子撲滿備份-${today()}.json`;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  } catch(error) { report(error); }
});
$('importBackup').addEventListener('click',()=>$('backupFile').click());
$('backupFile').addEventListener('change',async()=>{
  const file=$('backupFile').files[0]; if (!file) return;
  try {
    if (file.size>10*1024*1024) throw Error('備份檔超過 10 MB，未匯入。');
    const data=JSON.parse(await file.text());
    if (!confirm('將備份匯入為另一個本機帳本？目前帳本會保留，雲端內容不會被覆寫。')) return;
    store.create(data);clearError();render();
  } catch(error) { report(error); }
  finally {$('backupFile').value='';}
});
window.addEventListener('storage',event=>{
  if (event.key?.startsWith('piggy_v2:')) {try {render();schedule();} catch(error) {report(error);}}
});
window.addEventListener('online',()=>{render();schedule();});
window.addEventListener('offline',render);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){render();schedule();}});
setInterval(schedule,60000);
if (!fatal) {
  await run(async()=>{await initializeLogin(); if (drive) {if(store.get().meta.remote) await cloud.sync(); await refreshBooks();}});
}
if ('serviceWorker' in navigator && location.protocol==='https:') {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
