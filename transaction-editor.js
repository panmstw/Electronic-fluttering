export function createTransactionEditor({store, render, schedule, report, clearError, isBusy}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'transaction-editor';
  dialog.setAttribute('aria-labelledby','editTitle');
  dialog.innerHTML = `<form id="editForm">
    <h2 id="editTitle">修改收支</h2>
    <label>類型<select name="type"><option value="deposit">存入</option><option value="withdraw">取出</option></select></label>
    <label>金額<input name="amount" type="number" min="1" max="9007199254740991" step="1" required inputmode="numeric"></label>
    <label>日期<input name="date" type="date" required></label>
    <p class="edit-preview" aria-live="polite"></p>
    <p class="edit-error" role="alert" hidden></p>
    <div class="edit-actions"><button type="button" class="edit-cancel">取消</button><button type="submit">儲存修改</button></div>
  </form>`;
  document.body.append(dialog);
  const form=dialog.querySelector('form'), error=dialog.querySelector('.edit-error'), preview=dialog.querySelector('.edit-preview');
  let editing=null;
  const signed=t=>t.type==='deposit'?t.amount:-t.amount;
  const fields=()=>({type:form.elements.type.value,amount:Number(form.elements.amount.value),date:form.elements.date.value});
  function updatePreview() {
    if(!editing)return;
    const balance=store.get().balance-signed(editing)+signed(fields());
    preview.textContent=Number.isSafeInteger(balance)?`修改後餘額：$${balance.toLocaleString('zh-TW')}${balance<0?'（負餘額，請確認）':''}`:'請輸入有效金額。';
  }
  form.addEventListener('input',updatePreview);
  dialog.querySelector('.edit-cancel').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{editing=null;});
  form.addEventListener('submit',event=>{
    event.preventDefault();
    try {
      if(isBusy())throw Error('正在同步，請稍後再儲存。');
      store.edit(editing.id,fields(),editing);
      dialog.close(); clearError(); render(); schedule();
    } catch(e) {error.textContent=e.message;error.hidden=false;}
  });
  return function appendActions(row,tx) {
    const group=document.createElement('div');group.className='tx-actions';
    const edit=document.createElement('button');edit.type='button';edit.textContent='修改';edit.disabled=isBusy();
    const remove=document.createElement('button');remove.type='button';remove.textContent='刪除';remove.className='tx-delete';remove.disabled=isBusy();
    const description=`${tx.date} ${tx.type==='deposit'?'存入':'取出'} ${tx.amount} 元`;
    edit.setAttribute('aria-label','修改 '+description);remove.setAttribute('aria-label','刪除 '+description);
    edit.addEventListener('click',()=>{
      editing={...tx,ledgerId:store.activeId()};
      form.elements.type.value=tx.type;form.elements.amount.value=tx.amount;form.elements.date.value=tx.date;
      error.hidden=true;updatePreview();dialog.showModal();form.elements.amount.focus();
    });
    remove.addEventListener('click',()=>{
      const expected={...tx,ledgerId:store.activeId()}, balance=store.get().balance-signed(tx);
      if(!confirm(`刪除這筆「${description}」？\n刪除後餘額：$${balance.toLocaleString('zh-TW')}${balance<0?'（負餘額）':''}\n此操作無法直接復原，並會同步至共用此帳本的裝置。`))return;
      try {if(isBusy())throw Error('正在同步，請稍後再刪除。');store.remove(tx.id,expected);clearError();render();schedule();}catch(e){report(e);}
    });
    group.append(edit,remove);row.append(group);
  };
}
