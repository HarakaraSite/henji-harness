# Increment 168 — シアンとグリーンの表示色を交換

更新日: 2026-10-01

ステータス: local実装・検証・commit・binary作成・常用配置完了。利用者確認待ち。

## 要件・経路

利用者の「小さい修正表示色のシアンとグリーンを入れ替えて欲しい」により、現在のシアンと
グリーンを交換する。Markdown見出しをgreen（SGR 32）、toolラベル・list marker・emphasis・
readyをcyan（SGR 36）へ変更する。

Session/API → TUIのplain layoutとsemantic tone → rendererのSGR map → 最終terminal frameの
経路を確認した。rendererの既存色対応五箇所だけを切り替える。ANSI定数の名前と値は維持する。
保存本文・表示identity・順序は変更せず、他の配色と装飾を維持する。
Increment 164の見出しcyan指定は本変更で置き換える。過去の結果記録は保持する。
構想・architecture・roadmapの意味変更は不要。

## 検証・適用

既存の最終frame確認を新配色へ更新し、focused test、型検査、format、lint、diff checkを行う。
新規testやfull gateは追加しない。
隔離HOME/XDGとtmuxのcompiled production TUIでreadyのcyan、保存Sessionの見出しgreenとtool/listの
cyanを確認する。実Sessionの隔離backupを使用し、実config・credential・稼働Coreを変更しない。
provider requestは0。継続して承認されているcommit/build/常用配置を行い、TUIを開き直して適用する。

## 実装・focused結果

rendererのLABEL_SGR.tool、SPAN_SGR.heading/list/emphasis、FOOTER_SGR.readyを指定どおり交換した。
既存frame testの色期待値を更新した。focused 49件はpassし、test実行時の型検査、format、lint、
diff checkもpass。保存本文やplain layoutへのANSI混入がないこと、user blue・assistant yellow・
quote magenta等の既存装飾も既存testで確認した。

## production TUI・配置結果

配置先のcompiled Core/TUIを隔離HOME/XDGで起動し、最終ANSI captureでready cyan（36）を確認した。
保存済みf75a8810の隔離backupを/viewで開き、見出しgreen（32）、tool/list cyan（36）、
user blue（34）、assistant yellow（33）を実画面の色状態から確認した。
160×70の起動画面と160×160の保存履歴画面を使用した。provider requestは0。
証拠は`.tools/increment-168/`のready-ansi.txt、session-ansi.txt、verification.json。

隔離DBだけを置いた初回環境ではSession openがfailedとなった。空の隔離環境で正常起動を確認し、
その環境へDBをbackupして、起動providerをopenrouter-chatと明示して再起動したところ確認できた。
この確認環境の準備によるsource変更や実credentialのコピーは行っていない。確認用Coreはすべて終了した。

source commit `a692c10a290cabd8376ee7195267f57fe576c1da`、dirtyなしで公式henji:compileを実行した。
`dist/henji`と常用`/home/agent/.local/bin/henji`のSHA-256一致を確認して配置済み。
build IDは`4db6bd682d87c671ab8872f4dad8ccb817f0cb6a1c2f3ede3aa9e80aace6ec6d`。
配置記録は`.tools/increment-168/deployment.json`、以前のbinaryは同directoryのhenji.previous。
TUIを開き直して適用する。既存の実Core、Session、credentialは変更していない。push・公開は未実施。
