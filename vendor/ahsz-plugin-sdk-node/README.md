# 🛠️ 安汇数智统一插件对接 SDK (ahsz-plugin-sdk)

本仓库包含安汇数智开放平台与插件后端 standard 对接的多语言 SDK，支持 **Node.js (Express/原生 HTTP)**、**Python (Flask/FastAPI)**、**Java (Spring Boot)** 及 **Go**。

SDK 将鉴权、生命周期同步、WSS 指标上报以及异常日志上报标准化，插件开发者仅需实现 **4 个核心业务适配器** 与 **2 张数据库只读视图** 即可拉通平台端管理。

---

## 📂 目录结构

```text
ahsz-plugin-sdk/
├── README.md               # 接入规范及使用说明
├── node/                   # Node.js (Express/原生 HTTP) SDK
│   ├── package.json
│   └── index.js
├── python/                 # Python (Flask/FastAPI) SDK
│   ├── pyproject.toml
│   ├── requirements.txt
│   └── sdk.py
├── java/                   # Java (Spring Boot) SDK
│   ├── pom.xml
│   └── src/main/java/.../AhszPluginSdk.java
├── go/                     # Go (Standard) SDK
│   ├── go.mod
│   └── sdk.go
└── sql/                    # 数据库 DDL 模板
    └── platform_views.sql  # 底层物理表与视图 DDL 结构
```

---

## 🚀 一、 对接架构与适配器契约

SDK 支持两种部署与运行模式：
1. **标准表模式（推荐，零代码）**：插件使用标准的物理表 `platform_license` 与 `platform_order`，并按照 `sql/platform_views.sql` 建立了只读视图。此模式下，开发者**无须编写任何适配器代码**，SDK 启动时会自动初始化并装配内置的 MySQL 适配器。
2. **旧插件兼容模式**：当物理表无法调整或已有数据库架构时，可通过注册自定义的 Adapter 适配器接管本地的业务表。

当使用旧插件兼容模式或定制化业务逻辑时，需要实现以下 4 个业务适配器契约：

### 1. 健康检测适配器 (HealthAdapter)
*   **职责**：用于平台 HTTP 辅助健康探活校验。建议不仅检查进程存活，还尝试检查插件数据库是否可正常查询。
*   **契约接口**：
    *   `check()`: 返回具有 `healthy: boolean` 的 JSON 数据。检测失败请返回 `healthy: false` 或抛出异常。

### 2. 套餐配置适配器 (BillingAdapter)
*   **职责**：负责本地计费套餐的读取与原子存储更新。
*   **契约接口**：
    *   `getConfig()`: 获取本地当前的套餐 schema 结构。
    *   `updateConfig(schema)`: 覆盖保存最新的套餐 schema（用事务或原子文件重命名）。
*   **注意**：SDK 会对套餐的 `plan_id` 唯一性、价格非负性及对应额度/天数做强校验，并在写入后自动进行**回读比对验证**，若不一致则抛出失败。

### 3. 企业授权适配器 (LicenseAdapter)
*   **职责**：接收平台计算出的租户企业最新授权额度和订阅有效期最终值。
*   **契约接口**：
    *   `syncFinalLicense(data)`: 以**最终值覆盖**形式（而非累加）原子 Upsert 更新本地数据库的授权表。
*   **注意**：各语言 SDK 均会将平台参数统一格式化为 **camelCase** 传入适配器，即数据对象中包含：
    *   `tenantKey` (String)
    *   `billingType` (String)
    *   `usedQuota` (Integer)
    *   `maxQuota` (Integer)
    *   `expireTime` (String/Date/null)
*   **注意**：`used_quota = 0` 和 `max_quota = 0` 是合法值，必须被正确识别与覆盖，不可被默认值拦截。

### 4. 退款订单适配器 (OrderAdapter)
*   **职责**：平台发起退款通知后，插件执行订单状态同步。
*   **契约接口**：
    *   `markRefunded(orderId)`: 执行本地订单事务与行锁 (`SELECT ... FOR UPDATE`)，将状态标记为 `REFUNDED`。
*   **返回参数约束**：适配器实现必须返回包含以下两个字段的 Key-Value Map 或对象，用于 SDK 校验：
    *   `tenantKey` (String) - 必须为非空字符串。
    *   `alreadyRefunded` (Boolean) - 订单在本次调用前是否已经是退款状态（用于平台做幂等去重判断）。
*   **重要约束**：**退款接口只负责将订单标记为 `REFUNDED`，不可在退款接口中直接扣减额度或订阅时长！** 平台确认退款成功后，会读取视图并重新计算额度最终值，随后通过 `syncFinalLicense` 接口下发最终额度，避免双重扣减。

