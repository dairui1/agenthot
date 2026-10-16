# AgentHot

面向 Agent 开发者与重度用户的动态站。基于 [AIHOT](https://github.com/KKKKhazix/AIHOT) 独立 fork，保留采集、精选、事件归组、热点、日报、管理后台及原有页面，不重写引擎。

公开试运行地址：[agenthot.dairui1.com](https://agenthot.dairui1.com)。AgentLab 动态独立同步，符合证据条件的内容也进入日报；每天 UTC+8 06:30 采集处理、08:00 截稿、08:30 出刊。采集与模型筛选使用本机登录态 Codex CLI，模型为 `gpt-6.1-sol`；出刊阶段不采集、不调用模型。两阶段均为有界的一次性任务，见 [每日发布](deploy/agenthot-daily.md)。通知与服务器常驻通用 worker 保持关闭，不包含密钥和运行数据。适配器限制见 [Codex 适配器](modules/codex-cli/README.md)，生产环境不保存 Codex 登录态，部署流程见 [AgentHot 部署](deploy/agenthot.md)。

## 定制范围

- `site/`：AgentHot 品牌、文案、Agent 日报报头。
- `industry/`：Agent 主题、候选 RSS 信源、筛选标准与证据口径。
- `modules/`：后续站点扩展；首版不连接 AgentLab 数据库。

分类与信源是待确认的起点。评分类型、权重与门槛保留上游默认值，尚未用人工样本校准。

## 开发与维护

见 [AGENTHOT.md](AGENTHOT.md) 的安全预览、验证与上游同步约定。框架运行指南见 [部署文档](docs/deploy.md)，完整上游介绍保留在 [README.upstream.md](README.upstream.md)。

## 许可

保留上游 [MIT License](LICENSE) 与 [NOTICE](NOTICE)。AIHOT 名称和 Logo 不在代码许可范围内，不作为 AgentHot 品牌使用；第三方字体、内容与商标遵守各自许可。
