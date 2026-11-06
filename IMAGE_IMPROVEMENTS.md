# 画像最適化・表示改善 検証報告

2026-11-06 / v0.7.0 / ローカル検証結果（本番反映は別途承認・確認）

## 調査結果

対象は `render-alpha/`。Node.js 24、SQLite、Vanilla JSの構成です。
従来は画像のBase64をマニュアル本文に格納し、ログイン時・15秒ごとの同期時に全件を送信していました。
HTMLの `loading="lazy"` だけでは、そのJSONに含まれる画像データの通信を減らせません。
新規追加は最大辺1600pxへ縮小し、透過を白背景に変え、大きい画像をJPEGへ非可逆変換していました。

過去に縮小・非可逆変換された画像の失われた画質は、この更新では復元できません。

## 実装

- 新規追加は認証済みの同一サーバー内でsharp 0.35.5を使用し、原寸の可逆WebPへ変換。
- 縮小・JPEGへの非可逆変換・透過の白背景化を廃止。EXIFの向きを反映。
- WebPが小さく、変換前後の表示方向をそろえたsRGB/RGBA画素列のSHA-256が一致するときだけ採用。
- 透過部分のRGBを含めて比較。ICCプロファイルを維持。16bit PNGは元ファイルをそのまま保持。
- WebPが同容量以上、または画素比較が不一致なら元ファイルを採用。
- ファイル選択、貼り付け、ドロップの追加経路を統合。
- 閲覧用一覧・版詳細は画像URL・寸法・容量だけを返す。旧APIとJSONエクスポートは従来の画像入り形式を維持。
- 表示領域の200px手前でのみ画像URLを設定。他のマニュアルや非表示画面の画像は取得しない。
- 幅・高さ・アスペクト比により画像領域を事前確保。編集用サムネイルにも遅延読み込みを適用。
- 画像取得は毎回認証を確認。`private, no-cache`、`Vary: Cookie`、ETagによる304応答で再送を防止。
- 共有CDNには画像をキャッシュさせない。ログアウト・利用停止後は画像URLへの新しい取得も拒否。
- モーダルで暗い背景、拡大・縮小・画面合わせ・等倍・ホイール・ドラッグ・ピンチ・スワイプ・Esc・閉じるに対応。
- 画像は元解像度のまま表示。モーダル終了時のフォーカス・マニュアルのスクロール位置を維持。
- 同期で版が変わっていなければ詳細を再描画しない。変更時も読み位置を維持し、拡大中の差し替えを避ける。

## 保存と制限

SQLite内のBase64保存形式を維持。外部ストレージ移動、DBスキーマ変更、実データの一括変換はありません。
画像URLは保存済みの版から画像を読み出すもので、別の一時ファイルを必要としません。
SQLite全体バックアップとJSONバックアップは画像を含む自己完結形式のままです。
既存画像も遅延配信とキャッシュの対象になりますが、再圧縮はしません。

前回確認した公開設定は有料Computeと `/var/data` の5GB永続ディスクです。
今回Render設定・本番データ・GitHubを変更していません。Freeの一時領域へ保存する設計にはしていません。
無料プランの通信枠の大きさや料金は今回の検証対象ではありません。

- 追加元ファイル: PNG・JPEG・静止WebP、30MiB・1600万画素以内。
- 保存上限: 従来どおりBase64表現で1枚3MiB、1マニュアル合計15MiB、50枚まで。
- 上限を超えた画像を勝手に縮小せず、分割等を案内して拒否。アニメーションや破損画像も明示的に拒否。
- 変換は1サービスにつき同時1件。競合時は再試行を案内。libvipsのメモリキャッシュは16MiB、同時処理スレッドは1。
- 追加時は元ファイルをサーバーへ送るため、編集時のアップロード通信量まで必ず減るわけではありません。
- ブラウザーには非公開キャッシュが残り得ます。毎回の認証再確認で再取得を制限しますが、閲覧済みデータの端末からの完全消去を保証するものではありません。

## 検証結果

`npm test`: **39件成功、失敗0件**。既存24件に画像関連15件を追加。

