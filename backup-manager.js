export function createBackupManager({store,run,render,schedule,report,getCloud,refreshBooks}) {
  const $=id=>document.getElementById(id);
  const panel=document.createElement('div');panel.className='backup-manager';
  panel.innerHTML=`<h3>備份與帳本管理</h3>
    <label for="importMode">匯入方式（套用至目前帳本）</label>
    <select id="importMode"><option value="replace">取代目前帳本</option><option value="merge">合併至目前帳本</option><option value="new">另存為新帳本</option></select>
    <p class="hint">取代包含備份餘額；合併只加入未重複明細並加減餘額，不另加備份總餘額。日期、類型、金額及記錄時間皆相同才視為重複。</p>
    <label for="savedBackups">這台裝置儲存的備份</label><select id="savedBackups"></select>
    <div class="button-row"><button id="saveBackup">備份目前帳本</button><button id="applyBackup">套用所選備份</button><button id="downloadSaved">下載所選備份</button><button id="deleteBackup">刪除所選備份</button></div>
    <p class="hint">備份清單只保存在此裝置。刪除清單內備份不會刪除已下載的 JSON；下載檔請至 Finder／「檔案」刪除。</p>
    <label><input type="checkbox" id="backupBeforeDelete" checked> 刪除帳本前保留一份備份</label>
    <div class="button-row"><button id="deleteLocalBook">刪除所選帳本（僅此裝置）</button><button id="deleteCloudBook">刪除所選雲端帳本</button></div>
    <p class="hint">帳本刪除以「這台裝置保留的帳本」選單為準。雲端刪除會影響所有裝置；其他裝置的本機副本仍保留，但停止同步。</p>
    <p id="backupNotice" role="status"></p>`;
  document.querySelector('.backup-controls').append(panel);
  function selected() {const value=store.read('backup:'+$('savedBackups').value);if(!value)throw Error('請先選擇備份。');return value;}
  function download(data,name) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=name+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function refresh(busy) {
    const old=$('savedBackups').value;const list=store.backups();$('savedBackups').replaceChildren();
    for(const b of list) {const option=document.createElement('option');option.value=b.id;option.textContent=`${b.name} · ${new Date(b.savedAt).toLocaleString('zh-TW')} · $${b.data.balance.toLocaleString()}`;$('savedBackups').append(option);}
    if(list.some(b=>b.id===old))$('savedBackups').value=old;
    for(const el of panel.querySelectorAll('button,select,input'))el.disabled=busy;
    for(const id of ['applyBackup','downloadSaved','deleteBackup'])$(id).disabled=busy||!list.length;
    const book=store.get($('localBooks').value||store.activeId());
    $('deleteCloudBook').disabled=busy||!book.meta.remote||!getCloud();
  }
  const notice=message=>{$('backupNotice').textContent=message;};
  $('localBooks').addEventListener('change',()=>refresh(false));
  $('saveBackup').addEventListener('click',()=>run(async()=>{const id=store.saveBackup();render();$('savedBackups').value=id;notice('已儲存目前帳本備份。');}));
  $('downloadSaved').addEventListener('click',()=>{try{const b=selected();download(b.data,'電子撲滿備份-'+b.id);}catch(e){report(e);}});
  $('deleteBackup').addEventListener('click',()=>{
    try {const b=selected();if(!confirm(`刪除備份「${b.name}」？\n只刪除此裝置的這份備份，不影響帳本或其他下載檔。此操作無法復原。`))return;
      run(async()=>{store.deleteBackup(b.id);notice('已刪除所選備份。');});
    }catch(e){report(e);}
  });
  function applySaved() {
    let b;try{b=selected();}catch(e){report(e);return;}
    const mode=$('importMode').value,target=store.activeId();
    run(async()=>{
      if(mode!=='new'&&store.get().meta.remote) {
        if(!getCloud())throw Error('請先登入此帳本的 OneDrive 帳號。');
        await getCloud().sync(target);
      }
      if(store.activeId()!==target)throw Error('目前帳本已切換，請重試。');
      const preview=mode==='new'?{balance:b.data.balance,added:b.data.transactions.length}:store.previewImport(b.data,mode);
      const label={replace:'取代目前帳本',merge:'合併至目前帳本',new:'另存為新帳本'}[mode];
      if(!confirm(`${label}？\n備份：${b.name}\n套用後餘額：$${preview.balance.toLocaleString()}\n${mode==='merge'?'新增未重複明細':'匯入明細'}：${preview.added} 筆\n${mode==='new'?'建立新的本機帳本。':'會先自動備份現況；已連接的雲端帳本及其他裝置也會更新。'}`))return;
      if(mode==='new')store.create(b.data);else await store.importInto(b.data,mode,target);
      render();notice('備份已套用，本機資料已儲存。');
      if(mode!=='new'&&store.get().meta.remote) {await getCloud().sync(target);notice('備份已套用並同步。');}
      schedule();
    });
  }
  $('applyBackup').addEventListener('click',applySaved);
  for(const cloudDelete of [false,true]) $(cloudDelete?'deleteCloudBook':'deleteLocalBook').addEventListener('click',()=>{
    const id=$('localBooks').value,book=store.get(id),keep=$('backupBeforeDelete').checked;
    const text=cloudDelete?'刪除這本 OneDrive 帳本，所有裝置將無法再同步至它。本機這份帳本也會刪除。':'只刪除此裝置的帳本。OneDrive 帳本與其他裝置資料保留，可再次選取雲端帳本。';
    if(!confirm(`${text}\n帳本：${id.slice(0,8)} · 餘額 $${book.balance.toLocaleString()}\n${keep?'會先保留本機備份。':'不保留備份，請確認已有需要的資料。'}`))return;
    run(async()=>{
      if(cloudDelete && getCloud())await getCloud().sync(id);
      if(keep)store.saveBackup(store.export(id),'刪除帳本前備份');
      if(cloudDelete) {if(!getCloud())throw Error('請先登入 OneDrive。');await getCloud().deleteCloudBook(id);await refreshBooks();}else store.deleteBook(id);
      notice(cloudDelete?'雲端帳本已刪除；其他裝置本機副本不會遠端清除。':'已刪除此裝置的帳本。');
    });
  });
  return {refresh,download,async importFile(file) {
    if(file.size>10*1024*1024)throw Error('備份檔超過 10 MB，未匯入。');
    const data=JSON.parse(await file.text());
    const id=store.saveBackup(data,file.name);render();$('savedBackups').value=id;applySaved();
  }};
}
