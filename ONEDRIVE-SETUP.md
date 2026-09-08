# 電子撲滿：OneDrive 首次設定

這次更新沿用原網站：
https://panmstw.github.io/Electronic-fluttering/

程式已填入你的應用程式識別碼，但在完成 OneDrive 權限及部署之前，不會自動連接你的 OneDrive。支援 Microsoft 個人帳號（例如 Outlook、Hotmail），目前未設定公司／學校帳號。

## 一、註冊 Microsoft 應用程式（只需一次）

1. 開啟 https://entra.microsoft.com/ ，用你自己的 Microsoft 帳號登入。
2. 找到「應用程式註冊」（App registrations），選「新增註冊」。
3. 名稱填「電子撲滿」。
4. 支援的帳戶類型選「僅限個人 Microsoft 帳戶」。若入口只提供組織選項，請先確認目前目錄允許建立包含個人帳號的應用程式。
5. 重新導向 URI 的平台選「單頁應用程式（SPA）」；填入以下網址，保留最後的斜線：

   `https://panmstw.github.io/Electronic-fluttering/`

6. 完成註冊後，到「API 權限 → 新增權限 → Microsoft Graph → 委派權限」，加入 `Files.ReadWrite.AppFolder`。不需要 `Files.ReadWrite.All`，也不需要應用程式權限。
7. 回到「概觀」，複製「應用程式（用戶端）識別碼」。它的外觀是五組以連字號分開的文字。

不需要建立「用戶端密碼／Client secret」。請勿把密碼、登入驗證碼或權杖放進 GitHub，或傳給他人。應用程式識別碼本身是可公開的設定值。

若 Microsoft 入口顯示「沒有目錄」「無權註冊」或其他阻擋，先停在該畫面並提供不含個資的錯誤截圖，才能確認你的帳號是否具備註冊條件；不要為此任意購買服務。

## 二、填入識別碼並更新網站

此下載包已填入你的識別碼，不需再改。`config.js` 的設定為：

```javascript
window.PIGGY_CONFIG = { clientId: 'd1e7c588-a15b-4b9c-9c6b-828975f85015' };
```

下載包的 `網站更新/` 內有全部需要部署的網站檔案。將裡面的檔案及資料夾放進儲存庫根目錄，保留 `vendor/` 及 `icons/` 的目錄結構；不是只替換 `index.html`。

儲存庫：https://github.com/panmstw/Electronic-fluttering

沿用既有 GitHub Pages 設定。等待 GitHub Pages 部署成功後，開啟原網址並重新整理。不要更換網域或刪除瀏覽器資料，以便讀取原有紀錄。

若暫時沒有把識別碼寫入 `config.js`，也可在更新後網站的「同步設定」填入。這種方式需在每台裝置各填一次。

## 三、選定第一本雲端帳本

1. 先在目前紀錄最完整的裝置開啟「同步設定」。
2. 在「這台裝置保留的帳本」確認選到目前帳本，按「下載備份」。
3. 按「登入 OneDrive」，完成 Microsoft 登入與專用資料夾授權。
4. 登入回來後，按「將這台帳本建立為雲端帳本」。等待畫面顯示已同步。
5. 在其他裝置開啟相同網址，以同一個 Microsoft 帳號登入。
6. 按「重新整理帳本」，選擇剛才建立的那一本，再按「使用選取的雲端帳本」。

其他裝置請勿各自建立新的雲端帳本，否則會得到兩本獨立帳本。

切換時，原本的本機帳本仍在「這台裝置保留的帳本」，可以切換查看或下載備份。兩邊金額不會直接相加：如果先前兩台裝置各有不同資料，請先比對並補齊，避免把相同收支算兩次。

## 四、日常使用

- 開著網站時，新增收支約一秒後嘗試同步；回到網站、恢復連線及每隔一分鐘也會嘗試。
- 「已同步」只表示上次完成同步的時間；要立即取得別台最新資料，可按「立即同步」。
- 離線可以記帳，未傳出的資料保存在當前裝置。頁面第一次成功載入並完成離線快取後，才能離線重新開啟。
- iPhone 會暫停背景網頁。完全關閉網站時不會持續背景同步；重新開啟且有網路後再同步。
- Microsoft 登入到期時，需要再按「登入 OneDrive」。重新登入不會清除待同步紀錄。
- 「清除紀錄」會在同一本帳的裝置之間同步，但結餘不變。尚未見過的其他裝置紀錄不會被一起清除。
- 若兩台裝置離線時分別提款，合併後可能超過共同餘額；程式會保留兩筆並顯示負餘額提示。要嚴格禁止這種情況，必須改成連線提款及集中交易服務。
- 深淺模式為各裝置自己的偏好，帳務資料才跨裝置同步。

## 五、原本的 Mac 桌面版

本次更新是 GitHub Pages 網頁版，先前下載的 Mac 1.0.0 `.app` 不會自動更新，也不會自行開始同步。

Mac 現在可以先開啟同一網站，和 iPhone 共用雲端帳本。

如果 Mac 桌面版已有需要保留的紀錄：先結束桌面版，在 Finder「前往 → 前往檔案夾」輸入 `~/Library/Application Support/電子撲滿/`，複製 `piggy-data.json` 作備份，再到更新後網站按「匯入備份」。這會建立一本本機帳本，你可選擇以這本作為雲端起始帳本。

若要讓原 Mac `.app` 本身也登入並同步，還需要接上桌面端登入流程與資料遷移；不應把這次網站更新視為已完成 Mac 二進位檔更新。

## 六、資料位置及復原

OneDrive 的資料位於 `Apps/電子撲滿/` 之下。每本帳有自己的 `piggy-…` 資料夾，內含起始資料 `seed.json` 及逐筆同步紀錄 `event-….json`。

請勿手動修改這些檔案。若誤刪，先從 OneDrive 資源回收筒還原。程式偵測到已同步檔案消失或被改寫時會停止同步，保留本機內容；不要直接重新建立零餘額帳本。

清除網站資料會刪除尚未上傳的本機紀錄與保留帳本。清除前請先同步並下載備份。

## 驗證與限制

已通過離線資料與模擬 OneDrive 的自動化測試，包含併發記帳、重試去重、清除明細保留餘額、帳號隔離、故障保護及 Mac 備份匯入。

已取得並填入你的 Microsoft 應用程式識別碼；尚未完成登入授權，所以尚未進行真實 Microsoft 登入／OneDrive 上下載，也尚未把本次變更發佈到你的 GitHub Pages。首次正式連接後應用一筆小額測試紀錄確認兩台裝置互通，再開始日常使用。

參考官方文件：
- https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder
- https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- https://learn.microsoft.com/en-us/graph/api/driveitem-get-content
