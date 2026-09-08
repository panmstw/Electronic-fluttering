# Electronic-fluttering — 電子撲滿

保留原版的存錢、取錢、日期、結餘與明細，加入深淺模式、離線快取及 OneDrive 個人帳號同步。

## 啟用

請閱讀 [OneDrive 設定說明](ONEDRIVE-SETUP.md)，註冊自己的 Microsoft SPA 應用程式，填入 `config.js` 的公開 client ID。維持 GitHub Pages 的現有網域和路徑，才可從原有 localStorage 遷移資料。

帳本一律先在本機保存。雲端連接在使用者登入、建立／選擇雲端帳本後才啟用。原始 localStorage 鍵不刪除；切換帳本也不把兩邊餘額直接相加。

## 開發

```sh
npm ci
npm run build
npm test
```

`npm run build` 將官方 MSAL Browser 打包到 `vendor/msal.js`；產物應一起提交，GitHub Pages 無需 Node.js 伺服器。

- `ledger.js`：資料驗證、舊版遷移、逐筆本機事件、帳本計算。
- `onedrive.js`：官方 MSAL 登入、Microsoft Graph、逐筆同步。
- `app.js`：介面、備份、狀態與排程。
- `sw.js`：僅快取本站靜態資源；OAuth 回呼和雲端資料不快取。
- `tests/sync.test.js`：資料與模擬雲端合併測試。

起始餘額獨立於顯示中的歷史紀錄，因此清除明細後仍能正確遷移。每個事件是獨立檔案，識別碼固定；重傳不會重複記帳，跨裝置新增不會互相覆寫。清除操作只隱藏當時可見的紀錄 ID，不改變餘額，也不吞掉尚未同步的新紀錄。

資料存在本機瀏覽器與使用者自己的 OneDrive 專用資料夾；不提供伺服器集中交易。兩台離線裝置同時提款可能造成合併後負餘額，會明確提示而不丟棄紀錄。

尚未完成使用者的 Microsoft 應用程式設定及實帳戶端到端驗證。既有 Mac 1.0.0 應用程式不包含本次同步更新；可先在 Mac 使用這個網站，或透過匯入功能帶入桌面版 JSON 備份。
