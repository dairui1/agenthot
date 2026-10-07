# AgentHot

面向 Agent 开发者与重度用户的动态站。基于 [AIHOT](https://github.com/KKKKhazix/AIHOT) 独立 fork，保留采集、精选、事件归组、热点、日报、管理后台及原有页面，不重写引擎。

当前是本地验证版，尚未上线。默认关闭采集、模型与通知；不包含密钥和运行数据。

## 定制范围

- `site/`：AgentHot 品牌、文案、Agent 日报报头。
- `industry/`：Agent 主题、候选 RSS 信源、筛选标准与证据口径。
- `modules/`：后续站点扩展；首版不连接 AgentLab 数据库。

分类与信源是待确认的起点。评分类型、权重与门槛保留上游默认值，尚未用人工样本校准。

## 开发与维护

见 [AGENTHOT.md](AGENTHOT.md) 的安全预览、验证与上游同步约定。框架运行指南见 [部署文档](docs/deploy.md)，完整上游介绍保留在 [README.upstream.md](README.upstream.md)。

## 许可

保留上游 [MIT License](LICENSE) 与 [NOTICE](NOTICE)。AIHOT 名称和 Logo 不在代码许可范围内，不作为 AgentHot 品牌使用；第三方字体、内容与商标遵守各自许可。
