# Increment 171 — 256色最低ラインのuser行パネルと見出し色

更新日: 2026-10-03

ステータス: **利用者確認・完了承認済み（2026-10-03）。commit/push済み。常用配置・公開は未実施。**

## 要件・経路

利用者の判断で配色を次のとおり変更する。

- 8色サポートを切り捨て、256色を最低ラインとする。非256色端末への縮退考慮やfallbackはしない
- user行は文字を黄色（`38;5;220`）にし、背景を淡いグレー帯（`48;5;238`）にする。帯は行幅まで伸ばす
- Markdown見出しのgreen（SGR 32）を廃止し、boldなsoft blue（`1;38;5;111`）にする

参照実装の[_refs/pi](../../_refs/pi)（`userMessageBg`の背景帯、`mdHeading`）と
[_refs/zot](../../_refs/zot)（user bubbleの淡いパネル＋可読文字色、見出し＝bold accent blue、
帯の幅paddingの明示実装）を調査し、背景帯方式とbold soft blue見出しの根拠とした。piは
truecolor/256専用、zotは256/RGBで、どちらも8色互換を扱わない。本変更の256色最低ラインはこの前提に一致する。

Session/API → conversation projection → TUIのplain layoutとsemantic tone → rendererのSGR map →
最終terminal frameの経路を確認した。user行はfailure行と同じ全行tone機構（`rowTone: 'user'`）で
処理し、wrapされた全行に帯を掛ける。帯は行末まで幅paddingで伸ばし、行末のeraseに依存しない。
保存本文・表示identity・順序は変更しない。

実装範囲は`v0/tui/terminal.ts`（`GREEN_SGR`・`BLUE_SGR`の削除と`USER_TEXT_SGR`・
`USER_ROW_BG_SGR`・`HEADING_SGR`の追加）、`v0/tui/conversation_renderer.ts`（user行のrowTone）、
`v0/tui/tui_renderer.ts`（user行パネル描画と幅padding、heading色）の三ファイル。assistant・
tool・system・failure・list・emphasis・quote・table・footerの色は変更しない。
構想・architecture・roadmapの意味変更は不要。

## 検証・適用

既存frame testの色期待値を新配色へ更新し、user帯の幅paddingをframe assertionへ固定した。
focused test（tui conversation/retained terminal/tool preview 67件、increment 84・13・132・159）、
type check、format、lint、diff checkはpass。新規testファイルとfull gateは追加しない。

隔離HOME/XDGとtmuxのcompiled production TUI（build ID `e364a71f…`）で、実Sessionの隔離backupを
/viewで開き、user行の文字`38;5;220`・背景`48;5;238`、見出しのbold `38;5;111`、tool 36、
assistant 33、green（SGR 32）の不在、ready 36を実画面のANSI captureで確認した。帯が行末まで
全幅（表示160 cells）で伸びることも、trailing space保持のcaptureで確認した。provider requestは0。
実config・credential・稼働Core・実Sessionは変更していない。確認用Coreはすべて終了した。

証拠は`.tools/increment-171/`のbuild.log、ready-ansi.txt、session-ansi.txt、verification.json、
verify_colors.py。実装はIncrement 169・170のcommit `503a3f5f`の上に保持している。169/170は2026-10-03の利用者指示で
origin/mainへpush済み。171の変更はこのcommitに含めていない。

## 適用

表示の適用にはTUIを開き直す。commit/pushは実施済み（実装`fdc2ae42`、記録`3ef29fd5`）。
常用配置・公開は未指示のため未実施。

### 完了承認

2026-10-03、利用者確認のうえ完了承認を受け、Increment 171を完了とする。
