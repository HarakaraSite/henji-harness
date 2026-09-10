# Handoff

## Records

### Increment 19 busy activity indicator

- 状態: Increment 19のlocal実装と検証が完了した。production retained footerはbusy/cancelling primary
  statusだけをblinkし、busy中に通常styleの`Esc cancel`を表示する。authoritative `v0:gate`は一回で全130
  testを通過した。
- 次: 利用者がproduction retained TUIで通常taskを実行し、busy/cancellingの点滅とsettlement後の通常表示を
  目視確認してIncrement 19の完了可否を判断する。
- 正本: `docs/increments/increment-19.md`
- 注意: local source/testへ追加変更する承認は残っていない。実際の点滅はterminal設定にも依存する。
  構想・architecture・roadmapは個別の事前承認なしに変更しない。利用者所有の未追跡`_refs/*`は変更していない。