---

## 💾 二、 数据库底层表与视图规范 (DDL)

SDK 启动时会进行**只读就绪校验 (Readiness Check)**。插件开发者仅需按照 [sql/platform_views.sql](./sql/platform_views.sql) 中的 SQL 结构，在数据库中建立：
1. **授权视图 `platform_license_view`**。
2. **订单视图 `platform_order_view`**。

> [!IMPORTANT]
> - **物理表及视图必须由插件端提前创建好**，SDK 只进行只读校验。
> - SDK 在启动时会同步查询上述视图。如果视图不存在、数据库连接失败，或者 `packages.json` 路径无效/未建立，SDK 会标记为 `notReady` 状态，使健康接口返回 `503 Service Unavailable` 阻断发布，且不会启动 WebSocket 长连接监控，直到错误修复。

---

## 🔌 三、 统一初始化及挂载方式

### 1. 配置环境变量/系统属性
确保系统或 `.env` 配置文件中具备以下变量：
```env
PLUGIN_ID=plg_your_plugin_name
API_TOKEN=high_strength_random_token_generated
PLATFORM_API_URL=https://platform.feishu.anhuishuzhi.com
PLATFORM_WS_URL=wss://platform.feishu.anhuishuzhi.com/api/v1/ws/plugin
PLATFORM_WS_ORIGIN=https://platform.feishu.anhuishuzhi.com  # 可选，留空时 SDK 会根据 PLATFORM_API_URL 自动推导生成
LOG_FILE_PATH=./app.log

# ================= 零代码标准表模式（必填） =================
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_database_password
DB_NAME=your_database_name

# ================= 套餐配置文件（必填） =================
BILLING_CONFIG_PATH=/path/to/packages.json                  # 指定套餐配置文件绝对路径，若不存在/损坏将阻断就绪并返回 503
ANNOUNCEMENT_CONFIG_PATH=/path/to/announcement.json         # 可选；配置后自动启用 SDK 内置的多公告文件能力
AHSZ_WS_ENABLED=true                                        # 在多进程(PM2/Gunicorn等)部署下，非主实例节点需配置为 false 以关闭 WS 连接限制对账
```

### 2. Node.js (Express) 引入与挂载
```javascript
const express = require('express');
const AhszPluginSDK = require('./node'); // 引入 Node SDK 目录

const app = express();
app.use(express.json());

// 初始化 SDK
const sdk = new AhszPluginSDK({
    pluginId: process.env.PLUGIN_ID,
    apiToken: process.env.API_TOKEN,
    platformUrl: process.env.PLATFORM_API_URL,
    platformWsUrl: process.env.PLATFORM_WS_URL,
    platformWsOrigin: process.env.PLATFORM_WS_ORIGIN,
    logFilePath: process.env.LOG_FILE_PATH,
    billingConfigPath: process.env.BILLING_CONFIG_PATH,
    // 可选：使用 SDK 内置公告存储，支持最多 10 条公告和每条独立 HTTPS 链接。
    announcementConfigPath: process.env.ANNOUNCEMENT_CONFIG_PATH,

    // 1. 标准表模式 (无需注册 adapters，填全数据库配置即可)
    dbHost: process.env.DB_HOST,
    dbPort: process.env.DB_PORT,
    dbUser: process.env.DB_USER,
    dbPassword: process.env.DB_PASSWORD,
    dbName: process.env.DB_NAME,

    // 2. 旧插件兼容模式 (不需要数据库配置，但必须注册自定义适配器实现原有业务表连接)
    /*
    healthAdapter,
    licenseAdapter,
    orderAdapter
    */
});

// 必须使用 sdk.mount(app) 挂载，它会同时注册路由、开启流量统计并挂载全局错误拦截器
sdk.mount(app);
sdk.start();
```

### 旧 Node 插件只接入公告（不改动原手动接口）

金蝶连接器、电子签名等早于 SDK 接入的插件，不需要为了公告一次性迁移
健康检查、套餐、授权和退款接口。只需使用扩展能力模式：

```javascript
const express = require('express');
const AhszPluginSDK = require('ahsz-plugin-sdk-node');

const app = express();

// 1. 原有手动接口照常注册，无需改写。
registerExistingHealthBillingLicenseAndRefundRoutes(app);

// 2. 只增加能力发现与公告管理接口。
const extensions = new AhszPluginSDK.Extensions({
    apiToken: process.env.API_TOKEN,
    announcementConfigPath: process.env.ANNOUNCEMENT_CONFIG_PATH
});
extensions.mount(app);

// 3. 原有 404/错误处理必须放在扩展路由之后。
installExistingNotFoundAndErrorHandlers(app);
```

