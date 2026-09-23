# Increment 118 — キャンセル後のTUI表示ID衝突の修正

状態: 実装・検証完了

## 利用者が必要とする動作と根拠

- キャンセルしたターンへ続けて指示したとき、新しいツール呼び出しを新しい入力の後に表示する。
- session `29e6f6f9`では、キャンセル前後の実行がともにturn 1であり、後続実行の39件のツール結果は記録されたが、
  TUIには以前の`cd`付きコマンドが残り、`working`だけが見えた。
- `TuiPresentationAdapter`は`turn_start`ごとに表示用call番号を1から割り当て直す。TUIは完了した古いツール行を
  残す一方、行IDをturn番号とcall番号だけから作るため、後続実行の呼び出しが古い行を更新していた。

## 対象と実装

- TUIの`turn_start`ごとに表示専用の試行番号を進め、user、assistant、tool、steeringの行IDへ含める。
  同一試行内のprogressとresultは同じ行を更新し、キャンセル前の完了行と後続試行の行は分離する。
- Sessionのturn番号、Workerイベント、canonical transcript、SQLite schemaは変更しない。
- `bash`結果の4 KiB prefixと`bash_output`による保存済み出力の継続読込みはIncrement 5の確定要件どおりであり、
  今回は変更しない。

## 確認

- 同じturn番号と表示用call番号を再利用するキャンセル後のイベント列で、古い行と新しい行が別々に残る
  focused regressionを追加した。TUI conversation 16件、retained terminal 42件、tool preview 15件、
  current code 17件が成功した。
- `v0:check`、変更ファイルのformat・lint、`git diff --check`が成功した。
- 隔離XDGのproduction TUIをtmuxで起動し、ローカル模擬providerへだけ接続した。最初の入力で
  `tool> bash printf old ✓`を表示した後、Escでキャンセルし、同じturn番号の次の入力で
  `tool> bash printf new ✓`が古い行の後に表示され、最終回答まで進むことを確認した。
  模擬providerへのrequestは4件。実provider callは行っていない。
