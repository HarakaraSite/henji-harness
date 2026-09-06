# Henji Harness

Henji Harnessは、実際の利用経験から自身の機能を継続的に改訂できるDeno agent harnessを目指す。
通常利用の経験を保存し、人間の指示を契機にWorker内AIが改訂候補を作る。
候補は人間の採用アクションまたは明示的承認によってのみ採用され、その後の通常利用へ戻る。
Henji HostはSurface、lifecycle、storage、revisionを担い、headless Agent WorkerがDefinitionを合成・実行する。
現在は開発中であり、詳細は[構想](docs/concepts/experience-driven-self-revision.md)、[architecture](docs/architecture/henji-host-agent-worker.md)、[roadmap](docs/roadmap.md)を正本とする。