| 項目 | 結果 |
| --- | --- |
| 検証用1920×1080スクリーンショット | PNG 202,031 bytes → WebP 16,016 bytes（92.07%削減） |
| 画質 | 復号後の全RGBA画素・寸法が一致。文字・1px細線を含む |
| 透過・向き・色 | 透明RGB/alpha、EXIF回転JPEG、ICC、16bit PNG保持を確認 |
| 検証用マニュアル1件の一覧JSON | 22,403 bytes → 1,062 bytes（95.26%削減、画像本体を除外） |
| ホーム・未閲覧マニュアル | 画像取得0件を実ブラウザーで確認 |
| 遅延読み込み | 画面近傍だけ取得。下方画像はスクロール後に取得 |
| レイアウト | 最後の画像の復号前後で領域高さの差1px以内 |
| キャッシュ | Edgeの実通信でHTTP 304を確認。APIテストでも画像本文0 bytes |
| 認証 | 未ログイン・ログアウト後は画像URLを401で拒否。CSRF・権限維持 |
| 編集・複製・復元 | URL参照の再保存、JSON移行、SQLite全体復元、再起動後の画像保持を確認 |
| PC | Edge 1440×1000、ホイール・ドラッグ・等倍・Esc・位置復元を確認 |
| スマートフォン | Chromiumタッチエミュレーション390×844 / 844×390、ピンチ・スワイプ・閉じるを確認 |
| 既存UI | アカウント・権限・再発行・PC/スマートフォン画面の既存自動テスト成功 |
| JavaScript例外 | ブラウザー検証で0件 |
| 依存関係 | sharp 0.35.5固定。npm監査で既知の脆弱性0件を確認 |

削減率は合成した検証画像による実測であり、写真・既存ファイル・月間総通信量の削減率を保証しません。
一覧JSONの値は最適化後の画像を埋め込んだ場合とURL参照の場合の比較です。
数値は未圧縮の本文bytesで、TLS・HTTPヘッダー等を含むRender請求通信量ではありません。

実機iPhone/iPad/SafariおよびRender上での新版の動作は未確認です。
本番へ自動デプロイしないという指示に従い、Render上の最終確認は承認後に行います。

テスト時の `Error: injected failure` は既存の復元ロールバック試験で意図的に発生させる例外です。
合成画像のフォント生成ではWindowsのフォントキャッシュ書込警告が出ますが、全テストは成功しています。

## 確認用ファイル

- `test-output/image-quality.json`: 画質・容量の比較値
- `test-output/image-api-traffic.json`: 一覧JSONの比較値
- `test-output/image-browser-traffic.json`: 遅延読み込み・キャッシュ・タッチ等の検証記録
- `test-output/screenshot-original.png` / `screenshot-optimized.webp`: 比較用画像
- `test-output/images-detail-desktop.png` / `images-zoom-desktop.png`: PC画面
- `test-output/images-detail-mobile.png` / `images-zoom-mobile.png`: スマートフォン画面

これらはGit管理対象外のローカル検証資料です。実際の業務画像・本番バックアップは使用していません。

## 再実行とローカルプレビュー

```powershell
npm ci
npm test
$env:MANUAL_QA_MODULES='C:\Users\HONDA\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node scripts/ui-images.mjs
node scripts/ui-accounts.mjs
node scripts/preview-images.mjs
```

プレビューは `127.0.0.1:8897` のみで公開し、`test-output/image-preview/` に独立した検証データを保存します。
検証専用IDは `preview`、検証専用パスワードは `PreviewImage123`。本番では使わないでください。

## 承認後の配置手順

1. 管理者が現時点のSQLite全体バックアップを取得し、Render外にも保管する。
2. 変更済みソースと `package-lock.json`、新規 `image-service.mjs`・`images.js`・画像テスト等をGitHubへ反映。
3. RenderのBuild Commandを `npm ci && npm test` に変更。Start Command・環境変数・有料プラン・ディスクは維持。
4. 明示的にデプロイし、`/health` の `version: 0.7.0-images` とログの保存先 `/var/data` を確認。
5. 本番で画像追加・遅延読み込み・認証・キャッシュ・PC/スマートフォン表示を確認する。

環境変数や保存形式の移行は不要です。ロールバック時も新画像は従来から対応しているWebPのBase64形式なので表示可能です。

参考: [sharpの可逆WebP設定](https://sharp.pixelplumbing.com/api-output/)、[画像の向き](https://sharp.pixelplumbing.com/api-operation/)、[非公開キャッシュと再検証](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)。
