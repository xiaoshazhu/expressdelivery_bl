# Node SDK 变更记录

## 1.3.0 - 2026-09-16

### 修复

- 平台返回 4xx 业务错误时保留响应正文、错误码和提示文案。
- 重复兑换等可预期业务失败不再触发插件异常告警，并由插件端原样展示平台提示。

### 新增

- 新增经 Bearer Token 鉴权的可选能力发现接口 `GET /api/plugin/capabilities`。
- 新增可选 `aiConfigAdapter` 与 `aiPricingAdapter`，用于将插件自身的 AI 配置和额度倍率安全地提供给平台管理端。
- 新增可选 `announcementAdapter` 及 `GET/POST /api/plugin/announcement`，由平台管理插件自有公告配置。
- 公告适配器可通过 `supportsLinks: true` 独立声明整条公告的安全跳转能力，未声明时继续使用纯文字公告。
- 新增 `announcementConfigPath`/`ANNOUNCEMENT_CONFIG_PATH` 内置文件适配器，统一提供多公告、HTTPS 链接校验、原子写入和旧字段兼容。
- 自定义 `announcementAdapter` 优先于内置文件适配器，已接入公告的插件无需修改。
- 新增 `AhszPluginSDK.Extensions` 旧插件扩展模式，只挂载能力发现和公告接口，不覆盖现有手动业务接口。

### 兼容性

- 所有扩展适配器均为可选；旧插件不注册时能力值为 `false`，原有健康检查、套餐、授权、退款和企业登记接口不变。
- 不规定插件的 AI 数据库表结构，实际读写继续由插件适配器负责。

## 1.2.0 - 2026-07-29

### 新增

- 新增 `createNodeHttpHandler()`，允许原生 `node:http` 项目将 SDK 路由挂入现有
  `http.createServer`，与宿主业务共用一个进程和端口。
- 新增等价简写 `createHttpHandler()`。
- Handler 提供 `matches(req)`、`handle(req, res)` 和直接函数调用三种用法。
- 原生 HTTP 适配器内置 1 MB JSON 请求体解析、SDK 路由匹配、流量统计、统一错误响应。
- 新增 Express 与原生 HTTP 双模式兼容测试，覆盖鉴权、健康检查、零额度覆盖、
  套餐回写、退款通知、企业类型空字符串以及宿主业务路由透传。

### 兼容性

- 保留原 `sdk.mount(expressApp)`，现有 Express 插件无需修改。
- 统一平台 HTTP 路径、请求参数、响应结构、WebSocket、数据库和 Adapter 契约不变。
- 宿主已安装进程级异常监听时，可通过
  `createNodeHttpHandler({ installGlobalErrorHandlers: false })` 避免重复安装。

### 未改变

- 不修改 Python、Go、Java SDK。
- 不修改平台后端协议。
- 不自动创建插件业务表或数据库视图。
