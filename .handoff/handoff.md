# Handoff

## Records

### Context compactionの再検討

- 状態: 64 KiBでのtool-result機械的省略が調査反復へ関与した事象と、完全なcanonical transcriptを
  常時RAMへ展開してmodel requestごとに処理する将来の性能課題を、未採用候補として記録済み。
- 次の一手: 完全なcanonical transcriptを正本として保つ前提で、自動semantic checkpointとrequest直前の
  機械的省略を分け、今後の自動コンパクション動作を利用者と検討する。
- 正本: `docs/experience/normal-use-inbox.md`
- 注意: 検討段階であり、context動作を変更する個別incrementは未採用。
