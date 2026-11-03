# Operations-Manual-0

業務マニュアル Render起動確認版

GitHubでコードを管理し、RenderのNode.js Web Serviceで実行する版です。
元のHTMLと `alpha/`、Sites用の `online-alpha/` は別に残してあります。

このGitHub配置用の版には、元の6件のサンプル業務手順を含めません。
マニュアル本文・画像・アカウント・バックアップはGitHubへ配置しません。

## 起動設定

- Runtime: Node.js 24
- Plan: Free（今回の起動確認用）
- Build command: `node --test test.mjs`
- Start command: `node server.mjs`
- Health check: `/health`
- `HOST=0.0.0.0`
- `MANUAL_HTTPS=1`
- `MANUAL_PREVIEW_MODE=1`
- `INITIAL_ADMIN_USERNAME=admin`
- `INITIAL_ADMIN_NAME=管理者`
- `INITIAL_ADMIN_PASSWORD`: Renderの環境変数で設定する12〜128文字の秘密値

DBが空のときだけ初期管理者を作成します。既存の管理者パスワードは上書きしません。
初期パスワードをソース、ログ、README、GitHubへ載せないでください。
ログイン用パスワードはRenderのEnvironment画面で確認します。

## 無料版の位置付け

**起動・操作確認専用です。正式な業務データを登録しないでください。**

Render Freeは再起動、再配置、休止でファイルが失われます。
マニュアル、画像、スタッフ、更新履歴と自動バックアップは同じ一時ファイルシステム上にあるため、すべて失われ得ます。
画面上にもその旨を表示します。一定時間使わないと休止し、次に開く際の起動に時間がかかることがあります。

継続運用では有料の永続ディスク等が必要です。契約・課金の確認後、
`MANUAL_DATA_DIR` をそのマウント先に設定し、画面の検証用表示を外します。
同じディスク内のバックアップだけでなく、管理者がダウンロードして別の場所にも保管してください。

## ローカル確認

```text
node --test test.mjs
node server.mjs
```

初期管理者の環境変数なしでローカル起動すると、ループバック接続から初期設定できます。
公開環境で未設定の場合、インターネットからの初期登録は拒否します。

既存の検索・画像添付・お気に入り・管理・JSONバックアップに加え、
ログイン、閲覧/編集/管理者権限、担当者、確認日、更新履歴、版の復元を備えます。
同時編集と全件復元は競合を拒否し、全件復元の途中で失敗しても元に戻します。

参考: https://render.com/docs/free
