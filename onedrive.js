import {UUID, validateSeed, validateEvent, snapshot} from './ledger.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['Files.ReadWrite.AppFolder'];
const encode = encodeURIComponent;
export class MicrosoftLogin {
  constructor(clientId) { this.clientId = clientId; this.instance = null; }
  async init() {
    if (!UUID.test(this.clientId)) throw Error('請先設定 Microsoft 應用程式識別碼。');
    if (!window.piggyMSAL) throw Error('登入元件未載入，請重新整理網站。');
    this.instance = new window.piggyMSAL.PublicClientApplication({
      auth: {clientId:this.clientId, authority:'https://login.microsoftonline.com/consumers',
        redirectUri:new URL('./', location.href).href, navigateToLoginRequestUrl:false},
      cache:{cacheLocation:'localStorage'}
    });
    await this.instance.initialize();
    const response = await this.instance.handleRedirectPromise();
    if (response?.account) this.instance.setActiveAccount(response.account);
    if (!this.instance.getActiveAccount()) {
      const accounts = this.instance.getAllAccounts();
      if (accounts.length === 1) this.instance.setActiveAccount(accounts[0]);
    }
    return this.account();
  }
  account() { return this.instance?.getActiveAccount() || null; }
  async login() { await this.instance.loginRedirect({scopes:SCOPES, prompt:'select_account'}); }
  async token() {
    const account = this.account();
    if (!account) throw Error('請登入 Microsoft 帳號後同步。');
    try { return (await this.instance.acquireTokenSilent({account, scopes:SCOPES})).accessToken; }
    catch { throw Error('登入已到期，請按「登入 OneDrive」重新授權；未同步的紀錄仍保存在這台裝置。'); }
  }
  async logout() {
    await this.instance.logoutRedirect({account:this.account(),postLogoutRedirectUri:new URL('./',location.href).href});
  }
}

export class GraphDrive {
  constructor(login, fetcher = (...args) => fetch(...args)) { this.login = login; this.fetcher = fetcher; }
  async request(path, options = {}) {
    const url = path.startsWith('https:') ? path : GRAPH + path;
    const parsed = new URL(url);
    if (parsed.origin !== 'https://graph.microsoft.com' || !parsed.pathname.startsWith('/v1.0/')) throw Error('無效的同步位址。');
    const token = await this.login.token();
    const response = await this.fetcher(url, {...options, cache:'no-store', credentials:'omit',
      signal:AbortSignal.timeout(25000), headers:{Authorization:`Bearer ${token}`, ...options.headers}});
    if (!response.ok) {
      const error = Error(response.status === 401 ? '登入已到期，請重新登入 OneDrive。' :
        response.status === 403 ? 'OneDrive 權限不足，請確認已授權應用程式專用資料夾。' :
        response.status === 429 ? 'OneDrive 暫時限制請求，請稍後再同步。' :
        response.status === 507 ? 'OneDrive 空間不足；未同步的紀錄仍在這台裝置。' : `OneDrive 連線失敗（${response.status}），請稍後再試。`);
      error.status = response.status; throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  root() { return this.request('/me/drive/special/approot'); }
  async children(id) {
    let next = `/me/drive/items/${encode(id)}/children?$top=200`, items = [];
    const seen = new Set();
    while (next) {
      if (seen.has(next)) throw Error('OneDrive 分頁資料有誤。');
      seen.add(next);
      const page = await this.request(next);
      if (!Array.isArray(page.value)) throw Error('OneDrive 資料格式有誤。');
      items.push(...page.value); next = page['@odata.nextLink'];
    }
    return items;
  }
  async readItem(item) {
    if (item.size > 10 * 1024 * 1024) throw Error('帳本檔案過大，已停止讀取。');
    let metadata = item;
    if (!metadata['@microsoft.graph.downloadUrl']) metadata = await this.request(`/me/drive/items/${encode(item.id)}`);
    const url = metadata['@microsoft.graph.downloadUrl'];
    if (typeof url !== 'string' || new URL(url).protocol !== 'https:') throw Error('OneDrive 未提供有效的檔案下載位址。');
    // Browser downloads use the preauthenticated URL, with no bearer token forwarded.
    const response = await this.fetcher(url, {credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(25000)});
    if (!response.ok) throw Error('無法下載雲端帳本，請稍後再試。');
    return response.json();
  }
  async seed(folderId) {
    const metadata = await this.request(`/me/drive/items/${encode(folderId)}:/seed.json`);
    return validateSeed(await this.readItem(metadata));
  }
  put(folderId, name, value) {
    return this.request(`/me/drive/items/${encode(folderId)}:/${encode(name)}:/content`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)
    });
  }
  async books() {
    const root = await this.root();
    const folders = (await this.children(root.id)).filter(item => item.folder && /^piggy-[0-9a-f-]{36}$/.test(item.name));
    const result = [];
    for (const item of folders) {
      try { result.push({folderId:item.id, seed:await this.seed(item.id)}); }
      catch (error) { if (error.status !== 404) throw error; } // Interrupted folder creation has no seed yet.
    }
    return result.sort((a,b) => a.seed.createdAt - b.seed.createdAt);
  }
}