该模式只注册以下接口：

- `GET /api/plugin/capabilities`
- `GET /api/plugin/announcement`
- `POST /api/plugin/announcement`

它不要求数据库配置或业务 Adapter，不启动 WebSocket、指标上报或新端口，
也不注册 `/api/health`、套餐、授权、退款和企业登记路由。

对于原生 `node:http` 插件，使用 `extensions.createNodeHttpHandler()`，并仅在
`handler.matches(req)` 为 `true` 时将请求交给扩展 Handler。

### 3. Node.js（原生 HTTP）引入与单端口挂载

原生 `http.createServer` 项目不需要为 SDK 新增进程或端口。SDK Handler 只匹配统一平台
路由，未匹配请求继续交给插件原业务处理器：

```javascript
const http = require('http');
const AhszPluginSDK = require('./node');

const sdk = new AhszPluginSDK({
    pluginId: process.env.PLUGIN_ID,
    apiToken: process.env.API_TOKEN,
    platformUrl: process.env.PLATFORM_API_URL,
    platformWsUrl: process.env.PLATFORM_WS_URL,
    billingConfigPath: process.env.BILLING_CONFIG_PATH,
    healthAdapter,
    licenseAdapter,
    orderAdapter,

    // 3. 可选 AI 扩展能力：只有需要在平台管理 AI 配置的插件才注册。
    // 未注册的旧插件不会显示对应管理入口。
    aiConfigAdapter: {
        list: async () => ({ code: 0, configs: [] }),
        save: async (payload) => ({ code: 0, config: payload })
    },
    aiPricingAdapter: {
        list: async () => ({ code: 0, pricing: [] }),
        save: async (payload) => ({ code: 0, pricing: payload })
    },
    // 可选自定义公告能力：已有插件可继续使用，且优先级高于 announcementConfigPath。
    announcementAdapter: {
        supportsLinks: true,
        supportsMultipleItems: true,
        get: async () => ({ code: 0, announcement: currentAnnouncement }),
        save: async (payload) => ({ code: 0, announcement: await saveAnnouncement(payload) })
    }
});

// 已有插件如果传入 announcementAdapter，SDK 会继续使用现有实现；
// 新插件则可只配置 announcementConfigPath。展示样式与面向用户的公开读取接口仍由插件自行实现。
// 公开读取接口可直接调用 sdk.getAnnouncement()，无需再读取或解析 JSON 文件。

const sdkHandler = sdk.createNodeHttpHandler();

const server = http.createServer(async (req, res) => {
    // 必须在宿主业务读取请求体之前判断并交给 SDK。
    if (sdkHandler.matches(req)) {
        sdkHandler.handle(req, res);
        return;
    }

    await handlePluginBusinessRequest(req, res);
});

server.listen(Number(process.env.PORT || 3000), async () => {
    await sdk.start();
});

async function shutdown() {
    sdk.stop();
    server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

`createHttpHandler()` 是 `createNodeHttpHandler()` 的等价简写。返回的 Handler 同时支持：

```javascript
sdkHandler.matches(req);
sdkHandler.handle(req, res);
sdkHandler(req, res);
```

注意事项：

- SDK 只匹配 `/api/health`、`/api/plugin/*` 和已定义的 `/api/subscription/*` 路由。
- 未匹配请求不会被 SDK 拦截，必须由宿主业务继续处理。
- SDK 路由必须在宿主读取请求体之前执行，避免请求流被重复消费。
- 如果宿主已经安装全局异常处理，可传
  `createNodeHttpHandler({ installGlobalErrorHandlers: false })`，避免重复安装进程级监听器。
- Express 的 `sdk.mount(app)` 保持兼容，现有插件无需迁移。

### 4. Python (FastAPI/Flask) 挂载示例
```python
# Flask 挂载
from flask import Flask, Blueprint
from sdk import AhszPluginSDK

app = Flask(__name__)
sdk = AhszPluginSDK({
    "pluginId": "plg_your_plugin",
    "apiToken": "your_api_token",
    "platformUrl": "http://127.0.0.1:9000",
    "platformWsUrl": "ws://127.0.0.1:9000/api/v1/ws/plugin",
    "healthAdapter": my_health,
    "licenseAdapter": my_license,
    "orderAdapter": my_order
})

# 使用 mount_flask 挂载以启用流量统计和未捕获异常自动上报
blueprint = Blueprint("ahsz_plugin_sdk", __name__)
sdk.mount_flask(app, blueprint)
sdk.start()
```

```python
# FastAPI 挂载
from fastapi import FastAPI, APIRouter
from sdk import AhszPluginSDK

app = FastAPI()
sdk = AhszPluginSDK({
    "pluginId": "plg_your_plugin",
    "apiToken": "your_api_token",
    "platformUrl": "http://127.0.0.1:9000",
    "platformWsUrl": "ws://127.0.0.1:9000/api/v1/ws/plugin",
    "healthAdapter": my_health,
    "licenseAdapter": my_license,
    "orderAdapter": my_order
})

# 使用 mount_fastapi 挂载以启用流量统计和未捕获异常自动上报
router = APIRouter()
sdk.mount_fastapi(app, router)
sdk.start()
```

### 5. Java (Spring Boot) 挂载示例
在 `application.yml` 配置：
```yaml
ahsz:
  plugin:
    id: plg_your_plugin
    api-token: your_api_token
    platform-url: http://127.0.0.1:9000
    platform-ws-url: ws://127.0.0.1:9000/api/v1/ws/plugin
```
由于 SDK 内置了 Spring Boot Auto-configuration，开发者**无需显式注册 AhszPluginSdk Bean**。您只需要在项目中将实现的四个业务适配器类声明为 Spring `@Component` 即可，SDK 会自动发现并构造启动：
```java
@Component
public class MyHealthAdapter implements AhszPluginSdk.HealthAdapter {
    @Override
    public Map<String, Object> check() throws Exception {
        // 实现健康检测逻辑
        Map<String, Object> res = new HashMap<>();
        res.put("healthy", true);
        return res;
    }
}

// 同样的，将 BillingAdapter, LicenseAdapter, OrderAdapter 也声明为 @Component
```
在业务逻辑中如果需要主动调用平台 API，可以直接在任何类中自动装配注入 SDK 即可：
```java
@Autowired
private AhszPluginSdk sdk;
```

### 6. Go (Standard) 挂载示例
```go
import (
    "net/http"
    "github.com/anhuishuzhi/ahsz-plugin-sdk/go"
)

func main() {
    mux := http.NewServeMux()
    sdkInstance := sdk.New(sdk.Config{
        PluginID:       "plg_your_plugin",
        ApiToken:       "your_token",
        PlatformURL:    "http://127.0.0.1:9000",
        PlatformWSURL:   "ws://127.0.0.1:9000/api/v1/ws/plugin",
        HealthAdapter:  myHealth,
        LicenseAdapter: myLicense,
        OrderAdapter:   myOrder,
    })
    
    sdkInstance.RegisterRoutes(mux)
    sdkInstance.Start()
    
    // 必须用 HTTPTrackerMiddleware 包装 mux，以开启 HTTP 流量统计与未捕获 panic 全局捕获
    http.ListenAndServe(":8080", sdkInstance.HTTPTrackerMiddleware(mux))
}
```

---

## 📈 四、 WebSocket 性能监控上报规范

SDK 启动后会自动连接平台 WebSocket 探针，并进行低频细化指标采集推送，采集频率规范：
1.  **进程 CPU、内存、活跃线程及连接数**：采集推送周期默认为 **5秒**（可由 `metricsInterval` 环境变量配置，最低不低于 5 秒），且仅针对插件进程自身，而非整台服务器主机。
2.  **本地日志大小、主机系统磁盘占用**：每 **30秒** 采集一次。
3.  **插件物理目录总体积**：每 **5分钟** 递归扫描一次并进行内存缓存，避免频繁扫描造成磁盘 I/O 拥堵。

---

## 🛠️ 五、 统一客户端 API 方法

SDK 内置了安全客户端，供插件业务代码主动请求平台端接口。这些方法自动注入 Bearer Token 头、封装 5 秒超时机制及异常捕获，且在各语言返回中**完全对齐格式（直接返回平台解析后的 JSON 键值对）**：

*   **查询企业在平台的登记状态与授权包**：
    ```javascript
    const result = await sdk.queryEnterpriseStatus(tenantKey);
    // 返回 JSON 格式: { code: 200, data: { ... } }
    ```
*   **登记或更新开通插件的企业信息**（`enterpriseType` 为可选文本，可传空字符串；旧的两参数调用继续兼容）：
    ```javascript
    const result = await sdk.registerEnterprise(tenantKey, enterpriseName, enterpriseType);
    ```
*   **核销兑换码凭证**：
    ```javascript
    const result = await sdk.redeemCoupon(tenantKey, couponCode);
    ```
*   **异步日志/运行时错误上报**（自动进行堆栈字数裁剪，防上报风暴，失败降级本地文件）：
    ```javascript
    sdk.reportError(error, 'MyBusinessModuleContext');
    ```
