# @pi-story/pi-story

P2的Pi扩展与适配层。产品代码只依赖core与ADR-017固定构建的Pi包。入口为src/index.ts；包内rules由宿主装配，不依赖Pi的按需Skill加载。

先运行story/scripts/prepare-p2.mjs，再以PI_STORY_WORK_DIR指向P2 exec工作区运行install-isolated.mjs。SDK测试使用同一固定构建与原生faux提供方，不调用真实模型。