export class CloudSync {
  constructor(store, drive, owner) { this.store = store; this.drive = drive; this.owner = owner; this.running = null; }
  async create(id = this.store.activeId()) {
    const book = this.store.get(id);
    if (book.meta.remote) throw Error('此帳本已連接雲端，請使用立即同步。');
    const root = await this.drive.root();
    const folder = await this.drive.request(`/me/drive/items/${encode(root.id)}/children`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:`piggy-${crypto.randomUUID()}`,folder:{},'@microsoft.graph.conflictBehavior':'fail'})
    });
    await this.drive.put(folder.id, 'seed.json', book.seed);
    this.store.updateMeta(id, {remote:{folderId:folder.id,rootId:root.id,owner:this.owner},name:'OneDrive 帳本'});
    await this.sync(id);
  }
  async join(folderId) {
    const root = await this.drive.root();
    const seed = await this.drive.seed(folderId);
    const existing = this.store.read(`seed:${seed.id}`);
    // Download and validate before changing the active ledger. The previous local ledger is retained.
    const events = await this.download(folderId, seed);
    snapshot(seed, events);
    if (existing) {
      const remote = this.store.get(seed.id).meta.remote;
      if (remote && (remote.owner !== this.owner || remote.folderId !== folderId)) throw Error('相同帳本識別碼已連接另一個雲端位置。');
    }
    this.store.merge(seed, events);
    this.store.updateMeta(seed.id,{remote:{folderId,rootId:root.id,owner:this.owner},name:'OneDrive 帳本',acknowledged:events.map(e=>e.id)});
    this.store.activate(seed.id);
    await this.sync(seed.id);
  }
  async download(folderId, seed, known = null) {
    const items = await this.drive.children(folderId);
    const eventItems = items.filter(item => /^event-[0-9a-f-]{36}\.json$/.test(item.name));
    const available = new Set(eventItems.map(item => item.name.slice(6,-5)));
    for (const id of known?.meta.acknowledged || []) if (!available.has(id)) throw Error('曾同步的雲端紀錄被移除，已暫停同步。請先從 OneDrive 還原檔案。');
    const events = [];
    const cached = new Map((known?.events || []).map(e=>[e.id,e]));
    const versions = known?.meta.versions || {};
    this.downloadedVersions = {};
    for (const item of eventItems) {
      const id = item.name.slice(6,-5);
      let event = cached.get(id);
      if (!event || !item.eTag || versions[id] !== item.eTag) event = validateEvent(await this.drive.readItem(item), seed.id);
      if (event.id !== id) throw Error('雲端檔名與紀錄不一致，已停止同步。');
      events.push(event);
      if (item.eTag) this.downloadedVersions[id] = item.eTag;
    }
    snapshot(seed, [...(known?.events || []), ...events]);
    return events;
  }
  sync(id = this.store.activeId()) {
    if (this.running) return this.running;
    this.running = this.perform(id).finally(()=>{this.running=null;});
    return this.running;
  }
  async perform(id) {
    const book = this.store.get(id), remote = book.meta.remote;
    if (!remote) throw Error('請先選擇或建立 OneDrive 帳本。');
    if (remote.owner !== this.owner) throw Error('目前登入的帳號與此帳本不同，請登入原本的 Microsoft 帳號。');
    const root = await this.drive.root();
    if (root.id !== remote.rootId) throw Error('OneDrive 資料夾已改變，已停止同步以保留本機資料。');
    const seed = await this.drive.seed(remote.folderId);
    if (JSON.stringify(seed) !== JSON.stringify(book.seed)) throw Error('雲端帳本起始資料已改變，已停止同步。');
    const remoteEvents = await this.download(remote.folderId, seed, book);
    this.store.merge(seed, remoteEvents);
    const acknowledged = new Set(remoteEvents.map(e=>e.id));
    const versions = {...this.downloadedVersions};
    // Re-read to include local entries made during the network request.
    for (const event of this.store.get(id).events) {
      if (acknowledged.has(event.id)) continue;
      const item = await this.drive.put(remote.folderId, `event-${event.id}.json`, event);
      acknowledged.add(event.id);
      if (item?.eTag) versions[event.id]=item.eTag;
    }
    this.store.updateMeta(id,{acknowledged:[...acknowledged],versions,lastSync:Date.now()});
    return this.store.get(id);
  }
}
